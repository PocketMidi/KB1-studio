# KB1 Studio Libraries Reference

## Core Dependencies

### @polyend/tracker-lib
**Purpose:** Polyend Tracker .pti file manipulation (instrument creation/editing)

**Current Version:** 0.1.1 (as of June 2026)

**⚠️ ALWAYS CHECK FOR UPDATES:**
- NPM: https://www.npmjs.com/package/@polyend/tracker-lib
- Docs: https://polyend.github.io/tracker-lib/
- Run: `npm view @polyend/tracker-lib versions --json`

**Key API:**
- `InstrumentData` interface - NO `baseNote` property (use padding strategy)
- `tune` (-24 to +24 semitones)
- `finetune` (-100 to +100 cents)
- `numSlices` (0-47), `slices` array (48 positions)
- `playmode`: chromatic vs sliced

### wavesurfer.js
**Purpose:** Waveform visualization for beat slicer

**Current Version:** 7.8.0 (as of June 2026)

**⚠️ ALWAYS CHECK FOR UPDATES:**
- NPM: https://www.npmjs.com/package/wavesurfer.js
- Docs: https://wavesurfer.xyz/
- Run: `npm view wavesurfer.js versions --json`

### esptool-js
**Purpose:** ESP32 firmware flashing via Web Serial API

**Current Version:** 0.4.0 (inherited from kb1-flash)

**⚠️ ALWAYS CHECK FOR UPDATES:**
- NPM: https://www.npmjs.com/package/esptool-js
- Run: `npm view esptool-js versions --json`

## Version Update Workflow

**Before starting new features:**
```bash
cd /Volumes/Oyen2TB/xGIT_KB1/KB1/kb1-studio

# Check all dependency versions
npm view @polyend/tracker-lib versions --json
npm view wavesurfer.js versions --json
npm view esptool-js versions --json

# Update package.json if needed
npm install @polyend/tracker-lib@latest
npm install wavesurfer.js@latest
npm install esptool-js@latest
```

**After updates:**
- Test firmware flashing (esptool-js)
- Test .pti export (tracker-lib)
- Test waveform display (wavesurfer.js)

## Known Issues & Workarounds

### tracker-lib Limitations (v0.1.1)
- **No `baseNote` property** - Cannot set chromatic starting note via API
- **Workaround:** Insert 11 empty slices before content to shift from C-3 (MIDI 48) to B3 (MIDI 59)

### Tracker Middle C Setting
- User's setting: C-4 (MIDI 60)
- Tracker range: C-3 to C-6 configurable
- **Solution:** Add UI for user's Tracker middle C preference

## Architecture Decisions

### KB1 Range
- Physical keys: 19 keys
- MIDI range: B3-F5 (MIDI 59-77 absolute)
- Chromatic: All 19 keys playable
- Sliced: Distribute slices across available keys

### Padding Strategy
KB1 starts at B3 (MIDI 59), Tracker chromatic starts at C-3 (MIDI 48):
- Gap: 11 semitones
- Solution: Insert 11 empty slices at positions 0-10
- Real content starts at slice 11 (maps to B3/MIDI 59)

### Octave Range Calculation
**Tracker slice limit: 48 slices (0-47)**

