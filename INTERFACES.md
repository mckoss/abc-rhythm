# abc-rhythm — Module Interface Contracts

All modules are plain ES6 classes/functions, no bundler, no framework.
Each file is a standalone JS module loaded via `<script src="...">` in index.html.

---

## click-track.js — Web Audio API metronome

```js
class ClickTrack {
  constructor()
  // Configure before starting. Can call while stopped.
  configure({ bpm, beatsPerMeasure })

  // Start the click track. onTick is called on every quarter-note beat.
  // tickInfo = { beat (0-based), isMeasureStart, audioTime (AudioContext time) }
  start(onTick)
  stop()
  get isPlaying()  // boolean
  get bpm()
  get beatsPerMeasure()
}

// Export as window.ClickTrack
```

Sound design:
- Measure downbeat: loud, higher-pitched click (~1000 Hz, 80ms)
- Other beats: quieter/shorter click (~800 Hz, 40ms)
- Use Web Audio API OscillatorNode + GainNode for clean clicks
- Schedule ahead-of-time (lookahead ~100ms) for timing accuracy

---

## quantize.js — Beat grid quantization

```js
// Given an array of tap timestamps (ms, from Date.now()) and grid config,
// compute ABC duration strings for each note.
//
// tapTimes: [t0, t1, t2, ...tN] — N taps = N-1 intervals (or N notes if last tap ends last note)
// config: {
//   bpm: number,
//   beatsPerMeasure: number,
//   resolution: 'quarter'|'eighth'|'sixteenth'|'thirty-second',
//   startTime: number  // ms timestamp of the first beat (measure downbeat)
// }
// Returns: string[] of ABC duration strings, one per tap interval
//   e.g. ['2', '1', '/', '/2', '3/2']   (relative to L:1/4)
//
function quantizeTaps(tapTimes, config)

// Build the beat grid as an array of timestamps.
// startTime: ms, duration: ms total length to cover
// Returns: number[] of grid point timestamps
function buildGrid(startTime, duration, { bpm, resolution })

// Convert a duration in beats (float) to an ABC duration string,
// given L:1/4 as the note unit. E.g. 2.0→'2', 0.5→'/', 1.5→'3/2', 0.25→'/4'
function beatsToABC(beats)

// Export all three as window.Quantize = { quantizeTaps, buildGrid, beatsToABC }
```

---

## renderer.js — abcjs score renderer

```js
class ScoreRenderer {
  // containerId: id of a <div> in the DOM to render into
  constructor(containerId)

  // Render ABC text into the container using abcjs.
  // Options: { responsive: true }
  render(abcText)

  // Clear the rendered score
  clear()

  // Highlight a specific note by 0-based index (for playback cursor display).
  // Uses abcjs cursor API if available, else CSS class.
  highlightNote(index)

  // Remove highlight
  clearHighlight()
}

// Export as window.ScoreRenderer
// Depends on: abcjs loaded via CDN <script> before this file
// abcjs CDN: https://cdn.jsdelivr.net/npm/abcjs@6.4.3/dist/abcjs-basic-min.js
```

---

## note-player.js — Web Audio API note playback

```js
class NotePlayer {
  constructor()

  // ── Duration-known playback (sequence / chord) ────────────────────────────

  // Play a note for a known duration. Non-blocking; returns immediately.
  // Applies a 20 ms release ramp at the end to avoid clicks.
  //   pitch      — 'C'–'B' (uppercase = octave 4, lowercase = octave 5)
  //   accidental — '^' | '^^' | '_' | '__' | '=' | ''
  //   octave     — string of "'" (up) and "," (down) modifiers, e.g. "'" | ",,"
  //   durationMs — sustain duration before release begins
  async playNote(pitch, accidental, octave, durationMs)

  // Schedule sequential playback from a MusicState instance or a state.notes-style
  // note/rest array. Rests advance time without sound. Cancels any previous
  // sequence first. opts: { bpm, unitNoteLength, startDelayMs, onNote, onEnd }
  async playSequence(source, opts)  // → { durationMs, noteCount }

  // Stop any held note and cancel all scheduled sequence playback.
  stopAll()

  // ── Hold-until-release playback (tap feedback) ────────────────────────────

  // Called on Shift keydown or tap-button press — starts the note, holds it at
  // constant gain indefinitely (no decay). If a note is already held, it is silenced first.
  // Returns the AudioContext timestamp (seconds) when the note started.
  async startNote(pitch, accidental, octave)  // → number (audioCtx seconds)

  // Called on Shift keyup or tap-button release — applies a 20 ms release ramp and stops the note.
  // Returns wall-clock timings (ms, Date.now() scale).
  // Returns { startTime: 0, endTime: 0, durationMs: 0 } if no note was held.
  stopCurrentNote()  // → { startTime, endTime, durationMs }

  // Duration in ms between the last startNote() and stopCurrentNote() calls.
  // Returns 0 if no note has been played yet.
  get lastNoteDurationMs()  // → number
}

// Export as window.NotePlayer
```

Typical tap-feedback usage in the controller:
```js
// keydown:
const audioStart = await notePlayer.startNote(pitch, accidental, octave);
const tapStartTime = Date.now();

// keyup:
const { durationMs } = notePlayer.stopCurrentNote();
// pass durationMs to quantizer as the held-note interval
```

---

## abc-rhythm.js (existing, to be updated by coordinator)

Main app controller. Imports and coordinates all modules.
Handles the performance UI state machine:
  idle → configured → countdown → recording → reviewing → done

---

## Shared conventions

- `L:1/4` is the default note unit in all output ABC (quarter note = 1 beat)
- All timestamps in milliseconds (Date.now())
- AudioContext timing in seconds (Web Audio API standard)
- Note indices are 0-based throughout
