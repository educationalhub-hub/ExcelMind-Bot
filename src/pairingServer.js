import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';

export function createPairingServer() {
  let state = { status: 'waiting', qr: null };
  let revision = 0;

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/api/pairing') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(state));
      return;
    }

    if (path === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (path !== '/') {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    try {
      const page = await readFile(new URL('./pairing.html', import.meta.url));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page);
    } catch (error) {
      console.error('Could not load the QR pairing page:', error.message);
      response.writeHead(500);
      response.end('Pairing page unavailable');
    }
  });

  async function updatePairing(status, qr = null) {
    const currentRevision = ++revision;
    state = { status, qr: null };
    if (!qr) return;

    const image = await QRCode.toDataURL(qr, {
      width: 320,
      margin: 4,
      errorCorrectionLevel: 'M',
    });
    // A disconnect or successful scan may arrive while the image is generated.
    if (revision === currentRevision) {
      state = { status, qr: image };
    }
  }

  return { server, updatePairing };
}
