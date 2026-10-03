# ExcelMind-Bot

## Base44 pairing and verification

- The preview on port 3000 is a minimal QR pairing page, not the moderation interface. It renders Baileys `connection.update.qr` locally and polls `/api/pairing` for refreshed QR images and connection status.
- Do not call `requestPairingCode` in QR mode: it sets `creds.me` even before successful registration, causing incomplete phone-code credentials to try logging in instead of generating a QR.
- If switching away from a failed phone-code attempt, stop the bot first and reset only **unregistered** credentials. Never erase a registered WhatsApp session. Do not log or commit QR payloads or auth credentials.
- Auth state persists in the gitignored `auth_info/` directory. `PHONE_NUMBER` is no longer needed for QR pairing; an existing dashboard value may remain unused.
- Compose runs Node's import-based `--watch` mode. It watches imported source, not auth files read/written through the filesystem, so credential saves must not restart the bot. The pairing HTML is read on each page request; browser refresh is needed for HTML changes.
- Dependency installation belongs to Compose startup (`npm ci`). Install or update dependencies in a Node container and keep the lockfile synchronized.
- Healthchecks request both `/` and `/api/pairing` in the same bot process. A healthy HTTP service does **not** mean WhatsApp is linked; verify `/api/pairing` reports `connected` or logs say `ExcelMind-Bot connected to WhatsApp!`.
- Verify QR display with `/api/pairing`: status `scan` and a PNG data URL indicate a fresh linking QR. After a scan, Baileys normally requests a connection restart; the existing reconnect delay is 10 seconds.
- Run tests with `docker compose -f docker-compose.base44.yml exec -T bot npm test`. Pairing tests cover refresh, no-cache responses, clearing on connect/disconnect, and stale-image race handling. Actual QR scanning requires the user's WhatsApp phone and cannot be fully automated here.
- Only the pairing flow and supporting HTTP display have changed; link moderation remains in `src/index.js` and `src/antiLink.js`.
