/**
 * abc-rhythm.js — main controller
 *
 * Wires together: MusicState (IR) ← Quantize → ClickTrack → performance UI → ScoreRenderer
 *
 * State machine:
 *   idle → loaded → countdown → recording → reviewing
 *                                   ↑____________↓ (redo)
 */

// ---------------------------------------------------------------------------
// Module instances (populated after DOMContentLoaded)
// ---------------------------------------------------------------------------
let state;       // MusicState — reactive IR
let clickTrack;  // ClickTrack
let renderer;    // ScoreRenderer
let notePlayer;  // NotePlayer

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const app = {
  phase: 'idle',          // idle | loaded | countdown | recording | reviewing | editing
  holds: [],              // { down, up } ms pairs — one per note
  noteDown: null,         // timestamp of current keydown (null when key is up)
  countInBeatsLeft: 0,
  recordingStartTime: 0,
  currentNoteIdx: 0,
  beatIdx: 0,
  isScorePlaying: false,
  scorePlaybackPreviousRedoDisabled: true,
  selectedScoreTab: 'score',
  editCursor: 0,          // note index currently under the edit cursor
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
let elInputAbc, elOutputAbc, elNoteStrip, elTapBtn, elTransportStatus,
    elStartBtn, elPlayScoreBtn, elStopBtn, elRedoBtn, elEditBtn, elCopyBtn, elClearBtn, elLoadBtn,
    elExampleBtn, elBeatDisplay, elBpmSlider, elBpmLabel, elBpmSource,
    elTimeSigDisplay, elResolution, elCountIn;

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
function getSettings() {
  return {
    // timeSig and bpm are derived from parsed ABC, not from dropdowns
    timeSig:     state.timeSignature || '4/4',
    bpm:         parseInt(elBpmSlider.value, 10),
    resolution:  elResolution.value,
    countIn:     parseInt(elCountIn.value, 10),
  };
}

function parseTimeSig(sig) {
  if (sig === '2/2') return 2;
  const parts = sig.split('/');
  return parseInt(parts[0], 10) || 4;
}

// ---------------------------------------------------------------------------
// Beat-dot display
// ---------------------------------------------------------------------------
function buildBeatDots(beatsPerMeasure) {
  elBeatDisplay.innerHTML = '';
  for (let i = 0; i < beatsPerMeasure; i++) {
    const d = document.createElement('div');
    d.className = 'beat-dot' + (i === 0 ? ' downbeat' : '');
    d.id = `beat-dot-${i}`;
    elBeatDisplay.appendChild(d);
  }
}

function flashBeat(beatIdx) {
  document.querySelectorAll('.beat-dot').forEach((d, i) => {
    d.classList.toggle('active', i === beatIdx);
  });
}

// ---------------------------------------------------------------------------
// Note strip rendering
// ---------------------------------------------------------------------------
function renderNoteStrip() {
  elNoteStrip.innerHTML = '';
  if (!state || state.noteCount === 0) {
    elNoteStrip.innerHTML = '<span style="color:var(--muted);font-size:0.8rem">Notes appear here after loading.</span>';
    return;
  }

  // Rebuild from raw tokens so we can show bar lines too
  const tokens = state.tokens || state.notes; // fall back gracefully
  (tokens || state.notes).forEach(tok => {
    if (tok.type === 'bar') {
      const el = document.createElement('div');
      el.className = 'note-chip bar';
      el.textContent = '|';
      elNoteStrip.appendChild(el);
      return;
    }
    if (tok.type !== 'note' && tok.type !== 'rest') return;

    const chip = document.createElement('div');
    chip.className = 'note-chip' + (tok.type === 'rest' ? ' rest' : '');
    chip.id = `chip-${tok.index}`;

    const pitchEl = document.createElement('span');
    pitchEl.textContent = tok.type === 'rest'
      ? 'z'
      : (tok.accidental || '') + tok.pitch.toUpperCase() + (tok.octave || '').replace(/,/g, '↓').replace(/'/g, '↑');

    const durEl = document.createElement('span');
    durEl.className = 'dur-label';
    durEl.id = `dur-${tok.index}`;
    durEl.textContent = tok.durationABC || '—';

    chip.appendChild(pitchEl);
    chip.appendChild(durEl);

    if (app.phase === 'recording') {
      if (tok.index < app.currentNoteIdx) chip.classList.add('done');
      else if (tok.index === app.currentNoteIdx) chip.classList.add('active');
    } else if (app.phase === 'reviewing') {
      chip.classList.add('done');
    } else if (app.phase === 'editing') {
      if (tok.index === app.editCursor) chip.classList.add('cursor');
      else if (tok.durationABC) chip.classList.add('done');
    }

    elNoteStrip.appendChild(chip);
  });
}

// Update just the duration label and chip state for a single note (reactive, no full re-render)
function updateChip(noteIndex, durationABC) {
  const durEl = $(`dur-${noteIndex}`);
  if (durEl) durEl.textContent = durationABC || '—';
}

function advanceActiveChip(newIdx) {
  const prev = $(`chip-${newIdx - 1}`);
  if (prev) { prev.classList.remove('active'); prev.classList.add('done'); }
  const next = $(`chip-${newIdx}`);
  if (next) {
    next.classList.add('active');
    next.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
}

// ---------------------------------------------------------------------------
// Reactive: MusicState → renderer (live re-render on every state change)
// ---------------------------------------------------------------------------
function onStateChange() {
  // Update score live
  renderer.render(state.toABC());
  applyScoreTabVisibility();

  // Update duration labels on chips
  state.notes.forEach(note => {
    updateChip(note.index, note.durationABC);
  });

  // Update ABC output textarea
  elOutputAbc.value = state.toABC();
  elCopyBtn.disabled = false;
}

// ---------------------------------------------------------------------------
// Loading ABC
// ---------------------------------------------------------------------------
function loadABC() {
  if (app.isScorePlaying) stopScorePlayback();

  const text = elInputAbc.value.trim();
  if (!text) return;

  state.parseABC(text);
  if (state.noteCount === 0) {
    setStatus('No notes found — check your ABC notation.', '');
    return;
  }

  // Populate derived settings from parsed ABC
  const timeSig = state.timeSignature || '4/4';
  elTimeSigDisplay.textContent = timeSig;

  if (state.tempo) {
    elBpmSlider.value = state.tempo;
    elBpmLabel.textContent = state.tempo;
    elBpmSource.textContent = '(from Q:)';
  } else {
    elBpmLabel.textContent = elBpmSlider.value;
    elBpmSource.textContent = '(override)';
  }
  elBpmSlider.disabled = false;

  buildBeatDots(parseTimeSig(timeSig));

  app.phase = 'loaded';
  renderNoteStrip();
  renderer.render(state.toABC());
  applyScoreTabVisibility();
  elOutputAbc.value = state.toABC();

  elStartBtn.disabled = false;
  elPlayScoreBtn.disabled = false;
  elClearBtn.disabled = false;
  elRedoBtn.disabled = true;
  elEditBtn.disabled = false;
  elCopyBtn.disabled = false;

  setStatus(`${state.noteCount} notes loaded. Press Start or ✎ Edit.`, 'ready');
}

// ---------------------------------------------------------------------------
// Start / Stop / Redo
// ---------------------------------------------------------------------------
function startSession() {
  if (app.phase === 'idle' || state.noteCount === 0) return;
  if (app.isScorePlaying) stopScorePlayback();

  const s = getSettings();
  const beatsPerMeasure = parseTimeSig(s.timeSig);
  const totalCountInBeats = s.countIn * beatsPerMeasure;

  // Reset recording state
  app.holds = [];
  app.currentNoteIdx = 0;
  app.countInBeatsLeft = totalCountInBeats;
  // If there is no count-in, align the recording grid with the first scheduled click.
  // ClickTrack starts its first tick ~50ms in the future.
  app.recordingStartTime = totalCountInBeats > 0 ? 0 : Date.now() + 50;
  app.phase = totalCountInBeats > 0 ? 'countdown' : 'recording';

  // Configure and start click track
  clickTrack.configure({
    bpm: s.bpm,
    beatsPerMeasure,
  });

  clickTrack.start(onTick);

  // UI
  elStartBtn.disabled = true;
  elPlayScoreBtn.disabled = true;
  elStopBtn.disabled = false;
  elTapBtn.disabled = app.phase === 'countdown'; // can't tap during count-in
  elTapBtn.className = 'tap-btn' + (app.phase === 'recording' ? ' recording' : '');
  elRedoBtn.disabled = true;
  elEditBtn.disabled = true;
  renderNoteStrip();

  if (app.phase === 'countdown') {
    setStatus(`Count-in: ${totalCountInBeats} beats…`, '');
    elTapBtn.textContent = 'Waiting for count-in…';
  } else {
    setStatus(`Recording — hold Shift (or tap) for each note! (${state.noteCount} notes)`, 'recording');
    elTapBtn.textContent = `SHIFT/TAP — Note 1 of ${state.noteCount}`;
  }
}

function stopSession() {
  clickTrack.stop();
  notePlayer.stopAll();
  app.noteDown = null;
  app.phase = app.holds.length > 0 ? 'reviewing' : 'loaded';
  elStopBtn.disabled = true;
  elStartBtn.disabled = false;
  elPlayScoreBtn.disabled = false;
  elRedoBtn.disabled = false;
  elEditBtn.disabled = false;
  elTapBtn.disabled = true;
  elTapBtn.className = 'tap-btn';
  elTapBtn.textContent = 'SHIFT  /  TAP';
  document.querySelectorAll('.beat-dot').forEach(d => d.classList.remove('active'));

  if (app.holds.length >= 1) {
    finalizeQuantization();
    setStatus('Done — score updated. Redo to re-record.', 'ready');
  } else {
    setStatus('Stopped. Press Start to try again.', '');
  }
  renderNoteStrip();
}

function redoSession() {
  state.clearDurations();
  app.phase = 'loaded';
  app.holds = [];
  app.noteDown = null;
  app.currentNoteIdx = 0;
  elRedoBtn.disabled = true;
  elEditBtn.disabled = false;
  elPlayScoreBtn.disabled = false;
  elTapBtn.disabled = true;
  elTapBtn.textContent = 'SHIFT  /  TAP';
  renderNoteStrip();
  setStatus(`${state.noteCount} notes ready. Press Start.`, 'ready');
}

// ---------------------------------------------------------------------------
// Click track tick handler
// ---------------------------------------------------------------------------
function onTick({ beat }) {
  // Visual beat flash on every beat.
  flashBeat(beat);

  // Count-in phase
  if (app.phase === 'countdown') {
    app.countInBeatsLeft--;
    if (app.countInBeatsLeft <= 0) {
      // Count-in done → switch to recording
      app.phase = 'recording';
      app.recordingStartTime = Date.now();
      elTapBtn.disabled = false;
      elTapBtn.className = 'tap-btn recording';
      elTapBtn.textContent = `SHIFT/TAP — Note 1 of ${state.noteCount}`;
      setStatus(`Recording — hold Shift (or tap) for each note!`, 'recording');
    } else {
      setStatus(`Count-in: ${app.countInBeatsLeft} beats…`, '');
    }
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Keydown / keyup hold handlers
// ---------------------------------------------------------------------------
function onNoteKeyDown() {
  if (app.phase !== 'recording') return;
  if (app.noteDown !== null) return; // already held (ignore repeat)
  if (app.currentNoteIdx >= state.noteCount) return;

  app.noteDown = Date.now();

  // Play the note — sustain until keyup
  const note = state.notes[app.currentNoteIdx];
  if (note && note.type === 'note') {
    notePlayer.startNote(note.pitch, note.accidental || '', note.octave || '');
  }

  // Visual
  advanceActiveChip(app.currentNoteIdx);
  const remaining = state.noteCount - app.currentNoteIdx;
  elTapBtn.textContent = `HOLD — Note ${app.currentNoteIdx + 1} of ${state.noteCount}`;
  setStatus(`Holding note ${app.currentNoteIdx + 1} — release to advance.`, 'recording');
}

function onNoteKeyUp() {
  if (app.phase !== 'recording') return;
  if (app.noteDown === null) return;

  const up = Date.now();
  const down = app.noteDown;
  app.noteDown = null;

  // Stop the sustained note
  notePlayer.stopCurrentNote();

  // Record the hold
  app.holds.push({ down, up });
  app.currentNoteIdx++;

  // Live quantize after each completed hold
  liveQuantize();

  if (app.currentNoteIdx >= state.noteCount) {
    finalizeQuantization();
    stopSession();
    return;
  }

  const remaining = state.noteCount - app.currentNoteIdx;
  elTapBtn.textContent = `SHIFT/TAP — Note ${app.currentNoteIdx + 1} of ${state.noteCount}`;
  setStatus(`${remaining} note${remaining !== 1 ? 's' : ''} remaining.`, 'recording');
}

// Legacy single-tap fallback (tap button click)
function recordTap() {
  if (app.noteDown === null) {
    onNoteKeyDown();
  } else {
    onNoteKeyUp();
  }
}

// ---------------------------------------------------------------------------
// Quantization — pure logic lives in quantize-holds.js (window.QuantizeHolds)
// so it can be unit tested under Node. Bind the names used below.
// ---------------------------------------------------------------------------
const { quantizeHoldsToGrid } = window.QuantizeHolds;

function liveQuantize() {
  if (app.holds.length === 0) return;
  const s = getSettings();
  const bpm = parseInt(elBpmSlider.value, 10);

  // Quantize note starts to the click grid and derive durations from snapped
  // starts. Releases get extra leniency because they are articulation, not the
  // primary rhythmic event.
  const beatsPerMeasure = parseTimeSig(s.timeSig);
  const { durations, restsAfter } = quantizeHoldsToGrid(app.holds, bpm, s.resolution, app.recordingStartTime, beatsPerMeasure);

  if (typeof state.setAllDurationsAndInsertedRests === 'function') {
    state.setAllDurationsAndInsertedRests(durations, restsAfter);
  } else {
    state.setAllDurations(durations);
  }
}

function finalizeQuantization() {
  liveQuantize();
  if (typeof state.setHeaderTempo === 'function') {
    state.setHeaderTempo(parseInt(elBpmSlider.value, 10));
  }
}

// ---------------------------------------------------------------------------
// Manual Duration Edit Mode
// ---------------------------------------------------------------------------

/**
 * Number-key → quarter-note beat count mapping.
 * 1=quarter, 2=half, 3=dotted-half, 4=whole, 8=eighth, 6=sixteenth, 5=thirty-second
 */
const EDIT_KEY_BEATS = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '8': 0.5,
  '6': 0.25,
  '5': 0.125,
};

/** Human-readable label for edit-mode duration keys. */
const EDIT_KEY_LEGEND = '1=♩ 2=𝅗 3=𝅗. 4=𝅝 8=♪ 6=16th 5=32nd';

function enterEditMode() {
  if (state.noteCount === 0) return;
  if (app.isScorePlaying) stopScorePlayback();

  // Start cursor at first note without a duration, or note 0
  const notes = state.notes;
  const firstUnset = notes.find(n => !n.durationABC);
  app.editCursor = firstUnset ? firstUnset.index : notes[0].index;

  app.phase = 'editing';

  elStartBtn.disabled = true;
  elStopBtn.disabled = true;
  elRedoBtn.disabled = true;
  elPlayScoreBtn.disabled = false;
  elEditBtn.textContent = '✓ Done';
  elEditBtn.className = 'btn-primary';
  elTapBtn.disabled = false;
  elTapBtn.className = 'tap-btn';
  elTapBtn.textContent = EDIT_KEY_LEGEND + '  ◄► navigate  Esc=done';

  renderNoteStrip();
  updateEditCursorUI();
}

function exitEditMode() {
  const hasDurations = state.notes.some(n => n.durationABC);
  app.phase = hasDurations ? 'reviewing' : 'loaded';

  if (renderer) renderer.clearHighlight();

  elStartBtn.disabled = false;
  elPlayScoreBtn.disabled = false;
  elStopBtn.disabled = true;
  elRedoBtn.disabled = !hasDurations;
  elEditBtn.textContent = '✎ Edit';
  elEditBtn.className = 'btn-secondary';
  elTapBtn.disabled = true;
  elTapBtn.className = 'tap-btn';
  elTapBtn.textContent = 'SHIFT  /  TAP';

  renderNoteStrip();
  setStatus(hasDurations ? 'Done — score updated.' : `${state.noteCount} notes ready. Press Start or Edit.`, 'ready');
}

function toggleEditMode() {
  if (app.phase === 'editing') exitEditMode();
  else if (app.phase === 'loaded' || app.phase === 'reviewing') enterEditMode();
}

/**
 * Move the edit cursor by delta (+1 forward, -1 backward).
 * Wraps at boundaries (stays at first/last note).
 */
function moveCursor(delta) {
  const notes = state.notes;
  if (!notes.length) return;
  const currentPos = notes.findIndex(n => n.index === app.editCursor);
  const newPos = Math.max(0, Math.min(notes.length - 1, currentPos + delta));
  if (newPos === currentPos) return;
  app.editCursor = notes[newPos].index;
  updateEditCursorUI();
}

/**
 * Assign an ABC duration to the note at the current edit cursor,
 * play it as audio feedback, then advance the cursor.
 */
function assignDuration(beats) {
  const abcDur = Quantize.beatsToABC(beats);
  state.setDuration(app.editCursor, abcDur);  // triggers onStateChange (score re-render)

  // Audio feedback
  const note = state.notes.find(n => n.index === app.editCursor);
  if (note && note.type === 'note') {
    const bpm = parseInt(elBpmSlider.value, 10) || 100;
    const durationMs = Math.min(beats * 60000 / bpm, 2000);
    notePlayer.playNote(note.pitch, note.accidental || '', note.octave || '', durationMs);
  }

  // Advance or stay at end
  const notes = state.notes;
  const currentPos = notes.findIndex(n => n.index === app.editCursor);
  if (currentPos < notes.length - 1) {
    app.editCursor = notes[currentPos + 1].index;
  }
  // onStateChange re-renders the score SVG (clearing highlight); restore it
  updateEditCursorUI();
}

/** Update chip highlight + score highlight + status for current edit cursor. */
function updateEditCursorUI() {
  // Chip: remove old cursor class, add to new
  document.querySelectorAll('.note-chip.cursor').forEach(c => c.classList.remove('cursor'));
  const chip = $(`chip-${app.editCursor}`);
  if (chip) {
    chip.classList.add('cursor');
    chip.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }

  // Score highlight
  if (renderer) renderer.highlightNote(app.editCursor);

  // Status
  const notes = state.notes;
  const pos = notes.findIndex(n => n.index === app.editCursor);
  const note = notes[pos];
  if (note) {
    const label = note.type === 'rest'
      ? 'z (rest)'
      : (note.accidental || '') + note.pitch.toUpperCase() +
        (note.octave || '').replace(/,/g, '↓').replace(/'/g, '↑');
    const assigned = note.durationABC ? ` [${note.durationABC || '—'}]` : ' [unset]';
    setStatus(
      `Edit ${pos + 1}/${notes.length}: ${label}${assigned} — ${EDIT_KEY_LEGEND}  ◄► navigate  Esc=done`,
      'ready'
    );
  }
}

// ---------------------------------------------------------------------------
// Score playback (plays loaded ABC exactly as parsed; no recording/quantizing)
// ---------------------------------------------------------------------------
function canPlayScore() {
  return state && state.noteCount > 0 && (app.phase === 'loaded' || app.phase === 'reviewing');
}

function startScorePlayback() {
  if (!canPlayScore() || app.isScorePlaying) return;

  app.isScorePlaying = true;
  app.scorePlaybackPreviousRedoDisabled = elRedoBtn.disabled;
  elPlayScoreBtn.textContent = '■ Stop Playback';
  elPlayScoreBtn.disabled = false;
  elStartBtn.disabled = true;
  elStopBtn.disabled = true;
  elRedoBtn.disabled = true;
  elEditBtn.disabled = true;
  elTapBtn.disabled = true;

  const bpm = state.tempo || parseInt(elBpmSlider.value, 10);
  setStatus('Playing score…', 'ready');

  const playbackSource = (state.playbackNotes && state.playbackNotes.length)
    ? state.playbackNotes
    : state.notes;

  notePlayer.playSequence(playbackSource, {
    bpm,
    unitNoteLength: state.unitNoteLength || 1 / 4,
    onNote: (note) => {
      if (note.type === 'note' && renderer && typeof renderer.highlightNote === 'function') {
        renderer.highlightNote(note.index);
      }
    },
    onEnd: () => {
      stopScorePlayback({ ended: true });
    },
  }).catch((err) => {
    console.error('[ScorePlayback] Failed to play score:', err);
    stopScorePlayback();
    setStatus('Could not play score — check browser audio permissions.', '');
  });
}

function stopScorePlayback({ ended = false } = {}) {
  if (!app.isScorePlaying && !ended) return;

  notePlayer.stopAll();
  app.isScorePlaying = false;
  elPlayScoreBtn.textContent = '▶ Play Score';
  elPlayScoreBtn.disabled = !canPlayScore();
  elStartBtn.disabled = app.phase === 'idle' || state.noteCount === 0 || app.phase === 'editing';
  elStopBtn.disabled = true;
  elRedoBtn.disabled = app.scorePlaybackPreviousRedoDisabled || app.phase === 'editing';
  elEditBtn.disabled = app.phase === 'idle' || state.noteCount === 0;
  if (renderer && typeof renderer.clearHighlight === 'function') {
    renderer.clearHighlight();
  }

  if (canPlayScore()) {
    setStatus(ended ? 'Playback finished.' : 'Playback stopped.', 'ready');
  }
}

function toggleScorePlayback() {
  if (app.isScorePlaying) stopScorePlayback();
  else startScorePlayback();
}

// ---------------------------------------------------------------------------
// Status helper
// ---------------------------------------------------------------------------
function setStatus(msg, cls) {
  elTransportStatus.textContent = msg;
  elTransportStatus.className = 'transport-status' + (cls ? ` ${cls}` : '');
}

// ---------------------------------------------------------------------------
// Score tabs
// ---------------------------------------------------------------------------
function applyScoreTabVisibility() {
  const selected = app.selectedScoreTab;

  document.querySelectorAll('.score-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === selected);
  });

  $('score-container').style.display = selected === 'score' ? '' : 'none';
  $('abc-output-panel').style.display = selected === 'abc' ? '' : 'none';
}

function initTabs() {
  document.querySelectorAll('.score-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      app.selectedScoreTab = tab.dataset.tab;
      applyScoreTabVisibility();
    });
  });

  applyScoreTabVisibility();
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
function copyABC() {
  const text = state.toABC();
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const orig = elCopyBtn.textContent;
    elCopyBtn.textContent = 'Copied!';
    setTimeout(() => { elCopyBtn.textContent = orig; }, 1500);
  });
}

