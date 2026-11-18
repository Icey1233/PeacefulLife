import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { LocalStore } from '../server/storage.mjs';
import { createGateway } from '../server/vercel-gateway.mjs';

const secret = 'isolated-test-bridge-secret-with-at-least-32-characters';
const site = 'https://game.example';
async function setup(t, { configured = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'peaceful-bridge-'));
  const backend = createApp({ root: new URL('../', import.meta.url).pathname, store: new LocalStore(directory), production: true, origin: 'https://backend.example', bridgeSecret: secret });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const backendUrl = `http://127.0.0.1:${backend.address().port}`;
  let calls = 0;
  const gateway = createServer(createGateway({
    env: configured ? { APP_ORIGIN: site, FC_ACCESS_KEY_ID: 'fake-id', FC_ACCESS_KEY_SECRET: 'fake-secret', FC_BRIDGE_SECRET: secret } : {},
    invoke: async event => {
      calls++;
      const result = await fetch(backendUrl + '/invoke', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: JSON.stringify(event) });
      return result.json();
    }
  }));
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(async () => { await Promise.all([backend, gateway].map(server => new Promise(resolve => server.close(resolve)))); await rm(directory, { recursive: true, force: true }); });
  function send(route, { method = 'GET', data, cookie = '', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = request(`http://127.0.0.1:${gateway.address().port}/api/gateway?route=${encodeURIComponent(route)}`, {
        method, headers: { host: 'game.example', origin: site, cookie, 'content-type': 'application/json', ...headers }
      }, incoming => {
        let text = ''; incoming.on('data', chunk => { text += chunk; });
        incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, data: JSON.parse(text), text }));
      });
      outgoing.on('error', reject); outgoing.end(data === undefined ? undefined : JSON.stringify(data));
    });
  }
  return { send, directory, backendUrl, calls: () => calls };
}

test('Vercel gateway preserves registration, protected sessions, saves, conflicts, login and logout through one FC handler', async t => {
  const { send, directory } = await setup(t);
  const credentials = { username: 'vercel_alice', password: 'only-an-isolated-test' };
  const registered = await send('auth/register', { method: 'POST', data: credentials });
  assert.equal(registered.status, 201); assert.equal(registered.data.user.username, credentials.username);
  const cookie = registered.headers['set-cookie'][0].split(';')[0];
  assert.match(registered.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/api; Max-Age=\d+; Secure/);
  assert.equal(registered.text.includes(secret), false); assert.equal(registered.text.includes(credentials.password), false);
  assert.equal((await readdir(join(directory, 'UserData'))).includes(credentials.username), true);
  assert.equal((await send('auth/session', { cookie })).data.user.username, credentials.username);
  const state = { ...registered.data.save.state, activity: 'play', energy: 23 };
  const writes = await Promise.all([1, 2].map(() => send('save', { method: 'PUT', cookie, data: { state, revision: 1 } })));
  assert.deepEqual(writes.map(result => result.status).sort(), [200, 409]);
  assert.equal((await send('save', { cookie })).data.state.energy, 23);
  assert.equal((await send('auth/logout', { method: 'POST', cookie, data: {} })).status, 200);
  assert.equal((await send('save', { cookie })).status, 401);
  const login = await send('auth/login', { method: 'POST', data: credentials });
  assert.equal(login.status, 200); assert.equal(login.data.save.state.activity, 'play');
});

test('Vercel gateway rejects forged hosts, cross-site writes and unsupported routes without invoking FC', async t => {
  const { send, calls } = await setup(t);
  assert.equal((await send('auth/register', { method: 'POST', data: {}, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await send('health', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await send('auth/session', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await send('../server/storage.mjs')).status, 404);
  assert.equal(calls(), 0);
});

test('FC invocation bridge rejects missing keys and cannot dispatch file reads or recursively invoke itself', async t => {
  const { backendUrl, directory } = await setup(t);
  async function invoke(event) {
    return fetch(backendUrl + '/invoke', { method: 'POST', body: JSON.stringify(event) });
  }
  assert.equal((await invoke({ version: 1, method: 'POST', path: '/api/auth/register', cookie: '', data: { username: 'evil', password: 'test-password' } })).status, 403);
  for (const path of ['/invoke', '/.env', '/server/storage.mjs']) assert.equal((await invoke({ secret, version: 1, method: 'GET', path, cookie: '' })).status, 400);
  assert.deepEqual(await readdir(directory), []);
});

test('incomplete Vercel setup leaves guest play available and refuses account operations', async t => {
  const { send, calls } = await setup(t, { configured: false });
  assert.deepEqual((await send('health')).data, { accountsAvailable: false, storage: 'unconfigured' });
  assert.equal((await send('auth/register', { method: 'POST', data: {} })).status, 503);
  assert.equal(calls(), 0);
});
