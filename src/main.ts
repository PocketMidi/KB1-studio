// KB1 Studio - Main Entry Point
// Instrument Builder: piano roll, zoom, octave shift, sample editor

import { initFlashTools } from './flashTools';
import {
  clearAllFiles,
  deleteFile,
  getFileById,
  loadAllFiles,
  loadState,
  saveFile,
  saveState,
} from './persistence';
import { exportToPti, savePtiFile, type SlotAudio } from './ptiExport';
import { importSamples, type SampleMapping } from './sampleImport';

// ============================================
// CONSTANTS
// ============================================

const PIANO_START = 48;   // C3 (lowest Tracker slice)
const PIANO_END = 95;     // B6 (highest Tracker slice) -> 48 notes total
const KB1_LOW = 59;       // B3 (KB1 lowest key)
const KB1_HIGH = 77;      // F5 (KB1 highest key)
const NO_SELECTION = -1;  // sentinel: no slot focused in the sample editor

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES: Record<number, string> = { 1: 'Db', 3: 'Eb', 6: 'Gb', 8: 'Ab', 10: 'Bb' };

// ============================================
// STATE
// ============================================

interface PianoRollState {
  selectedMidi: number;   // currently selected/edited key
  octaveOffset: number;   // -2..+2, shifts the highlighted KB1 range
  zoom: number;           // 1.0..5.0
}

const state: PianoRollState = {
  selectedMidi: 64, // E4 default
  octaveOffset: 0,
  zoom: 1.0,
};

// ============================================
// FILE BIN STATE
// ============================================

interface ImportedFile {
  id: number;                       // stable id for drag/drop reference
  name: string;                     // original filename
  file: File;                       // raw file handle
  mapping: SampleMapping;           // normalized parse result (note, vel, etc.)
  detectedRootMidi: number | null;  // raw pre-offset detected root note (for strip display)
  audioBuffer: AudioBuffer | null;  // decoded PCM (null until decoded / on failure)
  decoding: boolean;                // true while decode in flight
  trimStart: number;                // seconds — start of active region (default 0)
  trimEnd: number;                  // seconds — end of active region (Infinity = use buffer.duration)
  normalized: boolean;              // true if RMS normalization has been applied
}

// All files loaded via the Import picker (shown in the file bin)
const importedFiles: ImportedFile[] = [];

// Manual slot assignments: MIDI note -> imported file id.
// This is the user override layer that sits alongside auto-propagation.
const slotAssignments = new Map<number, number>();

// Slots that were filled automatically (so manual edits can be distinguished)
const autoAssigned = new Set<number>();

let nextFileId = 1;
let selectedBinFileId: number | null = null;

// Multi-selection state (Stage 2: rubber-band / shift-click; Stage 3: group move)
const selectedSlots = new Set<number>();   // set of midi notes in the current group
let selectionAnchor: number | null = null; // anchor for shift-click range extension

// Move-group state (Stage 3)
let moveActive = false;        // group drag in progress
let moveCurrentDelta = 0;      // current semitone delta during drag preview

// Auto-trim: when enabled, silence at the start of each imported file is removed on decode
let autoTrimEnabled = true;

// ---- Dirty / unsaved-changes tracking ----
let isDirty = false;

function markDirty() {
  if (isDirty) return;
  isDirty = true;
  updateWindowTitle();
}

function markClean() {
  isDirty = false;
  updateWindowTitle();
}

function updateWindowTitle() {
  const nameEl = document.getElementById('instrument-name') as HTMLInputElement | null;
  const name = nameEl?.value.trim() || 'Untitled';
  document.title = isDirty ? `• ${name} — KB1 Studio` : `${name} — KB1 Studio`;
}

// Slot duration: the desired play length applied uniformly to all assigned slots (seconds).
// 0 means «not yet set» — auto-expands to the longest decoded file on first import.
let slotDuration = 0.0;
// When true (default), all slots share the same duration. When false, each slot's trimEnd is independent.
let slotDurationLocked = true;

// Export settings (affect estimated file size)
let exportChannels = 2;   // 2 = stereo, 1 = mono
// Bit depth is always 16 — PTI format bitdepth field valid range is 4–16; 8-bit not accepted by Tracker Mini

/**
 * File handle from the most recent project Save / Save As.
 * Passed to the PTI export dialog as `startIn` so the OS opens it in the same
 * folder — keeping project, source WAVs, and .pti together naturally.
 */
let currentProjectHandle: FileSystemFileHandle | null = null;

/** PTI fixed overhead: header (16 B) + main fields (376 B) + slice table (96 B) + CRC (4 B) */
const PTI_OVERHEAD_BYTES = 16 + 376 + 4;

