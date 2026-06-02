/**
 * Unit tests for quantize-holds.js (quantizeHoldsToGrid).
 *
 * Run:  node --test
 *
 * Loads the browser modules into the global scope (they self-export to
 * `window`, which we alias to globalThis) and exercises the pure quantizer.
 */
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const path = require('node:path');

globalThis.window = globalThis;
require(path.join(__dirname, '..', 'quantize.js'));        // defines Quantize
require(path.join(__dirname, '..', 'quantize-holds.js'));  // defines QuantizeHolds

const { quantizeHoldsToGrid } = globalThis.QuantizeHolds;

// 100 BPM, eighth grid → beat = 600ms, grid step = 300ms.
// Hold times below are relative (ms from the first onset); we offset them by a
// non-zero base because quantizeHoldsToGrid guards on `!startTime` (a real
// recording's startTime is a Date.now() value, never 0).
const T0 = 100000;
const q = (holds, bpm = 100, res = 'eighth', bpMeasure = 4) =>
  quantizeHoldsToGrid(
    holds.map(h => ({ down: T0 + h.down, up: T0 + h.up })),
    bpm, res, T0, bpMeasure,
  );

// ABC duration string → quarter-note beats (for measure-sum assertions).
const ABC_BEATS = { '': 1, '2': 2, '3': 3, '4': 4, '3/2': 1.5, '/': 0.5, '3/4': 0.75, '/4': 0.25, '/8': 0.125, '3/8': 0.375 };
const beats = (abc) => ABC_BEATS[abc != null ? abc : ''];

test('terminal measure: 2 quarters + held final note → half note, no stray rest', () => {
  // Final note onset at beat 3, held ~1.5 beats. Regression for the bug where
  // it padded a 3.5-of-4-beat measure with a whole rest.
  const { durations, restsAfter } = q([
    { down: 0, up: 560 },      // quarter
    { down: 600, up: 1160 },   // quarter
    { down: 1200, up: 2100 },  // final note, held ~1.5b → should fill to the bar
  ]);
  assert.deepStrictEqual(durations, ['', '', '2']);
  assert.deepStrictEqual(restsAfter, [null, null, null]);
});

test('terminal fill never exceeds one measure', () => {
  // Three quarters then a short final note: the last bar must total exactly
  // beatsPerMeasure (note + any padding rest), never overflow.
  const { durations, restsAfter } = q([
    { down: 0, up: 560 },
    { down: 600, up: 1160 },
    { down: 1200, up: 1760 },
    { down: 1800, up: 1950 }, // short final note
  ]);
  const last = durations.length - 1;
  const tail = beats(durations[last]) + (restsAfter[last] ? beats(restsAfter[last]) : 0);
  assert.ok(tail <= 4 + 1e-9, `final note+rest = ${tail} beats, exceeds one 4/4 measure`);
});

test('inter-onset bias: an early release fills to the next onset (no rest)', () => {
  // Note released at 0.8b but next onset is 2b away → should be a held half
  // note, not dotted-quarter + rest.
  const { durations, restsAfter } = q([
    { down: 0, up: 800 },
    { down: 1200, up: 1400 },
  ]);
  assert.strictEqual(durations[0], '2');
  assert.strictEqual(restsAfter[0], null);
});

test('a genuine long pause is preserved as a rest', () => {
  // Short note, then 2 beats of silence before the next onset → keep a rest.
  const { restsAfter } = q([
    { down: 0, up: 550 },
    { down: 2400, up: 2600 },
  ]);
  assert.ok(restsAfter[0], 'expected a rest after a real multi-beat pause');
});

test('terminal note on a downbeat held a full bar → whole note', () => {
  const { durations, restsAfter } = q([{ down: 0, up: 3850 }]);
  assert.strictEqual(durations[0], '4');
  assert.strictEqual(restsAfter[0], null);
});
