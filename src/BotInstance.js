import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import P from 'pino';
import QRCode from 'qrcode';
import { rm } from 'node:fs/promises';
import {
  isAdmin,
  containsAbuse,
  hasNonExemptedLink,
} from './antiLink.js';
import { config } from './config.js';
import { ModerationQueue } from './ModerationQueue.js';
import { pool } from './db.js';
import {
  getQuizQuestion,
  createQuizState,
  QUIZZES_BEFORE_RESULTS,
} from './quizSystem.js';

const DEFAULT_ABUSIVE_WORDS = [
  'fuck', 'shit', 'bitch', 'bastard', 'idiot', 'stupid',
  'asshole', 'damn', 'crap', 'moron', 'dick', 'piss',
  'retard', 'bloody', 'wanker', 'fool',
];

const MAX_LOGS = 100;

function getDefaultCapabilities(number, role) {
  // Main account (bot3) performs all functions
  if (number === '2349114112326') {
    return { moderation: true, antiLink: true, announcements: true, quiz: true, greeter: true };
  }
  switch (role) {
    case 'Guard': return { moderation: false, antiLink: true, announcements: false, quiz: false, greeter: false };
    case 'Announcer': return { moderation: false, antiLink: false, announcements: true, quiz: false, greeter: false };
    case 'Quiz': return { moderation: false, antiLink: false, announcements: false, quiz: true, greeter: false };
    case 'Greeter': return { moderation: false, antiLink: false, announcements: false, quiz: false, greeter: true };
    default: return { moderation: true, antiLink: true, announcements: false, quiz: false, greeter: false };
  }
}

export class BotInstance {
  constructor({ id, number, displayName, role, authDir, capabilities, active, userId }) {
    this.id = id;
    this.userId = userId || null;
    this.number = number;
    this.displayName = displayName;
    this.role = role || 'Moderator';
    this.authDir = authDir;
    this.active = active !== false;
    this.capabilities = capabilities || getDefaultCapabilities(number, role);
    this.sock = null;
    this.qrRevision = 0;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.starting = false;
    this.muteTimers = new Map();
    this.scheduleTimer = null;
    this.lastScheduleRun = {};
    this.quizState = createQuizState();
    this.abuseWarnings = new Map(); // key: `${groupJid}:${senderJid}` → warning count
    this.historyRecoverySince = null;
    this.moderationQueue = new ModerationQueue({
      isReady: () => this.active && this.state.connection === 'connected' && !!this.sock,
      process: (message) => this._moderateMessage(message),
      shouldRetry: (error) => [408, 428, 500, 503].includes(error?.output?.statusCode) || error?.message === 'Connection Closed',
      onError: (error, message) => {
        this.addLog('moderation_failed', { groupJid: message.key.remoteJid, details: `Could not moderate message ${message.key.id}: ${error.message}` });
        console.error(`❌ ${this.id} moderation error:`, error.message);
      },
      onDrop: (message, details) => this.addLog('moderation_skipped', { groupJid: message.key.remoteJid, details }),
    });

    this.state = {
      connection: 'waiting',
      qr: null,
      pairingCode: null,
      botNumber: null,
      groups: [],
      logs: [],
      settings: {
        antiLink: true,
        antiAbuse: true,
        abusiveWords: [...DEFAULT_ABUSIVE_WORDS],
        welcomeEnabled: false,
        linkExemptions: [],
      },
      groupSettings: {},
      mutedUsers: {},
      schedules: { ...config.defaultSchedules },
      rulesMessage: config.defaultRules,
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
    if (this.active && (this.sock || this.starting)) return;
    this.active = true;
    this.updateConnection('connecting');
    this.addLog('bot_started', { details: 'Bot activated by user' });
    console.log(`▶️ ${this.id}: activated by user`);
    await this.start();
  }

  async deactivate() {
    this.active = false;
    this.moderationQueue.clear();
    this.historyRecoverySince = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.scheduleTimer) { clearInterval(this.scheduleTimer); this.scheduleTimer = null; }
    for (const timer of this.muteTimers.values()) clearTimeout(timer);
    this.muteTimers.clear();
    if (this.sock) {
      try { this.sock.end(); } catch { /* ignore */ }
      this.sock = null;
    }
    this.updateConnection('stopped');
    this.addLog('bot_stopped', { details: 'Bot deactivated by user' });
    console.log(`⏸️ ${this.id}: deactivated by user`);
  }

