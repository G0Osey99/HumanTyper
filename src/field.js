/*
 * Field adapters — insert/backspace text into real DOM fields the way a
 * keyboard would, firing the events sites (React/Vue/plain) listen for.
 *
 * These DOM adapters are the *fallback* driver, used only when the universal
 * driver (trusted keystrokes through chrome.debugger, see background.js)
 * cannot attach — e.g. DevTools is already open on the tab.
 *
 * Supports <input> (text-like), <textarea>, and contenteditable editors.
 * Exposes globalThis.HTField = { isEditable, resolveEditable, makeField }
 */
(function (root) {
  'use strict';

  const EDITABLE_INPUT_TYPES = new Set([
    'text', 'search', 'url', 'tel', 'email', 'password', 'number', '',
  ]);

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return EDITABLE_INPUT_TYPES.has(t) && !el.disabled && !el.readOnly;
    }
    return false;
  }

  // Resolve the editable "host": for a click inside contenteditable, climb to
  // the element that actually carries the contenteditable attribute.
  function resolveEditable(el) {
    if (!el) return null;
    if (el.nodeType === 3) el = el.parentElement;
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return isEditable(el) ? el : null;
    }
    if (el.isContentEditable) {
      let host = el;
      let p = el.parentElement;
      while (p && p.isContentEditable) { host = p; p = p.parentElement; }
      const attrHost = el.closest('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]');
      return attrHost || host;
    }
    return null;
  }

  // --- key events ------------------------------------------------------------
  function keyInit(ch) {
    const init = { bubbles: true, cancelable: true, composed: true };
    if (ch === '\n') return Object.assign(init, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
    if (ch === '\t') return Object.assign(init, { key: 'Tab', code: 'Tab', keyCode: 9, which: 9 });
    const upper = ch.toUpperCase();
    const code = /[a-z]/i.test(ch) ? 'Key' + upper
      : /[0-9]/.test(ch) ? 'Digit' + ch
      : ch === ' ' ? 'Space' : '';
    const kc = ch === ' ' ? 32 : upper.charCodeAt(0);
    return Object.assign(init, {
      key: ch, code, keyCode: kc, which: kc,
      shiftKey: /[A-Z]/.test(ch),
    });
  }
  function fireKey(el, ch) {
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', keyInit(ch)));
      el.dispatchEvent(new KeyboardEvent('keyup', keyInit(ch)));
    } catch (_) { /* ignore */ }
  }
  function fireBackspaceKey(el) {
    const init = { bubbles: true, cancelable: true, composed: true, key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8 };
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
    } catch (_) { /* ignore */ }
  }

  // --- <input>/<textarea> adapter ------------------------------------------
  class InputField {
    constructor(el) {
      this.el = el;
      this.kind = 'input';
      this.multiline = el.tagName === 'TEXTAREA';
      const proto = this.multiline ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      this.setValue = Object.getOwnPropertyDescriptor(proto, 'value').set;
    }
    label() {
      const el = this.el;
      const hint = el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '';
      return (this.multiline ? 'textarea' : 'input') + (hint ? ` · ${hint}` : '');
    }
    focus() {
      this.el.focus();
      const n = this.el.value.length;
      try { this.el.setSelectionRange(n, n); } catch (_) { /* number inputs */ }
    }
    caret() {
      const s = this.el.selectionStart, e = this.el.selectionEnd;
      if (s == null || e == null) return [this.el.value.length, this.el.value.length];
      return [s, e];
    }
    insert(str) {
      if (!this.multiline) str = str.replace(/\n/g, ' ');
      const el = this.el;
      const [s, e] = this.caret();
      const v = el.value;
      const next = v.slice(0, s) + str + v.slice(e);
      fireKey(el, str[str.length - 1] || ' ');
      this.setValue.call(el, next);
      const pos = s + str.length;
      try { el.setSelectionRange(pos, pos); } catch (_) { /* */ }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: str }));
    }
    // Whole-word deletion in the DOM fallback: remove `k` chars in one edit.
    deleteWord(k) {
      const el = this.el;
      let [s, e] = this.caret();
      if (s === e) s = Math.max(0, s - k);
      const v = el.value;
      const next = v.slice(0, s) + v.slice(e);
      fireBackspaceKey(el);
      this.setValue.call(el, next);
      try { el.setSelectionRange(s, s); } catch (_) { /* */ }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteWordBackward', data: null }));
    }
    backspace() {
      const el = this.el;
      let [s, e] = this.caret();
      if (s === e) { if (s === 0) return; s = s - 1; }
      const v = el.value;
      const next = v.slice(0, s) + v.slice(e);
      fireBackspaceKey(el);
      this.setValue.call(el, next);
      try { el.setSelectionRange(s, s); } catch (_) { /* */ }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward', data: null }));
    }
  }

  // --- contenteditable adapter ---------------------------------------------
  class ContentEditableField {
    constructor(el) { this.el = el; this.kind = 'contenteditable'; this.doc = el.ownerDocument; }
    label() {
      const el = this.el;
      const hint = el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || el.getAttribute('role') || el.id || '';
      return 'editor' + (hint ? ` · ${hint}` : '');
    }
    focus() {
      this.el.focus();
      try {
        const sel = this.doc.getSelection();
        const range = this.doc.createRange();
        range.selectNodeContents(this.el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) { /* */ }
    }
    _exec(cmd, val) {
      try { return this.doc.execCommand(cmd, false, val); } catch (_) { return false; }
    }
    _fire(type, data) {
      try {
        this.el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: type, data }));
      } catch (_) { /* */ }
    }
    insert(str) {
      const el = this.el;
      fireKey(el, str[str.length - 1] || ' ');
      if (str === '\n') {
        // Prefer a paragraph break (what Enter does in most editors); fall back
        // to a line break, then to a raw newline.
        const ok = this._exec('insertParagraph') || this._exec('insertLineBreak') || this._exec('insertText', '\n');
        if (!ok) this._rangeInsert('\n');
        // execCommand already fires a trusted `input`; only fire ours on the manual path.
        if (!ok) this._fire('insertParagraph', null);
      } else {
        const ok = this._exec('insertText', str);
        if (!ok) { this._rangeInsert(str); this._fire('insertText', str); }
      }
    }
    _rangeInsert(str) {
      try {
        const sel = this.doc.getSelection();
        if (!sel.rangeCount) this.focus();
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = this.doc.createTextNode(str);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) { /* */ }
    }
    // Whole-word deletion: contenteditable editors disagree on what a word
    // is, so delete the exact number of characters, one edit each.
    deleteWord(k) {
      while (k-- > 0) this.backspace();
    }
    backspace() {
      fireBackspaceKey(this.el);
      const ok = this._exec('delete');
      if (!ok) {
        try {
          const sel = this.doc.getSelection();
          if (sel.rangeCount) {
            const range = sel.getRangeAt(0);
            if (range.collapsed && range.startOffset > 0) range.setStart(range.startContainer, range.startOffset - 1);
            range.deleteContents();
          }
        } catch (_) { /* */ }
        this._fire('deleteContentBackward', null);
      }
    }
  }

  function makeField(el) {
    const host = resolveEditable(el);
    if (!host) return null;
    if (host.tagName === 'INPUT' || host.tagName === 'TEXTAREA') return new InputField(host);
    return new ContentEditableField(host);
  }

  root.HTField = { isEditable, resolveEditable, makeField };
})(typeof globalThis !== 'undefined' ? globalThis : this);
