import { getContacts, saveContact } from './storage.js';

const DEV_ID_KEY = 'voxa_my_device_id_v1';
const CHUNK_SIZE = 64 * 1024; // 64KB binary chunks for crash-free transfers

export function getMyDeviceId() {
  let id = localStorage.getItem(DEV_ID_KEY);
  if (!id) {
    const num = Math.floor(1000 + Math.random() * 9000);
    const code = Math.random().toString(36).substring(2, 5).toUpperCase();
    id = `VX-${num}-${code}`;
    localStorage.setItem(DEV_ID_KEY, id);
  }
  return id;
}

async function deriveSharedAesKey(idA, idB, pin) {
  const sortedPair = [idA, idB].sort().join(':');
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('voxa-e2ee-' + sortedPair), iterations: 60000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptPayload(key, arrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
  return { iv: Array.from(iv), data };
}

async function decryptPayload(key, ivArr, cipherBuf) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(ivArr) }, key, cipherBuf);
}

export class VoxaRtcEngine {
  constructor(callbacks) {
    this.myId = getMyDeviceId();
    this.cb = callbacks;
    this.peer = null;
    this.connections = new Map(); // remoteDevId -> DataConnection
    this.verifiedPeers = new Set(); // remoteDevIds that passed AES challenge
    this.incomingBuffers = new Map(); // fileId -> { chunks: [], received: 0, total: 0, meta }
    this.reconnectTimer = null;
  }