/** Recompute and display estimated .pti file size. */
function updateExportSize() {
  const assignedCount = slotAssignments.size;
  const fill = document.getElementById('export-size-fill');
  const label = document.getElementById('export-size-label');
  if (!fill || !label) return;

  if (assignedCount === 0 || (slotDurationLocked && slotDuration <= 0)) {
    fill.style.width = '0%';
    fill.className = 'export-size-fill';
    label.textContent = '—';
    return;
  }

  // Raw PCM bytes: frames × bytes-per-frame × channels
  // PTI stores each channel contiguously (de-interleaved), but same total size
  let audioBytes: number;
  if (slotDurationLocked) {
    const frames = Math.ceil(slotDuration * 44100);
    const bytesPerFrame = 2 * exportChannels; // always 16-bit (2 bytes/sample)
    audioBytes = assignedCount * frames * bytesPerFrame;
  } else {
    const bytesPerFrame = 2 * exportChannels; // always 16-bit (2 bytes/sample)
    audioBytes = 0;
    slotAssignments.forEach((fileId) => {
      const entry = findFileById(fileId);
      if (!entry?.audioBuffer) return;
      const end = entry.trimEnd === Infinity ? entry.audioBuffer.duration : entry.trimEnd;
      const dur = Math.max(0, end - entry.trimStart);
      audioBytes += Math.ceil(dur * 44100) * bytesPerFrame;
    });
  }
  const totalBytes = PTI_OVERHEAD_BYTES + audioBytes;

  // Format label
  let sizeStr: string;
  if (totalBytes < 1024 * 1024) {
    sizeStr = `${(totalBytes / 1024).toFixed(0)} KB`;
  } else {
    sizeStr = `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  label.textContent = sizeStr;

  // Bar fill: soft thresholds — amber >8MB, red >24MB (32MB cap)
  const mb = totalBytes / (1024 * 1024);
  const pct = Math.min(100, (mb / 32) * 100);
  fill.style.width = `${pct}%`;
  fill.className = 'export-size-fill' + (mb > 24 ? ' danger' : mb > 8 ? ' warn' : '');
}

// Waveform zoom/scroll state for the sample editor detail view
let waveformZoom = 1.0;
let waveformScrollFrac = 0;

// Tracks which panel keyboard zoom (- / =) should apply to
let activeZoomPanel: 'waveform' | 'pianoroll' = 'waveform';

/** Set trimEnd = trimStart + duration for every imported file, clamped to buffer length. */
function applySlotDuration(duration: number) {
  slotDuration = Math.max(0.05, Math.round(duration * 100) / 100); // 10ms resolution
  if (slotDurationLocked) {
    for (const f of importedFiles) {
      if (!f.audioBuffer) continue;
      f.trimEnd = Math.min(f.trimStart + slotDuration, f.audioBuffer.duration);
    }
  }
  updateTrimUI();
  updateRuler();
  updateExportSize();
  persistSession();
}

/** Apply a duration change to only the selected slot (unlocked mode). */
function applySelectedSlotDuration(duration: number) {
  const id = slotAssignments.get(state.selectedMidi);
  const entry = id != null ? findFileById(id) : null;
  if (!entry?.audioBuffer) return;
  const clamped = Math.max(0.05, Math.round(duration * 100) / 100);
  entry.trimEnd = Math.min(entry.trimStart + clamped, entry.audioBuffer.duration);
  updateTrimUI();
  updateRuler();
  updateExportSize();
  persistSession();
}

/** Returns the displayed slot duration: global when locked, selected slot's duration when unlocked. */
function getDisplayDuration(): number {
  if (slotDurationLocked) return slotDuration;
  const id = slotAssignments.get(state.selectedMidi);
  const entry = id != null ? findFileById(id) : null;
  if (!entry?.audioBuffer) return slotDuration;
  const end = entry.trimEnd === Infinity ? entry.audioBuffer.duration : entry.trimEnd;
  return Math.max(0, end - entry.trimStart);
}

/** Refresh the length display in the toolbar. */
function updateLengthDisplay() {
  const el = document.getElementById('length-display');
  const dur = getDisplayDuration();
  if (el) el.textContent = dur > 0 ? `${dur.toFixed(2)}s` : '—';
}

// ============================================
// AUDIO ENGINE
// ============================================

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // Force 44100 Hz — PTI format requires this rate; without it macOS Chrome
    // uses the system rate (often 96 kHz), making decoded buffers ~2× larger
    // than the estimate and causing wrong playback pitch on the Tracker.
    audioCtx = new Ctor({ sampleRate: 44100 });
  }
  return audioCtx;
}

function findFileById(id: number): ImportedFile | undefined {
  return importedFiles.find((f) => f.id === id);
}

function fileForMidi(midi: number): ImportedFile | undefined {
  const id = slotAssignments.get(midi);
  return id != null ? findFileById(id) : undefined;
}

// ============================================
// NOTE HELPERS
// ============================================

function midiToName(midi: number): string {
  const note = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1; // MIDI 60 = C4
  return note + octave;
}

function isBlackKey(midi: number): boolean {
  return NOTE_NAMES[midi % 12].includes('#');
}

function getSharpFlatLabel(midi: number): string {
  const idx = midi % 12;
  const sharp = NOTE_NAMES[idx];
  const flat = FLAT_NAMES[idx];
  return flat ? `${sharp}\n${flat}` : sharp;
}

// Returns true if this midi note is within the currently-highlighted KB1 range
function isInKb1Range(midi: number): boolean {
  const low = KB1_LOW + state.octaveOffset * 12;
  const high = KB1_HIGH + state.octaveOffset * 12;
  return midi >= low && midi <= high;
}

// ============================================
// PIANO ROLL GENERATION
// ============================================

function buildPianoRoll(opts: { skipAutoCenter?: boolean } = {}) {
  const waveformsEl = document.getElementById('pr-waveforms');
  const keysEl = document.getElementById('pr-keys');
  const rollEl = document.getElementById('piano-roll');
  if (!waveformsEl || !keysEl || !rollEl) return;

  waveformsEl.innerHTML = '';
  keysEl.innerHTML = '';

  // Count white keys for layout
  const numWhite = (() => {
    let n = 0;
    for (let m = PIANO_START; m <= PIANO_END; m++) if (!isBlackKey(m)) n++;
    return n;
  })(); // 28

  // Base white-key width: fill the scroll container content area at zoom=1, scale up beyond that
  const scrollContainer = document.getElementById('piano-roll-scroll');
  const scrollStyle = scrollContainer ? window.getComputedStyle(scrollContainer) : null;
  const paddingLR = scrollStyle
    ? parseFloat(scrollStyle.paddingLeft) + parseFloat(scrollStyle.paddingRight)
    : 0;
  const containerW = (scrollContainer ? scrollContainer.clientWidth - paddingLR : 0) || 900;
  const baseWhiteWidth = containerW / numWhite;   // fills content area exactly at 1×
  const whiteWidth = baseWhiteWidth * state.zoom;
  const blackWidth = whiteWidth * 0.58;
  const totalWidth = numWhite * whiteWidth;

  // Roll width drives horizontal scrolling when zoomed
  rollEl.style.width = `${totalWidth}px`;

  // After rebuilding, center the scroll container on the selected slot (unless zoom bar is controlling)
  if (!opts.skipAutoCenter && scrollContainer && state.selectedMidi !== NO_SELECTION) {
    requestAnimationFrame(() => {
      const selectedSlotIdx = state.selectedMidi - PIANO_START;
      const slotCenterX = (selectedSlotIdx + 0.5) * (totalWidth / (PIANO_END - PIANO_START + 1));
      scrollContainer.scrollLeft = slotCenterX - scrollContainer.clientWidth / 2;
    });
  }

  // --- Mini waveform slots: 48 EQUAL-width chromatic columns ---
  const totalSlots = PIANO_END - PIANO_START + 1; // 48
  const slotWidth = totalWidth / totalSlots;

  for (let i = 0; i < totalSlots; i++) {
    const midi = PIANO_START + i;
    const inRange = isInKb1Range(midi);
    const selected = midi === state.selectedMidi;
    const assigned = slotAssignments.has(midi);

    const isMovingSource = moveActive && selectedSlots.has(midi);
    const isMovingTarget = moveActive && moveCurrentDelta !== 0
      && selectedSlots.has(midi - moveCurrentDelta)
      && !selectedSlots.has(midi);

    let waveClass = 'mini-wave';
    if (isMovingTarget) {
      waveClass += ' move-target';
    } else if (isMovingSource) {
      waveClass += ' move-source multi-selected';
    } else if (selected) {
      waveClass += ' selected';
    } else if (inRange) {
      waveClass += ' active';
    } else {
      waveClass += ' dim';
    }
    if (assigned && !isMovingSource) waveClass += ' assigned';
    if (!moveActive && selectedSlots.has(midi) && !selected) waveClass += ' multi-selected';

    const wave = document.createElement('div');
    wave.className = waveClass;
    wave.style.left = `${i * slotWidth + 1}px`;
    wave.style.width = `${slotWidth - 2}px`;
    wave.dataset.midi = String(midi);

    // For move-target slots, preview the waveform of the file being moved there
    const trimFile = isMovingTarget
      ? fileForMidi(midi - moveCurrentDelta)
      : fileForMidi(midi);
    const previewBuf = trimFile?.audioBuffer ?? null;
    if (inRange || selected || assigned || isMovingTarget) {
      const canvas = document.createElement('canvas');
      wave.appendChild(canvas);
      requestAnimationFrame(() => drawMiniWaveform(canvas, selected && !isMovingTarget, previewBuf));
    }

    attachSlotDropHandlers(wave, midi);
    waveformsEl.appendChild(wave);
  }

  // --- Piano keys: traditional layout, white shapes only ---
  // Pass 1: white keys (rendered first, underneath)
  let whiteIndex = 0;
  for (let midi = PIANO_START; midi <= PIANO_END; midi++) {
    if (isBlackKey(midi)) continue;
    const left = whiteIndex * whiteWidth;
    createKey(keysEl, midi, left, whiteWidth, false);
    whiteIndex++;
  }

  // Pass 2: black keys (negative space, rendered on top so they notch into white/gold keys)
  whiteIndex = 0;
  for (let midi = PIANO_START; midi <= PIANO_END; midi++) {
    if (!isBlackKey(midi)) {
      whiteIndex++;
      continue;
    }
    const left = whiteIndex * whiteWidth - blackWidth / 2;
    createKey(keysEl, midi, left, blackWidth, true);
  }

  // Sync zoom bar thumb after roll is rebuilt
  requestAnimationFrame(updateZoomBarThumb);
  requestAnimationFrame(updateSlipStrip);
}

// Create a single piano key element
function createKey(parent: HTMLElement, midi: number, left: number, width: number, black: boolean) {
  const inRange = isInKb1Range(midi);
  const selected = midi === state.selectedMidi;

  const key = document.createElement('div');
  key.className =
    'pkey ' + (black ? 'black' : 'white') + (inRange ? ' in-range' : '') + (selected ? ' selected' : '');
  key.style.left = `${left}px`;
  key.style.width = `${width}px`;
  key.dataset.midi = String(midi);

  const label = document.createElement('span');
  label.className = 'key-label';
  if (black) {
    if (inRange) label.innerHTML = getSharpFlatLabel(midi).replace('\n', '<br>');
  } else {
    label.textContent = midiToName(midi);
  }
  key.appendChild(label);

  key.addEventListener('click', () => selectKey(midi, true));
  attachSlotDropHandlers(key, midi);
  parent.appendChild(key);
}

// ============================================
// SLIP STRIP
// ============================================

/** Shift every slotAssignment by `delta` semitones (clamped to piano range). */
function slipAllAssignments(delta: number) {
  if (delta === 0 || slotAssignments.size === 0) return;

  pushUndo();

  // Shift ALL assignments regardless of range — out-of-range ones become invisible on the
  // piano roll but are preserved in the map so slipping back restores them exactly.
  const moved: [number, number][] = [];
  for (const [midi, fileId] of slotAssignments) {
    moved.push([midi + delta, fileId]);
  }
  const movedAuto = new Set([...autoAssigned].map((m) => m + delta));

  slotAssignments.clear();
  autoAssigned.clear();
  for (const [midi, fileId] of moved) slotAssignments.set(midi, fileId);
  for (const m of movedAuto) autoAssigned.add(m);

  buildPianoRoll();
  renderFileBin();
  updateSampleEditor();
  updateSlipStrip();
  persistSession();
}

/** Render the slip strip canvas and update the range label. Hidden when no assignments. */
function updateSlipStrip() {
  const canvas = document.getElementById('slip-strip-canvas') as HTMLCanvasElement | null;
  const controls = document.getElementById('slip-strip-controls');
  const rangeLabel = document.getElementById('slip-range-label');
  if (!canvas || !controls) return;

  const hasAssignments = slotAssignments.size > 0;
  canvas.classList.toggle('hidden', !hasAssignments);
  controls.classList.toggle('hidden', !hasAssignments);
  if (!hasAssignments) return;

  // Match canvas pixel width to the piano roll element
  const rollEl = document.getElementById('piano-roll') as HTMLElement;
  const rollWidth = parseFloat(rollEl.style.width) || rollEl.scrollWidth || 800;
  const TOTAL = PIANO_END - PIANO_START + 1; // 48
  const slotW = rollWidth / TOTAL;
  const H = 26;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rollWidth * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = `${rollWidth}px`;
  canvas.style.height = `${H}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, rollWidth, H);

  // KB1 range background highlight (respects current octave offset)
  const kb1Lo = KB1_LOW + state.octaveOffset * 12;
  const kb1Hi = KB1_HIGH + state.octaveOffset * 12;
  const kb1X = Math.max(0, (kb1Lo - PIANO_START)) * slotW;
  const kb1W = (Math.min(PIANO_END, kb1Hi) - Math.max(PIANO_START, kb1Lo) + 1) * slotW;
  ctx.fillStyle = 'rgba(128, 104, 71, 0.22)';
  ctx.fillRect(kb1X, 0, kb1W, H);

  // Slot borders (light)
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= TOTAL; i++) {
    const x = Math.round(i * slotW) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  // Note labels for assigned slots
  ctx.font = `bold 9px 'Roboto Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const assignedNotes: number[] = [];
  for (const [midi, fileId] of slotAssignments) {
    assignedNotes.push(midi);
    const entry = importedFiles.find((f) => f.id === fileId);
    const inKb1 = midi >= KB1_LOW + state.octaveOffset * 12 && midi <= KB1_HIGH + state.octaveOffset * 12;
    const slotX = (midi - PIANO_START) * slotW;

    // Slot fill: kb1 range = brown tint, outside = subtle
    ctx.fillStyle = inKb1 ? 'rgba(128, 104, 71, 0.45)' : 'rgba(255,255,255,0.06)';
    ctx.fillRect(slotX + 1, 1, slotW - 2, H - 2);

    // Show the SOURCE note (pre-offset, from filename detection) under the destination key.
    // The column position changes as you slip, but the label content stays C0/D0/etc.
    // Falls back to destination note for manually-placed files with no detected root.
    const srcMidi = entry?.detectedRootMidi;
    const labelMidi = srcMidi ?? midi;
    ctx.fillStyle = srcMidi != null
      ? (inKb1 ? '#c8a96e' : 'rgba(255,255,255,0.45)')
      : 'rgba(255,255,255,0.28)';
    ctx.fillText(midiToName(labelMidi), slotX + slotW / 2, H / 2 + 0.5);
  }

  // Range label
  if (rangeLabel && assignedNotes.length > 0) {
    const minM = Math.min(...assignedNotes);
    const maxM = Math.max(...assignedNotes);
    rangeLabel.textContent = `${midiToName(minM)}–${midiToName(maxM)}  (${assignedNotes.length} slot${assignedNotes.length !== 1 ? 's' : ''})`;
  } else if (rangeLabel) {
    rangeLabel.textContent = 'No mapped slots';
  }
}

function initSlipStrip() {
  const canvas = document.getElementById('slip-strip-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;

  let isDragging = false;
  let dragStartX = 0;

  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rollEl = document.getElementById('piano-roll') as HTMLElement;
    const rollWidth = parseFloat(rollEl.style.width) || rollEl.scrollWidth || 800;
    const slotW = rollWidth / (PIANO_END - PIANO_START + 1);
    const px = e.clientX - dragStartX;
    const semis = Math.trunc(px / slotW);
    if (semis !== 0) {
      slipAllAssignments(semis);
      dragStartX += semis * slotW;
    }
  });

  document.addEventListener('mouseup', () => { isDragging = false; });

  document.getElementById('slip-oct-left')?.addEventListener('click', () => slipAllAssignments(-12));
  document.getElementById('slip-semi-left')?.addEventListener('click', () => slipAllAssignments(-1));
  document.getElementById('slip-semi-right')?.addEventListener('click', () => slipAllAssignments(+1));
  document.getElementById('slip-oct-right')?.addEventListener('click', () => slipAllAssignments(+12));
}

// ============================================
// MINI WAVEFORM RENDERING (placeholder)
// ============================================

function drawMiniWaveform(
  canvas: HTMLCanvasElement,
  selected: boolean,
  buffer: AudioBuffer | null,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  // getBoundingClientRect returns 0 for off-screen (scrolled-away) elements.
  // Fall back to the canvas's existing pixel dimensions so live redraws still work.
  let cssW = rect.width;
  let cssH = rect.height;
  if ((cssW === 0 || cssH === 0) && canvas.width > 0 && canvas.height > 0) {
    cssW = canvas.width / dpr;
    cssH = canvas.height / dpr;
  }
  if (cssW === 0 || cssH === 0) return;

  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);

  const w = cssW;
  const h = cssH;
  const centerY = h / 2;
  // Selected = gold; everything else = white (opacity handled by .dim/.active CSS classes)
  const color = selected ? '#d4af37' : buffer ? 'rgba(234, 234, 234, 0.85)' : 'rgba(234, 234, 234, 0.4)';

  if (buffer) {
    const showStereo = exportChannels === 2 && buffer.numberOfChannels >= 2;
    if (showStereo) {
      drawBufferPeaks(ctx, buffer.getChannelData(0), w, h * 0.28, h * 0.22, color);
      drawBufferPeaks(ctx, buffer.getChannelData(1), w, h * 0.72, h * 0.22, color);
    } else {
      // Mono: average all channels for display
      const mono = buildMonoData(buffer);
      drawBufferPeaks(ctx, mono, w, centerY, h * 0.42, color);
    }
    return;
  }

  // Placeholder for empty (droppable) in-range slots
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const samples = 40;
  for (let i = 0; i < samples; i++) {
    const x = (i / samples) * w;
    const env = Math.exp(-i / samples * 2);
    const amp = Math.sin(i * 0.8) * env * (h * 0.4);
    const y = centerY + amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Redraw the mini waveform canvas for a single slot (e.g. after trim changes). */
function redrawMiniWaveformForMidi(midi: number) {
  const el = document.querySelector(`.mini-wave[data-midi="${midi}"]`) as HTMLElement | null;
  const canvas = el?.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const file = fileForMidi(midi);
  drawMiniWaveform(canvas, midi === state.selectedMidi, file?.audioBuffer ?? null);
}

/**
 * Build a mono Float32Array by averaging all channels of a buffer.
 * Used for mono display of stereo sources.
 */
function buildMonoData(buffer: AudioBuffer): Float32Array {
  const ch = buffer.numberOfChannels;
  if (ch === 1) return buffer.getChannelData(0);
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  for (let i = 0; i < len; i++) out[i] /= ch;
  return out;
}

/** Draw min/max peak envelope of a channel's data into a canvas strip. */
function drawBufferPeaks(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  w: number,
  centerY: number,
  amp: number,
  color: string,
) {
  const step = Math.max(1, Math.floor(data.length / w));

  ctx.fillStyle = color;
  for (let x = 0; x < w; x++) {
    let min = 1.0;
    let max = -1.0;
    const start = x * step;
    const end = Math.min(data.length, start + step);
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const yMax = centerY - max * amp;
    const yMin = centerY - min * amp;
    ctx.fillRect(x, yMax, 1, Math.max(1, yMin - yMax));
  }
}

// ============================================
// TRIM DETECTION
// ============================================

/**
 * Finds the first sample in any channel that exceeds the noise floor,
 * then backs up 5 ms for a clean attack. Returns seconds.
 */
function detectTrimStart(buffer: AudioBuffer, thresholdDb = -50): number {
  const threshold = Math.pow(10, thresholdDb / 20); // ~0.003 linear
  const sr = buffer.sampleRate;
  const nCh = buffer.numberOfChannels;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < nCh; ch++) {
      if (Math.abs(buffer.getChannelData(ch)[i]) > threshold) {
        return Math.max(0, (i / sr) - 0.005); // 5 ms safety margin
      }
    }
  }
  return 0;
}

// ============================================
// KEY SELECTION
// ============================================

function selectKey(midi: number, audition = false) {
  selectedSlots.clear();
  selectionAnchor = midi;
  stopSource();
  playOffset = 0;
  setPlayheadFraction(0);
  state.selectedMidi = midi;
  buildPianoRoll();
  renderFileBin();
  updateSampleEditor();
  if (audition && fileForMidi(midi)?.audioBuffer) playSample(0);
}

function updateSampleEditor() {
  const noteLabel = document.getElementById('sample-note-label');
  const fileLabel = document.getElementById('sample-file-label');
  const sampleCanvas = document.getElementById('sample-waveform') as HTMLCanvasElement;

  if (state.selectedMidi === NO_SELECTION) {
    if (noteLabel) noteLabel.textContent = '—';
    if (fileLabel) fileLabel.textContent = '—';
    if (sampleCanvas) {
      const ctx = sampleCanvas.getContext('2d');
      if (ctx) {
        const rect = sampleCanvas.getBoundingClientRect();
        sampleCanvas.width = rect.width * window.devicePixelRatio;
        sampleCanvas.height = rect.height * window.devicePixelRatio;
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary').trim();
        ctx.fillRect(0, 0, rect.width, rect.height);
      }
    }
    return;
  }

  if (noteLabel) noteLabel.textContent = midiToName(state.selectedMidi);

  if (fileLabel) {
    const assignedId = slotAssignments.get(state.selectedMidi);
    const assigned = assignedId != null
      ? importedFiles.find((f) => f.id === assignedId)
      : undefined;
    fileLabel.textContent = assigned ? assigned.name : 'source file name here';
  }

  if (sampleCanvas) drawDetailedWaveform(sampleCanvas);
  updateTrimUI();
  updateRuler();
}

// ============================================
// TRIM HANDLES (detail view)
// ============================================

/**
 * Returns the visible time window in the sample editor based on current zoom/scroll.
 * viewStart/viewEnd are in seconds; viewDur = viewEnd - viewStart.
 */
function getWaveView(dur: number): { viewStart: number; viewEnd: number; viewDur: number } {
  const thumbFrac = 1 / waveformZoom;
  const maxScrollFrac = Math.max(0, 1 - thumbFrac);
  const safeFrac = Math.min(waveformScrollFrac, maxScrollFrac);
  const viewStart = safeFrac * dur;
  const viewDur = dur * thumbFrac;
  return { viewStart, viewEnd: viewStart + viewDur, viewDur };
}

/** Reposition the dim overlays and drag handles for the current slot's trim points. */
function updateTrimUI() {
  const dimStart = document.getElementById('trim-dim-start') as HTMLElement | null;
  const dimEnd = document.getElementById('trim-dim-end') as HTMLElement | null;
  const hStart = document.getElementById('trim-handle-start') as HTMLElement | null;
  const hEnd = document.getElementById('trim-handle-end') as HTMLElement | null;
  if (!dimStart || !dimEnd || !hStart || !hEnd) return;

  const entry = fileForMidi(state.selectedMidi);
  const hidden = !entry?.audioBuffer;
  [dimStart, dimEnd, hStart, hEnd].forEach((el) => (el.style.display = hidden ? 'none' : ''));
  if (hidden) return;

  const dur = entry!.audioBuffer!.duration;
  const tStart = Math.max(0, entry!.trimStart);
  const tEnd = Math.min(entry!.trimEnd === Infinity ? dur : entry!.trimEnd, dur);

  // Map trim times to screen % through the current zoom window
  const { viewStart, viewDur } = getWaveView(dur);
  const startPct = ((tStart - viewStart) / viewDur) * 100;
  const endPct = ((tEnd - viewStart) / viewDur) * 100;

  // Dim overlays clamped to visible area (0–100%)
  dimStart.style.width = `${Math.max(0, Math.min(100, startPct))}%`;
  dimEnd.style.left = `${Math.max(0, Math.min(100, endPct))}%`;
  // Handles can extend off-screen so the user can still drag them back into view
  hStart.style.left = `${startPct}%`;
  hEnd.style.left = `${endPct}%`;
  updateRuler();
  // Keep the mini waveform in sync with live trim changes
  redrawMiniWaveformForMidi(state.selectedMidi);
}

/** Create the trim overlay and handle elements inside .sample-waveform-frame once. */
function initTrimHandles() {
  const frame = document.querySelector('.sample-waveform-frame') as HTMLElement | null;
  if (!frame) return;

  const dimStart = document.createElement('div');
  dimStart.id = 'trim-dim-start';
  dimStart.className = 'trim-dim trim-dim-start';

  const dimEnd = document.createElement('div');
  dimEnd.id = 'trim-dim-end';
  dimEnd.className = 'trim-dim trim-dim-end';

  const hStart = document.createElement('div');
  hStart.id = 'trim-handle-start';
  hStart.className = 'trim-handle trim-handle-start';
  hStart.title = 'Drag to set trim start';

  const hEnd = document.createElement('div');
  hEnd.id = 'trim-handle-end';
  hEnd.className = 'trim-handle trim-handle-end';
  hEnd.title = 'Drag to set trim end';

  frame.append(dimStart, dimEnd, hStart, hEnd);

  const frameEl = frame as HTMLElement;  // frame is guaranteed non-null (guard above)

  // Drag state
  type TrimSide = 'start' | 'end';
  let dragging: TrimSide | null = null;

  function startDrag(e: MouseEvent, side: TrimSide) {
    e.preventDefault();
    e.stopPropagation();
    dragging = side;
    document.body.style.cursor = 'ew-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onMove(e: MouseEvent) {
    if (!dragging) return;
    const entry = fileForMidi(state.selectedMidi);
    if (!entry?.audioBuffer) return;

    const rect = frameEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = entry.audioBuffer.duration;
    // Convert screen fraction to time via the current zoom window
    const { viewStart, viewDur } = getWaveView(dur);
    const newTime = viewStart + frac * viewDur;
    const effectiveTrimEnd = entry.trimEnd === Infinity ? dur : entry.trimEnd;

    if (dragging === 'start') {
      entry.trimStart = Math.min(newTime, effectiveTrimEnd - 0.01);
    } else {
      entry.trimEnd = Math.max(newTime, entry.trimStart + 0.01);
    }
    // Live-update the length display as the handle moves
    const liveTEnd = entry.trimEnd === Infinity ? dur : entry.trimEnd;
    const liveDur = Math.max(0.05, liveTEnd - entry.trimStart);
    if (dragging === 'end') slotDuration = liveDur; // end handle is the master length
    const dispEl = document.getElementById('length-display');
    if (dispEl) dispEl.textContent = `${liveDur.toFixed(2)}s`;
    updateTrimUI();
    updateExportSize();
    // If playing, stop — next Play press will start from new trimStart
    if (currentSource) {
      stopSource();
      playOffset = entry.trimStart;
      setPlayheadFraction(entry.trimStart / dur);
    }
  }

  function onUp() {
    const side = dragging;
    if (!side) return;
    dragging = null;
    document.body.style.cursor = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);

    // When end handle moves, propagate new length to all other slots
    if (side === 'end') {
      const entry = fileForMidi(state.selectedMidi);
      if (entry?.audioBuffer) {
        const dur = entry.audioBuffer.duration;
        const tEnd = entry.trimEnd === Infinity ? dur : entry.trimEnd;
        slotDuration = Math.max(0.05, tEnd - entry.trimStart);
        updateLengthDisplay();
        // Apply same duration to all OTHER files
        for (const f of importedFiles) {
          if (f.id === entry.id) continue;
          if (!f.audioBuffer) continue;
          f.trimEnd = Math.min(f.trimStart + slotDuration, f.audioBuffer.duration);
        }
        updateRuler();
        updateExportSize();
      }
    }

    persistSession();  // save updated trim points
  }

  hStart.addEventListener('mousedown', (e) => startDrag(e, 'start'));
  hEnd.addEventListener('mousedown', (e) => startDrag(e, 'end'));

  updateTrimUI();
}

// ============================================
// TIME RULER
// ============================================

/**
 * Draw a seconds-based time ruler on the given canvas.
 * The ruler spans the visible window (viewStart → viewStart+viewDur) and marks the active
 * trim region. Pass viewStart=0, viewDur=0 to fall back to the full buffer duration.
 */
function drawTrimRuler(
  canvas: HTMLCanvasElement,
  buffer: AudioBuffer,
  trimStart: number,
  trimEnd: number,
  viewStart = 0,
  viewDur = 0,
) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  const dur = buffer.duration;
  const vDur = viewDur > 0 ? viewDur : dur;
  const vStart = viewStart;

  // Map a time (seconds) to x-pixel in the visible window
  const px = (sec: number) => ((sec - vStart) / vDur) * w;

  // Background
  ctx.fillStyle = 'rgba(10, 10, 10, 0.88)';
  ctx.fillRect(0, 0, w, h);

  // Active region highlight (between trim handles) — muted gray tint
  const ax = px(trimStart);
  const bx = px(trimEnd);
  ctx.fillStyle = 'rgba(180, 180, 180, 0.07)';
  ctx.fillRect(ax, 0, bx - ax, h);

  // Choose tick interval based on the VISIBLE duration for dense-enough ticks
  let minor = 0.1, major = 0.5;
  if (vDur > 20) { minor = 1; major = 5; }
  else if (vDur > 10) { minor = 0.5; major = 2; }
  else if (vDur > 4) { minor = 0.25; major = 1; }
  else if (vDur > 2) { minor = 0.1; major = 0.5; }
  else if (vDur > 0.5) { minor = 0.05; major = 0.25; }
  else { minor = 0.01; major = 0.05; }

  // Ticks grow upward from the bottom edge
  const minorH = h * 0.32;
  const majorH = h * 0.60;
  ctx.lineWidth = 1;

  // Start tick loop from first multiple of minor at or before viewStart
  let t = Math.floor(vStart / minor) * minor;
  t = Math.round(t * 100000) / 100000;
  const tEnd = vStart + vDur;
  while (t <= tEnd + minor * 0.5) {
    const x = Math.round(px(t)) + 0.5;
    if (x >= -1 && x <= w + 1) {
      const isMajor = Math.abs(Math.round(t / major) * major - t) < minor * 0.1;
      const tickH = isMajor ? majorH : minorH;
      ctx.strokeStyle = isMajor ? 'rgba(200, 200, 200, 0.4)' : 'rgba(180, 180, 180, 0.18)';
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x, h - tickH);
      ctx.stroke();
    }
    t = Math.round((t + minor) * 100000) / 100000;
  }

  // Labels sit just above the major ticks — only within the visible window
  ctx.fillStyle = 'rgba(210, 210, 210, 0.55)';
  ctx.font = `${Math.round(9 * dpr) / dpr}px "Roboto Mono", monospace`;
  ctx.textBaseline = 'bottom';

  let label = Math.floor(vStart / major) * major;
  label = Math.round(label * 100000) / 100000;
  while (label <= tEnd + major * 0.5) {
    const x = px(label);
    if (x >= -20 && x <= w + 20) {
      const text = label.toFixed(label < 10 ? 2 : 1) + 's';
      const tw = ctx.measureText(text).width;
      if (x + tw + 2 <= w || label === Math.floor(vStart / major) * major) {
        ctx.fillText(text, Math.max(1, x - tw / 2), h - majorH);
      }
    }
    label = Math.round((label + major) * 100000) / 100000;
  }

  // Trim boundary lines — only draw if within visible window
  ctx.strokeStyle = 'rgba(210, 210, 210, 0.55)';
  ctx.lineWidth = 1.5;
  [trimStart, trimEnd].forEach((sec) => {
    const x = Math.round(px(sec)) + 0.5;
    if (x >= 0 && x <= w) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  });
}

/** Re-draw the ruler for the currently selected slot, respecting the current zoom view. */
function updateRuler() {
  const canvas = document.getElementById('trim-ruler') as HTMLCanvasElement | null;
  if (!canvas) return;
  const entry = fileForMidi(state.selectedMidi);
  if (!entry?.audioBuffer) {
    // Clear canvas
    const ctx = canvas.getContext('2d');
    if (ctx) { ctx.clearRect(0, 0, canvas.width, canvas.height); }
    return;
  }
  const dur = entry.audioBuffer.duration;
  const tEnd = entry.trimEnd === Infinity ? dur : Math.min(entry.trimEnd, dur);
  const { viewStart, viewDur } = getWaveView(dur);
  drawTrimRuler(canvas, entry.audioBuffer, entry.trimStart, tEnd, viewStart, viewDur);
}

// ============================================
// SLOT LENGTH CONTROL
// ============================================

function initLengthControl() {
  const downBtn = document.getElementById('length-down');
  const upBtn = document.getElementById('length-up');

  const STEP_SMALL = 0.05;   // 50 ms per click
  const STEP_LARGE = 0.5;    // 500 ms with Shift

  function change(delta: number) {
    if (slotDurationLocked) {
      applySlotDuration(slotDuration + delta);
    } else {
      applySelectedSlotDuration(getDisplayDuration() + delta);
    }
    updateLengthDisplay();
    updateSampleEditor(); // redraw ruler + trim handles
  }

  downBtn?.addEventListener('click', (e) => change((e as MouseEvent).shiftKey ? -STEP_LARGE : -STEP_SMALL));
  upBtn?.addEventListener('click', (e) => change((e as MouseEvent).shiftKey ? STEP_LARGE : STEP_SMALL));

  // Scroll wheel on the display for fine adjustment
  const displayEl = document.getElementById('length-display');
  displayEl?.addEventListener('wheel', (e) => {
    e.preventDefault();
    change((e as WheelEvent).deltaY < 0 ? STEP_SMALL : -STEP_SMALL);
  }, { passive: false });

  // Click-drag horizontal scrub on the display
  if (displayEl) {
    let dragStartX = 0;
    let dragStartDuration = 0;
    let isDragging = false;

    displayEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isDragging = true;
      dragStartX = e.clientX;
      dragStartDuration = getDisplayDuration();
      document.body.style.cursor = 'ew-resize';

      function onMove(ev: MouseEvent) {
        if (!isDragging) return;
        const dx = ev.clientX - dragStartX;
        // 1px = 0.02s, Shift = 0.004s (fine)
        const scale = ev.shiftKey ? 0.004 : 0.02;
        const newDur = dragStartDuration + dx * scale;
        if (slotDurationLocked) {
          applySlotDuration(newDur);
        } else {
          applySelectedSlotDuration(newDur);
        }
        updateLengthDisplay();
        updateSampleEditor();
      }

      function onUp() {
        isDragging = false;
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  updateLengthDisplay();
}

function initDurationLockToggle() {
  const btn = document.getElementById('duration-lock-btn');
  const group = document.querySelector('.length-controls');
  if (!btn || !group) return;

  function updateLockUI() {
    if (!btn || !group) return;
    if (slotDurationLocked) {
      btn.title = 'Locked: all slots share one duration. Click to unlock.';
      btn.setAttribute('aria-pressed', 'true');
      btn.classList.add('is-locked');
      group.classList.remove('is-unlocked');
    } else {
      btn.title = 'Unlocked: each slot has its own duration. Click to lock.';
      btn.setAttribute('aria-pressed', 'false');
      btn.classList.remove('is-locked');
      group.classList.add('is-unlocked');
    }
  }

  btn.addEventListener('click', () => {
    slotDurationLocked = !slotDurationLocked;
    if (slotDurationLocked) {
      // Re-lock: apply current slotDuration to all slots to re-synchronize
      applySlotDuration(slotDuration);
    }
    updateLockUI();
    updateLengthDisplay();
    updateSampleEditor();
    updateExportSize();
    persistSession();
  });

  updateLockUI();
}

// ============================================
// UNDO SYSTEM
// ============================================

interface UndoSnapshot {
  files: ImportedFile[];
  assignments: [number, number][];
  autoAssignedMidi: number[];
  selectedMidi: number;
  selectedSlotsMidi: number[];
  anchor: number | null;
  nextFileId: number;
}

const undoStack: UndoSnapshot[] = [];
const MAX_UNDO = 10;

function pushUndo() {
  if (undoStack.length >= MAX_UNDO) undoStack.shift();
  undoStack.push({
    files: importedFiles.map((entry) => ({ ...entry })),
    assignments: Array.from(slotAssignments.entries()),
    autoAssignedMidi: Array.from(autoAssigned),
    selectedMidi: state.selectedMidi,
    selectedSlotsMidi: Array.from(selectedSlots),
    anchor: selectionAnchor,
    nextFileId,
  });
}

function undoLast() {
  const snap = undoStack.pop();
  if (!snap) return;
  importedFiles.length = 0;
  importedFiles.push(...snap.files.map((entry) => ({ ...entry })));
  for (const entry of importedFiles) {
    entry.file.arrayBuffer().then((arrayBuffer) =>
      saveFile({ id: entry.id, name: entry.name, arrayBuffer }).catch(console.warn),
    );
  }
  slotAssignments.clear();
  for (const [k, v] of snap.assignments) slotAssignments.set(k, v);
  autoAssigned.clear();
  for (const m of snap.autoAssignedMidi) autoAssigned.add(m);
  state.selectedMidi = snap.selectedMidi;
  selectedSlots.clear();
  for (const m of snap.selectedSlotsMidi) selectedSlots.add(m);
  selectionAnchor = snap.anchor;
  nextFileId = snap.nextFileId;
  buildPianoRoll();
  renderFileBin();
  updateSampleEditor();
  persistSession();
}

// ============================================
// MULTI-SELECT HELPERS
// ============================================

/** Cheaply update .multi-selected class without rebuilding the entire roll DOM. */
function updateMultiSelectVisuals() {
  const waveformsEl = document.getElementById('pr-waveforms');
  if (!waveformsEl) return;
  waveformsEl.querySelectorAll<HTMLElement>('.mini-wave').forEach((wave) => {
    const midi = Number(wave.dataset.midi);
    if (selectedSlots.has(midi) && midi !== state.selectedMidi) {
      wave.classList.add('multi-selected');
    } else {
      wave.classList.remove('multi-selected');
    }
  });
}

/**
 * Wire up click / shift-click / rubber-band drag on the mini-waveform row.
 * Uses event delegation on #pr-waveforms so it survives buildPianoRoll() rebuilds.
 */
function initSelectionHandlers() {
  const containerEl = document.getElementById('pr-waveforms');
  if (!containerEl) return;
  const container: HTMLElement = containerEl;

  // Deselect when clicking blank space anywhere in the scroll container
  // (padding gutters, gap between waveform row and piano keys, etc.)
  const rollScroll = document.getElementById('piano-roll-scroll');
  rollScroll?.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.mini-wave') || target.closest('.pkey')) return;
    const hadSelection = selectedSlots.size > 0 || state.selectedMidi !== NO_SELECTION;
    selectedSlots.clear();
    selectionAnchor = null;
    state.selectedMidi = NO_SELECTION;
    if (hadSelection) { buildPianoRoll(); updateSampleEditor(); }
  });

  let pendingMidi = -1;          // slot under mousedown; -1 = nothing pending
  let pendingClientX = 0;
  let dragCommitted = false;     // drag threshold exceeded?
  let isPotentialMove = false;   // mousedown was on a slot inside selectedSlots

  let rubberActive = false;
  let rubberStartIdx = 0;
  let rubberCurrentIdx = 0;

  let moveStartIdx = 0;
  let rafPending = false;

  function slotIdxFromClientX(clientX: number): number {
    const rect = container.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width - 1, clientX - rect.left));
    const totalSlots = PIANO_END - PIANO_START + 1;
    return Math.min(totalSlots - 1, Math.floor(x / (rect.width / totalSlots)));
  }

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const slotEl = (e.target as HTMLElement).closest<HTMLElement>('.mini-wave');

    if (!slotEl) {
      // Clicked empty space — clear group selection and deselect the focused slot
      const hadSelection = selectedSlots.size > 0 || state.selectedMidi !== NO_SELECTION;
      selectedSlots.clear();
      selectionAnchor = null;
      state.selectedMidi = NO_SELECTION;
      if (hadSelection) {
        buildPianoRoll();
        updateSampleEditor();
      }
      return;
    }

    const slotIdx = slotIdxFromClientX(e.clientX);
    const midi = PIANO_START + slotIdx;

    if (e.shiftKey && selectionAnchor !== null) {
      // Shift-click: fill range from anchor to here (immediate, not a drag)
      const lo = Math.min(selectionAnchor, midi);
      const hi = Math.max(selectionAnchor, midi);
      selectedSlots.clear();
      for (let m = lo; m <= hi; m++) selectedSlots.add(m);
      state.selectedMidi = midi;
      buildPianoRoll();
      updateSampleEditor();
      return;
    }

    // Decide whether this could be a group move
    isPotentialMove = selectedSlots.size > 1 && selectedSlots.has(midi);
    pendingMidi = midi;
    pendingClientX = e.clientX;
    dragCommitted = false;

    if (!isPotentialMove) {
      rubberStartIdx = slotIdx;
      rubberCurrentIdx = slotIdx;
    } else {
      moveStartIdx = slotIdx;
      moveCurrentDelta = 0;
    }
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (pendingMidi < 0) return;

    if (!dragCommitted) {
      if (Math.abs(e.clientX - pendingClientX) < 5) return;
      dragCommitted = true;
      if (isPotentialMove) {
        moveActive = true;
        document.body.style.cursor = 'ew-resize';
      } else {
        rubberActive = true;
        selectionAnchor = pendingMidi;
        selectedSlots.clear();
        selectedSlots.add(pendingMidi);
        updateMultiSelectVisuals();
      }
    }

    if (moveActive) {
      const currentIdx = slotIdxFromClientX(e.clientX);
      const slots = Array.from(selectedSlots);
      const loMidi = Math.min(...slots);
      const hiMidi = Math.max(...slots);
      const rawDelta = currentIdx - moveStartIdx;
      moveCurrentDelta = Math.max(PIANO_START - loMidi, Math.min(PIANO_END - hiMidi, rawDelta));
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; buildPianoRoll(); });
      }
    } else if (rubberActive) {
      rubberCurrentIdx = slotIdxFromClientX(e.clientX);
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          if (!rubberActive) return;
          const lo = Math.min(rubberStartIdx, rubberCurrentIdx);
          const hi = Math.max(rubberStartIdx, rubberCurrentIdx);
          selectedSlots.clear();
          for (let i = lo; i <= hi; i++) selectedSlots.add(PIANO_START + i);
          state.selectedMidi = PIANO_START + rubberCurrentIdx;
          updateMultiSelectVisuals();
        });
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (pendingMidi < 0) return;
    const midi = pendingMidi;
    pendingMidi = -1;

    if (moveActive) {
      moveActive = false;
      document.body.style.cursor = '';
      if (moveCurrentDelta !== 0) {
        commitGroupMove(moveCurrentDelta);
        moveCurrentDelta = 0;
      } else {
        buildPianoRoll(); // remove ghost preview
      }
      return;
    }

    if (rubberActive) {
      rubberActive = false;
      const lo = Math.min(rubberStartIdx, rubberCurrentIdx);
      const hi = Math.max(rubberStartIdx, rubberCurrentIdx);
      selectedSlots.clear();
      for (let i = lo; i <= hi; i++) selectedSlots.add(PIANO_START + i);
      state.selectedMidi = PIANO_START + rubberCurrentIdx;
      selectionAnchor = state.selectedMidi;
      if (selectedSlots.size <= 1) {
        const m = PIANO_START + rubberCurrentIdx;
        selectedSlots.clear();
        selectKey(m, false); // no audition from waveform row
      } else {
        buildPianoRoll();
        updateSampleEditor();
      }
      return;
    }

    // Plain click — focus only, no audition from waveform row
    selectedSlots.clear();
    selectionAnchor = midi;
    selectKey(midi, false);
  });

  document.addEventListener('keydown', (e) => {
    // Escape: cancel move preview or clear selection
    if (e.key === 'Escape') {
      if (moveActive) {
        moveActive = false;
        moveCurrentDelta = 0;
        pendingMidi = -1;
        document.body.style.cursor = '';
        buildPianoRoll();
        return;
      }
      if (selectedSlots.size > 0) {
        selectedSlots.clear();
        selectionAnchor = null;
        buildPianoRoll();
      }
      return;
    }

    // Arrow keys: nudge selected group ±1 or ±12
    if (selectedSlots.size > 1 && !moveActive) {
      let delta = 0;
      if (e.key === 'ArrowLeft') delta = e.shiftKey ? -12 : -1;
      if (e.key === 'ArrowRight') delta = e.shiftKey ? +12 : +1;
      if (delta !== 0) {
        e.preventDefault();
        commitGroupMove(delta);
        return;
      }
    }

    // Ctrl+Z / Cmd+Z: undo
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLast();
    }
  });
}

// ============================================
// FILE BIN (imported source files)
// ============================================
// IMPORT MAPPING DIALOG
// ============================================

/** Semitone offset that best centres the sample set within the KB1 range. */
function suggestOffset(mappings: SampleMapping[]): number {
  const notes = mappings
    .map((m) => m.rootMidi)
    .filter((n): n is number => n !== null);
  if (notes.length === 0) return 0;

  const sorted = [...notes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const KB1_CENTER = Math.round((KB1_LOW + KB1_HIGH) / 2); // 68 ≈ Ab4
  const rawOffset = KB1_CENTER - median;

  // Also try octave-snap (cleaner musically)
  const octaveSnapped = Math.round(rawOffset / 12) * 12;
  const rawKb1 = countMappingsInRange(mappings, rawOffset).kb1;
  const snapKb1 = countMappingsInRange(mappings, octaveSnapped).kb1;
  return snapKb1 >= rawKb1 - 1 ? octaveSnapped : rawOffset;
}

function countMappingsInRange(
  mappings: SampleMapping[],
  offset: number,
): { kb1: number; roll: number; out: number } {
  let kb1 = 0, roll = 0, out = 0;
  for (const m of mappings) {
    if (m.rootMidi === null) continue;
    const s = m.rootMidi + offset;
    if (s >= KB1_LOW && s <= KB1_HIGH) kb1++;
    else if (s >= PIANO_START && s <= PIANO_END) roll++;
    else out++;
  }
  return { kb1, roll, out };
}

function applyMidiOffset(mappings: SampleMapping[], offset: number): SampleMapping[] {
  if (offset === 0) return mappings;
  return mappings.map((m) => ({
    ...m,
    rootMidi: m.rootMidi !== null ? m.rootMidi + offset : null,
  }));
}

function drawMappingPreview(
  canvas: HTMLCanvasElement,
  mappings: SampleMapping[],
  offset: number,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;

  const cw = rect.width;
  const ch = rect.height;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  ctx.scale(dpr, dpr);

  const TOTAL = PIANO_END - PIANO_START + 1;
  const slotW = cw / TOTAL;
  const TOP_H = 16;
  const BOTTOM_H = 16;
  const SLOT_Y = TOP_H;
  const SLOT_H = ch - TOP_H - BOTTOM_H;

  const kb1Si = KB1_LOW - PIANO_START;  // 11
  const kb1Ei = KB1_HIGH - PIANO_START; // 29
  const kb1X = kb1Si * slotW;
  const kb1W = (kb1Ei - kb1Si + 1) * slotW;

  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, cw, ch);

  // KB1 zone background tint
  ctx.fillStyle = 'rgba(212, 175, 55, 0.05)';
  ctx.fillRect(kb1X, 0, kb1W, ch);

  // Build slot status map
  const slotStatus = new Map<number, 'kb1' | 'roll'>();
  let overLeft = 0, overRight = 0;
  for (const m of mappings) {
    if (m.rootMidi === null) continue;
    const s = m.rootMidi + offset;
    const idx = s - PIANO_START;
    if (s >= KB1_LOW && s <= KB1_HIGH) slotStatus.set(idx, 'kb1');
    else if (s >= PIANO_START && s <= PIANO_END) slotStatus.set(idx, 'roll');
    else if (s < PIANO_START) overLeft++;
    else overRight++;
  }

  // Slot cells
  for (let i = 0; i < TOTAL; i++) {
    const midi = PIANO_START + i;
    const x = i * slotW;
    const status = slotStatus.get(i);
    const black = isBlackKey(midi);
    ctx.fillStyle = black ? '#131313' : '#202020';
    ctx.fillRect(x + 0.5, SLOT_Y + 0.5, slotW - 1, SLOT_H - 1);
    if (status === 'kb1') {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#d4af37';
      ctx.fillRect(x + 0.5, SLOT_Y + 0.5, slotW - 1, SLOT_H - 1);
      ctx.globalAlpha = 1;
    } else if (status === 'roll') {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#b9aa5f';
      ctx.fillRect(x + 0.5, SLOT_Y + 0.5, slotW - 1, SLOT_H - 1);
      ctx.globalAlpha = 1;
    }
  }

  // Overflow edge indicators
  if (overLeft > 0) {
    ctx.fillStyle = 'rgba(173, 65, 55, 0.75)';
    ctx.fillRect(0, SLOT_Y, 5, SLOT_H);
  }
  if (overRight > 0) {
    ctx.fillStyle = 'rgba(173, 65, 55, 0.75)';
    ctx.fillRect(cw - 5, SLOT_Y, 5, SLOT_H);
  }

  // KB1 bracket (top-of-slots line + corner ticks)
  ctx.strokeStyle = 'rgba(212, 175, 55, 0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(kb1X + 0.5, 2); ctx.lineTo(kb1X + kb1W - 0.5, 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(kb1X + 0.5, 2); ctx.lineTo(kb1X + 0.5, SLOT_Y + 1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(kb1X + kb1W - 0.5, 2); ctx.lineTo(kb1X + kb1W - 0.5, SLOT_Y + 1); ctx.stroke();

  // KB1 label
  ctx.fillStyle = 'rgba(212, 175, 55, 0.7)';
  ctx.font = `10px 'Roboto Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('KB1', kb1X + kb1W / 2, TOP_H / 2 + 1);

  // Octave labels (bottom)
  ctx.fillStyle = 'rgba(234, 234, 234, 0.3)';
  ctx.font = `10px 'Roboto Mono', monospace`;
  ctx.textBaseline = 'middle';
  const LABEL_CY = ch - BOTTOM_H / 2;
  for (let midi = PIANO_START; midi <= PIANO_END; midi++) {
    if (midi % 12 === 0) {
      const i = midi - PIANO_START;
      ctx.textAlign = 'center';
      ctx.fillText('C' + (Math.floor(midi / 12) - 1), i * slotW + slotW / 2, LABEL_CY);
    }
  }
}

