import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotInstance } from './BotInstance.js';
import { isAdmin } from './antiLink.js';
import { pool } from './db.js';

function setup(t, participants = [{ id: '100@s.whatsapp.net', admin: 'admin' }]) {
  // Expected disconnects/deletions are asserted via state, not console output.
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const bot = new BotInstance({
    id: 'test-bot', userId: 1, number: '100', active: true,
    authDir: '/tmp/omnimod-test-unused',
    capabilities: { antiLink: true, moderation: false },
  });
  const sent = [];
  const socket = {
    user: { id: '100:4@s.whatsapp.net', lid: '900:4@lid' },
    groupMetadata: async () => ({ subject: 'Test group', participants }),
    groupFetchAllParticipating: async () => ({}),
    sendMessage: async (jid, content) => { sent.push({ jid, content }); },
    end: () => {},
  };
  bot.sock = socket;
  bot.state.connection = 'connected';
  // Do not remove real participants or leave twelve-hour timers in tests.
  bot._kickAndAutoAdd = async () => {};
  t.after(() => bot.stop());
  return { bot, socket, sent };
}

function message(id, content) {
  return {
    key: { id, remoteJid: 'test@g.us', participant: '200@s.whatsapp.net', fromMe: false },
    message: content,
  };
}

test('recognizes admin aliases without mixing phone and LID namespaces', () => {
  const metadata = { participants: [
    { id: '900@lid', jid: '100@s.whatsapp.net', lid: '900@lid', admin: 'admin' },
  ] };
  assert.equal(isAdmin('900:4@lid', metadata), true);
  assert.equal(isAdmin('100:4@s.whatsapp.net', metadata), true);
  assert.equal(isAdmin('900@s.whatsapp.net', metadata), false);
});

test('deletes a link when WhatsApp identifies the bot by LID only', async t => {
  const { bot, sent } = setup(t, [{ id: '900@lid', admin: 'admin' }]);
  await bot.handleMessages([message('lid-link', { conversation: 'https://example.com' })]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content.delete.id, 'lid-link');
});

test('unwraps disappearing messages and caption wrappers in the entire batch', async t => {
  const { bot, sent } = setup(t);
  await bot.handleMessages([
    message('normal', { conversation: 'https://example.com/one' }),
    message('ephemeral', { ephemeralMessage: { message: { conversation: 'https://example.com/two' } } }),
    message('caption', { documentWithCaptionMessage: { message: { documentMessage: { caption: 'https://example.com/three' } } } }),
  ]);
  assert.deepEqual(sent.map(entry => entry.content.delete.id), ['normal', 'ephemeral', 'caption']);
});

test('keeps group admins exempt when their message uses the LID alias', async t => {
  const { bot, sent } = setup(t, [
    { id: '100@s.whatsapp.net', admin: 'admin' },
    { id: '800@lid', jid: '200@s.whatsapp.net', lid: '800@lid', admin: 'admin' },
  ]);
  const adminMessage = message('admin-link', { conversation: 'https://example.com' });
  adminMessage.key.participant = '800@lid';
  await bot.handleMessages([adminMessage]);
  assert.equal(sent.length, 0);
});

test('preserves link exemptions and the moderation off switch', async t => {
  const { bot, sent } = setup(t);
  bot.updateSettings({ linkExemptions: ['example.com/allowed'] });
  await bot.handleMessages([message('exempt', { conversation: 'https://example.com/allowed' })]);
  bot.updateGroupSetting('test@g.us', { moderation: false });
  await bot.handleMessages([message('disabled', { conversation: 'https://example.org' })]);
  assert.equal(sent.length, 0);
});

test('ignores delayed connection events from a replaced socket', async t => {
  const { bot } = setup(t);
  await bot.handleConnectionUpdate({
    connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } },
  }, { user: { id: 'old@s.whatsapp.net' } });
  assert.equal(bot.state.connection, 'connected');
  assert.equal(bot.reconnectTimer, null);
});

test('schedules only one reconnect and records the timeout', async t => {
  const { bot, socket } = setup(t);
  const update = { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } };
  await bot.handleConnectionUpdate(update, socket);
  const timer = bot.reconnectTimer;
  t.after(() => clearTimeout(timer));
  await bot.handleConnectionUpdate(update, socket);
  assert.ok(timer);
  assert.equal(bot.reconnectTimer, timer);
  assert.equal(bot.reconnectAttempts, 1);
  assert.equal(bot.state.logs[0].action, 'bot_disconnected');
});

test('the reconnect timer starts a replacement automatically', async t => {
  const { bot, socket } = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const start = t.mock.method(bot, 'start', async () => {});
  await bot.handleConnectionUpdate({
    connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } },
  }, socket);
  t.mock.timers.tick(3000);
  assert.equal(start.mock.callCount(), 1);
  assert.equal(bot.reconnectTimer, null);
});

