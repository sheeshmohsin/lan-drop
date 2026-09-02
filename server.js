// LAN Drop — huge file transfer over local WiFi. Zero dependencies.
// Run: node server.js  → share the printed link with anyone on the same WiFi.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3210;
const STORAGE = path.join(__dirname, 'storage');
const PARTS = path.join(STORAGE, '.parts');
const META_PATH = path.join(STORAGE, '.meta.json');
const PUBLIC = path.join(__dirname, 'public');

const MAX_FILE_SIZE = 200 * 1024 ** 3; // 200 GB
const MAX_CHUNK_SIZE = 64 * 1024 ** 2; // 64 MB per request
const DISK_MARGIN = 1024 ** 3; // keep at least 1 GB free

// --clean wipes everything the app has written: received files, partial uploads, metadata.
if (process.argv.includes('--clean')) {
  fs.rmSync(STORAGE, { recursive: true, force: true });
  console.log('cleaned: removed storage/ (received files, partial uploads, metadata)');
  if (process.argv.includes('--exit')) process.exit(0);
}

fs.mkdirSync(PARTS, { recursive: true });

// Drop abandoned partial uploads older than 7 days.
for (const entry of fs.readdirSync(PARTS)) {
  const partPath = path.join(PARTS, entry);
  try {
    if (Date.now() - fs.statSync(partPath).mtimeMs > 7 * 24 * 3600 * 1000) fs.unlinkSync(partPath);
  } catch {
    /* ignore races */
  }
}

// ---------------------------------------------------------------- metadata

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  } catch {
    return {};
  }
}
const meta = loadMeta(); // finalName -> { sender, time }
let metaTimer = null;
function saveMeta() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => {
    fsp.writeFile(META_PATH, JSON.stringify(meta, null, 2)).catch((err) => {
      console.error('meta save failed:', err.message);
    });
  }, 200);
}

// ---------------------------------------------------------------- helpers

function sanitizeName(raw) {
  const base = path.basename(String(raw)).replace(/[\x00-\x1f\x7f/\\]/g, '');
  const trimmed = base.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.startsWith('.')) return null;
  return trimmed.slice(0, 255);
}

