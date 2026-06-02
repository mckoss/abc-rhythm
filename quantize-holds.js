/**
 * quantize-holds.js — hold/onset → ABC duration quantizer for abc-rhythm.
 *
 * Pure logic (no DOM), extracted from the main controller so it can be unit
 * tested under Node. Depends on the global `Quantize` (from quantize.js) for
 * beatsToABC. Exported via window.QuantizeHolds in the browser and global in
 * Node.
 */
(function (global) {
  'use strict';

  /** Resolution name → subdivisions per quarter note. */
  const RESOLUTION_MULTIPLIER = {
    'quarter':       1,
    'eighth':        2,
    'sixteenth':     4,
    'thirty-second': 8,
  };

  function quantizeMsToABC(ms, bpm, resolution, { allowZero = false } = {}) {
    const multiplier = RESOLUTION_MULTIPLIER[resolution] || 2;
    const beatMs = 60000 / bpm;
    const gridMs = beatMs / multiplier;

    if (!ms || ms <= 0 || !bpm || bpm <= 0 || gridMs <= 0) {
      return allowZero ? null : Quantize.beatsToABC(1 / multiplier);
    }

    if (allowZero && ms < gridMs) {
      return null;
    }

    const steps = Math.max(1, Math.round(ms / gridMs));
    return Quantize.beatsToABC(steps / multiplier);
  }

  function quantizeHoldsToGrid(holds, bpm, resolution, startTime, beatsPerMeasure) {
    const multiplier = RESOLUTION_MULTIPLIER[resolution] || 2;
    const beatMs = 60000 / bpm;
    const gridMs = beatMs / multiplier;

    if (!holds.length || !bpm || bpm <= 0 || !startTime || gridMs <= 0) {
      return {
        durations: holds.map(h => quantizeMsToABC(h.up - h.down, bpm, resolution)),
        restsAfter: holds.map(() => null),
      };
    }

    const rawStep = (time) => (time - startTime) / gridMs;
    const snapStartStep = (time) => Math.max(0, Math.round(rawStep(time)));

    // Releases are articulation and are usually early. Let a key-up count as if
    // it happened up to half a quantization interval later, then snap to grid.
    const RELEASE_LENIENCY_STEPS = 0.5;
    const snapReleaseStep = (time) => Math.max(0, Math.round(rawStep(time) + RELEASE_LENIENCY_STEPS));

    // Inter-onset bias: a note owns the time until the next onset — an early
    // release is treated as articulation (breath/swing lift), not an intended
    // rest. A rest is only emitted when the note was released within the first
    // FILL_FRACTION of the interval AND the leftover silence is at least
    // MIN_REST_BEATS long (a real, audible pause).
    const FILL_FRACTION = 0.5;
    const MIN_REST_BEATS = 1;

    // Snap a beat count to the nearest representable note value (mirrors
    // Quantize.beatsToABC's candidate set + log-distance metric) so we can track
    // cumulative emitted beats the same way toABC accounts for measures.
    const SNAP_BEATS = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.375, 0.25, 0.125];
    const snapBeats = (b) =>
      SNAP_BEATS.reduce((best, c) =>
        Math.abs(Math.log(b / c)) < Math.abs(Math.log(b / best)) ? c : best, SNAP_BEATS[0]);

    const starts = holds.map(h => snapStartStep(h.down));
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] <= starts[i - 1]) starts[i] = starts[i - 1] + 1;
    }

    const durations = [];
    const restsAfter = holds.map(() => null);
    let cumBeats = 0; // emitted beats so far — mirrors toABC's measure accounting

    for (let i = 0; i < holds.length; i++) {
      const startStep = starts[i];
      const nextStartStep = (i + 1 < starts.length) ? starts[i + 1] : null;
      let releaseStep = Math.max(startStep + 1, snapReleaseStep(holds[i].up));

      if (nextStartStep != null) {
        releaseStep = Math.min(releaseStep, nextStartStep);
        const ioiSteps = nextStartStep - startStep;          // onset-to-onset span
        const heldSteps = Math.max(1, releaseStep - startStep);
        const gapSteps = ioiSteps - heldSteps;

        // Fold an early release into the note (the note owns the inter-onset
        // interval) unless it was clearly short AND followed by a real pause.
        const releasedEarly = heldSteps < FILL_FRACTION * ioiSteps;
        const restIsSubstantial = gapSteps >= MIN_REST_BEATS * multiplier;

        if (gapSteps > 0 && releasedEarly && restIsSubstantial) {
          const noteBeats = snapBeats(heldSteps / multiplier);
          const restBeats = snapBeats(gapSteps / multiplier);
          durations.push(Quantize.beatsToABC(noteBeats));
          restsAfter[i] = Quantize.beatsToABC(restBeats);
          cumBeats += noteBeats + restBeats;
        } else {
          const noteBeats = snapBeats(ioiSteps / multiplier);
          durations.push(Quantize.beatsToABC(noteBeats));
          cumBeats += noteBeats;
        }
      } else {
        // Terminal note: complete its final measure. Its position within the
        // measure comes from the cumulative emitted beats — the same accounting
        // toABC uses to place bar lines — NOT the raw onset grid, which drifts
        // from the score as interior durations snap. Fill only the true remainder
        // of the current measure: a single note if held most of the way, else a
        // short note padded with a rest. This can never exceed one measure.
        const beatsPerMeasureSafe = beatsPerMeasure || 4;
        const posInMeasure = ((cumBeats % beatsPerMeasureSafe) + beatsPerMeasureSafe) % beatsPerMeasureSafe;
        let remainingBeats = beatsPerMeasureSafe - posInMeasure;
        if (remainingBeats <= 1e-6) remainingBeats = beatsPerMeasureSafe;

        const heldBeats = (releaseStep - startStep) / multiplier;
        const noteBeats = heldBeats >= FILL_FRACTION * remainingBeats
          ? remainingBeats
          : Math.min(snapBeats(heldBeats), remainingBeats);

        durations.push(Quantize.beatsToABC(noteBeats));
        const restBeats = remainingBeats - noteBeats;
        if (restBeats > 1e-6) restsAfter[i] = Quantize.beatsToABC(restBeats);
      }
    }

    return { durations, restsAfter };
  }

  global.QuantizeHolds = { RESOLUTION_MULTIPLIER, quantizeMsToABC, quantizeHoldsToGrid };

})(typeof window !== 'undefined' ? window : globalThis);
