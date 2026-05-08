/**
 * quantize.js — Beat-grid quantization engine for abc-rhythm
 *
 * Converts tap timestamps into ABC notation duration strings.
 * Exported via window.Quantize = { quantizeTaps, buildGrid, beatsToABC }
 *
 * All durations are relative to ABC unit length L:1/4 (quarter note = 1 beat).
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /** Resolution name → subdivision multiplier (subdivisions per quarter note) */
  const RESOLUTION_MULTIPLIER = {
    'quarter':       1,
    'eighth':        2,
    'sixteenth':     4,
    'thirty-second': 8,
  };

  /**
   * Canonical beat values (in quarter-note units) and their ABC duration strings.
   * Sorted descending so we can iterate from longest to shortest.
   * L:1/4 means a quarter note = "", half = "2", whole = "4", etc.
   */
  const BEAT_MAP = [
    { beats: 4,     abc: '4'   },   // whole note
    { beats: 3,     abc: '3'   },   // dotted half
    { beats: 2,     abc: '2'   },   // half note
    { beats: 1.5,   abc: '3/2' },   // dotted quarter
    { beats: 1,     abc: ''    },   // quarter note (unit length)
    { beats: 0.75,  abc: '3/4' },   // dotted eighth
    { beats: 0.5,   abc: '/'   },   // eighth note  (shorthand for /2)
    { beats: 0.375, abc: '3/8' },   // dotted sixteenth
    { beats: 0.25,  abc: '/4'  },   // sixteenth note
    { beats: 0.125, abc: '/8'  },   // thirty-second note
  ];

  // ---------------------------------------------------------------------------
  // buildGrid
  // ---------------------------------------------------------------------------

  /**
   * Build a beat grid as an array of millisecond timestamps.
   *
   * @param {number} startTime  - ms timestamp of the first beat (grid origin)
   * @param {number} duration   - total ms to cover from startTime
   * @param {object} opts
   * @param {number} opts.bpm         - beats per minute (quarter-note tempo)
   * @param {string} opts.resolution  - 'quarter'|'eighth'|'sixteenth'|'thirty-second'
   * @returns {number[]} array of grid-point timestamps (ms), inclusive of startTime
   */
  function buildGrid(startTime, duration, { bpm, resolution }) {
    if (!bpm || bpm <= 0) return [];

    const multiplier = RESOLUTION_MULTIPLIER[resolution] || 1;
    const beatInterval = 60000 / bpm;          // ms per quarter note
    const gridInterval = beatInterval / multiplier; // ms per grid step

    const points = [];
    let t = startTime;
    const end = startTime + duration;

    // Include the start point; stop once we exceed the window
    while (t <= end + gridInterval * 0.01 /* float tolerance */) {
      points.push(t);
      t += gridInterval;
    }

    return points;
  }

  // ---------------------------------------------------------------------------
  // beatsToABC
  // ---------------------------------------------------------------------------

  /**
   * Convert a beat count (float, in quarter-note units) to an ABC duration string.
   *
   * Uses log-scale distance for snapping so that, e.g., 0.6 is closer to 0.5
   * than to 0.75 on a perceptual / musical scale.
   *
   * @param {number} beats - duration in quarter-note units
   * @returns {string}     - ABC duration suffix (e.g. '', '2', '/', '/4')
   */
  function beatsToABC(beats) {
    if (!beats || beats <= 0) return '';

    let bestABC = '';
    let bestDist = Infinity;

    for (const { beats: candidate, abc } of BEAT_MAP) {
      // Log-ratio distance: symmetric on multiplication/division
      const dist = Math.abs(Math.log(beats / candidate));
      if (dist < bestDist) {
        bestDist = dist;
        bestABC  = abc;
      }
    }

    return bestABC;
  }

  // ---------------------------------------------------------------------------
  // quantizeTaps
  // ---------------------------------------------------------------------------

  /**
   * Given tap timestamps and a grid config, compute ABC duration strings for
   * each inter-tap interval.
   *
   * Algorithm:
   *  1. Build a dense grid from the first tap (or provided startTime) covering
   *     the full span of the taps.
   *  2. For each consecutive tap pair, measure the interval in ms.
   *  3. Find how many grid steps best fit that interval (nearest integer).
   *  4. Convert grid steps → beats, then beats → ABC string.
   *
   * @param {number[]} tapTimes - array of ms timestamps (N taps → N-1 durations)
   * @param {object}  config
   * @param {number}  config.bpm             - quarter-note tempo
   * @param {number}  config.beatsPerMeasure - (informational, not used in quantize math)
   * @param {string}  config.resolution      - grid resolution
   * @param {number}  [config.startTime]     - ms timestamp of the first beat;
   *                                           defaults to tapTimes[0]
   * @returns {string[]} ABC duration strings, one per inter-tap interval
   */
  function quantizeTaps(tapTimes, config) {
    // Edge cases
    if (!tapTimes || tapTimes.length < 2) return [];
    if (!config.bpm || config.bpm <= 0)   return [];

    const { bpm, resolution = 'eighth' } = config;
    const startTime = (config.startTime != null) ? config.startTime : tapTimes[0];

    const multiplier   = RESOLUTION_MULTIPLIER[resolution] || 2;
    const beatInterval = 60000 / bpm;          // ms per quarter note
    const gridInterval = beatInterval / multiplier; // ms per grid step

    if (gridInterval <= 0) return [];

    const durations = [];

    for (let i = 0; i < tapTimes.length - 1; i++) {
      const intervalMs = tapTimes[i + 1] - tapTimes[i];

      if (intervalMs <= 0) {
        // Zero or negative interval — treat as shortest unit
        durations.push(beatsToABC(1 / multiplier));
        continue;
      }

      // How many grid steps span this interval? Round to nearest integer.
      const steps = Math.round(intervalMs / gridInterval);
      const clampedSteps = Math.max(1, steps); // at least one grid step

      // Convert steps → beats (quarter-note units)
      const beats = clampedSteps / multiplier;

      durations.push(beatsToABC(beats));
    }

    return durations;
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  global.Quantize = { quantizeTaps, buildGrid, beatsToABC };

})(typeof window !== 'undefined' ? window : global);
