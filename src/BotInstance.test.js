import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotInstance } from './BotInstance.js';
import { isAdmin } from './antiLink.js';
import { pool } from './db.js';

function setup(t, participants = [{ id: '100@s.whatsapp.net', admin: 'admin' }]) {
  const bot = new BotInstance({
    id: 'test-bot', userId: 1, number: '100', active: true,
    authDir: '/tmp/omnimod-test-unused',
    capabilities: { antiLink: true, moderation: false },
  });
  const sent = [];
  const socket = {
    user: { id: '100:4@s.whatsapp.net', lid: '900:4@lid' },
    groupMetadata: async () => ({ subject: 'Test group', participants }),
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
