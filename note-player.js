/**
 * note-player.js — Web Audio API note playback for tap-feedback and sequence playback.
 *
 * Two playback modes:
 *   1. Duration-known: playNote() — used for sequence/chord playback.
 *   2. Hold-until-release: startNote() + stopCurrentNote() — used for tap-feedback
 *      where the note sustains at constant gain until the key is released, then
 *      applies a 20 ms release ramp to prevent clicks.
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

    const freq = this._noteToFrequency(pitch, accidental, octave);
    const ctx  = this._audioCtx;
    const now  = ctx.currentTime;
    const dur  = Math.max(durationMs, 40) / 1000;  // at least 40 ms
    const RELEASE = 0.020;

    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);

    gain.gain.setValueAtTime(0.4, now);
    // Hold at constant gain, then ramp down 20 ms before end
    gain.gain.setValueAtTime(0.4, now + dur - RELEASE);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + dur + 0.005);

    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
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

    // Accidentals
    if      (accidental === '^^') semitone += 2;
    else if (accidental === '^')  semitone += 1;
    else if (accidental === '__') semitone -= 2;
    else if (accidental === '_')  semitone -= 1;
    // '=' (natural) and '' → no change

    // Base octave: uppercase → 4, lowercase → 5
    let octaveNum = /[A-Z]/.test(pitch) ? 4 : 5;

    // Apply explicit octave modifiers
    if (octave) {
      octaveNum += (octave.match(/'/g) || []).length;
      octaveNum -= (octave.match(/,/g)  || []).length;
    }

    // MIDI note: C4 = 60, A4 = 69 = 440 Hz
    const midi = 12 * (octaveNum + 1) + semitone;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }
}

window.NotePlayer = NotePlayer;
