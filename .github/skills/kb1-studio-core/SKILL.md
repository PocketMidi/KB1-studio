# KB1 Studio — Core Architecture & Conventions

## Purpose
Complete reference for continuing development on KB1 Studio without prior research.
Covers project structure, tech stack, all major subsystems, UI conventions, and
patterns established through development sessions.

---

## Project Overview

KB1 Studio is a **browser-only web app** (no server, no framework) that provides:
1. **Instrument Builder** — import WAV samples, assign to piano keys, set trim points,
   normalize levels, export as `.pti` Beat-Slice instrument for Polyend Tracker Mini.
2. **Flash Tool** — flash KB1 firmware via Web Serial API, monitor serial output.

Served at `http://localhost:5174/kb1-studio/` during development.

### Tech Stack
- **Vite 7.3.5 + TypeScript** — vanilla JS/TS, no Vue/React
- **`@polyend/tracker-lib`** — PTI format encoder (via blob-interception workaround, see pti-export skill)
- **Web Audio API** — sample decode, normalization, playback
- **IndexedDB** — session persistence (`persistence.ts`)
- **Web File System Access API** — native save dialog for `.kb1i` project files

### Type-check command
```bash
cd /Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-studio
node_modules/typescript/bin/tsc --noEmit
```

---

## File Structure

```
kb1-studio/
├── index.html              # All HTML for both tools (single page)
├── src/
│   ├── main.ts             # ~3700+ lines — all app logic
│   ├── style.css           # All styles
│   ├── ptiExport.ts        # PTI format encoder (uses @polyend/tracker-lib)
│   ├── sampleImport.ts     # WAV import + MIDI note detection from filenames
│   ├── persistence.ts      # IndexedDB save/load (session + file cache)
│   ├── types.ts            # Shared TypeScript types
│   └── ...
├── .github/skills/
│   ├── kb1-studio-core/    # This file
│   ├── kb1-studio-pti-export/
│   └── kb1-studio-libraries/
└── public/
```

---

## CSS Variables (`:root` in style.css)

```css
--accent-primary: #4d5f7e       /* Blue — hover/active highlights */
--accent-bronze: #b9aa5f        /* Bronze — active states, selected values */
--accent-secondary: #5d6f8e     /* Secondary blue */
--success: #5dad6b              /* Green */
--error: #ad4137                /* Red */
--spacing-xs: 0.5rem
--spacing-sm: 1rem
--spacing-md: 1.5rem
--spacing-lg: 2rem
--radius-sm: 4px
--radius-md: 8px
```

---

## Typography Standards

- **Body / sidebar nav**: `Jost` (inherited)
- **Toolbar labels / data values**: `Roboto Mono`, `0.8125rem` (13px), weight 400, sentence case
- **Instrument name input**: `1rem`, weight 500, borderless
- **File bin items**: inherit Jost

**NO uppercase transforms** on toolbar labels — sentence case only.

---

## UI Conventions

### Button Hierarchy
- Primary action: blue gradient (only ONE per view)
- Secondary: system tan `rgba(106, 104, 83, 0.35)`
- Destructive: amber gradient
- Success: `#5dad6b`

### Icons
- Info icon: text `i` in `.about-btn` styled circle — **not SVG**
- Lock/chain icon: inline SVG from `PerformanceSliders.vue` in KB1-config
  - Linked (closed chain): `viewBox="0 0 18 21"`
  - Unlinked (broken chain): `viewBox="0 0 25 26"`
  - Both rotated 90° via CSS: `.lock-svg { transform: rotate(90deg); }`
  - Size controlled by `.lock-svg { width: Xpx; height: Xpx; }`

### No emojis in UI — use Unicode symbols or inline SVG for icons

---

## Key Global State Variables (`main.ts`)

```typescript
let slotDuration = 0.0;          // global slot length (seconds). 0 = not set yet
let slotDurationLocked = true;   // true = all slots share slotDuration
let exportChannels = 2;          // 2=stereo, 1=mono
let exportBitDepth = 16;         // 16 or 8

const importedFiles: ImportedFile[] = [];
const slotAssignments = new Map<number, number>(); // MIDI note → file id
const autoAssigned = new Set<number>();            // notes placed automatically
let nextFileId = 1;
```

