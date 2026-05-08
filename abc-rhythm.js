// abc-rhythm.js
// Core logic: parse ABC notation, record tap timings, compute + annotate durations.

// ---------------------------------------------------------------------------
// ABC Parser — extracts note tokens while preserving all other text verbatim
// ---------------------------------------------------------------------------

// Matches a single note or rest token:
//   group 1: accidental  (^, ^^, _, __, =)
//   group 2: pitch       (A-G, a-g)
//   group 3: octave      (,* or '*)
//   group 4: duration    (e.g. 2, /, /2, 3/2 — may be empty)
// Also matches rest 'z' (group 5) with optional duration (group 6)
const NOTE_RE = /(\^{1,2}|_{1,2}|=)?([A-Ga-g])([,']*)(\d*\/?(?:\d+)?)|z([,']*)(\d*\/?(?:\d+)?)/g;

/**
 * Split an ABC tune into an array of segments.
 * Each segment is either:
 *   { type: 'note', raw, accidental, pitch, octave, duration, index }
 *   { type: 'rest', raw, duration, index }
 *   { type: 'text', raw }   — everything else (headers, bars, spaces, etc.)
 *
 * 'index' is the note/rest number (0-based) for mapping tap times back.
 */
function parseABC(abcText) {
  const segments = [];
  let noteIndex = 0;
  let cursor = 0;

  // Split headers from body at the first blank-line-after-K: or after all headers
  // We'll parse everything and just let the regex skip over header lines naturally.

  NOTE_RE.lastIndex = 0;
  let match;

  while ((match = NOTE_RE.exec(abcText)) !== null) {
    // Check if we're inside a header line (lines starting with a letter + colon)
    const before = abcText.slice(0, match.index);
    const lastNewline = before.lastIndexOf('\n');
    const lineStart = before.slice(lastNewline + 1).trimStart();
    const isHeader = /^[A-Za-z]:/.test(lineStart);

    if (isHeader) {
      // Don't treat this as a note — it's part of a field like "K:C" or "T:My Tune"
      // Push the gap as text and continue
      continue;
    }

    // Push text between last cursor and this match
    if (match.index > cursor) {
      segments.push({ type: 'text', raw: abcText.slice(cursor, match.index) });
    }

    if (match[2]) {
      // It's a note
      segments.push({
        type: 'note',
        raw: match[0],
        accidental: match[1] || '',
        pitch: match[2],
        octave: match[3] || '',
        duration: match[4] || '',
        index: noteIndex++
      });
    } else {
      // It's a rest (z)
      segments.push({
        type: 'rest',
        raw: match[0],
        duration: match[6] || '',
        index: noteIndex++
      });
    }

    cursor = match.index + match[0].length;
  }

  // Remaining text after last match
  if (cursor < abcText.length) {
    segments.push({ type: 'text', raw: abcText.slice(cursor) });
  }

  return segments;
}

/**
 * Rebuild ABC text from segments, substituting new durations.
 * durations: array of ABC duration strings, indexed by note/rest index.
 */
function rebuildABC(segments, durations) {
  return segments.map(seg => {
    if (seg.type === 'note') {
      const dur = durations[seg.index] !== undefined ? durations[seg.index] : seg.duration;
      return seg.accidental + seg.pitch + seg.octave + dur;
    }
    if (seg.type === 'rest') {
      const dur = durations[seg.index] !== undefined ? durations[seg.index] : seg.duration;
      return 'z' + dur;
    }
    return seg.raw;
  }).join('');
}

/**
 * Return just the note/rest segments (for display in the tap UI).
 */
function getNoteSegments(segments) {
  return segments.filter(s => s.type === 'note' || s.type === 'rest');
}

// ---------------------------------------------------------------------------
// Duration Quantization
// ---------------------------------------------------------------------------

// Standard durations as multiples of a quarter note (beat).
// Ordered from largest to smallest for snapping.
const STANDARD_DURATIONS = [
  { mult: 4,     abc: '4'   },  // whole
  { mult: 3,     abc: '3'   },  // dotted half
  { mult: 2,     abc: '2'   },  // half
  { mult: 1.5,   abc: '3/2' },  // dotted quarter
  { mult: 1,     abc: ''    },  // quarter (default = no suffix when L:1/4)
  { mult: 0.75,  abc: '3/4' },  // dotted eighth
  { mult: 0.5,   abc: '/'   },  // eighth
  { mult: 0.375, abc: '3/8' },  // dotted sixteenth
  { mult: 0.25,  abc: '/4'  },  // sixteenth
];

/**
 * Snap a float ratio (interval / beat) to the nearest standard duration.
 * Returns an ABC duration string.
 */
