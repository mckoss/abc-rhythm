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
   * Combined scanner that finds notes, rests, and inline field changes in
   * document order.
   *   Group 1: accidental  (note only)
   *   Group 2: pitch       (note only)
   *   Group 3: octave      (note only)
   *   Group 4: duration    (note)
   *   Group 5: 'z'         (rest path)
   *   Group 6: rest duration
   *   Group 7: field letter (inline field change, e.g. K, M, L, Q)
   *   Group 8: field value  (inline field change)
   */
  const BODY_TOKEN_RE = /(\^{1,2}|_{1,2}|=)?([A-Ga-g])([,']*)(\d*\/?(?:\d+)?)|(z)(\d*\/?(?:\d+)?)|\[([A-Za-z]):(.*?)\]/g;

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
  // Body segment parser — parses a single body line (not a field-change line)
  // for notes, rests, and inline field changes.
  // Returns { tokens, noteIndex } where noteIndex is updated past any note/rest
  // tokens produced.
  // ---------------------------------------------------------------------------

  function parseBodySegment(segText, startIndex) {
    const tokens = [];
    let cursor = 0;
    let noteIndex = startIndex;

    BODY_TOKEN_RE.lastIndex = 0;
    let match;

    while ((match = BODY_TOKEN_RE.exec(segText)) !== null) {
      const matchStart = match.index;
      const matchEnd = matchStart + match[0].length;

      // Capture any literal text between cursor and this match as a text token.
      if (matchStart > cursor) {
        tokens.push({ type: 'text', raw: segText.slice(cursor, matchStart) });
      }

      if (match[7] !== undefined) {
        // Inline field change: [X:value]
        tokens.push({
          type: 'field-change',
          raw: match[0],
          field: match[7],
          value: match[8],
        });
      } else if (match[5] !== undefined) {
        // Rest token (match[5] === 'z')
        const durationABC = match[6] || '';
        tokens.push({
          type: 'rest',
          raw: match[0],
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
    if (cursor < segText.length) {
      tokens.push({ type: 'text', raw: segText.slice(cursor) });
    }

    return { tokens, noteIndex };
  }

  // ---------------------------------------------------------------------------
  // Body parser — processes body text line by line.
  // Lines matching /^[A-Za-z]:/ become field-change tokens.
  // All other lines are parsed with parseBodySegment for notes/rests/inline changes.
  // noteIndex is the starting index for note/rest tokens.
  // ---------------------------------------------------------------------------

  function parseBody(bodyText, startIndex) {
    const tokens = [];
    let noteIndex = startIndex;

    const lines = bodyText.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Preserve the newline for all lines except possibly the last.
      const lineText = i < lines.length - 1 ? line + '\n' : line;

      if (/^[A-Za-z]:/.test(line)) {
        // Body-line field change (mid-tune K:, M:, L:, Q:, etc.)
        const colonIdx = line.indexOf(':');
        const field = line.slice(0, colonIdx);
        const value = line.slice(colonIdx + 1).trim();
        tokens.push({ type: 'field-change', raw: lineText, field, value });
      } else {
        // Regular body line — parse for notes, rests, inline field changes
        const result = parseBodySegment(lineText, noteIndex);
        for (const t of result.tokens) tokens.push(t);
        noteIndex = result.noteIndex;
      }
    }

    return tokens;
  }

  // ---------------------------------------------------------------------------
  // MusicState class
  // ---------------------------------------------------------------------------

  class MusicState {
    constructor() {
      /** @type {Array<Object>} flat token list (header | note | rest | text | field-change) */
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
     * The header section ends at the first K: line (standard ABC), or at the
     * last contiguous header line if no K: is present. Mid-tune lines matching
     * /^[A-Za-z]:/ are parsed as field-change tokens within the body.
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

      // Locate the header/body boundary.
      // Standard ABC: body begins after the first K: (key) header line.
      // Fallback (no K:): after the last contiguous header line at the top.
      // We stop scanning for headers as soon as we hit the first K: line OR
      // the first non-empty, non-header line (whichever comes first).
      let lastHeaderIdx = -1;

      for (let i = 0; i < lines.length; i++) {
        if (/^[A-Za-z]:/.test(lines[i])) {
          lastHeaderIdx = i;
          if (/^K:/.test(lines[i])) {
            break; // K: marks the end of the header section
          }
        } else if (lines[i].trim() !== '') {
          // First non-empty, non-header line: body has started
          break;
        }
      }

      for (let i = 0; i <= lastHeaderIdx; i++) {
        tokens.push({ type: 'header', raw: lines[i] + '\n' });
      }

      // Everything after the last header line is body text.
      let bodyLines = [];
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

    /**
     * Notes/rests for playback. Includes generated inter-note rests inserted by
     * performance quantization, but keeps noteCount/recording indices tied to
     * the original parsed notes/rests.
     *
     * @returns {Array<Object>}
     */
    get playbackNotes() {
      return this._tokens
        .filter(t => t.type === 'note' || t.type === 'rest' || t.type === 'inserted-rest')
        .map(t => {
          if (t.type === 'inserted-rest') {
            return {
              type: 'rest',
              durationABC: t.durationABC,
              generated: true,
              afterIndex: t.afterIndex,
            };
          }
          return { ...t };
        });
    }

    // -------------------------------------------------------------------------
    // Header accessors (always return the initial/header-level value)
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
    // Mid-tune context
    // -------------------------------------------------------------------------

    /**
     * Returns the active musical context at a given note index, reflecting any
     * field changes (K:, M:, L:, Q:) that have occurred *before* that note in
     * document order. Seeds from header-level values.
     *
     * @param {number} noteIndex  — the .index value of the target note
     * @returns {{ timeSig: string|null, beatsPerMeasure: number|null,
     *             key: string|null, unitLength: number|null, tempo: number|null }}
     */
    getContextAtNote(noteIndex) {
      // Seed with header-level values
      let timeSig = this.timeSignature;
      let key = this.keySignature;
      let unitLength = this.unitNoteLength;
      let tempo = this.tempo;

      // Scan tokens in document order. Accumulate field changes until we hit
      // the target note (or a note with a higher index).
      for (const tok of this._tokens) {
        if ((tok.type === 'note' || tok.type === 'rest') && tok.index >= noteIndex) {
          break;
        }
        if (tok.type === 'field-change') {
          switch (tok.field) {
            case 'M': timeSig = tok.value; break;
            case 'K': key = tok.value; break;
            case 'L': unitLength = parseUnitNoteLength(tok.value); break;
            case 'Q': tempo = parseTempo(tok.value); break;
          }
        }
      }

      return {
        timeSig,
        beatsPerMeasure: parseBeatsPerMeasure(timeSig),
        key,
        unitLength,
        tempo,
      };
    }

    /**
     * Array of every mid-tune field change with the index of the *next* note
     * after the change (i.e. "this change takes effect before note N").
     * If a field change appears before any notes, noteIndex is 0.
     * Only field-change tokens in the body are included (header tokens are not).
     *
     * @returns {Array<{ noteIndex: number, field: string, value: string }>}
     */
    get fieldChanges() {
      const changes = [];
      /** Field-change tokens waiting for the next note to anchor them. */
      const pending = [];

      for (const tok of this._tokens) {
        if (tok.type === 'note' || tok.type === 'rest') {
          // Anchor all pending field changes to this note's index
          for (const fc of pending) {
            changes.push({ noteIndex: tok.index, field: fc.field, value: fc.value });
          }
          pending.length = 0;
        } else if (tok.type === 'field-change') {
          pending.push(tok);
        }
      }

      // Field changes that trail after all notes
      if (pending.length > 0) {
        const count = this.noteCount;
        for (const fc of pending) {
          changes.push({ noteIndex: count, field: fc.field, value: fc.value });
        }
      }

      return changes;
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
      this._removeInsertedRests();
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
     * Replace original note/rest durations and insert generated rests after
     * notes where the performed silence was long enough to quantize.
     *
     * The generated rests are serialized in toABC(), rendered in the score, and
     * included in playbackNotes, but they are intentionally excluded from
     * noteCount and notes so the recording flow still advances through only the
     * source notes Mike is performing.
     *
     * @param {string[]} durationsArray - durations for original notes/rests
     * @param {(string|null|undefined)[]} restsAfterArray - rest durations after
     *   original note/rest i; falsy values mean no rest inserted
     */
    setAllDurationsAndInsertedRests(durationsArray, restsAfterArray) {
      this._removeInsertedRests();

      const noteTokens = this._tokens.filter(
        t => t.type === 'note' || t.type === 'rest'
      );

      for (let i = 0; i < noteTokens.length; i++) {
        if (i < durationsArray.length) {
          noteTokens[i].durationABC = durationsArray[i];
        }
      }

      for (let i = noteTokens.length - 1; i >= 0; i--) {
        const restDuration = restsAfterArray && restsAfterArray[i];
        if (restDuration == null) continue;

        const insertAt = this._tokens.indexOf(noteTokens[i]);
        if (insertAt === -1) continue;

        this._tokens.splice(insertAt + 1, 0, {
          type: 'inserted-rest',
          durationABC: restDuration,
          generated: true,
          afterIndex: noteTokens[i].index,
        });
      }

      this._notify();
    }

    /**
     * Clear all durations (reset to empty strings).
     * Fires one change event.
     */
    clearDurations() {
      this._removeInsertedRests();
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
     * durationABC instead of the original. All other tokens (header, text,
     * field-change) are emitted verbatim via their .raw property.
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
        if (tok.type === 'inserted-rest') {
          return 'z' + tok.durationABC;
        }
        // header, text, or field-change — verbatim
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

    /** Remove generated rests from the token stream. */
    _removeInsertedRests() {
      this._tokens = this._tokens.filter(t => t.type !== 'inserted-rest');
    }
  }

  // Expose globally for <script> tag usage.
  window.MusicState = MusicState;

})();
