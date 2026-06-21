/**
 * PTI Beat-Slice export for Polyend Tracker / Tracker Mini / Tracker+
 *
 * Pipeline:
 *  1. Render each assigned slot's trimmed region to Int16 PCM (44.1 kHz)
 *  2. Concatenate, recording raw frame offset for each slot
 *  3. Normalise slice offsets: Math.round(rawOffset / totalFrames * 65535)
 *  4. Build a standard interleaved WAV with `wavefile`
 *  5. Create PTI instrument via tracker-lib, set BeatSlice playmode + metadata
 *  6. writeInstrument() triggers browser file-save automatically
 *
 * Stereo note: PTI stores L-then-R de-interleaved, but tracker-lib accepts a
 * normal interleaved WAV and handles the de-interleaving internally.
 */

import Tracker, {
    InstrumentPlayMode,
    MAX_16BIT,
    SAMPLE_RATE,
} from '@polyend/tracker-lib';
import { WaveFile } from 'wavefile';

export interface SlotAudio {
    audioBuffer: AudioBuffer; // Web Audio API decoded buffer
    trimStart: number;        // seconds
    trimEnd: number;          // seconds (should already be resolved, not Infinity)
    name: string;
}

export interface ExportOptions {
    channels: 1 | 2;       // 1 = mono, 2 = stereo
    bitDepth: 16;          // PTI bitdepth field valid range is 4–16; 8-bit rejected by Tracker Mini
    instrumentName: string; // max 32 chars (PTI filename field)
}

/**
 * Render a Web Audio AudioBuffer region to an interleaved signed Int16Array.
 * Handles mono→stereo upmix and stereo→mono downmix automatically.
 */
function renderToInt16(
    buf: AudioBuffer,
    trimStart: number,
    trimEnd: number,
    targetChannels: 1 | 2,
): Int16Array {
    const srcRate = buf.sampleRate;
    const startFr = Math.round(trimStart * srcRate);
    const endFr = Math.min(Math.round(trimEnd * srcRate), buf.length);
    const frameCount = Math.max(0, endFr - startFr);
    const srcCh = buf.numberOfChannels;
    const out = new Int16Array(frameCount * targetChannels);

    for (let f = 0; f < frameCount; f++) {
        if (targetChannels === 1) {
            let sum = 0;
            for (let c = 0; c < srcCh; c++) sum += buf.getChannelData(c)[startFr + f]!;
            const v = Math.round((sum / srcCh) * 32767);
            out[f] = Math.max(-32768, Math.min(32767, v));
        } else {
            const L = buf.getChannelData(0)[startFr + f]!;
            const R = srcCh > 1 ? buf.getChannelData(1)[startFr + f]! : L;
            out[f * 2] = Math.max(-32768, Math.min(32767, Math.round(L * 32767)));
            out[f * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(R * 32767)));
        }
    }
    return out;
}

/**
 * Build and download a .pti Beat-Slice instrument from an ordered slot list.
 *
 * @param slots  Ordered array (MIDI-note ascending) of assigned slot audio
 * @param opts   Export options: channels, bitDepth, instrumentName
 */