test('does not erase auth files after repeated transient server failures', async t => {
  const { bot, socket } = setup(t);
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-auth-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  bot.authDir = dir;
  await writeFile(join(dir, 'sentinel'), 'keep-session');
  bot.reconnectAttempts = 4;
  await bot.handleConnectionUpdate({
    connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } },
  }, socket);
  assert.equal(await readFile(join(dir, 'sentinel'), 'utf8'), 'keep-session');
});

test('failed startup schedules another attempt instead of leaving the bot stranded', async t => {
  const { bot } = setup(t);
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-start-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  bot.authDir = join(dir, 'not-a-directory');
  await writeFile(bot.authDir, 'invalid-auth-directory');
  await assert.rejects(() => bot.start());
  assert.equal(bot.state.connection, 'reconnecting');
  assert.ok(bot.reconnectTimer);
});

test('stopping a bot cannot restart it through a late disconnect', async t => {
  const { bot, socket } = setup(t);
  bot.stop();
  await bot.handleConnectionUpdate({
    connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } },
  }, socket);
  assert.equal(bot.active, false);
  assert.equal(bot.reconnectTimer, null);
});

test('buffers delivered links and abuse while reconnecting, then deletes both on open', async t => {
  const { bot, socket, sent } = setup(t);
  bot.capabilities.moderation = true;
  bot.state.connection = 'reconnecting';
  await bot.handleMessages([
    message('missed-link', { conversation: 'https://example.com' }),
    message('missed-abuse', { conversation: 'you are an idiot' }),
  ]);
  assert.equal(sent.length, 0);
  assert.equal(bot.moderationQueue.pending.size, 2);
  await bot.handleConnectionUpdate({ connection: 'open' }, socket);
  assert.deepEqual(sent.filter(entry => entry.content.delete).map(entry => entry.content.delete.id), ['missed-link', 'missed-abuse']);
  assert.equal(bot.abuseWarnings.get('test@g.us:200@s.whatsapp.net'), 1);
  assert.equal(bot.moderationQueue.pending.size, 0);
});

test('replayed abuse messages produce only one warning each', async t => {
  const { bot, sent } = setup(t);
  bot.capabilities.moderation = true;
  const abuse = message('replayed-abuse', { conversation: 'you are an idiot' });
  await Promise.all([bot.handleMessages([abuse]), bot.handleMessages([abuse])]);
  await bot.handleMessages([abuse]);
  assert.equal(sent.filter(entry => entry.content.delete).length, 1);
  assert.equal(sent.filter(entry => entry.content.text).length, 1);
  assert.equal(bot.abuseWarnings.get('test@g.us:200@s.whatsapp.net'), 1);
});

test('catch-up keeps both link and abuse messages from group admins exempt', async t => {
  const { bot, socket, sent } = setup(t, [
    { id: '100@s.whatsapp.net', admin: 'admin' },
    { id: '200@s.whatsapp.net', admin: 'admin' },
  ]);
  bot.capabilities.moderation = true;
  bot.state.connection = 'connecting';
  await bot.handleMessages([
    message('admin-link', { conversation: 'https://example.com' }),
    message('admin-abuse', { conversation: 'you are an idiot' }),
  ]);
  await bot.handleConnectionUpdate({ connection: 'open' }, socket);
  assert.equal(sent.length, 0);
  assert.equal(bot.state.logs.filter(entry => entry.action === 'link_skipped_admin').length, 1);
  assert.equal(bot.state.logs.filter(entry => entry.action === 'abuse_skipped_admin').length, 1);
});

test('catch-up rechecks the current moderation settings before deletion', async t => {
  const { bot, socket, sent } = setup(t);
  bot.state.connection = 'connecting';
  await bot.handleMessages([message('disabled-link', { conversation: 'https://example.com' })]);
  bot.updateGroupSetting('test@g.us', { moderation: false });
  await bot.handleConnectionUpdate({ connection: 'open' }, socket);
  assert.equal(sent.length, 0);
  assert.equal(bot.moderationQueue.pending.size, 0);
});

test('a disconnect during permission lookup retains the message for the replacement socket', async t => {
  const { bot, socket, sent } = setup(t);
  socket.groupMetadata = async () => {
    await bot.handleConnectionUpdate({
      connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } },
    }, socket);
    return { subject: 'Test group', participants: [{ id: '100@s.whatsapp.net', admin: 'admin' }] };
  };
  await bot.handleMessages([message('interrupted', { conversation: 'https://example.com' })]);
  assert.equal(sent.length, 0);
  assert.equal(bot.moderationQueue.pending.size, 1);
  const replacement = {
    ...socket,
    groupMetadata: async () => ({ subject: 'Test group', participants: [{ id: '100@s.whatsapp.net', admin: 'admin' }] }),
  };
  bot.sock = replacement;
  await bot.handleConnectionUpdate({ connection: 'open' }, replacement);
  assert.equal(sent[0].content.delete.id, 'interrupted');
  assert.equal(bot.moderationQueue.pending.size, 0);
});