function showMappingDialog(rawMappings: SampleMapping[]): Promise<SampleMapping[] | null> {
  return new Promise((resolve) => {
    let currentOffset = suggestOffset(rawMappings);
    const detected = rawMappings.filter((m) => m.rootMidi !== null);
    const notes = detected.map((m) => m.rootMidi as number);
    const minNote = notes.length ? Math.min(...notes) : null;
    const maxNote = notes.length ? Math.max(...notes) : null;

    function close(result: SampleMapping[] | null) {
      overlay.remove();
      resolve(result);
    }

    const overlay = document.createElement('div');
    overlay.className = 'mapping-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

    const modal = document.createElement('div');
    modal.className = 'mapping-modal';
    modal.addEventListener('click', (e) => e.stopPropagation());

    // Header (title + inline summary + close)
    const header = document.createElement('div');
    header.className = 'mapping-modal-header';
    const titleEl = document.createElement('span');
    titleEl.className = 'mapping-modal-title';
    titleEl.textContent = 'Map Samples to Piano Roll';
    const summaryEl = document.createElement('span');
    summaryEl.className = 'mapping-header-summary';
    const rangeStr = minNote !== null && maxNote !== null
      ? `${midiToName(minNote)} – ${midiToName(maxNote)}`
      : 'No notes auto-detected';
    summaryEl.textContent = `${rawMappings.length} files  ·  Detected range: ${rangeStr}`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'mapping-close-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => close(null));
    header.append(titleEl, summaryEl, closeBtn);

    // Preview canvas
    const previewWrapper = document.createElement('div');
    previewWrapper.className = 'mapping-preview-wrapper';
    const canvas = document.createElement('canvas');
    canvas.className = 'mapping-preview-canvas';
    previewWrapper.appendChild(canvas);

    // Info row (updates with offset)
    const infoRow = document.createElement('div');
    infoRow.className = 'mapping-info-row';
    const infoText = document.createElement('span');
    infoText.className = 'mapping-info-text';
    infoRow.appendChild(infoText);

    // Offset display + controls
    const controls = document.createElement('div');
    controls.className = 'mapping-offset-controls';
    const offsetDisplay = document.createElement('span');
    offsetDisplay.className = 'mapping-offset-display';

    function refresh() {
      const filtered = getFilteredMappings();
      const stats = countMappingsInRange(filtered, currentOffset);
      const filteredDetected = filtered.filter(m => m.rootMidi !== null).length;
      const sign = currentOffset >= 0 ? '+' : '';
      let label = `${sign}${currentOffset} semitones`;
      if (minNote !== null) {
        const to = midiToName(Math.max(0, Math.min(127, minNote + currentOffset)));
        label += `  (${midiToName(minNote)} → ${to})`;
      }
      offsetDisplay.textContent = label;
      let info = `${stats.kb1} of ${filteredDetected} within KB1`;
      if (stats.roll > 0) info += `  ·  ${stats.roll} in roll`;
      if (stats.out > 0) info += `  ·  ${stats.out} outside range`;
      infoText.textContent = info;
      infoText.style.color = stats.kb1 > 0 ? 'var(--accent-gold)' : 'var(--text-secondary)';
      requestAnimationFrame(() => drawMappingPreview(canvas, filtered, currentOffset));
    }

    function makeBtn(label: string, delta: number) {
      const btn = document.createElement('button');
      btn.className = 'mapping-offset-btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        currentOffset = Math.max(-72, Math.min(72, currentOffset + delta));
        refresh();
      });
      return btn;
    }
    controls.append(makeBtn('← Oct', -12), offsetDisplay, makeBtn('Oct →', +12));

    // Reset-to-suggested link
    const resetLink = document.createElement('button');
    resetLink.className = 'mapping-reset-link';
    resetLink.textContent = 'Reset to suggested';
    resetLink.addEventListener('click', () => { currentOffset = suggestOffset(rawMappings); refresh(); });
    infoRow.appendChild(resetLink);

    // Layer selector + auto-trim combined options row
    const EXCLUDED_ARTICULATIONS = new Set(['release', 'rt']);
    const layerKeys = [...new Set(
      rawMappings
        .filter(m => !EXCLUDED_ARTICULATIONS.has((m.articulation ?? '').toLowerCase()))
        .map(m => m.velLayer ?? m.articulation ?? null)
    )] as (string | null)[];

    let layerSelect: HTMLSelectElement | null = null;
    const optionsRow = document.createElement('div');
    optionsRow.className = 'mapping-options-row';

    if (layerKeys.length > 1) {
      const layerLabel = document.createElement('span');
      layerLabel.className = 'mapping-trim-label';
      layerLabel.textContent = 'Sample layer';
      layerSelect = document.createElement('select');
      layerSelect.className = 'mapping-layer-select';
      for (const key of layerKeys) {
        const opt = document.createElement('option');
        opt.value = key ?? '';
        opt.textContent = key ? key.toUpperCase() : 'DEFAULT';
        layerSelect.appendChild(opt);
      }
      const medOpt = layerKeys.find(k => k === 'med' || k === 'medium');
      if (medOpt !== undefined) layerSelect.value = medOpt ?? '';
      layerSelect.addEventListener('change', refresh);
      optionsRow.append(layerLabel, layerSelect);
    }

    // Auto-trim toggle (right side of options row)
    const trimLabel = document.createElement('span');
    trimLabel.className = 'mapping-trim-label';
    trimLabel.textContent = 'Auto-trim silence';
    const trimToggle = document.createElement('button');
    trimToggle.className = 'mapping-trim-toggle' + (autoTrimEnabled ? ' active' : '');
    trimToggle.textContent = autoTrimEnabled ? 'ON' : 'OFF';
    trimToggle.title = 'Automatically trim leading silence from each imported clip';
    trimToggle.addEventListener('click', () => {
      autoTrimEnabled = !autoTrimEnabled;
      trimToggle.textContent = autoTrimEnabled ? 'ON' : 'OFF';
      trimToggle.classList.toggle('active', autoTrimEnabled);
    });
    const trimGroup = document.createElement('div');
    trimGroup.className = 'mapping-options-right';
    trimGroup.append(trimLabel, trimToggle);
    optionsRow.appendChild(trimGroup);

    function getFilteredMappings(): import('./sampleImport').SampleMapping[] {
      if (!layerSelect) return rawMappings;
      const selected = layerSelect.value || null;
      return rawMappings.filter(m => {
        if (EXCLUDED_ARTICULATIONS.has((m.articulation ?? '').toLowerCase())) return false;
        const key = m.velLayer ?? m.articulation ?? null;
        return key === selected;
      });
    }

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'mapping-modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'mapping-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => close(null));
    const applyBtn = document.createElement('button');
    applyBtn.className = 'mapping-btn-apply';
    applyBtn.textContent = 'Apply Mapping';
    applyBtn.addEventListener('click', () => close(applyMidiOffset(getFilteredMappings(), currentOffset)));
    actions.append(cancelBtn, applyBtn);

    modal.append(header, optionsRow, previewWrapper, infoRow, controls, actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => refresh());
  });
}

