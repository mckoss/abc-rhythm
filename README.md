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

## Technical Notes

- Pure HTML + JavaScript, zero dependencies, no build step.
- Uses [abcjs](https://paulrosen.github.io/abcjs/) (CDN) for score rendering.
- Quantization algorithm: median inter-tap interval = one beat; each interval snapped to the nearest standard duration (±20% tolerance before promoting to next value).
- Works offline once the page has loaded (abcjs cached by browser).

---

## Roadmap

- [ ] Visual score rendering with note highlighting during tap session
- [ ] MIDI playback of annotated result via abcjs
- [ ] Undo last tap
- [ ] Tap to set tempo first (metronome mode)
- [ ] Mobile touch support (tap anywhere on screen)
- [ ] Save/load ABC files from local filesystem
- [ ] Multiple voices / chords

---

## Author

Mike Koss — [@mckoss](https://github.com/mckoss)

Built because fighting notation editors is less fun than playing music.
