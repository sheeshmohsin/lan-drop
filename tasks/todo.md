# LAN Drop — build checklist

- [x] package.json, .gitignore
- [x] server.js — static serving, SSE presence, chunked resumable upload, file list, Range download, delete, banner, --clean flag, stale-part cleanup
- [x] public/qr.js — self-contained QR generator (no CDN)
- [x] public/index.html — mobile-first UI
- [x] public/app.js — upload engine (sequential 8MB chunks + resume), SSE client, rendering
- [x] README.md
- [x] Verify: QR output decodes (jsQR in scratchpad) — 5/5 cases, versions 1-6
- [x] Verify: 100MB chunked upload via curl, SHA-256 checksum match
- [x] Verify: resume after interruption (status endpoint + 409 offset re-sync)
- [x] Verify: Range download bytes correct (206, partial + full checksum)
- [x] Verify: path traversal / dotfile access blocked; traversal names neutralized into storage/
- [x] Verify: UI in Chrome — page renders, presence chip, QR shown, real file upload via picker → "sent ✓" → appears in Files list via SSE → on-disk checksum matches
- [x] --clean / npm run clean wipes storage (tested)

## Review

**Architecture**: HTTP hub on the Mac (no WebRTC) — chosen with user after discussing that WiFi P2P saves the router nothing and WebRTC can't reliably receive 10GB on phones. Zero npm dependencies; presence via SSE instead of WebSockets.

**Router-friendliness**: one 8MB chunk in flight per client, one upload at a time (client-side queue), all traffic LAN-only.

**10GB readiness**: uploads append-stream to disk (constant memory); `File.slice()` reads lazily on the sender; downloads use Range + browser download manager; `server.requestTimeout = 0` so long transfers aren't killed; resume via `/api/upload/status` offset re-sync keyed on stable upload id (name|size|mtime|clientId hash).

**Test results**: 13/13 backend tests pass (checksums, resume, 409 re-sync, Range, security); 5/5 QR decode tests pass; full browser E2E pass.

**Known limits (by design)**: no auth (anyone on WiFi can use it — documented); delete is global for everyone; single shared file pool rather than per-recipient targeting.