// ============================================

/** Move the selected group by `delta` semitones, updating assignments and persisting. */
function commitGroupMove(delta: number) {
  if (delta === 0 || selectedSlots.size === 0) return;

  const slots = Array.from(selectedSlots);
  const loMidi = Math.min(...slots);
  const hiMidi = Math.max(...slots);
  const clampedDelta = Math.max(PIANO_START - loMidi, Math.min(PIANO_END - hiMidi, delta));
  if (clampedDelta === 0) return;

  pushUndo();

  // Collect assignments for all moving slots
  const toMove: [number, number][] = [];
  for (const midi of slots) {
    const fileId = slotAssignments.get(midi);
    if (fileId != null) toMove.push([midi, fileId]);
  }

  // Remove source positions
  for (const [midi] of toMove) {
    slotAssignments.delete(midi);
    autoAssigned.delete(midi);
  }

  // Place at destination positions
  for (const [midi, fileId] of toMove) {
    slotAssignments.set(midi + clampedDelta, fileId);
    autoAssigned.delete(midi + clampedDelta); // moved = now manually placed
  }

  // Shift selection and anchor
  const newSlots = new Set(slots.map((m) => m + clampedDelta));
  selectedSlots.clear();
  for (const m of newSlots) selectedSlots.add(m);
  if (selectionAnchor !== null) selectionAnchor += clampedDelta;
  state.selectedMidi = Math.max(PIANO_START, Math.min(PIANO_END, state.selectedMidi + clampedDelta));

  buildPianoRoll();
  renderFileBin();
  updateSampleEditor();
  persistSession();
}

// ============================================
// CONTEXT MENU
// ============================================

function showContextMenu(e: MouseEvent, midi: number): void {
  // Remove any leftover menu
  document.querySelector('.ctx-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  function dismiss() {
    menu.remove();
    document.removeEventListener('mousedown', outsideHandler, true);
    document.removeEventListener('keydown', escHandler);
  }

  const outsideHandler = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) dismiss();
  };
  const escHandler = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); dismiss(); }
  };

  // ── Deselect selection ──
  if (selectedSlots.size > 1) {
    menu.appendChild(makeCtxItem('Deselect Selection', () => {
      selectedSlots.clear();
      selectionAnchor = null;
      buildPianoRoll();
      dismiss();
    }));
  }

  // ── Clear Slot (with separator) ──
  if (slotAssignments.has(midi)) {
    if (menu.children.length > 0) {
      const sep = document.createElement('div'); sep.className = 'ctx-separator'; menu.appendChild(sep);
    }
    menu.appendChild(makeCtxItem(`Clear Slot  ${midiToName(midi)}`, () => {
      dismiss();
      showConfirmDialog(
        `Clear sample from slot ${midiToName(midi)}?`,
        () => { pushUndo(); clearSlot(midi); },
        'Clear Slot',
      );
    }, true)); // destructive styling
  }

  // ── Assign / Replace ──
  if (importedFiles.length > 0) {
    const hasAssignment = slotAssignments.has(midi);
    const subItems = importedFiles.map((f) => ({
      label: f.name,
      action: () => {
        pushUndo();
        slotAssignments.set(midi, f.id);
        autoAssigned.delete(midi);
        state.selectedMidi = midi;
        buildPianoRoll();
        renderFileBin();
        updateSampleEditor();
        persistSession();
        dismiss();
      },
    }));
    menu.appendChild(makeCtxItemWithSub(
      hasAssignment ? 'Replace with\u2026' : 'Assign from bin\u2026',
      subItems,
    ));
  }

  if (menu.children.length === 0) return; // nothing to show

  document.body.appendChild(menu);

  // Flip position if it would overflow viewport
  requestAnimationFrame(() => {
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth - 8) menu.style.left = `${e.clientX - mr.width}px`;
    if (mr.bottom > window.innerHeight - 8) menu.style.top = `${e.clientY - mr.height}px`;
    // Flip submenus that would overflow right
    menu.querySelectorAll<HTMLElement>('.ctx-submenu').forEach((sub) => {
      const pr = (sub.parentElement as HTMLElement).getBoundingClientRect();
      if (window.innerWidth - pr.right < 230) {
        sub.style.left = 'auto';
        sub.style.right = '100%';
      }
    });
  });

  setTimeout(() => {
    document.addEventListener('mousedown', outsideHandler, true);
    document.addEventListener('keydown', escHandler);
  }, 0);
}

function makeCtxItem(label: string, action: () => void, danger = false): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'ctx-item' + (danger ? ' ctx-item-danger' : '');
  btn.textContent = label;
  btn.addEventListener('click', action);
  return btn;
}

function makeCtxItemWithSub(
  label: string,
  subitems: { label: string; action: () => void }[],
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ctx-item ctx-has-sub';

  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  wrap.appendChild(labelSpan);

  const arrow = document.createElement('span');
  arrow.className = 'ctx-arrow';
  arrow.textContent = '\u25b6';
  wrap.appendChild(arrow);

  const sub = document.createElement('div');
  sub.className = 'ctx-submenu';
  for (const si of subitems) {
    const btn = document.createElement('button');
    btn.className = 'ctx-sub-item';
    btn.textContent = si.label;
    btn.title = si.label;
    btn.addEventListener('click', si.action);
    sub.appendChild(btn);
  }
  wrap.appendChild(sub);
  return wrap;
}

/** Small modal for destructive-action confirmation. */
function showConfirmDialog(
  message: string,
  onConfirm: () => void,
  confirmLabel = 'Confirm',
): void {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';

  const modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.addEventListener('click', (e) => e.stopPropagation());

  const msg = document.createElement('p');
  msg.className = 'confirm-message';
  msg.textContent = message;

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';

  function dismiss() {
    overlay.remove();
    document.removeEventListener('keydown', keyHandler);
  }
  function confirm() { dismiss(); onConfirm(); }

  function keyHandler(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); dismiss(); }
    if (e.key === 'Enter') { e.stopPropagation(); confirm(); }
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
  document.addEventListener('keydown', keyHandler);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'confirm-btn-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', dismiss);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'confirm-btn-danger';
  confirmBtn.textContent = confirmLabel;
  confirmBtn.addEventListener('click', confirm);

  actions.append(cancelBtn, confirmBtn);
  modal.append(msg, actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => confirmBtn.focus());
}

function initImport() {
  const importBtn = document.getElementById('import-btn');
  const fileInput = document.getElementById('import-file-input') as HTMLInputElement;
  if (!importBtn || !fileInput) return;

  importBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    if (!fileInput.files || fileInput.files.length === 0) return;
    const files = Array.from(fileInput.files);
    fileInput.value = ''; // allow re-importing the same file
    await ingestFiles(files);
  });
}

function initImportBinOnly() {
  const btn = document.getElementById('import-bin-only-btn');
  const fileInput = document.getElementById('import-bin-only-input') as HTMLInputElement;
  if (!btn || !fileInput) return;

  btn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    if (!fileInput.files || fileInput.files.length === 0) return;
    const files = Array.from(fileInput.files);
    fileInput.value = '';
    await ingestFilesOnly(files);
  });
}

/** Adds files straight to the bin — no mapping dialog, no auto-propagate. */
async function ingestFilesOnly(files: File[]) {
  const audioFiles = files.filter((f) =>
    f.type.startsWith('audio/') || /\.(wav|aif|aiff|flac|mp3|ogg)$/i.test(f.name),
  );
  if (audioFiles.length === 0) return;

  pushUndo();

  const added: ImportedFile[] = [];
  for (const file of audioFiles) {
    const entry: ImportedFile = {
      id: nextFileId++,
      name: file.name,
      file,
      mapping: { file, rootMidi: null, rawName: file.name, confidence: 0, source: 'filename' },
      detectedRootMidi: null,
      audioBuffer: null,
      decoding: true,
      trimStart: 0,
      trimEnd: Infinity,
      normalized: false,
    };
    importedFiles.push(entry);
    added.push(entry);
    file.arrayBuffer().then((ab) =>
      saveFile({ id: entry.id, name: entry.name, arrayBuffer: ab }).catch(console.warn),
    );
  }

  renderFileBin();
  buildPianoRoll();
  persistSession();

  for (const entry of added) {
    decodeEntry(entry);
  }
}

// ============================================
// PTI EXPORT
// ============================================

