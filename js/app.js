import {
  getContacts, saveContact, removeContact,
  saveMessageRecord, updateMessageTick, markOutgoingReadForPeer,
  getMessagesForPeer, clearMessagesForPeer,
  getRetentionDays, setRetentionDays, enforceRetentionAndCap
} from './storage.js';
import { VoxaRtcEngine, getMyDeviceId } from './crypto-rtc.js';
import {
  showToast, renderContactList, appendBubbleToStream, setBubbleTickUI,
  formatBytes, copyImagesToClipboard
} from './ui-chat.js';

const MASTER_ACCESS_CODE = 'voxa2026';
const UNLOCK_KEY = 'voxa_unlocked_modular_v1';

let rtc = null;
let activePeerId = null;
let isDirectSingleChatMode = false;
const onlinePeers = new Set();
const unreadIncomingIds = new Map();
const memoryLargeFileQueue = new Map(); // For >50MB files queued while offline

const selectedRecords = new Map();
let lightboxCurrentMsg = null;

let recognition = null, isListening = false, manualStop = false, voiceBuffer = '';
let activeCall = null, incomingCall = null, localStream = null;
let isMuted = false, isCamOff = false, ringTimer = null, callDurationTimer = null, callSeconds = 0, audioCtx = null;

window.addEventListener('DOMContentLoaded', () => {
  const myId = getMyDeviceId();
  document.getElementById('lblMyDeviceId').textContent = myId;
  document.getElementById('modalMyId').textContent = myId;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Keep chat stream scrolled above mobile keyboard whenever keyboard opens
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      const stream = document.getElementById('chatStream');
      if (stream) stream.scrollTop = stream.scrollHeight;
    });
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
  const addId = (params.get('add') || '').trim().toUpperCase();
  const addPin = (params.get('pin') || '').trim();
  const addName = (params.get('name') || '').trim();
  isDirectSingleChatMode = params.get('direct') === '1';

  if (addId && addPin.length >= 4 && addId !== getMyDeviceId()) {
    saveContact(addId, { name: addName || addId, pin: addPin, lastTs: Date.now(), unread: 0 });
    if (!isDirectSingleChatMode) history.replaceState({}, '', '/');
  }

  rtc = new VoxaRtcEngine({
    onNetworkState: (st) => {
      document.getElementById('lblMyNetworkState').textContent = st;
    },
    onPeerStatusChanged: async (peerId, isOnline) => {
      if (isOnline) {
        onlinePeers.add(peerId);
        // Flush ALL queued offline messages AND offline photos/files from IndexedDB
        const msgs = await getMessagesForPeer(peerId);
        for (const m of msgs) {
          if (m.dir === 'out' && (m.tick || 1) === 1) {
            if (m.kind === 'text') {
              await rtc.sendEncryptedText(peerId, m);
            } else if (m.kind === 'file' && m.blob) {
              await rtc.sendEncryptedFile(peerId, m, null);
            }
          }
        }
        // Flush any >50MB files held in RAM queue
        const bigQueue = memoryLargeFileQueue.get(peerId) || [];
        while (bigQueue.length > 0) {
          const item = bigQueue.shift();
          await rtc.sendEncryptedFile(peerId, item, null);
        }

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
        `Security Check: Device [${remoteDevId}] wants to pair. Enter your Secret PIN to verify.`;
      modal.classList.remove('hidden');

      document.getElementById('btnBlockPeer').onclick = () => {
        modal.classList.add('hidden');
        decideCb(false);
      };
      document.getElementById('btnAllowPeer').onclick = () => {
        const pin = prompt('Enter shared Secret PIN:');
        if (!pin || pin.length < 4) return showToast('PIN must be 4+ chars');
        modal.classList.add('hidden');
        decideCb(true, pin.trim(), remoteDevId);
        refreshHomeUI();
      };
    },
    onIncomingText: async (peerId, pkt) => {
      const msg = { id: pkt.id, peerId, kind: 'text', text: pkt.text, dir: 'in', ts: pkt.ts };
      await saveMessageRecord(msg);
      const isViewing = (activePeerId === peerId && document.visibilityState === 'visible');

      saveContact(peerId, {
        lastMsg: pkt.text,
        lastTs: pkt.ts,
        unread: isViewing ? 0 : ((getContacts()[peerId]?.unread || 0) + 1)
      });

      if (isViewing) {
        appendBubbleToStream(msg, bubbleHandlers);
        rtc.sendReadAck(peerId, [pkt.id]);
      } else {
        if (!unreadIncomingIds.has(peerId)) unreadIncomingIds.set(peerId, new Set());
        unreadIncomingIds.get(peerId).add(pkt.id);
        showToast(`Message from ${getContacts()[peerId]?.name || peerId}`);
      }
      refreshHomeUI();
    },
    onIncomingFile: async (peerId, pkt) => {
      const msg = {
        id: pkt.id, peerId, kind: 'file', name: pkt.name, size: pkt.size, mime: pkt.mime, blob: pkt.blob, dir: 'in', ts: pkt.ts
      };
      await saveMessageRecord(msg);
      const isViewing = (activePeerId === peerId && document.visibilityState === 'visible');

      saveContact(peerId, {
        lastMsg: pkt.mime.startsWith('image/') ? '📷 Photo' : (pkt.mime.startsWith('video/') ? '🎥 Video' : `📎 ${pkt.name}`),
        lastTs: pkt.ts,
        unread: isViewing ? 0 : ((getContacts()[peerId]?.unread || 0) + 1)
      });

      if (isViewing) {
        appendBubbleToStream(msg, bubbleHandlers);
        rtc.sendReadAck(peerId, [pkt.id]);
      } else {
        if (!unreadIncomingIds.has(peerId)) unreadIncomingIds.set(peerId, new Set());
        unreadIncomingIds.get(peerId).add(pkt.id);
        showToast(`Media received from ${getContacts()[peerId]?.name || peerId}`);
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
      showToast(`Security Alert: Invalid PIN from ${peerId}`);
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

  if (isDirectSingleChatMode) {
    const targetPeer = addId || Object.keys(getContacts())[0];
    if (targetPeer) {
      document.getElementById('btnBackHome').classList.add('hidden');
      openChatScreen(targetPeer);
    }
  }
}

const bubbleHandlers = {
  isSelectionActive: () => selectedRecords.size > 0,
  onToggleSelect: (msg, bubbleEl, checkEl) => {
    if (selectedRecords.has(msg.id)) {
      selectedRecords.delete(msg.id);
      bubbleEl.classList.remove('selected');
      checkEl.classList.add('hidden');
    } else {
      selectedRecords.set(msg.id, { msg, bubbleEl, checkEl });
      bubbleEl.classList.add('selected');
      checkEl.classList.remove('hidden');
    }
    updateSelectionBarUI();
  },
  onOpenLightbox: (msg, isVideo) => openMediaLightbox(msg, isVideo)
};

function updateSelectionBarUI() {
  const bar = document.getElementById('copyBar');
  if (selectedRecords.size === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  document.getElementById('lblSelectedCount').textContent = `${selectedRecords.size} selected`;

  const items = Array.from(selectedRecords.values()).map((x) => x.msg);
  const photoCount = items.filter((m) => m.kind === 'file' && (m.mime || '').startsWith('image/')).length;
  document.getElementById('lblCopyBtnText').textContent =
    photoCount > 1 ? `Copy ${photoCount} Photos` : (photoCount === 1 ? 'Copy Photo' : 'Copy');
}

function clearAllSelections() {
  selectedRecords.forEach(({ bubbleEl, checkEl }) => {
    bubbleEl.classList.remove('selected');
    checkEl.classList.add('hidden');
  });
  selectedRecords.clear();
  updateSelectionBarUI();
}

function openMediaLightbox(msg, isVideo) {
  lightboxCurrentMsg = msg;
  const url = msg._objectUrl || (msg.blob ? URL.createObjectURL(msg.blob) : msg.url);
  const imgEl = document.getElementById('lightboxImg');
  const vidEl = document.getElementById('lightboxVid');
  const copyBtn = document.getElementById('btnLightboxCopy');
  const dlBtn = document.getElementById('btnLightboxDownload');

  document.getElementById('lightboxSizeBadge').textContent = formatBytes(msg.size);
  dlBtn.href = url;
  dlBtn.download = msg.name || (isVideo ? 'video.mp4' : 'photo.png');

  if (isVideo) {
    imgEl.classList.add('hidden');
    copyBtn.classList.add('hidden');
    vidEl.src = url;
    vidEl.classList.remove('hidden');
    vidEl.play().catch(() => {});
  } else {
    vidEl.pause();
    vidEl.classList.add('hidden');
    copyBtn.classList.remove('hidden');
    imgEl.src = url;
    imgEl.classList.remove('hidden');
  }
  document.getElementById('mediaLightbox').classList.remove('hidden');
}

function closeMediaLightbox() {
  const vidEl = document.getElementById('lightboxVid');
  vidEl.pause();
  vidEl.src = '';
  document.getElementById('mediaLightbox').classList.add('hidden');
  lightboxCurrentMsg = null;
}

function refreshHomeUI() {
  if (isDirectSingleChatMode) return;
  renderContactList(onlinePeers, (peerId) => openChatScreen(peerId));
}

async function openChatScreen(peerId) {
  clearAllSelections();
  activePeerId = peerId;
  saveContact(peerId, { unread: 0 });
  refreshHomeUI();

  document.getElementById('homeScreen').classList.add('hidden');
  document.getElementById('chatScreen').classList.remove('hidden');
  updateActiveChatHeader();

  const stream = document.getElementById('chatStream');
  stream.innerHTML = '';
  const history = await getMessagesForPeer(peerId);
  history.forEach((m) => appendBubbleToStream(m, bubbleHandlers));

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
  document.getElementById('btnCopyMyId').onclick = () => {
    navigator.clipboard.writeText(getMyDeviceId());
    showToast(`Copied ID: ${getMyDeviceId()}`);
  };

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

  document.getElementById('btnBackHome').onclick = () => {
    clearAllSelections();
    stopVoiceMic();
    activePeerId = null;
    document.getElementById('chatScreen').classList.add('hidden');
    document.getElementById('homeScreen').classList.remove('hidden');
    refreshHomeUI();
  };

  const chatDd = document.getElementById('chatDropdown');
  document.getElementById('btnChatMenu').onclick = (e) => {
    e.stopPropagation();
    chatDd.classList.toggle('hidden');
  };
  document.body.onclick = () => chatDd.classList.add('hidden');

  document.getElementById('btnSelectModeMenu').onclick = () => {
    showToast('Tap & hold any photo or message to multi-select');
  };

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
    clearAllSelections();
    await clearMessagesForPeer(activePeerId);
    document.getElementById('chatStream').innerHTML = '';
    showToast('Chat cleared');
  };

  document.getElementById('btnUnpairContact').onclick = async () => {
    if (!activePeerId) return;
    clearAllSelections();
    await clearMessagesForPeer(activePeerId);
    removeContact(activePeerId);
    document.getElementById('btnBackHome').click();
    showToast('Device unpaired');
  };

  document.getElementById('btnCancelCopy').onclick = clearAllSelections;
  document.getElementById('btnConfirmCopy').onclick = async () => {
    const items = Array.from(selectedRecords.values()).map((x) => x.msg);
    const photos = items.filter((m) => m.kind === 'file' && (m.mime || '').startsWith('image/'));
    const texts = items.filter((m) => m.kind === 'text').map((m) => m.text);

    if (photos.length > 0) {
      await copyImagesToClipboard(photos);
    } else if (texts.length > 0) {
      await navigator.clipboard.writeText(texts.join('\n'));
      showToast('Copied text');
    }
    clearAllSelections();
  };

  document.getElementById('btnLightboxClose').onclick = closeMediaLightbox;
  document.getElementById('btnLightboxCopy').onclick = () => {
    if (lightboxCurrentMsg) copyImagesToClipboard([lightboxCurrentMsg]);
  };

  // Keep keyboard open continuously when typing & sending
  const inp = document.getElementById('msgInput');
  inp.oninput = updateFabIcon;
  inp.onfocus = () => {
    setTimeout(() => {
      const stream = document.getElementById('chatStream');
      stream.scrollTop = stream.scrollHeight;
    }, 120);
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleFabClick(true);
    }
  };
  document.getElementById('fabMicSend').onclick = (e) => {
    e.preventDefault();
    handleFabClick(true);
  };

  document.getElementById('btnPickFiles').onclick = () => document.getElementById('fileFolderPicker').click();
  document.getElementById('btnOpenCamera').onclick = () => document.getElementById('cameraCapturePicker').click();

  const onFilesChosen = async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) await sendFileMessage(file);
    e.target.value = '';
  };
  document.getElementById('fileFolderPicker').onchange = onFilesChosen;
  document.getElementById('cameraCapturePicker').onchange = onFilesChosen;

  window.receiveFileFromAndroid = async (base64, name, mime) => {
    const res = await fetch(`data:${mime};base64,${base64}`);
    const blob = await res.blob();
    await sendFileMessage(new File([blob], name, { type: mime }));
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
    document.getElementById('svgCallMicOn').classList.toggle('hidden', isMuted);
    document.getElementById('svgCallMicOff').classList.toggle('hidden', !isMuted);
  };

  document.getElementById('btnCallVideoToggle').onclick = () => {
    if (!localStream) return;
    const tracks = localStream.getVideoTracks();
    if (!tracks.length) return;
    isCamOff = !isCamOff;
    tracks.forEach((t) => (t.enabled = !isCamOff));
    document.getElementById('localVideo').style.display = isCamOff ? 'none' : 'block';
    document.getElementById('svgCallCamOn').classList.toggle('hidden', isCamOff);
    document.getElementById('svgCallCamOff').classList.toggle('hidden', !isCamOff);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopVoiceMic();
    else if (document.visibilityState === 'visible') flushReadReceiptsForActiveChat();
  });
}

