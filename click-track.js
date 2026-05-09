/**
 * click-track.js — Web Audio API metronome with emphasized downbeats.
 *
 * Provides precise beat-level click-track playback using a look-ahead scheduling loop.
 * Downbeats are louder/higher-pitched; other beats are quieter/shorter.
 *
 * Usage:
 *   const ct = new ClickTrack();
 *   ct.configure({ bpm: 120, beatsPerMeasure: 4 });
 *   ct.start(({ beat, isMeasureStart, audioTime }) => { ... });
 *   ct.stop();
 */

class ClickTrack {
  constructor() {
    this._bpm = 120;
    this._beatsPerMeasure = 4;

    this._audioCtx = null;
    this._isPlaying = false;
    this._scheduleIntervalId = null;

    // Scheduler state
    this._nextTickTime = 0;   // audioContext time of next scheduled beat
    this._currentBeat = 0;    // 0-based beat index within measure

    // Look-ahead window
    this._lookaheadMs = 100;
    this._scheduleIntervalMs = 25;

    this._onTick = null;
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  configure({ bpm, beatsPerMeasure } = {}) {
    if (bpm !== undefined)            this._bpm = bpm;
    if (beatsPerMeasure !== undefined) this._beatsPerMeasure = beatsPerMeasure;
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  get isPlaying()       { return this._isPlaying; }
  get bpm()             { return this._bpm; }
  get beatsPerMeasure() { return this._beatsPerMeasure; }

  // ── Playback ───────────────────────────────────────────────────────────────

  async start(onTick) {
    if (this._isPlaying) return;

    this._onTick = onTick || null;

    // Lazily create AudioContext
    if (!this._audioCtx) {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Resume if suspended (autoplay policy)
    if (this._audioCtx.state === 'suspended') {
      await this._audioCtx.resume();
    }

    this._isPlaying = true;
    this._currentBeat = 0;
    // Start a tiny bit in the future so first tick is clean
    this._nextTickTime = this._audioCtx.currentTime + 0.05;

    this._scheduleIntervalId = setInterval(() => this._scheduler(), this._scheduleIntervalMs);
  }

  stop() {
    if (!this._isPlaying) return;
    this._isPlaying = false;
    clearInterval(this._scheduleIntervalId);
    this._scheduleIntervalId = null;
    this._onTick = null;
  }

  // ── Internal scheduling ────────────────────────────────────────────────────

  _scheduler() {
    if (!this._isPlaying || !this._audioCtx) return;

    const lookaheadSec = this._lookaheadMs / 1000;
    const scheduleUntil = this._audioCtx.currentTime + lookaheadSec;

    while (this._nextTickTime < scheduleUntil) {
      this._scheduleTick(this._nextTickTime, this._currentBeat);
      this._advance();
    }
  }

  _advance() {
    const secPerBeat = 60 / this._bpm;

    this._nextTickTime += secPerBeat;
    this._currentBeat++;
    if (this._currentBeat >= this._beatsPerMeasure) {
      this._currentBeat = 0;
    }
  }

  _scheduleTick(audioTime, beat) {
    const isMeasureStart = beat === 0;

    // Play the appropriate beat-level click sound.
    if (isMeasureStart) {
      this._playClick(audioTime, 1000, 0.9, 0.08);
    } else {
      this._playClick(audioTime, 800,  0.45, 0.04);
    }

    // Fire onTick callback at the correct wall-clock time
    if (this._onTick) {
      const delayMs = (audioTime - this._audioCtx.currentTime) * 1000;
      const safeDelay = Math.max(0, delayMs);
      const tickInfo = { beat, isMeasureStart, audioTime };
      setTimeout(() => {
        if (this._isPlaying) this._onTick(tickInfo);
      }, safeDelay);
    }
  }

  /**
   * Play a single click using an OscillatorNode + GainNode envelope.
   * @param {number} time       - AudioContext time to start
   * @param {number} freq       - Oscillator frequency in Hz
   * @param {number} gain       - Peak gain (0–1)
   * @param {number} duration   - Total envelope duration in seconds
   */
  _playClick(time, freq, gain, duration) {
    const ctx = this._audioCtx;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);

    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(gain, time + 0.002);          // fast attack
    env.gain.exponentialRampToValueAtTime(0.0001, time + duration); // decay

    osc.connect(env);
    env.connect(ctx.destination);

    osc.start(time);
    osc.stop(time + duration + 0.01);

    // Allow GC after the note finishes
    osc.onended = () => {
      osc.disconnect();
      env.disconnect();
    };
  }
}

window.ClickTrack = ClickTrack;
