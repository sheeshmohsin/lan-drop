# LAN Drop

Run it on a machine in your home network, and phones on the same WiFi can transfer huge files (10 GB+) straight to that machine — through nothing but their browser. No cloud, no accounts, no app install, no dependencies — one Node.js file.

## Use case

You have a laptop/desktop at home and someone wants to send you a 10 GB video from their phone. Start LAN Drop on your machine, share the printed link (or let them scan the QR code) — they open it in their phone browser, pick the file, and it lands directly in a folder on your machine. Anyone else online on the page can also grab any received file, so it doubles as device-to-device transfer for the whole household.

## Send to a specific device — or everyone

The "Send to" selector above the drop zone lists everyone currently online:

- **📢 Everyone (default)**: the file goes to the shared pool — it appears in the Files list of every device that opens the page, and anyone in the house can download it. Think of it as a family drop box.
- **📱 SomeDevice only**: the file appears only on that device's list (highlighted as "📥 sent to you") and on yours (labeled "you → SomeDevice only"). Other devices never see it in their list.

Either way the file physically lands in the `storage/` folder on the machine running the server — the selection only controls who sees it and gets it offered for download in the web UI.

One honest caveat: since there's no login, this is visibility filtering, not security — someone on your WiFi who knew the exact file URL could still download it. For a trusted home network that's the right trade-off.

## How it works

Your machine runs a tiny server. Anyone on the same WiFi opens the link in their phone/laptop browser and can send files to your machine — or to anyone else online, since every received file appears in a shared list that everyone can download from.

Designed to be gentle on your WiFi router:

- **One sequential stream per transfer** — files are sent in 8 MB chunks, one at a time. No parallel connection blasting.
- **Everything stays on the LAN** — zero internet traffic.
- **Resumable** — if WiFi drops at 9 GB, re-select the same file and it continues where it stopped.
- **Constant memory** — uploads stream straight to disk; downloads use the browser's native download manager (with pause/resume), so phones can receive files far bigger than their RAM.
- **Screen-lock aware** — phones pause transfers when the screen locks. The page holds a screen wake lock while uploading where the browser allows it, and otherwise shows a clear "keep your screen on" warning until the upload finishes. Either way, an interrupted upload resumes from where it stopped.

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
