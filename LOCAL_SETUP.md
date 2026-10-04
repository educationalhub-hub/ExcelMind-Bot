# OmniMod — Run on Your Own Computer (Free)

Run OmniMod 24/7 on your own computer. **Your computer must stay powered on and connected to the internet** — if it sleeps or loses connection, the bot stops.

## What you need (all free)

1. **Node.js 22+** — download from https://nodejs.org and install.
2. **PostgreSQL 16** — download from https://www.postgresql.org/download/ and install.
   - Remember the password you set for the `postgres` user.
   - Create a database called `omnimod`.

## Step-by-step

### 1. Get the code

```sh
git clone <your-repo-url> omnimod
cd omnimod
```

### 2. Create your `.env` file

```sh
cp .env.example .env
```

Open `.env` in a text editor and set:

```
DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/omnimod
JWT_SECRET= paste a random string here
```

Generate a random JWT secret (run in a terminal):

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Create the database

Open a terminal and run (replace `YOUR_PASSWORD` with your PostgreSQL password):

```sh
psql -U postgres -c "CREATE DATABASE omnimod;"
```

### 4. Install dependencies and start

```sh
npm install
npm start
```

You should see:

```
✅ Database migrations complete
📊 OmniMod SaaS platform is ready on port 3000.
```

### 5. Open the dashboard

Go to **http://localhost:3000** in your browser. Sign up — your first account becomes the founder/admin automatically.

### 6. Pair your WhatsApp bot

- Go to the dashboard → My Bots → Create Bot.
- Scan the QR code with your WhatsApp (Settings → Linked Devices → Link a Device).
- The bot is now live and moderating your groups.

## Keep it running 24/7

### Don't let the computer sleep

- **Windows:** Settings → System → Power & sleep → set "Sleep" to **Never**.
- **Mac:** System Settings → Energy Saver → set "Prevent automatic sleep".
- Keep your internet connection on at all times.

### Auto-restart if the bot crashes

Use a process manager so the bot restarts automatically if it crashes:

```sh
npm install -g pm2
pm2 start src/index.js --name omnimod
pm2 save
pm2 startup        # follow the instructions it prints
```

This makes the bot start automatically when your computer boots and restart if it crashes.

### Back up your data

Your bot pairing data is in the `auth_info/` folder and your database is in PostgreSQL. Back up both regularly.

## Troubleshooting

- **"Cannot connect to PostgreSQL"** — make sure PostgreSQL is running and your password in `.env` is correct.
- **Bot disconnects** — this is normal; OmniMod reconnects automatically. Check the dashboard logs.
- **Port 3000 already in use** — close the other program or change the port in `src/index.js`.
