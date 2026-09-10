/*
 * HumanTyper background service worker — router + universal keystroke driver.
 *
 * Universal driver ("cdp"): we attach Chrome's debugger to the tab and emit
 * keystrokes with Input.dispatchKeyEvent / Input.insertText. Those are real,
 * trusted key events handled by whatever has focus — plain inputs, any
 * contenteditable editor, Google Docs' hidden input frame, Word on the web's
 * cross-origin editing frame, canvas editors… with no site-specific code.
 * (This is exactly how Puppeteer / Playwright type.)
 *
 * Fallback driver ("dom"): if the debugger can't attach (DevTools already
 * open on the tab, permission denied) the frame holding the caret types
 * through the DOM adapters in field.js instead.
 *
 * Frames: the content script runs in every frame and reports when an editable
 * holds the caret (HT_CARET). We remember the latest frame per tab. A start
 * request first asks that frame to put focus back on its field (HT_FOCUS),
 * then the top frame runs the timing engine + HUD and asks us for each
 * keystroke (HT_KEY). If no frame has a target, the tab is "armed": a banner
 * shows and the very next caret report from ANY frame starts typing there.
 */
'use strict';

const caretFrame = {};   // tabId -> { frameId, ts }
const pending = {};      // tabId -> { payload, cdp }  (armed, waiting for a caret)
const typingFrame = {};  // tabId -> frameId running the engine
const attached = {};     // tabId -> true while the debugger is attached
const MAX_AGE = 30 * 60 * 1000;

function send(tabId, frameId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => null);
}
const toTop = (tabId, msg) => send(tabId, 0, msg);

// ---- debugger ---------------------------------------------------------------
async function attach(tabId) {
  if (attached[tabId]) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached[tabId] = true;
    return true;
  } catch (_) { return false; }
}
async function detach(tabId) {
  if (!attached[tabId]) return;
  delete attached[tabId];
  try { await chrome.debugger.detach({ tabId }); } catch (_) { /* already gone */ }
}
chrome.debugger.onDetach.addListener((source) => {
  // User dismissed the "is debugging this browser" bar, or DevTools took over.
  const tabId = source.tabId;
  if (tabId == null || !attached[tabId]) return;
  delete attached[tabId];
  if (typingFrame[tabId] != null) send(tabId, typingFrame[tabId], { type: 'HT_STOP', reason: 'Debugger closed' });
});
const cmd = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

// Key metadata for a printable character (US layout; only used for the
// `code`/virtual key hints — the inserted text is what matters).
function keyMeta(ch) {
  const upper = ch.toUpperCase();
  const isLetter = /^[a-z]$/i.test(ch);
  const code = isLetter ? 'Key' + upper : /^[0-9]$/.test(ch) ? 'Digit' + ch : ch === ' ' ? 'Space' : '';
  const vk = isLetter || /^[0-9]$/.test(ch) ? upper.charCodeAt(0) : ch === ' ' ? 32 : 0;
  return { code, vk, shift: /^[A-Z]$/.test(ch) };
}
const IS_MAC = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
async function keyOp(tabId, m) {
  if (m.op === 'deleteWord') {
    // Option+Backspace on macOS, Ctrl+Backspace elsewhere (CDP modifiers: Alt=1, Ctrl=2).
    // On macOS also name the editing command explicitly (as Puppeteer does), so
    // the renderer runs deleteWordBackward even where the key binding isn't consulted.
    const k = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: IS_MAC ? 1 : 2 };
    if (IS_MAC) k.commands = ['deleteWordBackward'];
    await cmd(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, k));
    await cmd(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k));
    return;
  }
  if (m.op === 'backspace') {
    const k = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
    await cmd(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, k));
    await cmd(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k));
    return;
  }
  const ch = m.ch;
  if (ch === '\n') {
    const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cmd(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyDown', text: '\r', unmodifiedText: '\r' }, k));
    await cmd(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k));
    return;
  }
  if (ch === '\t' || ch.codePointAt(0) > 0xFFFF) {
    // A real Tab key would move focus; emoji have no key. Commit as IME text.
    await cmd(tabId, 'Input.insertText', { text: ch });
    return;
  }
  const { code, vk, shift } = keyMeta(ch);
  const k = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
  await cmd(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyDown', text: ch, unmodifiedText: ch.toLowerCase() }, k));
  await cmd(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k));
}

