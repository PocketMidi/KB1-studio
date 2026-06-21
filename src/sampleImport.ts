// KB1 Studio - Sample Import Layer
// Extensible provider pattern so new library formats can be added without
// rebuilding the parser. Everything normalizes to a single SampleMapping shape.
//
// Providers (priority order):
//   1. SfzImportProvider      - parses an .sfz mapping file (key/vel ranges)
//   2. FilenameImportProvider - heuristic parse of audio filenames
//
// Future providers (DecentSampler .dspreset, mapping.json, Kontakt, etc.) only
// need to implement ImportProvider and emit SampleMapping[].

// ============================================
// CORE TYPES
// ============================================

/** A single source-agnostic sample placement descriptor. */
export interface SampleMapping {
    file: File;                 // the audio file
    rootMidi: number | null;    // detected root note (scientific pitch: C4 = MIDI 60)
    loMidi?: number;            // optional key-range low (SFZ lokey)
    hiMidi?: number;            // optional key-range high (SFZ hikey)
    velLayer?: string;          // 'f', 'p', 'hard', 'soft', 'vel96', ...
    velLo?: number;             // SFZ lovel (0-127)
    velHi?: number;             // SFZ hivel (0-127)
    articulation?: string;      // 'release', 'bite', 'staccato', 'sustain', ...
    roundRobin?: number;        // round-robin index if detected
    groupIndex?: number;        // numeric filename prefix (ordering hint)
    rawName: string;            // original filename
    confidence: number;         // 0..1 confidence in rootMidi
    source: 'filename' | 'sfz'; // where the mapping came from
}

/** A pluggable import strategy. */
export interface ImportProvider {
    name: string;
    /** Returns true if this provider should handle the given file set. */
    canHandle(files: File[]): boolean;
    /** Parse the files into normalized mappings. */
    parse(files: File[]): Promise<SampleMapping[]>;
}

// ============================================
// NOTE NAME -> MIDI (scientific pitch, C4 = 60)
// ============================================