async function handleExport() {
  // Build an ordered slot list: ascending MIDI note so the Tracker's chromatic
  // slice mapping is musically correct (low note = first slice).
  const sortedMidi = [...slotAssignments.keys()].sort((a, b) => a - b);
  const slots: SlotAudio[] = [];

  for (const midi of sortedMidi) {
    const id = slotAssignments.get(midi);
    const entry = id != null ? findFileById(id) : undefined;
    if (!entry?.audioBuffer) continue;
    const dur = entry.audioBuffer.duration;
    slots.push({
      audioBuffer: entry.audioBuffer,
      trimStart: entry.trimStart,
      trimEnd: entry.trimEnd === Infinity ? dur : Math.min(entry.trimEnd, dur),
      name: entry.name,
    });
  }

  if (slots.length === 0) {
    alert('Assign at least one sample to a key before exporting.');
    return;
  }

  const nameInput = document.getElementById('instrument-name') as HTMLInputElement | null;
  const instrName = nameInput?.value?.trim() || 'Untitled';

  const exportBtn = document.getElementById('export-btn');
  // Find the text node (last child) to update without disturbing the SVG icon
  const exportLabelNode = exportBtn
    ? Array.from(exportBtn.childNodes).find((n) => n.nodeType === Node.TEXT_NODE) ?? null
    : null;
  const origLabel = exportLabelNode?.textContent ?? 'Export .pti';

  function setExportLabel(text: string) {
    if (exportLabelNode) exportLabelNode.textContent = text;
  }

  try {
    setExportLabel('Building…');
    const bytes = await exportToPti(slots, {
      channels: exportChannels as 1 | 2,
      bitDepth: 16,
      instrumentName: instrName,
    });
    // Open OS save dialog in the same folder as the project file (if saved)
    await savePtiFile(bytes, instrName, currentProjectHandle ?? undefined);
    setExportLabel('Saved ✓');
    setTimeout(() => { setExportLabel(origLabel); }, 2000);
  } catch (err: unknown) {
    // User cancelling the save dialog throws an AbortError — treat silently
    if (err instanceof DOMException && err.name === 'AbortError') {
      setExportLabel(origLabel);
      return;
    }
    console.error('PTI export failed:', err);
    alert(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    setExportLabel(origLabel);
  }
}

function initExportBtn() {
  document.getElementById('export-btn')?.addEventListener('click', handleExport);
}

/**
 * Allow dragging OS files/folders onto the file bin to import them.
 * Folders are traversed recursively (handy for large sample libraries).
 */
function initFileDrop() {
  const bin = document.getElementById('file-bin');
  if (!bin) return;

  bin.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    bin.classList.add('drop-active');
  });

  bin.addEventListener('dragleave', (e) => {
    if (e.target === bin) bin.classList.remove('drop-active');
  });

  bin.addEventListener('drop', async (e) => {
    e.preventDefault();
    bin.classList.remove('drop-active');
    if (!e.dataTransfer) return;

    const items = Array.from(e.dataTransfer.items)
      .map((it) => it.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => !!entry);

    let files: File[];
    if (items.length > 0) {
      files = await collectEntries(items);
    } else {
      files = Array.from(e.dataTransfer.files);
    }
    if (files.length > 0) await ingestFiles(files);
  });
}

/** Recursively gather File objects from dropped FileSystemEntry items. */
async function collectEntries(entries: FileSystemEntry[]): Promise<File[]> {
  const out: File[] = [];

  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) =>
        fileEntry.file(resolve, reject),
      );
      out.push(file);
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      // readEntries must be called repeatedly until it returns empty.
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        for (const child of batch) await walk(child);
      } while (batch.length > 0);
    }
  }

  for (const entry of entries) await walk(entry);
  return out;
}

/**
 * Parse a batch of files through the import providers (SFZ or filename),
 * register them in the bin, decode audio, then auto-propagate to slots.
 */
async function ingestFiles(files: File[]) {
  const rawMappings = await importSamples(files);
  if (rawMappings.length === 0) return;

  // Show import mapping dialog before committing to the piano roll
  const mappings = await showMappingDialog(rawMappings);
  if (!mappings) return; // user cancelled

  pushUndo();

  // Capture pre-offset rootMidi values from rawMappings — these are the true source notes.
  // applyMidiOffset will have shifted mapping.rootMidi to the destination key, so we preserve
  // the original here for use in the slip strip display.
  const rawRootByFile = new Map<File, number | null>(rawMappings.map((m) => [m.file, m.rootMidi]));

  const added: ImportedFile[] = [];
  for (const mapping of mappings) {
    const entry: ImportedFile = {
      id: nextFileId++,
      name: mapping.file.name,
      file: mapping.file,
      mapping,
      detectedRootMidi: rawRootByFile.get(mapping.file) ?? null,
      audioBuffer: null,
      decoding: true,
      trimStart: 0,
      trimEnd: Infinity,
      normalized: false,
    };
    importedFiles.push(entry);
    added.push(entry);
    // Persist the raw bytes immediately so the session survives refresh
    mapping.file.arrayBuffer().then((ab) =>
      saveFile({ id: entry.id, name: entry.name, arrayBuffer: ab }).catch(console.warn),
    );
  }

  renderFileBin();

  // Auto-propagate mappings to slots (the default import behavior).
  autoPropagate(added);
  buildPianoRoll();
  renderFileBin();
  updateSampleEditor();
  persistSession();

  // Decode audio buffers in the background; redraw as each completes.
  for (const entry of added) {
    decodeEntry(entry);
  }
}

async function decodeEntry(entry: ImportedFile) {
  try {
    const arrayBuf = await entry.file.arrayBuffer();
    entry.audioBuffer = await getAudioContext().decodeAudioData(arrayBuf);
    // Re-apply normalization if it was active before save
    if (entry.normalized) entry.audioBuffer = normalizeAudioBuffer(entry.audioBuffer);
    // Auto-expand slotDuration only for fresh imports (trimEnd === Infinity means not restored from file)
    if (entry.trimEnd === Infinity && entry.audioBuffer.duration > slotDuration) {
      slotDuration = Math.round(entry.audioBuffer.duration * 100) / 100;
      updateLengthDisplay();
    }
    // Set trimEnd using slotDuration (if not already set by restoreSession)
    if (entry.trimEnd === Infinity) {
      if (autoTrimEnabled) entry.trimStart = detectTrimStart(entry.audioBuffer);
      entry.trimEnd = Math.min(entry.trimStart + slotDuration, entry.audioBuffer.duration);
    }
  } catch (err) {
    console.warn(`Failed to decode ${entry.name}:`, err);
    entry.audioBuffer = null;
  } finally {
    entry.decoding = false;
    // Redraw any slot showing this file
    const assignedMidi = midiForFile(entry.id);
    if (assignedMidi != null) {
      buildPianoRoll();
      if (assignedMidi === state.selectedMidi) updateSampleEditor();
    }
    renderFileBin();
    updateExportSize();
  }
}

// ============================================
// NORMALIZATION
// ============================================
// Peak normalization: scale so the loudest sample across all channels
// reaches exactly peakCeilingDb (default -1 dBFS). Much more predictable
// than RMS normalization for instrument samples — what you see is what exports.

function normalizeAudioBuffer(
  buffer: AudioBuffer,
  peakCeilingDb = -1
): AudioBuffer {
  const peakCeiling = Math.pow(10, peakCeilingDb / 20);
  const numChannels = buffer.numberOfChannels;
  const numSamples = buffer.length;

  // Find absolute peak across all channels
  let maxPeak = 0;
  for (let c = 0; c < numChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let s = 0; s < numSamples; s++) {
      const abs = Math.abs(data[s]);
      if (abs > maxPeak) maxPeak = abs;
    }
  }
  if (maxPeak === 0) return buffer; // silence — nothing to do
  const gain = peakCeiling / maxPeak;
  if (Math.abs(gain - 1) < 0.001) return buffer; // already at target

  // Apply gain to a new buffer
  const ctx = getAudioContext();
  const out = ctx.createBuffer(numChannels, numSamples, buffer.sampleRate);
  for (let c = 0; c < numChannels; c++) {
    const inData = buffer.getChannelData(c);
    const outData = out.getChannelData(c);
    for (let s = 0; s < numSamples; s++) outData[s] = inData[s] * gain;
  }
  return out;
}

async function normalizeEntry(entry: ImportedFile): Promise<void> {
  if (!entry.audioBuffer) return;
  const item = document.querySelector<HTMLElement>(`.file-bin-item[data-file-id="${entry.id}"]`);
  item?.classList.add('normalizing');
  // Yield to let the UI update before the heavy loop
  await new Promise(r => setTimeout(r, 0));
  entry.audioBuffer = normalizeAudioBuffer(entry.audioBuffer);
  entry.normalized = true;
  item?.classList.remove('normalizing');
  persistSession();
  const assignedMidi = midiForFile(entry.id);
  if (assignedMidi != null) {
    buildPianoRoll();
    if (assignedMidi === state.selectedMidi) updateSampleEditor();
  }
  renderFileBin();
}

async function normalizeAllEntries(): Promise<void> {
  const btn = document.getElementById('file-bin-normalize-all');
  if (btn) btn.textContent = 'Working…';
  for (const entry of importedFiles) {
    if (entry.audioBuffer) await normalizeEntry(entry);
  }
  if (btn) btn.textContent = 'Normalize';
}

// Reverse lookup: imported-file id -> assigned MIDI note (if any)
function midiForFile(fileId: number): number | null {
  for (const [midi, id] of slotAssignments) if (id === fileId) return midi;
  return null;
}

// ============================================
// PERSISTENCE HELPERS
// ============================================

function persistSession() {
  // Changes that reach here represent user edits — mark dirty unless we're in a clean restore
  markDirty();
  const instrumentName =
    (document.getElementById('instrument-name') as HTMLInputElement)?.value ?? '';
  saveState({
    assignments: Array.from(slotAssignments.entries()),
    autoAssigned: Array.from(autoAssigned),
    instrumentName,
    nextFileId,
    fileRootMidi: importedFiles.map((f) => ({ id: f.id, rootMidi: f.mapping.rootMidi, detectedRootMidi: f.detectedRootMidi })),
    fileTrims: importedFiles.map((f) => ({ id: f.id, trimStart: f.trimStart, trimEnd: f.trimEnd })),
    fileNormalized: importedFiles.map((f) => ({ id: f.id, normalized: f.normalized })),
    slotDuration,
    slotDurationLocked,
    exportChannels,
  }).catch(console.warn);
}

async function restoreSession() {
  const [persistedFiles, persistedState] = await Promise.all([
    loadAllFiles(),
    loadState(),
  ]);
  if (!persistedState && persistedFiles.length === 0) return;

  // Restore instrument name
  const input = document.getElementById('instrument-name') as HTMLInputElement;
  if (persistedState?.instrumentName) {
    if (input) input.value = persistedState.instrumentName;
  } else if (input && !input.value) {
    input.value = 'Untitled';
  }

  // Restore nextFileId
  if (persistedState?.nextFileId) nextFileId = persistedState.nextFileId;

  // Sort files by id so order is preserved
  persistedFiles.sort((a, b) => a.id - b.id);

  const rootMidiById = new Map<number, number | null>();
  const detectedRootMidiById = new Map<number, number | null>();
  for (const item of persistedState?.fileRootMidi ?? []) {
    rootMidiById.set(item.id, item.rootMidi);
    if ('detectedRootMidi' in item) detectedRootMidiById.set(item.id, (item as { id: number; rootMidi: number | null; detectedRootMidi: number | null }).detectedRootMidi);
  }

  // Rebuild importedFiles from stored ArrayBuffers
  for (const pf of persistedFiles) {
    const file = new File([pf.arrayBuffer], pf.name, { type: 'audio/wav' });
    const entry: ImportedFile = {
      id: pf.id,
      name: pf.name,
      file,
      mapping: {
        file,
        rootMidi: rootMidiById.get(pf.id) ?? null,
        rawName: pf.name,
        confidence: 0,
        source: 'filename',
      },
      detectedRootMidi: detectedRootMidiById.get(pf.id) ?? null,
      audioBuffer: null,
      decoding: true,
      trimStart: 0,
      trimEnd: Infinity,
      normalized: false,
    };
    importedFiles.push(entry);
    // Decode in background
    getAudioContext()
      .decodeAudioData(pf.arrayBuffer.slice(0))
      .then((buf) => {
        entry.audioBuffer = buf;
        // Re-apply normalization if it was active in the saved session
        if (entry.normalized) entry.audioBuffer = normalizeAudioBuffer(entry.audioBuffer);
        // Auto-expand slotDuration to the longest restored file (covers sessions without a
        // persisted slotDuration, e.g. opened in an older version)
        if (buf.duration > slotDuration) {
          slotDuration = Math.round(buf.duration * 100) / 100;
          updateLengthDisplay();
        }
        // trimEnd=Infinity means no persisted trim; keep Infinity (will be treated as buf.duration)
        if (entry.trimEnd === Infinity) {
          entry.trimEnd = buf.duration;
          // Don't re-apply auto-trim on restore (user may have adjusted manually)
        }
        entry.decoding = false;
        buildPianoRoll();
        if (midiForFile(entry.id) === state.selectedMidi) updateSampleEditor();
        renderFileBin();
      })
      .catch(() => { entry.decoding = false; renderFileBin(); });
  }

  // Restore assignments
  if (persistedState?.assignments) {
    for (const [midi, fileId] of persistedState.assignments) {
      slotAssignments.set(midi, fileId);
    }
  }
  if (persistedState?.autoAssigned) {
    for (const midi of persistedState.autoAssigned) autoAssigned.add(midi);
  }

  // Restore trim points — applied before background decode finishes so they aren't overwritten
  if (persistedState?.fileTrims) {
    for (const { id, trimStart, trimEnd } of persistedState.fileTrims as Array<{ id: number; trimStart: number; trimEnd: number }>) {
      const f = importedFiles.find((x) => x.id === id);
      if (f) { f.trimStart = trimStart; f.trimEnd = trimEnd; }
    }
  }

  // Restore normalized flags — must be set before the async decode callbacks fire
  if (persistedState?.fileNormalized) {
    for (const { id, normalized } of persistedState.fileNormalized as Array<{ id: number; normalized: boolean }>) {
      const f = importedFiles.find((x) => x.id === id);
      if (f) f.normalized = normalized;
    }
  }

  // Restore slot duration
  if (typeof persistedState?.slotDuration === 'number' && persistedState.slotDuration > 0) {
    slotDuration = persistedState.slotDuration;
    updateLengthDisplay();
  }
  // Restore lock state (default locked for old sessions without this field)
  if (typeof persistedState?.slotDurationLocked === 'boolean') {
    slotDurationLocked = persistedState.slotDurationLocked;
  }

  // Restore export settings and sync toggle UI
  if (persistedState?.exportChannels != null) {
    exportChannels = persistedState.exportChannels;
    const chInput = document.getElementById('export-channels') as HTMLInputElement | null;
    if (chInput) { chInput.checked = exportChannels === 2; chInput.dispatchEvent(new Event('change')); }
  }
  renderFileBin();
  buildPianoRoll();
  updateSampleEditor();
  // Restored from cache — not dirty yet
  markClean();
}
/**
 * Assign newly imported mappings to piano-roll slots.
 * By the time this runs the dialog has already filtered to a single layer,
 * so there is at most one candidate per MIDI note.
 * Never overwrites a slot the user assigned manually.
 */
function autoPropagate(entries: ImportedFile[]) {
  const byMidi = new Map<number, ImportedFile>();

  for (const entry of entries) {
    const m = entry.mapping;
    if (m.rootMidi == null) continue;
    if (m.rootMidi < PIANO_START || m.rootMidi > PIANO_END) continue;
    if (!byMidi.has(m.rootMidi)) byMidi.set(m.rootMidi, entry);
  }

  for (const [midi, entry] of byMidi) {
    // Don't clobber a manual assignment.
    if (slotAssignments.has(midi) && !autoAssigned.has(midi)) continue;
    slotAssignments.set(midi, entry.id);
    autoAssigned.add(midi);
  }
}

/** Remove one file from the bin (and its slot assignment if any). */
function removeFromBin(fileId: number) {
  const idx = importedFiles.findIndex((f) => f.id === fileId);
  if (idx === -1) return;

  pushUndo();
  const [removed] = importedFiles.splice(idx, 1);

  // Remove its slot assignment
  const assignedMidi = midiForFile(removed.id);
  if (assignedMidi != null) {
    slotAssignments.delete(assignedMidi);
    autoAssigned.delete(assignedMidi);
    if (assignedMidi === state.selectedMidi) stopSample();
  }

  deleteFile(removed.id).catch(console.warn);
  buildPianoRoll();
  renderFileBin();
  updateSampleEditor();
  persistSession();
}

/** Clear every file from the bin and all slot assignments. */
function clearBin() {
  if (importedFiles.length === 0 && slotAssignments.size === 0) return;

  pushUndo();
  stopSample();
  reversedBufferCache.clear();
  importedFiles.length = 0;
  slotAssignments.clear();
  autoAssigned.clear();
  clearAllFiles().catch(console.warn);
  buildPianoRoll();
  renderFileBin();
  updateSampleEditor();
  persistSession();
}

// ============================================
// FILE SAVE / LOAD  (.kb1i — KB1 Instrument)
// ============================================

interface KB1InstrumentFile {
  version: number;
  instrumentName: string;
  slotDuration: number;
  slotDurationLocked?: boolean;
  exportChannels?: number;
  nextFileId: number;
  files: Array<{
    id: number;
    name: string;
    data?: string;
    trimStart: number;
    trimEnd: number;
    normalized?: boolean;
    rootMidi?: number | null;
    detectedRootMidi?: number | null;
  }>;
  assignments: [number, number][];
  autoAssigned: number[];
}

/** Build the serialisable payload (shared by save + saveAs).
 * Version 3: self-contained fallback format.
 * Audio is embedded in the .kb1i so a saved project opens reliably even when
 * browser cache/IDB has been cleared or the file is opened on another origin.
 */
async function buildPayload(): Promise<{ payload: KB1InstrumentFile; json: string; blob: Blob }> {
  const nameEl = document.getElementById('instrument-name') as HTMLInputElement;
  const instrumentName = nameEl?.value.trim() || 'Untitled';

  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  const files: KB1InstrumentFile['files'] = await Promise.all(importedFiles.map(async (f) => {
    let data: string | undefined;
    try {
      const arrayBuffer = await f.file.arrayBuffer();
      data = arrayBufferToBase64(arrayBuffer);
    } catch (err) {
      console.warn(`Failed to embed audio for ${f.name}:`, err);
    }

    return {
      id: f.id,
      name: f.name,
      data,
      trimStart: f.trimStart,
      trimEnd: f.trimEnd,
      normalized: f.normalized,
      rootMidi: f.mapping.rootMidi,
      detectedRootMidi: f.detectedRootMidi,
    };
  }));

  const payload: KB1InstrumentFile = {
    version: 3, instrumentName, slotDuration, slotDurationLocked, exportChannels, nextFileId, files,
    assignments: Array.from(slotAssignments.entries()),
    autoAssigned: Array.from(autoAssigned),
  };

  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: 'application/json' });
  return { payload, json, blob };
}

/**
 * Save using File System Access API (native OS dialog) when available,
 * falling back to a download link.
 * Returns true on success, false if the user cancelled.
 */
