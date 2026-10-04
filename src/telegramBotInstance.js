import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const TelegramBot = require('node-telegram-bot-api');
import { containsLink, containsAbuse } from './antiLink.js';
import { getQuizQuestion, createQuizState, QUIZZES_BEFORE_RESULTS } from './quizSystem.js';
import { config, APP_NAME } from './config.js';
import { pool } from './db.js';

const DEFAULT_ABUSIVE_WORDS = [
  'fuck', 'shit', 'bitch', 'bastard', 'idiot', 'stupid',
  'asshole', 'damn', 'crap', 'moron', 'dick', 'piss',
  'retard', 'bloody', 'wanker', 'fool',
];

const MAX_LOGS = 100;

export class TelegramBotInstance {
  constructor({ id, token, displayName, role, capabilities, active, userId }) {
    this.id = id;
    this.userId = userId || null;
    this.token = token;
    this.displayName = displayName;
    this.role = role || 'Moderator';
    this.active = active !== false;
    this.platform = 'telegram';
    this.capabilities = capabilities || { moderation: true, antiLink: true, announcements: true, quiz: true, greeter: true };
    this.bot = null;
    this.scheduleTimer = null;
    this.lastScheduleRun = {};
    this.quizState = createQuizState();

    this.state = {
      connection: 'waiting',
      qr: null,
      botNumber: null,
      botUsername: null,
      groups: [],
      logs: [],
      settings: {
        antiLink: true,
        antiAbuse: true,
        abusiveWords: [...DEFAULT_ABUSIVE_WORDS],
      },
      groupSettings: {},
      schedules: { ...config.defaultSchedules },
      quiz: {
        quizTime: this.quizState.quizTime,
        welcomeMessage: this.quizState.welcomeMessage,
      },
    };
  }

  updateCapabilities(newCapabilities) {
    this.capabilities = { ...this.capabilities, ...newCapabilities };
  }

  // --- Start / Stop ---
  async activate() {
    if (this.active) return;
    this.active = true;
    this.updateConnection('connecting');
    this.addLog('bot_started', { details: 'Bot activated by user' });
    await this.start();
  }

  async deactivate() {
    this.active = false;
    if (this.scheduleTimer) { clearInterval(this.scheduleTimer); this.scheduleTimer = null; }
    if (this.bot) {
      try { this.bot.stopPolling(); } catch { /* ignore */ }
      this.bot = null;
    }
    this.updateConnection('stopped');
    this.addLog('bot_stopped', { details: 'Bot deactivated by user' });
  }

  async logout() {
    if (this.scheduleTimer) { clearInterval(this.scheduleTimer); this.scheduleTimer = null; }
    if (this.bot) {
      try { this.bot.stopPolling(); } catch { /* ignore */ }
      // Delete the webhook to clean up
      try { await this.bot.deleteWebHook(); } catch { /* ignore */ }
      this.bot = null;
    }
    this.active = false;
    this.updateConnection('logged_out');
    this.addLog('bot_logout', { details: 'Bot disconnected — reconnect to use again' });
  }

  // --- State helpers (same interface as WhatsApp BotInstance) ---
  addLog(action, details = {}) {
    this.state.logs.unshift({ timestamp: new Date().toISOString(), action, ...details });
    if (this.state.logs.length > MAX_LOGS) this.state.logs.length = MAX_LOGS;
  }

  updateGroups(groups) { this.state.groups = groups; }
  updateConnection(status) { this.state.connection = status; }

  updateSettings(newSettings) {
    if (typeof newSettings.antiLink === 'boolean') this.state.settings.antiLink = newSettings.antiLink;
    if (typeof newSettings.antiAbuse === 'boolean') this.state.settings.antiAbuse = newSettings.antiAbuse;
    if (Array.isArray(newSettings.abusiveWords)) {
      this.state.settings.abusiveWords = newSettings.abusiveWords.filter((w) => typeof w === 'string' && w.trim());
    }
  }

  updateGroupSetting(jid, settings) {
    if (!this.state.groupSettings[jid]) this.state.groupSettings[jid] = { moderation: true };
    Object.assign(this.state.groupSettings[jid], settings);
  }

  getGroupSetting(jid) {
    return this.state.groupSettings[jid] || { moderation: true };
  }

