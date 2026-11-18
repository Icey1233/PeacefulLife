import { validRoute } from './bridge-protocol.mjs';

export function createGateway({ env, invoke }) {
  return async (request, response) => {
    const json = (status, data) => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.statusCode = status; response.end(JSON.stringify(data));
    };
    try {
      const route = new URL(request.url, 'http://gateway.invalid').searchParams.get('route');
      const path = '/api/' + route;
      if (!validRoute(path, request.method)) { json(404, { error: 'NOT_FOUND', message: '没有找到这个接口。' }); return; }
      const ready = Boolean(env.APP_ORIGIN && env.FC_ACCESS_KEY_ID && env.FC_ACCESS_KEY_SECRET && env.FC_BRIDGE_SECRET?.length >= 32);
      if (!ready) {
        if (path === '/api/health') json(200, { accountsAvailable: false, storage: 'unconfigured' });
        else json(503, { error: 'NOT_CONFIGURED', message: '云存档入口还未配置完成，目前可以先以访客身份游玩。' });
        return;
      }
      const origin = new URL(env.APP_ORIGIN);
      if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN || request.headers.host !== origin.host) {
        json(403, { error: 'INVALID_HOST', message: '请从正式游戏网址访问账号服务。' }); return;
      }
      if (request.headers['sec-fetch-site'] === 'cross-site' || (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin.origin)) {
        json(403, { error: 'INVALID_ORIGIN', message: '请从游戏页面发起操作。' }); return;
      }
      let data;
      if (!['GET', 'HEAD'].includes(request.method)) {
        if (!(request.headers['content-type'] || '').startsWith('application/json')) { json(415, { error: 'JSON_REQUIRED' }); return; }
        if (request.body !== undefined) {
          data = typeof request.body === 'string' || Buffer.isBuffer(request.body) ? JSON.parse(request.body.toString()) : request.body;
        } else {
          const chunks = []; let length = 0;
          for await (const chunk of request) {
            length += chunk.length;
            if (length > 12288) { json(413, { error: 'BODY_TOO_LARGE' }); return; }
            chunks.push(chunk);
          }
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        if (!data || typeof data !== 'object' || Array.isArray(data) || Buffer.byteLength(JSON.stringify(data)) > 12288) { json(400, { error: 'INVALID_JSON' }); return; }
      }
      const cookie = request.headers.cookie || '';
      if (typeof cookie !== 'string' || cookie.length > 2048 || /[\r\n]/.test(cookie)) { json(400, { error: 'INVALID_COOKIE' }); return; }
      const result = await invoke({ version: 1, secret: env.FC_BRIDGE_SECRET, path, method: request.method, cookie, ...(data !== undefined ? { data } : {}) });
      if (result.bridgeVersion !== 1 || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 || typeof result.body !== 'string') throw new Error('Invalid bridge response');
      const payload = JSON.parse(result.body);
      const cookies = result.headers?.['set-cookie'];
      if (cookies) {
        const values = Array.isArray(cookies) ? cookies : [cookies];
        if (values.some(value => typeof value !== 'string' || !/^peaceful_session=/.test(value) || /[\r\n]/.test(value) || !value.includes('HttpOnly') || !value.includes('Secure'))) throw new Error('Invalid session response');
        response.setHeader('Set-Cookie', values);
      }
      json(result.status, payload);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else json(error instanceof SyntaxError ? 400 : 503, { error: error instanceof SyntaxError ? 'INVALID_JSON' : 'CLOUD_UNAVAILABLE', message: '云存档暂时无法连接，请稍后重试。' });
    }
  };
}