async function saveInstrumentFile(): Promise<boolean> {
  const nameEl = document.getElementById('instrument-name') as HTMLInputElement;
  const instrumentName = nameEl?.value.trim() || 'Untitled';
  const { blob } = await buildPayload();

  // If we already have a handle, write silently (no dialog) — like Ctrl/Cmd+S in a desktop app
  if (currentProjectHandle) {
    try {
      const writable = await currentProjectHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      markClean();
      persistSession();
      return true;
    } catch (err: any) {
      if (err?.name === 'AbortError') return false;
      // Handle became stale (file moved/deleted) — fall through to picker
      console.warn('Existing file handle failed, showing picker:', err);
      currentProjectHandle = null;
    }
  }

  // No handle yet (first save) — show OS Save dialog
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: `${instrumentName}.kb1i`,
        types: [{ description: 'KB1 Instrument', accept: { 'application/json': ['.kb1i'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      currentProjectHandle = handle;
      const savedName = (handle.name as string).replace(/\.kb1i$/i, '');
      if (nameEl && savedName) nameEl.value = savedName;
      markClean();
      persistSession();
      return true;
    } catch (err: any) {
      if (err?.name === 'AbortError') return false;
      console.warn('showSaveFilePicker failed, falling back to download:', err);
    }
  }

  // Fallback: trigger browser download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${instrumentName.replace(/[^a-z0-9_\-. ]/gi, '_')}.kb1i`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  markClean();
  persistSession();
  return true;
}

/** Save As — always shows the OS picker regardless of whether a handle exists. */
async function saveAsInstrumentFile(): Promise<boolean> {
  currentProjectHandle = null;
  return saveInstrumentFile();
}

/**
 * Show a 3-button "unsaved changes" dialog.
 * Calls onSave, onDiscard, or onCancel depending on user choice.
 */
function showUnsavedDialog(
  onSave: () => void,
  onDiscard: () => void,
  onCancel?: () => void,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';

  const modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.addEventListener('click', (e) => e.stopPropagation());

  const msg = document.createElement('p');
  msg.className = 'confirm-message';
  msg.textContent = 'You have unsaved changes. Save before continuing?';

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';

  function dismiss() {
    overlay.remove();
    document.removeEventListener('keydown', keyHandler);
  }

  function keyHandler(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); dismiss(); onCancel?.(); }
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { dismiss(); onCancel?.(); } });
  document.addEventListener('keydown', keyHandler);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'confirm-btn-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { dismiss(); onCancel?.(); });

  const discardBtn = document.createElement('button');
  discardBtn.className = 'confirm-btn-danger';
  discardBtn.textContent = 'Discard';
  discardBtn.addEventListener('click', () => { dismiss(); onDiscard(); });

  const saveBtn = document.createElement('button');
  saveBtn.className = 'confirm-btn-primary';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => { dismiss(); onSave(); });

  actions.append(cancelBtn, discardBtn, saveBtn);
  modal.append(msg, actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => saveBtn.focus());
}

/**
 * Guard an action that would discard the current instrument.
 * If dirty: shows 3-button dialog. If clean: proceeds immediately.
 */
function guardUnsaved(proceed: () => void): void {
  if (!isDirty) { proceed(); return; }
  showUnsavedDialog(
    async () => { const saved = await saveInstrumentFile(); if (saved) proceed(); },
    () => { markClean(); proceed(); },
  );
}

async function loadInstrumentFile(file: File) {
  let payload: KB1InstrumentFile;
  try {
    const text = await file.text();
    payload = JSON.parse(text) as KB1InstrumentFile;
    if (payload.version !== 1 && payload.version !== 2 && payload.version !== 3) throw new Error('Unknown format version');
  } catch {
    alert('Could not read instrument file — it may be corrupted or an unsupported version.');
    return;
  }

  // For v2: pre-fetch audio from IDB *before* we clear it below.
  // (clearAllFiles() would wipe the very data we need to restore.)
  const idbCache = new Map<number, { arrayBuffer: ArrayBuffer; name: string }>();
  if (payload.version >= 2) {
    for (const pf of payload.files) {
      const persisted = await getFileById(pf.id);
      if (persisted) idbCache.set(pf.id, persisted);
    }
  }

  // Stop playback + reset state
  stopSample();
  importedFiles.length = 0;
  slotAssignments.clear();
  autoAssigned.clear();
  await clearAllFiles().catch(console.warn);

  // Restore scalar state
  nextFileId = payload.nextFileId ?? 1;
  slotDuration = payload.slotDuration ?? 0.0;
  slotDurationLocked = payload.slotDurationLocked !== false; // default true if not saved
  updateLengthDisplay();
  // Restore export settings and sync toggle UI
  if (payload.exportChannels != null) {
    exportChannels = payload.exportChannels;
    const chInput = document.getElementById('export-channels') as HTMLInputElement | null;
    if (chInput) { chInput.checked = exportChannels === 2; chInput.dispatchEvent(new Event('change')); }
  }
  // Sync lock button UI after restoring state
  const lockBtn = document.getElementById('duration-lock-btn');
  const lengthGroup = document.querySelector('.length-controls');
  if (lockBtn && lengthGroup) {
    if (slotDurationLocked) {
      lockBtn.title = 'Locked: all slots share one duration. Click to unlock.';
      lockBtn.setAttribute('aria-pressed', 'true');
      lockBtn.classList.add('is-locked');
      lengthGroup.classList.remove('is-unlocked');
    } else {
      lockBtn.title = 'Unlocked: each slot has its own duration. Click to lock.';
      lockBtn.setAttribute('aria-pressed', 'false');
      lockBtn.classList.remove('is-locked');
      lengthGroup.classList.add('is-unlocked');
    }
  }
  const nameEl = document.getElementById('instrument-name') as HTMLInputElement;
  // Use the OS filename so the displayed name always matches the file on disk
  const filenameBase = file.name.replace(/\.kb1i$/i, '');
  if (nameEl) nameEl.value = filenameBase || payload.instrumentName || 'Untitled';
  updateWindowTitle();

  // Reconstruct files — v2: load audio from IDB; v1 (legacy): decode from embedded base64
  const missingNames: string[] = [];
  for (const pf of payload.files) {
    let restoredFile: File;
    if (payload.version >= 2) {
      // v2: audio was pre-fetched from IDB before clearAllFiles() ran
      const persisted = idbCache.get(pf.id);
      if (persisted) {
        restoredFile = new File([persisted.arrayBuffer], pf.name);
        // Re-populate IDB after the clearAllFiles() above
        saveFile({ id: pf.id, name: pf.name, arrayBuffer: persisted.arrayBuffer }).catch(console.warn);
      } else if (pf.data) {
        // v3 fallback: decode from embedded audio data when cache is missing
        const binary = atob(pf.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        restoredFile = new File([bytes], pf.name);
        saveFile({ id: pf.id, name: pf.name, arrayBuffer: bytes.buffer }).catch(console.warn);
      } else {
        missingNames.push(pf.name);
        continue;
      }
    } else {
      // v1 legacy: audio embedded as base64
      const binary = atob(pf.data!);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      restoredFile = new File([bytes], pf.name);
      // Migrate into IDB so future saves work
      saveFile({ id: pf.id, name: pf.name, arrayBuffer: bytes.buffer }).catch(console.warn);
    }
    const entry: ImportedFile = {
      id: pf.id, name: pf.name, file: restoredFile,
      mapping: {
        file: restoredFile,
        rootMidi: pf.rootMidi ?? null,
        rawName: pf.name,
        confidence: 0,
        source: 'filename' as const,
      },
      detectedRootMidi: (pf as { detectedRootMidi?: number | null }).detectedRootMidi ?? null,
      audioBuffer: null, decoding: true,
      trimStart: pf.trimStart ?? 0, trimEnd: pf.trimEnd ?? Infinity,
      normalized: pf.normalized ?? false,
    };
    importedFiles.push(entry);
    decodeEntry(entry);
  }

  if (missingNames.length > 0) {
    console.warn('Missing audio files (not in IDB):', missingNames);
    // Non-fatal: project metadata loads, slots show as empty for missing files
  }

  for (const [midi, id] of payload.assignments) slotAssignments.set(midi, id);
  for (const midi of payload.autoAssigned) autoAssigned.add(midi);

  markClean();
  persistSession();

  renderFileBin();
  buildPianoRoll();
  updateSampleEditor();
}

function newInstrument() {
  stopSample();
  importedFiles.length = 0;
  slotAssignments.clear();
  autoAssigned.clear();
  nextFileId = 1;
  slotDuration = 0.0;
  slotDurationLocked = true;
  exportChannels = 2;
  currentProjectHandle = null;
  updateLengthDisplay();
  // Sync export toggles back to defaults
  const chInput = document.getElementById('export-channels') as HTMLInputElement | null;
  if (chInput) { chInput.checked = true; chInput.dispatchEvent(new Event('change')); }
  clearAllFiles().catch(console.warn);
  const nameEl = document.getElementById('instrument-name') as HTMLInputElement;
  if (nameEl) nameEl.value = 'Untitled';
  state.selectedMidi = NO_SELECTION;
  markClean();
  buildPianoRoll();
  renderFileBin();
  updateSampleEditor();
  persistSession();
}

function updateStereoAutoDetect(): void {
  const chInput = document.getElementById('export-channels') as HTMLInputElement | null;
  if (!chInput) return;
  const wrapper = chInput.closest('.toolbar-toggle') as HTMLElement | null;
  const chLabel = wrapper?.querySelector('.toolbar-label');

  const decoded = importedFiles.filter(f => f.audioBuffer != null);
  if (decoded.length === 0) {
    // No decoded files yet — re-enable toggle, restore stereo default
    chInput.disabled = false;
    wrapper?.classList.remove('is-disabled');
    if (!chInput.checked) {
      chInput.checked = true;
      exportChannels = 2;
      wrapper?.classList.add('is-on');
      if (chLabel) chLabel.textContent = 'Stereo';
      updateExportSize();
    }
    return;
  }

  const allMono = decoded.every(f => f.audioBuffer!.numberOfChannels === 1);
  if (allMono) {
    // Force mono and lock the toggle
    chInput.disabled = true;
    wrapper?.classList.add('is-disabled');
    if (chInput.checked) {
      chInput.checked = false;
      exportChannels = 1;
      wrapper?.classList.remove('is-on');
      if (chLabel) chLabel.textContent = 'Mono';
      updateExportSize();
      buildPianoRoll({ skipAutoCenter: true });
      updateSampleEditor();
    }
  } else {
    // At least one stereo file — unlock and ensure stereo is selected
    chInput.disabled = false;
    wrapper?.classList.remove('is-disabled');
    if (!chInput.checked) {
      chInput.checked = true;
      exportChannels = 2;
      wrapper?.classList.add('is-on');
      if (chLabel) chLabel.textContent = 'Stereo';
      updateExportSize();
      buildPianoRoll({ skipAutoCenter: true });
      updateSampleEditor();
    }
  }
}

function renderFileBin() {
  const list = document.getElementById('file-bin-list');
  const count = document.getElementById('file-bin-count');
  const clearAllBtn = document.getElementById('file-bin-clear-all');
  if (!list) return;

  if (count) count.textContent = String(importedFiles.length);
  const hasFiles = importedFiles.length > 0;
  if (clearAllBtn) clearAllBtn.style.display = hasFiles ? 'flex' : 'none';

  updateExportSize(); // keep size display in sync with assignment changes
  updateStereoAutoDetect();

  list.innerHTML = '';

  if (importedFiles.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'file-bin-empty';
    empty.textContent = 'Import audio files to populate the bin';
    list.appendChild(empty);
    return;
  }

  // Reverse lookup: file id -> assigned MIDI note (for the slot marker)
  const idToMidi = new Map<number, number>();
  slotAssignments.forEach((fileId, midi) => idToMidi.set(fileId, midi));

  // If a key/slot is selected, highlight its mapped bin file.
  // Otherwise, keep the last explicit file-bin click highlighted.
  const mappedFromSelectedMidi =
    state.selectedMidi !== NO_SELECTION
      ? (slotAssignments.get(state.selectedMidi) ?? null)
      : null;
  const activeBinFileId = mappedFromSelectedMidi ?? selectedBinFileId;

  for (const f of importedFiles) {
    const item = document.createElement('li');
    const assignedMidi = idToMidi.get(f.id);
    const isSelected = f.id === activeBinFileId;
    item.className =
      'file-bin-item'
      + (assignedMidi != null ? ' assigned' : '')
      + (isSelected ? ' selected' : '');
    item.draggable = true;
    item.dataset.fileId = String(f.id);
    item.title = f.name;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-bin-name';
    nameSpan.textContent = f.name;
    item.appendChild(nameSpan);

    if (assignedMidi != null) {
      const slotSpan = document.createElement('span');
      slotSpan.className = 'file-bin-slot';
      slotSpan.textContent = midiToName(assignedMidi);
      item.appendChild(slotSpan);
    }

    // Normalize button (↑) — appears on hover via CSS
    const normalizeBtn = document.createElement('button');
    normalizeBtn.className = 'file-bin-normalize';
    normalizeBtn.textContent = '↑';
    normalizeBtn.title = 'Normalize to peak (-1 dBFS)';
    normalizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      normalizeEntry(f);
    });
    item.appendChild(normalizeBtn);

    // Remove button (×) — appears on hover via CSS
    const removeBtn = document.createElement('button');
    removeBtn.className = 'file-bin-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove from bin';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromBin(f.id);
    });
    item.appendChild(removeBtn);

    item.addEventListener('dragstart', (e) => {
      item.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', String(f.id));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));

    // Click a file to jump to its assigned slot (if any)
    item.addEventListener('click', () => {
      selectedBinFileId = f.id;
      if (assignedMidi != null) selectKey(assignedMidi);
      else renderFileBin();
    });

    list.appendChild(item);
  }

  // When selection came from a key/slot click, scroll the highlighted bin item into view.
  if (mappedFromSelectedMidi != null) {
    const selectedItem = list.querySelector('.file-bin-item.selected') as HTMLElement | null;
    selectedItem?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// Wire a mini-waveform slot as a drop target for bin files
function attachSlotDropHandlers(slot: HTMLElement, midi: number) {
  slot.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    slot.classList.add('drag-over');
  });

  slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));

  // Right-click: context menu
  slot.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // Focus the right-clicked slot if not already part of the selection
    if (!selectedSlots.has(midi)) {
      selectedSlots.clear();
      selectionAnchor = midi;
      selectKey(midi, false);
    } else {
      state.selectedMidi = midi;
      updateSampleEditor();
    }
    showContextMenu(e as MouseEvent, midi);
  });

  slot.addEventListener('drop', (e) => {
    e.preventDefault();
    slot.classList.remove('drag-over');
    const fileId = Number(e.dataTransfer?.getData('text/plain'));
    if (!fileId || !importedFiles.some((f) => f.id === fileId)) return;

    // Manual override: assign this file to this slot and lock it from auto-propagation.
    pushUndo();
    slotAssignments.set(midi, fileId);
    autoAssigned.delete(midi);
    state.selectedMidi = midi;
    buildPianoRoll();
    renderFileBin();
    updateSampleEditor();
    persistSession();
  });
}

// ============================================
// DETAILED WAVEFORM (placeholder stereo)
// ============================================

function drawDetailedWaveform(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  const w = rect.width;
  const h = rect.height;

  ctx.fillStyle = getComputedStyle(document.documentElement)
    .getPropertyValue('--bg-secondary')
    .trim();
  ctx.fillRect(0, 0, w, h);

  const buffer = fileForMidi(state.selectedMidi)?.audioBuffer ?? null;

  if (buffer) {
    const { viewStart, viewEnd } = getWaveView(buffer.duration);
    const sr = buffer.sampleRate;
    const sStart = Math.floor(viewStart * sr);
    const sEnd = Math.min(buffer.length, Math.ceil(viewEnd * sr));
    const showStereo = exportChannels === 2 && buffer.numberOfChannels >= 2;
    if (showStereo) {
      drawRealChannel(ctx, buffer.getChannelData(0), w, h * 0.28, h * 0.22, sStart, sEnd);
      drawRealChannel(ctx, buffer.getChannelData(1), w, h * 0.72, h * 0.22, sStart, sEnd);
    } else {
      // Mono view: average channels for display
      const mono = buildMonoData(buffer);
      drawRealChannel(ctx, mono, w, h * 0.5, h * 0.42, sStart, sEnd);
    }
    return;
  }

  // Placeholder when no sample assigned
  drawChannel(ctx, w, h * 0.28, h * 0.22);
  drawChannel(ctx, w, h * 0.72, h * 0.22);
}

/** Draw real min/max peaks of one channel as a filled envelope.
 * sStart/sEnd are sample indices into data — allows rendering a sub-range (for zoom). */
