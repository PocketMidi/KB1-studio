# KB1 Studio — PTI Export Skill

## Purpose
Everything needed to build the `.pti` Beat-Slice instrument export for the
Polyend Tracker Mini (and Tracker / Tracker+) from KB1 Studio.

---

## PTI File Format (confirmed from source + real files)

### Structure
```
[ PTI Header   ]  16 bytes  — "TI" magic + fw version + struct version + size
[ Main Fields  ] 376 bytes  — playmode, sample slot, automations, slices, etc.
[ Raw PCM Data ]  variable  — 16-bit signed PCM, NO RIFF wrapper
[ CRC          ]   4 bytes  — appended but not verified by hardware
```

### Audio encoding rules
- **Sample rate**: always 44 100 Hz (hardware USB interface locks to this)
- **Bit depth**: 16-bit stored in file; `bitdepth` metadata field valid range 4–16
- **Channels**: stereo supported (Tracker Mini is stereo) — stored **de-interleaved**:
  all L samples contiguous, then all R samples contiguous (NOT interleaved)
- **No WAV header** inside the PTI — raw PCM bytes only

### Slice positions
Positions in `slices[]` are **normalised** `uint16` values (0–65 535), NOT raw frames:
```typescript
// MAX_16BIT = 65535 (exported from @polyend/tracker-lib)
const normalisedSlices = rawFrameOffsets.map(
  (frameOffset) => Math.round((frameOffset / totalFrames) * MAX_16BIT)
);
```
- `slices[]` always has exactly **48 entries**; unused entries are zero
- `numSlices` = how many are actually used (0–47, i.e. 1–48 active slices)
- `selectedSlice` = last-active slice index (set to 0 for new exports)

### PlayMode enum
```typescript
import { InstrumentPlayMode } from '@polyend/tracker-lib';
// InstrumentPlayMode.BeatSlice = 5  ← what we use
// InstrumentPlayMode.Slice = 4      ← manual slice (no beat-sync)
// InstrumentPlayMode.OneShot = 0
```

---

## Real-file measurements (drum kits from public/)

| File | Slices | Duration/slot | Total audio | File size |
|---|---|---|---|---|
| Analog 2 20p.pti | 20 | 0.5 s stereo | 10 s | 1.72 MB |
| 80s 21p.pti | 21 | 0.5 s stereo | 10.5 s | 1.81 MB |
| Acid 33p.pti | 33 | 0.5 s stereo | 16.5 s | 2.84 MB |

Tracker Mini has ~32 MB sample RAM. Practical soft limit ~15 MB; danger above ~20 MB.

Size formula (bytes):
```
PTI_OVERHEAD = 16 + 376 + 4 = 396
audioBytes   = assignedSlots × slotDuration × 44100 × (bitDepth/8) × channels
totalBytes   = PTI_OVERHEAD + audioBytes
```

---

## Dependencies

```bash
npm install @polyend/tracker-lib wavefile
```

- **`@polyend/tracker-lib`** — official Polyend library; handles all PTI header/write logic
  - `Tracker.createInstrument(wavBuffer)` — create instrument from WAV ArrayBuffer
  - `Tracker.writeInstrument(instrument)` — serialise to PTI ArrayBuffer
  - `InstrumentPlayMode`, `MAX_16BIT`, `SAMPLE_RATE` — exported constants
- **`wavefile`** — handles sample-rate conversion, bit-depth reduction, WAV assembly
  - `wav.toSampleRate(targetRate)` — resample
  - `wav.toBitDepth('8')` — reduce bit depth
  - `wav.fromScratch(channels, sampleRate, bitDepth, samples)` — build from raw Int16Array
  - `wav.toBuffer().buffer` — get ArrayBuffer for tracker-lib

---

## Export module: `src/ptiExport.ts`