const NOTE_SEMITONES: Record<string, number> = {
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

// Matches a note token: letter + optional accidental + optional separator + octave.
// Examples: A#5, C4, Db3, C-1, C#-1, C#_4, C# 4
// We require an octave number so stray letters (e.g. "v1", "RT") never match.
const NOTE_TOKEN = /([A-Ga-g])([#bs]?)[_\s]?(-?\d+)/g;

/**
 * Convert a note name like "A#5", "Db3", "F#0", "C-1" to a MIDI number.
 * Uses scientific pitch notation where C4 = 60.
 * Returns null if it cannot be parsed.
 */
export function noteNameToMidi(name: string): number | null {
    const m = /^([A-Ga-g])([#bs]?)[_\s]?(-?\d+)$/.exec(name.trim());
    if (!m) return null;
    return tokenToMidi(m[1], m[2], m[3]);
}

function tokenToMidi(letter: string, accidental: string, octaveStr: string): number | null {
    const base = NOTE_SEMITONES[letter.toUpperCase()];
    if (base === undefined) return null;
    let semitone = base;
    if (accidental === '#' || accidental.toLowerCase() === 's') semitone += 1;
    else if (accidental === 'b') semitone -= 1;
    const octave = parseInt(octaveStr, 10);
    // C4 = 60  ->  midi = (octave + 1) * 12 + semitone
    const midi = (octave + 1) * 12 + semitone;
    if (midi < 0 || midi > 127) return null;
    return midi;
}

/**
 * Find the LAST note token inside an arbitrary string (most libraries place the
 * note near the end of the filename). Returns the MIDI value or null.
 */
export function findNoteInName(name: string): number | null {
    // Normalize common note+layer compact forms before scanning for notes.
    // Examples:
    //   A0v01  -> A0
    //   D#1v16 -> D#1
    // Keeps plain note tokens (A0, C#4, etc.) unchanged.
    const normalized = name.replace(/([A-Ga-g][#bs]?[_\s]?-?\d+)v\d{1,3}\b/g, '$1');

    NOTE_TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    let last: number | null = null;
    while ((match = NOTE_TOKEN.exec(normalized)) !== null) {
        const midi = tokenToMidi(match[1], match[2], match[3]);
        if (midi !== null) last = midi;
    }
    return last;
}

// ============================================
// TOKEN CLASSIFICATION (velocity / articulation / RR)
// ============================================

const VELOCITY_TOKENS = new Set([
    'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff',
    'soft', 'medium', 'med', 'hard', 'loud',
]);

const ARTICULATION_TOKENS = new Set([
    'release', 'rt', 'bite', 'staccato', 'stac', 'sustain', 'sus', 'legato', 'mute',
]);

function splitTokens(stem: string): string[] {
    return stem.split(/[\s_\-.]+/).filter(Boolean);
}

// ============================================
// FILENAME PROVIDER
// ============================================

export const FilenameImportProvider: ImportProvider = {
    name: 'filename',

    canHandle(files: File[]): boolean {
        return files.some((f) => isAudioFile(f.name));
    },

    async parse(files: File[]): Promise<SampleMapping[]> {
        return files
            .filter((f) => isAudioFile(f.name))
            .map((f) => parseFilename(f));
    },
};

function parseFilename(file: File): SampleMapping {
    const rawName = file.name;
    const stem = rawName.replace(/\.[^.]+$/, '');
    const tokens = splitTokens(stem);

    const rootMidi = findNoteInName(stem);

    let velLayer: string | undefined;
    let articulation: string | undefined;
    let roundRobin: number | undefined;
    let groupIndex: number | undefined;

    // Leading numeric prefix => ordering/group hint (e.g. "01_rhodes_...")
    const firstNum = /^(\d+)/.exec(stem);
    if (firstNum) groupIndex = parseInt(firstNum[1], 10);

    for (const raw of tokens) {
        const t = raw.toLowerCase();

        if (VELOCITY_TOKENS.has(t)) {
            velLayer = t;
            continue;
        }
        // vel96 / v96 numeric velocity
        const velNum = /^v(?:el)?(\d{1,3})$/.exec(t);
        if (velNum) {
            velLayer = `vel${velNum[1]}`;
            continue;
        }
        // compact form glued to note token, e.g. A0v01 / D#1v16
        const noteVelNum = /^[a-g][#bs]?[_\s]?-?\d+v(\d{1,3})$/i.exec(raw);
        if (noteVelNum) {
            velLayer = `vel${noteVelNum[1]}`;
            continue;
        }
        // dyn1/dyn2/... style used by some piano libraries
        const dynNum = /^dyn(\d{1,2})$/.exec(t);
        if (dynNum) {
            velLayer = `dyn${dynNum[1]}`;
            continue;
        }
        if (ARTICULATION_TOKENS.has(t)) {
            // RT and 'release' both mean a release-trigger sample
            articulation = t === 'rt' ? 'release' : t;
            continue;
        }
        const rr = /^(?:rr|round)(\d+)$/.exec(t);
        if (rr) {
            roundRobin = parseInt(rr[1], 10);
            continue;
        }
    }

    return {
        file,
        rootMidi,
        velLayer,
        articulation,
        roundRobin,
        groupIndex,
        rawName,
        confidence: rootMidi !== null ? 0.7 : 0,
        source: 'filename',
    };
}

// ============================================
// SFZ PROVIDER (basic but functional)
// ============================================

export const SfzImportProvider: ImportProvider = {
    name: 'sfz',

    canHandle(files: File[]): boolean {
        return files.some((f) => /\.sfz$/i.test(f.name));
    },

    async parse(files: File[]): Promise<SampleMapping[]> {
        const sfzFiles = files.filter((f) => /\.sfz$/i.test(f.name));
        const audioFiles = files.filter((f) => isAudioFile(f.name));

        // Index audio files by basename (lowercase) for sample= resolution.
        const audioByName = new Map<string, File>();
        for (const a of audioFiles) audioByName.set(basename(a.name).toLowerCase(), a);

        const mappings: SampleMapping[] = [];
        for (const sfz of sfzFiles) {
            const text = await sfz.text();
            mappings.push(...parseSfz(text, audioByName));
        }
        return mappings;
    },
};

interface SfzOpcodes {
    sample?: string;
    default_path?: string;
    key?: string;
    pitch_keycenter?: string;
    lokey?: string;
    hikey?: string;
    lovel?: string;
    hivel?: string;
}

function parseSfz(text: string, audioByName: Map<string, File>): SampleMapping[] {
    // Strip comments (// ... and /* ... */)
    const clean = text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/gm, ' ');

    // Split into header sections, tracking <global>/<group> inherited opcodes.
    const tokens = clean.split(/(<[a-zA-Z]+>)/).map((s) => s.trim());

    let globalOps: SfzOpcodes = {};
    let groupOps: SfzOpcodes = {};
    let currentHeader = '';
    const mappings: SampleMapping[] = [];

    for (const tok of tokens) {
        if (!tok) continue;
        const headerMatch = /^<([a-zA-Z]+)>$/.exec(tok);
        if (headerMatch) {
            currentHeader = headerMatch[1].toLowerCase();
            if (currentHeader === 'global') globalOps = {};
            if (currentHeader === 'group') groupOps = {};
            continue;
        }

        const ops = parseOpcodes(tok);
        if (currentHeader === 'global') {
            globalOps = { ...globalOps, ...ops };
        } else if (currentHeader === 'group') {
            groupOps = { ...groupOps, ...ops };
        } else if (currentHeader === 'region') {
            const merged: SfzOpcodes = { ...globalOps, ...groupOps, ...ops };
            const mapping = sfzRegionToMapping(merged, audioByName);
            if (mapping) mappings.push(mapping);
        }
    }
    return mappings;
}

function parseOpcodes(block: string): SfzOpcodes {
    const ops: SfzOpcodes = {};
    // opcode=value pairs; value may contain spaces (for sample paths) up to the
    // next "word=" token. Match key= then capture lazily until next key= or EOL.
    const re = /([a-zA-Z0-9_]+)=([^=]*?)(?=\s+[a-zA-Z0-9_]+=|\s*$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key in EMPTY_OPS) (ops as Record<string, string>)[key] = value;
    }
    return ops;
}

const EMPTY_OPS: Record<keyof SfzOpcodes, true> = {
    sample: true,
    default_path: true,
    key: true,
    pitch_keycenter: true,
    lokey: true,
    hikey: true,
    lovel: true,
    hivel: true,
};

function sfzRegionToMapping(
    ops: SfzOpcodes,
    audioByName: Map<string, File>,
): SampleMapping | null {
    if (!ops.sample) return null;

    // Resolve sample path to an actual provided File via basename.
    const rawPath = (ops.default_path ? ops.default_path : '') + ops.sample;
    const base = basename(rawPath.replace(/\\/g, '/')).toLowerCase();
    const file = audioByName.get(base);
    if (!file) return null; // sample not among imported files

    const root = sfzKey(ops.pitch_keycenter ?? ops.key);
    const lo = sfzKey(ops.lokey ?? ops.key);
    const hi = sfzKey(ops.hikey ?? ops.key);

    return {
        file,
        rootMidi: root,
        loMidi: lo ?? undefined,
        hiMidi: hi ?? undefined,
        velLo: ops.lovel ? parseInt(ops.lovel, 10) : undefined,
        velHi: ops.hivel ? parseInt(ops.hivel, 10) : undefined,
        rawName: file.name,
        confidence: root !== null ? 1 : 0.5,
        source: 'sfz',
    };
}

// SFZ key opcodes accept either a MIDI number (0-127) or a note name (c4, a#3).
function sfzKey(value: string | undefined): number | null {
    if (value === undefined) return null;
    const v = value.trim();
    if (/^\d+$/.test(v)) {
        const n = parseInt(v, 10);
        return n >= 0 && n <= 127 ? n : null;
    }
    return noteNameToMidi(v);
}

// ============================================
// ORCHESTRATOR
// ============================================

const PROVIDERS: ImportProvider[] = [SfzImportProvider, FilenameImportProvider];

/**
 * Parse a batch of dropped/selected files into normalized mappings using the
 * first provider that can handle them. SFZ takes priority over filename guessing.
 */
export async function importSamples(files: File[]): Promise<SampleMapping[]> {
    for (const provider of PROVIDERS) {
        if (provider.canHandle(files)) {
            const result = await provider.parse(files);
            if (result.length > 0) return result;
        }
    }
    return [];
}

// ============================================
// HELPERS
// ============================================

const AUDIO_EXT = /\.(wav|aif|aiff|flac|mp3|ogg)$/i;

export function isAudioFile(name: string): boolean {
    return AUDIO_EXT.test(name);
}

function basename(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx >= 0 ? path.slice(idx + 1) : path;
}
