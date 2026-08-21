import 'dotenv/config';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('✅ ExcelMind-Bot connected to WhatsApp!');
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
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
    const message = messages[0];

    if (!message?.message) return;

    console.log('📩 Message received');
  });
}

startBot().catch((error) => {
  console.error('❌ ExcelMind-Bot failed to start:', error);
});
