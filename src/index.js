import 'dotenv/config';

// Suppress harmless libsignal "Bad MAC" / "Failed to decrypt" noise from stale sessions.
const SUPPRESS_PATTERNS = ['Bad MAC', 'Failed to decrypt message with any known session'];
const _origError = console.error;
console.error = (...args) => {
  if (!SUPPRESS_PATTERNS.some((p) => args.map(String).join(' ').includes(p))) {
    _origError.apply(console, args);
  }
};
const _origStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  if (typeof chunk === 'string' && SUPPRESS_PATTERNS.some((p) => chunk.includes(p))) return true;
  return _origStderr(chunk, ...rest);
};

import { BotManager } from './botManager.js';
import { createDashboardServer } from './dashboardServer.js';

const botManager = new BotManager();
const { server } = createDashboardServer(botManager);

server.on('error', (error) => {
  console.error('❌ Dashboard server failed:', error.message);
  process.exit(1);
});

server.listen(3000, '0.0.0.0', async () => {
  console.log('📊 ExcelMind-Bot dashboard is ready on port 3000.');
  await botManager.init();
  console.log(`🤖 ${botManager.bots.size} bot(s) initialized.`);
});
