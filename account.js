(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const game = window.MellowGame;
  const dialog = $('account-dialog');
  let user = null, storage = 'unconfigured', available = false;
  let booting = true, busy = false, syncing = false, dirty = false, authMode = 'login';
  let revision = 0, updatedAt = null, conflict = null, syncError = false;
  let attempts = [];
  let epoch = 0, mutations = 0;
  const cacheKey = username => `mellow-cloud-${username}`;
  const gameKey = username => `mellow-days-user-${username}`;
  const storeName = () => storage === 'local' ? '本机服务' : '云端';
  function readCache(username) {
    try { return JSON.parse(localStorage.getItem(cacheKey(username)) || 'null'); } catch { return null; }
  }
  function writeCache() {
    if (!user) return;
    try { localStorage.setItem(cacheKey(user.username), JSON.stringify({ baseRevision: revision, dirty, state: game.snapshot(), attempts })); } catch { /* Cloud saving still works without browser storage. */ }
  }
  const stateFields = ['energy', 'focus', 'mood', 'joy', 'customTime', 'startedAt', 'activity', 'paused', 'progress', 'mode', 'speed'];
  const sameState = (a, b) => Boolean(a && b && stateFields.every(field => a[field] === b[field]));
  const acknowledgedAttempt = (save, pending) => Array.isArray(pending) && pending.some(attempt => attempt.baseRevision + 1 === save.revision && sameState(attempt.state, save.state));
  function backupLocal() {
    if (!user) return;
    try { localStorage.setItem(cacheKey(user.username) + '-backup', JSON.stringify({ state: game.snapshot(), savedAt: new Date().toISOString() })); } catch { /* Do not stop an explicit cloud restore. */ }
  }
  function suspension() { game.suspend(booting || busy || dialog.open); }
  function message(text = '') { $('account-message').textContent = text; }
  function renderStatus() {
    let text;
    if (!user) text = `访客小屋 · 进度保存在本机${!available && !booting ? ' · 账号服务未连接' : ''}`;
    else if (conflict) text = `${user.username} · 有两份不同的进度，请选择要保留的一份`;
    else if (syncing) text = `${user.username} · 正在保存到${storeName()}…`;
    else if (syncError) text = `${user.username} · 暂未同步，最新进度仍保留在本机`;
    else if (dirty) text = `${user.username} · 有新进度待保存${storage === 'local' ? '（本地开发模式）' : ''}`;
    else text = `${user.username} · 已保存到${storeName()}${updatedAt ? ' ' + new Date(updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''}${storage === 'local' ? '（本地开发模式）' : ''}`;
    $('cloud-status').textContent = text;
    $('cloud-sync').hidden = !user;
    $('cloud-sync').disabled = syncing || busy;
    $('cloud-sync').textContent = conflict ? '选择存档' : syncError ? '重试保存' : '立即保存';
  }
  function renderAccount() {
    $('account-name').textContent = user ? user.username : '登录 / 注册';
    $('account-open').title = user ? `管理 ${user.username} 的小屋` : '登录或注册账号';
    $('account-title').textContent = user ? `你好，${user.username}` : authMode === 'register' ? '给你的小屋留一个名字' : '欢迎回到你的小屋';
    $('account-intro').textContent = storage === 'local' ? '当前是本地开发模式，账号和存档仅保存在这台服务器。' : user ? '每一个平凡的日常，都好好为你记着。' : '登录后，换一台设备也能找回自己的日常。';
    $('auth-tabs').hidden = Boolean(user);
    $('account-form').hidden = Boolean(user);
    $('account-details').hidden = !user || Boolean(conflict);
    $('save-conflict').hidden = !user || !conflict;
    $('use-cloud-save').textContent = `使用${storeName()}进度`;
    $('keep-local-save').textContent = `用本机进度替换${storeName()}`;
    $('confirm-password-field').hidden = authMode !== 'register';
    $('account-confirm').required = authMode === 'register';
    $('import-guest-label').hidden = authMode !== 'register';
    $('account-password').autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
    for (const [id, active] of [['login-tab', authMode === 'login'], ['register-tab', authMode === 'register']]) {
      $(id).classList.toggle('active', active); $(id).setAttribute('aria-pressed', active);
    }
    $('account-submit').textContent = busy ? '稍等，小屋正在准备…' : authMode === 'register' ? '创建我的小屋' : '回到我的小屋';
    $('account-storage-info').textContent = `你的游戏进度会自动保存到${storeName()}，也可以随时手动保存。${storage === 'local' ? '此模式尚未连接阿里云。' : ''}`;
    for (const id of ['account-submit', 'account-save', 'account-logout', 'account-username', 'account-password', 'account-confirm', 'login-tab', 'register-tab', 'import-guest', 'use-cloud-save', 'keep-local-save']) $(id).disabled = busy || syncing;
    renderStatus(); suspension();
  }
  async function api(path, { method = 'GET', data, keepalive = false } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);
    try {
      const response = await fetch('/api' + path, {
        method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, keepalive,
        ...(data !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {})
      });
      const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      if (!response.ok || !result) {
        const error = new Error(result?.message || '账号服务暂未连接，你可以先在访客小屋里玩一会儿。');
        error.code = result?.error; error.status = response.status; throw error;
      }
      return result;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('暂时连接不上存档服务，最新进度会先留在本机。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function showDialog() {
    renderAccount();
    if (!dialog.open) dialog.showModal();
    suspension();
    if (!user && !busy) $('account-username').focus();
  }
  function adoptAccount(payload) {
    epoch++; mutations = 0; syncing = false; syncError = false;
    user = payload.user; storage = payload.storage;
    revision = payload.save.revision; updatedAt = payload.save.updatedAt;
    const cached = readCache(user.username);
    dirty = Boolean(cached?.dirty && cached.state);
    const acknowledged = acknowledgedAttempt(payload.save, cached?.attempts);
    if (dirty && acknowledged && sameState(cached.state, payload.save.state)) dirty = false;
    conflict = dirty && cached.baseRevision !== revision && !acknowledged ? payload.save : null;
    attempts = cached?.baseRevision === revision && Array.isArray(cached.attempts) ? cached.attempts.slice(-4) : [];
    game.replace(dirty ? cached.state : payload.save.state, gameKey(user.username));
    writeCache(); renderAccount();
    if (conflict) { showDialog(); message('找到了另一份新进度，请选择你想继续的那一份。'); }
  }
  function expiredSession() {
    writeCache();
    epoch++; user = null; dirty = false; conflict = null; syncError = false;
    game.restoreGuest(); renderAccount();
    message('登录已过期。账号进度已留在本机，请重新登录。');
    game.toast('登录已过期，最新账号进度已保留在本机。');
  }
  async function flush({ keepalive = false } = {}) {
    if (!user || !dirty || syncing || conflict || booting) return !dirty;
    const requestEpoch = epoch, sentMutations = mutations, snapshot = game.snapshot();
    attempts.push({ baseRevision: revision, state: snapshot });
    attempts = attempts.slice(-4);
    writeCache();
    syncing = true; syncError = false; renderAccount();
    try {
      const result = await api('/save', { method: 'PUT', data: { state: snapshot, revision }, keepalive });
      if (epoch !== requestEpoch) return false;
      revision = result.revision; updatedAt = result.updatedAt;
      attempts = [];
      dirty = mutations !== sentMutations;
      writeCache();
      return true;
    } catch (error) {
      if (epoch !== requestEpoch) return false;
      if (error.code === 'SAVE_CONFLICT') {
        try {
          const latest = await api('/save');
          if (epoch !== requestEpoch) return false;
          // A keepalive save may have succeeded just as the old page closed.
          // Recognize that exact snapshot rather than inventing a device conflict.
          if (acknowledgedAttempt(latest, attempts)) {
            revision = latest.revision; updatedAt = latest.updatedAt; attempts = [];
            dirty = !sameState(game.snapshot(), latest.state); writeCache(); return !dirty;
          }
          conflict = latest; writeCache();
          if (!document.hidden) showDialog();
          message('另一处小屋已有新进度，请选择要保留的一份。');
        } catch (readError) { syncError = true; message(readError.message); }
      } else if (error.status === 401) expiredSession();
      else { syncError = true; message(error.message); writeCache(); }
      return false;
    } finally {
      syncing = false; renderAccount();
    }
  }
  async function bootstrap() {
    suspension();
    try {
      if (!['http:', 'https:'].includes(location.protocol)) return;
      const health = await api('/health');
      storage = health.storage; available = health.accountsAvailable;
      if (available) {
        const result = await api('/auth/session');
        if (result.user) adoptAccount(result);
      }
    } catch { available = false; }
    finally { booting = false; renderAccount(); if (user && dirty && !conflict) void flush(); }
  }
  $('account-open').addEventListener('click', () => { message(); showDialog(); });
  $('account-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { $('account-password').value = ''; $('account-confirm').value = ''; suspension(); });
  for (const [id, mode] of [['login-tab', 'login'], ['register-tab', 'register']]) $(id).addEventListener('click', () => { authMode = mode; message(); renderAccount(); });
  $('account-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    if (authMode === 'register' && $('account-password').value !== $('account-confirm').value) { message('两次输入的密码不一样，再检查一下吧。'); $('account-confirm').focus(); return; }
    if (!['http:', 'https:'].includes(location.protocol)) { message('当前是离线小屋。请通过已启用账号服务的游戏网址登录或注册。'); return; }
    const mode = authMode;
    const input = { username: $('account-username').value.trim(), password: $('account-password').value };
    if (mode === 'register' && $('import-guest').checked) input.initialState = game.snapshot();
    busy = true; message(); renderAccount();
    try {
      const result = await api('/auth/' + mode, { method: 'POST', data: input });
      available = true; adoptAccount(result);
      $('account-password').value = ''; $('account-confirm').value = '';
      if (!conflict) dialog.close();
      game.toast(mode === 'register' ? '小屋准备好了，欢迎开始你的慢慢日常。' : '欢迎回来，你的小屋一直在这里。');
    } catch (error) { message(error.message); }
    finally { busy = false; renderAccount(); if (user && dirty && !conflict) void flush(); }
  });
  async function manualSave() {
    if (conflict) { showDialog(); return; }
    const ok = await flush();
    if (ok && user) { message(`最新进度已保存到${storeName()}。`); game.toast(`最新进度已保存到${storeName()}。`); }
  }
  $('cloud-sync').addEventListener('click', manualSave);
  $('account-save').addEventListener('click', manualSave);
  $('account-logout').addEventListener('click', async () => {
    if (busy || syncing) return;
    busy = true; renderAccount(); message();
    try {
      if (dirty && !conflict) await flush();
      if (!user) return;
      writeCache();
      await api('/auth/logout', { method: 'POST', data: {} });
      epoch++; user = null; dirty = false; conflict = null; syncError = false;
      game.restoreGuest(); dialog.close();
      game.toast('已退出账号，回到了原来的访客小屋。');
    } catch (error) { message(error.message); }
    finally { busy = false; renderAccount(); }
  });
  $('use-cloud-save').addEventListener('click', () => {
    if (!user || !conflict || busy || syncing) return;
    backupLocal();
    revision = conflict.revision; updatedAt = conflict.updatedAt;
    game.replace(conflict.state, gameKey(user.username));
    conflict = null; dirty = false; syncError = false; attempts = []; mutations++; writeCache();
    dialog.close(); renderAccount(); game.toast(`已经恢复${storeName()}的进度。`);
  });
  $('keep-local-save').addEventListener('click', async () => {
    if (!user || !conflict || busy || syncing) return;
    backupLocal(); revision = conflict.revision; conflict = null; dirty = true; attempts = []; writeCache();
    const ok = await flush();
    if (ok) { dialog.close(); game.toast(`这份本机进度已经保存到${storeName()}。`); }
  });
  window.addEventListener('mellow:save', () => {
    if (!user || booting) return;
    dirty = true; mutations++; writeCache(); renderStatus();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { writeCache(); void flush({ keepalive: true }); }
  });
  window.addEventListener('pagehide', () => { writeCache(); void flush({ keepalive: true }); });
  window.addEventListener('online', () => { if (user) void flush(); });
  setInterval(() => { if (!document.hidden && !busy) void flush(); }, 15000);
  void bootstrap();
})();