  // --- Message credit tracking ---
  async checkMessageCredit() {
    if (!this.userId) return { allowed: true, unlimited: true };
    try {
      const result = await pool.query('SELECT role, plan, messages_used, messages_reset_at FROM users WHERE id = $1', [this.userId]);
      if (!result.rows.length) return { allowed: true, unlimited: true };
      const user = result.rows[0];
      if (user.role === 'founder' || user.role === 'admin') return { allowed: true, unlimited: true };
      const resetDate = new Date(user.messages_reset_at);
      const now = new Date();
      if (resetDate.getMonth() !== now.getMonth() || resetDate.getFullYear() !== now.getFullYear()) {
        await pool.query('UPDATE users SET messages_used = 0, messages_reset_at = CURRENT_DATE WHERE id = $1', [this.userId]);
        user.messages_used = 0;
      }
      const limit = config.messageLimits[user.plan] ?? config.messageLimits.free;
      const used = user.messages_used || 0;
      if (used >= limit) return { allowed: false, limit, used, remaining: 0 };
      return { allowed: true, limit, used, remaining: limit - used };
    } catch (e) {
      console.error(`❌ Telegram ${this.id} credit check error:`, e.message);
      return { allowed: true, unlimited: true };
    }
  }

  async useMessageCredit() {
    if (!this.userId) return;
    try {
      await pool.query('UPDATE users SET messages_used = messages_used + 1 WHERE id = $1', [this.userId]);
    } catch (e) { /* ignore */ }
  }

  updateSchedules(newSchedules) {
    Object.assign(this.state.schedules, newSchedules);
  }

  updateQuizSettings(newSettings) {
    if (newSettings.quizTime) {
      this.quizState.quizTime = newSettings.quizTime;
      this.state.quiz.quizTime = newSettings.quizTime;
    }
    if (newSettings.welcomeMessage !== undefined) {
      this.quizState.welcomeMessage = newSettings.welcomeMessage;
      this.state.quiz.welcomeMessage = newSettings.welcomeMessage;
    }
  }

  // --- Connection ---
  async start() {
    try {
      this.bot = new TelegramBot(this.token, { polling: true });

      this.bot.on('polling_error', (error) => {
        if (error.message?.includes('409') || error.message?.includes('Conflict')) {
          // Another instance is polling — ignore
          return;
        }
        if (error.message?.includes('401') || error.message?.includes('Unauthorized')) {
          this.updateConnection('error');
          this.addLog('auth_error', { details: 'Invalid bot token' });
          return;
        }
        console.error(`❌ Telegram ${this.id} polling error:`, error.message);
      });

      // Get bot info on connect
      const me = await this.bot.getMe();
      this.state.botUsername = me.username;
      this.state.botNumber = me.username;
      this.updateConnection('connected');
      this.addLog('bot_connected', { details: `Connected as @${me.username}` });
      console.log(`✅ ${this.id} (@${me.username}) connected to Telegram!`);

      // Message handling (moderation)
      this.bot.on('message', (msg) => this.handleMessage(msg));

      // New member greeting
      this.bot.on('new_chat_members', (msg) => this.handleNewMembers(msg));

      // Start scheduler
      this.startScheduler();

      // Fetch groups/chats
      await this.refreshGroups();
    } catch (err) {
      console.error(`❌ Telegram ${this.id} start error:`, err.message);
      this.updateConnection('error');
      this.addLog('connection_error', { details: err.message });
    }
  }

  // --- Admin check ---
  async isBotAdmin(chatId) {
    try {
      const admins = await this.bot.getChatAdministrators(chatId);
      return admins.some((a) => a.user && a.user.username === this.state.botUsername);
    } catch {
      return false;
    }
  }

  async isSenderAdmin(chatId, userId) {
    try {
      const admins = await this.bot.getChatAdministrators(chatId);
      return admins.some((a) => a.user && a.user.id === userId);
    } catch {
      return false;
    }
  }

  // --- Refresh groups (Telegram chats where bot is a member) ---
  async refreshGroups() {
    if (!this.bot || this.state.connection !== 'connected') return;
    // Telegram API doesn't have a "list all chats" method — we track them from messages
    // Groups are accumulated as the bot receives messages from them
    this.addLog('groups_refreshed', { details: `${this.state.groups.length} group(s) known` });
  }

