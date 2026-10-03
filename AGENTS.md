# ExcelMind-Bot

WhatsApp group moderation bot (anti-link protection) built with the Baileys library.

## What it is

A **headless Node.js process** — not a web app. It connects to WhatsApp via Baileys,
prints a pairing code to stdout, then listens for group messages and deletes links
from non-admins. There is no HTTP server, so nothing serves on port 3000; the preview
stays on the loading screen by design. Verify the bot via `docker compose logs bot`.

## Setup

- Runtime: Node.js >= 22 (compose uses `node:22`).
- Dependencies: `npm ci` (lockfile is committed). Installed at container startup.
- Dev command: `node --watch src/index.js` (live reload on file changes).

## Required env var

- `PHONE_NUMBER` — WhatsApp phone number with country code, no `+`. Required at boot
  (the app throws if missing). A development placeholder is generated so the process
  starts, but the bot cannot actually pair with WhatsApp until the real number is set
  via the Secrets dashboard.

## Verifying it runs

```sh
docker compose -f docker-compose.base44.yml up -d --build
docker compose -f docker-compose.base44.yml logs bot
```

The logs should show the bot attempting to connect and (with a real phone number)
printing a WhatsApp pairing code.

## Known fix applied

`src/index.js` had a duplicate `import qrcode from 'qrcode-terminal';` line that
caused a syntax error — removed during setup.
