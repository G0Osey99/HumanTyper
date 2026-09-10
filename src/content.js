/*
 * HumanTyper content script (runs in every frame).
 *
 * - Tracks the editable that last held the caret in THIS frame and tells the
 *   background, so a start request is routed to the right frame (Google Docs'
 *   hidden input iframe, Word on the web's editing iframe, embedded editors…).
 * - Universal driver: the caret frame re-focuses its field (HT_FOCUS), then the
 *   TOP frame replays the ported HumanTyping model, asking the background for
 *   one real keystroke per character (chrome.debugger → trusted key events,
 *   delivered to whatever has focus, in any frame, on any site).
 * - Fallback driver: when the debugger can't attach, the caret frame types
 *   through the DOM adapters in field.js and streams HUD progress to the top.
 * - The HUD (progress / pause / stop) always lives in the top frame.
 *
 * Depends (same isolated world, loaded first): HumanTyping, HTField, HTSanitize
 */
(function () {
  'use strict';
  if (window.__HT_LOADED__) return;
  window.__HT_LOADED__ = true;

  const HT = globalThis.HumanTyping;
  const HF = globalThis.HTField;
  const HS = globalThis.HTSanitize;
  const IS_TOP = window === window.top;
  const send = (msg) => { try { return chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) { return null; } };
  const ask = async (msg) => { try { return await chrome.runtime.sendMessage(msg); } catch (_) { return null; } };

  // ==========================================================================
  // Caret tracking
  // ==========================================================================
  let lastEditable = null;
  let savedCaret = null; // { el, start, end } | { el, range }
  let lastReport = 0;

  function reportCaret(force) {
    const now = Date.now();
    if (!force && now - lastReport < 300) return;
    lastReport = now;
    send({ type: 'HT_CARET' });
  }
  function saveCaret(host) {
    try {
      if (host.tagName === 'INPUT' || host.tagName === 'TEXTAREA') {
        if (host.selectionStart != null) savedCaret = { el: host, start: host.selectionStart, end: host.selectionEnd };
      } else if (host.isContentEditable) {
        const sel = document.getSelection();
        if (sel && sel.rangeCount) {
          const r = sel.getRangeAt(0);
          if (host.contains(r.startContainer)) savedCaret = { el: host, range: r.cloneRange() };
        }
      }
    } catch (_) { /* ignore */ }
  }
  function noteEditable(el) {
    const host = HF.resolveEditable(el);
    if (!host) return;
    const changed = host !== lastEditable;
    lastEditable = host;
    saveCaret(host);
    reportCaret(changed);
  }
  document.addEventListener('focusin', (e) => noteEditable(e.target), true);
  document.addEventListener('pointerdown', (e) => noteEditable(e.target), true);
  document.addEventListener('keyup', (e) => noteEditable(e.target), true);
  document.addEventListener('selectionchange', () => {
    const host = HF.resolveEditable(document.activeElement);
    if (host) noteEditable(host);
    else if (lastEditable && lastEditable.isConnected) saveCaret(lastEditable);
  }, true);
  // Some editors (Google Docs' hidden input frame) focus their contenteditable
  // programmatically; catch the frame gaining focus too.
  window.addEventListener('focus', () => { if (HF.resolveEditable(document.activeElement)) noteEditable(document.activeElement); }, true);
  if (document.hasFocus() && HF.resolveEditable(document.activeElement)) noteEditable(document.activeElement);

  // The field to type into, in this frame, or null.
  function pickTarget() {
    if (lastEditable && lastEditable.isConnected) return HF.makeField(lastEditable);
    const ae = document.activeElement;
    if (HF.resolveEditable(ae)) return HF.makeField(ae);
    return null;
  }

  // Universal driver: every insert/backspace becomes a real keystroke emitted
  // by the background through chrome.debugger into the focused element.
  class KeystrokeField {
    constructor(label) { this._label = label || 'focused field'; this.el = null; this.kind = 'cdp'; }
    label() { return this._label; }
    focus() {}
    async insert(str) {
      // The engine emits one UTF-16 unit per keystroke, so an emoji arrives as
      // two halves; hold a high surrogate until its partner shows up.
      if (this._hi) { str = this._hi + str; this._hi = ''; }
      const last = str.charCodeAt(str.length - 1);
      if (last >= 0xD800 && last <= 0xDBFF) { this._hi = str.slice(-1); str = str.slice(0, -1); }
      for (const ch of str) {
        const r = await ask({ type: 'HT_KEY', op: 'char', ch });
        if (!r || !r.ok) throw new Error('Keystroke driver lost');
      }
    }
    async backspace() {
      if (this._hi) { this._hi = ''; return; } // the half never reached the page
      const r = await ask({ type: 'HT_KEY', op: 'backspace' });
      if (!r || !r.ok) throw new Error('Keystroke driver lost');
    }
    // Option+Backspace (mac) / Ctrl+Backspace: delete back to the word start.
    // The engine only emits this when the tail is a plain word, so the editor
    // and the model agree on what gets removed.
    async deleteWord() {
      this._hi = '';
      const r = await ask({ type: 'HT_KEY', op: 'deleteWord' });
      if (!r || !r.ok) throw new Error('Keystroke driver lost');
    }
  }

  // Put the caret back where the user left it, else at the end.
  function focusField(field) {
    const host = field.el;
    if (!host) return;
    try {
      host.focus({ preventScroll: false });
      if (savedCaret && savedCaret.el === host) {
        if (host.tagName === 'INPUT' || host.tagName === 'TEXTAREA') {
          if (savedCaret.start != null) { host.setSelectionRange(savedCaret.start, savedCaret.end); return; }
        } else if (savedCaret.range && host.contains(savedCaret.range.startContainer)) {
          const sel = document.getSelection();
          sel.removeAllRanges();
          sel.addRange(savedCaret.range);
          return;
        }
      }
    } catch (_) { /* fall through */ }
    field.focus();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clock = (secs) => {
    secs = Math.max(0, Math.round(secs));
    const m = Math.floor(secs / 60), s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  // ==========================================================================
  // Session / player (runs in the frame that owns the field)
  // ==========================================================================
  let session = null;

  function hud(patch) {
    // Progress goes to the top frame's HUD (locally if we are the top frame).
    if (IS_TOP) hudUpdate(patch);
    else send(Object.assign({ type: 'HT_HUD' }, patch));
  }
  async function applyDiff(prev, next, field, action) {
    if (next === prev) return;
    if (next.length > prev.length && next.startsWith(prev)) {
      await field.insert(next.slice(prev.length));
    } else if (next.length < prev.length && prev.startsWith(next)) {
      let k = prev.length - next.length;
      if (action === 'DELETE_WORD' && field.deleteWord) { await field.deleteWord(k); return; }
      while (k-- > 0) await field.backspace();
    } else {
      let i = 0; const m = Math.min(prev.length, next.length);
      while (i < m && prev[i] === next[i]) i++;
      let del = prev.length - i;
      while (del-- > 0) await field.backspace();
      if (next.length > i) await field.insert(next.slice(i));
    }
  }
  function stopSession(reason) {
    if (!session || session.done) return;
    session.stopped = true;
    session.stopReason = reason || 'Stopped';
  }
  function togglePause() {
    if (!session || session.stopped || session.done) return;
    session.paused = !session.paused;
    hud({ state: session.paused ? 'Paused' : 'Typing', cls: session.paused ? 'paused' : 'typing', paused: session.paused });
  }
  function onSessionKey(e) {
    if (session && !session.done && e.key === 'Escape') stopSession('Stopped');
  }

  async function play(field, text, opts, startDelay) {
    let history, totalTime;
    try {
      const res = new HT.MarkovTyper(text, opts).run();
      history = res.history; totalTime = res.totalTime;
    } catch (err) {
      hud({ show: true, state: 'Error', cls: 'stopped', target: String((err && err.message) || err), done: true });
      return;
    }
    const s = {
      field, history, totalTime, targetLen: text.length,
      prevText: '', simT: 0, paused: false, stopped: false, done: false,
      startWall: performance.now(), lastHud: 0,
    };
    session = s;
    document.addEventListener('keydown', onSessionKey, true);
    hud({ show: true, reset: true, state: 'Starting', cls: 'typing', target: '→ ' + field.label(), pct: 0, elapsed: 0, left: totalTime });

    focusField(field);
    if (startDelay > 0) {
      for (let n = Math.ceil(startDelay); n > 0; n--) {
        if (s.stopped || session !== s) break;
        hud({ state: 'Starting in ' + n + '…', cls: 'typing', left: totalTime, elapsed: 0, pct: 0 });
        await sleep(1000);
      }
    }
    if (s.stopped || session !== s) { finish(s); return; }
    hud({ state: 'Typing', cls: 'typing' });
    focusField(field);

    s.startWall = performance.now();
    // Schedule every keystroke against the wall clock (model time t maps to
    // clockBase + t) so per-keystroke overhead (timers, debugger round trips)
    // doesn't accumulate into a slower-than-modelled run. Pauses shift the
    // base; if the page stalls badly we re-base instead of machine-gunning
    // keys to catch up.
    let clockBase = performance.now();
    for (let i = 0; i < history.length; i++) {
      if (s.stopped || session !== s) break;
      const [t, action, txt] = history[i];
      if (action.startsWith('INIT')) { s.prevText = txt; continue; }
      if (s.paused) {
        const pausedAt = performance.now();
        while (s.paused && !s.stopped && session === s) await sleep(120);
        clockBase += performance.now() - pausedAt;
      }
      if (s.stopped || session !== s) break;
      const wait = clockBase + t * 1000 - performance.now();
      if (wait > 0) await sleep(wait);
      else if (wait < -250) clockBase -= wait;
      if (s.stopped || session !== s) break;
      if (field.el && !field.el.isConnected) { s.stopped = true; s.stopReason = 'Field left the page'; break; }
      try { await applyDiff(s.prevText, txt, field, action); }
      catch (err) { s.stopped = true; s.stopReason = (err && err.message) || 'Stopped'; break; }
      s.prevText = txt; s.simT = t;
      const now = performance.now();
      if (now - s.lastHud > 100) { s.lastHud = now; progress(s); }
    }
    finish(s);
  }
  function progress(s, extra) {
    const typed = s.prevText.length, total = s.targetLen;
    hud(Object.assign({
      pct: total ? Math.min(100, Math.round((typed / total) * 100)) : 0,
      typedN: typed, total,
      elapsed: (performance.now() - s.startWall) / 1000,
      left: Math.max(0, s.totalTime - s.simT),
    }, extra || {}));
  }
  function finish(s) {
    if (!s || s.done) return;
    s.done = true;
    if (session !== s) return;
    document.removeEventListener('keydown', onSessionKey, true);
    const elapsed = (performance.now() - s.startWall) / 1000;
    if (s.stopped) progress(s, { done: true, state: s.stopReason || 'Stopped', cls: 'stopped' });
    else progress(s, { done: true, state: 'Done', cls: 'ok', pct: 100, target: `Typed ${s.prevText.length} chars in ${clock(elapsed)}` });
    session = null;
    send({ type: 'HT_DONE' });
  }

  // ==========================================================================
  // Messaging
  // ==========================================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'HT_PING': sendResponse({ ok: true }); return;
      case 'HT_STOP': stopSession(msg.reason || 'Stopped'); sendResponse({ ok: true }); return;
      case 'HT_CTRL_DO':
        if (msg.action === 'pause') togglePause();
        else if (msg.action === 'stop') stopSession('Stopped');
        return;
      case 'HT_FOCUS': {
        // Universal driver: put focus (and the saved caret) back on this
        // frame's field so the trusted keystrokes land there. A focused
        // <iframe> counts too — the editor inside it will receive the keys.
        const field = pickTarget();
        if (field) { focusField(field); sendResponse({ ok: true, label: field.label() }); return; }
        const ae = document.activeElement;
        if (ae && ae.tagName === 'IFRAME') { sendResponse({ ok: true, label: 'embedded editor' }); return; }
        sendResponse({ ok: false });
        return;
      }
      case 'HT_START': {
        const p = msg.payload || {};
        const text = HS.sanitize(p.text || '');
        if (!text) { sendResponse({ ok: false, error: 'No text provided.' }); return; }
        const field = p.driver === 'cdp' ? new KeystrokeField(p.label) : pickTarget();
        if (!field) { sendResponse({ ok: false, error: 'no-target' }); return; }
        if (session && !session.done) stopSession('Restarted');
        sendResponse({ ok: true });
        setTimeout(() => play(field, text, p.opts || {}, p.startDelay != null ? p.startDelay : 0.6), 30);
        return;
      }
      case 'HT_ARM': if (IS_TOP) setArmed(!!msg.on); return;
      case 'HT_HUD_UPDATE': if (IS_TOP) hudUpdate(msg); return;
      default: return;
    }
  });

  // ==========================================================================
  // Top-frame UI: armed banner + HUD (Shadow DOM, Paper & Coral)
  // ==========================================================================
  if (!IS_TOP) return;

  let uiHost, ui, fontsLoaded = false, armed = false;

  function loadFonts() {
    if (fontsLoaded) return;
    fontsLoaded = true;
    try {
      const add = (family, file, weight) => {
        const url = chrome.runtime.getURL('fonts/' + file);
        const face = new FontFace(family, `url("${url}") format("woff2")`, { weight, display: 'swap' });
        face.load().then((f) => document.fonts.add(f)).catch(() => {});
      };
      add('HTDMSans', 'dmsans.woff2', '100 1000');
      add('HTMono', 'jetbrainsmono.woff2', '100 800');
    } catch (_) { /* fonts optional */ }
  }

  function ensureUI() {
    if (ui) return ui;
    loadFonts();
    uiHost = document.createElement('div');
    uiHost.id = '__humantyper_ui__';
    uiHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;';
    const shadow = uiHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${STYLE}</style>
      <div id="banner" hidden>
        <span class="pulse"></span>
        <span class="btxt">Click where you want the text typed</span>
        <span class="bkey">Esc</span>
      </div>
      <div id="hud" hidden>
        <div id="hudHead">
          <span class="brand"><span class="logo"></span> HumanTyper</span>
          <span id="hudState" class="state">Ready</span>
        </div>
        <div id="target" class="target">—</div>
        <div class="barwrap"><div id="bar"></div></div>
        <div class="stats">
          <div><label>Progress</label><b id="sProg">0%</b></div>
          <div><label>Elapsed</label><b id="sElapsed">0:00</b></div>
          <div class="left"><label>Left</label><b id="sLeft">0:00</b></div>
        </div>
        <div id="controls">
          <button id="btnPause" class="btn" type="button">Pause</button>
          <button id="btnStop" class="btn stop" type="button">Stop</button>
        </div>
        <div id="doneRow" hidden>
          <button id="btnClose" class="btn" type="button">Close</button>
        </div>
      </div>`;
    (document.documentElement || document.body).appendChild(uiHost);
    const $ = (id) => shadow.getElementById(id);
    ui = {
      banner: $('banner'), hud: $('hud'), head: $('hudHead'), state: $('hudState'), target: $('target'),
      bar: $('bar'), sProg: $('sProg'), sElapsed: $('sElapsed'), sLeft: $('sLeft'),
      controls: $('controls'), btnPause: $('btnPause'), btnStop: $('btnStop'), doneRow: $('doneRow'), btnClose: $('btnClose'),
    };
    ui.btnPause.addEventListener('click', () => ctrl('pause'));
    ui.btnStop.addEventListener('click', () => ctrl('stop'));
    ui.btnClose.addEventListener('click', () => { ui.hud.hidden = true; });
    // Keep clicks on the HUD from moving the page caret / being treated as a target click.
    uiHost.addEventListener('pointerdown', (e) => e.stopPropagation(), true);
    makeDraggable(ui.hud, ui.head);
    return ui;
  }
  function ctrl(action) {
    // Local session (typing in the top frame) or a remote one (an iframe).
    if (session && !session.done) { if (action === 'pause') togglePause(); else stopSession('Stopped'); }
    else send({ type: 'HT_CTRL', action });
  }
  function makeDraggable(panel, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.style.cursor = 'grab';
    handle.addEventListener('pointerdown', (e) => {
      dragging = true; handle.setPointerCapture(e.pointerId); handle.style.cursor = 'grabbing';
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      nx = Math.max(4, Math.min(window.innerWidth - panel.offsetWidth - 4, nx));
      ny = Math.max(4, Math.min(window.innerHeight - panel.offsetHeight - 4, ny));
      panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
    });
    handle.addEventListener('pointerup', (e) => {
      dragging = false; handle.style.cursor = 'grab';
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    });
  }

  let hudTimer = null, hudBase = null;
  function hudUpdate(m) {
    ensureUI();
    if (m.show) { ui.hud.hidden = false; }
    if (m.reset) {
      ui.doneRow.hidden = true; ui.controls.hidden = false; ui.btnPause.textContent = 'Pause';
      ui.bar.style.width = '0%'; ui.sProg.textContent = '0%'; ui.sElapsed.textContent = '0:00';
      clearInterval(hudTimer); hudBase = null;
    }
    if (m.state != null) { ui.state.textContent = m.state; ui.state.className = 'state ' + (m.cls || ''); }
    if (m.target != null) ui.target.textContent = m.target;
    if (m.pct != null) { ui.bar.style.width = m.pct + '%'; ui.sProg.textContent = m.pct + '%'; }
    if (m.typedN != null) ui.bar.title = `${m.typedN} / ${m.total}`;
    if (m.left != null) ui.sLeft.textContent = clock(m.left);
    if (m.elapsed != null) {
      ui.sElapsed.textContent = clock(m.elapsed);
      // Tick elapsed locally between (throttled) updates from an iframe.
      hudBase = { at: performance.now(), elapsed: m.elapsed };
      if (!hudTimer) hudTimer = setInterval(() => {
        if (!hudBase || ui.hud.hidden) return;
        ui.sElapsed.textContent = clock(hudBase.elapsed + (performance.now() - hudBase.at) / 1000);
      }, 1000);
    }
    if (m.paused != null) ui.btnPause.textContent = m.paused ? 'Resume' : 'Pause';
    if (m.paused === true && hudBase) { hudBase = null; }
    if (m.done) {
      ui.controls.hidden = true; ui.doneRow.hidden = false;
      clearInterval(hudTimer); hudTimer = null; hudBase = null;
    }
  }

  function onArmKey(e) { if (e.key === 'Escape') { e.preventDefault(); send({ type: 'HT_DISARM' }); setArmed(false); } }
  function setArmed(on) {
    ensureUI();
    armed = on;
    ui.banner.hidden = !on;
    if (on) document.addEventListener('keydown', onArmKey, true);
    else document.removeEventListener('keydown', onArmKey, true);
  }

  // ==========================================================================
  // Styles (Paper & Coral)
  // ==========================================================================
  const UIFONT = "'HTDMSans','DM Sans',system-ui,sans-serif";
  const MONO = "'HTMono','JetBrains Mono',ui-monospace,Menlo,monospace";
  const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }

  #banner {
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 10px; white-space: nowrap; z-index: 3;
    background: #1d1a17; color: #f7f4ee; border-radius: 999px; padding: 9px 14px 9px 10px;
    box-shadow: 0 10px 24px rgba(0,0,0,.25); pointer-events: none;
  }
  #banner .btxt { font: 700 13px/1 ${UIFONT}; }
  #banner .pulse { width: 10px; height: 10px; border-radius: 50%; background: #e8654a;
    box-shadow: 0 0 0 4px rgba(232,101,74,.3); animation: htpulse 1.2s ease-out infinite; }
  #banner .bkey { font: 600 10.5px/1 ${MONO}; padding: 4px 6px; border-radius: 5px; background: rgba(255,255,255,.14); }
  @keyframes htpulse { 0%{box-shadow:0 0 0 0 rgba(232,101,74,.5)} 100%{box-shadow:0 0 0 8px rgba(232,101,74,0)} }

  #hud {
    position: fixed; right: 18px; bottom: 18px; width: 300px; z-index: 3;
    background: #f7f4ee; color: #1d1a17; border: 1px solid rgba(29,26,23,.12); border-radius: 14px;
    padding: 12px 14px 14px; box-shadow: 0 14px 34px rgba(0,0,0,.18);
    display: flex; flex-direction: column; gap: 10px; font-family: ${UIFONT};
  }
  #hudHead { display: flex; align-items: center; justify-content: space-between; user-select: none; }
  .brand { display: flex; align-items: center; gap: 8px; font: 800 13px/1 ${UIFONT}; }
  .brand .logo { width: 20px; height: 20px; border-radius: 5px; background: #e8654a; position: relative; flex: none; }
  .brand .logo::after { content:''; position: absolute; left: 3px; top: 3px; width: 14px; height: 11px; border-radius: 3px; background: #fff3ec; box-shadow: 0 1px 0 #c74a31; }
  .state { font: 700 10.5px/1 ${UIFONT}; padding: 4px 8px; border-radius: 999px; background: rgba(29,26,23,.1); color: #1d1a17; }
  .state.typing { background: #e8654a; color: #fff; }
  .state.paused { background: #1d1a17; color: #f7f4ee; }
  .state.ok { background: #2e9e5b; color: #fff; }
  .state.stopped { background: #c0392b; color: #fff; }
  .target { font: 500 11.5px/1.2 ${UIFONT}; color: rgba(29,26,23,.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .barwrap { height: 8px; border-radius: 4px; background: rgba(29,26,23,.1); overflow: hidden; }
  #bar { height: 100%; width: 0%; background: #e8654a; border-radius: 4px; transition: width 120ms linear; }
  .stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .stats label { display: block; font: 500 10px/1 ${UIFONT}; color: rgba(29,26,23,.55); margin-bottom: 3px; }
  .stats b { font: 800 15px/1 ${UIFONT}; font-variant-numeric: tabular-nums; }
  .stats .left b { color: #e8654a; }
  #controls, #doneRow { display: flex; gap: 6px; }
  .btn { flex: 1; padding: 9px; border-radius: 9px; background: #fff; border: 1px solid rgba(29,26,23,.12);
    cursor: pointer; font: 700 12px/1 ${UIFONT}; color: #1d1a17; transition: border-color .12s, box-shadow .12s, transform .05s; }
  .btn:hover { border-color: #e8654a; }
  .btn:active { transform: translateY(1px); }
  .btn:focus-visible { outline: none; border-color: #e8654a; box-shadow: 0 0 0 2px rgba(232,101,74,.14); }
  .btn.stop { color: #c0392b; }
  `;
})();
