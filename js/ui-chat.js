import { getContacts } from './storage.js';

export function showToast(text) {
  const el = document.getElementById('toastBox');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2500);
}

export function getTickSvg(state) {
  if (state === 1) {
    return `<svg class="tick-svg" viewBox="0 0 16 11" fill="none"><path d="M11.5 1L4.8 9.2L1.5 6" stroke="#8696a0" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  const color = state === 3 ? '#34b7f1' : '#8696a0';
  return `<svg class="tick-svg" viewBox="0 0 18 11" fill="none"><path d="M11.5 1L4.8 9.2L1.5 6" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.5 1L9.8 9.2L8.2 7.5" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function renderContactList(onlineSet, onOpenChat) {
  const container = document.getElementById('contactListContainer');
  const contacts = Object.values(getContacts()).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));

  if (contacts.length === 0) {
    container.innerHTML = `<div class="empty-home">No paired devices yet.<br>Tap <strong>+</strong> to connect your Laptop or Phone using its Device ID &amp; PIN.</div>`;
    return;
  }

  container.innerHTML = '';
  contacts.forEach((c) => {
    const isOnline = onlineSet.has(c.peerId);
    const row = document.createElement('div');
    row.className = 'contact-item';
    const initial = (c.name || c.peerId).charAt(0).toUpperCase();
    const timeStr = c.lastTs ? new Date(c.lastTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    row.innerHTML = `
      <div class="avatar">
        <span>${escapeHtml(initial)}</span>
        <span class="status-dot ${isOnline ? 'online' : ''}"></span>
      </div>
      <div class="contact-body">
        <div class="contact-top">
          <div class="contact-name">${escapeHtml(c.name || c.peerId)}</div>
          <div class="contact-time">${timeStr}</div>
        </div>
        <div class="contact-bottom">
          <div class="contact-preview">${escapeHtml(c.lastMsg || c.peerId)}</div>
          ${c.unread > 0 ? `<span class="unread-badge">${c.unread}</span>` : ''}
        </div>
      </div>
    `;
    row.onclick = () => onOpenChat(c.peerId);
    container.appendChild(row);
  });
}

// Copy 1 photo directly OR stitch multiple selected photos onto a high-res PNG grid for 1-click clipboard copy
export async function copyImagesToClipboard(imageRecords) {
  if (!imageRecords.length) return;
  try {
    const bitmaps = await Promise.all(
      imageRecords.map(async (rec) => {
        const blob = rec.blob || (await (await fetch(rec.url)).blob());
        return createImageBitmap(blob);
      })
    );

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (bitmaps.length === 1) {
      canvas.width = bitmaps[0].width;
      canvas.height = bitmaps[0].height;
      ctx.drawImage(bitmaps[0], 0, 0);
    } else {
      const cols = Math.min(2, bitmaps.length);
      const rows = Math.ceil(bitmaps.length / cols);
      const tileW = 640;
      const tileH = 640;
      const gap = 12;
      canvas.width = cols * tileW + (cols - 1) * gap;
      canvas.height = rows * tileH + (rows - 1) * gap;
      ctx.fillStyle = '#0b141a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      bitmaps.forEach((bmp, idx) => {
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        const x = c * (tileW + gap);
        const y = r * (tileH + gap);
        const scale = Math.min(tileW / bmp.width, tileH / bmp.height);
        const dw = bmp.width * scale;
        const dh = bmp.height * scale;
        ctx.drawImage(bmp, x + (tileW - dw) / 2, y + (tileH - dh) / 2, dw, dh);
      });
    }

    const pngBlob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    showToast(bitmaps.length > 1 ? `Copied ${bitmaps.length} photos to clipboard!` : 'Photo copied!');
  } catch (_) {
    showToast('Clipboard copy blocked on this browser');
  }
}

