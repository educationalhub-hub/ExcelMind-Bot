import express from 'express';
import cookieParser from 'cookie-parser';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { requireAuth, authRouter, COOKIE_NAME } from './auth.js';
import { billingRouter, handleStripeWebhook } from './billing.js';
import { config } from './config.js';

async function sendHtml(res, file) {
  try {
    const page = await readFile(new URL(file, import.meta.url));
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

  // Create a new bot
  botApi.post('/bots', async (req, res) => {
    const { phoneNumber, displayName, role } = req.body || {};
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    try {
      const bot = await botManager.createBot(req.user.id, { phoneNumber, displayName, role });
      res.json(bot.getStatusSummary());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Bot-scoped routes: /api/bots/:botId/...
  botApi.get('/bots/:botId/status', async (req, res) => {
    const bot = await botManager.getBotForUser(req.params.botId, req.user.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json({
      connection: bot.state.connection,
      qr: bot.state.qr,
      botNumber: bot.state.botNumber,
      displayName: bot.displayName,
      role: bot.role,
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
      await bot.refreshGroups();
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
    if (bot.state.connection !== 'connected' || !bot.sock) return res.status(503).json({ error: 'Bot not connected' });
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
    if (bot.state.connection !== 'connected' || !bot.sock) return res.status(503).json({ error: 'Bot not connected' });
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
    const { jid, moderation } = req.body || {};
    if (!jid || typeof moderation !== 'boolean') return res.status(400).json({ error: 'jid and moderation required' });
    bot.updateGroupSetting(jid, moderation);
    res.json(bot.state.groupSettings);
  });

  app.use('/api', botApi);

  return app;
}
