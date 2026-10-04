import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Run migrations on startup
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name          TEXT,
        plan          TEXT NOT NULL DEFAULT 'free',
        stripe_customer_id TEXT,
        role          TEXT NOT NULL DEFAULT 'user',
        is_active     BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS bots (
        id          TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform    TEXT NOT NULL DEFAULT 'whatsapp',
        phone_number TEXT,
        telegram_token TEXT,
        display_name TEXT,
        role        TEXT NOT NULL DEFAULT 'Moderator',
        auth_dir     TEXT NOT NULL,
        active      BOOLEAN NOT NULL DEFAULT true,
        capabilities JSONB NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id          SERIAL PRIMARY KEY,
        author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        message     TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT 'announcement',
        is_active   BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_bots_user_id ON bots(user_id);

      CREATE TABLE IF NOT EXISTS payment_verifications (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan            TEXT NOT NULL,
        sender_name     TEXT NOT NULL,
        bank_name       TEXT NOT NULL,
        transaction_id  TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        reviewed_by     INTEGER REFERENCES users(id),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        reviewed_at     TIMESTAMPTZ
      );
    `);

    // Create additional tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id            SERIAL PRIMARY KEY,
        plan_key       TEXT UNIQUE NOT NULL,
        name           TEXT NOT NULL,
        price          TEXT NOT NULL DEFAULT '₦0',
        max_bots       INTEGER NOT NULL DEFAULT 1,
        message_limit  INTEGER NOT NULL DEFAULT 200,
        features       JSONB NOT NULL DEFAULT '[]',
        is_active      BOOLEAN NOT NULL DEFAULT true,
        sort_order     INTEGER NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS broadcasts (
        id          SERIAL PRIMARY KEY,
        message     TEXT NOT NULL,
        is_active   BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message     TEXT NOT NULL,
        is_read     BOOLEAN NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Add columns to existing tables if they don't exist (safe for already-created tables)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS messages_used INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS messages_reset_at DATE NOT NULL DEFAULT CURRENT_DATE`);
    await client.query(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'whatsapp'`);
    await client.query(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS telegram_token TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_message_limit INTEGER`);

    // Make auth_dir nullable (telegram bots don't use it)
    await client.query(`ALTER TABLE bots ALTER COLUMN auth_dir DROP NOT NULL`);

    // Seed default plans
    await client.query(`
      INSERT INTO plans (plan_key, name, price, max_bots, message_limit, features, sort_order)
      VALUES
        ('free', 'Free', '₦0', 1, 200, '["1 bot (WhatsApp or Telegram)","Anti-link moderation","Basic dashboard","QR code / token pairing"]', 0),
        ('pro', 'Pro', '₦2,000', 5, 2000, '["Up to 5 bots","Anti-link & anti-abuse","Quiz system","Greeter","Everything except schedules"]', 1),
        ('business', 'Business', '₦2,500', -1, 5000, '["Unlimited bots","Everything unlocked","Scheduled announcements","Priority support"]', 2)
      ON CONFLICT (plan_key) DO NOTHING
    `);

    // Capability definitions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS capability_definitions (
        id          SERIAL PRIMARY KEY,
        cap_key     TEXT UNIQUE NOT NULL,
        label       TEXT NOT NULL,
        description TEXT,
        is_active   BOOLEAN NOT NULL DEFAULT true,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      INSERT INTO capability_definitions (cap_key, label, description, sort_order)
      VALUES
        ('moderation', 'Moderation (anti-abuse)', 'Delete messages containing abusive or offensive language', 0),
        ('antiLink', 'Anti-Link', 'Delete links from non-admins and temporarily remove the sender', 1),
        ('announcements', 'Announcements & Schedules', 'Send scheduled messages, open/close groups automatically', 2),
        ('quiz', 'Quiz System', 'Send interactive quiz polls to groups', 3),
        ('greeter', 'Greeter (welcome new members)', 'Welcome new members when they join the group', 4)
      ON CONFLICT (cap_key) DO NOTHING
    `);

    // The very first user is the founder/admin
    const firstUser = await client.query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
    if (firstUser.rows.length && firstUser.rows[0].id) {
      await client.query("UPDATE users SET role = 'founder' WHERE id = $1", [firstUser.rows[0].id]);
    }

    await client.query('COMMIT');
    console.log('✅ Database migrations complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Convenience query helper
export async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

export async function queryOne(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}