// ---- starting ---------------------------------------------------------------
function began(tabId, frameId) {
  typingFrame[tabId] = frameId;
  delete pending[tabId];
  toTop(tabId, { type: 'HT_ARM', on: false });
}
async function startWith(tabId, frameId, payload, cdp) {
  if (cdp) {
    // The caret frame puts focus back on its field; the top frame runs the engine.
    const f = await send(tabId, frameId, { type: 'HT_FOCUS' });
    if (!f || !f.ok) return false;
    const res = await toTop(tabId, { type: 'HT_START', payload: Object.assign({}, payload, { driver: 'cdp', label: f.label }) });
    if (!res || !res.ok) return false;
    began(tabId, 0);
    return true;
  }
  const res = await send(tabId, frameId, { type: 'HT_START', payload: Object.assign({}, payload, { driver: 'dom' }) });
  if (!res || !res.ok) return false;
  began(tabId, frameId);
  return true;
}
async function routeStart(tabId, payload) {
  delete pending[tabId];
  if (typingFrame[tabId] != null) await send(tabId, typingFrame[tabId], { type: 'HT_STOP', reason: 'Restarted' });
  const cdp = payload.driver === 'dom' ? false : await attach(tabId);
  const rec = caretFrame[tabId];
  const candidates = [];
  if (rec && Date.now() - rec.ts < MAX_AGE) candidates.push(rec.frameId);
  if (!candidates.includes(0)) candidates.push(0);
  for (const fid of candidates) {
    if (await startWith(tabId, fid, payload, cdp)) return { ok: true, armed: false, driver: cdp ? 'cdp' : 'dom' };
  }
  pending[tabId] = { payload, cdp };
  await toTop(tabId, { type: 'HT_ARM', on: true });
  return { ok: true, armed: true, driver: cdp ? 'cdp' : 'dom' };
}
globalThis.HTRoute = routeStart; globalThis.HTAttached = attached; // test hooks

async function stopTab(tabId, reason) {
  delete pending[tabId];
  toTop(tabId, { type: 'HT_ARM', on: false });
  if (typingFrame[tabId] != null) await send(tabId, typingFrame[tabId], { type: 'HT_STOP', reason: reason || 'Stopped' });
  delete typingFrame[tabId];
  await detach(tabId);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  const tabId = sender.tab && sender.tab.id;
  const frameId = sender.frameId || 0;

  switch (msg.type) {
    case 'HT_CARET': {
      if (tabId == null) return;
      caretFrame[tabId] = { frameId, ts: Date.now() };
      const p = pending[tabId];
      if (p) {
        delete pending[tabId];
        startWith(tabId, frameId, p.payload, p.cdp).then((ok) => { if (!ok) pending[tabId] = p; });
      }
      return;
    }
    case 'HT_ROUTE_START':
      routeStart(msg.tabId, msg.payload || {}).then(sendResponse);
      return true;
    case 'HT_KEY':               // top frame engine -> one real keystroke
      if (tabId == null || !attached[tabId]) { sendResponse({ ok: false }); return; }
      keyOp(tabId, msg).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;
    case 'HT_DONE':              // engine finished (any reason) -> release the debugger
      if (tabId == null) return;
      delete typingFrame[tabId];
      detach(tabId);
      return;
    case 'HT_DISARM':
      if (tabId != null) { delete pending[tabId]; toTop(tabId, { type: 'HT_ARM', on: false }); detach(tabId); }
      return;
    case 'HT_HUD':               // iframe typist (dom fallback) -> top-frame HUD
      if (tabId == null) return;
      toTop(tabId, Object.assign({}, msg, { type: 'HT_HUD_UPDATE' }));
      return;
    case 'HT_CTRL':              // top-frame HUD -> iframe typist (dom fallback)
      if (tabId == null || typingFrame[tabId] == null) return;
      send(tabId, typingFrame[tabId], { type: 'HT_CTRL_DO', action: msg.action });
      return;
    case 'HT_STOP_TAB':
      stopTab(msg.tabId != null ? msg.tabId : tabId).then(() => sendResponse({ ok: true }));
      return true;
    default:
      return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete caretFrame[tabId]; delete pending[tabId]; delete typingFrame[tabId]; delete attached[tabId];
});
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) { delete caretFrame[d.tabId]; delete pending[d.tabId]; delete typingFrame[d.tabId]; detach(d.tabId); }
});