### ImportedFile interface
```typescript
interface ImportedFile {
  id: number;
  name: string;
  file: File;                    // original raw file (used for save/load)
  mapping: SampleMapping;
  audioBuffer: AudioBuffer | null;
  decoding: boolean;
  trimStart: number;             // seconds
  trimEnd: number;               // seconds (Infinity = use buffer.duration)
  normalized: boolean;           // true if RMS normalization applied
}
```

---

## Slot Duration Lock/Unlock

### State
- `slotDurationLocked = true` (default): all slots share one global `slotDuration`
- `slotDurationLocked = false`: each slot has its own `trimEnd`; toolbar controls affect selected slot only

### Key functions
- `applySlotDuration(duration)` — when locked, updates ALL importedFiles' trimEnd
- `applySelectedSlotDuration(duration)` — when unlocked, updates only the selected slot
- `getDisplayDuration()` — returns global or selected-slot duration depending on lock state

### Lock button (HTML)
In `.toolbar-group.length-controls`, after the `+` button:
```html
<button class="toolbar-lock-btn is-locked" id="duration-lock-btn" ...>
  <svg class="lock-svg locked-icon" viewBox="0 0 18 21">...</svg>
  <svg class="lock-svg unlocked-icon" viewBox="0 0 25 26">...</svg>
</button>
```
- `.is-locked` class on button → shows `locked-icon`, hides `unlocked-icon`
- Toggling to locked re-syncs all slots to current `slotDuration`

---

## Normalization

### Algorithm (`normalizeAudioBuffer`)
- Windowed RMS analysis: 50ms chunks across all channels
- Mean smoothing: 10-chunk rolling window
- Target: `-18 dBFS` RMS, peak ceiling: `-1 dBFS`
- Gain = `targetRmsLinear / maxSustainedRms`, clamped to peak ceiling

### Per-file normalize button
- Small `↑` button in `.file-bin-item`, hidden until hover
- Shows spin animation during processing (`.normalizing` class)
- Sets `entry.normalized = true` on completion

### Toolbar "Normalize" button
- `#file-bin-normalize-all` — processes all importedFiles sequentially

### Persistence
`entry.normalized` is saved in both `.kb1i` project files and IDB session.
On load, `decodeEntry()` re-applies `normalizeAudioBuffer()` if `entry.normalized === true`.

---

## Project File Format (`.kb1i`)

JSON file. Full interface:
```typescript
interface KB1InstrumentFile {
  version: 1;
  instrumentName: string;
  slotDuration: number;
  slotDurationLocked?: boolean;      // default true if absent
  exportChannels?: number;           // 2 or 1
  exportBitDepth?: number;           // 16 or 8
  nextFileId: number;
  files: Array<{
    id: number;
    name: string;
    data: string;                    // base64-encoded original WAV bytes
    trimStart: number;
    trimEnd: number;
    normalized?: boolean;
  }>;
  assignments: [number, number][];   // [midiNote, fileId]
  autoAssigned: number[];
}
```

### Save/load functions
- `buildPayload()` — assembles the payload; called by `saveInstrumentFile()` and `saveAsInstrumentFile()`
- `loadInstrumentFile(file)` — parses, resets state, restores all scalar + file state, calls `decodeEntry()` per file
- `newInstrument()` — full reset including export toggle UI sync

---

## Session Persistence (IndexedDB via `persistence.ts`)

### PersistedState interface
```typescript
interface PersistedState {
  assignments: [number, number][];
  autoAssigned: number[];
  instrumentName: string;
  nextFileId: number;
  fileTrims?: Array<{ id: number; trimStart: number; trimEnd: number }>;
  fileNormalized?: Array<{ id: number; normalized: boolean }>;
  slotDuration?: number;
  slotDurationLocked?: boolean;
  exportChannels?: number;
  exportBitDepth?: number;
}
```

- `persistSession()` — called after any user edit; marks dirty + saves to IDB
- `restoreSession()` — called on page load; restores all state including normalized flags
- Raw WAV bytes also stored in IDB (separate store) so session survives refresh without project file

---

## Toolbar Structure (HTML)

```html
<div class="piano-roll-toolbar">
  <div class="toolbar-group octave-controls">
    Octave  [−] [display] [+]
  </div>
  <div class="toolbar-group normalize-controls">
    [Normalize button]
  </div>
  <div class="toolbar-group length-controls">
    Slot duration  [−] [display] [+] [lock/unlock SVG btn]
  </div>
  <div class="toolbar-group export-controls">
    [toggle: Stereo/Mono]  |  [toggle: 16 bit/8 bit]
    [PTI badge] [size bar] [size label]
  </div>
  <span class="zoom-hint" id="zoom-hint">1×</span>
</div>
```

