const DB_NAME = 'VoxaIndexedDB_v1';
const STORE_MSGS = 'messages';
const MAX_CACHE_BYTES = 100 * 1024 * 1024; // 100 MB Max Total Cache
const MAX_SINGLE_FILE_CACHE = 50 * 1024 * 1024; // > 50 MB never stored locally

const CONTACTS_KEY = 'voxa_contacts_v1';
const RETENTION_KEY = 'voxa_retention_days_v1';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_MSGS)) {
        const store = db.createObjectStore(STORE_MSGS, { keyPath: 'id' });
        store.createIndex('peerId', 'peerId', { unique: false });
        store.createIndex('ts', 'ts', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function getRetentionDays() {
  const val = parseInt(localStorage.getItem(RETENTION_KEY) || '1', 10);
  return Math.min(10, Math.max(1, isNaN(val) ? 1 : val));
}

export function setRetentionDays(days) {
  const safe = Math.min(10, Math.max(1, parseInt(days, 10) || 1));
  localStorage.setItem(RETENTION_KEY, String(safe));
}

// Contacts Registry (Device ID + Custom Nickname + PIN + Unread Count)
export function getContacts() {
  return JSON.parse(localStorage.getItem(CONTACTS_KEY) || '{}');
}

export function saveContact(peerId, data) {
  const all = getContacts();
  all[peerId] = { ...(all[peerId] || {}), peerId, ...data };
  localStorage.setItem(CONTACTS_KEY, JSON.stringify(all));
  return all[peerId];
}

export function removeContact(peerId) {
  const all = getContacts();
  delete all[peerId];
  localStorage.setItem(CONTACTS_KEY, JSON.stringify(all));
}

// Save Message or Media (Enforces >50MB skip & 100MB rolling limit)
export async function saveMessageRecord(record) {
  const byteSize = record.blob ? record.blob.size : (record.text ? record.text.length * 2 : 128);
  // Rule: Do NOT locally store media larger than 50MB
  if (record.kind === 'file' && byteSize > MAX_SINGLE_FILE_CACHE) {
    return;
  }

  const db = await openDb();
  const tx = db.transaction(STORE_MSGS, 'readwrite');
  tx.objectStore(STORE_MSGS).put({ ...record, byteSize });
  await new Promise((res) => (tx.oncomplete = res));
  await enforceRetentionAndCap();
}

export async function updateMessageTick(msgId, newTick) {
  const db = await openDb();
  const tx = db.transaction(STORE_MSGS, 'readwrite');
  const store = tx.objectStore(STORE_MSGS);
  const req = store.get(msgId);
  req.onsuccess = () => {
    const item = req.result;
    if (item && (item.tick || 1) < newTick) {
      item.tick = newTick;
      store.put(item);
    }
  };
}

export async function markOutgoingReadForPeer(peerId, msgIds = null) {
  const db = await openDb();
  const tx = db.transaction(STORE_MSGS, 'readwrite');
  const store = tx.objectStore(STORE_MSGS);
  const idx = store.index('peerId').openCursor(IDBKeyRange.only(peerId));
  idx.onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    const m = cursor.value;
    if (m.dir === 'out' && (m.tick || 1) < 3 && (!msgIds || msgIds.includes(m.id))) {
      m.tick = 3;
      cursor.update(m);
    }
    cursor.continue();
  };
}

export async function getMessagesForPeer(peerId) {
  await enforceRetentionAndCap();
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_MSGS, 'readonly');
    const req = tx.objectStore(STORE_MSGS).index('peerId').getAll(IDBKeyRange.only(peerId));
    req.onsuccess = () => {
      const list = (req.result || []).sort((a, b) => a.ts - b.ts);
      resolve(list);
    };
  });
}

export async function clearMessagesForPeer(peerId) {
  const db = await openDb();
  const tx = db.transaction(STORE_MSGS, 'readwrite');
  const store = tx.objectStore(STORE_MSGS);
  const idx = store.index('peerId').openCursor(IDBKeyRange.only(peerId));
  idx.onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
}

// Auto-Purge expired days (1–10 days) & trim oldest if total exceeds 100MB
export async function enforceRetentionAndCap() {
  const days = getRetentionDays();
  const cutoffTs = Date.now() - days * 24 * 60 * 60 * 1000;
  const db = await openDb();

  const allItems = await new Promise((resolve) => {
    const tx = db.transaction(STORE_MSGS, 'readonly');
    const req = tx.objectStore(STORE_MSGS).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.ts - b.ts));
  });

  let totalBytes = 0;
  const toDeleteIds = [];

  for (const item of allItems) {
    if (item.ts < cutoffTs) {
      toDeleteIds.push(item.id);
    } else {
      totalBytes += item.byteSize || 128;
    }
  }

  for (const item of allItems) {
    if (totalBytes <= MAX_CACHE_BYTES) break;
    if (!toDeleteIds.includes(item.id)) {
      toDeleteIds.push(item.id);
      totalBytes -= item.byteSize || 128;
    }
  }

  if (toDeleteIds.length > 0) {
    const tx = db.transaction(STORE_MSGS, 'readwrite');
    const store = tx.objectStore(STORE_MSGS);
    toDeleteIds.forEach((id) => store.delete(id));
  }
  return Math.max(0, totalBytes);
}