  start() {
    this._createPeer(false);

    // Instant Wake-Up Auto-Reconnect after sleep/idle
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.wakeAndHealAll();
    });
    window.addEventListener('focus', () => this.wakeAndHealAll());
    window.addEventListener('online', () => this.wakeAndHealAll());

    this.reconnectTimer = setInterval(() => this.dialAllSavedContacts(), 3500);
  }

  wakeAndHealAll() {
    if (!this.peer || this.peer.destroyed) {
      this._createPeer(false);
      return;
    }
    if (this.peer.disconnected) {
      try { this.peer.reconnect(); } catch (_) {}
    }
    this.dialAllSavedContacts();
  }

  _createPeer(useTempSuffix) {
    if (this.peer) { try { this.peer.destroy(); } catch (_) {} }
    const peerRegId = useTempSuffix
      ? `voxa-${this.myId}-${Math.floor(100 + Math.random() * 899)}`
      : `voxa-${this.myId}`;

    this.cb.onNetworkState('Connecting...');
    this.peer = new Peer(peerRegId, {
      debug: 0,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
      }
    });

    this.peer.on('open', () => {
      this.cb.onNetworkState('Online');
      this.dialAllSavedContacts();
    });

    this.peer.on('connection', (conn) => {
      const remoteDevId = conn.metadata?.devId;
      if (!remoteDevId) { conn.close(); return; }

      const contacts = getContacts();
      if (contacts[remoteDevId]) {
        this._bindConnection(conn, remoteDevId);
      } else {
        // Ask user approval for new unknown Device ID
        this.cb.onIncomingPairRequest(remoteDevId, (allowed, pin, nickname) => {
          if (!allowed) { conn.close(); return; }
          saveContact(remoteDevId, { name: nickname || remoteDevId, pin, lastTs: Date.now() });
          this._bindConnection(conn, remoteDevId);
        });
      }
    });

    this.peer.on('call', (mediaCall) => {
      const callerDevId = mediaCall.metadata?.devId || 'Unknown';
      if (!this.verifiedPeers.has(callerDevId)) {
        mediaCall.close();
        return;
      }
      this.cb.onIncomingCall(callerDevId, mediaCall);
    });

    this.peer.on('disconnected', () => {
      this.cb.onNetworkState('Reconnecting...');
      try { this.peer.reconnect(); } catch (_) {}
    });

    this.peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && !useTempSuffix) {
        this._createPeer(true);
      }
    });
  }

  dialAllSavedContacts() {
    if (!this.peer || this.peer.disconnected || this.peer.destroyed) return;
    const contacts = getContacts();
    Object.keys(contacts).forEach((remoteDevId) => {
      const existing = this.connections.get(remoteDevId);
      if (!existing || !existing.open) {
        this.connectToDevice(remoteDevId);
      }
    });
  }

  connectToDevice(remoteDevId) {
    if (!this.peer || this.peer.disconnected || this.peer.destroyed) return;
    const targetPeerId = `voxa-${remoteDevId}`;
    try {
      const conn = this.peer.connect(targetPeerId, {
        reliable: true,
        metadata: { devId: this.myId }
      });
      this._bindConnection(conn, remoteDevId);
    } catch (_) {}
  }

  async _bindConnection(conn, remoteDevId) {
    conn.on('open', async () => {
      const contact = getContacts()[remoteDevId];
      if (!contact || !contact.pin) return;
      const key = await deriveSharedAesKey(this.myId, remoteDevId, contact.pin);
      const challenge = await encryptPayload(key, new TextEncoder().encode(`AUTH_${this.myId}`));
      conn.send({ type: 'auth', devId: this.myId, iv: challenge.iv, data: challenge.data });
    });

    conn.on('data', async (pkt) => {
      const contact = getContacts()[remoteDevId];
      if (!contact || !contact.pin) return;
      const key = await deriveSharedAesKey(this.myId, remoteDevId, contact.pin);

      // Unencrypted control ACKs (contain only message IDs, zero content)
      if (pkt.type === 'ack_delivered') {
        this.cb.onMessageDelivered(remoteDevId, pkt.msgId);
        return;
      }
      if (pkt.type === 'ack_read') {
        this.cb.onMessagesRead(remoteDevId, pkt.msgIds);
        return;
      }
      if (pkt.type === 'call_ctrl') {
        this.cb.onCallSignal(remoteDevId, pkt.action);
        return;
      }

      try {
        if (pkt.type === 'auth') {
          const plain = await decryptPayload(key, pkt.iv, pkt.data);
          const str = new TextDecoder().decode(plain);
          if (str === `AUTH_${remoteDevId}`) {
            this.connections.set(remoteDevId, conn);
            this.verifiedPeers.add(remoteDevId);
            this.cb.onPeerStatusChanged(remoteDevId, true);
            if (!pkt.isAck) {
              const reply = await encryptPayload(key, new TextEncoder().encode(`AUTH_${this.myId}`));
              conn.send({ type: 'auth', devId: this.myId, iv: reply.iv, data: reply.data, isAck: true });
            }
          }
          return;
        }

        if (!this.verifiedPeers.has(remoteDevId)) return;

        if (pkt.type === 'text') {
          const plain = await decryptPayload(key, pkt.iv, pkt.data);
          const text = new TextDecoder().decode(plain);
          // Immediately confirm delivery (Double Grey Tick)
          conn.send({ type: 'ack_delivered', msgId: pkt.id });
          this.cb.onIncomingText(remoteDevId, { id: pkt.id, text, ts: pkt.ts });
        }

        // 64KB Chunked File Assembly
        if (pkt.type === 'file_start') {
          this.incomingBuffers.set(pkt.id, {
            chunks: new Array(pkt.totalChunks),
            received: 0,
            total: pkt.totalChunks,
            name: pkt.name,
            size: pkt.size,
            mime: pkt.mime,
            ts: pkt.ts
          });
        } else if (pkt.type === 'file_chunk') {
          const entry = this.incomingBuffers.get(pkt.id);
          if (!entry) return;
          const plainChunk = await decryptPayload(key, pkt.iv, pkt.data);
          entry.chunks[pkt.index] = plainChunk;
          entry.received++;

          if (entry.received === entry.total) {
            this.incomingBuffers.delete(pkt.id);
            const blob = new Blob(entry.chunks, { type: entry.mime });
            conn.send({ type: 'ack_delivered', msgId: pkt.id });
            this.cb.onIncomingFile(remoteDevId, {
              id: pkt.id, name: entry.name, size: entry.size, mime: entry.mime, blob, ts: entry.ts
            });
          }
        }
      } catch (_) {
        this.cb.onPinError(remoteDevId);
      }
    });

    conn.on('close', () => {
      if (this.connections.get(remoteDevId) === conn) {
        this.connections.delete(remoteDevId);
        this.verifiedPeers.delete(remoteDevId);
        this.cb.onPeerStatusChanged(remoteDevId, false);
      }
    });
  }

  isPeerOnline(remoteDevId) {
    const c = this.connections.get(remoteDevId);
    return !!(c && c.open && this.verifiedPeers.has(remoteDevId));
  }

  async sendEncryptedText(remoteDevId, msgObj) {
    if (!this.isPeerOnline(remoteDevId)) return false;
    const contact = getContacts()[remoteDevId];
    const key = await deriveSharedAesKey(this.myId, remoteDevId, contact.pin);
    const enc = await encryptPayload(key, new TextEncoder().encode(msgObj.text));
    this.connections.get(remoteDevId).send({
      type: 'text', id: msgObj.id, ts: msgObj.ts, iv: enc.iv, data: enc.data
    });
    return true;
  }

  async sendEncryptedFile(remoteDevId, fileObj, onProgress) {
    if (!this.isPeerOnline(remoteDevId)) return false;
    const conn = this.connections.get(remoteDevId);
    const contact = getContacts()[remoteDevId];
    const key = await deriveSharedAesKey(this.myId, remoteDevId, contact.pin);

    const buffer = await fileObj.blob.arrayBuffer();
    const totalChunks = Math.max(1, Math.ceil(buffer.byteLength / CHUNK_SIZE));

    conn.send({
      type: 'file_start',
      id: fileObj.id,
      name: fileObj.name,
      size: fileObj.size,
      mime: fileObj.mime,
      ts: fileObj.ts,
      totalChunks
    });

    for (let i = 0; i < totalChunks; i++) {
      const slice = buffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const enc = await encryptPayload(key, slice);
      conn.send({
        type: 'file_chunk',
        id: fileObj.id,
        index: i,
        iv: enc.iv,
        data: enc.data
      });
      if (onProgress) onProgress(Math.round(((i + 1) / totalChunks) * 100));
      // Yield every 8 chunks so UI remains 60fps smooth
      if (i % 8 === 7) await new Promise((r) => setTimeout(r, 10));
    }
    return true;
  }

  sendReadAck(remoteDevId, msgIds) {
    if (!this.isPeerOnline(remoteDevId) || !msgIds.length) return;
    this.connections.get(remoteDevId).send({ type: 'ack_read', msgIds });
  }

  sendCallControl(remoteDevId, action) {
    if (!this.isPeerOnline(remoteDevId)) return;
    this.connections.get(remoteDevId).send({ type: 'call_ctrl', action });
  }

  startMediaCall(remoteDevId, stream, withVideo) {
    if (!this.isPeerOnline(remoteDevId)) return null;
    return this.peer.call(`voxa-${remoteDevId}`, stream, {
      metadata: { devId: this.myId, video: withVideo }
    });
  }
}
