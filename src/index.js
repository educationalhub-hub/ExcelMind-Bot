import 'dotenv/config';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import P from 'pino';

// Suppress harmless libsignal "Bad MAC" / "Failed to decrypt" noise from stale sessions.
const SUPPRESS_PATTERNS = ['Bad MAC', 'Failed to decrypt message with any known session'];
function shouldSuppress(...args) {
  return SUPPRESS_PATTERNS.some((p) => args.map(String).join(' ').includes(p));
}
const _origError = console.error;
console.error = (...args) => { if (!shouldSuppress(...args)) _origError.apply(console, args); };
const _origStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  if (typeof chunk === 'string' && SUPPRESS_PATTERNS.some((p) => chunk.includes(p))) return true;
  return _origStderr(chunk, ...rest);
};
import { createDashboardServer } from './dashboardServer.js';
import { botState, addLog } from './botState.js';
import {
  containsLink,
  resetLinkRegex,
  isAdmin,
  containsAbuse,
} from './antiLink.js';
import { getGroupSetting } from './botState.js';

const dashboard = createDashboardServer();
dashboard.server.on('error', (error) => {
  console.error('❌ Dashboard server failed:', error.message);
  process.exit(1);
});
dashboard.server.listen(3000, '0.0.0.0', () => {
  console.log('📊 ExcelMind-Bot dashboard is ready on port 3000.');
});

function handleStartError(error) {
  console.error('❌ ExcelMind-Bot failed to start:', error);
  dashboard.updateStatus('error');
}

function isBotAdminInGroup(groupMetadata, botJid) {
  if (!groupMetadata?.participants || !botJid) return false;
  const botId = botJid.split('@')[0].split(':')[0];
  const member = groupMetadata.participants.find(
    (p) => (p.jid || p.id)?.split('@')[0].split(':')[0] === botId
  );
  return member?.admin === 'admin' || member?.admin === 'superadmin';
}

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
  });

  dashboard.setSocket(sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (connection === 'connecting' || isNewLogin) {
      await dashboard.updateStatus('connecting');
    }

    if (qr) {
      try {
        await dashboard.updateStatus('scan', qr);
        console.log('📱 Fresh WhatsApp QR code available in the preview.');
      } catch (error) {
        console.error('❌ QR generation failed:', error.message);
        await dashboard.updateStatus('error');
      }
    }

    if (connection === 'open') {
      dashboard.setSocket(sock);
      await dashboard.updateStatus('connected');
      console.log('✅ ExcelMind-Bot connected to WhatsApp!');
      try {
        await dashboard.refreshGroups();
        addLog('bot_connected', {
          details: `Connected as ${sock.user?.id || 'unknown'}`,
        });
      } catch (error) {
        console.error('❌ Failed to fetch groups:', error.message);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      await dashboard.updateStatus(
        shouldReconnect ? 'reconnecting' : 'logged_out'
      );
      console.log(
        `❌ WhatsApp connection closed. (code: ${statusCode})`
      );

      if (shouldReconnect) {
        console.log('🔄 Reconnecting...');
        setTimeout(() => startBot().catch(handleStartError), 10000);
      } else {
        console.log('⚠️ Logged out. Please authenticate again.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const message = messages[0];

      if (!message?.message) return;
      if (message.key.fromMe) return;

      const remoteJid = message.key.remoteJid;

      // Only moderate WhatsApp groups.
      if (!remoteJid?.endsWith('@g.us')) return;

      const messageText =
        message.message.conversation ||
        message.message.extendedTextMessage?.text ||
        message.message.imageMessage?.caption ||
        message.message.videoMessage?.caption ||
        '';

      if (!messageText) return;

      // Get the latest group metadata.
      const groupMetadata = await sock.groupMetadata(remoteJid);
      const groupName = groupMetadata.subject || remoteJid;

      // Only moderate groups where the bot is an admin.
      if (!isBotAdminInGroup(groupMetadata, sock.user?.id)) {
        return;
      }

      // Check per-group moderation toggle (default: enabled).
      const groupSetting = getGroupSetting(remoteJid);
      if (!groupSetting.moderation) {
        return;
      }

      const senderJid =
        message.key.participant ||
        message.participant;

      // Admins and the group owner are allowed to send anything.
      if (isAdmin(senderJid, groupMetadata)) {
        return;
      }

      resetLinkRegex();

      const hasLink =
        botState.settings.antiLink && containsLink(messageText);
      const hasAbuse =
        botState.settings.antiAbuse &&
        containsAbuse(messageText, botState.settings.abusiveWords);

      if (!hasLink && !hasAbuse) return;

      // Delete the offending message.
      await sock.sendMessage(remoteJid, {
        delete: message.key,
      });

      const action = hasLink ? 'link_deleted' : 'abuse_deleted';
      const reason = hasLink ? 'link' : 'abusive language';

      addLog(action, {
        group: groupName,
        groupJid: remoteJid,
        sender: senderJid || 'unknown',
        content: messageText.slice(0, 100),
        reason,
      });

      console.log(
        `🗑️ Deleted ${reason} message from ${senderJid || 'unknown user'} in ${groupName}`
      );

    } catch (error) {
      console.error('❌ Moderation error:', error);
    }
  });
}

startBot().catch(handleStartError);
