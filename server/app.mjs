import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { handleBridge } from './fc-bridge.mjs';

const scrypt = promisify(scryptCallback);
const SESSION_DURATION = 7 * 86400000;
const COOKIE_NAME = 'peaceful_session';
const USERNAME = /^[a-z0-9_]{3,24}$/;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ...['index.html', 'style.css', 'game.js', 'account.js'].map(file => ['/' + file, [file, file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8']])
]);
class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const reject = (status, code, message) => { throw new HttpError(status, code, message); };
const userKey = username => `UserData/${username}/user.json`;
const sessionKey = (username, token) => `UserData/${username}/sessions/${createHash('sha256').update(token).digest('hex')}.json`;
const publicUser = user => ({ username: user.username, createdAt: user.createdAt });
const publicSave = user => ({ state: user.save.state, revision: user.save.revision, updatedAt: user.save.updatedAt });

export function validateState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject(400, 'INVALID_SAVE', '存档格式不正确。');
  const result = {};
  for (const [field, min, max] of [
    ['energy', 0, 100], ['focus', 0, 100], ['mood', 0, 100], ['joy', 0, Number.MAX_SAFE_INTEGER],
    ['customTime', Date.UTC(2000, 0, 1) - 28800000, Date.UTC(2099, 11, 31, 15, 59, 59)],
    ['startedAt', 0, Date.now() + 60000]
  ]) {
    if (!Number.isFinite(input[field]) || input[field] < min || input[field] > max) reject(400, 'INVALID_SAVE', '存档中的数值不正确。');
    result[field] = input[field];
  }
  if (!Number.isSafeInteger(result.joy)) reject(400, 'INVALID_SAVE', '小确幸数量不正确。');
  if (!['sleep', 'study', 'play'].includes(input.activity) || !['live', 'custom'].includes(input.mode) || ![1, 60, 360].includes(input.speed) || typeof input.paused !== 'boolean') reject(400, 'INVALID_SAVE', '存档中的活动或时间设置不正确。');
  const duration = input.activity === 'study' ? 45 : 30;
  if (!Number.isFinite(input.progress) || input.progress < 0 || input.progress >= duration) reject(400, 'INVALID_SAVE', '活动进度不正确。');
  return { ...result, activity: input.activity, paused: input.paused, progress: input.progress, mode: input.mode, speed: input.speed, flowing: false };
}
function initialState() {
  return { activity: 'study', paused: false, progress: 0, energy: 72, focus: 48, mood: 84, joy: 0, mode: 'live', customTime: Date.now(), flowing: false, speed: 60, startedAt: Date.now() };
}
async function body(request) {
  if (!(request.headers['content-type'] || '').startsWith('application/json')) reject(415, 'JSON_REQUIRED', '请使用 JSON 请求。');
  const chunks = []; let size = 0;
  await new Promise((resolve, fail) => {
    let oversized = false;
    request.on('data', chunk => {
      if (oversized) return;
      size += chunk.length;
      if (size > 12288) { oversized = true; fail(new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大。')); }
      else chunks.push(chunk);
    });
    request.once('end', resolve);
    request.once('error', fail);
    request.once('aborted', () => fail(new HttpError(400, 'REQUEST_ABORTED', '请求未完成。')));
  });
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { reject(400, 'INVALID_JSON', '请求内容不正确。'); }
}

export function createApp({ store, root, origin, production = false, bridgeSecret = '', logError = () => {} }) {
  const appOrigin = new URL(origin).origin;
  if (production && !appOrigin.startsWith('https://')) throw new Error('Production APP_ORIGIN must use HTTPS.');
  // The per-user queue protects read/modify/write and revision checks in ONE Node process.
  // OSS PutObject does not support If-Match. Multiple processes need a shared lock/database.
  const locks = new Map(), limits = new Map();
  let activePasswords = 0;
  async function locked(username, work) {
    const previous = locks.get(username) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    locks.set(username, current);
    await previous;
    try { return await work(); }
    finally { release(); if (locks.get(username) === current) locks.delete(username); }
  }
  function rateLimit(key, max, duration = 15 * 60000) {
    const now = Date.now();
    if (limits.size > 10000) {
      for (const [entry, limit] of limits) if (limit.until <= now) limits.delete(entry);
      if (limits.size > 10000) reject(429, 'BUSY', '现在访问人数较多，请稍后再试。');
    }
    const record = limits.get(key);
    if (!record || record.until <= now) limits.set(key, { count: 1, until: now + duration });
    else if (++record.count > max) reject(429, 'RATE_LIMITED', '尝试次数较多，请稍后再试。');
  }
  async function derive(password, salt) {
    if (activePasswords >= 4) reject(429, 'BUSY', '现在访问人数较多，请稍后再试。');
    activePasswords++;
    try { return await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
    finally { activePasswords--; }
  }
  function cookie(response, value, clear = false) {
    response.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${clear ? 0 : SESSION_DURATION / 1000}${production || appOrigin.startsWith('https://') ? '; Secure' : ''}`);
  }
  function parseSession(request) {
    const value = (request.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(COOKIE_NAME + '='))?.slice(COOKIE_NAME.length + 1);
    if (!value) return null;
    const [username, token, extra] = value.split('.');
    return USERNAME.test(username) && /^[A-Za-z0-9_-]{43}$/.test(token || '') && !extra ? { username, token } : null;
  }
  async function session(request, optional = false) {
    const parsed = parseSession(request);
    if (parsed) {
      const record = await store.read(sessionKey(parsed.username, parsed.token));
      if (record && record.username === parsed.username && record.expiresAt > Date.now()) return parsed;
    }
    if (!optional) reject(401, 'UNAUTHENTICATED', '登录已过期，请重新登录。');
    return null;
  }
  async function newSession(request, response, username) {
    const token = randomBytes(32).toString('base64url');
    await store.write(sessionKey(username, token), { username, expiresAt: Date.now() + SESSION_DURATION }, { createOnly: true });
    const old = parseSession(request);
    if (old) await store.delete(sessionKey(old.username, old.token));
    cookie(response, `${username}.${token}`);
  }
  function json(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  }
  const handler = async (request, response) => {
    if (request.url === '/invoke' && request.method === 'POST') {
      await handleBridge(request, response, { secret: bridgeSecret, origin: appOrigin, handler }); return;
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, appOrigin);
      const path = url.pathname;
      if (!path.startsWith('/api/')) {
        const asset = STATIC_FILES.get(path);
        if (!asset || !['GET', 'HEAD'].includes(request.method)) reject(404, 'NOT_FOUND', '没有找到这个页面。');
        const content = await readFile(resolve(root, asset[0]));
        response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
        response.end(request.method === 'HEAD' ? undefined : content); return;
      }
      const ip = request.socket.remoteAddress || 'unknown'; // Do not trust arbitrary X-Forwarded-For.
      rateLimit(`api:${ip}`, 240, 60000);
      if (!['GET', 'HEAD'].includes(request.method)) {
        if (request.headers.origin !== appOrigin || request.headers['sec-fetch-site'] === 'cross-site') reject(403, 'INVALID_ORIGIN', '请从游戏页面发起操作。');
      }
      if (path === '/api/health' && request.method === 'GET') {
        json(response, 200, { accountsAvailable: Boolean(store), storage: store?.kind || 'unconfigured' }); return;
      }
      if (!store) reject(503, 'NOT_CONFIGURED', '云存档还未配置完成，现在可以先以访客身份游玩。');
      if (path === '/api/auth/register' && request.method === 'POST') {
        rateLimit(`register:${ip}`, 10);
        const input = await body(request);
        const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
        if (!USERNAME.test(username)) reject(400, 'INVALID_USERNAME', '账号需为 3–24 位字母、数字或下划线。');
        if (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 128) reject(400, 'INVALID_PASSWORD', '密码需为 10–128 个字符。');
        const state = input.initialState ? validateState(input.initialState) : initialState();
        const user = await locked(username, async () => {
          if (await store.read(userKey(username))) reject(409, 'USERNAME_TAKEN', '这个账号已经有人用了，换一个吧。');
          const salt = randomBytes(32).toString('hex');
          const hash = (await derive(input.password, salt)).toString('hex');
          const createdAt = new Date().toISOString();
          const record = { username, createdAt, password: { algorithm: 'scrypt-v1', salt, hash }, save: { state, revision: 1, updatedAt: createdAt } };
          try { await store.write(userKey(username), record, { createOnly: true }); }
          catch (error) { if (error.code === 'ALREADY_EXISTS') reject(409, 'USERNAME_TAKEN', '这个账号已经有人用了，换一个吧。'); throw error; }
          return record;
        });
        // The account remains usable via login if session creation temporarily fails.
        await newSession(request, response, username);
        json(response, 201, { user: publicUser(user), save: publicSave(user), storage: store.kind }); return;
      }
      if (path === '/api/auth/login' && request.method === 'POST') {
        rateLimit(`login:${ip}`, 30);
        const input = await body(request);
        const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
        if (!USERNAME.test(username) || typeof input.password !== 'string' || input.password.length > 128) reject(401, 'INVALID_CREDENTIALS', '账号或密码不正确。');
        rateLimit(`account:${username}`, 15);
        const user = await store.read(userKey(username));
        const actual = await derive(input.password, user?.password.salt || '0000000000000000000000000000000000000000000000000000000000000000');
        const expected = user ? Buffer.from(user.password.hash, 'hex') : Buffer.alloc(64);
        if (!user || expected.length !== actual.length || !timingSafeEqual(actual, expected)) reject(401, 'INVALID_CREDENTIALS', '账号或密码不正确。');
        await newSession(request, response, username);
        json(response, 200, { user: publicUser(user), save: publicSave(user), storage: store.kind }); return;
      }
      if (path === '/api/auth/session' && request.method === 'GET') {
        const current = await session(request, true);
        if (!current) { cookie(response, '', true); json(response, 200, { user: null, storage: store.kind }); return; }
        const user = await store.read(userKey(current.username));
        if (!user) reject(401, 'UNAUTHENTICATED', '账号不存在，请重新登录。');
        json(response, 200, { user: publicUser(user), save: publicSave(user), storage: store.kind }); return;
      }
      if (path === '/api/auth/logout' && request.method === 'POST') {
        const current = parseSession(request);
        if (current) await store.delete(sessionKey(current.username, current.token));
        cookie(response, '', true); json(response, 200, { ok: true }); return;
      }
      if (path === '/api/save' && ['GET', 'PUT'].includes(request.method)) {
        const current = await session(request);
        if (request.method === 'GET') {
          const user = await store.read(userKey(current.username));
          if (!user) reject(401, 'UNAUTHENTICATED', '账号不存在，请重新登录。');
          json(response, 200, publicSave(user)); return;
        }
        const input = await body(request);
        const state = validateState(input.state);
        if (!Number.isSafeInteger(input.revision) || input.revision < 1) reject(400, 'INVALID_REVISION', '存档版本不正确。');
        const save = await locked(current.username, async () => {
          const user = await store.read(userKey(current.username));
          if (!user) reject(401, 'UNAUTHENTICATED', '账号不存在，请重新登录。');
          if (input.revision !== user.save.revision) reject(409, 'SAVE_CONFLICT', '另一处小屋已有新进度，请先选择要保留的存档。');
          user.save = { state, revision: user.save.revision + 1, updatedAt: new Date().toISOString() };
          await store.write(userKey(current.username), user);
          return user.save;
        });
        json(response, 200, { revision: save.revision, updatedAt: save.updatedAt }); return;
      }
      reject(404, 'NOT_FOUND', '没有找到这个接口。');
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof HttpError) json(response, error.status, { error: error.code, message: error.message });
      else {
        // Do not log SDK errors wholesale: they may include signed requests/credentials.
        logError({ code: String(error.code || 'INTERNAL_ERROR'), status: Number(error.status) || 500 });
        json(response, 503, { error: 'STORAGE_UNAVAILABLE', message: '存档服务暂时没有连接成功，请稍后再试。若刚注册失败，也可尝试登录。' });
      }
    }
  };
  return createServer(handler);
}
