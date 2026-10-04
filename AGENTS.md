# OmniMod

WhatsApp & Telegram group moderation bot SaaS platform. Users sign up, create bots via QR pairing (WhatsApp) or bot token (Telegram), and configure moderation, quiz, announcements, and greeter features. Built with Express, PostgreSQL, Baileys, and node-telegram-bot-api.

## Running in Base44

```sh
docker compose -f docker-compose.base44.yml up -d --build
```

- Node 22 runtime, source bind-mounted at `/app`.
- PostgreSQL 16 (Alpine) runs as a `db` compose service with auto-generated credentials.
- The dependency volume is synced from the committed lockfile at container startup via `npm ci`; recreate the bot service after dependency changes.
- `JWT_SECRET` is auto-generated for development; replace with a real value for production.
- Stripe keys (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`, `STRIPE_BUSINESS_PRICE_ID`) are optional — billing routes return "not configured" without them.
- Bot runs with `node --watch src/index.js` for live reload on source changes.
- WhatsApp auth state persists per-user per-bot in `./auth_info/user_{userId}/{botId}/`.
- Telegram bot tokens are stored in the `bots` table (`telegram_token` column).

## Architecture

- **Landing page** (`/`) — marketing page with pricing tiers, WhatsApp + Telegram branding.
- **Auth pages** (`/login`, `/signup`) — login/signup with JWT cookies. First user becomes 'founder'.
- **Dashboard** (`/dashboard`) — multi-tenant user dashboard with tabs: My Bots, Profile, Premium, Admin.
- **Admin** (`/admin`) — admin dashboard for founders/admins to manage users, announcements, and stats.
- **API**: Express-based REST API under `/api/`.

### Key files

| File | Purpose |
|------|---------|
| `src/index.js` | Entry point — runs DB migrations, starts BotManager, serves Express app |
| `src/dashboardServer.js` | Express app with all routes (auth, billing, bot management, profile, admin) |
| `src/auth.js` | JWT auth middleware, signup/login/logout routes, admin middleware |
| `src/billing.js` | Stripe checkout, webhook handler, plan management |
| `src/db.js` | PostgreSQL connection pool + migrations (users, bots, announcements tables) |
| `src/botManager.js` | Multi-tenant bot CRUD — handles both WhatsApp and Telegram bots |
| `src/BotInstance.js` | WhatsApp connection, moderation, quiz, greeter, scheduling |
| `src/telegramBotInstance.js` | Telegram bot connection, moderation, quiz, greeter, scheduling |
| `src/antiLink.js` | Link detection, abuse detection, admin check helpers |
| `src/quizSystem.js` | Quiz question bank and state management |
| `src/config.js` | Plans, schedules, rules defaults; Stripe price IDs from env; app name |

### Database schema

- `users` — id, email, password_hash, name, plan, stripe_customer_id, role (founder/admin/user), is_active, created_at
- `bots` — id, user_id (FK), platform (whatsapp/telegram), phone_number, telegram_token, display_name, role, auth_dir, active, capabilities (JSONB), created_at
- `announcements` — id, author_id (FK), title, message, type, is_active, created_at

### API endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/signup` | — | Create account (first user becomes founder) |
| POST | `/api/auth/login` | — | Log in |
| POST | `/api/auth/logout` | — | Log out |
| GET | `/api/auth/me` | ✅ | Current user (fetches latest role from DB) |
| GET | `/api/profile` | ✅ | Get profile |
| PUT | `/api/profile` | ✅ | Update name/email |
| PUT | `/api/profile/password` | ✅ | Change password |
| GET | `/api/billing/plans` | — | List plans |
| GET | `/api/billing/status` | ✅ | User's subscription |
| POST | `/api/billing/checkout` | ✅ | Create Stripe checkout |
| POST | `/api/billing/webhook` | — | Stripe webhook (raw body) |
| GET | `/api/bots` | ✅ | List user's bots (WhatsApp + Telegram) |
| POST | `/api/bots` | ✅ | Create bot (platform: whatsapp/telegram) |
| GET/PUT/DELETE | `/api/bots/:id` | ✅ | Read/update/delete bot |
| POST | `/api/bots/:id/activate` | ✅ | Start bot |
| POST | `/api/bots/:id/deactivate` | ✅ | Stop bot |
| POST | `/api/bots/:id/logout` | ✅ | Logout + clear auth for re-pair |
| GET | `/api/bots/:id/status` | ✅ | Connection + QR/token status |
| GET | `/api/bots/:id/groups` | ✅ | List groups |
| GET/POST | `/api/bots/:id/settings` | ✅ | Moderation settings |
| GET/POST | `/api/bots/:id/schedules` | ✅ | Group schedules |
| GET/POST | `/api/bots/:id/quiz` | ✅ | Quiz & greeting config |
| POST | `/api/bots/:id/quiz/send` | ✅ | Send quiz now |
| GET | `/api/bots/:id/logs` | ✅ | Activity log |
| GET | `/api/admin/stats` | Admin | Platform statistics |
| GET | `/api/admin/users` | Admin | List all users |
| PUT | `/api/admin/users/:id` | Admin | Update user (active, role, plan) |
| DELETE | `/api/admin/users/:id` | Admin | Delete user |
| GET/POST | `/api/admin/announcements` | Admin | List/create announcements |
| DELETE | `/api/admin/announcements/:id` | Admin | Delete announcement |
| POST | `/api/admin/announcements/:id/broadcast` | Admin | Broadcast to all bot groups |
| GET | `/api/status` | — | Health check (aggregate) |

### Subscription plans

- **Free**: 1 bot, anti-link only
- **Pro** ($9/mo): 5 bots, all features
- **Business** ($29/mo): unlimited bots, all features

### Roles

- **founder**: Highest privilege — cannot be deleted or demoted by non-founders
- **admin**: Can access admin dashboard, manage users and announcements
- **user**: Standard access to dashboard and bots

## Verifying the app started

```sh
docker compose -f docker-compose.base44.yml logs bot
```

Success: `✅ Database migrations complete` then `📊 OmniMod SaaS platform is ready on port 3000.`

## WhatsApp reliability checks

- Baileys participants expose `id`, phone `jid`, and anonymous `lid`. Permission checks must compare all aliases with the domain preserved; the socket's `user.lid` may be the only matching bot identity in a group.
- Normalize wrapped/disappearing message content before inspecting text or captions. Keep per-message errors isolated so one failed deletion does not stop the rest of a batch.
- Reconnection events are bound to their original socket. Ignore obsolete sockets, keep only one retry timer, and retry startup errors as well as disconnects. Preserve pairing on 408/500; only confirmed WhatsApp logout (401) clears auth. A replaced session (440) needs the competing instance stopped, not new pairing.
- `/api/status` reports the first loaded bot, which may be deactivated; a `stopped` aggregate does not establish the moderation bot's state. Use the authenticated per-bot status and activity logs. `bot_disconnected` and `moderation_skipped` include actionable reasons.
- Tests use fake WhatsApp sockets and temporary auth directories, never real group sends or removals. Passing tests/reconnect logs are not proof a newly posted link disappeared on WhatsApp; confirm that separately from a non-admin member (group admins and the bot's own messages are exempt).
- The Base44 sandbox is a development preview, not an always-on production hosting guarantee. No production deployment workflow is currently configured in this checkout.

## Tests

```sh
docker compose -f docker-compose.base44.yml exec -T bot npm test
# Focused moderation and recovery regression tests:
docker compose -f docker-compose.base44.yml exec -T bot node --test src/BotInstance.test.js
```
