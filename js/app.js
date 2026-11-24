import {
  getContacts, saveContact, removeContact,
  saveMessageRecord, updateMessageTick, markOutgoingReadForPeer,
  getMessagesForPeer, clearMessagesForPeer,
  getRetentionDays, setRetentionDays, enforceRetentionAndCap
} from './storage.js';
import { VoxaRtcEngine, getMyDeviceId } from './crypto-rtc.js';
import {
  showToast, renderContactList, appendBubbleToStream, setBubbleTickUI, formatBytes
} from './ui-chat.js';

const MASTER_ACCESS_CODE = 'voxa2026';
const UNLOCK_KEY = 'voxa_unlocked_modular_v1';

let rtc = null;
let activePeerId = null;
const onlinePeers = new Set();
const unreadIncomingIds = new Map(); // peerId -> Set<msgId>

// Continuous Voice Mic state
let recognition = null, isListening = false, manualStop = false, voiceBuffer = '';
let selectedCopyText = '', selectedBubble = null;

// Call state
let activeCall = null, incomingCall = null, localStream = null, isMuted = false, ringTimer = null, audioCtx = null;

window.addEventListener('DOMContentLoaded', () => {
  const myId = getMyDeviceId();
  document.getElementById('lblMyDeviceId').textContent = myId;
  document.getElementById('modalMyId').textContent = myId;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  const params = new URLSearchParams(location.search);
  if (params.get('key') === MASTER_ACCESS_CODE) localStorage.setItem(UNLOCK_KEY, '1');

  if (localStorage.getItem(UNLOCK_KEY) !== '1') {
    document.getElementById('accessModal').classList.remove('hidden');
    document.getElementById('btnUnlockMaster').onclick = () => {
      if (document.getElementById('inpMasterCode').value.trim() === MASTER_ACCESS_CODE) {
        localStorage.setItem(UNLOCK_KEY, '1');
        document.getElementById('accessModal').classList.add('hidden');
        bootApp(params);
      } else {
        showToast('Wrong Passcode');
      }
    };
    return;
  }

  bootApp(params);
});