### Toolbar CSS patterns
- `.toolbar-group`: `border: 1px solid var(--border)`, background subtle, `border-radius: var(--radius-sm)`, `padding: 4px 10px`
- `.length-btn` / `.octave-btn`: borderless, transparent, hover → `var(--accent-bronze)`
- `.toolbar-toggle` + `.toggle-track` + `.toggle-thumb`: CSS toggle switch (28×16px track, 10px thumb)
- `.toolbar-toggle.is-on .toolbar-label`: bronze color
- `.toolbar-label`: fixed-width (`width: 46px`) prevents layout shift on text toggle
- `.export-size-wrap`: has `border-left` internal divider

### Export size bar thresholds
- Green: < 8 MB
- Amber (`.warn`): 8–24 MB  
- Red (`.danger`): > 24 MB
- Bar fills to 32 MB max

---

## Zoom Systems

### Piano Roll Zoom (`state.zoom`, range 1×–2×)
- Zoom bar: `#zoom-bar-track`, `#zoom-bar-thumb`, left/right handles
- **Scroll wheel on `#piano-roll-scroll`**: plain scroll = zoom (centered on cursor), Shift+scroll = pan
- Sensitivity constant: `k = 0.0005` → `factor = Math.exp(e.deltaY * 0.0005)`
- Double-click zoom bar track: reset to 1×
- Pattern: `applyBounds(lb, rb)` local function inside `initZoomBar()`

### Waveform Zoom (`waveformZoom`, range 1×–20×)
- Zoom bar: `#waveform-zoom-track`, `#waveform-zoom-thumb`, left/right handles
- **Scroll wheel on `#sample-waveform` canvas**: plain scroll = zoom (centered on cursor), Shift+scroll = pan
- Sensitivity constant: `k = 0.002` → `factor = Math.exp(e.deltaY * 0.002)`
- Double-click zoom bar track: reset to 1×, scroll to start
- Pattern: `applyBounds(lb, rb)` local function inside `initWaveformZoomBar()`

### Zoom formula (both windows)
```typescript
// scroll down (deltaY > 0) = zoom out, scroll up = zoom in
const factor = Math.exp(e.deltaY * k);
const newThumbFrac = Math.max(MIN_THUMB_FRAC, Math.min(1, thumbFrac * factor));
// Pivot on mouse cursor position:
const mouseXFrac = (e.clientX - rect.left) / rect.width;
const pivotFrac = lb + mouseXFrac * thumbFrac;
const newLb = Math.max(0, Math.min(1 - newThumbFrac, pivotFrac - mouseXFrac * newThumbFrac));
applyBounds(newLb, newLb + newThumbFrac);
```

---

## Waveform Scroll State

```typescript
let waveformZoom = 1.0;
let waveformScrollFrac = 0;  // left edge as fraction of total (0–1)
```

`updateWaveformZoomBarThumb()` syncs the visual thumb from these values.
`updateSampleEditor()` redraws using `waveformZoom` + `waveformScrollFrac`.

---

## About Modals

Both tools have About modals (not full-page sections):
- Flash: `#flash-about-overlay` opened by `#flash-about-btn`
- Instrument: `#instrument-about-overlay` opened by `#instrument-about-btn`
- Pattern: overlay div → `.about-modal` → `.about-modal-header` + `.about-modal-body`

---

## Sidebars

### Instrument sidebar
- Instrument name: borderless `#instrument-name` input, focus → `border-left-color: var(--accent-primary)`
- File menu nav: `.file-menu-btn` — borderless, `border-left: 3px solid transparent`, hover → `--accent-primary`
- Separator `<hr>` above About button at bottom
- About button: `.flash-sidebar-btn` style

### Flash sidebar
- Nav items: `.flash-sidebar-btn` — `border-left: 3px solid transparent`, hover/active → `--accent-primary`
- Items: Firmware Update, Device Info, Serial Monitor, `<hr>`, About
- About opens `#flash-about-overlay` modal (no `data-section` attribute)

---

## PTI Export Key Facts

