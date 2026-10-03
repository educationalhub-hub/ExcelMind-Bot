import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return null;
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}

export function createDashboardServer(botManager) {
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');

    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    const method = request.method;

    // Dashboard page
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      try {
        const page = await readFile(new URL('./dashboard.html', import.meta.url));
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(page);
      } catch {
        response.writeHead(500);
        response.end('Dashboard unavailable');
      }
      return;
    }

    if (path === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    // --- Bot-scoped routes: /api/bots/:id/... ---
    const botMatch = path.match(/^\/api\/bots\/([^/]+)(\/.*)?$/);
    const botId = botMatch ? botMatch[1] : null;
    const subPath = botMatch ? (botMatch[2] || '') : null;

    // List all bots
    if (method === 'GET' && path === '/api/bots') {
      sendJson(response, 200, botManager.listBots());
      return;
    }

    // Add a new bot
    if (method === 'POST' && path === '/api/bots') {
      const body = await readBody(request);
      if (!body?.number) {
        sendJson(response, 400, { error: 'number is required' });
        return;
      }
      try {
        const bot = await botManager.addBot({
          number: body.number,
          displayName: body.displayName || null,
          role: body.role || 'Moderator',
        });
        sendJson(response, 200, bot.getStatusSummary());
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (!botId || !botManager.getBot(botId)) {
      sendJson(response, 404, { error: 'Bot not found' });
      return;
    }

    const bot = botManager.getBot(botId);

    // Update bot config (role, displayName, number)
    if ((method === 'PUT' || method === 'POST') && subPath === '') {
      const body = await readBody(request);
      botManager.updateBot(botId, body || {});
      sendJson(response, 200, bot.getStatusSummary());
      return;
    }

    // Remove bot
    if (method === 'DELETE' && subPath === '') {
      try {
        await botManager.removeBot(botId);
        sendJson(response, 200, { success: true });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    // --- Per-bot endpoints ---

    if (method === 'GET' && subPath === '/status') {
      sendJson(response, 200, {
        connection: bot.state.connection,
        qr: bot.state.qr,
        botNumber: bot.state.botNumber,
        displayName: bot.displayName,
        role: bot.role,
        number: bot.number,
      });
      return;
    }

    if (method === 'GET' && subPath === '/groups') {
      sendJson(response, 200, bot.state.groups);
      return;
    }

    if (method === 'POST' && subPath === '/groups/refresh') {
      if (bot.state.connection !== 'connected') {
        sendJson(response, 503, { error: 'Bot not connected' });
        return;
      }
      try {
        await bot.refreshGroups();
        sendJson(response, 200, bot.state.groups);
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (method === 'GET' && subPath === '/logs') {
      sendJson(response, 200, bot.state.logs);
      return;
    }

    if (method === 'GET' && subPath === '/settings') {
      sendJson(response, 200, bot.state.settings);
      return;
    }
    if (method === 'POST' && subPath === '/settings') {
      const body = await readBody(request);
      if (!body) { sendJson(response, 400, { error: 'Invalid JSON' }); return; }
      bot.updateSettings(body);
      bot.addLog('settings_update', { details: 'Dashboard settings updated' });
      sendJson(response, 200, bot.state.settings);
      return;
    }

    if (method === 'GET' && subPath === '/group-settings') {
      sendJson(response, 200, bot.state.groupSettings);
      return;
    }
    if (method === 'POST' && subPath === '/group-settings') {
      const body = await readBody(request);
      if (!body?.jid || typeof body.moderation !== 'boolean') {
        sendJson(response, 400, { error: 'jid and moderation (boolean) required' });
        return;
      }
      bot.updateGroupSetting(body.jid, body.moderation);
      const groupName = bot.state.groups.find((g) => g.jid === body.jid)?.name || body.jid;
      bot.addLog('group_toggled', {
        group: groupName,
        details: body.moderation ? 'Moderation enabled' : 'Moderation disabled',
      });
      sendJson(response, 200, bot.state.groupSettings);
      return;
    }

    if (method === 'POST' && subPath === '/instruction') {
      if (bot.state.connection !== 'connected' || !bot.sock) {
        sendJson(response, 503, { error: 'Bot not connected' });
        return;
      }
      const body = await readBody(request);
      if (!body?.message) {
        sendJson(response, 400, { error: 'Message is required' });
        return;
      }
      try {
        const sent = await bot.sendInstruction(body.groupJid, body.message);
        sendJson(response, 200, { sent });
      } catch (error) {
        bot.addLog('instruction_error', { error: error.message });
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (method === 'GET' && subPath === '/schedules') {
      sendJson(response, 200, bot.state.schedules);
      return;
    }
    if (method === 'POST' && subPath === '/schedules') {
      const body = await readBody(request);
      bot.updateSchedules(body || {});
      bot.addLog('schedules_updated', { details: 'Schedule settings updated' });
      sendJson(response, 200, bot.state.schedules);
      return;
    }

    if (method === 'GET' && subPath === '/rules') {
      sendJson(response, 200, { rulesMessage: bot.state.rulesMessage });
      return;
    }
    if (method === 'POST' && subPath === '/rules') {
      const body = await readBody(request);
      if (typeof body?.rulesMessage === 'string') bot.state.rulesMessage = body.rulesMessage;
      if (body?.send) {
        try {
          const sent = await bot.sendRules(body.groupJid || 'all');
          sendJson(response, 200, { sent });
          return;
        } catch (error) {
          sendJson(response, 500, { error: error.message });
          return;
        }
      }
      sendJson(response, 200, { rulesMessage: bot.state.rulesMessage });
      return;
    }

    if (method === 'POST' && subPath === '/lock') {
      const body = await readBody(request);
      if (!body?.groupJid) { sendJson(response, 400, { error: 'groupJid required' }); return; }
      try {
        await bot.lockGroup(body.groupJid);
        sendJson(response, 200, { success: true });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }
    if (method === 'POST' && subPath === '/unlock') {
      const body = await readBody(request);
      if (!body?.groupJid) { sendJson(response, 400, { error: 'groupJid required' }); return; }
      try {
        await bot.unlockGroup(body.groupJid);
        sendJson(response, 200, { success: true });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  });

  return { server };
}