function drawRealChannel(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  w: number,
  centerY: number,
  maxAmp: number,
  sStart = 0,
  sEnd = data.length,
) {
  const totalSamples = Math.max(1, sEnd - sStart);
  const step = Math.max(1, totalSamples / w);
  ctx.fillStyle = '#9a9a9a';
  for (let x = 0; x < w; x++) {
    const si = Math.floor(sStart + x * step);
    const ei = Math.min(data.length, Math.ceil(sStart + (x + 1) * step));
    let min = 1.0;
    let max = -1.0;
    for (let i = si; i < ei; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const yMax = centerY - max * maxAmp;
    const yMin = centerY - min * maxAmp;
    ctx.fillRect(x, yMax, 1, Math.max(1, yMin - yMax));
  }
}

function drawChannel(ctx: CanvasRenderingContext2D, w: number, centerY: number, maxAmp: number) {
  ctx.strokeStyle = '#9a9a9a';
  ctx.lineWidth = 1;
  ctx.beginPath();

  const samples = 600;
  for (let i = 0; i < samples; i++) {
    const x = (i / samples) * w;
    const t = i / samples;
    const env = Math.exp(-t * 3); // decaying tail
    const amp = (Math.sin(i * 0.3) * 0.5 + Math.sin(i * 1.7) * 0.5) * env * maxAmp;
    const y = centerY + amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ============================================
// ZOOM CONTROL
// ============================================

// ============================================
// ZOOM BAR (pinch-zoom scrub bar)
// ============================================

// Module-level flag to suppress scroll sync while the zoom bar is dragging
let zoomBarActive = false;

function updateZoomBarThumb() {
  const track = document.getElementById('zoom-bar-track');
  const thumb = document.getElementById('zoom-bar-thumb');
  const scroll = document.getElementById('piano-roll-scroll') as HTMLElement | null;
  const hint = document.getElementById('zoom-hint');
  if (!track || !thumb || !scroll) return;

  const thumbFrac = 1 / state.zoom;  // visible fraction of total roll width
  const maxScroll = scroll.scrollWidth - scroll.clientWidth;
  const scrollFrac = maxScroll > 0 ? scroll.scrollLeft / maxScroll : 0;
  const leftFrac = scrollFrac * (1 - thumbFrac);

  thumb.style.width = `${thumbFrac * 100}%`;
  thumb.style.left = `${leftFrac * 100}%`;

  if (hint) hint.textContent = state.zoom === 1 ? '1×' : `${state.zoom.toFixed(1)}×`;
}

function initZoomBar() {
  const track = document.getElementById('zoom-bar-track') as HTMLElement | null;
  const thumb = document.getElementById('zoom-bar-thumb') as HTMLElement | null;
  const leftHandle = document.getElementById('zoom-bar-left') as HTMLElement | null;
  const rightHandle = document.getElementById('zoom-bar-right') as HTMLElement | null;
  const scroll = document.getElementById('piano-roll-scroll') as HTMLElement | null;
  if (!track || !thumb || !leftHandle || !rightHandle || !scroll) return;

  // After the guard above, these are definitely non-null; cast to satisfy TS closures
  const trackEl = track as HTMLElement;
  const thumbEl = thumb as HTMLElement;
  const scrollEl = scroll as HTMLElement;

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 2;
  const MIN_THUMB_FRAC = 1 / MAX_ZOOM; // = 0.5

  type DragType = 'body' | 'left' | 'right';
  let dragType: DragType | null = null;
  let dragStartX = 0;
  let dragStartLeftFrac = 0;
  let dragStartRightFrac = 0;

  /** Derive thumb bounds from current state */
  function getBounds(): { lb: number; rb: number } {
    const thumbFrac = 1 / state.zoom;
    const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
    const scrollFrac = maxScroll > 0 ? scrollEl.scrollLeft / maxScroll : 0;
    const lb = scrollFrac * (1 - thumbFrac);
    return { lb, rb: lb + thumbFrac };
  }

  /** Apply bounds → update state.zoom + scroll */
  function applyBounds(lb: number, rb: number) {
    let left = Math.max(0, lb);
    let right = Math.min(1, rb);
    const thumbFrac = right - left;
    if (thumbFrac < MIN_THUMB_FRAC) {
      // clamp: anchor the side that didn't move
      if (lb === left) right = left + MIN_THUMB_FRAC;
      else left = right - MIN_THUMB_FRAC;
    }
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, 1 / (right - left)));
    state.zoom = newZoom;

    thumbEl.style.left = `${left * 100}%`;
    thumbEl.style.width = `${(right - left) * 100}%`;

    // Rebuild roll (no auto-center) then set scroll from left bound
    buildPianoRoll({ skipAutoCenter: true });
    requestAnimationFrame(() => {
      const maxS = scrollEl.scrollWidth - scrollEl.clientWidth;
      const thumbW = 1 / newZoom;
      const scrollFrac = (1 - thumbW) > 0 ? left / (1 - thumbW) : 0;
      scrollEl.scrollLeft = scrollFrac * maxS;
      updateZoomBarThumb();
    });
  }

  function startDrag(e: MouseEvent, type: DragType) {
    e.preventDefault();
    e.stopPropagation();
    zoomBarActive = true;
    dragType = type;
    dragStartX = e.clientX;
    const { lb, rb } = getBounds();
    dragStartLeftFrac = lb;
    dragStartRightFrac = rb;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onMove(e: MouseEvent) {
    if (!dragType) return;
    const dFrac = (e.clientX - dragStartX) / trackEl.clientWidth;
    if (dragType === 'body') {
      const thumbFrac = dragStartRightFrac - dragStartLeftFrac;
      const newLeft = Math.max(0, Math.min(1 - thumbFrac, dragStartLeftFrac + dFrac));
      applyBounds(newLeft, newLeft + thumbFrac);
    } else if (dragType === 'left') {
      const newLeft = Math.max(0, Math.min(dragStartRightFrac - MIN_THUMB_FRAC, dragStartLeftFrac + dFrac));
      applyBounds(newLeft, dragStartRightFrac);
    } else {
      const newRight = Math.min(1, Math.max(dragStartLeftFrac + MIN_THUMB_FRAC, dragStartRightFrac + dFrac));
      applyBounds(dragStartLeftFrac, newRight);
    }
  }

  function onUp() {
    dragType = null;
    zoomBarActive = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }

  const bodyEl = thumbEl.querySelector('.zoom-bar-body') as HTMLElement;
  bodyEl?.addEventListener('mousedown', (e) => startDrag(e as MouseEvent, 'body'));
  leftHandle.addEventListener('mousedown', (e) => startDrag(e, 'left'));
  rightHandle.addEventListener('mousedown', (e) => startDrag(e, 'right'));

  // Keep thumb in sync when user scrolls the piano roll directly
  scrollEl.addEventListener('scroll', () => {
    if (!zoomBarActive) updateZoomBarThumb();
  });

  // Double-click anywhere on the track (or thumb) to reset zoom to 1×
  trackEl.addEventListener('dblclick', () => {
    applyBounds(0, 1);
  });

  // Scroll wheel on the piano roll: plain = zoom centered on cursor, Shift = pan
  // k=0.0005 calibrated so ~180° of wheel rotation covers the full 1×–2× range
  scrollEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { lb, rb } = getBounds();
    const thumbFrac = rb - lb;
    if (e.shiftKey) {
      // Shift+scroll = horizontal pan
      const delta = (e.deltaY / 500) * thumbFrac;
      const newLeft = Math.max(0, Math.min(1 - thumbFrac, lb + delta));
      applyBounds(newLeft, newLeft + thumbFrac);
    } else {
      // Plain scroll = zoom centered on cursor
      const factor = Math.exp(e.deltaY * 0.0005); // scroll down = zoom out
      const newThumbFrac = Math.max(MIN_THUMB_FRAC, Math.min(1, thumbFrac * factor));
      const rect = scrollEl.getBoundingClientRect();
      const mouseXFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const pivotFrac = lb + mouseXFrac * thumbFrac;
      const newLb = Math.max(0, Math.min(1 - newThumbFrac, pivotFrac - mouseXFrac * newThumbFrac));
      applyBounds(newLb, newLb + newThumbFrac);
    }
  }, { passive: false });

  updateZoomBarThumb();
}

// ============================================
// WAVEFORM ZOOM BAR (sample editor)
// ============================================

function updateWaveformZoomBarThumb() {
  const thumb = document.getElementById('waveform-zoom-thumb');
  if (!thumb) return;
  const thumbFrac = 1 / waveformZoom;
  thumb.style.width = `${thumbFrac * 100}%`;
  thumb.style.left = `${waveformScrollFrac * 100}%`;
}

function initWaveformZoomBar() {
  const track = document.getElementById('waveform-zoom-track') as HTMLElement | null;
  const thumb = document.getElementById('waveform-zoom-thumb') as HTMLElement | null;
  if (!track || !thumb) return;

  const trackEl = track;
  const thumbEl = thumb;

  const MAX_ZOOM = 20;
  const MIN_THUMB_FRAC = 1 / MAX_ZOOM;

  type DragType = 'body' | 'left' | 'right';
  let dragType: DragType | null = null;
  let dragStartX = 0;
  let dragStartLb = 0;
  let dragStartRb = 0;

  function getBounds(): { lb: number; rb: number } {
    const thumbFrac = 1 / waveformZoom;
    return { lb: waveformScrollFrac, rb: waveformScrollFrac + thumbFrac };
  }

  function applyBounds(lb: number, rb: number) {
    let left = Math.max(0, lb);
    let right = Math.min(1, rb);
    const thumbFrac = right - left;
    if (thumbFrac < MIN_THUMB_FRAC) {
      if (lb === left) right = left + MIN_THUMB_FRAC;
      else left = right - MIN_THUMB_FRAC;
    }
    left = Math.max(0, left);
    right = Math.min(1, right);
    waveformZoom = Math.max(1, Math.min(MAX_ZOOM, 1 / (right - left)));
    waveformScrollFrac = left;
    updateWaveformZoomBarThumb();
    updateSampleEditor();
  }

  function startDrag(e: MouseEvent, type: DragType) {
    e.preventDefault();
    e.stopPropagation();
    dragType = type;
    dragStartX = e.clientX;
    const { lb, rb } = getBounds();
    dragStartLb = lb;
    dragStartRb = rb;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onMove(e: MouseEvent) {
    if (!dragType) return;
    const dFrac = (e.clientX - dragStartX) / trackEl.clientWidth;
    if (dragType === 'body') {
      const thumbFrac = dragStartRb - dragStartLb;
      const newLeft = Math.max(0, Math.min(1 - thumbFrac, dragStartLb + dFrac));
      applyBounds(newLeft, newLeft + thumbFrac);
    } else if (dragType === 'left') {
      const newLeft = Math.max(0, Math.min(dragStartRb - MIN_THUMB_FRAC, dragStartLb + dFrac));
      applyBounds(newLeft, dragStartRb);
    } else {
      const newRight = Math.min(1, Math.max(dragStartLb + MIN_THUMB_FRAC, dragStartRb + dFrac));
      applyBounds(dragStartLb, newRight);
    }
  }

  function onUp() {
    dragType = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }

  const bodyEl = thumbEl.querySelector('.zoom-bar-body') as HTMLElement | null;
  bodyEl?.addEventListener('mousedown', (e) => startDrag(e as MouseEvent, 'body'));

  const leftHandleEl = thumbEl.querySelector('.zoom-bar-handle:first-child') as HTMLElement | null;
  const rightHandleEl = thumbEl.querySelector('.zoom-bar-handle:last-child') as HTMLElement | null;
  leftHandleEl?.addEventListener('mousedown', (e) => startDrag(e, 'left'));
  rightHandleEl?.addEventListener('mousedown', (e) => startDrag(e, 'right'));

  // Scroll-wheel on the track for fine horizontal scroll
  trackEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { lb, rb } = getBounds();
    const thumbFrac = rb - lb;
    const delta = (e.deltaY / 500) * thumbFrac;
    const newLeft = Math.max(0, Math.min(1 - thumbFrac, lb + delta));
    applyBounds(newLeft, newLeft + thumbFrac);
  }, { passive: false });

  // Double-click track to reset to 1×, scroll to start
  trackEl.addEventListener('dblclick', () => {
    waveformZoom = 1;
    waveformScrollFrac = 0;
    updateWaveformZoomBarThumb();
    updateSampleEditor();
  });

  // Scroll wheel on the waveform canvas: plain = zoom centered on cursor, Shift = pan
  // k=0.002 calibrated so ~180° of wheel rotation covers the full 1×–20× range
  const canvasEl = document.getElementById('sample-waveform') as HTMLElement | null;
  canvasEl?.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { lb, rb } = getBounds();
    const thumbFrac = rb - lb;
    if (e.shiftKey) {
      // Shift+scroll = horizontal pan
      const delta = (e.deltaY / 500) * thumbFrac;
      const newLeft = Math.max(0, Math.min(1 - thumbFrac, lb + delta));
      applyBounds(newLeft, newLeft + thumbFrac);
    } else {
      // Plain scroll = zoom centered on cursor
      const factor = Math.exp(e.deltaY * 0.002); // scroll down = zoom out
      const newThumbFrac = Math.max(MIN_THUMB_FRAC, Math.min(1, thumbFrac * factor));
      const rect = canvasEl.getBoundingClientRect();
      const mouseXFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const pivotFrac = lb + mouseXFrac * thumbFrac;
      const newLb = Math.max(0, Math.min(1 - newThumbFrac, pivotFrac - mouseXFrac * newThumbFrac));
      applyBounds(newLb, newLb + newThumbFrac);
    }
  }, { passive: false });

  updateWaveformZoomBarThumb();
}

// ============================================
// OCTAVE CONTROL
// ============================================

function initOctaveControl() {
  const downBtn = document.getElementById('octave-down');
  const upBtn = document.getElementById('octave-up');
  const display = document.getElementById('octave-display');

  function update() {
    if (display) {
      const v = state.octaveOffset;
      display.textContent = v > 0 ? `+${v}` : String(v);
    }
    buildPianoRoll();
  }

  downBtn?.addEventListener('click', () => {
    if (state.octaveOffset > -2) {
      state.octaveOffset--;
      update();
    }
  });

  upBtn?.addEventListener('click', () => {
    if (state.octaveOffset < 2) {
      state.octaveOffset++;
      update();
    }
  });
}

// ============================================
// TRANSPORT CONTROLS (placeholder)
// ============================================

// ============================================
// PLAYBACK ENGINE
// ============================================

let currentSource: AudioBufferSourceNode | null = null;
let playStartCtxTime = 0;   // AudioContext time when playback began
let playOffset = 0;         // seconds into the buffer where playback started
let playRafId = 0;
let stoppedManually = false;

// Scrub state — separate from the main playback source so they don't interfere
let scrubNode: AudioBufferSourceNode | null = null;
let lastScrubTime = 0;
const SCRUB_SNIPPET_S = 0.08;           // 80 ms snippets
const SCRUB_THROTTLE_MS = 80;           // max one scrub per 80 ms

// Lazily-created reversed buffers (keyed by file id); built once, reused
const reversedBufferCache = new Map<number, AudioBuffer>();

/** Update the play button icon to reflect current playback state. */
function updatePlayBtn() {
  const btn = document.getElementById('transport-play');
  if (!btn) return;
  if (currentSource) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
    btn.title = 'Pause';
  } else {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    btn.title = 'Play';
  }
}

/**
 * Play a short 80 ms scrub snippet at `timeSeconds` in the current entry's buffer.
 * Throttled so at most one snippet per SCRUB_THROTTLE_MS fires.
 * Reuses the already-decoded AudioBuffer — zero extra memory or decoding cost.
 */
function scrubPlayAt(timeSeconds: number) {
  const entry = fileForMidi(state.selectedMidi);
  if (!entry?.audioBuffer) return;

  const now = performance.now();
  if (now - lastScrubTime < SCRUB_THROTTLE_MS) return;
  lastScrubTime = now;

  // Stop the previous snippet before starting a new one
  if (scrubNode) {
    try { scrubNode.stop(); } catch { /* already ended */ }
    scrubNode.disconnect();
    scrubNode = null;
  }

  const buf = entry.audioBuffer;
  const offset = Math.max(0, Math.min(buf.duration - SCRUB_SNIPPET_S, timeSeconds));
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.connect(ctx.destination);
  node.start(0, offset, SCRUB_SNIPPET_S);
  node.onended = () => { if (scrubNode === node) scrubNode = null; };
  scrubNode = node;
}

/** Stop any in-flight scrub snippet. */
function stopScrub() {
  if (scrubNode) {
    try { scrubNode.stop(); } catch { /* already ended */ }
    scrubNode.disconnect();
    scrubNode = null;
  }
}

/**
 * Return a reversed copy of entry.audioBuffer, creating and caching it on first call.
 * Building is O(n) CPU / O(n) memory — for sub-5 s clips this is negligible.
 */
function getReversedBuffer(entry: ImportedFile): AudioBuffer | null {
  if (!entry.audioBuffer) return null;
  const cached = reversedBufferCache.get(entry.id);
  if (cached) return cached;

  const src = entry.audioBuffer;
  const ctx = getAudioContext();
  const rev = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const srcData = src.getChannelData(c);
    const revData = rev.getChannelData(c);
    for (let i = 0; i < src.length; i++) revData[i] = srcData[src.length - 1 - i];
  }
  reversedBufferCache.set(entry.id, rev);
  return rev;
}

/** Play the current slot's active region in reverse. */
function playSampleReverse() {
  const entry = fileForMidi(state.selectedMidi);
  if (!entry?.audioBuffer) return;
  stopScrub();
  stopSource();

  const revBuf = getReversedBuffer(entry);
  if (!revBuf) return;

  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  const dur = entry.audioBuffer.duration;
  const trimStart = entry.trimStart ?? 0;
  const trimEnd = Math.min(entry.trimEnd === Infinity ? dur : entry.trimEnd, dur);

  // Mirror the trim region into the reversed buffer:
  // original [trimStart, trimEnd] → reversed [dur - trimEnd, dur - trimStart]
  const revOffset = dur - trimEnd;
  const revDuration = trimEnd - trimStart;

  const source = ctx.createBufferSource();
  source.buffer = revBuf;
  source.connect(ctx.destination);
  source.start(0, revOffset, revDuration);

  currentSource = source;
  playStartCtxTime = ctx.currentTime;
  playOffset = trimEnd;
  stoppedManually = false;

  source.onended = () => {
    if (stoppedManually) return;
    currentSource = null;
    playOffset = trimStart;
    cancelAnimationFrame(playRafId);
    setPlayheadFraction(trimStart / dur);
    updatePlayBtn();
  };

  // Playhead counts down from trimEnd to trimStart
  const animateReverse = () => {
    if (!currentSource) return;
    const elapsed = ctx.currentTime - playStartCtxTime;
    const pos = trimEnd - elapsed;
    setPlayheadFraction(Math.max(trimStart, pos) / dur);
    if (pos > trimStart) playRafId = requestAnimationFrame(animateReverse);
  };
  playRafId = requestAnimationFrame(animateReverse);
  updatePlayBtn();
}

function playSample(fromOffset = playOffset) {
  const entry = fileForMidi(state.selectedMidi);
  const buffer = entry?.audioBuffer ?? null;
  if (!buffer) return;

  stopSource(); // clear any existing source without resetting offset

  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);

  // Apply trim bounds
  const trimStart = entry?.trimStart ?? 0;
  const trimEnd = Math.min(entry?.trimEnd === Infinity ? buffer.duration : (entry?.trimEnd ?? buffer.duration), buffer.duration);
  const offset = Math.min(Math.max(trimStart, fromOffset), trimEnd - 0.001);
  const duration = trimEnd - offset;
  source.start(0, offset, Math.max(0, duration));

  currentSource = source;
  playStartCtxTime = ctx.currentTime;
  playOffset = offset;
  stoppedManually = false;

  source.onended = () => {
    if (stoppedManually) return; // handled by stop/pause
    currentSource = null;
    playOffset = trimStart; // reset to trim start, not buffer start
    cancelAnimationFrame(playRafId);
    setPlayheadFraction(trimStart / buffer.duration);
    updatePlayBtn();
  };

  animatePlayhead(buffer.duration);
  updatePlayBtn();
}