function bootApp(params) {
  // Handle 1-click Magic Invite link (?add=VX-XXXX&pin=123456&name=Laptop)
  const addId = (params.get('add') || '').trim().toUpperCase();
  const addPin = (params.get('pin') || '').trim();
  const addName = (params.get('name') || '').trim();
  if (addId && addPin.length >= 4 && addId !== getMyDeviceId()) {
    saveContact(addId, { name: addName || addId, pin: addPin, lastTs: Date.now() });
    history.replaceState({}, '', '/');
  }

  rtc = new VoxaRtcEngine({
    onNetworkState: (st) => {
      document.getElementById('lblMyNetworkState').textContent = st;
    },
    onPeerStatusChanged: async (peerId, isOnline) => {
      if (isOnline) {
        onlinePeers.add(peerId);
        // Flush any queued offline messages (Tick 1 -> delivered ACK turns it Tick 2)
        const msgs = await getMessagesForPeer(peerId);
        for (const m of msgs) {
          if (m.dir === 'out' && (m.tick || 1) === 1 && m.kind === 'text') {
            await rtc.sendEncryptedText(peerId, m);
          }
        }
        // Send Read Receipt ONLY if user is actively viewing this exact chat right now
        if (activePeerId === peerId && document.visibilityState === 'visible') {
          flushReadReceiptsForActiveChat();
        }
      } else {
        onlinePeers.delete(peerId);
      }
      refreshHomeUI();
      updateActiveChatHeader();
    },
    onIncomingPairRequest: (remoteDevId, decideCb) => {
      const modal = document.getElementById('approvalModal');
      document.getElementById('approvalMessage').textContent =
        `Device [${remoteDevId}] wants to connect. Enter the same PIN you set on that device.`;
      modal.classList.remove('hidden');

      document.getElementById('btnBlockPeer').onclick = () => {
        modal.classList.add('hidden');
        decideCb(false);
      };
      document.getElementById('btnAllowPeer').onclick = () => {
        const pin = prompt('Enter the shared Secret PIN to accept:');
        if (!pin || pin.length < 4) return showToast('PIN must be 4+ chars');
        modal.classList.add('hidden');
        decideCb(true, pin.trim(), remoteDevId);
        refreshHomeUI();
      };
    },
    onIncomingText: async (peerId, pkt) => {
      const msg = { id: pkt.id, peerId, kind: 'text', text: pkt.text, dir: 'in', ts: pkt.ts };
      await saveMessageRecord(msg);
      const isViewingThisChat = (activePeerId === peerId && document.visibilityState === 'visible');

      saveContact(peerId, {
        lastMsg: pkt.text,
        lastTs: pkt.ts,
        unread: isViewingThisChat ? 0 : ((getContacts()[peerId]?.unread || 0) + 1)
      });

      if (isViewingThisChat) {
        appendBubbleToStream(msg, handleBubbleSelect);
        rtc.sendReadAck(peerId, [pkt.id]);
      } else {
        if (!unreadIncomingIds.has(peerId)) unreadIncomingIds.set(peerId, new Set());
        unreadIncomingIds.get(peerId).add(pkt.id);
        showToast(`New message from ${getContacts()[peerId]?.name || peerId}`);
      }
      refreshHomeUI();
    },
    onIncomingFile: async (peerId, pkt) => {
      const msg = {
        id: pkt.id, peerId, kind: 'file', name: pkt.name, size: pkt.size, mime: pkt.mime, blob: pkt.blob, dir: 'in', ts: pkt.ts
      };
      await saveMessageRecord(msg);
      const isViewingThisChat = (activePeerId === peerId && document.visibilityState === 'visible');

      saveContact(peerId, {
        lastMsg: `📎 ${pkt.name}`,
        lastTs: pkt.ts,
        unread: isViewingThisChat ? 0 : ((getContacts()[peerId]?.unread || 0) + 1)
      });

      if (isViewingThisChat) {
        appendBubbleToStream(msg, handleBubbleSelect);
        rtc.sendReadAck(peerId, [pkt.id]);
      } else {
        if (!unreadIncomingIds.has(peerId)) unreadIncomingIds.set(peerId, new Set());
        unreadIncomingIds.get(peerId).add(pkt.id);
        showToast(`File received: ${pkt.name}`);
      }
      refreshHomeUI();
    },
    onMessageDelivered: async (peerId, msgId) => {
      await updateMessageTick(msgId, 2);
      if (activePeerId === peerId) setBubbleTickUI(msgId, 2);
    },
    onMessagesRead: async (peerId, msgIds) => {
      await markOutgoingReadForPeer(peerId, msgIds);
      if (activePeerId === peerId && Array.isArray(msgIds)) {
        msgIds.forEach((id) => setBubbleTickUI(id, 3));
      }
    },
    onPinError: (peerId) => {
      showToast(`PIN mismatch with ${peerId}`);
    },
    onIncomingCall: (callerDevId, callObj) => {
      incomingCall = callObj;
      const wantVideo = callObj.metadata?.video !== false;
      const name = getContacts()[callerDevId]?.name || callerDevId;
      document.getElementById('incomingCallerName').textContent = name;
      document.getElementById('incomingCallMode').textContent = wantVideo ? 'Incoming Video Call' : 'Incoming Voice Call';
      document.getElementById('incomingCallBanner').style.display = 'flex';
      startRingtone();
    },
    onCallSignal: (_, action) => {
      if (action === 'end' || action === 'decline') {
        cleanupCallUI(false);
        showToast(action === 'decline' ? 'Call declined' : 'Call ended');
      }
    }
  });

  rtc.start();
  setupUIEvents();
  setupVoiceMic();
  refreshHomeUI();
}

function refreshHomeUI() {
  renderContactList(onlinePeers, (peerId) => openChatScreen(peerId));
}

async function openChatScreen(peerId) {
  activePeerId = peerId;
  saveContact(peerId, { unread: 0 });
  refreshHomeUI();

  document.getElementById('homeScreen').classList.add('hidden');
  document.getElementById('chatScreen').classList.remove('hidden');
  updateActiveChatHeader();

  const stream = document.getElementById('chatStream');
  stream.innerHTML = '';
  const history = await getMessagesForPeer(peerId);
  history.forEach((m) => appendBubbleToStream(m, handleBubbleSelect));

  flushReadReceiptsForActiveChat();
}

function flushReadReceiptsForActiveChat() {
  if (!activePeerId || document.visibilityState !== 'visible') return;
  const set = unreadIncomingIds.get(activePeerId);
  if (set && set.size > 0) {
    rtc.sendReadAck(activePeerId, Array.from(set));
    set.clear();
  }
}

function updateActiveChatHeader() {
  if (!activePeerId) return;
  const c = getContacts()[activePeerId];
  if (!c) return;
  const isOnline = onlinePeers.has(activePeerId);
  document.getElementById('chatAvatarLetter').textContent = (c.name || c.peerId).charAt(0).toUpperCase();
  document.getElementById('chatPeerName').textContent = c.name || c.peerId;
  const sub = document.getElementById('chatPeerSub');
  sub.textContent = isOnline ? 'online • encrypted' : `${c.peerId} • offline`;
  sub.className = isOnline ? 'peer-sub online' : 'peer-sub';
  document.getElementById('chatOnlineDot').className = isOnline ? 'status-dot online' : 'status-dot';
}