function uniqueName(name) {
  if (!fs.existsSync(path.join(STORAGE, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(STORAGE, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function safeStoragePath(name) {
  const clean = sanitizeName(name);
  if (!clean) return null;
  const resolved = path.resolve(STORAGE, clean);
  if (resolved !== path.join(STORAGE, clean)) return null;
  return resolved;
}

function lanAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function availableDisk() {
  const stat = await fsp.statfs(STORAGE);
  return stat.bavail * stat.bsize;
}

// ---------------------------------------------------------------- presence (SSE)

const clients = new Map(); // res -> { id, name }

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients.keys()) res.write(frame);
}

function presenceList() {
  const seen = new Map();
  for (const { id, name } of clients.values()) seen.set(id, name);
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

function handleEvents(req, res, url) {
  const id = String(url.searchParams.get('id') || '').slice(0, 64);
  const name = String(url.searchParams.get('name') || 'Unknown').slice(0, 40);
  if (!id) return sendJson(res, 400, { error: 'id required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  clients.set(res, { id, name });
  broadcast('presence', presenceList());

  req.on('close', () => {
    clients.delete(res);
    broadcast('presence', presenceList());
  });
}

setInterval(() => {
  for (const res of clients.keys()) res.write(': ping\n\n');
}, 15000).unref();

// ---------------------------------------------------------------- uploads

const activeUploads = new Set(); // upload ids with an append in flight

function validUploadId(id) {
  return typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id);
}

async function partSize(id) {
  try {
    return (await fsp.stat(path.join(PARTS, id))).size;
  } catch {
    return 0;
  }
}

async function handleUploadStatus(res, url) {
  const id = url.searchParams.get('id');
  if (!validUploadId(id)) return sendJson(res, 400, { error: 'bad id' });
  sendJson(res, 200, { offset: await partSize(id) });
}

async function handleUploadChunk(req, res, url) {
  const id = url.searchParams.get('id');
  const name = url.searchParams.get('name');
  const size = Number(url.searchParams.get('size'));
  const offset = Number(url.searchParams.get('offset'));
  const sender = String(url.searchParams.get('sender') || 'Unknown').slice(0, 40);

  if (!validUploadId(id)) return sendJson(res, 400, { error: 'bad id' });
  if (!sanitizeName(name)) return sendJson(res, 400, { error: 'bad filename' });
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_SIZE) {
    return sendJson(res, 400, { error: 'bad size' });
  }
  if (!Number.isInteger(offset) || offset < 0 || offset >= size) {
    return sendJson(res, 400, { error: 'bad offset' });
  }
  const declared = Number(req.headers['content-length']);
  if (!Number.isInteger(declared) || declared <= 0 || declared > MAX_CHUNK_SIZE) {
    return sendJson(res, 400, { error: 'chunk must be 1B-64MB with Content-Length' });
  }
  if (offset + declared > size) return sendJson(res, 400, { error: 'chunk exceeds file size' });

  if (activeUploads.has(id)) return sendJson(res, 409, { error: 'busy', offset: await partSize(id) });
  activeUploads.add(id);

  const partPath = path.join(PARTS, id);
  try {
    const current = await partSize(id);
    if (current !== offset) return sendJson(res, 409, { error: 'offset mismatch', offset: current });

    if ((await availableDisk()) < size - current + DISK_MARGIN) {
      return sendJson(res, 507, { error: 'not enough disk space on the receiving machine' });
    }

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(partPath, { flags: 'a' });
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
      req.on('aborted', () => reject(new Error('client aborted')));
    });

    const newSize = await partSize(id);
    if (newSize < size) return sendJson(res, 200, { offset: newSize });

    // Complete — move into place and announce.
    const finalName = uniqueName(sanitizeName(name));
    await fsp.rename(partPath, path.join(STORAGE, finalName));
    meta[finalName] = { sender, time: Date.now() };
    saveMeta();
    broadcast('files', { added: finalName, sender });
    console.log(`received ${finalName} (${(size / 1024 ** 2).toFixed(1)} MB) from ${sender}`);
    sendJson(res, 200, { done: true, name: finalName });
  } catch (err) {
    console.error(`upload ${id} chunk failed:`, err.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'write failed', offset: await partSize(id) });
    else res.destroy();
  } finally {
    activeUploads.delete(id);
  }
}

// ---------------------------------------------------------------- files

async function listFiles() {
  const entries = await fsp.readdir(STORAGE, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const stat = await fsp.stat(path.join(STORAGE, entry.name));
    const info = meta[entry.name] || {};
    files.push({
      name: entry.name,
      size: stat.size,
      time: info.time || stat.mtimeMs,
      sender: info.sender || '—',
    });
  }
  return files.sort((a, b) => b.time - a.time);
}

function handleDownload(req, res, rawName) {
  const filePath = safeStoragePath(decodeURIComponent(rawName));
  if (!filePath || !fs.existsSync(filePath)) return sendJson(res, 404, { error: 'not found' });

  const { size } = fs.statSync(filePath);
  const fileName = path.basename(filePath);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    fs.createReadStream(filePath).pipe(res);
  }
}

async function handleDelete(res, rawName) {
  const filePath = safeStoragePath(decodeURIComponent(rawName));
  if (!filePath || !fs.existsSync(filePath)) return sendJson(res, 404, { error: 'not found' });
  await fsp.unlink(filePath);
  delete meta[path.basename(filePath)];
  saveMeta();
  broadcast('files', { removed: path.basename(filePath) });
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- static

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function handleStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.resolve(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, 404, { error: 'not found' });
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------- router

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/events') return handleEvents(req, res, url);
    if (req.method === 'GET' && p === '/api/files') return sendJson(res, 200, await listFiles());
    if (req.method === 'GET' && p === '/api/upload/status') return handleUploadStatus(res, url);
    if (req.method === 'PUT' && p === '/api/upload') return handleUploadChunk(req, res, url);
    if (req.method === 'GET' && p === '/api/info') {
      return sendJson(res, 200, { url: `http://${lanAddresses()[0] || 'localhost'}:${PORT}` });
    }
    if (req.method === 'GET' && p.startsWith('/d/')) return handleDownload(req, res, p.slice(3));
    if (req.method === 'DELETE' && p.startsWith('/api/files/')) return handleDelete(res, p.slice(11));
    if (req.method === 'GET') return handleStatic(res, p);
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error(`${req.method} ${p} failed:`, err.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.destroy();
  }
});

// Long uploads/downloads must not be killed by idle timeouts.
server.requestTimeout = 0;
server.headersTimeout = 60000;

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log('\n  LAN Drop is running — share this link with people on your WiFi:\n');
  for (const addr of addrs.length ? addrs : ['localhost']) {
    console.log(`    http://${addr}:${PORT}`);
  }
  console.log(`\n  Files land in: ${STORAGE}\n`);
});
