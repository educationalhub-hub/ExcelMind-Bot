# ExcelMind-Bot

WhatsApp group moderation bot SaaS platform. Users sign up, create WhatsApp bots via QR pairing, and configure moderation, quiz, announcements, and greeter features. Built with Express, PostgreSQL, and Baileys.

## Running in Base44

```sh
docker compose -f docker-compose.base44.yml up -d --build
```

- Node 22 runtime, source bind-mounted at `/app`.
- PostgreSQL 16 (Alpine) runs as a `db` compose service with auto-generated credentials.
- Dependencies installed on startup via `npm install` (lockfile-preserving).
- `JWT_SECRET` is auto-generated for development; replace with a real value for production.
- Stripe keys (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`, `STRIPE_BUSINESS_PRICE_ID`) are optional — billing routes return "not configured" without them.
- Bot runs with `node --watch src/index.js` for live reload on source changes.
- Auth state persists per-user per-bot in `./auth_info/user_{userId}/{botId}/`.

## Architecture

- **Landing page** (`/`) — marketing page with pricing tiers.
- **Auth pages** (`/login`, `/signup`) — login/signup with JWT cookies.
- **Dashboard** (`/dashboard`) — multi-tenant user dashboard behind auth.
- **API**: Express-based REST API under `/api/`.

### Key files

| File | Purpose |
|------|---------|
| `src/index.js` | Entry point — runs DB migrations, starts BotManager, serves Express app |
| `src/dashboardServer.js` | Express app with all routes (auth, billing, bot management) |
| `src/auth.js` | JWT auth middleware, signup/login/logout routes |
| `src/billing.js` | Stripe checkout, webhook handler, plan management |
| `src/db.js` | PostgreSQL connection pool + migrations (users, bots tables) |
| `src/botManager.js` | Multi-tenant bot CRUD — bots stored in DB, per-user isolation |
| `src/BotInstance.js` | WhatsApp connection, moderation, quiz, greeter, scheduling |
| `src/antiLink.js` | Link detection, abuse detection, admin check helpers |
| `src/quizSystem.js` | Quiz question bank and state management |
| `src/config.js` | Plans, schedules, rules defaults; Stripe price IDs from env |

### Database schema

- `users` — id, email, password_hash, name, plan, stripe_customer_id
- `bots` — id, user_id (FK), phone_number, display_name, role, auth_dir, active, capabilities (JSONB)

### API endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/signup` | — | Create account |
| POST | `/api/auth/login` | — | Log in |
| POST | `/api/auth/logout` | — | Log out |
| GET | `/api/auth/me` | ✅ | Current user |
| GET | `/api/billing/plans` | — | List plans |
| GET | `/api/billing/status` | ✅ | User's subscription |
| POST | `/api/billing/checkout` | ✅ | Create Stripe checkout |
| POST | `/api/billing/webhook` | — | Stripe webhook (raw body) |
| GET | `/api/bots` | ✅ | List user's bots |
| POST | `/api/bots` | ✅ | Create bot (plan-limited) |
| GET/PUT/DELETE | `/api/bots/:id` | ✅ | Read/update/delete bot |
| POST | `/api/bots/:id/activate` | ✅ | Start bot |
| POST | `/api/bots/:id/deactivate` | ✅ | Stop bot |
| POST | `/api/bots/:id/logout` | ✅ | Logout + clear auth for re-pair |
| GET | `/api/bots/:id/status` | ✅ | Connection + QR |
| GET | `/api/bots/:id/groups` | ✅ | List groups |
| POST | `/api/bots/:id/groups/refresh` | ✅ | Re-fetch groups |
| GET/POST | `/api/bots/:id/settings` | ✅ | Moderation settings |
| GET/POST | `/api/bots/:id/schedules` | ✅ | Group schedules |
| GET/POST | `/api/bots/:id/quiz` | ✅ | Quiz & greeting config |
| POST | `/api/bots/:id/quiz/send` | ✅ | Send quiz now |
| GET | `/api/bots/:id/logs` | ✅ | Activity log |
| GET | `/api/status` | — | Health check (aggregate) |

### Subscription plans

- **Free**: 1 bot, anti-link only
- **Pro** ($9/mo): 5 bots, all features
- **Business** ($29/mo): unlimited bots, all features

## Verifying the app started

```sh
docker compose -f docker-compose.base44.yml logs bot
```

Success: `✅ Database migrations complete` then `📊 ExcelMind-Bot SaaS platform is ready on port 3000.`

The landing page at `/` shows marketing content; `/signup` allows creating an account; `/dashboard` shows the user's bots.

## Tests

```sh
docker compose -f docker-compose.base44.yml exec -T bot npm test
```
