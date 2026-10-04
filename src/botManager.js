import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BotInstance } from './BotInstance.js';
import { TelegramBotInstance } from './telegramBotInstance.js';
import { config } from './config.js';
import { pool } from './db.js';

export class BotManager {
  constructor() {
    this.bots = new Map(); // botId -> BotInstance | TelegramBotInstance
  }

  // Load all bots from database on startup
  async init() {
    try {
      const result = await pool.query('SELECT * FROM bots ORDER BY created_at');
      for (const row of result.rows) {
        const bot = this.createInstanceFromRow(row);
        this.bots.set(bot.id, bot);
        if (bot.active) {
          bot.start().catch((e) => console.error(`❌ ${bot.id} start error:`, e));
        } else {
          bot.updateConnection('stopped');
          console.log(`⏸️ ${bot.id} is deactivated, skipping start.`);
        }
      }
      console.log(`🤖 ${this.bots.size} bot(s) loaded from database.`);
    } catch (err) {
      console.error('❌ Failed to load bots from database:', err.message);
    }
  }

  // Create the right instance type from a DB row
  createInstanceFromRow(row) {
    const common = {
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      role: row.role,
      capabilities: row.capabilities,
      active: row.active,
    };

    if (row.platform === 'telegram') {
      return new TelegramBotInstance({
        ...common,
        token: row.telegram_token,
      });
    }

    return new BotInstance({
      ...common,
      number: row.phone_number,
      authDir: row.auth_dir,
    });
  }

