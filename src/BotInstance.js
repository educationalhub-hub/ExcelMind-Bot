import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import P from 'pino';
import QRCode from 'qrcode';
import { rm } from 'node:fs/promises';
import {
  containsLink,
  resetLinkRegex,
  isAdmin,
  containsAbuse,
} from './antiLink.js';
import { config } from './config.js';
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
  constructor({ id, number, displayName, role, authDir, capabilities, active }) {
    this.id = id;
    this.number = number;
    this.displayName = displayName;
    this.role = role || 'Moderator';
    this.authDir = authDir;
    this.active = active !== false;
    this.capabilities = capabilities || getDefaultCapabilities(number, role);
    this.sock = null;
    this.qrRevision = 0;
    this.reconnectTimer = null;
    this.muteTimers = new Map();
    this.scheduleTimer = null;
    this.lastScheduleRun = {};
    this.quizState = createQuizState();

    this.state = {
      connection: 'waiting',
      qr: null,
      botNumber: null,
      groups: [],
      logs: [],
      settings: {
        antiLink: true,
        antiAbuse: true,
        abusiveWords: [...DEFAULT_ABUSIVE_WORDS],
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
    if (this.active) return;
    this.active = true;
    this.updateConnection('connecting');
    this.addLog('bot_started', { details: 'Bot activated by user' });
    console.log(`▶️ ${this.id}: activated by user`);
    await this.start();
  }

  async deactivate() {
    this.active = false;
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
  updateConnection(status, qr = null) { this.state.connection = status; this.state.qr = qr; }
  setBotNumber(number) { this.state.botNumber = number; }

  updateSettings(newSettings) {
    if (typeof newSettings.antiLink === 'boolean') this.state.settings.antiLink = newSettings.antiLink;
    if (typeof newSettings.antiAbuse === 'boolean') this.state.settings.antiAbuse = newSettings.antiAbuse;
    if (Array.isArray(newSettings.abusiveWords)) {
      this.state.settings.abusiveWords = newSettings.abusiveWords.filter((w) => typeof w === 'string' && w.trim());
    }
  }

  updateGroupSetting(jid, moderation) {
    if (!this.state.groupSettings[jid]) this.state.groupSettings[jid] = { moderation: true };
    this.state.groupSettings[jid].moderation = moderation;
  }

  getGroupSetting(jid) {
    if (!this.state.groupSettings[jid]) return { moderation: true };
    return this.state.groupSettings[jid];
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
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this.sock = makeWASocket({
      auth: state,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', (update) => this.handleConnectionUpdate(update));
    this.sock.ev.on('messages.upsert', ({ messages }) => this.handleMessages(messages));
    this.sock.ev.on('messages.update', (updates) => this.handlePollUpdates(updates));
    this.sock.ev.on('group-participants.update', (update) => this.handleParticipantUpdate(update));

    this.startScheduler();
  }

  async handleConnectionUpdate(update) {
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
        if (this.qrRevision === currentRevision) {
          this.updateConnection('scan', image);
          console.log(`📱 Fresh QR for ${this.id} (${this.number})`);
        }
      } catch (error) {
        console.error(`❌ ${this.id} QR generation failed:`, error.message);
        this.updateConnection('error');
      }
    }

    if (connection === 'open') {
      this.setBotNumber(this.sock.user?.id);
      this.updateConnection('connected');
      console.log(`✅ ${this.id} (${this.number}) connected to WhatsApp!`);
      try {
        await this.refreshGroups();
        this.addLog('bot_connected', { details: `Connected as ${this.sock.user?.id || 'unknown'}` });

        if (this.displayName) {
          const adminGroups = this.state.groups.filter((g) => g.isAdmin);
          if (adminGroups.length > 0) {
            try {
              await this.sock.updateProfileName(this.displayName);
              this.addLog('profile_name_set', { details: `Profile name set to "${this.displayName}"` });
              console.log(`🏷️ ${this.id}: Profile name set to "${this.displayName}"`);
            } catch (error) {
              console.error(`❌ ${this.id} profile name failed:`, error.message);
            }
          }
        }
      } catch (error) {
        console.error(`❌ ${this.id} group fetch failed:`, error.message);
      }
    }

    if (connection === 'close') {
      if (!this.active) {
        this.updateConnection('stopped');
        return;
      }
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      this.updateConnection(shouldReconnect ? 'reconnecting' : 'logged_out');
      console.log(`❌ ${this.id} connection closed (code: ${statusCode})`);

      if (shouldReconnect) {
        console.log(`🔄 ${this.id} reconnecting...`);
        this.reconnectTimer = setTimeout(
          () => this.start().catch((e) => console.error(`❌ ${this.id} restart error:`, e)),
          10000,
        );
      } else {
        // Session was logged out on WhatsApp's side — wipe stale auth files
        // so the next activate() generates a fresh QR instead of retrying dead creds
        this.qrRevision = 0;
        try {
          await rm(this.authDir, { recursive: true, force: true });
          console.log(`🧹 ${this.id}: stale auth cleared (was logged out)`);
        } catch (e) {
          console.error(`❌ ${this.id} auth cleanup error:`, e.message);
        }
      }
    }
  }

  isBotAdminInGroup(groupMetadata, botJid) {
    if (!groupMetadata?.participants || !botJid) return false;
    const botId = botJid.split('@')[0].split(':')[0];
    const member = groupMetadata.participants.find(
      (p) => (p.jid || p.id)?.split('@')[0].split(':')[0] === botId,
    );
    return member?.admin === 'admin' || member?.admin === 'superadmin';
  }

  async refreshGroups() {
    if (!this.sock || this.state.connection !== 'connected') return;
    const result = await this.sock.groupFetchAllParticipating();
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
    try {
      const message = messages[0];
      if (!message?.message || message.key.fromMe) return;
      const remoteJid = message.key.remoteJid;
      if (!remoteJid?.endsWith('@g.us')) return;

      const msg = message.message;
      const contextInfo =
        msg.extendedTextMessage?.contextInfo ||
        msg.imageMessage?.contextInfo ||
        msg.videoMessage?.contextInfo || {};

      const messageText = [
        msg.conversation,
        msg.extendedTextMessage?.text,
        msg.extendedTextMessage?.canonicalUrl,
        msg.imageMessage?.caption,
        msg.videoMessage?.caption,
        msg.documentMessage?.caption,
        msg.liveLocationMessage?.caption,
        msg.buttonsMessage?.contentText,
        msg.listMessage?.description,
        contextInfo?.externalAdReply?.body,
      ].filter(Boolean).join(' ') || '';

      if (!messageText) return;

      const groupMetadata = await this.sock.groupMetadata(remoteJid);
      const groupName = groupMetadata.subject || remoteJid;

      if (!this.isBotAdminInGroup(groupMetadata, this.sock.user?.id)) return;

      const groupSetting = this.getGroupSetting(remoteJid);
      if (!groupSetting.moderation) return;

      const senderJid = message.key.participant || message.participant;
      if (isAdmin(senderJid, groupMetadata)) return;

      resetLinkRegex();
      const hasLink = this.capabilities.antiLink && this.state.settings.antiLink && containsLink(messageText);
      const hasAbuse =
        this.capabilities.moderation &&
        this.state.settings.antiAbuse &&
        containsAbuse(messageText, this.state.settings.abusiveWords);
      if (!hasLink && !hasAbuse) return;

      await this.sock.sendMessage(remoteJid, { delete: message.key });
      const action = hasLink ? 'link_deleted' : 'abuse_deleted';
      const reason = hasLink ? 'link' : 'abusive language';
      this.addLog(action, {
        group: groupName, groupJid: remoteJid,
        sender: senderJid || 'unknown',
        content: messageText.slice(0, 100), reason,
      });
      console.log(`🗑️ ${this.id}: Deleted ${reason} from ${senderJid || 'unknown'} in ${groupName}`);

      // Mute (kick + auto re-add) for link violations
      if (hasLink && senderJid && !this.isUserMuted(remoteJid, senderJid)) {
        try {
          await this.sock.groupParticipantsUpdate(remoteJid, [senderJid], 'remove');
          this.addMutedUser(remoteJid, senderJid, config.muteDurationMs);
          this.addLog('user_muted', {
            group: groupName, groupJid: remoteJid, sender: senderJid,
            details: 'Muted for 12 hours (link violation)',
          });
          console.log(`🔇 ${this.id}: Muted ${senderJid} in ${groupName} for 12h`);

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
    } catch (error) {
      console.error(`❌ ${this.id} moderation error:`, error);
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
    if (groupJid === 'all') {
      const adminGroups = this.state.groups.filter((g) => g.isAdmin);
      for (const group of adminGroups) {
        await this.sock.sendMessage(group.jid, { text: message });
      }
      this.addLog('instruction_broadcast', {
        group: `All admin groups (${adminGroups.length})`,
        content: message.slice(0, 100),
      });
      return adminGroups.length;
    }
    await this.sock.sendMessage(groupJid, { text: message });
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

    const { openTime, closeTime, morningTime, morningMessage } = this.state.schedules;
    const adminGroups = this.state.groups.filter((g) => g.isAdmin);

    // Morning message (requires announcements capability)
    if (this.capabilities.announcements && morningTime && morningTime === hhmm && this.lastScheduleRun.morning !== today) {
      this.lastScheduleRun.morning = today;
      if (morningMessage) {
        for (const group of adminGroups) {
          try {
            await this.sock.sendMessage(group.jid, { text: morningMessage });
          } catch (e) { console.error(`❌ ${this.id} morning msg error:`, e.message); }
        }
        this.addLog('morning_message', { details: `Sent to ${adminGroups.length} group(s)` });
        console.log(`🌅 ${this.id}: Morning message sent to ${adminGroups.length} group(s)`);
      }
    }

    // Open groups (requires announcements capability)
    if (this.capabilities.announcements && openTime && openTime === hhmm && this.lastScheduleRun.open !== today) {
      this.lastScheduleRun.open = today;
      for (const group of adminGroups) {
        try {
          await this.sock.groupSettingUpdate(group.jid, 'not_announcement');
        } catch (e) { console.error(`❌ ${this.id} unlock error:`, e.message); }
      }
      this.addLog('groups_opened', { details: `Opened ${adminGroups.length} group(s)` });
      console.log(`🔓 ${this.id}: Opened ${adminGroups.length} group(s)`);
    }

    // Close groups (requires announcements capability)
    if (this.capabilities.announcements && closeTime && closeTime === hhmm && this.lastScheduleRun.close !== today) {
      this.lastScheduleRun.close = today;
      for (const group of adminGroups) {
        try {
          await this.sock.groupSettingUpdate(group.jid, 'announcement');
        } catch (e) { console.error(`❌ ${this.id} lock error:`, e.message); }
      }
      this.addLog('groups_closed', { details: `Closed ${adminGroups.length} group(s)` });
      console.log(`🔒 ${this.id}: Closed ${adminGroups.length} group(s)`);
    }

    // Quiz — only if quiz capability is enabled
    if (this.capabilities.quiz && this.quizState.quizTime === hhmm && this.lastScheduleRun.quiz !== today) {
      this.lastScheduleRun.quiz = today;
      for (const group of adminGroups) {
        await this.sendQuiz(group.jid);
      }
      if (this.quizState.quizzesSent >= QUIZZES_BEFORE_RESULTS) {
        await this.sendQuizResults();
      }
    }
  }

  // --- Quiz: send a question as a WhatsApp poll ---
  async sendQuiz(groupJid) {
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

  // --- Greeter: welcome new members ---
  async handleParticipantUpdate(update) {
    if (!this.capabilities.greeter) return;
    if (update.action !== 'add') return;
    const groupJid = update.id;
    if (!groupJid?.endsWith('@g.us')) return;
    const adminGroups = this.state.groups.filter((g) => g.isAdmin);
    if (!adminGroups.find((g) => g.jid === groupJid)) return;

    for (const participant of update.participants || []) {
      try {
        await this.sock.sendMessage(groupJid, {
          text: this.state.quiz.welcomeMessage,
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    for (const timer of this.muteTimers.values()) clearTimeout(timer);
    this.muteTimers.clear();
    if (this.sock) {
      try { this.sock.end(); } catch { /* ignore */ }
    }
  }
}