test('history recovery only processes delivered outage messages, not the old archive', async t => {
  const { bot, socket, sent } = setup(t);
  const beforeOutage = message('old-history', { conversation: 'https://example.com/old' });
  beforeOutage.messageTimestamp = Math.floor(Date.now() / 1000) - 3600;
  const missedLink = message('history-link', { conversation: 'https://example.com/missed' });
  missedLink.messageTimestamp = Math.floor(Date.now() / 1000);
  const missedAbuse = message('history-abuse', { conversation: 'you are an idiot' });
  missedAbuse.messageTimestamp = { toString: () => String(Math.floor(Date.now() / 1000)) };
  bot.capabilities.moderation = true;
  await bot.handleHistoryMessages([missedLink]);
  assert.equal(sent.length, 0); // Initial pairing must not sweep old history.
  await bot.handleConnectionUpdate({
    connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } },
  }, socket);
  await bot.handleHistoryMessages([beforeOutage, missedLink, missedAbuse]);
  bot.sock = socket;
  await bot.handleConnectionUpdate({ connection: 'open' }, socket);
  await bot.handleMessages([missedLink, missedAbuse]); // Same payload replayed via upsert.
  assert.deepEqual(sent.filter(entry => entry.content.delete).map(entry => entry.content.delete.id), ['history-link', 'history-abuse']);
  assert.equal(bot.abuseWarnings.get('test@g.us:200@s.whatsapp.net'), 1);
});

test('deactivating discards the reconnect backlog and ignores inactive messages', async t => {
  const { bot } = setup(t);
  bot.state.connection = 'connecting';
  await bot.handleMessages([message('pending', { conversation: 'https://example.com' })]);
  await bot.deactivate();
  assert.equal(bot.moderationQueue.pending.size, 0);
  await bot.handleMessages([message('inactive', { conversation: 'https://example.com' })]);
  assert.equal(bot.moderationQueue.pending.size, 0);
});

test('catch-up preserves the three-strike abuse rule without counting replays twice', async t => {
  const { bot, socket, sent } = setup(t);
  bot.capabilities.moderation = true;
  bot.state.connection = 'connecting';
  const kick = t.mock.method(bot, '_kickAndAutoAdd', async () => {});
  const batch = [1, 2, 3].map(id => message(`abuse-${id}`, { conversation: 'you are an idiot' }));
  await bot.handleMessages([...batch, ...batch]);
  await bot.handleConnectionUpdate({ connection: 'open' }, socket);
  await bot.handleMessages(batch);
  assert.equal(sent.filter(entry => entry.content.delete).length, 3);
  assert.equal(sent.filter(entry => entry.content.text).length, 2);
  assert.equal(kick.mock.callCount(), 1);
  assert.equal(kick.mock.calls[0].arguments[3], 'repeated abusive language');
});

test('confirmed WhatsApp logout clears queued messages and the history cutoff', async t => {
  const { bot, socket } = setup(t);
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-logout-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  bot.authDir = dir;
  bot.state.connection = 'connecting';
  bot.historyRecoverySince = Math.floor(Date.now() / 1000);
  await bot.handleMessages([message('pending', { conversation: 'https://example.com' })]);
  await bot.handleConnectionUpdate({
    connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } },
  }, socket);
  assert.equal(bot.moderationQueue.pending.size, 0);
  assert.equal(bot.historyRecoverySince, null);
  assert.equal(bot.state.connection, 'logged_out');
  assert.equal(bot.reconnectTimer, null);
});

test('consecutive 408 retry waits increase from 3 seconds and cap at 80 seconds', async t => {
  const { bot } = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const start = t.mock.method(bot, 'start', async () => {});
  for (const delay of [3000, 6000, 12000, 24000, 48000, 80000, 80000]) {
    const before = start.mock.callCount();
    bot.scheduleReconnect(408);
    t.mock.timers.tick(delay - 1);
    assert.equal(start.mock.callCount(), before);
    t.mock.timers.tick(1);
    assert.equal(start.mock.callCount(), before + 1);
  }
});

test('admin and founder message credits remain unlimited', async t => {
  const { bot } = setup(t);
  for (const role of ['admin', 'founder']) {
    const mock = t.mock.method(pool, 'query', async () => ({ rows: [{
      role, plan: 'free', messages_used: 999999, custom_message_limit: 0,
    }] }));
    assert.deepEqual(await bot.checkMessageCredit(), { allowed: true, unlimited: true });
    mock.mock.restore();
  }
});