  // Create a bot for a specific user
  async createBot(userId, { platform, phoneNumber, telegramToken, displayName, role }) {
    const userResult = await pool.query('SELECT plan FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user) throw new Error('User not found');

    const plan = config.plans[user.plan] || config.plans.free;
    const existingCount = await this.countUserBots(userId);
    if (plan.maxBots !== -1 && existingCount >= plan.maxBots) {
      throw new Error(`Your ${plan.name} plan allows ${plan.maxBots} bot(s). Upgrade to create more.`);
    }

    const botPlatform = platform || 'whatsapp';
    const botId = `bot_${userId}_${Date.now()}`;
    const capabilities = this.getDefaultCapabilities(role);

    if (botPlatform === 'telegram') {
      if (!telegramToken) throw new Error('Telegram bot token is required');

      await pool.query(
        `INSERT INTO bots (id, user_id, platform, telegram_token, display_name, role, auth_dir, active, capabilities)
         VALUES ($1, $2, 'telegram', $3, $4, $5, NULL, true, $6)`,
        [botId, userId, telegramToken, displayName || null, role || 'Moderator', JSON.stringify(capabilities)],
      );

      const bot = new TelegramBotInstance({
        id: botId, userId, token: telegramToken, displayName, role: role || 'Moderator', capabilities, active: true,
      });
      this.bots.set(botId, bot);
      bot.start().catch((e) => console.error(`❌ ${botId} start error:`, e));
      return bot;
    }

    // WhatsApp
    if (!phoneNumber) throw new Error('Phone number is required');
    const authDir = join(config.authDirRoot, `user_${userId}`, botId);
    await mkdir(authDir, { recursive: true });

    await pool.query(
      `INSERT INTO bots (id, user_id, platform, phone_number, display_name, role, auth_dir, active, capabilities)
       VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6, true, $7)`,
      [botId, userId, phoneNumber, displayName || null, role || 'Moderator', authDir, JSON.stringify(capabilities)],
    );

    const bot = new BotInstance({
      id: botId, userId, number: phoneNumber, displayName, role: role || 'Moderator', authDir, capabilities, active: true,
    });
    this.bots.set(botId, bot);
    bot.start().catch((e) => console.error(`❌ ${botId} start error:`, e));
    return bot;
  }

  // List bots for a specific user
  async listUserBots(userId) {
    const result = await pool.query('SELECT * FROM bots WHERE user_id = $1 ORDER BY created_at', [userId]);
    return result.rows.map((row) => {
      const bot = this.bots.get(row.id);
      return {
        id: row.id,
        platform: row.platform,
        phoneNumber: row.phone_number,
        telegramToken: row.telegram_token,
        displayName: row.display_name,
        role: row.role,
        active: row.active,
        capabilities: row.capabilities,
        connection: bot?.state.connection || 'stopped',
        botNumber: bot?.state.botNumber || null,
        createdAt: row.created_at,
      };
    });
  }

  // Get a bot and verify ownership
  async getBotForUser(botId, userId) {
    const result = await pool.query('SELECT * FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
    if (!result.rows.length) return null;
    return this.bots.get(botId);
  }

  async countUserBots(userId) {
    const result = await pool.query('SELECT COUNT(*) FROM bots WHERE user_id = $1', [userId]);
    return parseInt(result.rows[0].count, 10);
  }

  // Update bot config in database
  async updateBot(botId, userId, updates) {
    const bot = await this.getBotForUser(botId, userId);
    if (!bot) throw new Error('Bot not found');

    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    if (updates.displayName !== undefined) {
      bot.displayName = updates.displayName || null;
      setClauses.push(`display_name = $${paramIdx++}`);
      params.push(bot.displayName);
    }
    if (updates.role !== undefined) {
      bot.role = updates.role;
      setClauses.push(`role = $${paramIdx++}`);
      params.push(bot.role);
    }
    if (updates.phoneNumber !== undefined) {
      bot.number = updates.phoneNumber;
      setClauses.push(`phone_number = $${paramIdx++}`);
      params.push(bot.phoneNumber);
    }
    if (updates.capabilities !== undefined) {
      bot.updateCapabilities(updates.capabilities);
      setClauses.push(`capabilities = $${paramIdx++}`);
      params.push(JSON.stringify(bot.capabilities));
    }

    if (setClauses.length) {
      params.push(botId, userId);
      await pool.query(`UPDATE bots SET ${setClauses.join(', ')} WHERE id = $${paramIdx++} AND user_id = $${paramIdx++}`, params);
    }
    return bot;
  }

  async activateBot(botId, userId) {
    const bot = await this.getBotForUser(botId, userId);
    if (!bot) throw new Error('Bot not found');
    await bot.activate();
    await pool.query('UPDATE bots SET active = true WHERE id = $1', [botId]);
  }

  async deactivateBot(botId, userId) {
    const bot = await this.getBotForUser(botId, userId);
    if (!bot) throw new Error('Bot not found');
    await bot.deactivate();
    await pool.query('UPDATE bots SET active = false WHERE id = $1', [botId]);
  }

  async logoutBot(botId, userId) {
    const bot = await this.getBotForUser(botId, userId);
    if (!bot) throw new Error('Bot not found');
    await bot.logout();
    await pool.query('UPDATE bots SET active = false WHERE id = $1', [botId]);
  }

  async deleteBot(botId, userId) {
    const bot = await this.getBotForUser(botId, userId);
    if (!bot) throw new Error('Bot not found');

    bot.stop();
    this.bots.delete(botId);

    // Clean auth directory (WhatsApp only)
    if (bot.authDir) {
      try {
        await rm(bot.authDir, { recursive: true, force: true });
      } catch (e) {
        console.error(`❌ ${botId} auth cleanup error:`, e.message);
      }
    }

    await pool.query('DELETE FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
  }

  getBot(botId) {
    return this.bots.get(botId);
  }

  getDefaultCapabilities(role) {
    switch (role) {
      case 'Guard': return { moderation: false, antiLink: true, announcements: false, quiz: false, greeter: false };
      case 'Announcer': return { moderation: false, antiLink: false, announcements: true, quiz: false, greeter: false };
      case 'Quiz': return { moderation: false, antiLink: false, announcements: false, quiz: true, greeter: false };
      case 'Greeter': return { moderation: false, antiLink: false, announcements: false, quiz: false, greeter: true };
      default: return { moderation: true, antiLink: true, announcements: true, quiz: true, greeter: true };
    }
  }

  listBots() {
    return Array.from(this.bots.values()).map((b) => b.getStatusSummary());
  }
}
