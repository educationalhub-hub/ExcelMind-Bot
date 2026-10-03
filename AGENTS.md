# ExcelMind-Bot

WhatsApp group moderation bot using Baileys (`@whiskeysockets/baileys`). Not a web app — there is no HTTP server, so the preview shows a loading screen by design. The bot connects to WhatsApp via WebSocket and prints a pairing code to stdout on first run.

## Running in Base44

```sh
docker compose -f docker-compose.base44.yml up -d --build
```

- Node 22 runtime, source bind-mounted at `/app`.
- Dependencies installed on startup via `npm ci` (lockfile-preserving).
- `PHONE_NUMBER` secret is required at boot — delivered via `/run/base44/app.env`.
- Auth state persists in `./auth_info/` (gitignored).

## Key files

- `src/index.js` — bot entry point; connects to WhatsApp, requests pairing code, listens for group messages.
- `src/antiLink.js` — link detection regex + admin check helper.
- `src/config.js` — bot configuration constants.

## Verifying the app started

Check logs: `docker compose -f docker-compose.base44.yml logs bot`. A successful start prints a pairing code or "✅ ExcelMind-Bot connected to WhatsApp!".
