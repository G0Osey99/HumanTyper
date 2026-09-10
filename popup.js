/* HumanTyper popup — Script / Presets / Tune tabs, live ETA, launch flow. */
(function () {
  'use strict';
  const HT = globalThis.HumanTyping;
  const sanitize = globalThis.HTSanitize.sanitize;
  const $ = (id) => document.getElementById(id);

  const el = {
    ver: $('ver'),
    tabs: Array.from(document.querySelectorAll('.tab')),
    panels: { script: $('panel-script'), presets: $('panel-presets'), tune: $('panel-tune') },
    notice: $('notice'),
    // script
    text: $('text'), counts: $('counts'),
    wpm: $('wpm'), wpmVal: $('wpmVal'), bars: $('bars'),
    chipTypos: $('chipTypos'), chipFatigue: $('chipFatigue'), chipRhythm: $('chipRhythm'),
    chipVariance: $('chipVariance'), chipLayout: $('chipLayout'),
    aim: $('aim'), etaChip: $('etaChip'), delayNote: $('delayNote'),
    // presets
    presetList: $('presetList'), presetName: $('presetName'), presetSave: $('presetSave'),
    presetDelete: $('presetDelete'), loadAim: $('loadAim'), loadChip: $('loadChip'),
    presetCount: $('presetCount'),
    // tune
    mistakes: $('mistakes'), intensityRow: $('intensityRow'), intensity: $('intensity'), intVal: $('intVal'),
    fatigue: $('fatigue'), rhythm: $('rhythm'), variance: $('variance'),
    layout: $('layout'), startDelay: $('startDelay'), reset: $('reset'),
  };

  const DEFAULTS = {
    tab: 'script', text: '', wpm: 70,
    mistakes: true, intensity: 1, fatigue: true, rhythm: true, variance: false,
    layout: 'qwerty', startDelay: '0.6',
  };
  let state = Object.assign({}, DEFAULTS);
  let presets = {};        // id -> {name,text,wpm,...}
  let selectedPresetId = null;

  const BAR_HEIGHTS = [40, 55, 70, 85, 100, 60, 75, 90, 100, 65, 80, 100];

  // ---- engine opts + estimation ------------------------------------------
  function readOpts(s) {
    s = s || state;
    return {
      wpm: Number(s.wpm),
      layout: s.layout,
      mistakes: s.mistakes,
      errorIntensity: Number(s.intensity),
      fatigue: s.fatigue,
      rhythm: s.rhythm,
      sessionVariance: s.variance,
    };
  }
  function fmtEta(secs) {
    if (secs == null || !isFinite(secs)) return '—';
    secs = Math.round(secs);
    if (secs < 60) return '~' + secs + 's';
    const m = Math.floor(secs / 60), s = secs % 60;
    if (m < 60) return `~${m}m ${s}s`;
    const h = Math.floor(m / 60);
    return `~${h}h ${m % 60}m`;
  }
  function estimateSeconds(text, opts) {
    if (!text) return null;
    try { return HT.estimate(text, opts, text.length > 1500 ? 3 : 6).seconds; }
    catch (_) { return null; }
  }

  // ---- painters -----------------------------------------------------------
  function buildBars() {
    el.bars.innerHTML = '';
    for (const h of BAR_HEIGHTS) {
      const s = document.createElement('span');
      s.style.height = h + '%';
      el.bars.appendChild(s);
    }
  }
  function paintBars() {
    const v = Number(state.wpm);
    const frac = (v - 15) / (200 - 15);
    const n = Math.round(frac * BAR_HEIGHTS.length);
    Array.from(el.bars.children).forEach((s, i) => s.classList.toggle('on', i < n));
    el.wpmVal.textContent = v;
  }
  function paintChips() {
    el.chipTypos.textContent = state.mistakes ? `typos ×${Number(state.intensity).toFixed(1)}` : 'typos off';
    el.chipTypos.classList.toggle('on', state.mistakes);
    el.chipTypos.classList.toggle('off', !state.mistakes);
    const setChip = (node, label, on) => {
      node.textContent = label;
      node.classList.remove('on');
      node.classList.toggle('off', !on);
    };
    setChip(el.chipFatigue, 'fatigue', state.fatigue);
    setChip(el.chipRhythm, 'rhythm', state.rhythm);
    setChip(el.chipVariance, 'variance', state.variance);
    el.chipLayout.textContent = state.layout;
    el.chipLayout.classList.remove('off');
  }
  function paintIntensity() {
    const v = Number(state.intensity);
    const pct = (v / 3) * 100;
    el.intensity.value = v;
    el.intensity.style.background =
      `linear-gradient(90deg, var(--coral) 0 ${pct}%, var(--track) ${pct}% 100%)`;
    el.intVal.textContent = v.toFixed(1) + '×';
    el.intensityRow.hidden = !state.mistakes;
  }
  function paintSwitch(node, on) { node.setAttribute('aria-checked', on ? 'true' : 'false'); }
  function paintSeg(group, val) {
    Array.from(group.children).forEach((b) =>
      b.setAttribute('aria-checked', b.dataset.val === String(val) ? 'true' : 'false'));
  }
  function paintDelayNote() {
    el.delayNote.textContent = state.startDelay === '0' ? 'no start delay' : `start delay ${state.startDelay}s`;
  }
  function paintCounts() {
    const t = el.text.value;
    const words = t.trim() ? t.trim().split(/\s+/).length : 0;
    el.counts.textContent = `${t.length}c · ${words}w`;
  }
  function updateAimDisabled() { el.aim.disabled = !state.text.trim(); }
  function updatePresetCount() {
    const n = Object.keys(presets).length;
    el.presetCount.textContent = n;
    el.presetCount.hidden = n === 0;
  }
  let delConfirm = false, delTimer = null;
  function resetDeleteConfirm() {
    if (delTimer) clearTimeout(delTimer);
    delConfirm = false;
    if (el.presetDelete) el.presetDelete.textContent = 'Delete selected';
  }

  let etaTimer = null;
  function refreshEta() {
    paintCounts();
    clearTimeout(etaTimer);
    if (!el.text.value) { el.etaChip.textContent = '—'; return; }
    el.etaChip.textContent = '…';
    etaTimer = setTimeout(() => {
      el.etaChip.textContent = fmtEta(estimateSeconds(el.text.value, readOpts()));
    }, 120);
  }

  // Reflect full state into every control (used on load / preset apply / reset).
  function syncUI() {
    el.text.value = state.text;
    el.wpm.value = state.wpm;
    paintBars();
    paintChips();
    paintSwitch(el.mistakes, state.mistakes);
    paintSwitch(el.fatigue, state.fatigue);
    paintSwitch(el.rhythm, state.rhythm);
    paintSwitch(el.variance, state.variance);
    paintIntensity();
    paintSeg(el.layout, state.layout);
    paintSeg(el.startDelay, state.startDelay);
    paintDelayNote();
    updateAimDisabled();
    refreshEta();
  }

  // ---- persistence --------------------------------------------------------
  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({
        ht_state: state, ht_presets: presets, ht_selected: selectedPresetId, ht_tab: state.tab,
      });
    }, 200);
  }

  // ---- tabs ---------------------------------------------------------------
  function setTab(name) {
    state.tab = name;
    el.tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    for (const key of Object.keys(el.panels)) el.panels[key].hidden = key !== name;
    if (name === 'presets') renderPresets();
    persist();
  }
  el.tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const order = ['script', 'presets', 'tune'];
    let i = order.indexOf(state.tab);
    i = e.key === 'ArrowRight' ? (i + 1) % 3 : (i + 2) % 3;
    setTab(order[i]);
    el.tabs[i].focus();
  });

  // ---- script tab wiring --------------------------------------------------
  // Whatever gets pasted is reduced to plain text (no formatting, invisible
  // characters, smart quotes, odd spaces) before it is counted or typed.
  el.text.addEventListener('paste', (e) => {
    const raw = e.clipboardData && e.clipboardData.getData('text/plain');
    if (raw == null) return;
    e.preventDefault();
    const clean = sanitize(raw);
    const s = el.text.selectionStart, en = el.text.selectionEnd;
    el.text.setRangeText(clean, s, en, 'end');
    el.text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  el.text.addEventListener('input', () => { state.text = el.text.value; updateAimDisabled(); refreshEta(); persist(); });
  el.wpm.addEventListener('input', () => { state.wpm = Number(el.wpm.value); paintBars(); refreshEta(); persist(); });

  [el.chipTypos, el.chipFatigue, el.chipRhythm, el.chipVariance, el.chipLayout]
    .forEach((c) => c.addEventListener('click', () => setTab('tune')));

  el.aim.addEventListener('click', () => start());

  // ---- tune tab wiring ----------------------------------------------------
  function toggleSwitch(node, key) {
    state[key] = !state[key];
    paintSwitch(node, state[key]);
    if (key === 'mistakes') paintIntensity();
    paintChips();
    refreshEta();
    persist();
  }
  el.mistakes.addEventListener('click', () => toggleSwitch(el.mistakes, 'mistakes'));
  el.fatigue.addEventListener('click', () => toggleSwitch(el.fatigue, 'fatigue'));
  el.rhythm.addEventListener('click', () => toggleSwitch(el.rhythm, 'rhythm'));
  el.variance.addEventListener('click', () => toggleSwitch(el.variance, 'variance'));
  // switches also respond to Space/Enter (they're <button>, so Enter works; add Space)
  [el.mistakes, el.fatigue, el.rhythm, el.variance].forEach((s) =>
    s.addEventListener('keydown', (e) => { if (e.key === ' ') { e.preventDefault(); s.click(); } }));

  el.intensity.addEventListener('input', () => {
    state.intensity = Number(el.intensity.value);
    paintIntensity(); paintChips(); refreshEta(); persist();
  });

  function wireSeg(group, key) {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-val]');
      if (!b) return;
      state[key] = b.dataset.val;
      paintSeg(group, state[key]);
      if (key === 'layout') paintChips();
      if (key === 'startDelay') paintDelayNote();
      refreshEta(); persist();
    });
  }
  wireSeg(el.layout, 'layout');
  wireSeg(el.startDelay, 'startDelay');

  el.reset.addEventListener('click', () => {
    const keepText = state.text, keepTab = state.tab;
    state = Object.assign({}, DEFAULTS, { text: keepText, tab: keepTab });
    syncUI(); persist();
  });

  // ---- presets tab --------------------------------------------------------
  function firstLine(t) {
    const line = (t || '').split('\n').find((l) => l.trim()) || (t || '');
    return line.trim();
  }
  function renderPresets() {
    resetDeleteConfirm();
    updatePresetCount();
    const ids = Object.keys(presets);
    el.presetList.innerHTML = '';
    if (ids.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'preset-empty';
      empty.textContent = 'No saved scripts yet — paste one on the Script tab and save it here.';
      el.presetList.appendChild(empty);
    } else {
      for (const id of ids) {
        const p = presets[id];
        const card = document.createElement('div');
        card.className = 'preset-card' + (id === selectedPresetId ? ' selected' : '');
        card.tabIndex = 0;
        const eta = fmtEta(estimateSeconds(p.text, readOpts(p)));
        card.innerHTML =
          `<div class="pc-main"><div class="pc-name"></div><div class="pc-snip"></div></div>` +
          `<div class="pc-meta">${p.text.length}c · ${p.wpm} wpm<br><span class="pc-eta">${eta}</span></div>`;
        card.querySelector('.pc-name').textContent = p.name;
        card.querySelector('.pc-snip').textContent = firstLine(p.text);
        card.addEventListener('click', () => selectPreset(id));
        card.addEventListener('dblclick', () => { applyPreset(id); setTab('script'); });
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { applyPreset(id); setTab('script'); }
        });
        el.presetList.appendChild(card);
      }
    }
    el.loadAim.disabled = !selectedPresetId;
    el.loadChip.textContent = selectedPresetId && presets[selectedPresetId] ? presets[selectedPresetId].name : '—';
  }
  function selectPreset(id) {
    selectedPresetId = id;
    renderPresets(); persist();
  }
  function applyPreset(id) {
    const p = presets[id];
    if (!p) return;
    state = Object.assign({}, state, {
      text: p.text, wpm: p.wpm, mistakes: p.mistakes, intensity: p.intensity,
      fatigue: p.fatigue, rhythm: p.rhythm, variance: p.variance,
      layout: p.layout, startDelay: p.startDelay,
    });
    selectedPresetId = id;
    syncUI(); persist();
  }
  el.presetSave.addEventListener('click', () => {
    const name = (el.presetName.value || '').trim();
    if (!name) { flashNotice('Give the script a name first.', true); setTab('presets'); return; }
    if (!state.text.trim()) { flashNotice('Nothing to save — paste a script first.', true); return; }
    const id = 'p' + Date.now();
    presets[id] = {
      name, text: state.text, wpm: state.wpm, mistakes: state.mistakes, intensity: state.intensity,
      fatigue: state.fatigue, rhythm: state.rhythm, variance: state.variance,
      layout: state.layout, startDelay: state.startDelay,
    };
    selectedPresetId = id;
    el.presetName.value = '';
    renderPresets(); persist();
  });
  el.presetDelete.addEventListener('click', () => {
    if (!selectedPresetId || !presets[selectedPresetId]) return;
    if (!delConfirm) {
      delConfirm = true;
      el.presetDelete.textContent = 'Sure? Delete';
      delTimer = setTimeout(() => { delConfirm = false; el.presetDelete.textContent = 'Delete selected'; }, 3000);
      return;
    }
    clearTimeout(delTimer); delConfirm = false; el.presetDelete.textContent = 'Delete selected';
    delete presets[selectedPresetId];
    selectedPresetId = null;
    renderPresets(); persist();
  });
  el.loadAim.addEventListener('click', () => {
    if (!selectedPresetId) return;
    applyPreset(selectedPresetId);
    start();
  });

  // ---- notice -------------------------------------------------------------
  let noticeTimer = null;
  function flashNotice(msg, isErr) {
    el.notice.textContent = msg;
    el.notice.className = 'notice' + (isErr ? ' err' : '');
    el.notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { el.notice.hidden = true; }, 3200);
  }

  // ---- launch flow (unchanged behaviour) ----------------------------------
  const RESTRICTED = /^(chrome|edge|brave|about|view-source|chrome-extension|devtools):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;
  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
  async function ensureContentScript(tabId) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'HT_PING' });
      if (res && res.ok) return true;
    } catch (_) { /* not injected yet */ }
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['src/engine.js', 'src/sanitize.js', 'src/field.js', 'src/content.js'],
      });
      return true;
    } catch (_) { return false; }
  }
  function setBusy(b) {
    el.aim.disabled = b; el.loadAim.disabled = b || !selectedPresetId;
  }
  async function start() {
    const text = sanitize(state.text);
    if (!text.trim()) { flashNotice('Nothing to type — paste a script first.', true); setTab('script'); return; }
    const tab = await getActiveTab();
    if (!tab || !tab.id) { flashNotice('No active tab found.', true); return; }
    if (tab.url && RESTRICTED.test(tab.url)) {
      flashNotice('This page is protected by the browser and can’t be typed into. Open a normal web page and try again.', true);
      return;
    }
    setBusy(true);
    const ok = await ensureContentScript(tab.id);
    if (!ok) { setBusy(false); flashNotice('Could not run on this page. Reload the page and try again.', true); return; }
    const payload = { text, opts: readOpts(), startDelay: Number(state.startDelay) };
    try {
      // The background routes this to the frame that last held the cursor
      // (Google Docs' input iframe, Word's editing iframe, a plain page…).
      // If no frame has a cursor it arms the page: the next click into any
      // text box starts typing there.
      const res = await chrome.runtime.sendMessage({ type: 'HT_ROUTE_START', tabId: tab.id, payload });
      if (!res || !res.ok) throw new Error('route failed');
      window.close();
    } catch (e) {
      setBusy(false);
      flashNotice('Could not start typing on this page. Reload and retry.', true);
    }
  }

  // ---- init ---------------------------------------------------------------
  function init() {
    try { el.ver.textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) {}
    buildBars();
    chrome.storage.local.get(['ht_state', 'ht_presets', 'ht_selected', 'ht_tab'], (data) => {
      state = Object.assign({}, DEFAULTS, data.ht_state || {});
      presets = data.ht_presets || {};
      selectedPresetId = data.ht_selected || null;
      if (selectedPresetId && !presets[selectedPresetId]) selectedPresetId = null;
      updatePresetCount();
      syncUI();
      setTab(data.ht_tab || state.tab || 'script');
    });
  }
  init();
})();
