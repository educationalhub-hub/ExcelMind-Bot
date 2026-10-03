import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPairingServer } from './pairingServer.js';

async function setup(t) {
  const pairing = createPairingServer();
  pairing.server.listen(0, '127.0.0.1');
  await once(pairing.server, 'listening');
  t.after(() => new Promise(resolve => pairing.server.close(resolve)));
  return {
    ...pairing,
    url: `http://127.0.0.1:${pairing.server.address().port}`,
  };
}

test('serves a no-cache pairing page and waiting status', async t => {
  const { url } = await setup(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Connect with a QR scan/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const response = await fetch(`${url}/api/pairing`);
  assert.deepEqual(await response.json(), { status: 'waiting', qr: null });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${url}/auth_info/creds.json`)).status, 404);
});

test('publishes fresh QR images and clears them after pairing or disconnect', async t => {
  const { url, updatePairing } = await setup(t);
  await updatePairing('scan', 'test-qr-first');
  const first = await (await fetch(`${url}/api/pairing`)).json();
  assert.equal(first.status, 'scan');
  assert.match(first.qr, /^data:image\/png;base64,/);

  await updatePairing('scan', 'test-qr-refreshed');
  const refreshed = await (await fetch(`${url}/api/pairing`)).json();
  assert.notEqual(refreshed.qr, first.qr);

  await updatePairing('connected');
  assert.deepEqual(await (await fetch(`${url}/api/pairing`)).json(), {
    status: 'connected', qr: null,
  });

  await updatePairing('scan', 'test-qr-reconnect');
  await updatePairing('reconnecting');
  assert.deepEqual(await (await fetch(`${url}/api/pairing`)).json(), {
    status: 'reconnecting', qr: null,
  });
});

test('does not restore a stale QR when disconnect happens during generation', async t => {
  const { url, updatePairing } = await setup(t);
  const generation = updatePairing('scan', 'test-qr-stale');
  await updatePairing('reconnecting');
  await generation;
  assert.deepEqual(await (await fetch(`${url}/api/pairing`)).json(), {
    status: 'reconnecting', qr: null,
  });
});
