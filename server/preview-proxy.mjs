import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';

// A loopback-only test entrance. All account operations still run in the FC backend.
const assets = new Set(['/', '/index.html', '/style.css', '/game.js', '/account.js']);
const api = new Map([
  ['/api/health', ['GET']], ['/api/auth/session', ['GET']],
  ['/api/auth/register', ['POST']], ['/api/auth/login', ['POST']],
  ['/api/auth/logout', ['POST']], ['/api/save', ['GET', 'PUT']]
]);
export function createPreviewProxy({ upstream, origin, transport = httpsRequest }) {
  const target = new URL(upstream);
  const local = new URL(origin);
  if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Preview upstream must be an HTTPS origin.');
  if (local.protocol !== 'http:' || local.hostname !== 'localhost') throw new Error('Preview requires http://localhost.');
  const fail = (response, status, message) => {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(message);
  };
  return createServer(async (request, response) => {
    if (request.headers.host !== local.host) return fail(response, 403, '请从本机预览网址访问。');
    const path = request.url;
    if (!(assets.has(path) && ['GET', 'HEAD'].includes(request.method)) && !api.get(path)?.includes(request.method)) return fail(response, 404, '没有找到这个页面。');
    if (api.has(path) && request.headers['sec-fetch-site'] === 'cross-site') return fail(response, 403, '不允许其他网站访问本机预览。');
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== local.origin) return fail(response, 403, '请从本机游戏页面发起操作。');
    try {
      const chunks = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 32768) return fail(response, 413, '请求内容过大。');
        chunks.push(chunk);
      }
      const headers = { accept: request.headers.accept || '*/*' };
      for (const name of ['cookie', 'content-type']) if (request.headers[name]) headers[name] = request.headers[name];
      if (!['GET', 'HEAD'].includes(request.method)) {
        headers.origin = target.origin;
        headers['sec-fetch-site'] = 'same-origin';
      }
      const remote = transport(new URL(path, target), { method: request.method, headers }, incoming => {
        // FC's public test domain forces downloads. Only remove that header locally.
        const outgoing = {};
        for (const name of ['content-type', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options', 'set-cookie']) {
          if (incoming.headers[name]) outgoing[name] = incoming.headers[name];
        }
        outgoing['cache-control'] = 'no-store';
        response.writeHead(incoming.statusCode, outgoing);
        incoming.on('error', () => response.destroy());
        incoming.pipe(response);
      });
      remote.setTimeout(25000, () => remote.destroy(new Error('Upstream timeout')));
      remote.on('error', () => {
        if (response.headersSent) response.destroy();
        else fail(response, 502, '暂时无法连接云端，请稍后重试。');
      });
      response.on('close', () => { if (!response.writableFinished) remote.destroy(); });
      remote.end(Buffer.concat(chunks));
    } catch {
      if (!response.headersSent) fail(response, 400, '请求未完成。');
      else response.destroy();
    }
  });
}
