/*
 * HumanTyping engine — a JavaScript port of the Lax3n/HumanTyping
 * Markov-chain typing model (https://github.com/Lax3n/HumanTyping), extended
 * with a physical keyboard geometry, a richer error model and a calibrated
 * speed/rhythm model. See AUDIT notes in the README for what changed and why.
 *
 * The model computes a full "history" of timed events for a target string:
 *   [ t (seconds), action, resultingText ]
 * which a player then replays into a real DOM field. Every event is exactly
 * one keystroke (one character typed, or one Backspace).
 *
 * Works in both the browser (content script / popup) and Node (for tests):
 * exposes `globalThis.HumanTyping` and, if present, `module.exports`.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------
  const C = {
    DEFAULT_WPM: 60,
    WPM_STD: 10,
    AVG_WORD_LENGTH: 5,

    // --- errors -------------------------------------------------------------
    // Base per-character probability of a "slip" (before context multipliers).
    PROB_ERROR: 0.04,
    // Transposition ("the" -> "hte"), drawn separately.
    PROB_SWAP_ERROR: 0.012,
    // How the slip budget is split between slip kinds (weights, normalised).
    ERROR_MIX: { substitute: 0.55, omit: 0.22, insert: 0.13, missedShift: 0.10 },
    // Chance (relative to the slip budget) that a lowercase letter right after
    // a capital comes out capitalised too ("THe") — shift released late.
    SHIFT_SLIP_MULT: 1.5,
    // Space is never mis-hit as another key; it can only be dropped, and less
    // often than a letter is.
    SPACE_OMIT_MULT: 0.3,
    // Error probability scales mildly with typing speed: (wpm/60)^EXP.
    SPEED_ERROR_EXP: 0.4,
    SPEED_ERROR_MIN: 0.7,
    SPEED_ERROR_MAX: 1.5,

    // Noticing errors.
    PROB_NOTICE_ERROR: 0.85,   // error is the last char typed
    DRIFT_CORRECTION_PROB: 0.8, // error is 2+ chars back (per keystroke)

    // After a correction people slow down and are more careful for a few keys.
    CARE_WINDOW: 6,
    CARE_ERROR_MULT: 0.15,     // error multiplier right after a fix, ramps to 1
    CARE_SLOW_MULT: 1.3,       // speed multiplier right after a fix, ramps to 1

    // Word / character difficulty.
    COMPLEX_WORD_ERROR_MULT: 1.5,
    COMMON_WORD_ERROR_MULT: 0.5,
    COMPOSED_ACCENT_ERROR_MULT: 2.0,

    // Neighbor weighting for substitutions.
    NEIGHBOR_MAX_DIST: 1.3,    // physical key units
    NEIGHBOR_DIGIT_WEIGHT: 0.15,
    NEIGHBOR_SYMBOL_WEIGHT: 0.45,

    // --- speed / rhythm -----------------------------------------------------
    SPEED_BOOST_COMMON_WORD: 0.85,
    SPEED_PENALTY_COMPLEX_WORD: 1.15,
    SPEED_SAME_KEY: 0.85,          // "ll", "oo"
    SPEED_SAME_FINGER: 1.35,       // "de", "un", "ce" — same finger, different key
    SPEED_SAME_HAND: 1.05,
    SPEED_ALTERNATE_HAND: 0.85,
    SPEED_BIGRAM: 0.85,            // common bigram, on top of the above
    FAR_KEY_THRESHOLD: 3.5,
    FAR_KEY_PENALTY: 1.15,
    SPEED_DIGIT: 1.25,
    SPEED_PUNCT: 1.1,
    SPEED_SPACE: 1.1,
    SPEED_NEWLINE: 1.5,
    SPEED_UNKNOWN_CHAR: 2.0,       // characters not on the keyboard

    TIME_SHIFT_PENALTY: 0.12,      // seconds, any shifted key
    TIME_COMPOSED_ACCENT_PENALTY: 0.4,
    TIME_DIRECT_ACCENT_PENALTY: 0.15,

    // Keystroke intervals are log-normal (right-skewed), not Gaussian.
    KEYSTROKE_SIGMA: 0.22,
    MIN_KEYSTROKE_TIME: 0.025,
    MIN_SPEED_MULTIPLIER: 0.2,

    // Pauses (seconds, log-normal medians) — where humans actually hesitate.
    PAUSE_CHUNK_PROB: 0.18,        // glance back at the source between words
    PAUSE_CHUNK_MEDIAN: 0.45,
    PAUSE_SENTENCE_PROB: 0.85,     // after . ! ?
    PAUSE_SENTENCE_MEDIAN: 0.6,
    PAUSE_CLAUSE_PROB: 0.5,        // after , ; :
    PAUSE_CLAUSE_MEDIAN: 0.25,
    PAUSE_NEWLINE_MEDIAN: 0.9,     // before the first char of a new line
    PAUSE_SIGMA: 0.55,
    PAUSE_MAX: 3.0,

    // Corrections.
    TIME_REACTION_MEAN: 0.35,      // notice -> first backspace
    TIME_REACTION_STD: 0.1,
    TIME_BACKSPACE_MEAN: 0.12,     // first backspace
    TIME_BACKSPACE_STD: 0.02,
    TIME_BACKSPACE_REPEAT_MEAN: 0.085, // subsequent backspaces in a chain
    TIME_BACKSPACE_REPEAT_STD: 0.015,
    MIN_REACTION_TIME: 0.1,
    MIN_BACKSPACE_TIME: 0.03,

    // Whole-word deletion (Option/Ctrl+Backspace) instead of a backspace chain
    // when the slip is buried in the word and retyping is quicker.
    WORD_DELETE_PROB: 0.6,         // per correction that qualifies
    WORD_DELETE_MIN_TAIL: 3,       // chars from word start to the end of text
    WORD_DELETE_MIN_DEPTH: 2,      // chars from the slip to the end of text
    TIME_WORD_DELETE_MEAN: 0.2,    // the chord takes a beat longer than Backspace
    TIME_WORD_DELETE_STD: 0.04,

    // Slow drift: bursts and lulls (Ornstein–Uhlenbeck on log tempo).
    DRIFT_THETA: 0.06,
    DRIFT_SIGMA: 0.05,
    DRIFT_CLAMP: 0.5,              // |log tempo| cap

    // Warm-up: the first few keys are slower.
    WARMUP_KEYS: 8,
    WARMUP_SLOW: 1.35,

    // Fatigue: gentle slowdown over a long session.
    FATIGUE_FACTOR: 1.0003,
    FATIGUE_CAP: 1.25,

    // Calibration: scale the model so that net speed (chars/5 per minute,
    // including pauses and corrections) lands on the requested WPM.
    CALIBRATE_PASSES: 2,
    CALIBRATE_FULL_LENGTH: 80,     // chars; shorter texts calibrate less
    CALIBRATE_MIN: 0.35,
    CALIBRATE_MAX: 1.6,
  };

  // ---------------------------------------------------------------------------
  // Random helpers
  // ---------------------------------------------------------------------------
  function gaussian(mean, std) {
    if (std === 0) return mean;
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + n * std;
  }
  // Log-normal with the given *mean* (mean-preserving) and log-sigma.
  function lognormalMean(mean, sigma) {
    if (mean <= 0) return 0;
    return Math.exp(gaussian(Math.log(mean) - (sigma * sigma) / 2, sigma));
  }
  // Log-normal with the given *median*.
  function lognormalMedian(median, sigma) {
    return Math.exp(gaussian(Math.log(median), sigma));
  }
  function weightedChoice(items, weights) {
    let total = 0;
    for (const w of weights) total += w;
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
  const rand = Math.random;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  // ---------------------------------------------------------------------------
  // language.py
  // ---------------------------------------------------------------------------
  const COMMON_WORDS = new Set(
    ('the be to of and a in that have it for not on with he as you do at this ' +
      'but his by from they we say her she or an will my one all would there ' +
      'their what so up out if about who get which go me when make can like time ' +
      'no just him know take people into year your good some could them see other ' +
      'than then now look only come its over think also back after use two how our ' +
      'work first well way even new want because').split(' ')
  );

  const COMMON_BIGRAMS = new Set(
    ('th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ' +
      'ha as ou io le ve co me de hi ri ro ic ne ea ra ce').split(' ')
  );

  const PUNCTUATION_CHARS = ".,!?;:'\"-()[]{}/";
  const SENTENCE_END = '.!?';
  const CLAUSE_END = ',;:';
  const SHIFTED_SYMBOLS = '~!@#$%^&*()_+{}|:"<>?';

  function stripPunctuation(word) {
    let start = 0, end = word.length;
    while (start < end && PUNCTUATION_CHARS.includes(word[start])) start++;
    while (end > start && PUNCTUATION_CHARS.includes(word[end - 1])) end--;
    return word.slice(start, end);
  }

  function getWordDifficulty(word) {
    const wl = stripPunctuation(word.toLowerCase());
    if (COMMON_WORDS.has(wl)) return 'common';
    const isLong = wl.length > 8;
    const hasComplex = /[zxqj]/.test(wl);
    if (isLong || hasComplex) return 'complex';
    return 'normal';
  }

  function isCommonBigram(c1, c2) {
    return COMMON_BIGRAMS.has((c1 + c2).toLowerCase());
  }

  const isUpper = (ch) => ch !== ch.toLowerCase() && ch === ch.toUpperCase();
  const isLetter = (ch) => /\p{L}/u.test(ch);
  const isDigit = (ch) => /^[0-9]$/.test(ch);
  const isShifted = (ch) => isUpper(ch) || SHIFTED_SYMBOLS.includes(ch);

  // ---------------------------------------------------------------------------
  // keyboard.py — with physical geometry
  // ---------------------------------------------------------------------------
  // Rows are the physical key rows. ROW_OFFSET is the horizontal offset (in
  // key widths) of each row's first listed key, which reproduces the stagger
  // of a real keyboard so that e.g. "w" sits above and between "a" and "s".
  const LAYOUTS = {
    qwerty: {
      rows: ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./'],
      offsets: [0, 1.5, 1.75, 2.25],
    },
    azerty: {
      rows: ['&é"\'(-è_çà)=', 'azertyuiop^$', 'qsdfghjklmù*', 'wxcvbn,;:!'],
      offsets: [1, 1.5, 1.75, 2.25],
    },
  };

  // Touch-typing finger for a physical key, by row + column index.
  // 0-4 = left pinky..index (4=pinky, 1=index), 5-9 = right index..pinky.
  const FINGER_BY_COL = {
    top: [4, 4, 4, 3, 2, 1, 1, 5, 6, 7, 8, 8, 8, 8],   // number row (col 0 = key left of "1")
    main: [4, 3, 2, 1, 1, 5, 5, 6, 7, 8, 8, 8, 8, 8],  // letter rows
  };
  const fingerHand = (f) => (f == null ? null : f <= 4 ? 'L' : 'R');

  class KeyboardLayout {
    constructor(name = 'qwerty') {
      if (!LAYOUTS[name]) throw new Error(`Unsupported layout: ${name}`);
      this.layoutName = name;
      const def = LAYOUTS[name];
      this.grid = def.rows.map((row) => row.split(''));
      this.offsets = def.offsets;
      this.posMap = this._buildPosMap();

      if (name === 'azerty') {
        this.directAccents = new Set('éèàùç'.split(''));
        this.composedAccents = new Set('âêîôûäëïöü'.split(''));
      } else {
        this.directAccents = new Set();
        this.composedAccents = new Set('âêîôûäëïöüéèàùç'.split(''));
      }
      this._neighborCache = new Map();
    }

    _buildPosMap() {
      const map = new Map();
      this.grid.forEach((row, r) => {
        row.forEach((ch, c) => {
          const table = r === 0 ? FINGER_BY_COL.top : FINGER_BY_COL.main;
          const col = this.layoutName === 'azerty' && r === 0 ? c + 1 : c;
          map.set(ch, {
            r, c, x: this.offsets[r] + c, y: r,
            finger: table[Math.min(col, table.length - 1)],
          });
        });
      });
      if (this.layoutName === 'azerty') {
        const row0 = '&é"\'(-è_çà)';
        const digits = '1234567890';
        for (let i = 0; i < digits.length; i++) {
          const base = row0[i];
          if (map.has(base) && !map.has(digits[i])) map.set(digits[i], map.get(base));
        }
      }
      return map;
    }

    _normalizeChar(ch) {
      ch = ch.toLowerCase();
      if (this.composedAccents.has(ch)) {
        return ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      }
      return ch;
    }

    _pos(ch) {
      return this.posMap.get(this._normalizeChar(ch)) || null;
    }

    hasKey(ch) {
      return this.posMap.has(this._normalizeChar(ch));
    }

    /** Finger id for a key (see FINGER_BY_COL); space = thumb (null hand). */
    getFinger(ch) {
      if (ch === ' ') return 'thumb';
      const p = this._pos(ch);
      return p ? p.finger : null;
    }

    /** Physical (Euclidean) distance between two keys in key widths. */
    getDistance(c1, c2) {
      const p1 = this._pos(c1), p2 = this._pos(c2);
      if (!p1 || !p2) return C.FAR_KEY_THRESHOLD;
      return Math.hypot(p1.x - p2.x, p1.y - p2.y);
    }

    /**
     * Keys physically adjacent to `ch`, each with a weight proportional to how
     * likely a slip lands on it: closer keys weigh more, digits and symbols
     * weigh less than letters (fingers rarely stray up to the number row).
     */
    getWeightedNeighbors(ch) {
      const n = this._normalizeChar(ch);
      if (this._neighborCache.has(n)) return this._neighborCache.get(n);
      const p = this.posMap.get(n);
      const out = [];
      if (p) {
        for (const [key, q] of this.posMap) {
          if (key === n || q === p) continue;
          const d = Math.hypot(p.x - q.x, p.y - q.y);
          if (d > C.NEIGHBOR_MAX_DIST) continue;
          let w = 1 / (d * d);
          if (isDigit(key)) w *= C.NEIGHBOR_DIGIT_WEIGHT;
          else if (!isLetter(key)) w *= C.NEIGHBOR_SYMBOL_WEIGHT;
          out.push({ key, w });
        }
      }
      this._neighborCache.set(n, out);
      return out;
    }

    getNeighborKeys(ch) {
      return this.getWeightedNeighbors(ch).map((x) => x.key);
    }

    /** A plausible mis-hit for `ch`, or null if there is none (e.g. space). */
    getRandomNeighbor(ch) {
      const nb = this.getWeightedNeighbors(ch);
      if (nb.length === 0) return null;
      const pick = weightedChoice(nb, nb.map((x) => x.w));
      return isUpper(ch) ? pick.key.toUpperCase() : pick.key;
    }

    isDirectAccent(ch) {
      return this.directAccents.has(ch.toLowerCase());
    }
    isComposedAccent(ch) {
      return this.composedAccents.has(ch.toLowerCase());
    }
  }

  // ---------------------------------------------------------------------------
  // typer.py — MarkovTyper
  // ---------------------------------------------------------------------------
  class MarkovTyper {
    /**
     * @param {string} targetText
     * @param {object} opts
     *   wpm            {number}  target *net* words-per-minute (default 60):
     *                            chars/5 per minute including pauses and fixes
     *   layout         {string}  'qwerty' | 'azerty'
     *   mistakes       {boolean} enable typos + corrections (default true)
     *   errorIntensity {number}  multiplier on error probabilities (default 1)
     *   fatigue        {boolean} enable gradual slowdown (default true)
     *   rhythm         {boolean} variable speed / pauses (default true)
     *   sessionVariance{boolean} randomise session WPM around target (default true)
     *   calibrate      {boolean} scale the model so net speed hits wpm (default true)
     */
    constructor(targetText, opts = {}) {
      if (typeof targetText !== 'string' || targetText.length === 0) {
        throw new Error('targetText must be a non-empty string');
      }
      const wpm = opts.wpm == null ? C.DEFAULT_WPM : opts.wpm;
      if (typeof wpm !== 'number' || wpm <= 0) {
        throw new Error('wpm must be a positive number');
      }

      this.o = {
        wpm,
        layout: opts.layout || 'qwerty',
        mistakes: opts.mistakes !== false,
        errorIntensity: opts.errorIntensity == null ? 1 : opts.errorIntensity,
        fatigue: opts.fatigue !== false,
        rhythm: opts.rhythm !== false,
        sessionVariance: opts.sessionVariance !== false,
        calibrate: opts.calibrate !== false,
      };

      this.targetText = targetText;
      this.keyboard = new KeyboardLayout(this.o.layout);
      this._wordAt = MarkovTyper._indexWords(targetText);

      const std = this.o.sessionVariance ? C.WPM_STD : 0;
      this.sessionWpm = Math.max(10, gaussian(wpm, std));
      this.baseKeystrokeTime = 60 / (this.sessionWpm * C.AVG_WORD_LENGTH);

      const speedMult = this.o.rhythm
        ? clamp(Math.pow(this.sessionWpm / 60, C.SPEED_ERROR_EXP), C.SPEED_ERROR_MIN, C.SPEED_ERROR_MAX)
        : 1;
      this.probError = this.o.mistakes ? C.PROB_ERROR * this.o.errorIntensity * speedMult : 0;
      this.probSwap = this.o.mistakes ? C.PROB_SWAP_ERROR * this.o.errorIntensity * speedMult : 0;

      // Calibration factors (1 = raw model). Set by _calibrate(), or passed
      // in (opts.tempo / opts.pauseScale) to reuse a previous calibration.
      this.tempo = opts.tempo > 0 ? opts.tempo : 1;
      this.pauseScale = opts.pauseScale > 0 ? opts.pauseScale : 1;

      this._reset();
      if (this.o.calibrate && !(opts.tempo > 0)) this._calibrate();
    }

    _reset() {
      this.state = {
        currentText: '',
        totalTime: 0.0,
        history: [],
        lastCharTyped: null,
        fatigueMultiplier: 1.0,
        mentalCursorPos: 0,
        keysTyped: 0,
        careLeft: 0,
        logDrift: 0,
        correcting: false,   // inside a backspace chain
        lastWasBackspace: false,
        wordDeleteDecided: false, // one word-delete decision per correction
      };
      this.state.history.push([0.0, `INIT (WPM: ${this.sessionWpm.toFixed(1)})`, '']);
    }

    // Net speed of the raw model depends on the text (punctuation density,
    // capitals, word difficulty…), so measure it on this text and rescale.
    _calibrate() {
      for (let pass = 0; pass < C.CALIBRATE_PASSES; pass++) {
        const { totalTime } = this.run();
        if (!(totalTime > 0)) break;
        const netWpm = (this.targetText.length / C.AVG_WORD_LENGTH) / (totalTime / 60);
        // One run of a short text is a noisy sample: trust it proportionally.
        const weight = Math.min(1, this.targetText.length / C.CALIBRATE_FULL_LENGTH);
        const ratio = Math.pow(netWpm / this.sessionWpm, weight);
        this.tempo = clamp(this.tempo * ratio, C.CALIBRATE_MIN, C.CALIBRATE_MAX);
        // Voluntary pauses shrink for fast typists too, but less than linearly.
        this.pauseScale = clamp(this.pauseScale * Math.sqrt(ratio), C.CALIBRATE_MIN, C.CALIBRATE_MAX);
        this._reset();
      }
    }

    // Word containing each index (space-delimited; a space belongs to the word
    // before it), precomputed once so step() is O(1).
    static _indexWords(text) {
      const out = new Array(text.length);
      let start = 0;
      for (let i = 0; i <= text.length; i++) {
        if (i === text.length || text[i] === ' ') {
          const word = text.slice(start, i);
          for (let k = start; k < i; k++) out[k] = word;
          if (i < text.length) out[i] = word;
          start = i + 1;
        }
      }
      return out;
    }

    _currentWordContext() {
      const idx = this.state.mentalCursorPos;
      if (idx >= this.targetText.length) return null;
      return this._wordAt[idx] || null;
    }

    // Slow tempo drift: bursts and lulls over a few dozen keystrokes.
    _driftMultiplier() {
      const s = this.state;
      if (!this.o.rhythm) return 1;
      s.logDrift = clamp(
        s.logDrift * (1 - C.DRIFT_THETA) + gaussian(0, C.DRIFT_SIGMA),
        -C.DRIFT_CLAMP, C.DRIFT_CLAMP
      );
      return Math.exp(s.logDrift);
    }

    _warmupMultiplier() {
      const k = this.state.keysTyped;
      if (!this.o.rhythm || k >= C.WARMUP_KEYS) return 1;
      return 1 + (C.WARMUP_SLOW - 1) * ((C.WARMUP_KEYS - k) / C.WARMUP_KEYS);
    }

    _careFraction() {
      return this.state.careLeft > 0 ? this.state.careLeft / C.CARE_WINDOW : 0;
    }

    // Pause a human makes *before* this character: looking back at the source
    // between chunks, after sentence/clause punctuation, at a new line.
    _pauseBefore(idx) {
      if (!this.o.rhythm || idx === 0) return 0;
      const t = this.targetText;
      const prev = t[idx - 1];
      let median = 0, prob = 0;
      if (prev === '\n') {
        median = C.PAUSE_NEWLINE_MEDIAN; prob = 1;
      } else if (prev === ' ') {
        const before = idx >= 2 ? t[idx - 2] : '';
        if (SENTENCE_END.includes(before)) { median = C.PAUSE_SENTENCE_MEDIAN; prob = C.PAUSE_SENTENCE_PROB; }
        else if (CLAUSE_END.includes(before)) { median = C.PAUSE_CLAUSE_MEDIAN; prob = C.PAUSE_CLAUSE_PROB; }
        else { median = C.PAUSE_CHUNK_MEDIAN; prob = C.PAUSE_CHUNK_PROB; }
      }
      if (!prob || rand() >= prob) return 0;
      return Math.min(C.PAUSE_MAX, lognormalMedian(median, C.PAUSE_SIGMA)) * this.pauseScale;
    }

    _calcKeystrokeTime(ch, { intended = ch } = {}) {
      const s = this.state;
      let t = this.baseKeystrokeTime * this.tempo * s.fatigueMultiplier;
      t *= this._driftMultiplier() * this._warmupMultiplier();
      t *= 1 + (C.CARE_SLOW_MULT - 1) * this._careFraction();
      let extra = 0;

      if (this.o.rhythm) {
        const word = this._currentWordContext();
        if (word) {
          const diff = getWordDifficulty(word);
          if (diff === 'common') t *= C.SPEED_BOOST_COMMON_WORD;
          else if (diff === 'complex') t *= C.SPEED_PENALTY_COMPLEX_WORD;
        }

        const prev = s.lastCharTyped;
        if (prev && prev !== '\n') {
          if (prev.toLowerCase() === ch.toLowerCase()) {
            t *= C.SPEED_SAME_KEY;
          } else {
            const f1 = this.keyboard.getFinger(prev), f2 = this.keyboard.getFinger(ch);
            if (f1 != null && f2 != null && f1 !== 'thumb' && f2 !== 'thumb') {
              if (f1 === f2) t *= C.SPEED_SAME_FINGER;
              else if (fingerHand(f1) === fingerHand(f2)) t *= C.SPEED_SAME_HAND;
              else t *= C.SPEED_ALTERNATE_HAND;
              if (this.keyboard.getDistance(prev, ch) > C.FAR_KEY_THRESHOLD) t *= C.FAR_KEY_PENALTY;
            }
            if (isCommonBigram(prev, ch)) t *= C.SPEED_BIGRAM;
          }
        }

        if (ch === ' ') t *= C.SPEED_SPACE;
        else if (ch === '\n') t *= C.SPEED_NEWLINE;
        else if (isDigit(ch)) t *= C.SPEED_DIGIT;
        else if (!isLetter(ch)) t *= C.SPEED_PUNCT;

        if (this.keyboard.isComposedAccent(ch)) extra += C.TIME_COMPOSED_ACCENT_PENALTY;
        else if (this.keyboard.isDirectAccent(ch)) extra += C.TIME_DIRECT_ACCENT_PENALTY;
        else if (isShifted(ch)) extra += C.TIME_SHIFT_PENALTY * this.tempo;
      }

      t = Math.max(C.MIN_SPEED_MULTIPLIER * this.baseKeystrokeTime * this.tempo, t);
      const dt = lognormalMean(t, this.o.rhythm ? C.KEYSTROKE_SIGMA : C.KEYSTROKE_SIGMA / 2) + extra;
      return Math.max(C.MIN_KEYSTROKE_TIME, dt);
    }

    // Would a typist wipe the whole word here? Only when the tail of the text
    // is a plain run of letters/digits preceded by a space or the start of the
    // text (so Option/Ctrl+Backspace deletes exactly that run in any editor),
    // the slip sits inside it, and it's long enough to be worth the chord.
    // Returns { start } or null. Decided once per correction.
    _wordDeleteSpan(firstErrorPos) {
      const s = this.state;
      if (!this.o.mistakes || s.wordDeleteDecided) return null;
      s.wordDeleteDecided = true;
      const cur = s.currentText;
      let start = cur.length;
      while (start > 0 && /[\p{L}\p{N}]/u.test(cur[start - 1])) start--;
      if (start > 0 && cur[start - 1] !== ' ') return null;
      const tail = cur.length - start;
      if (tail < C.WORD_DELETE_MIN_TAIL) return null;
      if (firstErrorPos < start) return null;                       // slip is in an earlier word
      if (cur.length - firstErrorPos < C.WORD_DELETE_MIN_DEPTH) return null; // one Backspace will do
      if (!this.targetText.startsWith(cur.slice(0, start))) return null;
      if (rand() >= C.WORD_DELETE_PROB) return null;
      return { start };
    }

    _bumpFatigue() {
      if (!this.o.fatigue) return;
      this.state.fatigueMultiplier = Math.min(
        C.FATIGUE_CAP,
        this.state.fatigueMultiplier * C.FATIGUE_FACTOR
      );
    }

    // Append one typed character as its own event. `pause` is the hesitation
    // before the intended character (see _pauseBefore), applied once per step.
    _emit(ch, label, pause = 0) {
      const s = this.state;
      const dt = this._calcKeystrokeTime(ch) + pause;
      s.totalTime += dt;
      s.currentText += ch;
      s.lastCharTyped = ch;
      s.keysTyped++;
      if (s.careLeft > 0) s.careLeft--;
      s.lastWasBackspace = false;
      const event = [s.totalTime, `${label} '${ch}'`, s.currentText];
      s.history.push(event);
      return event;
    }

    step() {
      const s = this.state;
      const target = this.targetText;

      if (s.currentText === target) return null;

      // --- monitoring & correction ---
      let firstErrorPos = target.length;
      const minLen = Math.min(s.currentText.length, target.length);
      for (let i = 0; i < minLen; i++) {
        if (s.currentText[i] !== target[i]) { firstErrorPos = i; break; }
      }

      if (firstErrorPos < s.currentText.length) {
        let shouldCorrect = false;

        if (s.correcting) {
          shouldCorrect = true;
        } else if (s.mentalCursorPos >= target.length) {
          shouldCorrect = true;
        } else if (s.currentText.length > 0) {
          const lastChar = s.currentText[s.currentText.length - 1];
          const distance = s.currentText.length - firstErrorPos;
          if (' \n\t.,;!?:()[]{}<>"\''.includes(lastChar)) {
            shouldCorrect = true;
          } else if (distance >= 2) {
            if (rand() < C.DRIFT_CORRECTION_PROB) shouldCorrect = true;
          } else if (distance === 1) {
            if (rand() < C.PROB_NOTICE_ERROR) shouldCorrect = true;
          }
        }

        if (shouldCorrect) {
          const wordDel = this._wordDeleteSpan(firstErrorPos);
          if (wordDel) {
            let dt = s.correcting ? 0
              : Math.max(C.MIN_REACTION_TIME, gaussian(C.TIME_REACTION_MEAN, C.TIME_REACTION_STD));
            dt += Math.max(C.MIN_BACKSPACE_TIME, gaussian(C.TIME_WORD_DELETE_MEAN, C.TIME_WORD_DELETE_STD));
            s.totalTime += dt;
            s.currentText = s.currentText.slice(0, wordDel.start);
            s.mentalCursorPos = s.currentText.length;
            s.lastCharTyped = s.currentText.length ? s.currentText[s.currentText.length - 1] : null;
            s.lastWasBackspace = true;
            s.correcting = false;           // the word start is always a clean prefix
            s.wordDeleteDecided = false;
            s.careLeft = C.CARE_WINDOW;
            const event = [s.totalTime, 'DELETE_WORD', s.currentText];
            s.history.push(event);
            return event;
          }
          let dt;
          if (!s.correcting) {
            dt = Math.max(C.MIN_REACTION_TIME, gaussian(C.TIME_REACTION_MEAN, C.TIME_REACTION_STD));
            dt += Math.max(C.MIN_BACKSPACE_TIME, gaussian(C.TIME_BACKSPACE_MEAN, C.TIME_BACKSPACE_STD));
          } else {
            dt = Math.max(C.MIN_BACKSPACE_TIME, gaussian(C.TIME_BACKSPACE_REPEAT_MEAN, C.TIME_BACKSPACE_REPEAT_STD));
          }
          s.totalTime += dt;
          s.currentText = s.currentText.slice(0, -1);
          s.mentalCursorPos = s.currentText.length;
          s.lastCharTyped = s.currentText.length ? s.currentText[s.currentText.length - 1] : null;
          s.lastWasBackspace = true;
          // Chain continues until the text is a clean prefix of the target.
          s.correcting = !target.startsWith(s.currentText);
          if (!s.correcting) { s.careLeft = C.CARE_WINDOW; s.wordDeleteDecided = false; }
          const event = [s.totalTime, 'BACKSPACE', s.currentText];
          s.history.push(event);
          return event;
        }
      }

      // --- typing ---
      if (s.mentalCursorPos > s.currentText.length) {
        s.mentalCursorPos = s.currentText.length;
      }
      if (s.mentalCursorPos >= target.length) return null;

      const charIntended = target[s.mentalCursorPos];
      const onKeyboard = this.keyboard.hasKey(charIntended);

      // Characters not on the keyboard (newline, emoji, symbols): typed
      // literally, slower, no error modelling.
      // Hesitation before this character (never right after a correction —
      // the typist already knows where they are).
      const pause = s.lastWasBackspace ? 0 : this._pauseBefore(s.mentalCursorPos);

      if (!onKeyboard && charIntended !== ' ') {
        this._bumpFatigue();
        let dt = this.baseKeystrokeTime * this.tempo * s.fatigueMultiplier;
        dt *= charIntended === '\n' ? C.SPEED_NEWLINE : C.SPEED_UNKNOWN_CHAR;
        dt = Math.max(C.MIN_KEYSTROKE_TIME, lognormalMean(dt, C.KEYSTROKE_SIGMA)) + pause;
        s.totalTime += dt;
        s.currentText += charIntended;
        s.lastCharTyped = charIntended;
        s.keysTyped++;
        s.lastWasBackspace = false;
        const event = [s.totalTime, `TYPED '${charIntended}'`, s.currentText];
        s.history.push(event);
        s.mentalCursorPos += 1;
        return event;
      }

      this._bumpFatigue();

      // Context multiplier shared by every error kind.
      let ctx = 1;
      const wordDiff = getWordDifficulty(this._currentWordContext() || '');
      if (wordDiff === 'complex') ctx *= C.COMPLEX_WORD_ERROR_MULT;
      else if (wordDiff === 'common') ctx *= C.COMMON_WORD_ERROR_MULT;
      if (this.keyboard.isComposedAccent(charIntended)) ctx *= C.COMPOSED_ACCENT_ERROR_MULT;
      const care = this._careFraction();
      ctx *= C.CARE_ERROR_MULT + (1 - C.CARE_ERROR_MULT) * (1 - care);

      const pos = s.mentalCursorPos;
      const charAfter = pos + 1 < target.length ? target[pos + 1] : null;
      const lower = charIntended.toLowerCase();

      // Shift released late: "The" -> "THe".
      if (s.lastCharTyped && isUpper(s.lastCharTyped) && isLetter(charIntended) && !isUpper(charIntended)
          && !s.lastWasBackspace && rand() < this.probError * ctx * C.SHIFT_SLIP_MULT) {
        const ev = this._emit(charIntended.toUpperCase(), 'TYPED_ERROR', pause);
        s.mentalCursorPos += 1;
        return ev;
      }

      // Transposition (anticipation): "the" -> "hte".
      if (charAfter && charAfter !== ' ' && charAfter !== '\n' && charAfter !== charIntended
          && this.keyboard.hasKey(charAfter) && rand() < this.probSwap * ctx) {
        this._emit(charAfter, 'TYPED_SWAP', pause);
        const ev = this._emit(charIntended, 'TYPED_SWAP');
        s.mentalCursorPos += 2;
        return ev;
      }

      // Slips.
      let pErr = this.probError * ctx;
      if (charIntended === ' ') pErr *= C.SPACE_OMIT_MULT;
      if (rand() < pErr) {
        const kinds = [], weights = [];
        const mix = C.ERROR_MIX;
        const canOmit = charAfter != null && charAfter !== ' ' && charAfter !== '\n' && this.keyboard.hasKey(charAfter);
        if (charIntended === ' ') {
          if (canOmit) { kinds.push('omit'); weights.push(1); }
        } else {
          kinds.push('substitute'); weights.push(mix.substitute);
          if (canOmit) { kinds.push('omit'); weights.push(mix.omit); }
          kinds.push('insert'); weights.push(mix.insert);
          if (isUpper(charIntended) && isLetter(charIntended)) { kinds.push('missedShift'); weights.push(mix.missedShift); }
        }
        const kind = kinds.length ? weightedChoice(kinds, weights) : null;

        if (kind === 'substitute') {
          const wrong = this.keyboard.getRandomNeighbor(charIntended);
          if (wrong) {
            const ev = this._emit(wrong, 'TYPED_ERROR', pause);
            s.mentalCursorPos += 1;
            return ev;
          }
        } else if (kind === 'omit') {
          // Skip this character; the next one comes out in its place.
          s.mentalCursorPos += 2;
          return this._emit(charAfter, 'TYPED_OMIT', pause);
        } else if (kind === 'insert') {
          // Key bounce / double tap: "hello" -> "helllo".
          this._emit(charIntended, 'TYPED', pause);
          const ev = this._emit(charIntended, 'TYPED_ERROR');
          s.mentalCursorPos += 1;
          return ev;
        } else if (kind === 'missedShift') {
          const ev = this._emit(lower, 'TYPED_ERROR', pause);
          s.mentalCursorPos += 1;
          return ev;
        }
      }

      // Clean keystroke.
      const ev = this._emit(charIntended, 'TYPED', pause);
      s.mentalCursorPos += 1;
      return ev;
    }

    run() {
      let steps = 0;
      const maxSteps = this.targetText.length * 10 + 100;
      while (this.step() !== null) {
        steps++;
        if (steps > maxSteps) break;
      }
      return { totalTime: this.state.totalTime, history: this.state.history };
    }
  }

  // ---------------------------------------------------------------------------
  // Estimation — run the model a few times to get an average duration.
  // Purely computational (no waiting); used for the live ETA in the UI.
  // ---------------------------------------------------------------------------
  function estimate(text, opts = {}, samples = 6) {
    if (!text) return { seconds: 0, chars: 0, words: 0, keystrokes: 0 };
    let sum = 0;
    let keystrokes = 0;
    const n = Math.max(1, samples);
    let cal = null; // calibrate once, reuse for the remaining samples
    for (let i = 0; i < n; i++) {
      const t = new MarkovTyper(text, cal ? Object.assign({}, opts, cal) : opts);
      if (!cal) cal = { tempo: t.tempo, pauseScale: t.pauseScale };
      const { totalTime, history } = t.run();
      sum += totalTime;
      keystrokes += history.length - 1; // minus INIT
    }
    const words = text.trim().length ? text.trim().split(/\s+/).length : 0;
    return {
      seconds: sum / n,
      chars: text.length,
      words,
      keystrokes: Math.round(keystrokes / n),
    };
  }

  const HumanTyping = {
    CONFIG: C,
    KeyboardLayout,
    MarkovTyper,
    estimate,
    gaussian,
  };

  root.HumanTyping = HumanTyping;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HumanTyping;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
