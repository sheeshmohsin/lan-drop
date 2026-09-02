# LAN Drop

Transfer huge files (10 GB+) between devices on your home WiFi. No cloud, no accounts, no dependencies — one Node.js file.

## How it works

Your Mac runs a tiny server. Anyone on the same WiFi opens the link (or scans the QR code shown in the app) in their phone/laptop browser and can send files to your Mac — or to anyone else online, since every received file appears in a shared list that everyone can download from.

Designed to be gentle on your WiFi router:

- **One sequential stream per transfer** — files are sent in 8 MB chunks, one at a time. No parallel connection blasting.
- **Everything stays on the LAN** — zero internet traffic.
- **Resumable** — if WiFi drops at 9 GB, re-select the same file and it continues where it stopped.
- **Constant memory** — uploads stream straight to disk; downloads use the browser's native download manager (with pause/resume), so phones can receive files far bigger than their RAM.

## Run

```bash
npm start
```

Then share the printed link, e.g. `http://192.168.1.23:3210`, with anyone on your WiFi (or let them scan the QR code shown on the page).

Received files land in `storage/` inside this folder.

## Cleaning up

```bash
npm run clean            # delete everything the app has written (received files, partial uploads, metadata) and exit
node server.js --clean   # same wipe, then start the server fresh
```

Abandoned partial uploads are also auto-deleted after 7 days on startup.

## Notes

- Port: set `PORT=xxxx` to override the default `3210`.
- First run on macOS may prompt to allow incoming network connections — allow it.
- No authentication by design: anyone on your WiFi can use it. Don't run it on networks you don't trust.
- The server refuses uploads that would leave less than 1 GB free disk space.
