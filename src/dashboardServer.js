import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { requireAuth, requireAdmin, authRouter, COOKIE_NAME } from './auth.js';
import { billingRouter, handleStripeWebhook } from './billing.js';
import { config, APP_NAME } from './config.js';
import { pool } from './db.js';
import { getAllPlans, createPlan, updatePlan, deletePlan } from './planManager.js';

async function sendHtml(res, file) {
  try {
    const page = await readFile(new URL(file, import.meta.url));
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('html').send(page);
  } catch {
    res.status(500).send('Page unavailable');
  }
}

export function createApp(botManager) {
  const app = express();

  // Stripe webhook needs raw body — register BEFORE express.json
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

  app.use(express.json());
  app.use(cookieParser());

  // --- Static pages ---
  app.get('/', (req, res) => sendHtml(res, './landing.html'));
  app.get('/login', (req, res) => sendHtml(res, './auth.html'));
  app.get('/signup', (req, res) => sendHtml(res, './auth.html'));
  app.get('/dashboard', (req, res) => sendHtml(res, './dashboard.html'));
  app.get('/admin', (req, res) => sendHtml(res, './admin.html'));

  // --- API: Auth ---
  app.use('/api/auth', authRouter());

  // --- API: Billing ---
  app.use('/api/billing', billingRouter());

  // --- API: Aggregate status (health-check) ---
  app.get('/api/status', (req, res) => {
    const bots = botManager.listBots();
    const primary = bots[0] || {};
    res.json({ connection: primary.connection || 'waiting', bots: bots.length });
  });

  // --- API: Profile (behind auth) ---
  app.get('/api/profile', requireAuth, async (req, res) => {
    try {
      const result = await pool.query('SELECT id, email, name, plan, role, created_at FROM users WHERE id = $1', [req.user.id]);
      res.json(result.rows[0] || { error: 'Not found' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch profile' });
    }
  });

  app.put('/api/profile', requireAuth, async (req, res) => {
    const { name, email } = req.body || {};
    try {
      const setClauses = [];
      const params = [];
      let idx = 1;
      if (name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(name); }
      if (email !== undefined) {
        // Check email isn't taken
        const existing = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email.toLowerCase(), req.user.id]);
        if (existing.rows.length) return res.status(409).json({ error: 'Email already in use' });
        setClauses.push(`email = $${idx++}`);
        params.push(email.toLowerCase());
      }
      if (setClauses.length) {
        params.push(req.user.id);
        await pool.query(`UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
      }
      const result = await pool.query('SELECT id, email, name, plan, role, created_at FROM users WHERE id = $1', [req.user.id]);
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });

  app.put('/api/profile/password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    try {
      const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
      const user = result.rows[0];
      const valid = await bcrypt.compare(currentPassword || '', user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

      const hash = await bcrypt.hash(newPassword, 10);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to change password' });
    }
  });

  // --- Public broadcasts (homepage marquee) ---
  app.get('/api/broadcasts', async (req, res) => {
    try {
      const result = await pool.query('SELECT id, message FROM broadcasts WHERE is_active = true ORDER BY created_at DESC');
      res.json({ broadcasts: result.rows });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch broadcasts' });
    }
  });

  // --- Notifications (behind auth) ---
  app.get('/api/notifications', requireAuth, async (req, res) => {
    try {
      const result = await pool.query('SELECT id, message, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [req.user.id]);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch notifications' });
    }
  });

  app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
    try {
      await pool.query('UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to mark notification' });
    }
  });

  // --- API: Admin (behind auth + admin) ---
  const adminApi = express.Router();
  adminApi.use(requireAuth, requireAdmin);

  // Stats
  adminApi.get('/stats', async (req, res) => {
    try {
      const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
      const activeUsers = await pool.query('SELECT COUNT(*) FROM users WHERE is_active = true');
      const paidUsers = await pool.query("SELECT COUNT(*) FROM users WHERE plan != 'free'");
      const totalBots = await pool.query('SELECT COUNT(*) FROM bots');
      const activeBots = await pool.query('SELECT COUNT(*) FROM bots WHERE active = true');
      const waBots = await pool.query("SELECT COUNT(*) FROM bots WHERE platform = 'whatsapp'");
      const tgBots = await pool.query("SELECT COUNT(*) FROM bots WHERE platform = 'telegram'");
      const planBreakdown = await pool.query('SELECT plan, COUNT(*) as count FROM users GROUP BY plan');
      res.json({
        totalUsers: parseInt(totalUsers.rows[0].count, 10),
        activeUsers: parseInt(activeUsers.rows[0].count, 10),
        paidUsers: parseInt(paidUsers.rows[0].count, 10),
        totalBots: parseInt(totalBots.rows[0].count, 10),
        activeBots: parseInt(activeBots.rows[0].count, 10),
        waBots: parseInt(waBots.rows[0].count, 10),
        tgBots: parseInt(tgBots.rows[0].count, 10),
        planBreakdown: planBreakdown.rows,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // List all users
  adminApi.get('/users', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT u.id, u.email, u.name, u.plan, u.role, u.is_active, u.created_at,
                u.messages_used, u.custom_message_limit, u.messages_reset_at,
                (SELECT COUNT(*) FROM bots WHERE user_id = u.id) as bot_count
         FROM users u ORDER BY u.created_at DESC`
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  // Update user (activate/deactivate, change role, change plan)
  adminApi.put('/users/:id', async (req, res) => {
    const { id } = req.params;
    const { isActive, role, plan } = req.body || {};
    try {
      const setClauses = [];
      const params = [];
      let idx = 1;
      if (isActive !== undefined) { setClauses.push(`is_active = $${idx++}`); params.push(isActive); }
      if (role !== undefined) {
        if (!['founder', 'admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
        // Protect founder from being demoted
        const target = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
        if (target.rows[0]?.role === 'founder' && role !== 'founder' && req.user.role !== 'founder') {
          return res.status(403).json({ error: 'Cannot modify founder role' });
        }
        setClauses.push(`role = $${idx++}`);
        params.push(role);
      }
      if (plan !== undefined) {
        const validPlan = await pool.query('SELECT 1 FROM plans WHERE plan_key = $1 AND is_active = true', [plan]);
        if (!validPlan.rows.length) return res.status(400).json({ error: 'Invalid plan' });
        setClauses.push(`plan = $${idx++}`);
        params.push(plan);
      }
      if (setClauses.length) {
        params.push(id);
        await pool.query(`UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
      }
      const result = await pool.query('SELECT id, email, name, plan, role, is_active FROM users WHERE id = $1', [id]);
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  // Delete user
  adminApi.delete('/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
      // Protect founder from deletion
      const target = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
      if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
      if (target.rows[0].role === 'founder') return res.status(403).json({ error: 'Cannot delete founder account' });
      if (String(id) === String(req.user.id)) return res.status(403).json({ error: 'Cannot delete your own account' });

      // Stop and delete user's bots
      const userBots = await pool.query('SELECT id FROM bots WHERE user_id = $1', [id]);
      for (const row of userBots.rows) {
        const bot = botManager.getBot(row.id);
        if (bot) { bot.stop(); botManager.bots.delete(row.id); }
      }

      await pool.query('DELETE FROM users WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  // Announcements
  adminApi.get('/announcements', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT a.*, u.email as author_email FROM announcements a
         JOIN users u ON a.author_id = u.id ORDER BY a.created_at DESC`
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch announcements' });
    }
  });

  adminApi.post('/announcements', async (req, res) => {
    const { title, message, type } = req.body || {};
    if (!title || !message) return res.status(400).json({ error: 'Title and message are required' });
    try {
      const result = await pool.query(
        'INSERT INTO announcements (author_id, title, message, type) VALUES ($1, $2, $3, $4) RETURNING *',
        [req.user.id, title, message, type || 'announcement']
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create announcement' });
    }
  });

  adminApi.delete('/announcements/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM announcements WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete announcement' });
    }
  });

  // Broadcast announcement to all active users' bot groups
  adminApi.post('/announcements/:id/broadcast', async (req, res) => {
    try {
      const annResult = await pool.query('SELECT * FROM announcements WHERE id = $1', [req.params.id]);
      if (!annResult.rows.length) return res.status(404).json({ error: 'Announcement not found' });
      const ann = annResult.rows[0];

      let sent = 0;
      for (const bot of botManager.bots.values()) {
        if (bot.state.connection !== 'connected') continue;
        const adminGroups = (bot.state.groups || []).filter((g) => g.isAdmin);
        for (const group of adminGroups) {
          try {
            await bot.sendInstruction(group.jid, `📢 ${ann.title}\n\n${ann.message}`);
            sent++;
          } catch (e) { /* ignore individual failures */ }
        }
      }
      res.json({ sent });
    } catch (err) {
      res.status(500).json({ error: 'Failed to broadcast' });
    }
  });

  // List all bots across all users (admin only)
  adminApi.get('/bots', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT b.*, u.email as owner_email, u.name as owner_name
         FROM bots b JOIN users u ON b.user_id = u.id
         ORDER BY b.created_at DESC`
      );
      const bots = result.rows.map((row) => {
        const bot = botManager.getBot(row.id);
        return {
          id: row.id,
          platform: row.platform,
          phoneNumber: row.phone_number,
          displayName: row.display_name,
          role: row.role,
          active: row.active,
          capabilities: row.capabilities,
          ownerEmail: row.owner_email,
          ownerName: row.owner_name,
          connection: bot?.state?.connection || 'stopped',
          botNumber: bot?.state?.botNumber || null,
          groupCount: bot?.state?.groups?.length || 0,
          createdAt: row.created_at,
        };
      });
      res.json(bots);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch bots' });
    }
  });

  // Toggle any bot's active state (admin only)
  adminApi.post('/bots/:botId/toggle', async (req, res) => {
    const { botId } = req.params;
    try {
      const botRow = await pool.query('SELECT user_id FROM bots WHERE id = $1', [botId]);
      if (!botRow.rows.length) return res.status(404).json({ error: 'Bot not found' });
      const bot = botManager.getBot(botId);
      if (!bot) return res.status(404).json({ error: 'Bot not loaded' });
      if (bot.active) {
        await bot.deactivate();
        await pool.query('UPDATE bots SET active = false WHERE id = $1', [botId]);
      } else {
        await bot.activate();
        await pool.query('UPDATE bots SET active = true WHERE id = $1', [botId]);
      }
      res.json(bot.getStatusSummary());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Aggregate activity from all bots (admin only)
  adminApi.get('/activity', async (req, res) => {
    try {
      const allLogs = [];
      for (const bot of botManager.bots.values()) {
        const ownerEmail = bot.number || bot.id;
        for (const log of bot.state.logs || []) {
          allLogs.push({
            ...log,
            botId: bot.id,
            botNumber: bot.number || bot.displayName || bot.id,
            platform: bot.platform || 'whatsapp',
          });
        }
      }
      allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      res.json(allLogs.slice(0, 200));
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch activity' });
    }
  });

  // List all payment verifications (admin only)
  adminApi.get('/verifications', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT v.id, v.plan, v.sender_name, v.bank_name, v.transaction_id, v.status, v.created_at,
                u.email, u.name as user_name
         FROM payment_verifications v
         JOIN users u ON v.user_id = u.id
         ORDER BY v.created_at DESC`
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch verifications' });
    }
  });

  // Approve or reject a payment verification (admin only)
  adminApi.put('/verifications/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be approved or rejected' });
    }
    try {
      const result = await pool.query(
        'SELECT user_id, plan, status FROM payment_verifications WHERE id = $1', [id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Verification not found' });
      const v = result.rows[0];
      if (v.status !== 'pending') return res.status(400).json({ error: 'Already reviewed' });

      await pool.query(
        'UPDATE payment_verifications SET status = $1, reviewed_by = $2, reviewed_at = now() WHERE id = $3',
        [status, req.user.id, id]
      );

      if (status === 'approved') {
        await pool.query('UPDATE users SET plan = $1 WHERE id = $2', [v.plan, v.user_id]);

        // Create congratulations notification for the user
        const planName = v.plan.charAt(0).toUpperCase() + v.plan.slice(1);
        const congratsMsg = `🎉 Congratulations! Your upgrade to the ${planName} plan has been approved. You now have access to all ${planName} features. Thank you for choosing OmniMod!`;
        await pool.query('INSERT INTO notifications (user_id, message) VALUES ($1, $2)', [v.user_id, congratsMsg]);

        // Broadcast congratulations to the user's connected bot groups
        const userBots = await pool.query('SELECT id FROM bots WHERE user_id = $1 AND active = true', [v.user_id]);
        let sentCount = 0;
        for (const row of userBots.rows) {
          const bot = botManager.getBot(row.id);
          if (bot && bot.state?.connection === 'connected') {
            const adminGroups = (bot.state.groups || []).filter((g) => g.isAdmin);
            for (const group of adminGroups) {
              try {
                await bot.sendInstruction(group.jid, `🎉 *Congratulations!* 🎉\n\nYour upgrade to the *${planName}* plan has been approved! You now have access to all the features of your new plan.\n\nThank you for choosing OmniMod! 🤖`);
                sentCount++;
              } catch (e) { /* ignore individual failures */ }
            }
          }
        }
        console.log(`🎉 Upgrade congratulations sent to ${sentCount} group(s) for user ${v.user_id}`);
      }

      res.json({ success: true, status, plan: v.plan });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update verification' });
    }
  });

  // Reset a user's message credits (admin only)
  adminApi.put('/users/:id/reset-credits', async (req, res) => {
    try {
      await pool.query('UPDATE users SET messages_used = 0, messages_reset_at = CURRENT_DATE WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to reset credits' });
    }
  });

  // Set custom message limit for a user (admin only)
  adminApi.put('/users/:id/credits', async (req, res) => {
    const { custom_message_limit } = req.body || {};
    try {
      if (custom_message_limit === null || custom_message_limit === undefined) {
        await pool.query('UPDATE users SET custom_message_limit = NULL WHERE id = $1', [req.params.id]);
      } else {
        const val = parseInt(custom_message_limit, 10);
        if (isNaN(val) || val < 0) return res.status(400).json({ error: 'Invalid limit' });
        await pool.query('UPDATE users SET custom_message_limit = $1 WHERE id = $2', [val, req.params.id]);
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to set credit limit' });
    }
  });

  // --- Plans management (admin only) ---
  adminApi.get('/plans', async (req, res) => {
    try {
      res.json(await getAllPlans());
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch plans' });
    }
  });

  adminApi.post('/plans', async (req, res) => {
    try {
      res.json(await createPlan(req.body || {}));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  adminApi.put('/plans/:id', async (req, res) => {
    try {
      res.json(await updatePlan(req.params.id, req.body || {}));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  adminApi.delete('/plans/:id', async (req, res) => {
    try {
      await deletePlan(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete plan' });
    }
  });

  // --- Capability definitions management (admin only) ---
  adminApi.get('/capabilities', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM capability_definitions ORDER BY sort_order, id');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch capabilities' });
    }
  });

  adminApi.post('/capabilities', async (req, res) => {
    const { cap_key, label, description, sort_order } = req.body || {};
    if (!cap_key || !label) return res.status(400).json({ error: 'Key and label are required' });
    try {
      const result = await pool.query(
        'INSERT INTO capability_definitions (cap_key, label, description, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
        [cap_key.trim().toLowerCase(), label.trim(), description || null, sort_order || 0]
      );
      res.json(result.rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'A capability with this key already exists' });
      res.status(500).json({ error: 'Failed to create capability' });
    }
  });

  adminApi.put('/capabilities/:id', async (req, res) => {
    const { id } = req.params;
    const { label, description, is_active, sort_order } = req.body || {};
    try {
      const setClauses = [];
      const params = [];
      let idx = 1;
      if (label !== undefined) { setClauses.push(`label = $${idx++}`); params.push(label); }
      if (description !== undefined) { setClauses.push(`description = $${idx++}`); params.push(description); }
      if (is_active !== undefined) { setClauses.push(`is_active = $${idx++}`); params.push(is_active); }
      if (sort_order !== undefined) { setClauses.push(`sort_order = $${idx++}`); params.push(sort_order); }
      if (setClauses.length) {
        params.push(id);
        await pool.query(`UPDATE capability_definitions SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
      }
      const result = await pool.query('SELECT * FROM capability_definitions WHERE id = $1', [id]);
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update capability' });
    }
  });

  adminApi.delete('/capabilities/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM capability_definitions WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete capability' });
    }
  });

  // --- Broadcasts management (admin only) ---
  adminApi.get('/broadcasts', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM broadcasts ORDER BY created_at DESC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch broadcasts' });
    }
  });

  adminApi.post('/broadcasts', async (req, res) => {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Message is required' });
    try {
      const result = await pool.query('INSERT INTO broadcasts (message) VALUES ($1) RETURNING *', [message]);
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create broadcast' });
    }
  });

  adminApi.put('/broadcasts/:id', async (req, res) => {
    const { is_active, message } = req.body || {};
    try {
      const setClauses = [];
      const params = [];
      let idx = 1;
      if (is_active !== undefined) { setClauses.push(`is_active = $${idx++}`); params.push(is_active); }
      if (message !== undefined) { setClauses.push(`message = $${idx++}`); params.push(message); }
      if (setClauses.length) {
        params.push(req.params.id);
        await pool.query(`UPDATE broadcasts SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
      }
      const result = await pool.query('SELECT * FROM broadcasts WHERE id = $1', [req.params.id]);
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update broadcast' });
    }
  });

  adminApi.delete('/broadcasts/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM broadcasts WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete broadcast' });
    }
  });

  app.use('/api/admin', adminApi);

  // --- API: Message credits (behind auth) ---
  app.get('/api/credits', requireAuth, async (req, res) => {
    try {
      const result = await pool.query('SELECT role, plan, messages_used, messages_reset_at, custom_message_limit FROM users WHERE id = $1', [req.user.id]);
      if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
      const user = result.rows[0];
      const unlimited = user.role === 'founder' || user.role === 'admin';
      const limit = unlimited ? -1 : (user.custom_message_limit ?? (config.messageLimits[user.plan] ?? config.messageLimits.free));
      // Monthly reset check
      const resetDate = new Date(user.messages_reset_at);
      const now = new Date();
      if (!unlimited && (resetDate.getMonth() !== now.getMonth() || resetDate.getFullYear() !== now.getFullYear())) {
        await pool.query('UPDATE users SET messages_used = 0, messages_reset_at = CURRENT_DATE WHERE id = $1', [req.user.id]);
        user.messages_used = 0;
      }
      res.json({
        used: user.messages_used || 0,
        limit,
        unlimited,
        plan: user.plan,
        role: user.role,
        remaining: unlimited ? -1 : Math.max(0, limit - (user.messages_used || 0)),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch credits' });
    }
  });

  // --- Public capability definitions (for bot creation modal) ---
  app.get('/api/capabilities', async (req, res) => {
    try {
      const result = await pool.query('SELECT cap_key, label, description FROM capability_definitions WHERE is_active = true ORDER BY sort_order');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch capabilities' });
    }
  });

  // --- API: Bot management (all behind auth) ---
  const botApi = express.Router();
  botApi.use(requireAuth);

  // List user's bots
  botApi.get('/bots', async (req, res) => {
    try {
      const bots = await botManager.listUserBots(req.user.id);
      res.json(bots);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create a new bot (WhatsApp or Telegram)
  botApi.post('/bots', async (req, res) => {
    const { platform, phoneNumber, telegramToken, displayName, role } = req.body || {};
    try {
      const bot = await botManager.createBot(req.user.id, {
        platform: platform || 'whatsapp',
        phoneNumber, telegramToken, displayName, role,
      });
      res.json(bot.getStatusSummary());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Bot-scoped routes
  botApi.get('/bots/:botId/status', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json({
      connection: bot.state.connection,
      qr: bot.state.qr,
      botNumber: bot.state.botNumber,
      displayName: bot.displayName,
      role: bot.role,
      platform: bot.platform || 'whatsapp',
      number: bot.number,
      active: bot.active,
      capabilities: bot.capabilities,
    });
  });

  botApi.put('/bots/:botId', async (req, res) => {
    try {
      const bot = await botManager.updateBot(req.params.botId, req.user.id, req.body || {});
      res.json(bot.getStatusSummary());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  botApi.delete('/bots/:botId', async (req, res) => {
    try {
      await botManager.deleteBot(req.params.botId, req.user.id);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  botApi.post('/bots/:botId/activate', async (req, res) => {
    try {
      await botManager.activateBot(req.params.botId, req.user.id);
      const bot = botManager.getBot(req.params.botId);
      res.json(bot.getStatusSummary());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  botApi.post('/bots/:botId/deactivate', async (req, res) => {
    try {
      await botManager.deactivateBot(req.params.botId, req.user.id);
      const bot = botManager.getBot(req.params.botId);
      res.json(bot.getStatusSummary());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  botApi.post('/bots/:botId/logout', async (req, res) => {
    try {
      await botManager.logoutBot(req.params.botId, req.user.id);
      const bot = botManager.getBot(req.params.botId);
      res.json(bot.getStatusSummary());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  botApi.get('/bots/:botId/groups', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json(bot.state.groups);
  });

  botApi.post('/bots/:botId/groups/refresh', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    if (bot.state.connection !== 'connected') return res.status(503).json({ error: 'Bot not connected' });
    try {
      if (bot.refreshGroups) await bot.refreshGroups();
      res.json(bot.state.groups);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  botApi.get('/bots/:botId/logs', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json(bot.state.logs);
  });

  botApi.get('/bots/:botId/settings', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json(bot.state.settings);
  });

  botApi.post('/bots/:botId/settings', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    bot.updateSettings(req.body || {});
    bot.addLog('settings_update', { details: 'Dashboard settings updated' });
    res.json(bot.state.settings);
  });

  botApi.post('/bots/:botId/instruction', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    if (bot.state.connection !== 'connected' || !bot.sock && !bot.bot) return res.status(503).json({ error: 'Bot not connected' });
    const { message, groupJid } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Message is required' });
    try {
      const sent = await bot.sendInstruction(groupJid, message);
      res.json({ sent });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  botApi.get('/bots/:botId/schedules', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json(bot.state.schedules);
  });

  botApi.post('/bots/:botId/schedules', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    bot.updateSchedules(req.body || {});
    bot.addLog('schedules_updated', { details: 'Schedule settings updated' });
    res.json(bot.state.schedules);
  });

  botApi.post('/bots/:botId/lock', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const { groupJid } = req.body || {};
    if (!groupJid) return res.status(400).json({ error: 'groupJid required' });
    try {
      await bot.lockGroup(groupJid);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  botApi.post('/bots/:botId/unlock', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const { groupJid } = req.body || {};
    if (!groupJid) return res.status(400).json({ error: 'groupJid required' });
    try {
      await bot.unlockGroup(groupJid);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  botApi.get('/bots/:botId/quiz', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json(bot.state.quiz);
  });

  botApi.post('/bots/:botId/quiz', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    bot.updateQuizSettings(req.body || {});
    bot.addLog('quiz_settings_updated', { details: 'Quiz settings updated' });
    res.json(bot.state.quiz);
  });

  botApi.post('/bots/:botId/quiz/send', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    if (bot.state.connection !== 'connected') return res.status(503).json({ error: 'Bot not connected' });
    const { groupJid } = req.body || {};
    try {
      let count = 0;
      if (!groupJid || groupJid === 'all') {
        const adminGroups = bot.state.groups.filter((g) => g.isAdmin);
        for (const g of adminGroups) { await bot.sendQuiz(g.jid); count++; }
      } else {
        await bot.sendQuiz(groupJid);
        count = 1;
      }
      res.json({ sent: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  botApi.get('/bots/:botId/group-settings', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json(bot.state.groupSettings);
  });

  botApi.post('/bots/:botId/group-settings', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const { jid, ...settings } = req.body || {};
    if (!jid) return res.status(400).json({ error: 'jid required' });
    bot.updateGroupSetting(jid, settings);
    bot.addLog('group_settings_updated', { groupJid: jid, details: 'Per-group settings updated' });
    res.json(bot.state.groupSettings);
  });

  app.use('/api', botApi);

  return app;
}