async function sendTextMessage(keepKeyboardOpen = true) {
  stopVoiceMic();
  if (!activePeerId) return;
  const inp = document.getElementById('msgInput');
  const text = inp.value.trim();
  if (!text) return;

  inp.value = '';
  voiceBuffer = '';
  updateFabIcon();
  if (keepKeyboardOpen) inp.focus(); // Prevents mobile keyboard from closing after send

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
  appendBubbleToStream(msg, bubbleHandlers);
  refreshHomeUI();

  await rtc.sendEncryptedText(activePeerId, msg);
}

async function sendFileMessage(file) {
  if (!activePeerId) return;
  const mime = file.type || 'application/octet-stream';
  const msg = {
    id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    peerId: activePeerId,
    kind: 'file',
    name: file.name,
    size: file.size,
    mime,
    blob: file,
    dir: 'out',
    ts: Date.now(),
    tick: 1
  };

  await saveMessageRecord(msg);
  saveContact(activePeerId, {
    lastMsg: mime.startsWith('image/') ? '📷 Photo' : (mime.startsWith('video/') ? '🎥 Video' : `📎 ${file.name}`),
    lastTs: msg.ts
  });
  appendBubbleToStream(msg, bubbleHandlers);
  refreshHomeUI();

  const sent = await rtc.sendEncryptedFile(activePeerId, msg, null);
  if (!sent) {
    if (file.size > 50 * 1024 * 1024) {
      if (!memoryLargeFileQueue.has(activePeerId)) memoryLargeFileQueue.set(activePeerId, []);
      memoryLargeFileQueue.get(activePeerId).push(msg);
    }
    showToast('Queued — will auto-send as soon as device reconnects');
  }
}

