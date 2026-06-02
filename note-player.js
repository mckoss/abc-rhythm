/**
 * note-player.js — Web Audio API note playback for tap-feedback and sequence playback.
 *
 * Two playback modes:
 *   1. Duration-known: playNote() — used for sequence/chord playback.
 *   2. Hold-until-release: startNote() + stopCurrentNote() — used for tap-feedback
 *      where the note sustains at constant gain until the key is released, then
 *      applies a 20 ms release ramp to prevent clicks.
 *   3. Sequence: playSequence() — schedules a parsed MusicState note/rest list.
 *
 * ABC pitch notation:
 *   pitch      — single letter, uppercase = octave 4, lowercase = octave 5
 *   accidental — '^' sharp, '^^' double sharp, '_' flat, '__' double flat, '=' natural, '' none
 *   octave     — string of '\'' (up) and ',' (down) modifiers, e.g. "'" = +1 oct, ",," = -2 oct
 *
 * Usage:
 *   const np = new NotePlayer();
 *   // Sequence playback — duration known up front:
 *   np.playNote('G', '', '', 500);
 *   np.playSequence(musicState, { bpm: 100 });
 *   // Tap-feedback — key held:
 *   const audioStartTime = await np.startNote('A', '^', "'");
 *   const { startTime, endTime, durationMs } = np.stopCurrentNote();
 */

class NotePlayer {
  constructor() {
    this._audioCtx = null;

    // Held-note state
    this._currentOscillator = null;
    this._currentGain       = null;
    this._startAudioTime    = 0;   // AudioContext seconds
    this._startWallTime     = 0;   // Date.now() ms

    // Sequence playback state
    this._scheduledVoices = new Set();
    this._sequenceTimers  = new Set();
    this._sequenceToken   = 0;

    this._lastNoteDurationMs = 0;
  }

  // ── Public getter ──────────────────────────────────────────────────────────

  /**
   * Duration in ms between the last startNote() and stopCurrentNote() calls.
   * Returns 0 if no note has been played yet.
   */
  get lastNoteDurationMs() {
    return this._lastNoteDurationMs;
  }

  // ── playNote — duration known up front ────────────────────────────────────

  /**
   * Play a note for a specific duration. Non-blocking; returns immediately.
   * Applies a short 20 ms release at the end to avoid clicks.
   *
   * @param {string} pitch       - Note letter ('C'–'B', uppercase or lowercase)
   * @param {string} accidental  - '^', '^^', '_', '__', '=', or ''
   * @param {string} octave      - Octave modifier string (e.g. "'", ",,")
   * @param {number} durationMs  - How long to sustain before release begins (ms)
   */
  async playNote(pitch, accidental, octave, durationMs) {
    await this._ensureContext();
    this._scheduleNote(pitch, accidental, octave, this._audioCtx.currentTime, durationMs);
  }

  // ── playSequence — schedule parsed ABC notes/rests ────────────────────────

  /**
   * Schedule sequential playback from a MusicState instance or notes array.
   * Rests advance time without sound. Already-scheduled sequence playback is
   * cancelled before the new sequence is queued.
   *
   * @param {MusicState|Array<Object>} source - MusicState or state.notes-style array
   * @param {object} opts
   * @param {number} opts.bpm - Tempo in quarter-note beats per minute
   * @param {number} [opts.unitNoteLength] - ABC L: value as a fraction (default 1/4)
   * @param {number} [opts.startDelayMs=30] - Small scheduling lead time
   * @param {Function} [opts.onNote] - Called as each token starts: (note, index) => void
   * @param {Function} [opts.onEnd] - Called after the sequence finishes
   * @returns {Promise<{durationMs:number, noteCount:number}>}
   */
  async playSequence(source, opts = {}) {
    await this._ensureContext();
    this.stopAll();

    const token = this._sequenceToken;
    const notes = Array.isArray(source) ? source : (source && source.notes) || [];
    const bpm = Number(opts.bpm || (source && source.tempo) || 120);
    const startDelayMs = opts.startDelayMs == null ? 30 : Number(opts.startDelayMs);

    // Articulation gap — humanize playback by sounding each note slightly
    // shorter than its slot (detaché). Onset timing is unchanged. Tunable:
    //   gapFraction — fraction of the note clipped (default 15%)
    //   maxGapMs    — cap so long notes aren't over-clipped
    const gapFraction = opts.gapFraction == null ? 0.15 : Number(opts.gapFraction);
    const maxGapMs = opts.maxGapMs == null ? 90 : Number(opts.maxGapMs);
    const MIN_SOUND_MS = 40;

    if (!notes.length || !bpm || bpm <= 0) {
      return { durationMs: 0, noteCount: 0 };
    }

    const ctx = this._audioCtx;
    let when = ctx.currentTime + Math.max(0, startDelayMs) / 1000;
    let totalMs = 0;

    notes.forEach((note, sequenceIndex) => {
      const context = (source && typeof source.getContextAtNote === 'function')
        ? source.getContextAtNote(note.index)
        : null;
      const unitNoteLength = context?.unitLength || opts.unitNoteLength || 1 / 4;
      const noteBpm = context?.tempo || bpm;
      const durationMs = this._durationABCToMs(note.durationABC || '', noteBpm, unitNoteLength);

      // Sound the note slightly shorter than its slot; `when` still advances by
      // the full durationMs below, so onsets stay exactly on the beat.
      const gapMs = Math.min(maxGapMs, durationMs * gapFraction);
      const soundMs = Math.max(MIN_SOUND_MS, durationMs - gapMs);

      if (note.type === 'note') {
        this._scheduleNote(
          note.pitch,
          note.accidental || '',
          note.octave || '',
          when,
          soundMs,
        );
      }

      if (typeof opts.onNote === 'function') {
        const delayMs = Math.max(0, (when - ctx.currentTime) * 1000);
        const timer = setTimeout(() => {
          this._sequenceTimers.delete(timer);
          if (this._sequenceToken === token) opts.onNote(note, sequenceIndex);
        }, delayMs);
        this._sequenceTimers.add(timer);
      }

      when += durationMs / 1000;
      totalMs += durationMs;
    });

    if (typeof opts.onEnd === 'function') {
      const timer = setTimeout(() => {
        this._sequenceTimers.delete(timer);
        if (this._sequenceToken === token) opts.onEnd();
      }, Math.max(0, totalMs + startDelayMs));
      this._sequenceTimers.add(timer);
    }

    return { durationMs: totalMs, noteCount: notes.length };
  }