- PTI format uses per-slot variable lengths — the Polyend format DOES support variable slot durations
- `ptiExport.ts` `renderToInt16(slot.audioBuffer, slot.trimStart, slot.trimEnd, channels)` handles per-slot trim
- Slice offsets normalized to 0–65535 relative to total audio frames
- Max 48 slices
- `handleExport()` builds `SlotAudio[]` from `slotAssignments` sorted ascending by MIDI note
- For each slot: `trimEnd === Infinity ? dur : Math.min(entry.trimEnd, dur)` resolves the trimEnd

---

## decodeEntry() Flow

```
decodeEntry(entry)
  → decodes entry.file bytes via Web Audio API
  → if entry.normalized: re-applies normalizeAudioBuffer()  ← preserves normalization on load
  → if trimEnd === Infinity (fresh import): auto-expand slotDuration, set trimEnd from slotDuration
  → if locked & auto-trim enabled: detect silence start
  → finally: redraw piano roll + sample editor + file bin
```

---

## Auto-Trim Feature

- `autoTrimEnabled` flag (check if present in state)
- `detectTrimStart(buffer)` — finds first non-silent sample above threshold
- Only applied on **fresh imports** (when `trimEnd === Infinity`)
- Never re-applied on session restore or project load

---

## Common Patterns

### Adding a new persisted scalar
1. Add `let myVar = defaultValue` near top of main.ts
2. Add `myVar?: type` to `PersistedState` in persistence.ts
3. Add `myVar?: type` to `KB1InstrumentFile` interface
4. Include in `saveState({...})` call in `persistSession()`
5. Include in `payload` in `buildPayload()`
6. Restore in `restoreSession()` with appropriate guard
7. Restore in `loadInstrumentFile()` with UI sync if needed
8. Reset in `newInstrument()`

### Adding a new per-file persisted field
1. Add to `ImportedFile` interface
2. Add `field?: type` to the `files` array type in `KB1InstrumentFile`
3. Include in `buildPayload()` file mapping
4. Set default in all 3 entry constructors (fresh import, restoreSession, loadInstrumentFile)
5. Restore in `loadInstrumentFile()` via `pf.field ?? default`
6. Add to session: `fileXxx` array in `persistSession()` + `PersistedState` + `restoreSession()`

---

## File Bin UI

- List: `#file-bin-list` — each item `.file-bin-item[data-file-id]`
- Per-file normalize button: `↑` character, hidden until hover, green on hover
- Remove button: `×`
- During normalization: `.normalizing` class → spin animation on `↑` button, bronze color
- `renderFileBin()` — full re-render of the list

---

## Known Working Patterns

### Export size calculation (unlocked mode)
```typescript
if (!slotDurationLocked) {
  // sum per-slot actual durations
  slotAssignments.forEach((fileId) => {
    const entry = findFileById(fileId);
    if (!entry?.audioBuffer) return;
    const end = entry.trimEnd === Infinity ? entry.audioBuffer.duration : entry.trimEnd;
    audioBytes += Math.ceil((end - entry.trimStart) * 44100) * bytesPerFrame;
  });
}
```

### Syncing export toggle UI programmatically
```typescript
// Set state then fire change event so listener syncs label text + is-on class
exportChannels = 2;
const chInput = document.getElementById('export-channels') as HTMLInputElement | null;
if (chInput) { chInput.checked = true; chInput.dispatchEvent(new Event('change')); }
```

### Lock button UI sync (standalone, outside initDurationLockToggle)
```typescript
const lockBtn = document.getElementById('duration-lock-btn');
const lengthGroup = document.querySelector('.length-controls');
if (lockBtn && lengthGroup) {
  lockBtn.classList.toggle('is-locked', slotDurationLocked);
  lengthGroup.classList.toggle('is-unlocked', !slotDurationLocked);
}
```

---

## Workspace Location

`/Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-studio/`

Three sibling repos in the workspace:
- `firmware/` — ESP32-S3 PlatformIO firmware
- `KB1-config/` — Vue 3 BLE config web app
- `kb1-studio/` — this app

---

## Last Updated

June 19, 2026 — Session: lock/unlock slot duration, link icons from KB1-config,
scroll-wheel zoom (both windows, plain+Shift), project save completeness
(normalized, exportChannels, exportBitDepth, slotDurationLocked), old file cleanup.