function setupUIEvents() {
  // Copy Own Device ID
  document.getElementById('btnCopyMyId').onclick = () => {
    navigator.clipboard.writeText(getMyDeviceId());
    showToast(`Copied ID: ${getMyDeviceId()}`);
  };

  // Add Device Modal
  const openAdd = () => document.getElementById('addDeviceModal').classList.remove('hidden');
  document.getElementById('btnOpenAddDevice').onclick = openAdd;
  document.getElementById('fabNewChat').onclick = openAdd;
  document.getElementById('btnCancelAddDev').onclick = () => document.getElementById('addDeviceModal').classList.add('hidden');
  document.getElementById('btnSaveAddDev').onclick = () => {
    const name = document.getElementById('inpContactName').value.trim();
    const targetId = document.getElementById('inpTargetDevId').value.trim().toUpperCase();
    const pin = document.getElementById('inpSharedPin').value.trim();
    if (!targetId || pin.length < 4) return showToast('Enter Target Device ID & 4+ char PIN');
    if (targetId === getMyDeviceId()) return showToast('Cannot pair with your own ID');

    saveContact(targetId, { name: name || targetId, pin, lastTs: Date.now(), unread: 0 });
    document.getElementById('addDeviceModal').classList.add('hidden');
    rtc.connectToDevice(targetId);
    refreshHomeUI();
    openChatScreen(targetId);
  };

  // Settings Modal (Retention 1-10 Days + Cache Usage)
  document.getElementById('btnOpenSettings').onclick = async () => {
    document.getElementById('selRetentionDays').value = String(getRetentionDays());
    const used = await enforceRetentionAndCap();
    document.getElementById('lblStorageUsage').textContent = `Used Cache: ${formatBytes(used)} / 100 MB`;
    document.getElementById('settingsModal').classList.remove('hidden');
  };
  document.getElementById('btnCloseSettings').onclick = () => document.getElementById('settingsModal').classList.add('hidden');
  document.getElementById('btnSaveSettings').onclick = async () => {
    setRetentionDays(document.getElementById('selRetentionDays').value);
    await enforceRetentionAndCap();
    document.getElementById('settingsModal').classList.add('hidden');
    showToast(`Retention set to ${getRetentionDays()} day(s)`);
  };

  // Back to Home Screen
  document.getElementById('btnBackHome').onclick = () => {
    stopVoiceMic();
    activePeerId = null;
    document.getElementById('chatScreen').classList.add('hidden');
    document.getElementById('homeScreen').classList.remove('hidden');
    refreshHomeUI();
  };

  // Chat 3-Dot Menu
  const chatDd = document.getElementById('chatDropdown');
  document.getElementById('btnChatMenu').onclick = (e) => {
    e.stopPropagation();
    chatDd.classList.toggle('hidden');
  };
  document.body.onclick = () => chatDd.classList.add('hidden');

  document.getElementById('btnRenameContact').onclick = () => {
    if (!activePeerId) return;
    const cur = getContacts()[activePeerId]?.name || activePeerId;
    const next = prompt('Rename device:', cur);
    if (next && next.trim()) {
      saveContact(activePeerId, { name: next.trim() });
      updateActiveChatHeader();
      refreshHomeUI();
    }
  };

  document.getElementById('btnCopyMagicInvite').onclick = () => {
    if (!activePeerId) return;
    const c = getContacts()[activePeerId];
    const url = `${location.origin}/?key=${encodeURIComponent(MASTER_ACCESS_CODE)}&add=${encodeURIComponent(getMyDeviceId())}&pin=${encodeURIComponent(c.pin)}&name=My+Device`;
    navigator.clipboard.writeText(url);
    showToast('Magic Pair Link copied!');
  };

  document.getElementById('btnClearThisChat').onclick = async () => {
    if (!activePeerId) return;
    await clearMessagesForPeer(activePeerId);
    document.getElementById('chatStream').innerHTML = '';
    showToast('Chat cleared');
  };

  document.getElementById('btnUnpairContact').onclick = async () => {
    if (!activePeerId) return;
    await clearMessagesForPeer(activePeerId);
    removeContact(activePeerId);
    document.getElementById('btnBackHome').click();
    showToast('Device unpaired');
  };

  // Input Bar & Pickers
  const inp = document.getElementById('msgInput');
  inp.oninput = updateFabIcon;
  inp.onkeydown = (e) => { if (e.key === 'Enter') handleFabClick(); };
  document.getElementById('fabMicSend').onclick = handleFabClick;

  document.getElementById('btnPickFiles').onclick = () => document.getElementById('fileFolderPicker').click();
  document.getElementById('btnPickGallery').onclick = () => document.getElementById('galleryMediaPicker').click();

  const onFilesChosen = async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) await sendFileMessage(file);
    e.target.value = '';
  };
  document.getElementById('fileFolderPicker').onchange = onFilesChosen;
  document.getElementById('galleryMediaPicker').onchange = onFilesChosen;

  // Long-press Copy Bar
  document.getElementById('btnCancelCopy').onclick = clearCopySelection;
  document.getElementById('btnConfirmCopy').onclick = () => {
    if (selectedCopyText) navigator.clipboard.writeText(selectedCopyText);
    showToast('Copied');
    clearCopySelection();
  };

  // Calls
  document.getElementById('btnVideoCall').onclick = () => initiateCall(true);
  document.getElementById('btnAudioCall').onclick = () => initiateCall(false);
  document.getElementById('btnAcceptCall').onclick = acceptCall;
  document.getElementById('btnDeclineCall').onclick = declineCall;
  document.getElementById('btnCallHangup').onclick = () => cleanupCallUI(true);
  document.getElementById('btnCallMute').onclick = () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
    document.getElementById('btnCallMute').textContent = isMuted ? '🔇' : '🎙️';
  };
  document.getElementById('btnCallVideoToggle').onclick = () => {
    if (!localStream) return;
    const tracks = localStream.getVideoTracks();
    if (!tracks.length) return;
    const next = !tracks[0].enabled;
    tracks.forEach((t) => (t.enabled = next));
    document.getElementById('localVideo').style.display = next ? 'block' : 'none';
  };

  // Visibility Read Receipt Sync
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopVoiceMic();
    else if (document.visibilityState === 'visible') flushReadReceiptsForActiveChat();
  });
}

