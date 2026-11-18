import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../account.js', import.meta.url), 'utf8');
const baseState = { activity: 'study', paused: true, progress: 4, energy: 71, focus: 52, mood: 85, joy: 2, mode: 'live', customTime: 1700000000000, flowing: false, speed: 60, startedAt: 1690000000000 };
async function restore({ cachedState, attemptedState, serverState }) {
  const nodes = new Map(), storage = new Map(), puts = [];
  storage.set('mellow-cloud-alice', JSON.stringify({ baseRevision: 1, dirty: true, state: cachedState, attempts: [{ baseRevision: 1, state: attemptedState }] }));
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, open: false, value: '', classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, focus() {}, showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  let gameState = { ...baseState };
  const game = { snapshot: () => ({ ...gameState }), suspend() {}, replace(state) { gameState = { ...state }; }, restoreGuest() {}, toast() {} };
  const context = vm.createContext({
    document: { getElementById: element, addEventListener() {}, hidden: false },
    window: { MellowGame: game, addEventListener() {} },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    location: { protocol: 'http:' }, AbortController, setTimeout, clearTimeout, setInterval() {},
    async fetch(path, options) {
      let data;
      if (path === '/api/health') data = { accountsAvailable: true, storage: 'oss' };
      else if (path === '/api/auth/session') data = { user: { username: 'alice' }, storage: 'oss', save: { state: serverState, revision: 2, updatedAt: '2026-11-17T06:00:00Z' } };
      else if (path === '/api/save' && options.method === 'PUT') { puts.push(JSON.parse(options.body)); data = { revision: 3, updatedAt: '2026-11-17T06:01:00Z' }; }
      else throw new Error('Unexpected API: ' + path);
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => data };
    }
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, storage, puts, state: gameState };
}

test('reload recognizes a save completed during page exit without a false conflict', async () => {
  const result = await restore({ cachedState: baseState, attemptedState: baseState, serverState: baseState });
  assert.equal(result.nodes.get('account-dialog').open, false);
  assert.equal(result.nodes.get('save-conflict').hidden, true);
  assert.equal(result.puts.length, 0);
  assert.equal(JSON.parse(result.storage.get('mellow-cloud-alice')).dirty, false);
});

test('reload preserves newer pending progress after acknowledging the last completed save', async () => {
  const pending = { ...baseState, energy: 75, joy: 3 };
  const result = await restore({ cachedState: pending, attemptedState: baseState, serverState: baseState });
  assert.equal(result.nodes.get('account-dialog').open, false);
  assert.equal(result.puts.length, 1);
  assert.equal(result.puts[0].revision, 2);
  assert.deepEqual(result.puts[0].state, pending);
  assert.equal(JSON.parse(result.storage.get('mellow-cloud-alice')).baseRevision, 3);
});

test('a genuinely different remote save requires a choice and is never overwritten automatically', async () => {
  const pending = { ...baseState, energy: 75 };
  const remote = { ...baseState, energy: 15, activity: 'sleep' };
  const result = await restore({ cachedState: pending, attemptedState: baseState, serverState: remote });
  assert.equal(result.nodes.get('account-dialog').open, true);
  assert.equal(result.nodes.get('save-conflict').hidden, false);
  assert.equal(result.puts.length, 0);
  assert.deepEqual(result.state, pending);
  assert.equal(JSON.parse(result.storage.get('mellow-cloud-alice')).dirty, true);
});
