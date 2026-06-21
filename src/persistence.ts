// KB1 Studio - IndexedDB Persistence
//
// Stores the full instrument session so a browser refresh restores everything.
//
// DB: "kb1-studio" v1
//   Object store "files"  keyPath: id
//     { id, name, arrayBuffer }
//   Object store "state"  keyPath: key
//     { key: 'assignments',     value: [midi, fileId][] }
//     { key: 'instrumentName',  value: string }
//     { key: 'nextFileId',      value: number }

const DB_NAME = 'kb1-studio';
const DB_VERSION = 3;

export interface PersistedFile {
    id: number;
    name: string;
    arrayBuffer: ArrayBuffer;
}

export interface PersistedState {
    assignments: [number, number][];   // [midi, fileId]
    autoAssigned: number[];            // midi notes that were auto-placed
    instrumentName: string;
    nextFileId: number;
    fileRootMidi?: Array<{ id: number; rootMidi: number | null; detectedRootMidi?: number | null }>;
    fileTrims?: Array<{ id: number; trimStart: number; trimEnd: number }>;
    fileNormalized?: Array<{ id: number; normalized: boolean }>;
    slotDuration?: number;
    slotDurationLocked?: boolean;
    exportChannels?: number;
    exportBitDepth?: number;
}

// ============================================
// DB OPEN
// ============================================

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('files')) {
                db.createObjectStore('files', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('state')) {
                db.createObjectStore('state', { keyPath: 'key' });
            }
            // v2: remember last-used directories for import vs. project pickers
            if (!db.objectStoreNames.contains('handles')) {
                db.createObjectStore('handles', { keyPath: 'key' });
            }
            // v3: project-scoped audio cache — the durable source of truth for
            // reopening a project (no permission prompts, no relinking).
            if (!db.objectStoreNames.contains('projectAudio')) {
                db.createObjectStore('projectAudio', { keyPath: 'key' });
            }
        };
        req.onsuccess = () => { _db = req.result; resolve(req.result); };
        req.onerror = () => reject(req.error);
    });
}

// ============================================
// FILES STORE
// ============================================

export async function saveFile(file: PersistedFile): Promise<void> {
    const db = await openDb();
    await tx(db, 'files', 'readwrite', (store) => store.put(file));
}

export async function deleteFile(id: number): Promise<void> {
    const db = await openDb();
    await tx(db, 'files', 'readwrite', (store) => store.delete(id));
}

export async function loadAllFiles(): Promise<PersistedFile[]> {
    const db = await openDb();
    return txAll<PersistedFile>(db, 'files', 'readonly', (store) => store.getAll());
}

export async function getFileById(id: number): Promise<PersistedFile | undefined> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const t = db.transaction('files', 'readonly');
        const req = t.objectStore('files').get(id);
        req.onsuccess = () => resolve(req.result as PersistedFile | undefined);
        req.onerror = () => reject(req.error);
    });
}

export async function clearAllFiles(): Promise<void> {
    const db = await openDb();
    await tx(db, 'files', 'readwrite', (store) => store.clear());
}

/** Clear transient session cache (files + state) but keep picker handles.
 * Used when running in file-first mode where .kb1i is the source of truth. */
export async function clearSessionCache(): Promise<void> {
    const db = await openDb();
    await Promise.all([
        tx(db, 'files', 'readwrite', (store) => store.clear()),
        tx(db, 'state', 'readwrite', (store) => store.clear()),
    ]);
}

// ============================================
// HANDLES STORE  (FileSystemFileHandle persistence)
// ============================================

/** Persist a FileSystemHandle so its parent directory can be used as `startIn`
 *  on the next picker open.  Key: 'import' | 'project' */
export async function saveHandle(key: string, handle: FileSystemHandle): Promise<void> {
    const db = await openDb();
    await tx(db, 'handles', 'readwrite', (store) => store.put({ key, handle }));
}

export async function loadHandle(key: string): Promise<FileSystemHandle | null> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const t = db.transaction('handles', 'readonly');
        const req = t.objectStore('handles').get(key);
        req.onsuccess = () => resolve((req.result as { key: string; handle: FileSystemHandle } | undefined)?.handle ?? null);
        req.onerror = () => reject(req.error);
    });
}

export async function deleteHandle(key: string): Promise<void> {
    const db = await openDb();
    await tx(db, 'handles', 'readwrite', (store) => store.delete(key));
}

// ============================================
// PROJECT AUDIO STORE  (durable, project-scoped audio cache)
// ============================================

interface ProjectAudioRecord {
    key: string;        // `${projectId}:${fileId}`
    projectId: string;
    id: number;
    name: string;
    arrayBuffer: ArrayBuffer;
}

function projectAudioKey(projectId: string, id: number): string {
    return `${projectId}:${id}`;
}

/** Persist a file's audio bytes for a project. Survives page reloads and browser
 *  restarts with no permission prompts — the primary restore path on reopen. */
export async function saveProjectAudio(
    projectId: string,
    id: number,
    name: string,
    arrayBuffer: ArrayBuffer,
): Promise<void> {
    const db = await openDb();
    const record: ProjectAudioRecord = { key: projectAudioKey(projectId, id), projectId, id, name, arrayBuffer };
    await tx(db, 'projectAudio', 'readwrite', (store) => store.put(record));
}