  // --- Message handling (moderation) ---
  async handleMessage(msg) {
    try {
      if (!msg.text && !msg.caption) return;
      const chatId = msg.chat?.id;
      if (!chatId) return;
      // Only moderate group/supergroup chats
      if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;

      const chatTitle = msg.chat.title || String(chatId);

      // Track this group
      if (!this.state.groups.find((g) => g.jid === String(chatId))) {
        const isBotAdmin = await this.isBotAdmin(chatId);
        this.state.groups.push({
          jid: String(chatId),
          name: chatTitle,
          participants: 0, // Telegram doesn't easily provide this
          isAdmin: isBotAdmin,
        });
      }

      const groupSetting = this.getGroupSetting(String(chatId));
      if (!groupSetting.moderation) return;

      const text = msg.text || msg.caption || '';
      const senderId = msg.from?.id;
      if (!senderId) return;

      // Skip admins
      const senderIsAdmin = await this.isSenderAdmin(chatId, senderId);
      if (senderIsAdmin) return;

      const hasLink = this.capabilities.antiLink && this.state.settings.antiLink && containsLink(text);
      const hasAbuse = this.capabilities.moderation && this.state.settings.antiAbuse && containsAbuse(text, this.state.settings.abusiveWords);

      if (!hasLink && !hasAbuse) return;

      // Delete the message
      try {
        await this.bot.deleteMessage(chatId, msg.message_id);
        const action = hasLink ? 'link_deleted' : 'abuse_deleted';
        const reason = hasLink ? 'link' : 'abusive language';
        this.addLog(action, {
          group: chatTitle, groupJid: String(chatId),
          sender: String(senderId), content: text.slice(0, 100), reason,
        });
        console.log(`🗑️ Telegram ${this.id}: Deleted ${reason} from ${senderId} in ${chatTitle}`);
      } catch (err) {
        console.error(`❌ Telegram ${this.id} delete failed:`, err.message);
      }

      // Restrict user for link violation (mute)
      if (hasLink) {
        try {
          const until = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12h
          await this.bot.restrictChatMember(chatId, senderId, {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            until_date: until,
          });
          this.addLog('user_muted', {
            group: chatTitle, groupJid: String(chatId), sender: String(senderId),
            details: 'Muted for 12 hours (link violation)',
          });
          console.log(`🔇 Telegram ${this.id}: Muted ${senderId} in ${chatTitle} for 12h`);
        } catch (err) {
          console.error(`❌ Telegram ${this.id} mute failed:`, err.message);
        }
      }
    } catch (error) {
      console.error(`❌ Telegram ${this.id} moderation error:`, error);
    }
  }

  // --- Greeter: welcome new members ---
  async handleNewMembers(msg) {
    if (!this.capabilities.greeter) return;
    const chatId = msg.chat?.id;
    if (!chatId) return;
    for (const member of msg.new_chat_members || []) {
      try {
        const name = member.first_name || member.username || 'there';
        const welcomeMsg = (this.state.quiz.welcomeMessage || '👋 Welcome to the group!').replace('{name}', name);
        await this.bot.sendMessage(chatId, welcomeMsg);
        this.addLog('member_welcomed', { group: msg.chat.title || String(chatId), sender: String(member.id) });
        console.log(`👋 Telegram ${this.id}: Welcomed ${name} in ${msg.chat.title}`);
      } catch (e) {
        console.error(`❌ Telegram ${this.id} welcome error:`, e.message);
      }
    }
  }

  // --- Send message ---
  async sendInstruction(groupJid, message) {
    const credit = await this.checkMessageCredit();
    if (!credit.allowed) {
      this.addLog('credit_exhausted', { details: `Message limit reached (${credit.used}/${credit.limit}). Upgrade your plan.` });
      throw new Error('Message limit reached. Upgrade your plan to send more messages.');
    }
    if (groupJid === 'all') {
      const adminGroups = this.state.groups.filter((g) => g.isAdmin);
      let sent = 0;
      for (const group of adminGroups) {
        const c = await this.checkMessageCredit();
        if (!c.allowed) {
          this.addLog('credit_exhausted', { details: `Stopped at ${sent}/${adminGroups.length} groups — limit reached` });
          break;
        }
        await this.bot.sendMessage(group.jid, message);
        await this.useMessageCredit();
        sent++;
      }
      this.addLog('instruction_broadcast', {
        group: `All admin groups (${sent}/${adminGroups.length})`,
        content: message.slice(0, 100),
      });
      return sent;
    }
    await this.bot.sendMessage(groupJid, message);
    await this.useMessageCredit();
    const groupName = this.state.groups.find((g) => g.jid === groupJid)?.name || groupJid;
    this.addLog('instruction_sent', { group: groupName, content: message.slice(0, 100) });
    return 1;
  }

