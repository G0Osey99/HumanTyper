# ⌨ HumanTyper — Realistic Auto Typer (Chrome Extension)

Type any script, paper, or snippet into **any** text field on the web with
believable, human-like typing — variable speed, natural pauses, real typos that
get noticed and corrected, and gradual fatigue. Live **ETA**, a draggable
progress HUD with pause/stop, saved presets, and full tuning.

Design: **“Paper & Coral”** — warm off-white surfaces, near-black ink, a single
coral accent; DM Sans + JetBrains Mono. Built on the typing model from
**[Lax3n/HumanTyping](https://github.com/Lax3n/HumanTyping)**.

---

## About the typing model

The engine started as a JavaScript port of the Python
[HumanTyping](https://github.com/Lax3n/HumanTyping) Markov typing model and
has since been extended so the output reads like a person copy-typing:

- **Physical keyboard geometry.** Keys have real staggered positions, so a slip
  lands on a key your finger could actually hit (`e` → `w`/`r`/`d`, `n` → `m`/`b`)
  weighted by distance; digits and symbols are much less likely than letters.
  A space is never mis-hit as another key.
- **Several kinds of slip**, in realistic proportions: adjacent-key
  substitution, dropped letter, double-tap, transposition (`the` → `hte`),
  missed shift (`the` for `The`) and shift released late (`THe`).
- **Whole-word deletions.** When a slip is buried inside a word, the typist
  often wipes the word with Option+Backspace (Ctrl+Backspace on Windows/Linux)
  and retypes it instead of backspacing letter by letter. The model only does
  this where every editor agrees on the word boundary (a plain run of letters
  or digits after a space), so the result is always exact.
- **Carefulness after a fix.** Right after a correction the error rate drops
  sharply and typing slows a little, ramping back over the next few keys, so
  two slips in a row are rare.
- **Rhythm from the hands**, not just key distance: alternating hands are
  fast, same-finger sequences slow, repeated letters quick, shifted keys and
  the number row slower; keystroke intervals are right-skewed (log-normal).
- **Pauses where people pause**: between chunks of words, after commas,
  longer after sentence ends, longest at line breaks. Plus a short warm-up,
  slow drifting bursts and lulls, and gentle fatigue on long texts.
- **Calibrated speed.** The **Speed** you set is the *net* rate the run
  actually achieves (characters ÷ 5 per minute, pauses and corrections
  included), so the ETA and the finished time line up.

See [`src/engine.js`](src/engine.js). The model produces a full timed history
of single keystrokes which the extension replays into the field, scheduled
against the wall clock so overhead doesn't stretch the run.

---

## Install (Load Unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `HumanTyper` folder.
4. Pin the HumanTyper (coral keycap) icon.

No build step, no dependencies — plain HTML/CSS/JS with two bundled woff2 fonts.

---

## How to use

1. Click into the text box you want filled — a plain `<input>`, a `<textarea>`,
   any contenteditable editor (Gmail, Notion, Word on the web…), or a Google Doc.
   Leave the caret where the text should go.
2. Open the popup, paste your script, set the **Speed**, and press **Aim & Type**.

That's it. HumanTyper types **where your cursor last was**. It remembers the
field and caret position per frame, puts focus back there, and then sends
**real keystrokes** through Chrome's debugger API — the same trusted input path
Puppeteer and Playwright use. Because the browser itself delivers those keys to
whatever has focus, it works on plain inputs, any contenteditable editor,
Google Docs' canvas editor, Word for the web's cross-origin editing frame, and
anything else, with no site-specific code. While it types, Chrome shows its
yellow *"HumanTyper started debugging this browser"* bar; it disappears when
typing finishes (closing the bar early stops the run).

If no text box has held the cursor yet, a banner asks you to click one; the
very next click into any text box starts typing there (**Esc** cancels).

If the debugger can't attach (DevTools is already open on that tab) HumanTyper
falls back to typing through the DOM — fine for ordinary inputs and
contenteditable editors, but not for canvas editors like Google Docs.

Anything pasted into the popup is reduced to **plain text** first: formatting,
invisible/zero-width characters, smart quotes, exotic spaces and unknown
characters are stripped or normalized, so exactly what you see is what gets typed.

The popup has three tabs:

- **Script** — the text (live `chars · words` + estimated time), the **Speed**
  histogram slider, tuning summary chips, and **Aim & Type** (shows the ETA).
- **Presets** — save the current script + speed + tuning as a named card.
  **Load & Aim** starts typing straight away; double-click loads into Script.
- **Tune** — humanizing toggles (**Make mistakes** + typo intensity, **Fatigue
  over time**, **Natural rhythm**, **Speed variance**), plus **Keyboard**
  (QWERTY/AZERTY) and **Start delay** (0 / 0.6s / 3s / 5s). **Reset** restores
  defaults.

While typing, a draggable **HUD** (bottom-right of the page, always in the top
frame even when the editor is an iframe) shows the target, a coral progress
bar, and **Progress / Elapsed / Left**, with **Pause** and **Stop** (Esc also
stops). It reports **Done** when finished.

---

## Features

| Feature | What it does |
|---|---|
| **Realistic model** | Keyboard-geometry slips, six error kinds, post-fix carefulness, hand-aware rhythm, calibrated net WPM |
| **Live ETA** | Model-derived estimate in the primary button, recomputed as you tweak |
| **Types at your cursor** | Targets the field and caret you last used, in whatever frame it lives |
| **Universal keystrokes** | Real, trusted key events via `chrome.debugger` — Google Docs, Word on the web, canvas editors, anything focused |
| **DOM fallback** | `<input>`, `<textarea>`, and `contenteditable` adapters when the debugger can't attach |
| **Plain-text paste** | Pasted text is stripped of formatting, invisible and unknown characters |
| **Progress HUD** | Draggable, live Progress / Elapsed / Left, isolated in a Shadow DOM |
| **Pause / Resume / Stop** | Full control mid-type (Esc = stop) |
| **Typos & corrections** | Adjacent-key slips, dropped/doubled letters, swaps, shift errors — noticed & backspaced; toggle + intensity |
| **Fatigue / rhythm / variance** | Gradual slowdown, word-aware bursts, session-WPM randomization |
| **Presets** | Save & reload named scripts with their full tuning |
| **Keyboard layout** | QWERTY or AZERTY (affects which typos are plausible) |
| **Start delay / countdown** | 0 / 0.6s / 3s / 5s before typing starts |
| **Framework-safe insertion** | Native value setters + real input/keyboard events so React/Vue controlled inputs update correctly |

Turn **Make mistakes** off for clean typing with natural cadence; turn rhythm and
variance off too for a steady, robotic pace.

---

## How targeting works

```
popup ──HT_ROUTE_START──▶ background: attach chrome.debugger to the tab
                            │
                            ├─HT_FOCUS──▶ frame that last reported the caret
                            │             (re-focuses its field + saved caret)
                            │             falls back to the top frame, then "armed":
                            │             the next click into any text box wins
                            │
                            └─HT_START──▶ top frame: runs the timing engine + HUD
                                            └─HT_KEY per keystroke──▶ background
                                                  Input.dispatchKeyEvent / insertText
```

- `src/content.js` runs in every frame (`all_frames` + `match_about_blank`) and
  tracks the last editable + caret in that frame.
- `src/background.js` routes between frames and emits the keystrokes.
  Printable characters go out as key down/up with text, Enter and Backspace as
  their keys, whole-word deletions as Option/Ctrl+Backspace, tabs and emoji as
  IME text insertion (a real Tab would move focus).
- `src/field.js` holds the DOM fallback adapters (input/textarea and
  contenteditable via `execCommand('insertText')`).
- `src/sanitize.js` is the plain-text normalizer used by the popup and before typing.

---

## Settings → model mapping

The Tune options map onto the ported engine (`new HumanTyping.MarkovTyper(text, opts)`):

```
wpm             → net words-per-minute the run is calibrated to hit
mistakes        → all slip kinds + transpositions + corrections
intensity       → multiplier on those error probabilities  (errorIntensity)
fatigue         → FATIGUE_FACTOR slowdown (capped at FATIGUE_CAP)
rhythm          → hand/finger timing, word difficulty, pauses, drift, warm-up
variance        → WPM_STD randomization of the session speed  (sessionVariance)
layout          → 'qwerty' | 'azerty'  (key geometry and which slips are plausible)
```

---

## Notes & limitations

- **Typing goes to your cursor.** Aim & Type inserts at the caret position in the
  field you last used — including editors that live inside an **iframe** (e.g.
  **Word on the web**), because the content script runs in every frame and a
  background worker routes typing to the frame that holds your cursor.
- After you **reload or update the extension**, refresh the page before typing,
  so the content script is present when you click into the field (that click is
  how it learns where your cursor is).
- **Google Docs** renders text on a `<canvas>` and intercepts keys at a very low
  level, so generic web typing can’t drive it. Word on the web and most
  `contenteditable` editors accept synthetic input; a small number of editors
  with custom input pipelines may still ignore it.
- Browser-internal pages (`chrome://`, the Web Store, `view-source:`) can’t be
  scripted — the popup will tell you.
- The bundled fonts load in the popup everywhere; in the in-page HUD they load
  via `chrome.runtime.getURL` and gracefully fall back to the system stack on
  sites whose CSP blocks extension font files.
- Personal productivity/accessibility tool — don’t use it to violate the terms
  of sites that prohibit automated input (e.g. online tests/exams).

---

## Project structure

```
manifest.json       MV3 manifest (all-frames content script + fonts in web_accessible_resources)
popup.html/.css/.js  Three-tab popup: Script / Presets / Tune, live ETA, launch
src/engine.js       Typing model (extended HumanTyping port) + estimate()
src/field.js        DOM adapters: input / textarea / contenteditable insert+backspace
src/content.js      Cursor tracking, aim picker, draggable HUD, timed player, messaging
src/background.js   Routes a typing request to the frame that holds the cursor
fonts/              DM Sans + JetBrains Mono (variable woff2, bundled)
icons/              Coral keycap icons (16 / 48 / 128)
```

Model licensed under MIT by the HumanTyping contributors; this port follows it.
DM Sans and JetBrains Mono are under the SIL Open Font License.