function snapDuration(ratio) {
  let best = STANDARD_DURATIONS[0];
  let bestDist = Infinity;
  for (const d of STANDARD_DURATIONS) {
    const dist = Math.abs(Math.log(ratio / d.mult)); // log-scale distance
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best.abc;
}

/**
 * Given an array of tap timestamps (ms), compute ABC duration strings
 * for each note. One tap per note (the tap marks the START of that note;
 * the next tap marks its end). A final extra tap ends the last note.
 *
 * Returns { durations: string[], bpm: number }
 */
function computeDurations(tapTimes) {
  if (tapTimes.length < 2) return { durations: [], bpm: 0 };

  // Intervals between consecutive taps
  const intervals = [];
  for (let i = 1; i < tapTimes.length; i++) {
    intervals.push(tapTimes[i] - tapTimes[i - 1]);
  }

  // Beat = median interval
  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const beat = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  const bpm = Math.round(60000 / beat);

  // For each interval, compute ratio and snap to duration
  const durations = intervals.map(iv => snapDuration(iv / beat));

  return { durations, bpm };
}

// ---------------------------------------------------------------------------
// App State
// ---------------------------------------------------------------------------

let state = {
  phase: 'idle',       // idle | tapping | done
  segments: [],
  notes: [],           // note/rest segments
  tapTimes: [],
  currentNoteIdx: 0,
  bpm: 0,
  outputDurations: [],
};

// ---------------------------------------------------------------------------
// DOM refs (populated on DOMContentLoaded)
// ---------------------------------------------------------------------------

let elInput, elOutput, elNoteSeq, elTapBtn, elStatus, elBpm;
let elStartBtn, elRedoBtn, elCopyBtn, elClearBtn;

function $(id) { return document.getElementById(id); }

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------

function renderNoteSequence() {
  elNoteSeq.innerHTML = '';
  if (state.notes.length === 0) {
    elNoteSeq.innerHTML = '<span style="color:var(--muted);font-size:0.85rem">Notes will appear here once you paste ABC above.</span>';
    return;
  }
  state.notes.forEach((note, i) => {
    const chip = document.createElement('div');
    chip.className = 'note-chip';
    if (note.type === 'rest') chip.classList.add('rest');

    // Display label: pitch letter (uppercase for readability) or 'z' for rest
    const label = note.type === 'rest' ? 'z' : note.pitch.toUpperCase() + note.octave.replace(/,/g, '↓').replace(/'/g, '↑');
    chip.textContent = label;
    chip.id = `note-chip-${i}`;

    if (state.phase === 'tapping') {
      if (i < state.currentNoteIdx) chip.classList.add('done');
      else if (i === state.currentNoteIdx) chip.classList.add('active');
    } else if (state.phase === 'done') {
      chip.classList.add('done');
    }

    elNoteSeq.appendChild(chip);
  });

  // Scroll active chip into view
  if (state.phase === 'tapping') {
    const active = document.getElementById(`note-chip-${state.currentNoteIdx}`);
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
}

function setStatus(msg, cls = '') {
  elStatus.textContent = msg;
  elStatus.className = 'tap-status' + (cls ? ` ${cls}` : '');
}

function updateBpm() {
  elBpm.textContent = state.bpm ? `~${state.bpm} BPM` : '';
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

function onInputChange() {
  const abc = elInput.value.trim();
  if (!abc) {
    state.segments = [];
    state.notes = [];
    renderNoteSequence();
    setStatus('Paste ABC notation on the left to begin.');
    elStartBtn.disabled = true;
    return;
  }

  state.segments = parseABC(abc);
  state.notes = getNoteSegments(state.segments);
  renderNoteSequence();

  const n = state.notes.length;
  setStatus(n > 0
    ? `${n} note${n !== 1 ? 's' : ''} found. Press Start Tapping when ready.`
    : 'No notes found — check your ABC notation.');
  elStartBtn.disabled = n === 0;
  elClearBtn.disabled = false;
}

function startTapping() {
  if (state.notes.length === 0) return;

  state.phase = 'tapping';
  state.tapTimes = [];
  state.currentNoteIdx = 0;
  state.bpm = 0;
  state.outputDurations = [];

  elStartBtn.disabled = true;
  elRedoBtn.disabled = false;
  elTapBtn.disabled = false;
  elTapBtn.className = 'big-tap-btn tapping';
  elTapBtn.textContent = `TAP — Note 1 of ${state.notes.length}`;
  elCopyBtn.disabled = true;
  elOutput.value = '';
  updateBpm();

  setStatus(`Tap for each note. ${state.notes.length} notes + 1 final tap to finish.`, 'active');
  renderNoteSequence();
  elTapBtn.focus();
}

function recordTap() {
  if (state.phase !== 'tapping') return;

  state.tapTimes.push(Date.now());
  state.currentNoteIdx++;

  const remaining = state.notes.length - state.currentNoteIdx;

  if (state.currentNoteIdx <= state.notes.length) {
    // Update BPM estimate after a few taps
    if (state.tapTimes.length >= 3) {
      const { bpm } = computeDurations(state.tapTimes);
      state.bpm = bpm;
      updateBpm();
    }
  }

  if (state.currentNoteIdx > state.notes.length) {
    // Final tap — we have one more interval than notes, which is fine;
    // computeDurations uses intervals so we need notes+1 taps total.
    finishTapping();
    return;
  }

  if (remaining > 0) {
    elTapBtn.textContent = `TAP — Note ${state.currentNoteIdx + 1} of ${state.notes.length}`;
    setStatus(`${remaining} note${remaining !== 1 ? 's' : ''} left, then one final tap.`, 'active');
  } else {
    // Last note tapped — one more tap needed to close it
    elTapBtn.textContent = 'TAP — Final tap to end last note';
    setStatus('One more tap to set the duration of the last note.', 'active');
  }

  renderNoteSequence();
}

function finishTapping() {
  state.phase = 'done';

  const { durations, bpm } = computeDurations(state.tapTimes);
  state.bpm = bpm;
  state.outputDurations = durations;

  const annotated = rebuildABC(state.segments, durations);
  elOutput.value = annotated;

  elTapBtn.disabled = true;
  elTapBtn.textContent = 'Done!';
  elTapBtn.className = 'big-tap-btn';
  elStartBtn.disabled = false;
  elRedoBtn.disabled = false;
  elCopyBtn.disabled = false;

  updateBpm();
  setStatus(`Done! Detected ~${bpm} BPM. Annotated ABC is on the right.`, 'done');
  renderNoteSequence();
}

function redoTapping() {
  state.phase = 'idle';
  state.tapTimes = [];
  state.currentNoteIdx = 0;
  state.bpm = 0;
  elOutput.value = '';
  elTapBtn.disabled = true;
  elTapBtn.className = 'big-tap-btn';
  elTapBtn.textContent = 'TAP';
  elStartBtn.disabled = state.notes.length === 0;
  elRedoBtn.disabled = true;
  elCopyBtn.disabled = true;
  updateBpm();
  setStatus(`${state.notes.length} notes ready. Press Start Tapping.`);
  renderNoteSequence();
}

function copyOutput() {
  const text = elOutput.value;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const orig = elCopyBtn.textContent;
    elCopyBtn.textContent = 'Copied!';
    setTimeout(() => { elCopyBtn.textContent = orig; }, 1500);
  });
}

function clearInput() {
  elInput.value = '';
  elOutput.value = '';
  state.segments = [];
  state.notes = [];
  state.phase = 'idle';
  state.tapTimes = [];
  state.currentNoteIdx = 0;
  state.bpm = 0;
  elStartBtn.disabled = true;
  elRedoBtn.disabled = true;
  elCopyBtn.disabled = true;
  elClearBtn.disabled = true;
  elTapBtn.disabled = true;
  elTapBtn.textContent = 'TAP';
  elBpm.textContent = '';
  setStatus('Paste ABC notation on the left to begin.');
  renderNoteSequence();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  elInput    = $('input-abc');
  elOutput   = $('output-abc');
  elNoteSeq  = $('note-sequence');
  elTapBtn   = $('tap-btn');
  elStatus   = $('tap-status');
  elBpm      = $('bpm-display');
  elStartBtn = $('start-btn');
  elRedoBtn  = $('redo-btn');
  elCopyBtn  = $('copy-btn');
  elClearBtn = $('clear-btn');

  elInput.addEventListener('input', onInputChange);
  elStartBtn.addEventListener('click', startTapping);
  elRedoBtn.addEventListener('click', redoTapping);
  elCopyBtn.addEventListener('click', copyOutput);
  elClearBtn.addEventListener('click', clearInput);
  elTapBtn.addEventListener('click', recordTap);

  // Spacebar taps anywhere on the page (when tapping phase is active)
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && state.phase === 'tapping') {
      e.preventDefault();
      recordTap();
    }
  });

  // Seed with example
  elInput.value = `X:1
T:Example Melody
M:4/4
L:1/4
K:C
CDEF GABc|cdeg fedc|BGAF GECE|C4|]`;

  onInputChange();
  setStatus('Paste ABC notation on the left, or use the example above.');
});