  async logout() {
    this.active = false;
    this.moderationQueue.clear();
    this.historyRecoverySince = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.scheduleTimer) { clearInterval(this.scheduleTimer); this.scheduleTimer = null; }
    for (const timer of this.muteTimers.values()) clearTimeout(timer);
    this.muteTimers.clear();
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (e) {
        console.error(`❌ ${this.id} logout error:`, e.message);
      }
      this.sock = null;
    }
    // Wipe stale auth files so the next start() generates a fresh QR
    try {
      await rm(this.authDir, { recursive: true, force: true });
      console.log(`🧹 ${this.id}: auth directory cleared for fresh pairing`);
    } catch (e) {
      console.error(`❌ ${this.id} auth cleanup error:`, e.message);
    }
    this.active = false;
    this.qrRevision = 0;
    this.updateConnection('logged_out');
    this.addLog('bot_logout', { details: 'Bot logged out — scan QR to reconnect' });
    console.log(`🚪 ${this.id}: logged out`);
  }

  // --- State helpers ---
  addLog(action, details = {}) {
    this.state.logs.unshift({ timestamp: new Date().toISOString(), action, ...details });
    if (this.state.logs.length > MAX_LOGS) this.state.logs.length = MAX_LOGS;
  }

  updateGroups(groups) { this.state.groups = groups; }
  updateConnection(status, qr = null) {
    this.state.connection = status;
    this.state.qr = qr;
    // Clear stale pairing code whenever connection state changes
    if (status !== 'scan') this.state.pairingCode = null;
  }
  setBotNumber(number) { this.state.botNumber = number; }

  // --- Request a phone-number pairing code (alternative to QR scan) ---
  async requestPairingCode(phoneNumber) {
    if (!this.sock) throw new Error('Bot socket is not active. Activate the bot first.');
    const conn = this.state.connection;
    if (conn === 'connected') throw new Error('Bot is already connected.');
    if (conn === 'stopped' || conn === 'logged_out') throw new Error('Bot is not active. Activate it first.');

    // Baileys expects digits only, no '+' or spaces
    const digits = String(phoneNumber).replace(/\D/g, '');
    if (!digits || digits.length < 8) throw new Error('A valid phone number is required.');

    // Small delay to ensure the socket is ready to accept the request
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const code = await this.sock.requestPairingCode(digits);
      this.state.pairingCode = code || null;
      this.addLog('pairing_code', { details: `Pairing code requested for +${digits}` });
      console.log(`🔑 ${this.id}: Pairing code generated for +${digits}: ${code}`);
      return code;
    } catch (e) {
      console.error(`❌ ${this.id} pairing code error:`, e.message);
      throw new Error('Failed to generate pairing code. Make sure the bot is connecting and try again.');
    }
  }

  updateSettings(newSettings) {
    if (typeof newSettings.antiLink === 'boolean') this.state.settings.antiLink = newSettings.antiLink;
    if (typeof newSettings.antiAbuse === 'boolean') this.state.settings.antiAbuse = newSettings.antiAbuse;
    if (typeof newSettings.welcomeEnabled === 'boolean') this.state.settings.welcomeEnabled = newSettings.welcomeEnabled;
    if (Array.isArray(newSettings.abusiveWords)) {
      this.state.settings.abusiveWords = newSettings.abusiveWords.filter((w) => typeof w === 'string' && w.trim());
    }
    if (Array.isArray(newSettings.linkExemptions)) {
      this.state.settings.linkExemptions = newSettings.linkExemptions.filter((w) => typeof w === 'string' && w.trim());
    }
  }

  updateGroupSetting(jid, settings) {
    if (!this.state.groupSettings[jid]) this.state.groupSettings[jid] = { moderation: true };
    Object.assign(this.state.groupSettings[jid], settings);
  }

  getGroupSetting(jid) {
    if (!this.state.groupSettings[jid]) return { moderation: true };
    return this.state.groupSettings[jid];
  }

  // --- Message credit tracking ---
  async checkMessageCredit() {
    if (!this.userId) return { allowed: true, unlimited: true };
    try {
      const result = await pool.query('SELECT role, plan, messages_used, messages_reset_at, custom_message_limit FROM users WHERE id = $1', [this.userId]);
      if (!result.rows.length) return { allowed: true, unlimited: true };
      const user = result.rows[0];
      // Founder/admin: unlimited
      if (user.role === 'founder' || user.role === 'admin') return { allowed: true, unlimited: true };
      // Monthly reset: if reset date is from a previous month, reset counter
      const resetDate = new Date(user.messages_reset_at);
      const now = new Date();
      if (resetDate.getMonth() !== now.getMonth() || resetDate.getFullYear() !== now.getFullYear()) {
        await pool.query('UPDATE users SET messages_used = 0, messages_reset_at = CURRENT_DATE WHERE id = $1', [this.userId]);
        user.messages_used = 0;
      }
      // Admin can set a custom per-user limit that overrides the plan default
      const limit = user.custom_message_limit ?? (config.messageLimits[user.plan] ?? config.messageLimits.free);
      const used = user.messages_used || 0;
      if (used >= limit) return { allowed: false, limit, used, remaining: 0 };
      return { allowed: true, limit, used, remaining: limit - used };
    } catch (e) {
      console.error(`❌ ${this.id} credit check error:`, e.message);
      return { allowed: true, unlimited: true }; // fail open
    }
  }

  async useMessageCredit() {
    if (!this.userId) return;
    try {
      await pool.query('UPDATE users SET messages_used = messages_used + 1 WHERE id = $1', [this.userId]);
    } catch (e) { /* ignore */ }
  }

  addMutedUser(groupJid, senderJid, durationMs) {
    this.state.mutedUsers[`${groupJid}:${senderJid}`] = {
      muteUntil: new Date(Date.now() + durationMs).toISOString(),
    };
  }

  isUserMuted(groupJid, senderJid) {
    const key = `${groupJid}:${senderJid}`;
    const entry = this.state.mutedUsers[key];
    if (!entry) return false;
    if (new Date(entry.muteUntil) <= new Date()) {
      delete this.state.mutedUsers[key];
      return false;
    }
    return true;
  }

  removeMutedUser(groupJid, senderJid) {
    delete this.state.mutedUsers[`${groupJid}:${senderJid}`];
  }

  updateSchedules(newSchedules) {
    Object.assign(this.state.schedules, newSchedules);
  }

  // --- Connection ---
  async start() {
    if (!this.active || this.starting) return;
    this.starting = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const previousSocket = this.sock;
    this.sock = null;
    try { previousSocket?.end(); } catch { /* already closed */ }

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      if (!this.active) return;
      const socket = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        connectTimeoutMs: 30000,
        keepAliveIntervalMs: 15000,
        retryRequestDelayMs: 1000,
      });
      this.sock = socket;
      const isCurrent = () => this.active && this.sock === socket;
      socket.ev.on('creds.update', () => {
        if (isCurrent()) saveCreds().catch((error) => console.error(`❌ ${this.id} auth save failed:`, error.message));
      });
      socket.ev.on('connection.update', (update) => {
        this.handleConnectionUpdate(update, socket).catch((error) => console.error(`❌ ${this.id} connection update failed:`, error.message));
      });
      socket.ev.on('messages.upsert', ({ messages }) => {
        if (isCurrent()) this.handleMessages(messages).catch((error) => console.error(`❌ ${this.id} message queue failed:`, error.message));
      });
      socket.ev.on('messaging-history.set', ({ messages }) => {
        if (isCurrent()) this.handleHistoryMessages(messages).catch((error) => console.error(`❌ ${this.id} history recovery failed:`, error.message));
      });
      socket.ev.on('messages.update', (updates) => { if (isCurrent()) this.handlePollUpdates(updates); });
      socket.ev.on('group-participants.update', (update) => { if (isCurrent()) this.handleParticipantUpdate(update); });
      this.startScheduler();
    } catch (error) {
      if (this.active) {
        this.updateConnection('reconnecting');
        this.addLog('connection_error', { details: `Startup failed: ${error.message}. Retrying automatically.` });
        this.scheduleReconnect();
      }
      throw error;
    } finally {
      this.starting = false;
    }
  }

  scheduleReconnect(statusCode) {
    if (!this.active || this.reconnectTimer) return;
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 6);
    const baseDelay = statusCode === DisconnectReason.timedOut ? 3000 : 5000;
    const delay = Math.min(baseDelay * 2 ** (this.reconnectAttempts - 1), 80000);
    console.log(`🔄 ${this.id} reconnecting in ${delay / 1000}s (attempt #${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((error) => console.error(`❌ ${this.id} restart error:`, error.message));
    }, delay);
  }

  async handleConnectionUpdate(update, socket = this.sock) {
    // A late event from an old socket must not disconnect or restart its replacement.
    if (!this.active || socket !== this.sock) return;
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (connection === 'connecting' || isNewLogin) {
      this.updateConnection('connecting');
    }

    if (qr) {
      try {
        const currentRevision = ++this.qrRevision;
        const image = await QRCode.toDataURL(qr, {
          width: 320, margin: 4, errorCorrectionLevel: 'M',
        });
        if (this.active && socket === this.sock && this.qrRevision === currentRevision) {
          this.updateConnection('scan', image);
          console.log(`📱 Fresh QR for ${this.id} (${this.number})`);
        }
      } catch (error) {
        console.error(`❌ ${this.id} QR generation failed:`, error.message);
        if (this.active && socket === this.sock) this.updateConnection('error');
      }
    }

    if (connection === 'open') {
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.setBotNumber(socket.user?.id);
      this.updateConnection('connected');
      this.addLog('bot_connected', { details: `Connected as ${socket.user?.id || 'unknown'}` });
      console.log(`✅ ${this.id} (${this.number}) connected to WhatsApp!`);
      try {
        // Drain immediately on open, independently of the group-list refresh.
        await Promise.all([this.moderationQueue.drain(), this.refreshGroups()]);
        if (!this.active || socket !== this.sock) return;
        if (this.displayName && this.state.groups.some((g) => g.isAdmin)) {
          try {
            await socket.updateProfileName(this.displayName);
            this.addLog('profile_name_set', { details: `Profile name set to "${this.displayName}"` });
            console.log(`🏷️ ${this.id}: Profile name set to "${this.displayName}"`);
          } catch (error) {
            console.error(`❌ ${this.id} profile name failed:`, error.message);
          }
        }
      } catch (error) {
        console.error(`❌ ${this.id} group fetch failed:`, error.message);
      }
    }

    if (connection === 'close') {
      this.sock = null;
      this.qrRevision++;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const replaced = statusCode === DisconnectReason.connectionReplaced;
      if (!loggedOut && !replaced && this.historyRecoverySince === null) {
        // Overlap the last heartbeat interval; deduplication prevents double penalties.
        this.historyRecoverySince = Math.floor(Date.now() / 1000) - 30;
      }
      if (loggedOut) {
        this.moderationQueue.clear();
        this.historyRecoverySince = null;
      }
      this.updateConnection(loggedOut ? 'logged_out' : replaced ? 'error' : 'reconnecting');
      this.addLog('bot_disconnected', {
        details: `WhatsApp disconnected (${statusCode ?? 'unknown'}): ${loggedOut ? 'Scan a new QR to reconnect.' : replaced ? 'Session replaced by another connection. Stop the other instance before activating.' : 'Reconnecting automatically; saved pairing is preserved.'}`,
      });
      console.log(`❌ ${this.id} connection closed (code: ${statusCode})`);

      if (loggedOut) {
        // Only an explicit WhatsApp logout invalidates the saved pairing.
        // Network timeouts, server errors and competing sessions are not logout.
        this.reconnectAttempts = 0;
        try {
          await rm(this.authDir, { recursive: true, force: true });
          console.log(`🧹 ${this.id}: stale auth cleared (was logged out)`);
        } catch (error) {
          console.error(`❌ ${this.id} auth cleanup error:`, error.message);
        }
      } else if (!replaced) {
        this.scheduleReconnect(statusCode);
      }
    }
  }

  isBotAdminInGroup(groupMetadata, botJid) {
    return isAdmin([botJid, this.sock?.user?.lid], groupMetadata);
  }

  async refreshGroups() {
    if (!this.sock || this.state.connection !== 'connected') return;
    const socket = this.sock;
    const result = await socket.groupFetchAllParticipating();
    if (!this.active || socket !== this.sock) return;
    const groups = Object.values(result);
    const groupList = groups.map((g) => ({
      jid: g.id,
      name: g.subject || 'Unnamed',
      participants: g.participants?.length || 0,
      isAdmin: this.isBotAdminInGroup(g, this.sock.user?.id),
    }));
    this.updateGroups(groupList);
    this.addLog('groups_refreshed', { details: `${groupList.length} groups found` });
  }

  async handleMessages(messages) {
    if (!this.active) return;
    this.moderationQueue.add(messages);
    await this.moderationQueue.drain();
  }

  async handleHistoryMessages(messages = []) {
    // Only recover this process's outage, never punish an entire old chat history.
    if (this.historyRecoverySince === null) return;
    const oldest = Math.max(this.historyRecoverySince, Math.floor(Date.now() / 1000) - 48 * 60 * 60);
    await this.handleMessages(messages.filter((message) => Number(message.messageTimestamp) >= oldest));
  }

  async _moderateMessage(message) {
    const socket = this.sock;
    if (!this.active || this.state.connection !== 'connected' || !socket) return false;
    if (!message?.message || message.key?.fromMe) return;
    const remoteJid = message.key?.remoteJid;
    if (!remoteJid?.endsWith('@g.us')) return;

    const msg = normalizeMessageContent(message.message);
    if (!msg) return;
    const contextInfo =
      msg.extendedTextMessage?.contextInfo ||
      msg.imageMessage?.contextInfo ||
      msg.videoMessage?.contextInfo || {};

    const messageText = [
      msg.conversation,
      msg.extendedTextMessage?.text,
      msg.extendedTextMessage?.canonicalUrl,
      msg.extendedTextMessage?.matchedText,
      msg.imageMessage?.caption,
      msg.videoMessage?.caption,
      msg.documentMessage?.caption,
      msg.liveLocationMessage?.caption,
      msg.buttonsMessage?.contentText,
      msg.listMessage?.description,
      contextInfo?.externalAdReply?.body,
    ].filter(Boolean).join(' ') || '';

    if (!messageText) return;

    const groupSetting = this.getGroupSetting(remoteJid);
    if (!groupSetting.moderation) return;

    const exemptions = this.state.settings.linkExemptions || [];
    const hasLink = this.capabilities.antiLink && this.state.settings.antiLink && hasNonExemptedLink(messageText, exemptions);
    const hasAbuse =
      this.capabilities.moderation &&
      this.state.settings.antiAbuse &&
      containsAbuse(messageText, this.state.settings.abusiveWords);
    if (!hasLink && !hasAbuse) return;

    // Fetch permissions only for potential violations, not for every group message.
    const groupMetadata = await socket.groupMetadata(remoteJid);
    if (!this.active || socket !== this.sock || this.state.connection !== 'connected') return false;
    const groupName = groupMetadata.subject || remoteJid;
    if (!this.isBotAdminInGroup(groupMetadata, socket.user?.id)) {
      this.addLog('moderation_skipped', { group: groupName, groupJid: remoteJid, details: 'Bot is not a WhatsApp group admin; it cannot delete other members’ messages.' });
      return;
    }

    const senderJid = message.key.participant || message.participant;
    const reason = hasLink ? 'link' : 'abusive language';
    if (isAdmin(senderJid, groupMetadata)) {
      this.addLog(hasLink ? 'link_skipped_admin' : 'abuse_skipped_admin', {
        group: groupName, groupJid: remoteJid, sender: senderJid || 'unknown',
        content: messageText.slice(0, 100), reason,
        details: 'Sender is a group admin — admin messages are exempt from moderation.',
      });
      return;
    }

    await socket.sendMessage(remoteJid, { delete: message.key });
    this.addLog(hasLink ? 'link_deleted' : 'abuse_deleted', {
      group: groupName, groupJid: remoteJid,
      sender: senderJid || 'unknown',
      content: messageText.slice(0, 100), reason,
    });
    console.log(`🗑️ ${this.id}: Deleted ${reason} from ${senderJid || 'unknown'} in ${groupName}`);

    // --- Link violation: kick + 12h mute + auto re-add ---
    if (hasLink && senderJid && !this.isUserMuted(remoteJid, senderJid)) {
      await this._kickAndAutoAdd(remoteJid, senderJid, groupName, 'link violation');
    }

    // --- Abuse violation: 3-strike warning system ---
    if (hasAbuse && senderJid) {
      const warnKey = `${remoteJid}:${senderJid}`;
      const count = (this.abuseWarnings.get(warnKey) || 0) + 1;
      this.abuseWarnings.set(warnKey, count);

      if (count < 3) {
        // Warn the user
        try {
          const phoneNum = senderJid.split('@')[0].split(':')[0];
          await this.sock.sendMessage(remoteJid, {
            text: `⚠️ @${phoneNum}, please refrain from using abusive language. This is warning #${count} of 3. After 3 warnings you will be removed for 12 hours.`,
            mentions: [senderJid],
          });
          this.addLog('abuse_warning', {
            group: groupName, groupJid: remoteJid, sender: senderJid,
            details: `Warning #${count} of 3`,
          });
          console.log(`⚠️ ${this.id}: Abuse warning #${count} for ${senderJid} in ${groupName}`);
        } catch (e) {
          console.error(`❌ ${this.id} warning send failed:`, e.message);
        }
      } else {
        // Kick for 12h and reset counter
        this.abuseWarnings.set(warnKey, 0);
        await this._kickAndAutoAdd(remoteJid, senderJid, groupName, 'repeated abusive language');
      }
    }
  }

  /**
   * Remove a participant and auto re-add them after the configured mute duration.
   * Shared by both link-violation and abuse-strike-out flows.
   */
  async _kickAndAutoAdd(remoteJid, senderJid, groupName, reason) {
    try {
      await this.sock.groupParticipantsUpdate(remoteJid, [senderJid], 'remove');
      this.addMutedUser(remoteJid, senderJid, config.muteDurationMs);
      this.addLog('user_muted', {
        group: groupName, groupJid: remoteJid, sender: senderJid,
        details: `Muted for 12 hours (${reason})`,
      });
      console.log(`🔇 ${this.id}: Muted ${senderJid} in ${groupName} for 12h (${reason})`);

      const timerKey = `${remoteJid}:${senderJid}`;
      const timer = setTimeout(async () => {
        try {
          await this.sock.groupParticipantsUpdate(remoteJid, [senderJid], 'add');
          this.removeMutedUser(remoteJid, senderJid);
          this.addLog('user_unmuted', {
            group: groupName, groupJid: remoteJid, sender: senderJid,
            details: 'Auto-unmuted after 12h',
          });
          console.log(`🔊 ${this.id}: Unmuted ${senderJid} in ${groupName}`);
        } catch (error) {
          console.error(`❌ ${this.id} unmute failed:`, error.message);
        }
        this.muteTimers.delete(timerKey);
      }, config.muteDurationMs);
      this.muteTimers.set(timerKey, timer);
    } catch (error) {
      console.error(`❌ ${this.id} mute failed:`, error.message);
    }
  }

  // --- Group lock/unlock ---
  async lockGroup(groupJid) {
    await this.sock.groupSettingUpdate(groupJid, 'announcement');
    const name = this.state.groups.find((g) => g.jid === groupJid)?.name || groupJid;
    this.addLog('group_locked', { group: name, groupJid, details: 'Group locked (admins only)' });
  }

  async unlockGroup(groupJid) {
    await this.sock.groupSettingUpdate(groupJid, 'not_announcement');
    const name = this.state.groups.find((g) => g.jid === groupJid)?.name || groupJid;
    this.addLog('group_unlocked', { group: name, groupJid, details: 'Group unlocked (everyone can send)' });
  }

  // --- Send instruction ---
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
        await this.sock.sendMessage(group.jid, { text: message });
        await this.useMessageCredit();
        sent++;
      }
      this.addLog('instruction_broadcast', {
        group: `All admin groups (${sent}/${adminGroups.length})`,
        content: message.slice(0, 100),
      });
      return sent;
    }
    await this.sock.sendMessage(groupJid, { text: message });
    await this.useMessageCredit();
    const groupName = this.state.groups.find((g) => g.jid === groupJid)?.name || groupJid;
    this.addLog('instruction_sent', { group: groupName, content: message.slice(0, 100) });
    return 1;
  }

  // --- Send rules ---
  async sendRules(groupJid) {
    const rules = this.state.rulesMessage || config.defaultRules;
    return this.sendInstruction(groupJid, rules);
  }

  // --- Scheduler (open/close group, morning message) ---
  startScheduler() {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = setInterval(() => this.checkSchedules(), 30000);
  }

  async checkSchedules() {
    if (this.state.connection !== 'connected' || !this.sock) return;
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

      // Morning message (per-group)
      if (this.capabilities.announcements && gs.morningTime && gs.morningTime === hhmm && gs.morningMessage && !alreadyRun('morning')) {
        this.lastScheduleRun[runKey('morning')] = today;
        const credit = await this.checkMessageCredit();
        if (!credit.allowed) {
          this.addLog('credit_exhausted', { group: group.name, groupJid: group.jid, details: 'Morning message skipped — limit reached' });
        } else {
          try {
            await this.sock.sendMessage(group.jid, { text: gs.morningMessage });
            await this.useMessageCredit();
            this.addLog('morning_message', { group: group.name, groupJid: group.jid, details: 'Morning message sent' });
          } catch (e) { console.error(`❌ ${this.id} morning msg error:`, e.message); }
        }
      }

      // Open group (per-group)
      if (this.capabilities.announcements && gs.openTime && gs.openTime === hhmm && !alreadyRun('open')) {
        this.lastScheduleRun[runKey('open')] = today;
        try {
          await this.sock.groupSettingUpdate(group.jid, 'not_announcement');
          this.addLog('groups_opened', { group: group.name, groupJid: group.jid, details: 'Group opened' });
        } catch (e) { console.error(`❌ ${this.id} unlock error:`, e.message); }
      }

      // Close group (per-group)
      if (this.capabilities.announcements && gs.closeTime && gs.closeTime === hhmm && !alreadyRun('close')) {
        this.lastScheduleRun[runKey('close')] = today;
        try {
          await this.sock.groupSettingUpdate(group.jid, 'announcement');
          this.addLog('groups_closed', { group: group.name, groupJid: group.jid, details: 'Group closed' });
        } catch (e) { console.error(`❌ ${this.id} lock error:`, e.message); }
      }

      // Quiz (per-group)
      if (this.capabilities.quiz && gs.quizEnabled && gs.quizTime && gs.quizTime === hhmm && !alreadyRun('quiz')) {
        this.lastScheduleRun[runKey('quiz')] = today;
        await this.sendQuiz(group.jid);
        if (this.quizState.quizzesSent >= QUIZZES_BEFORE_RESULTS) {
          await this.sendQuizResults();
        }
      }
    }
  }

  // --- Quiz: send a question as a WhatsApp poll ---
  async sendQuiz(groupJid) {
    const credit = await this.checkMessageCredit();
    if (!credit.allowed) {
      this.addLog('credit_exhausted', { details: `Quiz not sent — message limit reached (${credit.used}/${credit.limit})` });
      return;
    }
    const q = getQuizQuestion(this.quizState.quizIndex);
    this.quizState.quizIndex++;
    try {
      const sent = await this.sock.sendMessage(groupJid, {
        poll: {
          name: `📝 Quiz #${this.quizState.quizzesSent + 1}: ${q.question}`,
          values: q.options,
          selectableCount: 1,
        },
      });
      const pollKey = sent?.key?.id;
      if (pollKey) {
        this.quizState.activePolls[pollKey] = {
          groupJid,
          correctIndex: q.correctIndex,
          votes: {},
        };
      }
      this.quizState.quizzesSent++;
      await this.useMessageCredit();
      this.addLog('quiz_sent', { group: groupJid, details: `Quiz #${this.quizState.quizzesSent}: ${q.question.slice(0, 60)}` });
      console.log(`📝 ${this.id}: Quiz #${this.quizState.quizzesSent} sent to ${groupJid}`);
    } catch (e) {
      console.error(`❌ ${this.id} quiz send error:`, e.message);
    }
  }

  // --- Quiz: track poll votes ---
  handlePollUpdates(updates) {
    for (const update of updates) {
      const pollKey = update.key?.id;
      if (!pollKey) continue;
      const poll = this.quizState.activePolls[pollKey];
      if (!poll) continue;
      const pollUpdates = update.pollUpdates;
      if (!pollUpdates) continue;

      // Baileys sends vote updates with name (voterJid) and votes (selected option indexes)
      for (const vote of pollUpdates.votes || []) {
        const voterJid = vote.key?.participant || update.key?.participant;
        if (!voterJid) continue;
        const selected = vote.vote?.selectedOptions || [];
        const selectedIndexes = selected.map((s) => s.parent || s.index).filter((i) => i !== undefined);
        poll.votes[voterJid] = selectedIndexes;

        // Track score
        if (!this.quizState.scores[poll.groupJid]) this.quizState.scores[poll.groupJid] = {};
        if (!this.quizState.scores[poll.groupJid][voterJid]) {
          this.quizState.scores[poll.groupJid][voterJid] = { correct: 0, total: 0 };
        }
        const score = this.quizState.scores[poll.groupJid][voterJid];
        score.total++;
        if (selectedIndexes.length === 1 && selectedIndexes[0] === poll.correctIndex) score.correct++;
      }
    }
  }

  // --- Quiz: send results after N quizzes ---
  async sendQuizResults() {
    for (const [groupJid, participants] of Object.entries(this.quizState.scores)) {
      if (!Object.keys(participants).length) continue;
      const lines = Object.entries(participants)
        .sort(([, a], [, b]) => b.correct - a.correct)
        .map(([jid, s], i) => {
          const name = jid.split('@')[0].split(':')[0];
          const pct = s.total ? Math.round((s.correct / s.total) * 100) : 0;
          return `${i + 1}. +${name} — ${s.correct}/${s.total} (${pct}%)`;
        });
      const summary = `🏆 *Quiz Results (${QUIZZES_BEFORE_RESULTS} rounds)*\n\n${lines.join('\n')}\n\n🎉 Well done! New quiz round starting soon. — *OmniMod* 🤖`;
      try {
        await this.sock.sendMessage(groupJid, { text: summary });
        this.addLog('quiz_results', { group: groupJid, details: `Results sent for ${QUIZZES_BEFORE_RESULTS} quizzes` });
        console.log(`🏆 ${this.id}: Quiz results sent to ${groupJid}`);
      } catch (e) {
        console.error(`❌ ${this.id} results send error:`, e.message);
      }
    }
    // Reset after sending results
    this.quizState.quizzesSent = 0;
    this.quizState.scores = {};
    this.quizState.activePolls = {};
  }

  // --- Greeter: welcome new members (only when welcomeEnabled is ON) ---
  async handleParticipantUpdate(update) {
    if (!this.capabilities.greeter) return;
    if (!this.state.settings.welcomeEnabled) return;
    if (update.action !== 'add') return;
    const groupJid = update.id;
    if (!groupJid?.endsWith('@g.us')) return;
    const adminGroups = this.state.groups.filter((g) => g.isAdmin);
    if (!adminGroups.find((g) => g.jid === groupJid)) return;

    for (const participant of update.participants || []) {
      try {
        const phoneNum = participant.split('@')[0].split(':')[0];
        const name = `+${phoneNum}`;
        const welcomeMsg = (this.state.quiz.welcomeMessage || '👋 Welcome to the group! Please read the group rules and enjoy your stay. — *OmniMod* 🤖').replace('{name}', name);
        await this.sock.sendMessage(groupJid, {
          text: welcomeMsg,
          mentions: [participant],
        });
        this.addLog('member_welcomed', { group: groupJid, sender: participant });
        console.log(`👋 ${this.id}: Welcomed ${participant} in ${groupJid}`);
      } catch (e) {
        console.error(`❌ ${this.id} welcome error:`, e.message);
      }
    }
  }

  // --- Quiz settings update ---
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

  // --- Status summary ---
  getStatusSummary() {
    return {
      id: this.id,
      number: this.number,
      displayName: this.displayName,
      role: this.role,
      connection: this.state.connection,
      botNumber: this.state.botNumber,
      active: this.active,
      capabilities: this.capabilities,
      quiz: this.state.quiz,
    };
  }

  // --- Cleanup ---
  stop() {
    this.active = false;
    this.moderationQueue.clear();
    this.historyRecoverySince = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.scheduleTimer) { clearInterval(this.scheduleTimer); this.scheduleTimer = null; }
    for (const timer of this.muteTimers.values()) clearTimeout(timer);
    this.muteTimers.clear();
    const socket = this.sock;
    this.sock = null;
    try { socket?.end(); } catch { /* ignore */ }
    this.updateConnection('stopped');
  }
}
