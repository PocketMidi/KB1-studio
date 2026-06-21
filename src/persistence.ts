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
const DB_VERSION = 1;

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