```typescript
import Tracker, {
  InstrumentPlayMode,
  MAX_16BIT,
  SAMPLE_RATE,
} from '@polyend/tracker-lib';
import { WaveFile } from 'wavefile';

export interface SlotAudio {
  audioBuffer: AudioBuffer;   // Web Audio API decoded buffer
  trimStart: number;          // seconds
  trimEnd: number;            // seconds (Infinity = buffer.duration)
  name: string;
}

export interface ExportOptions {
  channels: 1 | 2;           // 1 = mono, 2 = stereo
  bitDepth: 8 | 16;
  instrumentName: string;     // max 32 chars (PTI filename field)
}

/**
 * Render a Web Audio AudioBuffer region to a signed Int16Array.
 * Handles mono→stereo upmix and stereo→mono downmix automatically.
 */
function renderToInt16(
  buf: AudioBuffer,
  trimStart: number,
  trimEnd: number,
  targetChannels: 1 | 2
): Int16Array {
  const startFrame = Math.floor(trimStart * buf.sampleRate);
  const endFrame   = Math.min(
    Math.ceil((trimEnd === Infinity ? buf.duration : trimEnd) * buf.sampleRate),
    buf.length
  );
  const frameCount = Math.max(0, endFrame - startFrame);
  const outSamples = new Int16Array(frameCount * targetChannels);

  const srcCh = buf.numberOfChannels;

  for (let f = 0; f < frameCount; f++) {
    if (targetChannels === 1) {
      // Mix all source channels to mono
      let sum = 0;
      for (let c = 0; c < srcCh; c++) sum += buf.getChannelData(c)[startFrame + f]!;
      outSamples[f] = Math.round((sum / srcCh) * 32767);
    } else {
      // Stereo output: L = ch0, R = ch1 (or duplicate ch0 if mono source)
      const L = buf.getChannelData(0)[startFrame + f]!;
      const R = srcCh > 1 ? buf.getChannelData(1)[startFrame + f]! : L;
      outSamples[f * 2]     = Math.round(L * 32767);
      outSamples[f * 2 + 1] = Math.round(R * 32767);
    }
  }
  return outSamples;
}

/**
 * Build a .pti Beat-Slice instrument from an ordered array of slot audio regions.
 *
 * @param slots  — ordered array of assigned slots (MIDI-note order, low→high)
 * @param opts   — export options (channels, bitDepth, name)
 * @returns      — ArrayBuffer containing the binary .pti file
 */
export async function exportToPti(
  slots: SlotAudio[],
  opts: ExportOptions
): Promise<ArrayBuffer> {
  if (slots.length === 0) throw new Error('No slots to export');
  if (slots.length > 48) throw new Error('Maximum 48 slices supported');

  const { channels, bitDepth, instrumentName } = opts;

  // --- 1. Render each slot to Int16 and track raw frame offsets ---
  const renderedSlots: Int16Array[] = [];
  const rawFrameOffsets: number[] = [];
  let totalFrames = 0;

  for (const slot of slots) {
    const pcm = renderToInt16(slot.audioBuffer, slot.trimStart, slot.trimEnd, channels);
    rawFrameOffsets.push(totalFrames);
    renderedSlots.push(pcm);
    totalFrames += pcm.length / channels;  // frames (not samples)
  }

  // --- 2. Concatenate all slots into one Int16Array ---
  const allSamplesLen = renderedSlots.reduce((s, r) => s + r.length, 0);
  const allSamples = new Int16Array(allSamplesLen);
  let writePos = 0;
  for (const pcm of renderedSlots) {
    allSamples.set(pcm, writePos);
    writePos += pcm.length;
  }

  // --- 3. Normalise slice positions: 0–65535 over the full sample ---
  const normalisedSlices = rawFrameOffsets.map(
    (offset) => Math.round((offset / totalFrames) * MAX_16BIT)
  );
  // Pad to 48 entries
  while (normalisedSlices.length < 48) normalisedSlices.push(0);

  // --- 4. Build WAV (with optional bit-depth reduction) ---
  const wav = new WaveFile();
  wav.fromScratch(channels, SAMPLE_RATE, '16', allSamples);
  if (bitDepth === 8) wav.toBitDepth('8');
  const wavBuffer = wav.toBuffer().buffer as ArrayBuffer;

  // --- 5. Create and configure the PTI instrument ---
  const instrument = Tracker.createInstrument(wavBuffer);
  instrument.playmode            = InstrumentPlayMode.BeatSlice;
  instrument.numSlices           = slots.length;
  instrument.slices              = normalisedSlices;
  instrument.selectedSlice       = 0;
  instrument.bitdepth            = bitDepth;
  instrument.sample.channels     = channels;
  instrument.sample.filename     = instrumentName.slice(0, 32);

  // --- 6. Serialise and return ---
  return Tracker.writeInstrument(instrument);
}

/** Trigger a browser download of the PTI binary. */
export function downloadPti(buffer: ArrayBuffer, filename: string) {
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename.endsWith('.pti') ? filename : `${filename}.pti`;
  a.click();
  URL.revokeObjectURL(url);
}
```

---

## How to call it from main.ts

```typescript
import { exportToPti, downloadPti, type SlotAudio } from './ptiExport';

async function handleExport() {
  // Build ordered slot list from slotAssignments (sorted by MIDI note)
  const sortedMidi = [...slotAssignments.keys()].sort((a, b) => a - b);
  const slots: SlotAudio[] = [];

  for (const midi of sortedMidi) {
    const entry = findFileById(slotAssignments.get(midi)!);
    if (!entry?.audioBuffer) continue;
    slots.push({
      audioBuffer: entry.audioBuffer,
      trimStart:   entry.trimStart,
      trimEnd:     entry.trimEnd === Infinity ? entry.audioBuffer.duration : entry.trimEnd,
      name:        entry.name,
    });
  }

  if (slots.length === 0) return; // nothing assigned

  const instrName = (document.getElementById('instrument-name') as HTMLInputElement)
    ?.value?.trim() || 'KB1 Instrument';

  const ptiBuffer = await exportToPti(slots, {
    channels:       exportChannels as 1 | 2,
    bitDepth:       exportBitDepth as 8 | 16,
    instrumentName: instrName,
  });

  downloadPti(ptiBuffer, instrName);
}
```

---

## Key gotchas

1. **Stereo is de-interleaved in PTI** (L-full then R-full) but tracker-lib's
   `writeInstrument` handles this internally — pass a standard interleaved WAV.
2. **No RIFF header** in the stored PTI audio — tracker-lib strips it for you.
3. **`trimEnd === Infinity`** means "use buffer.duration" — always resolve before
   passing to renderToInt16.
4. **Slot order matters** — export in ascending MIDI-note order so the Tracker's
   chromatic slice mapping is musically correct.
5. **Max 48 slices** — `numSlices` range is 0–47 (1–48 actual slices).
6. **`wavefile` resampling** — if source files are already 44.1 kHz and 16-bit (which
   they will be after Web Audio decoding), skip the conversion calls to avoid
   unnecessary processing.

---

## Copilot instructions to add (if not already present)

Add to `.github/copilot-instructions.md` in kb1-studio:

```
## PTI Export
- Use @polyend/tracker-lib + wavefile for all PTI writes
- Slice positions are normalised uint16 (0–65535), NOT raw frames
- Stereo is de-interleaved in PTI; tracker-lib handles this automatically
- See .github/skills/kb1-studio-pti-export/SKILL.md for full implementation
```