export async function exportToPti(
    slots: SlotAudio[],
    opts: ExportOptions,
): Promise<Uint8Array> {
    if (slots.length === 0) throw new Error('No slots to export.');
    if (slots.length > 48) throw new Error('Maximum 48 slices supported by PTI format.');

    const { channels, bitDepth, instrumentName } = opts;

    // --- 1. Render each slot to Int16 PCM, track frame offsets -----------------
    const rendered: Int16Array[] = [];
    const rawOffsets: number[] = [];   // frame offset of each slot in the final audio
    let totalFrames = 0;

    for (const slot of slots) {
        const pcm = renderToInt16(slot.audioBuffer, slot.trimStart, slot.trimEnd, channels);
        rawOffsets.push(totalFrames);
        rendered.push(pcm);
        totalFrames += pcm.length / channels; // frame count (not sample count)
    }

    // --- 2. Concatenate all slots -----------------------------------------------
    const totalSamples = rendered.reduce((s, r) => s + r.length, 0);
    const allPcm = new Int16Array(totalSamples);
    let pos = 0;
    for (const pcm of rendered) { allPcm.set(pcm, pos); pos += pcm.length; }

    // --- 3. Normalise slice offsets: 0-65535 over the full sample ---------------
    // MAX_16BIT = 65535 (from @polyend/tracker-lib)
    const normSlices = rawOffsets.map((o) => Math.round((o / totalFrames) * MAX_16BIT));

    // --- 4. Build WAV using wavefile (handles bit-depth reduction) --------------
    // Web Audio AudioBuffer is already at its native sample rate; if it differs
    // from 44100 we need to resample. For files decoded via Web Audio API in a
    // 44100 Hz AudioContext the rate will already be 44100.
    const wav = new WaveFile();
    wav.fromScratch(channels, SAMPLE_RATE, '16', allPcm);
    const wavBuffer = (wav.toBuffer() as Uint8Array).buffer as ArrayBuffer;

    // --- 5. Create PTI instrument -----------------------------------------------
    const instrument = Tracker.createInstrument(wavBuffer, normSlices);
    instrument.playmode = InstrumentPlayMode.BeatSlice;
    instrument.numSlices = slots.length;   // how many slices are active
    instrument.selectedSlice = 0;
    instrument.bitdepth = bitDepth;
    instrument.sample.channels = channels;
    instrument.sample.filename = instrumentName.slice(0, 32);

    // --- 6. Extract raw PTI bytes by intercepting the internal anchor-download -
    // tracker-lib's exports map blocks deep imports, so we temporarily suppress
    // the auto-click and capture the Blob that writeInstrument creates.
    return interceptWriteInstrument(instrument, instrumentName);
}

/**
 * Calls Tracker.writeInstrument but intercepts the internal Blob before the
 * anchor-download fires, returning the raw bytes instead.
 */
async function interceptWriteInstrument(
    instrument: ReturnType<typeof Tracker.createInstrument>,
    filename: string,
): Promise<Uint8Array> {
    let capturedBlob: Blob | null = null;

    // Intercept URL.createObjectURL to grab the Blob reference
    const origCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
        if (object instanceof Blob) capturedBlob = object;
        return origCreateObjectURL(object); // still create a real URL (safe to revoke later)
    };

    // Suppress the anchor .click() so no download fires automatically
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { /* suppressed */ };

    try {
        const safeName = filename.replace(/[/\\:*?"<>|]/g, '_').slice(0, 32);
        await Tracker.writeInstrument(instrument, `${safeName}.pti`);
    } finally {
        URL.createObjectURL = origCreateObjectURL;
        HTMLAnchorElement.prototype.click = origClick;
    }

    if (!capturedBlob) throw new Error('tracker-lib writeInstrument did not produce a Blob');
    return new Uint8Array(await (capturedBlob as Blob).arrayBuffer());
}

/**
 * Prompt the user with an OS Save dialog and write the PTI bytes to the chosen
 * file. Falls back to a standard anchor-download if the File System Access API
 * is unavailable (Firefox, older Safari).
 *
 * @param bytes         Raw PTI bytes to write
 * @param suggestedName Instrument name used as the suggested filename (no extension)
 * @param startIn       Optional FileSystemFileHandle from the project save — opens
 *                      the dialog in the same folder so PTI lands next to the project
 */
export async function savePtiFile(
    bytes: Uint8Array,
    suggestedName: string,
    startIn?: FileSystemFileHandle,
): Promise<void> {
    // Strip OS-illegal chars; PTI filename field is 32 chars but the OS filename
    // can be longer — we only truncate the PTI metadata field, not the OS filename.
    const safeName = suggestedName.replace(/[/\\:*?"<>|]/g, '_');
    const name = `${safeName}.pti`;

    // showSaveFilePicker is available in Chrome/Edge 86+ and Safari 16.4+
    if ('showSaveFilePicker' in window) {
        const opts: Record<string, unknown> = {
            suggestedName: name,
            types: [{
                description: 'Polyend Tracker Instrument',
                accept: { 'application/octet-stream': ['.pti'] },
            }],
        };
        // Opens dialog in the same folder as the saved project file
        if (startIn) opts.startIn = startIn;
        const handle = await (window as any).showSaveFilePicker(opts);
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
    } else {
        // Fallback: anchor-based download
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
    }
}