Chromatic mapping from C-3 (MIDI 48):
- **Slices 0-10:** MIDI 48-58 (C-3 to A#3) - ~1 octave below KB1
- **Slices 11-29:** MIDI 59-77 (B3 to F5) - **KB1 CORE RANGE** (19 keys)
- **Slices 30-47:** MIDI 78-95 (F#5 to B6) - ~1.5 octaves above KB1

**Total playable range:** C-3 to B6 (48 notes, 4 octaves)

**User can map samples to:**
- KB1 only (19 slices, 11-29) + padding (11 empty slices)
- Extended range (all 48 slices for full keyboard coverage)
- Octave offset adjustments (shift entire mapping up/down)

### Tool Structure
- **Primary:** Instrument Builder (melodic chromatic mode)
- **Secondary:** Beat Slicer (mode within Instrument Builder, drums)
- **Legacy:** Flash tools (integrated as tab)

## Polyend Tracker Constraints

### Memory Limits
- **Max slices:** 48 per instrument
- **Project memory:** ~100 MB total
- **Practical .pti size:** 10-30 MB recommended
- **Sliced mode optimization:** Designed for short drum samples (0.5-2s)

### Melodic Instrument Challenges
**Problem:** Long sustained samples × 19-48 keys = Large memory footprint

**Example file sizes (uncompressed WAV):**
```
Short samples (0.5s):  ~0.5 MB per note × 19 = ~10 MB
Medium samples (3s):   ~3 MB per note × 19 = ~57 MB ⚠️
Long samples (6s):     ~6 MB per note × 19 = ~114 MB ❌
```

**Solutions implemented:**
1. Automatic tail trimming (5-6s max with fade-out)
2. Silence detection and trimming
3. Mono conversion option (50% size reduction)
4. Sample rate options (22.05kHz = 50% size)
5. Bit depth reduction (16-bit standard)

### Audio Optimization Strategies

#### 1. Tail Trimming (CRITICAL for melodic)
**Design:**
- User sets max sample length: 5-6 seconds recommended
- Auto-detect release tail start (RMS threshold)
- Apply exponential fade-out over last 500ms-1s
- Preserve attack/sustain, trim only release tail

**Implementation:**
```typescript
interface TrimSettings {
  maxLength: number;        // 5-6 seconds for melodic
  fadeOutDuration: number;  // 500-1000ms
  silenceThreshold: number; // -60dB RMS
  preserveAttack: boolean;  // Always true
}
```

#### 2. Silence Trimming
- Detect leading silence (< -60dB for 50ms)
- Detect trailing silence after fade-out
- Preserve 10-20ms padding for clean playback

#### 3. File Size Calculator
Show before export:
```
19 samples detected
Average length: 4.2s (after trimming)
Format: 44.1kHz, 16-bit, mono
Estimated .pti size: 12.4 MB ✓
```

#### 4. Compression Options
**Lossless (always apply):**
- Trim silence (start/end)
- Normalize to -3dB (prevent clipping)
- Fade-out tail trimming

**Optional (quality tradeoff):**
- Convert stereo → mono (50% reduction)
- Downsample 44.1kHz → 22.05kHz (50% reduction, acceptable for bass-heavy)
- 24-bit → 16-bit (33% reduction, imperceptible)

**Never apply (breaks .pti):**
- MP3/OGG compression (not compatible)
- FLAC compression (not standard for Tracker)

## Sample State Management

### Architecture for Editable Mapping
**Key principle:** Import once, adjust mapping without reimport

```typescript
interface ImportedSample {
  file: File;                    // Original file reference
  audioBuffer: AudioBuffer;      // Decoded once, cached
  fileName: string;              // "rhodes_A#0_hard.wav"
  
  // Auto-detected metadata
  detectedNote: string;          // "A#0" parsed from filename
  detectedMidiNote: number;      // 58 (absolute)
  velocityLayer: string;         // "hard", "soft", "med", "pp", "ff"
  
  // Audio analysis
  duration: number;              // Original duration
  trimmedDuration: number;       // After tail trim
  silenceStart: number;          // Leading silence (ms)
  silenceEnd: number;            // Trailing silence (ms)
  peakLevel: number;             // Peak amplitude
  rmsLevel: number;              // Average RMS
}

interface InstrumentState {
  samples: ImportedSample[];              // All imported samples
  octaveOffset: number;                   // -2, -1, 0, +1, +2
  selectedVelocityLayer: string;          // Which layer to use
  trackerMiddleC: 'C-3' | 'C-4' | 'C-5' | 'C-6'; // User's Tracker setting
  
  // Optimization settings
  trimSettings: TrimSettings;
  convertToMono: boolean;
  targetSampleRate: 44100 | 22050;
  targetBitDepth: 16 | 24;
}
```

**User workflow:**
1. Import WAV folder → Decode all, cache AudioBuffers
2. Adjust octave offset → Recalculate mapping (no reimport)
3. Change velocity layer → Filter samples (no reimport)
4. Adjust trim settings → Preview size estimate
5. Export → Apply optimizations to cached audio

### Filename Parsing Patterns

**Auto-detect note names:**
- Standard: `C4`, `C#4`, `Db4`, `c4`, `c-4`
- Flat notation: `Bb3`, `Ab2`
- Sharp notation: `A#3`, `F#5`
- Octave formats: `C4`, `C-4`, `C_4`

**Auto-detect velocity layers:**
- Short: `pp`, `p`, `mf`, `f`, `ff`
- Full: `soft`, `medium`, `hard`, `loud`
- Numeric: `vel64`, `vel96`, `vel127`
- Variants: `bite`, `release`, `staccato`, `sustain`

**Auto-detect round robin:**
- Formats: `RR1`, `RR2`, `rr1`, `round1`
- Strategy: Merge round robins (average or pick RR1)

**Example matches:**
```
✓ rhodes_A#0_hard.wav      → A#0, hard
✓ piano_C4_pp_RR1.wav      → C4, pp (pianissimo)
✓ bass_Db2_medium.wav      → Db2, medium
✓ synth_vel96_F#5.wav      → F#5, vel96
✓ kick_C3.wav              → C3, (no velocity)
```

## Design Priorities

### For Melodic Instruments (Primary Use Case)
1. **Tail trimming is MANDATORY** - Default 5-6s max
2. **File size warnings** - Alert if >30 MB
3. **Fade-out quality** - Exponential, musical fade
4. **Preview before export** - Play trimmed samples
5. **Octave range flexibility** - Easy offset adjustment

### For Drum Instruments (Secondary)
1. **No tail trimming needed** - Samples naturally short
2. **Fast import/export** - Optimized workflow
3. **Waveform visualization** - Beat Slicer mode
4. **Auto-slice detection** - Transient analysis

## Last Updated
June 17, 2026 - Added memory constraints, tail trimming design, octave range calculations