export function appendBubbleToStream(msg, handlers) {
  const stream = document.getElementById('chatStream');
  const row = document.createElement('div');
  row.className = `msg-row ${msg.dir}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const mime = msg.mime || '';
  const isPhoto = msg.kind === 'file' && mime.startsWith('image/');
  const isVideo = msg.kind === 'file' && mime.startsWith('video/');

  if (msg.kind === 'text') {
    const txt = document.createElement('div');
    txt.textContent = msg.text;
    bubble.appendChild(txt);
  } else if (isPhoto || isVideo) {
    // Clean 1:1 Square Media Card — NO filename, size + Copy/Download icons on bottom bar
    bubble.classList.add('media-bubble');
    const url = msg.blob ? URL.createObjectURL(msg.blob) : msg.url;
    msg._objectUrl = url;

    const card = document.createElement('div');
    card.className = 'square-media-card';

    if (isPhoto) {
      const img = document.createElement('img');
      img.src = url;
      img.loading = 'lazy';
      card.appendChild(img);
    } else {
      const vid = document.createElement('video');
      vid.src = url;
      vid.muted = true;
      vid.preload = 'metadata';
      card.appendChild(vid);

      const playBadge = document.createElement('div');
      playBadge.className = 'video-center-play';
      playBadge.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="margin-left:2px;"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
      card.appendChild(playBadge);
    }

    const bottomBar = document.createElement('div');
    bottomBar.className = 'media-bottom-bar';
    bottomBar.innerHTML = `<span class="media-size-pill">${formatBytes(msg.size)}</span>`;

    const btnGroup = document.createElement('div');
    btnGroup.className = 'media-quick-btns';

    if (isPhoto) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'media-mini-btn';
      copyBtn.title = 'Copy Photo';
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      copyBtn.onclick = (e) => {
        e.stopPropagation();
        copyImagesToClipboard([msg]);
      };
      btnGroup.appendChild(copyBtn);
    }

    if (url) {
      const dlBtn = document.createElement('a');
      dlBtn.className = 'media-mini-btn';
      dlBtn.href = url;
      dlBtn.download = msg.name || (isPhoto ? 'photo.png' : 'video.mp4');
      dlBtn.title = 'Download';
      dlBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
      dlBtn.onclick = (e) => e.stopPropagation();
      btnGroup.appendChild(dlBtn);
    }

    bottomBar.appendChild(btnGroup);
    card.appendChild(bottomBar);
    bubble.appendChild(card);
  } else {
    // Document / PDF / APK card
    const url = msg.blob ? URL.createObjectURL(msg.blob) : msg.url;
    const ext = (msg.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4);
    const doc = document.createElement('div');
    doc.className = 'doc-card';
    doc.innerHTML = `
      <div class="doc-badge">${escapeHtml(ext)}</div>
      <div class="doc-info">
        <div class="doc-name">${escapeHtml(msg.name)}</div>
        <div class="doc-size">${formatBytes(msg.size)}</div>
      </div>
      ${url ? `<a class="dl-link" href="${url}" download="${escapeHtml(msg.name)}" title="Download">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </a>` : ''}
    `;
    bubble.appendChild(doc);
  }

  // Selection Checkmark Badge
  const checkBadge = document.createElement('div');
  checkBadge.className = 'select-check-badge hidden';
  checkBadge.textContent = '✓';
  bubble.appendChild(checkBadge);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const timeStr = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.innerHTML = `<span>${timeStr}</span>` + (msg.dir === 'out' ? `<span id="tick-${msg.id}" class="msg-tick" data-state="${msg.tick || 1}">${getTickSvg(msg.tick || 1)}</span>` : '');
  bubble.appendChild(meta);

  // Long-Press (Hold) to Enter Multi-Select; Tap to Expand or Toggle Selection
  let pressTimer = null;
  let didLongPress = false;

  const startHold = () => {
    didLongPress = false;
    pressTimer = setTimeout(() => {
      didLongPress = true;
      handlers.onToggleSelect(msg, bubble, checkBadge);
    }, 420);
  };
  const cancelHold = () => clearTimeout(pressTimer);

  bubble.addEventListener('touchstart', startHold, { passive: true });
  bubble.addEventListener('touchend', cancelHold);
  bubble.addEventListener('touchmove', cancelHold);
  bubble.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    handlers.onToggleSelect(msg, bubble, checkBadge);
  });

  bubble.addEventListener('click', () => {
    if (didLongPress) return;
    if (handlers.isSelectionActive()) {
      handlers.onToggleSelect(msg, bubble, checkBadge);
    } else if (isPhoto || isVideo) {
      handlers.onOpenLightbox(msg, isVideo);
    }
  });

  row.appendChild(bubble);
  stream.appendChild(row);
  stream.scrollTop = stream.scrollHeight;
}

export function setBubbleTickUI(msgId, state) {
  const el = document.getElementById(`tick-${msgId}`);
  if (el && Number(el.dataset.state) < state) {
    el.dataset.state = state;
    el.innerHTML = getTickSvg(state);
  }
}

export function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
