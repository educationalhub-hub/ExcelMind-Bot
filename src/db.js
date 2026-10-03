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
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS bots (
        id          TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        phone_number TEXT,
        display_name TEXT,
        role        TEXT NOT NULL DEFAULT 'Moderator',
        auth_dir     TEXT NOT NULL,
        active      BOOLEAN NOT NULL DEFAULT true,
        capabilities JSONB NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_bots_user_id ON bots(user_id);
    `);
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
