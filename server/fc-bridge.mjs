import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { validRoute } from './bridge-protocol.mjs';

// InvokeFunction maps its payload to POST /invoke and discards response headers/status.
// An explicit envelope carries them back; the normal account handler owns all writes.
export async function handleBridge(request, response, { secret, origin, handler }) {
  const reply = (status, data) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };
  if (!secret || secret.length < 32) { reply(404, { error: 'BRIDGE_DISABLED' }); return; }
  try {
    const chunks = []; let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 20000) { reply(413, { error: 'BODY_TOO_LARGE' }); return; }
      chunks.push(chunk);
    }
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const provided = Buffer.from(typeof event.secret === 'string' ? event.secret : '');
    const expected = Buffer.from(secret);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { reply(403, { error: 'INVALID_BRIDGE_KEY' }); return; }
    if (event.version !== 1 || !validRoute(event.path, event.method) || typeof event.cookie !== 'string' || event.cookie.length > 2048 || /[\r\n]/.test(event.cookie)) { reply(400, { error: 'INVALID_BRIDGE_REQUEST' }); return; }
    const data = event.data === undefined ? '' : JSON.stringify(event.data);
    if (Buffer.byteLength(data) > 12288) { reply(413, { error: 'BODY_TOO_LARGE' }); return; }
    const forwarded = Readable.from(data ? [Buffer.from(data)] : []);
    Object.assign(forwarded, {
      url: event.path, method: event.method,
      headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie: event.cookie },
      socket: { remoteAddress: 'vercel-gateway' }
    });
    const headers = {};
    const captured = {
      headersSent: false, status: 200,
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      writeHead(status, values = {}) { this.status = status; for (const [name, value] of Object.entries(values)) this.setHeader(name, value); this.headersSent = true; },
      end(body = '') {
        const safeHeaders = {};
        for (const name of ['content-type', 'set-cookie']) if (headers[name]) safeHeaders[name] = headers[name];
        reply(200, { bridgeVersion: 1, status: this.status, headers: safeHeaders, body: String(body) });
      },
      destroy() { response.destroy(); }
    };
    await handler(forwarded, captured);
  } catch {
    if (!response.headersSent) reply(400, { error: 'INVALID_BRIDGE_REQUEST' });
    else response.destroy();
  }
}
