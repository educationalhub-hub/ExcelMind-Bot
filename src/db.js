import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Run migrations on startup
export async function migrate() {
  const client = await pool.connect();
  try {
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

    // Add columns to existing tables if they don't exist (safe for already-created tables)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS messages_used INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS messages_reset_at DATE NOT NULL DEFAULT CURRENT_DATE`);
    await client.query(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'whatsapp'`);
    await client.query(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS telegram_token TEXT`);

    // Make auth_dir nullable (telegram bots don't use it)
    await client.query(`ALTER TABLE bots ALTER COLUMN auth_dir DROP NOT NULL`);

    // The very first user is the founder/admin
    const firstUser = await client.query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
    if (firstUser.rows.length && firstUser.rows[0].id) {
      await client.query("UPDATE users SET role = 'founder' WHERE id = $1", [firstUser.rows[0].id]);
    }

    console.log('✅ Database migrations complete');
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
