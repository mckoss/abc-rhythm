/**
 * Unit tests for edit-mode duration assignment (number keys + Shift-for-dotted).
 *
 * Run:  node --test
 *
 * Exercises the real digit→beats→ABC path exported from abc-rhythm.js:
 *   - EDIT_KEY_BEATS:   number key → base (undotted) quarter-note beats
 *   - DOT_MULTIPLIER:   Shift dots the value (× 1.5)
 *   - editDurationABC:  beats → exact ABC string (no lossy snapping)
 */
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const path = require('node:path');

globalThis.window = globalThis;
require(path.join(__dirname, '..', 'quantize.js'));        // Quantize
require(path.join(__dirname, '..', 'quantize-holds.js'));  // QuantizeHolds (controller dep)
require(path.join(__dirname, '..', 'abc-rhythm.js'));       // AbcRhythm

const { EDIT_KEY_BEATS, DOT_MULTIPLIER, editDurationABC } = globalThis.AbcRhythm;

// key → [plain ABC, dotted ABC]
const EXPECTED = {
  '1': ['',   '3/2' ],  // quarter        / dotted quarter
  '2': ['2',  '3'   ],  // half           / dotted half
  '4': ['4',  '6'   ],  // whole          / dotted whole
  '8': ['/',  '3/4' ],  // eighth         / dotted eighth
  '6': ['/4', '3/8' ],  // sixteenth      / dotted sixteenth
  '5': ['/8', '3/16'],  // thirty-second  / dotted thirty-second
};

test('every edit key maps to its exact plain and dotted ABC duration', () => {
  for (const [key, [plain, dotted]] of Object.entries(EXPECTED)) {
    const base = EDIT_KEY_BEATS[key];
    assert.notStrictEqual(base, undefined, `key ${key} should be mapped`);
    assert.strictEqual(editDurationABC(base), plain,
      `key ${key} (${base} beats) → "${plain}"`);
    assert.strictEqual(editDurationABC(base * DOT_MULTIPLIER), dotted,
      `Shift+${key} (${base * DOT_MULTIPLIER} beats) → "${dotted}"`);
  }
});

test('the legacy dotted-half "3" key is gone (now Shift+2)', () => {
  assert.strictEqual(EDIT_KEY_BEATS['3'], undefined);
});

test('out-of-snap-table dotted values are exact, not rounded', () => {
  // These motivated the exact lookup: Quantize.beatsToABC tops out at a whole
  // note and lacks 3/16, so it would mis-round these.
  assert.strictEqual(editDurationABC(6), '6');       // dotted whole, not '4'
  assert.strictEqual(editDurationABC(0.1875), '3/16'); // dotted 32nd, not '/4'
});