// ---------------------------------------------------------------------------
// Example tune
// ---------------------------------------------------------------------------
const EXAMPLE_ABC = `X:1
T:Twinkle Twinkle
M:4/4
L:1/4
Q:1/4=100
K:C
CCGG AAG FFEE DDC|GGFF EED GGFF EED|CCGG AAG FFEE DDC|]`;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  elInputAbc       = $('input-abc');
  elOutputAbc      = $('output-abc');
  elNoteStrip      = $('note-strip');
  elTapBtn         = $('tap-btn');
  elTransportStatus= $('transport-status');
  elStartBtn       = $('start-btn');
  elPlayScoreBtn   = $('play-score-btn');
  elStopBtn        = $('stop-btn');
  elRedoBtn        = $('redo-btn');
  elEditBtn        = $('edit-btn');
  elCopyBtn        = $('copy-btn');
  elClearBtn       = $('clear-btn');
  elLoadBtn        = $('load-btn');
  elExampleBtn     = $('example-btn');
  elBeatDisplay    = $('beat-display');
  elBpmSlider      = $('bpm-slider');
  elBpmLabel       = $('bpm-label');
  elBpmSource      = $('bpm-source');
  elTimeSigDisplay = $('time-sig-display');
  elResolution     = $('resolution');
  elCountIn        = $('count-in');

  // Instantiate modules
  state      = new MusicState();
  clickTrack = new ClickTrack();
  renderer   = new ScoreRenderer('score-container');
  notePlayer = new NotePlayer();

  // Reactive: any state change → re-render score + update UI
  state.subscribe(onStateChange);

  // BPM slider label
  elBpmSlider.addEventListener('input', () => {
    elBpmLabel.textContent = elBpmSlider.value;
  });

  // BPM slider → clear the Q: attribution once user overrides
  elBpmSlider.addEventListener('input', () => {
    elBpmLabel.textContent = elBpmSlider.value;
    elBpmSource.textContent = '(override)';
  });

  // Buttons
  elLoadBtn.addEventListener('click', loadABC);
  elExampleBtn.addEventListener('click', () => {
    elInputAbc.value = EXAMPLE_ABC;
    loadABC();
  });
  elClearBtn.addEventListener('click', () => {
    stopScorePlayback();
    elInputAbc.value = '';
    elOutputAbc.value = '';
    state.parseABC('');
    app.phase = 'idle';
    app.tapTimes = [];
    clickTrack.stop();
    renderer.clear();
    applyScoreTabVisibility();
    renderNoteStrip();
    elStartBtn.disabled = true;
    elPlayScoreBtn.disabled = true;
    elStopBtn.disabled = true;
    elRedoBtn.disabled = true;
    elEditBtn.disabled = true;
    elCopyBtn.disabled = true;
    elClearBtn.disabled = true;
    elTapBtn.disabled = true;
    setStatus('Load ABC to begin.', '');
  });
  elStartBtn.addEventListener('click', startSession);
  elPlayScoreBtn.addEventListener('click', toggleScorePlayback);
  elStopBtn.addEventListener('click', stopSession);
  elRedoBtn.addEventListener('click', redoSession);
  elEditBtn.addEventListener('click', toggleEditMode);
  elCopyBtn.addEventListener('click', copyABC);
  elTapBtn.addEventListener('click', recordTap);

  // Shift key hold timing. Mouse/touch still uses the tap button toggle.
  const isTextEntryTarget = (target) => {
    const tag = target && target.tagName;
    return target && (
      target.isContentEditable ||
      tag === 'TEXTAREA' ||
      tag === 'INPUT' ||
      tag === 'SELECT'
    );
  };

  document.addEventListener('keydown', e => {
    if (isTextEntryTarget(e.target)) return;

    // ── Edit mode key handling ──
    if (app.phase === 'editing' && !e.repeat) {
      if (EDIT_KEY_BEATS[e.key] !== undefined) {
        e.preventDefault();
        assignDuration(EDIT_KEY_BEATS[e.key]);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        moveCursor(-1);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        moveCursor(1);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        exitEditMode();
        return;
      }
    }

    // ── Click-track recording key handling ──
    if (e.key !== 'Shift' || e.repeat || app.phase !== 'recording') return;
    e.preventDefault();
    onNoteKeyDown();
  });

  document.addEventListener('keyup', e => {
    if (e.key !== 'Shift' || app.phase !== 'recording') return;
    if (isTextEntryTarget(e.target) && app.noteDown === null) return;
    e.preventDefault();
    onNoteKeyUp();
  });

  // Score tabs
  initTabs();
  buildBeatDots(4);
  setStatus('Load ABC to begin.', '');
});
