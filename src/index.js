import 'dotenv/config';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import qrcode from 'qrcode-terminal';
import {
  containsLink,
  resetLinkRegex,
  isAdmin,
} from './antiLink.js';

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
  });
if (!state.creds.registered) {
  const phoneNumber = process.env.PHONE_NUMBER;

  if (!phoneNumber) {
    throw new Error(
      'PHONE_NUMBER is missing. Check your local .env file.'
    );
  }

  const code = await sock.requestPairingCode(phoneNumber);

  console.log('📱 WhatsApp Pairing Code:');
  console.log(code);
}
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
  const { connection, lastDisconnect } = update;

  if (connection === 'open') {
    console.log('✅ ExcelMind-Bot connected to WhatsApp!');
  }
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode !==
            DisconnectReason.loggedOut
          : true;

      console.log('❌ WhatsApp connection closed.');

      if (shouldReconnect) {
        console.log('🔄 Reconnecting...');
        startBot();
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

      resetLinkRegex();

      if (!containsLink(messageText)) return;

      // Get the latest group metadata.
      const groupMetadata = await sock.groupMetadata(remoteJid);

      const senderJid =
        message.key.participant ||
        message.participant;

      // Admins and the group owner are allowed to send links.
      if (isAdmin(senderJid, groupMetadata)) {
        console.log('✅ Admin link allowed.');
        return;
      }

      // Normal member sent a link.
      await sock.sendMessage(remoteJid, {
        delete: message.key,
      });

      console.log(
        `🗑️ Deleted link message from ${senderJid || 'unknown user'}`
      );

    } catch (error) {
      console.error('❌ Anti-link error:', error);
    }
  });
}

startBot().catch((error) => {
  console.error(
    '❌ ExcelMind-Bot failed to start:',
    error
  );
});