  /**
   * Stop any held note and cancel all scheduled sequence playback.
   */
  stopAll() {
    this._sequenceToken++;

    for (const timer of this._sequenceTimers) {
      clearTimeout(timer);
    }
    this._sequenceTimers.clear();

    for (const voice of this._scheduledVoices) {
      try {
        voice.gain.gain.cancelScheduledValues(0);
        voice.gain.gain.value = 0;
        voice.osc.stop(0);
      } catch (_) {
        // Voice may already have ended or not have started yet.
      }
      try { voice.osc.disconnect(); } catch (_) {}
      try { voice.gain.disconnect(); } catch (_) {}
    }
    this._scheduledVoices.clear();

    this._silenceCurrent();
  }

  // ── startNote — holds until stopCurrentNote() ─────────────────────────────

  /**
   * Called on keydown. Starts the note and sustains it at constant gain.
   * If a note is already held, it is silenced first.
   *
   * @param {string} pitch       - Note letter ('C'–'B', uppercase or lowercase)
   * @param {string} accidental  - '^', '^^', '_', '__', '=', or ''
   * @param {string} octave      - Octave modifier string (e.g. "'", ",,")
   * @returns {number} AudioContext timestamp (seconds) when the note started
   */
  async startNote(pitch, accidental, octave) {
    await this._ensureContext();

    // Silence any previously held note without recording its duration
    this._silenceCurrent();

    const freq = this._noteToFrequency(pitch, accidental, octave);
    const ctx  = this._audioCtx;
    const now  = ctx.currentTime;

    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.4, now);  // constant gain — no decay

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);

    this._currentOscillator = osc;
    this._currentGain       = gain;
    this._startAudioTime    = now;
    this._startWallTime     = Date.now();

    return now;
  }

  // ── stopCurrentNote ───────────────────────────────────────────────────────

  /**
   * Called on keyup. Applies a 20 ms release ramp and stops the held note.
   *
   * @returns {{ startTime: number, endTime: number, durationMs: number }}
   *   All values in wall-clock milliseconds (Date.now() scale).
   *   Returns { startTime: 0, endTime: 0, durationMs: 0 } if no note was held.
   */
  stopCurrentNote() {
    if (!this._currentOscillator || !this._currentGain) {
      return { startTime: 0, endTime: 0, durationMs: 0 };
    }

    const ctx        = this._audioCtx;
    const now        = ctx.currentTime;
    const endWall    = Date.now();
    const startWall  = this._startWallTime;
    const durationMs = endWall - startWall;
    const RELEASE    = 0.020;

    // Short release to avoid clicks
    const g = this._currentGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + RELEASE);

    const osc  = this._currentOscillator;
    const gain = this._currentGain;
    osc.stop(now + RELEASE + 0.005);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };

    this._currentOscillator  = null;
    this._currentGain        = null;
    this._lastNoteDurationMs = durationMs;

    return { startTime: startWall, endTime: endWall, durationMs };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Lazily create the AudioContext and resume if suspended.
   */
  async _ensureContext() {
    if (!this._audioCtx) {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this._audioCtx.state === 'suspended') {
      await this._audioCtx.resume();
    }
  }

  /**
   * Schedule one oscillator voice at an AudioContext time.
   */
  _scheduleNote(pitch, accidental, octave, startTime, durationMs) {
    const freq = this._noteToFrequency(pitch, accidental, octave);
    const ctx  = this._audioCtx;
    const dur  = Math.max(Number(durationMs) || 0, 40) / 1000;  // at least 40 ms
    const RELEASE = Math.min(0.020, dur / 2);

    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    const voice = { osc, gain };

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0.4, startTime);
    gain.gain.setValueAtTime(0.4, startTime + dur - RELEASE);
    gain.gain.linearRampToValueAtTime(0, startTime + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);

    this._scheduledVoices.add(voice);
    osc.onended = () => {
      this._scheduledVoices.delete(voice);
      try { osc.disconnect(); } catch (_) {}
      try { gain.disconnect(); } catch (_) {}
    };

    osc.start(startTime);
    osc.stop(startTime + dur + 0.005);
  }

  /**
   * Immediately stop any held note without recording duration (used internally
   * when a new startNote() pre-empts an un-stopped note).
   */
  _silenceCurrent() {
    if (!this._currentOscillator) return;
    try {
      const now     = this._audioCtx.currentTime;
      const RELEASE = 0.020;
      const g = this._currentGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + RELEASE);
      this._currentOscillator.stop(now + RELEASE + 0.005);
    } catch (_) {
      // oscillator may have already ended
    }
    this._currentOscillator = null;
    this._currentGain       = null;
  }

  /**
   * Convert an ABC duration suffix into milliseconds.
   * The suffix multiplies the active L: unit length. With L:1/4, '' is one
   * quarter-note beat, '2' is two beats, '/' or '/2' is half a beat, etc.
   */
  _durationABCToMs(durationABC, bpm, unitNoteLength = 1 / 4) {
    const multiplier = this._parseABCDurationMultiplier(durationABC);
    const quarterBeats = multiplier * (unitNoteLength / (1 / 4));
    return quarterBeats * (60000 / bpm);
  }

  /**
   * Parse ABC duration syntax as a multiplier of L:.
   */
  _parseABCDurationMultiplier(durationABC) {
    const text = String(durationABC || '').trim();
    if (!text) return 1;

    if (/^\d+$/.test(text)) return parseInt(text, 10);

    const fraction = text.match(/^(\d*)\/(\d*)$/);
    if (fraction) {
      const numerator = fraction[1] ? parseInt(fraction[1], 10) : 1;
      const denominator = fraction[2] ? parseInt(fraction[2], 10) : 2;
      return numerator / denominator;
    }

    // Conservative fallback: malformed/unsupported duration plays as unit L:.
    return 1;
  }

  /**
   * Convert ABC note components to a frequency in Hz.
   *
   * ABC octave convention (per the ABC standard):
   *   Uppercase C–B  → octave 4  (C4 = middle C = 261.63 Hz)
   *   Lowercase c–b  → octave 5
   *   Each '\'' in octave string → +1 octave
   *   Each ','  in octave string → -1 octave
   *
   * @param {string} pitch       - 'C'–'B' or 'c'–'b'
   * @param {string} accidental  - '^', '^^', '_', '__', '=', or ''
   * @param {string} octave      - e.g. "'", ",,", ""
   * @returns {number} Frequency in Hz
   */
  _noteToFrequency(pitch, accidental, octave) {
    const NOTE_SEMITONES = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

    const letter   = pitch.toLowerCase();
    let semitone   = NOTE_SEMITONES[letter] ?? 0;

    // Accidentals from MusicState are stored on note.accidental and passed
    // through directly: '^', '^^', '_', '__', '=', or ''.
    if      (accidental === '^^') semitone += 2;
    else if (accidental === '^')  semitone += 1;
    else if (accidental === '__') semitone -= 2;
    else if (accidental === '_')  semitone -= 1;
    // '=' (natural) and '' → no change

    // Base octave: uppercase → 4, lowercase → 5.
    let octaveNum = /[A-Z]/.test(pitch) ? 4 : 5;

    // Apply explicit octave modifiers.
    if (octave) {
      octaveNum += (octave.match(/'/g) || []).length;
      octaveNum -= (octave.match(/,/g)  || []).length;
    }

    // MIDI note formula: C4 = 12 * (4 + 1) + 0 = 60 → 261.63 Hz;
    // A4 = 12 * (4 + 1) + 9 = 69 → 440 Hz.
    const midi = 12 * (octaveNum + 1) + semitone;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }
}

window.NotePlayer = NotePlayer;
