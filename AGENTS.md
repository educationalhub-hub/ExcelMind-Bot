# ExcelMind-Bot

WhatsApp group moderation bot using Baileys (`@whiskeysockets/baileys`). The bot deletes links and abusive words sent by non-admins in groups where it is an admin. A built-in dashboard on port 3000 shows connection status, group list, activity log, moderation settings, and a message broadcast tool.

## Running in Base44

```sh
docker compose -f docker-compose.base44.yml up -d --build
```

- Node 22 runtime, source bind-mounted at `/app`.
- Dependencies installed on startup via `npm ci` (lockfile-preserving).
- `PHONE_NUMBER` secret is no longer required for QR pairing.
- Auth state persists in `./auth_info/` (gitignored).
- Bot runs with `node --watch src/index.js` for live reload on source changes.

## Dashboard (port 3000)

The dashboard replaces the old QR-only pairing page. When the bot is not connected, it shows a QR code for linking. When connected, it shows:

- **Stats**: total groups, groups where bot is admin, actions logged.
- **Groups**: list of all groups the bot is in, with admin badge and member count. Refresh button re-fetches from WhatsApp.
- **Activity**: real-time log of deleted messages, settings changes, and broadcast/instruction messages.
- **Settings**: toggle anti-link and anti-abuse, edit the abusive words list.
- **Send Instruction**: send a message to a specific admin group or broadcast to all admin groups.

API endpoints (all `no-store`):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/status` | Connection status, QR data URL, bot number |
| GET | `/api/groups` | List of groups with admin flag |
| POST | `/api/groups/refresh` | Re-fetch groups from WhatsApp |
| GET | `/api/logs` | Recent activity log (max 100 entries) |
| GET | `/api/settings` | Current moderation settings |
| POST | `/api/settings` | Update settings (antiLink, antiAbuse, abusiveWords) |
| POST | `/api/instruction` | Send message to a group or broadcast (body: `{ groupJid, message }`) |

## Moderation rules

The bot **only moderates groups where it is an admin**. In those groups:

- Links sent by non-admins are deleted (when anti-link is enabled).
- Abusive words sent by non-admins are deleted (when anti-abuse is enabled).
- Admins and group owners can always send anything.
- All deletions are logged to the activity feed.

## Key files

- `src/index.js` — bot entry point; connects to WhatsApp, runs moderation, serves dashboard.
- `src/dashboardServer.js` — HTTP server for the dashboard and API endpoints.
- `src/dashboard.html` — dashboard UI (groups, activity, settings, instructions).
- `src/botState.js` — shared in-memory state (connection, groups, logs, settings).
- `src/antiLink.js` — link detection, abuse detection, admin check helpers.
- `src/config.js` — default configuration constants.

## Verifying the app started

Check logs: `docker compose -f docker-compose.base44.yml logs bot`. A successful start prints "📊 ExcelMind-Bot dashboard is ready on port 3000." and then "✅ ExcelMind-Bot connected to WhatsApp!" after linking. The dashboard at `/` shows the connection status and group list.

## Tests

```sh
docker compose -f docker-compose.base44.yml exec -T bot npm test
```

Pairing server tests are in `src/pairingServer.test.js`. Moderation logic tests are in `src/antiLink.test.js`.