/** Load all audio bytes cached for a project, indexed by file id. */
export async function loadProjectAudio(
    projectId: string,
): Promise<Map<number, { name: string; arrayBuffer: ArrayBuffer }>> {
    const db = await openDb();
    const all = await txAll<ProjectAudioRecord>(db, 'projectAudio', 'readonly', (store) => store.getAll());
    const map = new Map<number, { name: string; arrayBuffer: ArrayBuffer }>();
    for (const rec of all) {
        if (rec.projectId === projectId) map.set(rec.id, { name: rec.name, arrayBuffer: rec.arrayBuffer });
    }
    return map;
}

/** Remove all cached audio for a project (e.g. when starting a new project). */
export async function deleteProjectAudio(projectId: string): Promise<void> {
    const db = await openDb();
    const all = await txAll<ProjectAudioRecord>(db, 'projectAudio', 'readonly', (store) => store.getAll());
    const keys = all.filter((r) => r.projectId === projectId).map((r) => r.key);
    await Promise.all(keys.map((k) => tx(db, 'projectAudio', 'readwrite', (store) => store.delete(k))));
}

// ============================================
// STATE STORE
// ============================================

export async function saveState(s: PersistedState): Promise<void> {
    const db = await openDb();
    await Promise.all([
        tx(db, 'state', 'readwrite', (store) =>
            store.put({ key: 'assignments', value: s.assignments }),
        ),
        tx(db, 'state', 'readwrite', (store) =>
            store.put({ key: 'autoAssigned', value: s.autoAssigned }),
        ),
        tx(db, 'state', 'readwrite', (store) =>
            store.put({ key: 'instrumentName', value: s.instrumentName }),
        ),
        tx(db, 'state', 'readwrite', (store) =>
            store.put({ key: 'nextFileId', value: s.nextFileId }),
        ),
        tx(db, 'state', 'readwrite', (store) =>
            store.put({ key: 'fileRootMidi', value: s.fileRootMidi ?? [] }),
        ),
        tx(db, 'state', 'readwrite', (store) =>
            store.put({ key: 'fileTrims', value: s.fileTrims ?? [] }),
        ),
        tx(db, 'state', 'readwrite', (store) =>
            store.put({ key: 'fileNormalized', value: s.fileNormalized ?? [] }),
        ),
        tx(db, 'state', 'readwrite', (store) =>
            store.put({ key: 'slotDuration', value: s.slotDuration ?? 0 }),
        ),
        tx(db, 'state', 'readwrite', (store) =>
            store.put({ key: 'slotDurationLocked', value: s.slotDurationLocked ?? true }),
        ),
        tx(db, 'state', 'readwrite', (store) =>
            store.put({ key: 'exportChannels', value: s.exportChannels ?? 2 }),
        ),
        tx(db, 'state', 'readwrite', (store) =>
            store.put({ key: 'exportBitDepth', value: s.exportBitDepth ?? 16 }),
        ),
    ]);
}

export async function loadState(): Promise<PersistedState | null> {
    const db = await openDb();
    const [
        assignments,
        autoAssigned,
        instrumentName,
        nextFileId,
        fileRootMidi,
        fileTrims,
        fileNormalized,
        slotDuration,
        slotDurationLocked,
        exportChannels,
        exportBitDepth,
    ] = await Promise.all([
        txGet<{ key: string; value: [number, number][] }>(db, 'state', 'assignments'),
        txGet<{ key: string; value: number[] }>(db, 'state', 'autoAssigned'),
        txGet<{ key: string; value: string }>(db, 'state', 'instrumentName'),
        txGet<{ key: string; value: number }>(db, 'state', 'nextFileId'),
        txGet<{ key: string; value: Array<{ id: number; rootMidi: number | null }> }>(db, 'state', 'fileRootMidi'),
        txGet<{ key: string; value: Array<{ id: number; trimStart: number; trimEnd: number }> }>(db, 'state', 'fileTrims'),
        txGet<{ key: string; value: Array<{ id: number; normalized: boolean }> }>(db, 'state', 'fileNormalized'),
        txGet<{ key: string; value: number }>(db, 'state', 'slotDuration'),
        txGet<{ key: string; value: boolean }>(db, 'state', 'slotDurationLocked'),
        txGet<{ key: string; value: number }>(db, 'state', 'exportChannels'),
        txGet<{ key: string; value: number }>(db, 'state', 'exportBitDepth'),
    ]);
    if (!assignments && !instrumentName) return null;
    return {
        assignments: assignments?.value ?? [],
        autoAssigned: autoAssigned?.value ?? [],
        instrumentName: instrumentName?.value ?? '',
        nextFileId: nextFileId?.value ?? 1,
        fileRootMidi: fileRootMidi?.value ?? [],
        fileTrims: fileTrims?.value ?? [],
        fileNormalized: fileNormalized?.value ?? [],
        slotDuration: slotDuration?.value,
        slotDurationLocked: slotDurationLocked?.value,
        exportChannels: exportChannels?.value,
        exportBitDepth: exportBitDepth?.value,
    };
}

// ============================================
// HELPERS
// ============================================

function tx(
    db: IDBDatabase,
    store: string,
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

function txAll<T>(
    db: IDBDatabase,
    store: string,
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T[]> {
    return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error);
    });
}

function txGet<T>(
    db: IDBDatabase,
    store: string,
    key: string,
): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        const t = db.transaction(store, 'readonly');
        const req = t.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
    });
}