/** Stop the active source node without altering playOffset. */
function stopSource() {
  if (currentSource) {
    stoppedManually = true;
    try {
      currentSource.onended = null;
      currentSource.stop();
    } catch {
      /* already stopped */
    }
    currentSource = null;
  }
  cancelAnimationFrame(playRafId);
}

function pauseSample() {
  if (!currentSource) return;
  const ctx = getAudioContext();
  const elapsed = ctx.currentTime - playStartCtxTime;
  playOffset = playOffset + elapsed;
  stopSource();
  updatePlayBtn();
}

function stopSample() {
  stopSource();
  const entry = fileForMidi(state.selectedMidi);
  const trimStart = entry?.trimStart ?? 0;
  const dur = entry?.audioBuffer?.duration ?? 1;
  playOffset = trimStart;
  setPlayheadFraction(trimStart / dur);
  updatePlayBtn();
}

function animatePlayhead(duration: number) {
  const ctx = getAudioContext();
  const tick = () => {
    if (!currentSource) return;
    const elapsed = ctx.currentTime - playStartCtxTime;
    const pos = playOffset + elapsed;
    setPlayheadFraction(Math.min(1, pos / duration));
    if (pos < duration) {
      playRafId = requestAnimationFrame(tick);
    }
  };
  playRafId = requestAnimationFrame(tick);
}

function setPlayheadFraction(fraction: number) {
  const playhead = document.getElementById('playhead');
  const frame = document.querySelector('.sample-waveform-frame') as HTMLElement;
  if (!playhead || !frame) return;
  // Map a full-buffer fraction (0–1) to screen position through the zoom window
  const entry = fileForMidi(state.selectedMidi);
  const dur = entry?.audioBuffer?.duration ?? 1;
  const { viewStart, viewDur } = getWaveView(dur);
  const screenFrac = ((fraction * dur) - viewStart) / viewDur;
  if (screenFrac < 0 || screenFrac > 1) {
    playhead.style.display = 'none';
  } else {
    playhead.style.display = '';
    playhead.style.left = `${screenFrac * frame.clientWidth}px`;
  }
}

// ============================================
// TRANSPORT CONTROLS
// ============================================

function initTransportControls() {
  // Play button toggles play/pause
  document.getElementById('transport-play')?.addEventListener('click', () => {
    if (currentSource) pauseSample();
    else playSample();
  });
  document.getElementById('transport-prev')?.addEventListener('click', () => {
    selectPrevKey();
  });
  document.getElementById('transport-next')?.addEventListener('click', () => {
    selectNextKey();
  });
}

function initExportControls() {
  const chInput = document.getElementById('export-channels') as HTMLInputElement | null;

  const chLabel = chInput?.closest('.toolbar-toggle')?.querySelector('.toolbar-label');

  function syncToggle(input: HTMLInputElement, label: Element | null | undefined, onText: string, offText: string) {
    input.closest('.toolbar-toggle')?.classList.toggle('is-on', input.checked);
    if (label) label.textContent = input.checked ? onText : offText;
  }

  chInput?.addEventListener('change', () => {
    exportChannels = chInput.checked ? 2 : 1;
    syncToggle(chInput, chLabel, 'Stereo', 'Mono');
    updateExportSize();
    // Redraw waveforms in both the piano roll and trim editor to reflect stereo/mono mode
    buildPianoRoll({ skipAutoCenter: true });
    updateSampleEditor();
  });
  syncToggle(chInput!, chLabel, 'Stereo', 'Mono');
}

function selectPrevKey() {
  if (state.selectedMidi > PIANO_START) selectKey(state.selectedMidi - 1);
}

function selectNextKey() {
  if (state.selectedMidi < PIANO_END) selectKey(state.selectedMidi + 1);
}

// ============================================
// PLAYHEAD DRAGGING (placeholder)
// ============================================

function initPlayhead() {
  const playhead = document.getElementById('playhead');
  const frame = document.querySelector('.sample-waveform-frame') as HTMLElement;
  if (!playhead || !frame) return;

  let dragging = false;

  const movePlayhead = (clientX: number) => {
    const rect = frame.getBoundingClientRect();
    let x = clientX - rect.left;
    x = Math.max(0, Math.min(rect.width, x));
    playhead.style.left = `${x}px`;
    // Sync the playback offset — zoom-aware so scrubbing works at any zoom level
    const entry = fileForMidi(state.selectedMidi);
    const buf = entry?.audioBuffer;
    if (buf && rect.width > 0) {
      const screenFrac = x / rect.width;
      const { viewStart, viewDur } = getWaveView(buf.duration);
      playOffset = Math.max(0, Math.min(buf.duration, viewStart + screenFrac * viewDur));
      scrubPlayAt(playOffset);
    }
  };

  playhead.addEventListener('mousedown', (e) => {
    stopSource();
    dragging = true;
    e.preventDefault();
  });

  frame.addEventListener('mousedown', (e) => {
    stopSource();
    movePlayhead(e.clientX);
    dragging = true;
  });

  window.addEventListener('mousemove', (e) => {
    if (dragging) movePlayhead(e.clientX);
  });

  window.addEventListener('mouseup', () => {
    if (dragging) stopScrub();
    dragging = false;
  });
}

// ============================================
// CLEAR / REMOVE ASSIGNMENT
// ============================================

/** Remove the sample assigned to a slot (right-click on a slot or its key). */
function clearSlot(midi: number) {
  if (!slotAssignments.has(midi)) return;
  slotAssignments.delete(midi);
  autoAssigned.delete(midi);
  if (midi === state.selectedMidi) {
    stopSample();
  }
  buildPianoRoll();
  renderFileBin();
  updateSampleEditor();
  persistSession();
}

// ============================================
// TAB NAVIGATION
// ============================================

function initTabNavigation() {
  const tabButtons = document.querySelectorAll('.nav-tab');
  const tabContents = document.querySelectorAll('.tab-content');
  const instrumentSidebarContent = document.getElementById('instrument-sidebar-content');
  const flashSidebarContent = document.getElementById('flash-sidebar-content');

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const tabName = button.getAttribute('data-tab');

      tabButtons.forEach((btn) => btn.classList.remove('active'));
      button.classList.add('active');

      tabContents.forEach((content) => content.classList.remove('active'));
      const activeContent = document.getElementById(`tab-${tabName}`);
      if (activeContent) activeContent.classList.add('active');

      if (instrumentSidebarContent && flashSidebarContent) {
        if (tabName === 'instrument') {
          instrumentSidebarContent.classList.remove('hidden');
          flashSidebarContent.classList.add('hidden');
          // Force reflow so canvas/JS-sized elements recalculate after display:flex
          requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
        } else if (tabName === 'flash') {
          instrumentSidebarContent.classList.add('hidden');
          flashSidebarContent.classList.remove('hidden');
        }
      }
    });
  });
}

// ============================================
// FLASH SIDEBAR SECTION NAVIGATION
// ============================================

function initFlashSidebarNav() {
  const sidebarBtns = document.querySelectorAll<HTMLElement>('.flash-sidebar-btn[data-section]');
  const sections = document.querySelectorAll<HTMLElement>('.flash-section');
  const sectionTitle = document.getElementById('flash-section-title');

  const sectionMeta: Record<string, { title: string }> = {
    update: { title: 'Firmware Update' },
    info: { title: 'Device Info' },
    serial: { title: 'Serial Monitor' },
  };

  sidebarBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const sectionName = btn.getAttribute('data-section')!;

      sidebarBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      sections.forEach((s) => s.classList.remove('active'));
      const target = document.getElementById(`flash-section-${sectionName}`);
      if (target) target.classList.add('active');

      // Update header title and help button
      const meta = sectionMeta[sectionName];
      if (meta && sectionTitle) sectionTitle.textContent = meta.title;
    });
  });
}

// ============================================
// BROWSER COMPATIBILITY
// ============================================

function checkBrowserCompatibility() {
  const warning = document.getElementById('browser-warning');
  if (!warning) return;
  const hasSerialAPI = 'serial' in navigator;
  const hasAudioContext = 'AudioContext' in window || 'webkitAudioContext' in window;
  if (!hasSerialAPI || !hasAudioContext) warning.classList.remove('hidden');
}

// ============================================
// INITIALIZATION
// ============================================

// ============================================
// KEYBOARD SHORTCUTS
// ============================================

/**
 * JKL transport shortcuts (standard video/audio editing conventions):
 *   J = reverse play      K = pause      L = play forward
 *   Space = play / pause toggle
 */
/**
 * Step the waveform zoom by a factor.
 * factor > 1 = zoom out (show more), factor < 1 = zoom in (show less).
 * Zooms centered on the current view midpoint.
 */
function stepWaveformZoom(factor: number) {
  const MAX_ZOOM = 20;
  const MIN_THUMB_FRAC = 1 / MAX_ZOOM;
  const thumbFrac = 1 / waveformZoom;
  const midFrac = waveformScrollFrac + thumbFrac / 2;
  const newThumbFrac = Math.max(MIN_THUMB_FRAC, Math.min(1, thumbFrac * factor));
  const newLb = Math.max(0, Math.min(1 - newThumbFrac, midFrac - newThumbFrac / 2));
  waveformZoom = Math.max(1, Math.min(MAX_ZOOM, 1 / newThumbFrac));
  waveformScrollFrac = newLb;
  updateWaveformZoomBarThumb();
  updateSampleEditor();
}

/**
 * Step the piano roll zoom by a factor.
 * factor > 1 = zoom out (show more), factor < 1 = zoom in (show less).
 */
function stepPianoRollZoom(factor: number) {
  const MIN_ZOOM = 1, MAX_ZOOM = 2;
  const thumbFrac = 1 / state.zoom;
  const newThumbFrac = Math.max(1 / MAX_ZOOM, Math.min(1, thumbFrac * factor));
  state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, 1 / newThumbFrac));
  buildPianoRoll();
  updateZoomBarThumb();
}

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Don't fire when the user is typing in an input or textarea
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (currentSource) pauseSample();
        else playSample();
        break;
      case 'l':
      case 'L':
        e.preventDefault();
        playSample();
        break;
      case 'k':
      case 'K':
        e.preventDefault();
        if (currentSource) pauseSample();
        break;
      case 'j':
      case 'J':
        e.preventDefault();
        playSampleReverse();
        break;
      case '=':
      case '+':
        if (!e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          if (activeZoomPanel === 'pianoroll') stepPianoRollZoom(1 / 1.5);
          else stepWaveformZoom(1 / 1.5);
        }
        break;
      case '-':
      case '_':
        if (!e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          if (activeZoomPanel === 'pianoroll') stepPianoRollZoom(1.5);
          else stepWaveformZoom(1.5);
        }
        break;
      case 's':
      case 'S':
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          if (e.shiftKey) saveAsInstrumentFile();
          else saveInstrumentFile();
        }
        break;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  console.log('KB1 Studio initializing...');

  checkBrowserCompatibility();
  initTabNavigation();
  initFlashSidebarNav();
  initFlashTools();
  initZoomBar();
  initWaveformZoomBar();
  initOctaveControl();
  initTransportControls();
  initKeyboardShortcuts();
  initPlayhead();
  initTrimHandles();
  initLengthControl();
  initDurationLockToggle();
  initExportControls();
  initImport();
  initImportBinOnly();
  initFileDrop();
  initExportBtn();
  initSelectionHandlers();
  initResizers();
  initActivePanels();
  initSlipStrip();

  // Wire clear-all button
  document.getElementById('file-bin-clear-all')?.addEventListener('click', clearBin);

  // Wire normalize-all button
  document.getElementById('file-bin-normalize-all')?.addEventListener('click', normalizeAllEntries);

  // Flash About modal
  const flashAboutOverlay = document.getElementById('flash-about-overlay');
  document.getElementById('flash-about-btn')?.addEventListener('click', () => {
    flashAboutOverlay?.classList.remove('hidden');
  });
  document.getElementById('flash-about-close')?.addEventListener('click', () => {
    flashAboutOverlay?.classList.add('hidden');
  });
  flashAboutOverlay?.addEventListener('click', (e) => {
    if (e.target === flashAboutOverlay) flashAboutOverlay.classList.add('hidden');
  });

  // Instrument builder — About modal
  const aboutOverlay = document.getElementById('instrument-about-overlay');
  document.getElementById('instrument-about-btn')?.addEventListener('click', () => {
    aboutOverlay?.classList.remove('hidden');
  });
  document.getElementById('instrument-about-close')?.addEventListener('click', () => {
    aboutOverlay?.classList.add('hidden');
  });
  aboutOverlay?.addEventListener('click', (e) => {
    if (e.target === aboutOverlay) aboutOverlay.classList.add('hidden');
  });

  // Instrument name → update window title + mark dirty
  document.getElementById('instrument-name')?.addEventListener('input', () => {
    persistSession();
    updateWindowTitle();
  });

  // Save (Cmd+S equivalent in the file menu)
  document.getElementById('save-btn')?.addEventListener('click', () => saveInstrumentFile());

  // Save As — always opens picker
  document.getElementById('save-as-btn')?.addEventListener('click', () => saveAsInstrumentFile());

  // Load Instrument — guard unsaved, then open file picker
  const loadInput = document.getElementById('load-instrument-input') as HTMLInputElement | null;
  document.getElementById('load-instrument-btn')?.addEventListener('click', () => {
    guardUnsaved(() => loadInput?.click());
  });
  loadInput?.addEventListener('change', async () => {
    if (!loadInput.files?.length) return;
    await loadInstrumentFile(loadInput.files[0]);
    loadInput.value = '';
  });

  // New Instrument — guard unsaved changes
  document.getElementById('new-instrument-btn')?.addEventListener('click', () => {
    guardUnsaved(newInstrument);
  });

  // Warn before closing/refreshing with unsaved changes
  window.addEventListener('beforeunload', (e) => {
    if (isDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  buildPianoRoll();
  updateSampleEditor();
  renderFileBin();

  // Restore previous session from IndexedDB
  restoreSession().catch(console.warn);

  // PWA File Handling API — fires when user opens a .kb1i file from the OS
  if ('launchQueue' in window) {
    (window as any).launchQueue.setConsumer(async (launchParams: any) => {
      if (!launchParams.files?.length) return;
      const fileHandle = launchParams.files[0];
      const file = await fileHandle.getFile();
      if (file.name.endsWith('.kb1i')) {
        guardUnsaved(() => loadInstrumentFile(file));
      }
    });
  }

  console.log('KB1 Studio ready!');
});

// ============================================
// RESIZABLE PANELS
// ============================================

function initResizers() {
  // --- Vertical resizer: piano-roll-panel (top) ↕ editor-row (bottom) ---
  const resizerV = document.getElementById('resizer-v');
  const pianoPanel = document.querySelector('.piano-roll-panel') as HTMLElement;
  const editorRow = document.querySelector('.editor-row') as HTMLElement;
  const tabContent = document.getElementById('tab-instrument') as HTMLElement;

  if (resizerV && pianoPanel && editorRow && tabContent) {
    let dragging = false;
    let startY = 0;
    let startPianoH = 0;
    let totalH = 0;

    resizerV.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startPianoH = pianoPanel.getBoundingClientRect().height;
      totalH = tabContent.getBoundingClientRect().height - resizerV.getBoundingClientRect().height;
      resizerV.classList.add('dragging');
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const delta = e.clientY - startY;
      const newH = Math.min(Math.max(120, startPianoH + delta), totalH - 120);
      pianoPanel.style.height = `${newH}px`;
      pianoPanel.style.flexShrink = '0';
      pianoPanel.style.flexGrow = '0';
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      resizerV.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Redraw canvases after resize
      updateSampleEditor();
      buildPianoRoll();
    });
  }

  // --- Horizontal resizer: file-bin (left) ↔ sample-editor (right) ---
  const resizerH = document.getElementById('resizer-h');
  const fileBin = document.querySelector('.file-bin') as HTMLElement;
  const samplePanel = document.querySelector('.sample-editor-panel') as HTMLElement;

  if (resizerH && fileBin && samplePanel) {
    let dragging = false;
    let startX = 0;
    let startBinW = 0;

    resizerH.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startBinW = fileBin.getBoundingClientRect().width;
      resizerH.classList.add('dragging');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      const parentW = (fileBin.parentElement as HTMLElement).getBoundingClientRect().width;
      const newW = Math.min(Math.max(160, startBinW + delta), parentW - 200);
      fileBin.style.width = `${newW}px`;
      fileBin.style.flexShrink = '0';
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      resizerH.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      updateSampleEditor();
    });
  }
}

// ============================================
// ACTIVE PANEL HIGHLIGHT
// ============================================

function initActivePanels() {
  const panels = [
    document.querySelector('.piano-roll-panel'),
    document.querySelector('.file-bin'),
    document.querySelector('.sample-editor-panel'),
  ].filter(Boolean) as HTMLElement[];

  // Track which panel the mouse is in for - / = keyboard zoom
  const pianoPanel = document.querySelector('.piano-roll-panel') as HTMLElement | null;
  const editorPanel = document.querySelector('.sample-editor-panel') as HTMLElement | null;
  pianoPanel?.addEventListener('mouseenter', () => { activeZoomPanel = 'pianoroll'; });
  editorPanel?.addEventListener('mouseenter', () => { activeZoomPanel = 'waveform'; });

  panels.forEach((panel) => {
    panel.addEventListener('mousedown', () => {
      panels.forEach((p) => p.classList.remove('panel-active'));
      panel.classList.add('panel-active');
    });
  });
}

window.addEventListener('resize', () => {
  updateSampleEditor();
  buildPianoRoll({ skipAutoCenter: true });
});

// Scroll the selected key into view on load
window.addEventListener('load', () => {
  const scroll = document.getElementById('piano-roll-scroll');
  const selected = document.querySelector('.pkey.selected') as HTMLElement;
  if (scroll && selected) {
    scroll.scrollLeft = selected.offsetLeft - scroll.clientWidth / 2;
  }
});
