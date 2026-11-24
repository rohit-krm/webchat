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

export function appendBubbleToStream(msg, onLongPressText) {
  const stream = document.getElementById('chatStream');
  const row = document.createElement('div');
  row.className = `msg-row ${msg.dir}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (msg.kind === 'text') {
    const txt = document.createElement('div');
    txt.textContent = msg.text;
    bubble.appendChild(txt);

    let timer;
    const selectFn = () => onLongPressText(msg.text, bubble);
    bubble.addEventListener('touchstart', () => { timer = setTimeout(selectFn, 450); }, { passive: true });
    bubble.addEventListener('touchend', () => clearTimeout(timer));
    bubble.addEventListener('touchmove', () => clearTimeout(timer));
    bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); selectFn(); });
  } else {
    const url = msg.blob ? URL.createObjectURL(msg.blob) : msg.url;
    const mime = msg.mime || '';
    if (mime.startsWith('image/') && url) {
      const img = document.createElement('img');
      img.src = url;
      img.onclick = () => window.open(url, '_blank');
      bubble.appendChild(img);
    } else if (mime.startsWith('video/') && url) {
      const vid = document.createElement('video');
      vid.src = url;
      vid.controls = true;
      bubble.appendChild(vid);
    }
    const ext = (msg.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4);
    const doc = document.createElement('div');
    doc.className = 'doc-card';
    doc.innerHTML = `
      <div class="doc-badge">${escapeHtml(ext)}</div>
      <div class="doc-info">
        <div class="doc-name">${escapeHtml(msg.name)}</div>
        <div class="doc-size">${formatBytes(msg.size)}</div>
      </div>
      ${url ? `<a class="dl-link" href="${url}" download="${escapeHtml(msg.name)}">Save</a>` : ''}
    `;
    bubble.appendChild(doc);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const timeStr = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.innerHTML = `<span>${timeStr}</span>` + (msg.dir === 'out' ? `<span id="tick-${msg.id}" class="msg-tick" data-state="${msg.tick || 1}">${getTickSvg(msg.tick || 1)}</span>` : '');
  bubble.appendChild(meta);

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