function updateFabIcon() {
  const hasText = document.getElementById('msgInput').value.trim().length > 0;
  document.getElementById('svgMic').classList.toggle('hidden', isListening || hasText);
  document.getElementById('svgStop').classList.toggle('hidden', !isListening);
  document.getElementById('svgSend').classList.toggle('hidden', isListening || !hasText);
}

function setWaveformVisible(show) {
  document.getElementById('msgInput').classList.toggle('hidden', show);
  document.getElementById('btnPickFiles').classList.toggle('hidden', show);
  document.getElementById('btnOpenCamera').classList.toggle('hidden', show);
  document.getElementById('waveformBox').classList.toggle('hidden', !show);
}

function handleFabClick(keepKeyboard = false) {
  if (isListening) { stopVoiceMic(); return; }
  if (document.getElementById('msgInput').value.trim().length > 0) sendTextMessage(keepKeyboard);
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

function startCallTimer() {
  clearInterval(callDurationTimer);
  callSeconds = 0;
  callDurationTimer = setInterval(() => {
    callSeconds++;
    const mins = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const secs = String(callSeconds % 60).padStart(2, '0');
    document.getElementById('callTimerLabel').textContent = `${mins}:${secs} • E2EE`;
  }, 1000);
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
    startCallTimer();
  });
  call.on('close', () => cleanupCallUI(false));
  call.on('error', () => cleanupCallUI(false));
}

function cleanupCallUI(notifyRemote) {
  stopRingtone();
  clearInterval(callDurationTimer);
  if (notifyRemote && activePeerId) rtc.sendCallControl(activePeerId, 'end');
  if (activeCall) { try { activeCall.close(); } catch (_) {} activeCall = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  isMuted = false;
  isCamOff = false;
  document.getElementById('svgCallMicOn').classList.remove('hidden');
  document.getElementById('svgCallMicOff').classList.add('hidden');
  document.getElementById('svgCallCamOn').classList.remove('hidden');
  document.getElementById('svgCallCamOff').classList.add('hidden');
  document.getElementById('remoteVideo').srcObject = null;
  document.getElementById('callOverlay').classList.add('hidden');
}
