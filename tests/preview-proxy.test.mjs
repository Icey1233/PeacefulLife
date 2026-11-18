import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createPreviewProxy } from '../server/preview-proxy.mjs';

async function setup(t) {
  const calls = [];
  const remote = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, method: req.method, headers: req.headers, body });
    res.writeHead(200, {
      'Content-Type': 'application/json', 'Content-Disposition': 'attachment',
      'Set-Cookie': 'session=test; HttpOnly; Secure; SameSite=Strict; Path=/api',
      'Content-Security-Policy': "default-src 'self'"
    });
    res.end('{"ok":true}');
  });
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
  const proxy = createPreviewProxy({
    upstream: 'https://cloud.example', origin: 'http://localhost:5175',
    transport(url, options, callback) {
      assert.equal(url.origin, 'https://cloud.example');
      return request(`http://127.0.0.1:${remote.address().port}${url.pathname}`, options, callback);
    }
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => { await Promise.all([proxy, remote].map(server => new Promise(resolve => server.close(resolve)))); });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  return { calls, send: (path, options = {}) => new Promise((resolve, reject) => {
    const outgoing = request(base + path, { ...options, headers: { host: 'localhost:5175', ...options.headers } }, incoming => {
      let body = ''; incoming.on('data', chunk => { body += chunk; });
      incoming.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        resolve({ status: incoming.statusCode, headers, json: async () => JSON.parse(body) });
      });
    });
    outgoing.on('error', reject); outgoing.end(options.body);
  }) };
}

test('cloud preview forwards account requests to the fixed backend and preserves protected cookies', async t => {
  const { calls, send } = await setup(t);
  const result = await send('/api/auth/login', {
    method: 'POST', body: '{"username":"alice"}',
    headers: { origin: 'http://localhost:5175', cookie: 'session=old', 'content-type': 'application/json' }
  });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { ok: true });
  assert.equal(result.headers.has('content-disposition'), false);
  assert.match(result.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(result.headers.get('content-security-policy'), "default-src 'self'");
  assert.equal(calls.length, 1); assert.equal(calls[0].headers.origin, 'https://cloud.example');
  assert.equal(calls[0].headers.cookie, 'session=old');
  assert.equal(calls[0].body, '{"username":"alice"}');
});

test('cloud preview rejects foreign sites, DNS rebinding, arbitrary paths and oversized bodies before forwarding', async t => {
  const { calls, send } = await setup(t);
  assert.equal((await send('/api/auth/register', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await send('/api/auth/register', { method: 'POST' })).status, 403);
  assert.equal((await send('/api/health', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await send('/api/auth/session', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  for (const path of ['/.env', '/server/app.mjs', '/api/save?target=https://evil.example', '/anything']) assert.equal((await send(path)).status, 404);
  assert.equal((await send('/api/save', { method: 'PUT', headers: { origin: 'http://localhost:5175' }, body: 'a'.repeat(32769) })).status, 413);
  assert.equal(calls.length, 0);
});