function handleBubbleSelect(text, bubbleEl) {
  clearCopySelection();
  selectedCopyText = text;
  selectedBubble = bubbleEl;
  bubbleEl.classList.add('selected');
  document.getElementById('copyBar').classList.remove('hidden');
}

function clearCopySelection() {
  if (selectedBubble) selectedBubble.classList.remove('selected');
  selectedBubble = null;
  selectedCopyText = '';
  document.getElementById('copyBar').classList.add('hidden');
}

// Sending Text & Files
async function sendTextMessage() {
  stopVoiceMic();
  if (!activePeerId) return;
  const inp = document.getElementById('msgInput');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  voiceBuffer = '';
  updateFabIcon();

  const msg = {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    peerId: activePeerId,
    kind: 'text',
    text,
    dir: 'out',
    ts: Date.now(),
    tick: 1
  };

  await saveMessageRecord(msg);
  saveContact(activePeerId, { lastMsg: text, lastTs: msg.ts });
  appendBubbleToStream(msg, handleBubbleSelect);
  refreshHomeUI();

  await rtc.sendEncryptedText(activePeerId, msg);
}

async function sendFileMessage(file) {
  if (!activePeerId) return;
  const msg = {
    id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    peerId: activePeerId,
    kind: 'file',
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    blob: file,
    dir: 'out',
    ts: Date.now(),
    tick: 1
  };

  await saveMessageRecord(msg); // Automatically skips if > 50MB
  saveContact(activePeerId, { lastMsg: `📎 ${file.name}`, lastTs: msg.ts });
  appendBubbleToStream(msg, handleBubbleSelect);
  refreshHomeUI();

  const sent = await rtc.sendEncryptedFile(activePeerId, msg, null);
  if (!sent) showToast('Peer offline — connect device to send files');
}

// Waveform Mic Controls
function updateFabIcon() {
  const hasText = document.getElementById('msgInput').value.trim().length > 0;
  document.getElementById('svgMic').classList.toggle('hidden', isListening || hasText);
  document.getElementById('svgStop').classList.toggle('hidden', !isListening);
  document.getElementById('svgSend').classList.toggle('hidden', isListening || !hasText);
}

function setWaveformVisible(show) {
  document.getElementById('msgInput').classList.toggle('hidden', show);
  document.getElementById('btnPickFiles').classList.toggle('hidden', show);
  document.getElementById('btnPickGallery').classList.toggle('hidden', show);
  document.getElementById('waveformBox').classList.toggle('hidden', !show);
}

function handleFabClick() {
  if (isListening) { stopVoiceMic(); return; }
  if (document.getElementById('msgInput').value.trim().length > 0) sendTextMessage();
  else startVoiceMic();
}

function setupVoiceMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  recognition = new SR();
  recognition.lang = 'hi-IN';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    isListening = true;
    document.getElementById('fabMicSend').classList.add('recording');
    setWaveformVisible(true);
    updateFabIcon();
  };

  recognition.onresult = (e) => {
    let finalPart = '', interimPart = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalPart += t + ' ';
      else interimPart += t;
    }
    if (finalPart) voiceBuffer = (voiceBuffer + ' ' + finalPart).trim();
    document.getElementById('msgInput').value = (voiceBuffer + ' ' + interimPart).trim();
  };

  recognition.onend = () => {
    if (!manualStop && document.visibilityState === 'visible') {
      try { recognition.start(); return; } catch (_) {}
    }
    isListening = false;
    document.getElementById('fabMicSend').classList.remove('recording');
    setWaveformVisible(false);
    updateFabIcon();
  };
}

function startVoiceMic() {
  if (!recognition) return showToast('Voice typing not supported');
  manualStop = false;
  voiceBuffer = document.getElementById('msgInput').value.trim();
  try { recognition.start(); } catch (_) {}
}

function stopVoiceMic() {
  manualStop = true;
  isListening = false;
  document.getElementById('fabMicSend').classList.remove('recording');
  setWaveformVisible(false);
  if (recognition) { try { recognition.stop(); } catch (_) {} }
  updateFabIcon();
}

// Audio/Video Call Functions
function startRingtone() {
  stopRingtone();
  const play = () => {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.setValueAtTime(540, audioCtx.currentTime);
      osc.frequency.setValueAtTime(680, audioCtx.currentTime + 0.16);
      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start(); osc.stop(audioCtx.currentTime + 0.5);
    } catch (_) {}
  };
  play();
  ringTimer = setInterval(play, 2200);
}

function stopRingtone() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
}

async function initiateCall(withVideo) {
  if (!activePeerId || !rtc.isPeerOnline(activePeerId)) return showToast('Device offline');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
  } catch (_) {
    if (withVideo) {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      withVideo = false;
    } else return showToast('Allow microphone access');
  }
  openCallOverlay(withVideo, 'Ringing...');
  const call = rtc.startMediaCall(activePeerId, localStream, withVideo);
  if (call) bindCallStream(call);
}

async function acceptCall() {
  stopRingtone();
  document.getElementById('incomingCallBanner').style.display = 'none';
  if (!incomingCall) return;
  const wantVideo = incomingCall.metadata?.video !== false;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo });
    openCallOverlay(wantVideo, 'Connected');
    incomingCall.answer(localStream);
    bindCallStream(incomingCall);
    incomingCall = null;
  } catch (_) {
    declineCall();
  }
}

function declineCall() {
  stopRingtone();
  document.getElementById('incomingCallBanner').style.display = 'none';
  if (incomingCall) {
    const callerId = incomingCall.metadata?.devId;
    if (callerId) rtc.sendCallControl(callerId, 'decline');
    try { incomingCall.close(); } catch (_) {}
    incomingCall = null;
  }
}

function openCallOverlay(withVideo, label) {
  document.getElementById('callPeerLabel').textContent = getContacts()[activePeerId]?.name || 'Voxa Call';
  document.getElementById('callTimerLabel').textContent = label;
  document.getElementById('localVideo').srcObject = localStream;
  document.getElementById('localVideo').style.display = withVideo ? 'block' : 'none';
  document.getElementById('callAvatarCenter').style.display = withVideo ? 'none' : 'block';
  document.getElementById('callOverlay').classList.remove('hidden');
}

function bindCallStream(call) {
  activeCall = call;
  call.on('stream', (remote) => {
    document.getElementById('remoteVideo').srcObject = remote;
    const hasVid = remote.getVideoTracks().length > 0;
    document.getElementById('callAvatarCenter').style.display = hasVid ? 'none' : 'block';
    document.getElementById('callTimerLabel').textContent = 'Connected • E2EE';
  });
  call.on('close', () => cleanupCallUI(false));
  call.on('error', () => cleanupCallUI(false));
}

function cleanupCallUI(notifyRemote) {
  stopRingtone();
  if (notifyRemote && activePeerId) rtc.sendCallControl(activePeerId, 'end');
  if (activeCall) { try { activeCall.close(); } catch (_) {} activeCall = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  isMuted = false;
  document.getElementById('btnCallMute').textContent = '🎙️';
  document.getElementById('remoteVideo').srcObject = null;
  document.getElementById('callOverlay').classList.add('hidden');
}
