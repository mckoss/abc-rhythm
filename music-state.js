/**
 * music-state.js — Central reactive data store for abc-rhythm-parser.
 *
 * Parses ABC notation into a structured token list, holds current note
 * durations (updated by the quantizer), notifies subscribers on change,
 * and serializes back to ABC text.
 *
 * Loaded as a plain <script> tag; exports via window.MusicState.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // ABC duration regex helpers
  // ---------------------------------------------------------------------------

  /**
   * Regex that matches a single note in ABC body text.
   *   Group 1: accidental  (\^{1,2} | _{1,2} | =)?
   *   Group 2: pitch letter [A-Ga-g]
   *   Group 3: octave modifiers (,  or  ')
   *   Group 4: duration string (may be empty)
   *
   * Examples:  ^C'2   _e/   G   z3/2  (z handled separately)
   */
  const NOTE_RE = /(\^{1,2}|_{1,2}|=)?([A-Ga-g])([,']*)(\d*\/?(?:\d+)?)/g;

  /**
   * Regex that matches a rest ('z') with optional duration.
   *   Group 1: duration string (may be empty)
   */
  const REST_RE = /z(\d*\/?(?:\d+)?)/g;

  /**
   * Combined scanner that finds notes AND rests in document order.
   * We need lastIndex sync, so we use a single pass with alternation.
   *   Group 1: accidental  (note only)
   *   Group 2: pitch       (note only)
   *   Group 3: octave      (note only)
   *   Group 4: duration    (note)
   *   Group 5: rest duration (rest path, matched when group 2 is absent)
   */
  const BODY_TOKEN_RE = /(\^{1,2}|_{1,2}|=)?([A-Ga-g])([,']*)(\d*\/?(?:\d+)?)|(z)(\d*\/?(?:\d+)?)/g;

  // ---------------------------------------------------------------------------
  // Header parsing helpers
  // ---------------------------------------------------------------------------

  /** Return the value portion of the first matching header line, or null. */
  function getHeader(tokens, key) {
    const prefix = key + ':';
    for (const tok of tokens) {
      if (tok.type === 'header' && tok.raw.startsWith(prefix)) {
        return tok.raw.slice(prefix.length).replace(/\r?\n$/, '').trim();
      }
    }
    return null;
  }

  /** Parse M: value → beats per measure (number). */
  function parseBeatsPerMeasure(mValue) {
    if (!mValue) return null;
    if (mValue === 'C') return 4;
    if (mValue === 'C|') return 2;
    const m = mValue.match(/^(\d+)\//);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Parse L: value → decimal fraction (e.g. '1/4' → 0.25). */
  function parseUnitNoteLength(lValue) {
    if (!lValue) return null;
    const m = lValue.match(/^(\d+)\/(\d+)$/);
    if (m) return parseInt(m[1], 10) / parseInt(m[2], 10);
    const n = parseFloat(lValue);
    return isNaN(n) ? null : n;
  }

  /** Parse Q: value → bpm number (e.g. 'Q:1/4=120' → 120, 'Q:120' → 120). */
  function parseTempo(qValue) {
    if (!qValue) return null;
    // Q:1/4=120 style
    const withUnit = qValue.match(/=(\d+)/);
    if (withUnit) return parseInt(withUnit[1], 10);
    // Q:120 style
    const plain = qValue.match(/^(\d+)$/);
    return plain ? parseInt(plain[1], 10) : null;
  }

  // ---------------------------------------------------------------------------
  // Body parser — returns array of text/note/rest tokens for one body string.
  // noteIndex is the starting index for note/rest tokens.
  // ---------------------------------------------------------------------------

  function parseBody(bodyText, startIndex) {
    const tokens = [];
    let cursor = 0;
    let noteIndex = startIndex;

    BODY_TOKEN_RE.lastIndex = 0;
    let match;

    while ((match = BODY_TOKEN_RE.exec(bodyText)) !== null) {
      const matchStart = match.index;
      const matchEnd = matchStart + match[0].length;

      // Capture any literal text between cursor and this match as a text token.
      if (matchStart > cursor) {
        tokens.push({ type: 'text', raw: bodyText.slice(cursor, matchStart) });
      }

      if (match[5] === 'z') {
        // Rest token
        const durationABC = match[6] || '';
        tokens.push({
          type: 'rest',
          raw: match[0],          // original text (used for toABC reconstruction)
          durationABC,
          index: noteIndex++,
        });
      } else {
        // Note token
        const accidental = match[1] || '';
        const pitch = match[2];
        const octave = match[3] || '';
        const durationABC = match[4] || '';
        tokens.push({
          type: 'note',
          raw: match[0],
          accidental,
          pitch,
          octave,
          durationABC,
          index: noteIndex++,
        });
      }

      cursor = matchEnd;
    }

    // Any trailing text after the last note/rest
    if (cursor < bodyText.length) {
      tokens.push({ type: 'text', raw: bodyText.slice(cursor) });
    }

    return tokens;
  }

  // ---------------------------------------------------------------------------
  // MusicState class
  // ---------------------------------------------------------------------------

  class MusicState {
    constructor() {
      /** @type {Array<Object>} flat token list (header | note | rest | text) */
      this._tokens = [];

      /** @type {Set<Function>} change subscribers */
      this._subscribers = new Set();
    }

    // -------------------------------------------------------------------------
    // Parse
    // -------------------------------------------------------------------------

    /**
     * Parse ABC text. Replaces all existing tokens.
     * Clears any note durations that may have been set previously.
     *
     * @param {string} abcText
     */
    parseABC(abcText) {
      if (!abcText || typeof abcText !== 'string') {
        this._tokens = [];
        this._notify();
        return;
      }

      const tokens = [];
      const lines = abcText.split('\n');

      // Split into header lines vs body lines.
      // Headers are lines matching /^[A-Za-z]:/ that appear before the body.
      // The body begins after the last contiguous header line group, OR after
      // the K: (key) header, whichever comes first — standard ABC convention.
      // For simplicity we treat every line matching /^[A-Za-z]:/ as a header
      // and collect the rest as body text.
      let bodyLines = [];
      let lastHeaderIdx = -1;

      for (let i = 0; i < lines.length; i++) {
        if (/^[A-Za-z]:/.test(lines[i])) {
          lastHeaderIdx = i;
        }
      }

      for (let i = 0; i <= lastHeaderIdx; i++) {
        tokens.push({ type: 'header', raw: lines[i] + '\n' });
      }

      // Everything after the last header line is body text.
      if (lastHeaderIdx < lines.length - 1) {
        bodyLines = lines.slice(lastHeaderIdx + 1);
      }

      const bodyText = bodyLines.join('\n');
      const bodyTokens = parseBody(bodyText, 0);
      for (const t of bodyTokens) tokens.push(t);

      this._tokens = tokens;
      this._notify();
    }

    // -------------------------------------------------------------------------
    // Notes accessor
    // -------------------------------------------------------------------------

    /**
     * All note/rest tokens as a shallow-copy array.
     * Each element: { index, type, pitch?, accidental?, octave?, durationABC }
     *
     * @returns {Array<Object>}
     */
    get notes() {
      return this._tokens
        .filter(t => t.type === 'note' || t.type === 'rest')
        .map(t => ({ ...t })); // shallow copy — callers can't mutate internals
    }

    /** Count of note + rest tokens. */
    get noteCount() {
      return this._tokens.filter(t => t.type === 'note' || t.type === 'rest').length;
    }

    // -------------------------------------------------------------------------
    // Header accessors
    // -------------------------------------------------------------------------

    /** Title from T: header, or null. */
    get title() {
      return getHeader(this._tokens, 'T');
    }

    /** Time signature string from M: header, e.g. '4/4', or null. */
    get timeSignature() {
      return getHeader(this._tokens, 'M');
    }

    /** Numerator of the time signature (beats per measure), or null. */
    get beatsPerMeasure() {
      return parseBeatsPerMeasure(this.timeSignature);
    }

    /** Key signature from K: header, e.g. 'G' or 'Dm', or null. */
    get keySignature() {
      return getHeader(this._tokens, 'K');
    }

    /**
     * Unit note length as a decimal fraction from L: header.
     * e.g. L:1/4 → 0.25, L:1/8 → 0.125. Returns null if absent.
     */
    get unitNoteLength() {
      return parseUnitNoteLength(getHeader(this._tokens, 'L'));
    }

    /**
     * Tempo in BPM from Q: header, or null.
     * Handles both Q:120 and Q:1/4=120 styles.
     */
    get tempo() {
      return parseTempo(getHeader(this._tokens, 'Q'));
    }

    // -------------------------------------------------------------------------
    // Duration mutation
    // -------------------------------------------------------------------------

    /**
     * Update the ABC duration string for a single note/rest by index.
     * Fires one change event.
     *
     * @param {number} noteIndex  — the .index value from a notes[] element
     * @param {string} abcDuration — e.g. '2', '/', '3/2', ''
     */
    setDuration(noteIndex, abcDuration) {
      const tok = this._tokens.find(
        t => (t.type === 'note' || t.type === 'rest') && t.index === noteIndex
      );
      if (!tok) {
        console.warn(`MusicState.setDuration: no token with index ${noteIndex}`);
        return;
      }
      tok.durationABC = abcDuration;
      this._notify();
    }

    /**
     * Replace all note/rest durations from an array.
     * durations[i] maps to the note whose .index === i (positional by index order).
     * Fires one change event.
     *
     * @param {string[]} durationsArray
     */
    setAllDurations(durationsArray) {
      const noteTokens = this._tokens.filter(
        t => t.type === 'note' || t.type === 'rest'
      );
      for (let i = 0; i < noteTokens.length; i++) {
        if (i < durationsArray.length) {
          noteTokens[i].durationABC = durationsArray[i];
        }
      }
      this._notify();
    }

    /**
     * Clear all durations (reset to empty strings).
     * Fires one change event.
     */
    clearDurations() {
      for (const tok of this._tokens) {
        if (tok.type === 'note' || tok.type === 'rest') {
          tok.durationABC = '';
        }
      }
      this._notify();
    }

    // -------------------------------------------------------------------------
    // Serialization
    // -------------------------------------------------------------------------

    /**
     * Serialize back to ABC text with current durations applied.
     *
     * For each note/rest token we reconstruct the raw text using the current
     * durationABC instead of the original. All other tokens are emitted verbatim.
     *
     * @returns {string}
     */
    toABC() {
      return this._tokens.map(tok => {
        if (tok.type === 'note') {
          // accidental + pitch + octave + duration
          return tok.accidental + tok.pitch + tok.octave + tok.durationABC;
        }
        if (tok.type === 'rest') {
          return 'z' + tok.durationABC;
        }
        // header or text — verbatim
        return tok.raw;
      }).join('');
    }

    // -------------------------------------------------------------------------
    // Pub/sub
    // -------------------------------------------------------------------------

    /**
     * Subscribe to state changes.
     * fn() is called synchronously after any mutation.
     *
     * @param {Function} fn
     */
    subscribe(fn) {
      this._subscribers.add(fn);
    }

    /**
     * Remove a previously registered subscriber.
     *
     * @param {Function} fn
     */
    unsubscribe(fn) {
      this._subscribers.delete(fn);
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    /** Fire all subscribers. */
    _notify() {
      for (const fn of this._subscribers) {
        try {
          fn();
        } catch (e) {
          console.error('MusicState subscriber threw:', e);
        }
      }
    }
  }

  // Expose globally for <script> tag usage.
  window.MusicState = MusicState;

})();
