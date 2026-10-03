import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BotInstance } from './BotInstance.js';
import { config } from './config.js';

export class BotManager {
  constructor() {
    this.bots = new Map();
  }

  async init() {
    let configs = config.defaultBots;
    try {
      const data = await readFile(config.configsPath, 'utf-8');
      configs = JSON.parse(data);
    } catch {
      // First run — use defaults and persist them
    }

    for (const botConfig of configs) {
      const bot = new BotInstance(botConfig);
      this.bots.set(botConfig.id, bot);
      bot.start().catch((e) => console.error(`❌ ${botConfig.id} start error:`, e));
    }

    await this.saveConfigs();
  }

  async saveConfigs() {
    const configs = Array.from(this.bots.values()).map((b) => ({
      id: b.id,
      number: b.number,
      displayName: b.displayName,
      role: b.role,
      authDir: b.authDir,
    }));
    try {
      await mkdir(dirname(config.configsPath), { recursive: true });
      await writeFile(config.configsPath, JSON.stringify(configs, null, 2));
    } catch (error) {
      console.error('❌ Failed to save bot configs:', error.message);
    }
  }

  async addBot({ number, displayName, role }) {
    const id = `bot${this.bots.size + 1}`;
    const authDir = `./auth_info/${id}`;
    if (this.bots.has(id)) throw new Error(`Bot ${id} already exists`);

    const bot = new BotInstance({ id, number, displayName, role, authDir });
    this.bots.set(id, bot);
    await this.saveConfigs();
    bot.start().catch((e) => console.error(`❌ ${id} start error:`, e));
    return bot;
  }

  async removeBot(id) {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    bot.stop();
    this.bots.delete(id);
    await this.saveConfigs();
  }

  updateBot(id, updates) {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    if (updates.role !== undefined) bot.role = updates.role;
    if (updates.displayName !== undefined) bot.displayName = updates.displayName || null;
    if (updates.number !== undefined) bot.number = updates.number;
    this.saveConfigs();
    return bot;
  }

  getBot(id) {
    return this.bots.get(id);
  }

  listBots() {
    return Array.from(this.bots.values()).map((b) => b.getStatusSummary());
  }
}
