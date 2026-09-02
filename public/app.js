// LAN Drop client: sequential chunked uploads with resume, SSE presence, file list.
(() => {
  'use strict';

  const CHUNK_SIZE = 8 * 1024 * 1024; // one 8MB chunk in flight at a time — easy on the router
  const MAX_RETRIES = 60; // keep trying through WiFi blips (~2 min at 2s backoff)

  const $ = (sel) => document.querySelector(sel);

  // --- identity ---
  function randomId() {
    return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }
  const clientId = localStorage.getItem('lanDropId') || randomId();
  localStorage.setItem('lanDropId', clientId);

  const nameInput = $('#name-input');
  nameInput.value = localStorage.getItem('lanDropName') || `Device-${clientId.slice(0, 4)}`;
  const deviceName = () => nameInput.value.trim() || 'Unknown';
  nameInput.addEventListener('change', () => {
    localStorage.setItem('lanDropName', deviceName());
    connectEvents(); // reconnect so everyone sees the new name
  });

  // --- presence via SSE ---
  let eventSource = null;
  function connectEvents() {
    if (eventSource) eventSource.close();
    const params = new URLSearchParams({ id: clientId, name: deviceName() });
    eventSource = new EventSource(`/events?${params}`);
    eventSource.onopen = () => $('#conn-banner').classList.remove('show');
    eventSource.onerror = () => $('#conn-banner').classList.add('show');
    eventSource.addEventListener('presence', (ev) => renderPeers(JSON.parse(ev.data)));
    eventSource.addEventListener('files', () => refreshFiles());
  }

  function renderPeers(peers) {
    const box = $('#peers');
    box.innerHTML = '';
    if (!peers.length) {
      box.innerHTML = '<div class="empty">Nobody online</div>';
      return;
    }
    for (const peer of peers) {
      const chip = document.createElement('div');
      chip.className = 'peer' + (peer.id === clientId ? ' self' : '');
      chip.textContent = peer.id === clientId ? `${peer.name} (you)` : peer.name;
      box.appendChild(chip);
    }
  }

  // --- file list ---
  function formatSize(bytes) {
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
    if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
  }
  function formatTime(ms) {
    const d = new Date(ms);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  async function refreshFiles() {
    try {
      const files = await (await fetch('/api/files')).json();
      const box = $('#files');
      box.innerHTML = '';
      if (!files.length) {
        box.innerHTML = '<div class="empty">No files yet</div>';
        return;
      }
      for (const file of files) {
        const row = document.createElement('div');
        row.className = 'file-row';

        const info = document.createElement('div');
        info.className = 'file-info';
        const fname = document.createElement('div');
        fname.className = 'fname';
        fname.textContent = file.name;
        const fmeta = document.createElement('div');
        fmeta.className = 'fmeta';
        fmeta.textContent = `${formatSize(file.size)} · from ${file.sender} · ${formatTime(file.time)}`;
        info.append(fname, fmeta);

        const download = document.createElement('a');
        download.className = 'btn';
        download.textContent = 'Download';
        download.href = `/d/${encodeURIComponent(file.name)}`;

        const del = document.createElement('button');
        del.className = 'btn ghost';
        del.textContent = '✕';
        del.title = 'Delete';
        del.onclick = async () => {
          if (!confirm(`Delete "${file.name}" for everyone?`)) return;
          await fetch(`/api/files/${encodeURIComponent(file.name)}`, { method: 'DELETE' });
        };

        row.append(info, download, del);
        box.appendChild(row);
      }
    } catch {
      /* transient — SSE reconnect will trigger another refresh */
    }
  }

  // --- upload engine: one file at a time, one chunk in flight ---
  const queue = [];
  let uploading = false;

  function uploadIdFor(file) {
    // Stable id so re-selecting the same file resumes where it stopped.
    const key = `${file.name}|${file.size}|${file.lastModified}|${clientId}`;
    let hash = 5381;
    for (let i = 0; i < key.length; i++) hash = ((hash * 33) ^ key.charCodeAt(i)) >>> 0;
    let hash2 = 52711;
    for (let i = key.length - 1; i >= 0; i--) hash2 = ((hash2 * 37) ^ key.charCodeAt(i)) >>> 0;
    return `${hash.toString(36)}-${hash2.toString(36)}-${file.size.toString(36)}`;
  }

  function makeUploadCard(file) {
    const item = document.createElement('div');
    item.className = 'upload-item';
    item.innerHTML = `
      <div class="row"><div class="fname"></div><div class="status">queued</div></div>
      <div class="bar"><i></i></div>`;
    item.querySelector('.fname').textContent = file.name;
    $('#uploads').prepend(item);
    return {
      set(pct, text, cls) {
        item.querySelector('.bar i').style.width = pct + '%';
        item.querySelector('.status').textContent = text;
        if (cls) item.className = `upload-item ${cls}`;
      },
    };
  }

  function enqueue(files) {
    for (const file of files) {
      if (!file.size) continue;
      queue.push({ file, card: makeUploadCard(file) });
    }
    processQueue();
  }

  // Keep the phone screen awake during uploads — mobile browsers freeze the
  // page (and the transfer) when the screen locks. Wake locks are released by
  // the OS whenever the page is hidden, so re-acquire on return if still busy.
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch {
      /* unsupported or denied — uploads still work, screen may just sleep */
    }
  }
  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && uploading) acquireWakeLock();
  });

  // Wake Lock is unavailable on plain-HTTP pages (non-secure context), i.e. the
  // normal LAN case — fall back to telling the sender to keep the screen on.
  function setKeepAwakeNotice(show) {
    let notice = document.getElementById('keep-awake-notice');
    if (!show) {
      if (notice) notice.remove();
      return;
    }
    if ('wakeLock' in navigator || notice) return;
    notice = document.createElement('div');
    notice.id = 'keep-awake-notice';
    notice.style.cssText =
      'margin-top:10px;padding:10px 14px;border-radius:10px;background:#3d3320;' +
      'color:#ffd479;font-size:0.85rem;text-align:center;';
    notice.textContent = '⚠️ Keep your screen on and stay on this page until the upload finishes — locking the phone pauses the transfer.';
    $('#uploads').before(notice);
  }

  async function processQueue() {
    if (uploading) return;
    const next = queue.shift();
    if (!next) {
      releaseWakeLock();
      setKeepAwakeNotice(false);
      return;
    }
    uploading = true;
    acquireWakeLock();
    setKeepAwakeNotice(true);
    try {
      await uploadFile(next.file, next.card);
    } finally {
      uploading = false;
      processQueue();
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function uploadFile(file, card) {
    const id = uploadIdFor(file);
    let offset = 0;
    let retries = 0;
    const speeds = [];

    try {
      const status = await (await fetch(`/api/upload/status?id=${id}`)).json();
      offset = status.offset || 0;
      if (offset > 0) card.set((offset / file.size) * 100, 'resuming…');
    } catch {
      /* start from 0 */
    }

    while (offset < file.size) {
      const chunk = file.slice(offset, offset + CHUNK_SIZE);
      const started = Date.now();
      try {
        const params = new URLSearchParams({
          id,
          name: file.name,
          size: String(file.size),
          offset: String(offset),
          sender: deviceName(),
        });
        const res = await fetch(`/api/upload?${params}`, { method: 'PUT', body: chunk });
        const body = await res.json();

        if (res.status === 409 && Number.isInteger(body.offset)) {
          offset = body.offset; // server has a different offset — re-sync and continue
          continue;
        }
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

        retries = 0;
        if (body.done) {
          card.set(100, 'sent ✓', 'done');
          return;
        }
        const elapsed = (Date.now() - started) / 1000;
        speeds.push(chunk.size / Math.max(elapsed, 0.05));
        if (speeds.length > 5) speeds.shift();
        const avg = speeds.reduce((total, s) => total + s, 0) / speeds.length;
        offset = body.offset;
        card.set(
          (offset / file.size) * 100,
          `${formatSize(offset)} / ${formatSize(file.size)} · ${formatSize(avg)}/s`
        );
      } catch (err) {
        retries++;
        if (retries > MAX_RETRIES) {
          card.set((offset / file.size) * 100, 'failed — select the file again to resume', 'error');
          throw err;
        }
        card.set((offset / file.size) * 100, `connection lost — retry ${retries}…`);
        await sleep(Math.min(2000 * retries, 10000));
        try {
          const status = await (await fetch(`/api/upload/status?id=${id}`)).json();
          if (Number.isInteger(status.offset)) offset = status.offset;
        } catch {
          /* still offline — next loop iteration retries */
        }
      }
    }
  }

  // --- pickers ---
  const dropZone = $('#drop-zone');
  const fileInput = $('#file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    enqueue([...fileInput.files]);
    fileInput.value = '';
  });
  dropZone.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dropZone.classList.remove('dragover');
    enqueue([...ev.dataTransfer.files]);
  });

  // Warn before closing mid-upload.
  window.addEventListener('beforeunload', (ev) => {
    if (uploading) ev.preventDefault();
  });

  // --- share link + QR ---
  async function renderShare() {
    let url = location.origin;
    try {
      const info = await (await fetch('/api/info')).json();
      if (info.url) url = info.url;
    } catch {
      /* fall back to current origin */
    }
    const link = $('#share-url');
    link.textContent = url;
    link.href = url;
    const matrix = window.qrMatrix(url);
    if (!matrix) return;
    const canvas = $('#qr-canvas');
    const ctx = canvas.getContext('2d');
    const scale = Math.floor(canvas.width / (matrix.length + 2));
    const pad = Math.floor((canvas.width - matrix.length * scale) / 2);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let y = 0; y < matrix.length; y++) {
      for (let x = 0; x < matrix.length; x++) {
        if (matrix[y][x]) ctx.fillRect(pad + x * scale, pad + y * scale, scale, scale);
      }
    }
  }

  connectEvents();
  refreshFiles();
  renderShare();
})();
