import 'dotenv/config';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import P from 'pino';
import { createPairingServer } from './pairingServer.js';
import {
  containsLink,
  resetLinkRegex,
  isAdmin,
} from './antiLink.js';

const { server, updatePairing } = createPairingServer();
server.on('error', (error) => {
  console.error('❌ QR pairing server failed:', error.message);
  process.exit(1);
});
server.listen(3000, '0.0.0.0', () => {
  console.log('📱 WhatsApp QR pairing page is ready on port 3000.');
});

function handleStartError(error) {
  console.error('❌ ExcelMind-Bot failed to start:', error);
  updatePairing('error');
}

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (connection === 'connecting' || isNewLogin) {
      await updatePairing('connecting');
    }

    if (qr) {
      try {
        await updatePairing('scan', qr);
        console.log('📱 Fresh WhatsApp QR code available in the preview.');
      } catch (error) {
        console.error('❌ QR generation failed:', error.message);
        await updatePairing('error');
      }
    }

    if (connection === 'open') {
      await updatePairing('connected');
      console.log('✅ ExcelMind-Bot connected to WhatsApp!');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      await updatePairing(shouldReconnect ? 'reconnecting' : 'logged_out');
      console.log(`❌ WhatsApp connection closed. (code: ${statusCode})`);

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

startBot().catch(handleStartError);
