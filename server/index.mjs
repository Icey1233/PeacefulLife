import { fileURLToPath } from 'node:url';
import { configuredStore } from './storage.mjs';
import { createApp } from './app.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 5174);
const host = process.env.HOST || '127.0.0.1';
const origin = process.env.APP_ORIGIN || `http://127.0.0.1:${port}`;
const production = process.env.NODE_ENV === 'production';
const store = configuredStore(process.env, root, process.argv.includes('--local'));
if (production && !store) throw new Error('OSS credentials and OSS_REGION must be configured in production.');
const app = createApp({ store, root, origin, production, bridgeSecret: process.env.FC_BRIDGE_SECRET || '', logError: error => console.error('Storage request failed:', error) });
app.requestTimeout = 20000;
app.headersTimeout = 10000;
app.listen(port, host, () => {
  console.log(`Peaceful Life: ${origin}`);
  console.log(`Account storage: ${store?.kind === 'local' ? 'LOCAL DEVELOPMENT ONLY — not Alibaba Cloud' : store ? 'OSS / ' + (process.env.OSS_BUCKET || 'peaceful-life-data') + ' / UserData/' : 'not configured (guest play available)'}`);
});
