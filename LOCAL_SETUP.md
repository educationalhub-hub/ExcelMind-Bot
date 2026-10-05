# OmniMod — Run on Your Windows Computer (Free, 24/7)

Run OmniMod on your own Windows PC. **Your computer must stay powered on and connected to the internet** — if it sleeps or loses connection, the bot stops.

---

## Step 1: Install Node.js

1. Go to https://nodejs.org
2. Download the **LTS version** (v22 or higher).
3. Run the installer — click **Next** through all defaults.
4. Verify: open **Command Prompt** and type:
   ```
   node -v
   ```
   You should see `v22.x.x`.

## Step 2: Install PostgreSQL

1. Go to https://www.postgresql.org/download/windows/
2. Download the installer and run it.
3. When asked, set a **password for the `postgres` user** — **write this down**, you need it later.
4. Keep the default port **5432**.
5. Finish the installation.
6. Open **Command Prompt** and create the database:
   ```
   psql -U postgres -c "CREATE DATABASE omnimod;"
   ```
   Enter your postgres password when prompted.

## Step 3: Download the code

1. Open **Command Prompt**.
2. Choose a folder, for example your Desktop:
   ```
   cd %USERPROFILE%\Desktop
   git clone <your-repo-url> omnimod
   cd omnimod
   ```
   (If you don't have Git, download it from https://git-scm.com first, or download the ZIP from GitHub and extract it.)

## Step 4: Create your `.env` file

1. In the `omnimod` folder, copy `.env.example` to `.env`:
   ```
   copy .env.example .env
   ```
2. Open `.env` in Notepad and edit two lines:

   ```
   DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/omnimod
   JWT_SECRET=paste-random-string-here
   ```
   Replace `YOUR_PASSWORD` with the PostgreSQL password from Step 2.

3. Generate a random JWT secret — in Command Prompt:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Copy the output and paste it as the `JWT_SECRET` value.

## Step 5: Install dependencies and start

1. In Command Prompt, inside the `omnimod` folder:
   ```
   npm install
   npm start
   ```
2. You should see:
   ```
   ✅ Database migrations complete
   📊 OmniMod SaaS platform is ready on port 3000.
   ```
3. Open your browser to **http://localhost:3000**
4. Click **Sign Up** and create an account — your first account becomes the founder/admin.

## Step 6: Pair your WhatsApp bot

1. In the dashboard, go to **My Bots** → **Create Bot**.
2. Choose WhatsApp, enter the phone number.
3. Scan the QR code with your phone: WhatsApp → **Settings** → **Linked Devices** → **Link a Device**.
4. The bot is now live. It will moderate your groups automatically.

---

## Keep it running 24/7

### Step 7: Prevent your computer from sleeping

1. **Windows Settings** → **System** → **Power & sleep**.
2. Set **Sleep** to **Never** (for both "On battery" and "When plugged in").
3. Set **Screen** to **Never** (optional, but display off is fine).
4. Make sure your Wi-Fi or Ethernet stays connected.

### Step 8: Auto-restart with PM2

PM2 restarts the bot if it crashes and starts it when your computer boots.

1. In Command Prompt:
   ```
   npm install -g pm2
   pm2 start src/index.js --name omnimod
   pm2 save
   ```
2. To make it start on boot:
   ```
   pm2 startup
   ```
   PM2 will print a command — **copy and run that command** in Command Prompt.

3. Useful PM2 commands:
   ```
   pm2 status            # see if the bot is running
   pm2 logs omnimod      # view live logs
   pm2 restart omnimod   # restart the bot
   pm2 stop omnimod      # stop the bot
   ```

### Step 9: Back up your data

- **Bot pairing data:** the `auth_info/` folder — copy it somewhere safe.
- **Database:** use pgAdmin or Command Prompt:
  ```
  pg_dump -U postgres omnimod > omnimod_backup.sql
  ```

---

## How the bot works — and when it stops

### When it works (moderating links):
- ✅ Bot is **connected** to WhatsApp (green status in dashboard).
- ✅ Someone sends a link in a group where the bot is an **admin**.
- ✅ The sender is **not a group admin**.
- → The bot **deletes the link** and temporarily removes the sender for 12 hours.

### When it stops (links survive):
- ❌ **Your computer sleeps or loses internet** → bot disconnects, misses messages.
- ❌ **WhatsApp disconnects** (408 timeout) → moderation pauses until reconnect. The bot queues delivered messages and checks links and abusive words when connected again. It cannot recover messages WhatsApp never delivers.
- ❌ **Bot is not an admin** in that WhatsApp group → it cannot delete anyone's messages.
- ❌ **Sender is a group admin** → admin links are not deleted by design.
- ❌ **The group's moderation is turned off** in dashboard settings.

### The 408 timeouts explained:
**408 means a connection/request timed out**, not that the bot was banned or logged out. It can result from network loss, a stalled response, or a WhatsApp service problem; it does not have a fixed schedule.

After a 408, OmniMod waits **3 seconds before its first reconnect attempt**. If consecutive attempts fail with another 408, the waits increase to **6, 12, 24, 48, then 80 seconds** (the maximum retry wait). Startup failures and other transient errors start at 5 seconds instead. A successful connection resets the retry counter. Each socket connection attempt has a 30-second timeout; actual downtime also depends on your internet and WhatsApp, so reconnection is not guaranteed within 3 or 4 seconds.

Delivered group messages are buffered while connecting and checked once the socket is ready, including both links and configured abusive words. Replayed messages are deduplicated to avoid repeating warnings or removals. Recent history sync is restricted to the current process's disconnect window, not your entire chat archive. Admin exemptions, group settings and link exemptions still apply.

The catch-up queue is **in memory**, retains up to **2,000 delivered group messages per bot** for at most 48 hours, and is cleared when the bot is stopped or logged out (or the process exits). Overflow, expiry and permanent moderation failures appear in the activity log. Catch-up cannot recover messages WhatsApp does not deliver, decrypt failed messages, or override WhatsApp's deletion restrictions.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot connect to PostgreSQL" | Make sure PostgreSQL is running (Start menu → "Start PostgreSQL"). Check password in `.env`. |
| Port 3000 already in use | Close the other program, or change the port in `src/index.js` (line `app.listen(3000, ...)`). |
| Bot shows "reconnecting" | Normal — it reconnects automatically. Wait a few seconds. |
| Links not deleted | Check: (1) bot is connected, (2) bot is admin in the group, (3) sender is not an admin, (4) moderation is on for that group. |
| "psql is not recognized" | Add PostgreSQL's `bin` folder to your PATH, or use pgAdmin instead. |
