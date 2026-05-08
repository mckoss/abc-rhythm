# abc-rhythm

**Tap your way from a melody to a scored piece.**

`abc-rhythm` is a browser-based tool that takes an [ABC notation](https://abcnotation.com/) file — notes with no durations — and lets you tap the spacebar in time to assign real rhythmic values to each note. The result is a fully annotated ABC file ready for import into MuseScore, EasyABC, or any ABC-compatible tool.

---

## The Problem It Solves

If you keep a **fake book** or melody sketchpad where you jot down note sequences without worrying about exact timing — just the pitches — you know the rhythm in your head but getting it into a notation program means fighting an interactive editor note by note.

`abc-rhythm` flips that: you write the notes as plain ABC text, then *play* the melody by tapping the spacebar. The tool measures your tap intervals, quantizes them to standard note values, and writes the durations back into the ABC.

**Input:**
```abc
X:1
T:My Tune
M:4/4
L:1/4
K:C
CDEC CDEC EFGF EFG z|
```

**Tap through it** in rhythm — the app times each tap — then get back:
```abc
X:1
T:My Tune
M:4/4
L:1/4
K:C
C D E2 C D E2 E F G2 E F G2 z2|
```

---

## How to Use It

1. **Open `index.html`** in any modern browser (no server needed, no install).
2. **Paste your ABC notation** into the left panel. Notes without durations are fine — existing durations will be replaced.
3. Click **Start Tapping** (or press Enter).
4. The notes scroll by one at a time. **Press Spacebar** (or tap the screen) each time the next note should sound.
5. Press Spacebar one final time to mark the end of the last note.
6. The app quantizes your taps and shows the **annotated ABC** in the right panel.
7. **Copy** or **Download** the result.

### Tips
- Play along with the melody in your head or hum it while tapping.
- Mistakes? Hit **Redo** to try again — your original file is never modified.
- The quantization snaps to standard values: whole, dotted half, half, dotted quarter, quarter, dotted eighth, eighth, sixteenth.
- The beat reference is derived from your median tap interval, so you don't need to tap at a fixed BPM — just play naturally.

---

## ABC Notation Primer

ABC is plain text music notation. A minimal tune looks like:

```
X:1
T:Title
M:4/4        ← time signature
L:1/4        ← default note length (quarter note)
K:C          ← key signature
CDEF GABc|   ← notes (C D E F G A B c)
```

Uppercase = lower octave, lowercase = higher octave. Durations: `C2` = half note, `C/` = eighth note, `C3/2` = dotted quarter. `abc-rhythm` writes these for you.

Full reference: <https://abcnotation.com/wiki/abc:standard:v2.1>

---

## Supported ABC Subset

abc-rhythm targets **lead sheet / fake book** use cases — melody, chords, structure. It does not attempt to be a general ABC renderer. The goal is clean round-tripping: any element that goes in comes back out unchanged, whether or not the app understands it.

### Headers — fully parsed and used

| Field | Example | Used for |
|---|---|---|
| `X:` | `X:1` | Tune index (required by spec) |
| `T:` | `T:Autumn Leaves` | Title display |
| `M:` | `M:4/4` | Time signature → beats per measure for click track and quantization |
| `L:` | `L:1/4` | Default note length (unit for duration output) |
| `Q:` | `Q:1/4=120` or `Q:120` | Tempo → seeds BPM slider |
| `K:` | `K:Bb` or `K:Dorian` | Key signature → passed to abcjs for correct rendering and accidentals |

All other header lines (`C:`, `A:`, `Z:`, `H:`, `N:`, `S:`, `R:`, `B:`, `D:`, `F:`, `G:`, `I:`, `O:`, `P:`, `V:`, `W:`, `r:`) are **retained verbatim** and written back unchanged. They are not parsed or displayed.

### Notes and rests — fully supported

- **Pitch**: `A–G` (lower octave), `a–g` (higher octave)
- **Octave modifiers**: `,` (down an octave) and `'` (up), repeatable: `C,,` `c''`
- **Accidentals**: `^` (sharp), `^^` (double sharp), `_` (flat), `__` (double flat), `=` (natural)
- **Durations**: integer multipliers (`C2` = half note), fractional (`C/` or `C/2` = eighth, `C3/2` = dotted quarter) — these are what the quantizer writes
- **Rests**: `z` (visible rest) with full duration syntax; treated as a note slot in the tap sequence
- **Invisible rests**: `x` — retained, treated same as `z` in the tap sequence
- **Chords** (simultaneous notes): `[CEG]` — the chord is treated as a single tap slot; duration applied to the whole chord

### Structure — supported

- **Bar lines**: `|` `||` `|]` `[|` — retained verbatim, not tap slots
- **Repeat bars**: `|:` `:|` `::` — retained verbatim
- **Ties**: `-` between notes — retained; quantizer does not merge tied notes (yet)
- **Broken rhythm**: `>` and `<` (dotted-rhythm shorthand) — retained verbatim; not rewritten by the quantizer
- **Tuplets**: `(3` `(5` etc. — retained verbatim as text; each note inside is still a tap slot

### Chord symbols (guitar/lead sheet chords) — retained

Chord symbols written above notes (e.g. `"C"C "G7"B`) are **retained verbatim** and rendered by abcjs. They are not tap slots. This is important for fake book use — chord symbols ride through the round-trip untouched.

### Decorations and annotations — retained, not parsed

All decoration syntax is passed through unchanged:
- Short decorations: `.` (staccato), `~` (roll/ornament), `H` (fermata), `L` (accent), `M` (mordent), `O` (coda), `P` (presto), `S` (segno), `T` (trill), `u` (up-bow), `v` (down-bow)
- Long decorations: `!fermata!`, `!trill!`, `!>!`, etc.
- Text annotations: `"^above"`, `"_below"`, `"<left"`, `">right"` — retained but not rendered specially
- Grace notes: `{g}` — retained verbatim, not a tap slot

### Transposition — retained, not processed

ABC 2.1 provides two transposition mechanisms:

- **`I:transpose <semitones>`** — standard 2.1 directive, transposes both score and playback. Example: `I:transpose -2` (down a whole step).
- **`K:` transpose modifier** — e.g. `K:Am transpose=-2` applies a fixed offset within a key field.
- **`%%transpose n`** — older abcm2ps extension directive; synonymous with `I:transpose`.

All three are **retained verbatim** and passed through to abcjs (which does handle them for rendering). The abc-rhythm parser does not interpret or apply them — pitch values in the IR are stored as written, not concert pitch. This means a file with `I:transpose -2` will round-trip correctly for a transposing instrument workflow.

> **Future:** A transpose UI ("concert pitch ↔ Bb instrument") is on the roadmap, which would use these fields.

### Lyrics and other body-text fields — retained, not shown

`w:` (lyric lines), `s:` (symbol lines), and `W:` (word lines) are retained in the token stream and written back in `toABC()` output. They are not displayed in the score strip or used in quantization.

### What is explicitly out of scope

- **Multi-tune files** (`X:2`, `X:3`, …): only the first tune is parsed. Subsequent tunes are retained as trailing text.
- **MIDI directives** (`%%MIDI program`, `%%MIDI control`, etc.): retained as raw text, not processed. These are what caused the EasyABC playback bugs this tool was partly born from.
- **Full rendering fidelity**: abcjs handles rendering. We rely on it entirely for display. abc-rhythm's parser only needs to identify tap-slot boundaries and write durations — not render.

---

## Technical Notes

- Pure HTML + JavaScript, zero dependencies, no build step.
- Uses [abcjs](https://paulrosen.github.io/abcjs/) (CDN) for score rendering.
- Quantization algorithm: median inter-tap interval = one beat; each interval snapped to the nearest standard duration (±20% tolerance before promoting to next value).
- Works offline once the page has loaded (abcjs cached by browser).

---

## Roadmap

- [x] Visual score rendering (abcjs, live re-render on every tap)
- [x] Click track with emphasized downbeat (Web Audio API)
- [x] Configurable resolution (quarter / eighth / sixteenth / 32nd)
- [x] Count-in measures before recording
- [x] Beat-grid quantization (not just median-interval)
- [ ] Re-quantize live when resolution/BPM settings change (tap data already stored)
- [ ] MIDI playback of annotated result via abcjs
- [ ] Undo last tap
- [ ] Transpose UI (concert pitch ↔ Bb/Eb instrument)
- [ ] Mobile touch support (tap anywhere on screen)
- [ ] Save/load ABC files from local filesystem
- [ ] Tied-note merging in quantizer
- [ ] Multi-tune file support (X:2, X:3, …)

---

## Author

Mike Koss — [@mckoss](https://github.com/mckoss)

Built because fighting notation editors is less fun than playing music.
