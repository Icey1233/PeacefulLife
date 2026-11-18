(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const STORAGE_KEY = 'mellow-days-v1';
  let storageKey = STORAGE_KEY;
  let gameSuspended = false;
  const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
  const activities = {
    sleep: { name: '睡个好觉', duration: 30, reward: '睡了一个好觉，精力也慢慢回来了。', rates: { energy: .65, focus: -.025, mood: .035 } },
    study: { name: '读书学习', duration: 45, reward: '又读完了几页书，今天也进步了一点点。', rates: { energy: -.15, focus: .32, mood: .025 } },
    play: { name: '陪橘子玩', duration: 30, reward: '橘子把喜欢藏在了呼噜声里，喵～', rates: { energy: -.075, focus: -.02, mood: .45 } }
  };
  const initial = { activity: 'study', paused: false, progress: 0, energy: 72, focus: 48, mood: 84, joy: 0, mode: 'live', customTime: Date.now(), flowing: false, speed: 60, startedAt: Date.now() };
  let saved;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { /* The game also works when storage is unavailable. */ }
  const state = { ...initial };
  function applySaved(saved) {
    Object.assign(state, initial, { customTime: Date.now(), startedAt: Date.now() });
    if (!saved || typeof saved !== 'object') return;
    for (const key of ['energy', 'focus', 'mood']) if (Number.isFinite(saved[key])) state[key] = Math.max(0, Math.min(100, saved[key]));
    if (activities[saved.activity]) state.activity = saved.activity;
    if (typeof saved.paused === 'boolean') state.paused = saved.paused;
    if (Number.isFinite(saved.progress)) state.progress = Math.max(0, Math.min(activities[state.activity].duration - .01, saved.progress));
    if (Number.isInteger(saved.joy) && saved.joy >= 0) state.joy = saved.joy;
    if (saved.mode === 'custom') state.mode = 'custom';
    if (Number.isFinite(saved.customTime) && saved.customTime >= Date.UTC(2000, 0, 1) - BEIJING_OFFSET && saved.customTime <= Date.UTC(2099, 11, 31, 15, 59, 59)) state.customTime = saved.customTime;
    if ([1, 60, 360].includes(saved.speed)) state.speed = saved.speed;
    if (Number.isFinite(saved.startedAt) && saved.startedAt <= Date.now()) state.startedAt = saved.startedAt;
    // A custom moment remains exactly where it was left on reopening.
  }
  applySaved(saved);
  const persist = (notify = true) => {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Session-only play is supported. */ }
    if (notify) window.dispatchEvent(new CustomEvent('mellow:save', { detail: { ...state } }));
  };
  const pad = number => String(number).padStart(2, '0');
  const dateParts = timestamp => {
    const date = new Date(timestamp + BEIJING_OFFSET);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
  };
  const getTime = () => state.mode === 'live' ? Date.now() : state.customTime;
  const inputValue = timestamp => {
    const p = dateParts(timestamp);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
  };
  let toastTimeout;
  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => $('toast').classList.remove('show'), 3700);
  }

  // The palettes blend continuously, including across midnight.
  const palettes = [
    { hour: 0, top: '#24324c', bottom: '#667389', far: '#64757d', near: '#506c68', tint: .24, light: 1, stars: 1 },
    { hour: 5, top: '#49516d', bottom: '#bd9e9e', far: '#8c8d97', near: '#717d7b', tint: .16, light: .7, stars: .45 },
    { hour: 6.5, top: '#bdcbd0', bottom: '#f2cfaa', far: '#b2b3a1', near: '#91a08b', tint: .025, light: 0, stars: 0 },
    { hour: 9, top: '#a9cbd1', bottom: '#e6e9cd', far: '#9eafa0', near: '#819b84', tint: 0, light: 0, stars: 0 },
    { hour: 15, top: '#a9cbd1', bottom: '#e8e8ce', far: '#9baa9a', near: '#7e9380', tint: 0, light: 0, stars: 0 },
    { hour: 17.5, top: '#c8b8ae', bottom: '#f4c296', far: '#b49f94', near: '#8c9380', tint: .025, light: .2, stars: 0 },
    { hour: 19, top: '#676b90', bottom: '#cc9b9c', far: '#85839a', near: '#6c7c7c', tint: .15, light: .85, stars: .2 },
    { hour: 21, top: '#293851', bottom: '#718297', far: '#65787f', near: '#516e69', tint: .24, light: 1, stars: 1 },
    { hour: 24, top: '#24324c', bottom: '#667389', far: '#64757d', near: '#506c68', tint: .24, light: 1, stars: 1 }
  ];
  function mixColor(a, b, amount) {
    const channels = color => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
    const start = channels(a), end = channels(b);
    return `rgb(${start.map((channel, index) => Math.round(channel + (end[index] - channel) * amount)).join(',')})`;
  }
  const phases = [
    { from: 0, label: '万籁俱静的深夜', icon: 'moon', captions: { sleep: '夜深了，把自己交给一个好梦。', study: '小灯亮着，书里还有另一个世界。', play: '月亮还醒着，橘子也想再玩一会儿。', idle: '听听夜晚，什么也不做也很好。' } },
    { from: 5, label: '微光里的黎明', icon: 'sun', captions: { sleep: '天色渐亮，再做一个软软的梦。', study: '晨光正在路上，翻开新的一页。', play: '早安，橘子。又是崭新的一天。', idle: '新的一天，正慢慢醒来。' } },
    { from: 7, label: '清新明亮的早晨', icon: 'sun', captions: { sleep: '阳光轻轻的，不急着醒来。', study: '晨光落在书页上，刚好读一会儿。', play: '早晨第一件小事，是陪陪你。', idle: '留一点空白，给美好的早晨。' } },
    { from: 11, label: '阳光温柔的午后', icon: 'sun', captions: { sleep: '午后的风很轻，适合打一个盹。', study: '阳光刚刚好，适合读上几页书。', play: '晒着太阳，和橘子虚度一小会儿。', idle: '就这样坐着，让阳光停一停。' } },
    { from: 17, label: '被晚霞染红的傍晚', icon: 'sun', captions: { sleep: '晚霞落下来，好好歇一会儿。', study: '读着读着，窗外已经是晚霞。', play: '陪橘子一起，把黄昏拉得长一点。', idle: '天边的晚霞，今天也准时赴约。' } },
    { from: 19, label: '灯火可亲的夜晚', icon: 'moon', captions: { sleep: '结束忙碌，好好睡一觉吧。', study: '点一盏小灯，给自己一点安静。', play: '夜色很温柔，身边还有你。', idle: '小屋亮着灯，今天也辛苦啦。' } }
  ];
  let currentPhase = null;
  function renderSky(hour) {
    let index = palettes.findIndex((palette, i) => i < palettes.length - 1 && hour >= palette.hour && hour < palettes[i + 1].hour);
    if (index < 0) index = 0;
    const a = palettes[index], b = palettes[index + 1], blend = (hour - a.hour) / (b.hour - a.hour);
    const lerp = key => a[key] + (b[key] - a[key]) * blend;
    const top = mixColor(a.top, b.top, blend);
    $('sky-top').setAttribute('stop-color', top);
    $('sky-bottom').setAttribute('stop-color', mixColor(a.bottom, b.bottom, blend));
    $('far-hill').setAttribute('fill', mixColor(a.far, b.far, blend));
    $('near-hill').setAttribute('fill', mixColor(a.near, b.near, blend));
    $('moon-cut').setAttribute('fill', top);
    $('room-tint').setAttribute('opacity', lerp('tint').toFixed(3));
    $('lamp-glow').setAttribute('opacity', lerp('light').toFixed(3));
    $('stars').style.opacity = lerp('stars').toFixed(3);
    document.querySelector('.house-windows').setAttribute('fill', hour >= 18 || hour < 6 ? '#f2d396' : '#a2b2a5');
    const daylight = hour >= 5.5 && hour < 18.75;
    $('sun').style.opacity = daylight ? String(Math.min(1, Math.max(0, (hour - 5.5) / 1.2), Math.max(0, (18.75 - hour) / 1.2))) : '0';
    const solarProgress = Math.max(0, Math.min(1, (hour - 6) / 12));
    $('sun').setAttribute('cx', 115 + solarProgress * 288);
    $('sun').setAttribute('cy', 290 - Math.sin(solarProgress * Math.PI) * 145);
    $('moon').style.opacity = String(lerp('stars'));
    $('sunbeam').setAttribute('opacity', daylight ? Math.max(0, Math.sin(solarProgress * Math.PI) * .2) : 0);
    $('scene-wrap').classList.toggle('night-scene', hour >= 19 || hour < 6);
    let phase = phases[0];
    for (const item of phases) if (hour >= item.from) phase = item;
    if (phase !== currentPhase) {
      currentPhase = phase;
      $('phase-label').textContent = phase.label;
      $('time-icon').innerHTML = phase.icon === 'moon'
        ? '<path d="M36 29A17 17 0 0 1 19 9a17 17 0 1 0 17 20Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M34 8v7m-3.5-3.5h7m1 7v4m-2-2h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
        : '<circle cx="24" cy="24" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M24 6v5m0 26v5M6 24h5m26 0h5M11 11l4 4m18 18 4 4M11 37l4-4m18-18 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
    }
    $('scene-caption').textContent = phase.captions[state.paused ? 'idle' : state.activity];
    $('scene-description').textContent = `窗外是${phase.label}，人物${state.paused ? '正在歇息' : '正在' + activities[state.activity].name}，橘子在身边。`;
  }
  function renderTime() {
    const timestamp = getTime();
    const p = dateParts(timestamp);
    $('clock').innerHTML = `${pad(p.hour)}:${pad(p.minute)}<span>:${pad(p.second)}</span>`;
    $('clock').dateTime = new Date(timestamp).toISOString();
    $('date-label').textContent = `${p.year} 年 ${p.month} 月 ${p.day} 日 · 星期${'日一二三四五六'[p.weekday]}`;
    $('wall-clock-hour').setAttribute('transform', `rotate(${(p.hour % 12) * 30 + p.minute * .5} 549 223)`);
    $('wall-clock-minute').setAttribute('transform', `rotate(${p.minute * 6 + p.second * .1} 549 223)`);
    if (document.activeElement !== $('custom-datetime')) $('custom-datetime').value = inputValue(timestamp);
    if (document.activeElement !== $('time-slider')) $('time-slider').value = p.hour * 60 + p.minute;
    $('day-count').textContent = pad(Math.max(1, Math.floor((Date.now() - state.startedAt) / 86400000) + 1));
    renderSky(p.hour + p.minute / 60 + p.second / 3600);
  }
  function renderMode() {
    const live = state.mode === 'live';
    for (const [id, active] of [['live-mode', live], ['custom-mode', !live]]) {
      $(id).classList.toggle('active', active);
      $(id).setAttribute('aria-pressed', active);
    }
    $('custom-time-controls').hidden = live;
    $('timezone-label').innerHTML = `<span></span>${live ? '北京时间' : '自定义 · 北京时区'}`;
    $('time-hint').lastChild.textContent = live ? '窗外的风景，和你共享同一刻。' : '拖动时间，看看小屋的另一面。';
    $('time-flow-toggle').setAttribute('aria-pressed', state.flowing);
    $('flow-label').textContent = state.flowing ? '暂停时间流动' : '让时间流动';
    $('flow-symbol').textContent = state.flowing ? 'Ⅱ' : '▷';
    $('time-speed').value = state.speed;
    renderTime();
  }
  function renderActivity() {
    for (const button of document.querySelectorAll('[data-activity]')) {
      const selected = button.dataset.activity === state.activity && !state.paused;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected);
    }
    $('person-sleeping').toggleAttribute('hidden', state.activity !== 'sleep' || state.paused);
    $('person-studying').toggleAttribute('hidden', state.activity !== 'study' && !state.paused);
    $('study-hands').toggleAttribute('hidden', state.activity !== 'study' && !state.paused);
    $('person-playing').toggleAttribute('hidden', state.activity !== 'play' || state.paused);
    $('cat').classList.toggle('cat-playing', state.activity === 'play' && !state.paused);
    $('cat').classList.toggle('cat-idle', state.activity !== 'play' || state.paused);
    $('cat-status').textContent = state.paused ? '橘子在陪你发呆 · 喵' : { sleep: '橘子放轻了呼噜声 · 呼噜', study: '橘子乖乖地陪着你 · 喵', play: '橘子的尾巴摇起来了 · 喵！' }[state.activity];
    $('activity-status').textContent = state.paused ? '正在享受放空的片刻' : `正在${activities[state.activity].name}`;
    $('pause-activity').textContent = state.paused ? '继续刚才的事' : '歇一会儿';
    document.querySelector('.activity-progress').classList.toggle('activity-paused', state.paused);
    renderTime();
    renderStats();
  }
  function renderStats() {
    for (const stat of ['energy', 'focus', 'mood']) {
      const value = Math.round(state[stat]);
      $(stat + '-value').innerHTML = `${value}<small>/100</small>`;
      $(stat + '-bar').style.width = `${state[stat]}%`;
    }
    $('energy-note').textContent = state.energy < 25 ? '有点累了，睡个好觉吧' : state.energy >= 90 ? '电量满格，元气满满' : '还有满满的能量';
    $('focus-note').textContent = state.focus >= 90 ? '书页里藏着好多新发现' : state.focus < 25 ? '翻几页书，慢慢进入状态' : '知识在一点点积累';
    $('mood-note').textContent = state.mood >= 90 ? '和橘子一起，快乐满满' : state.mood < 30 ? '去陪陪橘子吧，它在等你' : '今天也有小小的幸福';
    $('joy-count').textContent = state.joy;
    const activity = activities[state.activity];
    $('activity-progress-bar').style.width = `${state.progress / activity.duration * 100}%`;
    $('activity-progress-note').textContent = state.paused ? '慢慢来，进度会留在这里。' : `${state.activity === 'study' ? '再专注' : state.activity === 'sleep' ? '再休息' : '再玩耍'} ${Math.ceil(activity.duration - state.progress)} 秒，收获一份小确幸`;
  }
  document.querySelectorAll('[data-activity]').forEach(button => button.addEventListener('click', () => {
    const next = button.dataset.activity;
    if (state.activity === next && !state.paused) return;
    if (state.activity !== next) state.progress = 0;
    state.activity = next;
    state.paused = false;
    renderActivity(); persist();
  }));
  $('pause-activity').addEventListener('click', () => { state.paused = !state.paused; renderActivity(); persist(); });
  $('live-mode').addEventListener('click', () => { state.mode = 'live'; state.flowing = false; renderMode(); persist(); });
  $('custom-mode').addEventListener('click', () => {
    if (state.mode === 'live') state.customTime = Date.now();
    state.mode = 'custom'; state.flowing = false; renderMode(); persist();
  });
  $('custom-datetime').addEventListener('change', event => {
    const value = event.target.value;
    const timestamp = Date.parse(value + ':00+08:00');
    if (!Number.isFinite(timestamp) || !event.target.validity.valid) {
      toast('请选择 2000 年到 2099 年之间的有效时间。');
      event.target.value = inputValue(state.customTime); return;
    }
    state.customTime = timestamp; renderTime(); persist();
  });
  $('time-slider').addEventListener('input', event => {
    const parts = dateParts(state.customTime);
    const minutes = Number(event.target.value);
    state.customTime = Date.UTC(parts.year, parts.month - 1, parts.day, Math.floor(minutes / 60), minutes % 60) - BEIJING_OFFSET;
    renderTime(); persist();
  });
  $('time-flow-toggle').addEventListener('click', () => { state.flowing = !state.flowing; renderMode(); persist(); });
  $('time-speed').addEventListener('change', event => { state.speed = Number(event.target.value); persist(); });

  // A quiet, optional ambient sound, synthesized locally; no audio downloads.
  let audioContext, audioMaster, audioEnabled = false;
  async function toggleAudio() {
    try {
      if (!audioContext) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) throw new Error('Audio unavailable');
        audioContext = new AudioContext();
        audioMaster = audioContext.createGain(); audioMaster.gain.value = 0; audioMaster.connect(audioContext.destination);
        [130.81, 196, 261.63, 329.63].forEach((frequency, index) => {
          const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
          oscillator.type = 'sine'; oscillator.frequency.value = frequency; oscillator.detune.value = index % 2 ? 3 : -3;
          gain.gain.value = .025 / (index + 1); oscillator.connect(gain).connect(audioMaster); oscillator.start();
          const lfo = audioContext.createOscillator(), lfoGain = audioContext.createGain();
          lfo.frequency.value = .07 + index * .025; lfoGain.gain.value = gain.gain.value * .4;
          lfo.connect(lfoGain).connect(gain.gain); lfo.start();
        });
      }
      await audioContext.resume();
      audioEnabled = !audioEnabled;
      audioMaster.gain.setTargetAtTime(audioEnabled ? 1 : 0, audioContext.currentTime, .4);
      $('sound-toggle').setAttribute('aria-pressed', audioEnabled);
      $('sound-label').textContent = audioEnabled ? '轻音乐开' : '声音已关';
      $('sound-waves').setAttribute('d', audioEnabled ? 'M16 8q7 4 0 8m3-11q11 7 0 14' : 'm16 9 5 6m0-6-5 6');
    } catch { toast('这个浏览器暂时无法播放声音，继续享受安静的小屋吧。'); }
  }
  $('sound-toggle').addEventListener('click', toggleAudio);
  let lastPet = -Infinity;
  function petCat() {
    if (performance.now() - lastPet < 1800) return;
    lastPet = performance.now();
    state.mood = Math.min(100, state.mood + 1);
    toast('摸摸橘子，它对你发出了呼噜声。心情 +1');
    renderStats(); persist();
    if (audioEnabled && audioContext) {
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
      oscillator.frequency.setValueAtTime(650, audioContext.currentTime); oscillator.frequency.exponentialRampToValueAtTime(360, audioContext.currentTime + .3);
      gain.gain.setValueAtTime(.025, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .35);
      oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + .4);
    }
  }
  $('cat').setAttribute('role', 'button'); $('cat').setAttribute('tabindex', '0'); $('cat').setAttribute('aria-label', '摸摸橘子，增加一点心情');
  $('cat').addEventListener('click', petCat);
  $('cat').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); petCat(); } });

  let lastTick = performance.now(), saveElapsed = 0;
  function tick() {
    const now = performance.now();
    const seconds = Math.max(0, Math.min(2, (now - lastTick) / 1000));
    lastTick = now;
    if (!document.hidden && !gameSuspended) {
      if (state.mode === 'custom' && state.flowing) {
        state.customTime += seconds * 1000 * state.speed;
        if (state.customTime > Date.UTC(2099, 11, 31, 15, 59, 59)) {
          state.customTime = Date.UTC(2099, 11, 31, 15, 59, 59);
          state.flowing = false;
          renderMode();
          toast('时间走到可选日期的尽头了，换一个喜欢的日子吧。');
        }
      }
      if (!state.paused) {
        const activity = activities[state.activity];
        for (const stat of ['energy', 'focus', 'mood']) state[stat] = Math.max(0, Math.min(100, state[stat] + activity.rates[stat] * seconds));
        state.progress += seconds;
        if (state.progress >= activity.duration) {
          state.progress %= activity.duration; state.joy += 1;
          toast(`小确幸 +1 · ${activity.reward}`); persist();
        }
      } else {
        state.energy = Math.min(100, state.energy + .035 * seconds);
      }
      renderStats();
      saveElapsed += seconds;
      if (saveElapsed >= 5) { saveElapsed = 0; persist(); }
    }
    renderTime();
  }
  document.addEventListener('visibilitychange', () => {
    lastTick = performance.now();
    if (document.hidden) { persist(); if (audioContext) audioContext.suspend().catch(() => {}); }
    else if (audioContext && audioEnabled) audioContext.resume().catch(() => {});
    renderTime();
  });
  window.addEventListener('pagehide', () => persist());
  window.MellowGame = {
    snapshot: () => ({ ...state }),
    suspend(value) { gameSuspended = Boolean(value); lastTick = performance.now(); },
    replace(data, key = STORAGE_KEY) {
      storageKey = key;
      applySaved(data);
      persist(false);
      renderMode(); renderActivity();
      lastTick = performance.now();
    },
    restoreGuest() {
      let guest;
      try { guest = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { /* Start a fresh guest room. */ }
      this.replace(guest, STORAGE_KEY);
    },
    toast
  };
  renderMode(); renderActivity();
  setInterval(tick, 250);
})();
