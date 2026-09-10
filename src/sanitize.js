/*
 * Text sanitizer — reduce whatever was pasted to plain, typeable text.
 *
 * - Normalizes line endings (\r\n, \r, U+2028/2029 → \n)
 * - Unicode NFKC (ligatures → letters, fullwidth → ASCII, … → ..., etc.)
 * - Typographic quotes → straight quotes, exotic spaces → plain space
 * - Drops control characters (except \n and \t), invisible format characters
 *   (zero-width joiners/spaces, BOM, soft hyphen, bidi marks), private-use,
 *   unassigned code points and lone surrogates
 * - Trims trailing whitespace on each line and blank lines at both ends
 *
 * Shared by the popup (on paste/input) and the content script (before typing).
 * Exposes globalThis.HTSanitize.sanitize(text)
 */
(function (root) {
  'use strict';

  const QUOTES = {
    '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '‵': "'",
    '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '‶': '"',
    '«': '"', '»': '"', '‹': "'", '›': "'",
  };
  const QUOTE_RE = /[‘’‚‛′‵“”„‟″‶«»‹›]/g;
  // Every Unicode "space separator" plus NBSP-likes → a normal space.
  const SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
  // Cc = control, Cf = format (invisible), Co = private use, Cn = unassigned, Cs = surrogate.
  const JUNK_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu;

  function sanitize(text) {
    if (text == null) return '';
    let t = String(text);
    t = t.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n');
    try { t = t.normalize('NFKC'); } catch (_) { /* ignore */ }
    t = t.replace(QUOTE_RE, (m) => QUOTES[m] || m);
    t = t.replace(SPACE_RE, ' ');
    t = t.replace(JUNK_RE, (m) => (m === '\n' || m === '\t') ? m : '');
    t = t.replace(/[ \t]+$/gm, '');            // trailing whitespace per line
    t = t.replace(/^\n+/, '').replace(/\n+$/, ''); // leading / trailing blank lines
    return t;
  }

  root.HTSanitize = { sanitize };
})(typeof globalThis !== 'undefined' ? globalThis : this);
