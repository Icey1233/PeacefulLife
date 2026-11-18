import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';
import { LocalStore, OssStore, configuredStore } from '../server/storage.mjs';

const origin = 'http://peaceful.test';
const root = fileURLToPath(new URL('../', import.meta.url));
const password = 'only-a-test-password';
async function setup(t, { configured = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'peaceful-life-test-'));
  const store = configured ? new LocalStore(directory) : null;
  const app = createApp({ store, root, origin });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  function client() {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async request(path, { method = 'GET', data, headers = {}, raw, useCookie = cookie } = {}) {
        const response = await fetch(base + path, { method, headers: { Origin: origin, ...(useCookie ? { Cookie: useCookie } : {}), ...(data !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw ?? (data !== undefined ? JSON.stringify(data) : undefined) });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const text = await response.text();
        return { status: response.status, headers: response.headers, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
      },
      register(username, initialState) { return this.request('/api/auth/register', { method: 'POST', data: { username, password, ...(initialState ? { initialState } : {}) } }); }
    };
  }
  return { directory, store, client };
}

test('unconfigured server keeps guest play and denies credentials/data/source paths', async t => {
  const { client } = await setup(t, { configured: false }); const guest = client();
  assert.equal((await guest.request('/')).status, 200);
  assert.equal((await guest.request('/api/health')).data.accountsAvailable, false);
  assert.equal((await guest.register('alice')).status, 503);
  for (const path of ['/.env', '/.env.example', '/server/app.mjs', '/UserData/alice/user.json', '/.local-data/UserData/alice/user.json', '/package-lock.json', '/node_modules/ali-oss/package.json', '/%2eenv']) assert.equal((await guest.request(path)).status, 404, path);
});

test('registration creates a private per-account record, hashes the password, and restores a session', async t => {
  const { client, directory } = await setup(t); const alice = client();
  const result = await alice.register('  ALICE_1  ');
  assert.equal(result.status, 201); assert.equal(result.data.user.username, 'alice_1');
  assert.equal(result.data.storage, 'local'); assert.equal(result.data.save.revision, 1);
  assert.match(result.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/api/);
  assert.equal(JSON.stringify(result.data).includes('scrypt'), false);
  const recordText = await readFile(join(directory, 'UserData/alice_1/user.json'), 'utf8');
  const record = JSON.parse(recordText);
  assert.equal(record.password.algorithm, 'scrypt-v1'); assert.equal(record.password.hash.length, 128);
  assert.equal(recordText.includes(password), false);
  const sessions = await readdir(join(directory, 'UserData/alice_1/sessions'));
  assert.equal(sessions.length, 1); assert.equal(sessions[0].length, 69);
  assert.equal((await alice.request('/api/auth/session')).data.user.username, 'alice_1');
});

test('simultaneous registrations cannot overwrite the winning account', async t => {
  const { client } = await setup(t); const a = client(), b = client();
  const results = await Promise.all([a.register('same_name'), b.register('SAME_NAME')]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const login = await client().request('/api/auth/login', { method: 'POST', data: { username: 'SAME_NAME', password } });
  assert.equal(login.status, 200);
});

test('login rejects unknown users and wrong passwords without returning credential details', async t => {
  const { client } = await setup(t); const a = client(); await a.register('alice');
  const wrong = await client().request('/api/auth/login', { method: 'POST', data: { username: 'alice', password: 'incorrect-password' } });
  const unknown = await client().request('/api/auth/login', { method: 'POST', data: { username: 'nobody', password } });
  assert.equal(wrong.status, 401); assert.deepEqual(wrong.data, unknown.data);
  const correct = await client().request('/api/auth/login', { method: 'POST', data: { username: 'alice', password } });
  assert.equal(correct.status, 200); assert.equal('password' in correct.data.user, false);
});

test('save API isolates accounts and serializes concurrent updates with revision conflicts', async t => {
  const { client } = await setup(t); const alice = client(), bob = client();
  const a = await alice.register('alice'), b = await bob.register('bob');
  const state = { ...a.data.save.state, energy: 19, joy: 12 };
  const results = await Promise.all([1, 2].map(() => alice.request('/api/save', { method: 'PUT', data: { state, revision: 1, username: 'bob' } })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const savedAlice = await alice.request('/api/save?username=bob');
  const savedBob = await bob.request('/api/save');
  assert.equal(savedAlice.data.state.energy, 19); assert.equal(savedAlice.data.revision, 2);
  assert.deepEqual(savedBob.data.state, b.data.save.state); assert.equal(savedBob.data.revision, 1);
  assert.equal((await client().request('/api/save')).status, 401);
  assert.equal((await alice.request('/api/save/bob')).status, 404);
});

test('logout revokes the session, including replay of a previously captured cookie', async t => {
  const { client } = await setup(t); const a = client(); await a.register('alice'); const oldCookie = a.cookie;
  assert.equal((await a.request('/api/auth/logout', { method: 'POST', data: {} })).status, 200);
  assert.equal((await a.request('/api/save', { useCookie: oldCookie })).status, 401);
  assert.equal((await a.request('/api/auth/session')).data.user, null);
});

test('rejects cross-origin writes, invalid paths, malformed saves, and oversized input', async t => {
  const { client } = await setup(t); const a = client(); const registered = await a.register('alice');
  assert.equal((await a.request('/api/save', { method: 'PUT', data: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await a.request('/api/auth/login', { method: 'POST', data: {}, headers: { Origin: '' } })).status, 403);
  assert.equal((await a.request('/api/auth/register', { method: 'POST', data: { username: '../alice', password } })).status, 400);
  for (const changed of [{ energy: 999 }, { activity: 'unknown' }, { joy: 1.5 }, { progress: 99 }, { customTime: -1 }, { startedAt: Date.now() + 86400000 }]) {
    assert.equal((await a.request('/api/save', { method: 'PUT', data: { state: { ...registered.data.save.state, ...changed }, revision: 1 } })).status, 400);
  }
  assert.equal((await a.request('/api/auth/login', { method: 'POST', raw: '{broken' })).status, 400);
  assert.equal((await a.request('/api/auth/login', { method: 'POST', raw: 'x'.repeat(13000) })).status, 413);
  assert.equal((await a.request('/api/auth/login', { method: 'POST', data: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
});

test('repeated login attempts are rate limited', async t => {
  const { client } = await setup(t); const a = client();
  let result;
  for (let i = 0; i < 31; i++) result = await a.request('/api/auth/login', { method: 'POST', data: { username: '!', password } });
  assert.equal(result.status, 429);
});

test('OSS writes use private ACL and overwrite prevention; storage errors never become local success', async () => {
  const calls = [];
  const store = new OssStore({
    async put(...args) { calls.push(args); },
    async get(key) { if (key === 'missing') throw Object.assign(new Error(), { code: 'NoSuchKey' }); throw Object.assign(new Error(), { code: 'AccessDenied' }); }
  });
  await store.write('UserData/alice/user.json', { username: 'alice' }, { createOnly: true });
  const headers = calls[0][2].headers;
  assert.equal(headers['x-oss-object-acl'], 'private'); assert.equal(headers['x-oss-forbid-overwrite'], 'true');
  assert.equal(headers['Cache-Control'], 'no-store'); assert.equal('If-Match' in headers, false);
  assert.equal(await store.read('missing'), null);
  await assert.rejects(store.read('denied'), { code: 'AccessDenied' });
  assert.equal(configuredStore({}, root), null);
  assert.throws(() => configuredStore({ NODE_ENV: 'production' }, root, true), /Production cannot/);
  assert.throws(() => createApp({ store, root, origin, production: true }), /HTTPS/);
});
