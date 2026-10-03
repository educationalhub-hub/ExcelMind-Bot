import 'dotenv/config';

// Suppress harmless libsignal "Bad MAC" / "Failed to decrypt" noise from stale sessions.
const SUPPRESS_PATTERNS = [
  'Bad MAC',
  'Failed to decrypt message with any known session',
  'Closing session: SessionEntry',
];
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

// Prevent Baileys "Connection Closed" rejections from crashing the process.
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (msg === 'Connection Closed' || reason?.output?.statusCode === 428) return;
  console.error('Unhandled rejection:', msg);
});

import { BotManager } from './botManager.js';
import { createApp } from './dashboardServer.js';
import { migrate } from './db.js';

async function main() {
  // Run database migrations first
  await migrate();

  const botManager = new BotManager();
  await botManager.init();

  const app = createApp(botManager);

  const server = app.listen(3000, '0.0.0.0', () => {
    console.log('📊 ExcelMind-Bot SaaS platform is ready on port 3000.');
  });

  server.on('error', (error) => {
    console.error('❌ Server failed:', error.message);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('❌ Failed to start:', err);
  process.exit(1);
});