  // --- Quiz: send a question as a Telegram poll ---
  async sendQuiz(groupJid) {
    const credit = await this.checkMessageCredit();
    if (!credit.allowed) {
      this.addLog('credit_exhausted', { details: `Quiz not sent — message limit reached (${credit.used}/${credit.limit})` });
      return;
    }
    const q = getQuizQuestion(this.quizState.quizIndex);
    this.quizState.quizIndex++;
    try {
      const correctOption = q.options[q.correctIndex];
      await this.bot.sendPoll(groupJid, `📝 Quiz #${this.quizState.quizzesSent + 1}: ${q.question}`, q.options, {
        type: 'quiz',
        correct_option_id: q.correctIndex,
        is_anonymous: false,
      });
      this.quizState.quizzesSent++;
      await this.useMessageCredit();
      this.addLog('quiz_sent', { group: groupJid, details: `Quiz #${this.quizState.quizzesSent}: ${q.question.slice(0, 60)}` });
      console.log(`📝 Telegram ${this.id}: Quiz #${this.quizState.quizzesSent} sent to ${groupJid}`);
    } catch (e) {
      console.error(`❌ Telegram ${this.id} quiz send error:`, e.message);
    }
  }

  // --- Group lock/unlock (Telegram: restrict who can send messages) ---
  async lockGroup(groupJid) {
    try {
      await this.bot.setChatPermissions(groupJid, {
        can_send_messages: false,
        can_send_media_messages: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
      });
      const name = this.state.groups.find((g) => g.jid === groupJid)?.name || groupJid;
      this.addLog('group_locked', { group: name, groupJid, details: 'Group locked (admins only)' });
    } catch (e) {
      console.error(`❌ Telegram ${this.id} lock error:`, e.message);
    }
  }

  async unlockGroup(groupJid) {
    try {
      await this.bot.setChatPermissions(groupJid, {
        can_send_messages: true,
        can_send_media_messages: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
        can_change_info: true,
        can_invite_users: true,
        can_pin_messages: true,
      });
      const name = this.state.groups.find((g) => g.jid === groupJid)?.name || groupJid;
      this.addLog('group_unlocked', { group: name, groupJid, details: 'Group unlocked' });
    } catch (e) {
      console.error(`❌ Telegram ${this.id} unlock error:`, e.message);
    }
  }

  // --- Scheduler ---
  startScheduler() {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = setInterval(() => this.checkSchedules(), 30000);
  }

  async checkSchedules() {
    if (this.state.connection !== 'connected' || !this.bot) return;
    const now = new Date();
    const hh = now.getHours().toString().padStart(2, '0');
    const mm = now.getMinutes().toString().padStart(2, '0');
    const hhmm = `${hh}:${mm}`;
    const today = now.toDateString();
    const adminGroups = this.state.groups.filter((g) => g.isAdmin);

    for (const group of adminGroups) {
      const gs = this.getGroupSetting(group.jid);
      const runKey = (act) => `${group.jid}:${act}`;
      const alreadyRun = (act) => this.lastScheduleRun[runKey(act)] === today;

      if (this.capabilities.announcements && gs.morningTime && gs.morningTime === hhmm && gs.morningMessage && !alreadyRun('morning')) {
        this.lastScheduleRun[runKey('morning')] = today;
        try { await this.bot.sendMessage(group.jid, gs.morningMessage); } catch (e) { /* ignore */ }
        this.addLog('morning_message', { group: group.name, groupJid: group.jid, details: 'Morning message sent' });
      }

      if (this.capabilities.announcements && gs.openTime && gs.openTime === hhmm && !alreadyRun('open')) {
        this.lastScheduleRun[runKey('open')] = today;
        await this.unlockGroup(group.jid);
      }

      if (this.capabilities.announcements && gs.closeTime && gs.closeTime === hhmm && !alreadyRun('close')) {
        this.lastScheduleRun[runKey('close')] = today;
        await this.lockGroup(group.jid);
      }

      if (this.capabilities.quiz && gs.quizEnabled && gs.quizTime && gs.quizTime === hhmm && !alreadyRun('quiz')) {
        this.lastScheduleRun[runKey('quiz')] = today;
        await this.sendQuiz(group.jid);
      }
    }
  }

  // --- Status summary (same interface as WhatsApp) ---
  getStatusSummary() {
    return {
      id: this.id,
      number: this.state.botUsername,
      displayName: this.displayName,
      role: this.role,
      platform: 'telegram',
      connection: this.state.connection,
      botNumber: this.state.botUsername,
      active: this.active,
      capabilities: this.capabilities,
      quiz: this.state.quiz,
    };
  }

  // --- Cleanup ---
  stop() {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    if (this.bot) {
      try { this.bot.stopPolling(); } catch { /* ignore */ }
    }
  }
}
