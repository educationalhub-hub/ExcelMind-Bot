import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import {
  botState,
  addLog,
  updateGroups,
  updateConnection,
  updateSettings,
  setBotNumber,
} from './botState.js';

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return null;
  }
}

function isBotAdmin(groupMetadata, botJid) {
  if (!groupMetadata?.participants || !botJid) return false;
  const botId = botJid.split(':')[0];
  const member = groupMetadata.participants.find(
    (p) => p.id?.split(':')[0] === botId
  );
  return member?.admin === 'admin' || member?.admin === 'superadmin';
}

export function createDashboardServer() {
  let sock = null;
  let qrRevision = 0;

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');

    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    const method = request.method;

    // Dashboard page
    if (method === 'GET' && path === '/') {
      try {
        const page = await readFile(new URL('./dashboard.html', import.meta.url));
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(page);
      } catch (error) {
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

    // API: status
    if (method === 'GET' && path === '/api/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          connection: botState.connection,
          qr: botState.qr,
          botNumber: botState.botNumber,
        })
      );
      return;
    }

    // API: groups
    if (method === 'GET' && path === '/api/groups') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(botState.groups));
      return;
    }

    // API: refresh groups
    if (method === 'POST' && path === '/api/groups/refresh') {
      if (botState.connection !== 'connected') {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Bot not connected' }));
        return;
      }
      try {
        await refreshGroupsInternal();
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(botState.groups));
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // API: logs
    if (method === 'GET' && path === '/api/logs') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(botState.logs));
      return;
    }

    // API: settings
    if (method === 'GET' && path === '/api/settings') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(botState.settings));
      return;
    }

    // API: update settings
    if (method === 'POST' && path === '/api/settings') {
      const body = await readBody(request);
      if (!body) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      updateSettings(body);
      addLog('settings_update', { details: 'Dashboard settings updated' });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(botState.settings));
      return;
    }

    // API: send instruction
    if (method === 'POST' && path === '/api/instruction') {
      if (botState.connection !== 'connected' || !sock) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Bot not connected' }));
        return;
      }
      const body = await readBody(request);
      if (!body?.message) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Message is required' }));
        return;
      }
      try {
        if (body.groupJid === 'all') {
          const adminGroups = botState.groups.filter((g) => g.isAdmin);
          for (const group of adminGroups) {
            await sock.sendMessage(group.jid, { text: body.message });
          }
          addLog('instruction_broadcast', {
            group: `All admin groups (${adminGroups.length})`,
            content: body.message.slice(0, 100),
          });
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ sent: adminGroups.length }));
        } else {
          await sock.sendMessage(body.groupJid, { text: body.message });
          const groupName =
            botState.groups.find((g) => g.jid === body.groupJid)?.name ||
            body.groupJid;
          addLog('instruction_sent', {
            group: groupName,
            content: body.message.slice(0, 100),
          });
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ sent: 1 }));
        }
      } catch (error) {
        addLog('instruction_error', { error: error.message });
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
  });

  async function refreshGroupsInternal() {
    if (!sock || botState.connection !== 'connected') return;
    const result = await sock.groupFetchAllParticipating();
    const groups = Object.values(result);
    const groupList = groups.map((g) => ({
      jid: g.id,
      name: g.subject || 'Unnamed',
      participants: g.participants?.length || 0,
      isAdmin: isBotAdmin(g, sock.user?.id),
    }));
    updateGroups(groupList);
    addLog('groups_refreshed', { details: `${groupList.length} groups found` });
  }

  function setSocket(socket) {
    sock = socket;
    if (sock?.user?.id) setBotNumber(sock.user.id);
  }

  async function updateStatus(status, qr = null) {
    const currentRevision = ++qrRevision;
    updateConnection(status, null);
    if (!qr) return;
    const image = await QRCode.toDataURL(qr, {
      width: 320,
      margin: 4,
      errorCorrectionLevel: 'M',
    });
    if (qrRevision === currentRevision) {
      updateConnection(status, image);
    }
  }

  return { server, setSocket, updateStatus, refreshGroups: refreshGroupsInternal };
}
