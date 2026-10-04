import { config } from './config.js';
import { pool } from './db.js';

// Load plans from DB and update config in memory
export async function loadPlansFromDB() {
  try {
    const result = await pool.query('SELECT * FROM plans ORDER BY sort_order');
    if (!result.rows.length) return;

    for (const row of result.rows) {
      if (!config.plans[row.plan_key]) {
        config.plans[row.plan_key] = { name: row.name, priceId: null, maxBots: row.max_bots, features: row.features || [] };
      } else {
        config.plans[row.plan_key].name = row.name;
        config.plans[row.plan_key].maxBots = row.max_bots;
        config.plans[row.plan_key].features = row.features || [];
      }
      config.plans[row.plan_key].price = row.price;
      config.messageLimits[row.plan_key] = row.message_limit;
    }

    console.log(`📋 Loaded ${result.rows.length} plan(s) from database`);
  } catch (err) {
    console.error('❌ Failed to load plans from DB:', err.message);
  }
}

export async function getAllPlans() {
  return (await pool.query('SELECT * FROM plans ORDER BY sort_order')).rows;
}

export async function createPlan(data) {
  const { plan_key, name, price, max_bots, message_limit, features, sort_order } = data;
  if (!plan_key || !name) throw new Error('Plan key and name are required');
  const result = await pool.query(
    `INSERT INTO plans (plan_key, name, price, max_bots, message_limit, features, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [plan_key.toLowerCase(), name, price || '₦0', max_bots ?? 1, message_limit ?? 200,
     JSON.stringify(features || []), sort_order ?? 99]
  );
  await loadPlansFromDB();
  return result.rows[0];
}

export async function updatePlan(id, data) {
  const allowed = ['name', 'price', 'max_bots', 'message_limit', 'features', 'is_active', 'sort_order'];
  const setClauses = [];
  const params = [];
  let idx = 1;
  for (const [key, val] of Object.entries(data)) {
    if (val === undefined || !allowed.includes(key)) continue;
    setClauses.push(`${key} = $${idx++}`);
    params.push(key === 'features' ? JSON.stringify(val) : val);
  }
  if (setClauses.length) {
    params.push(id);
    await pool.query(`UPDATE plans SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
  }
  await loadPlansFromDB();
  const result = await pool.query('SELECT * FROM plans WHERE id = $1', [id]);
  return result.rows[0];
}

export async function deletePlan(id) {
  await pool.query('DELETE FROM plans WHERE id = $1', [id]);
  await loadPlansFromDB();
}
