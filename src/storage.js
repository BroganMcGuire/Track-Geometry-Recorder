/**
 * Persistence of the recorded runs in IndexedDB.
 *
 * A run can easily contain several hundred thousand acceleration samples, so
 * the raw arrays are stored as-is in a single record per run and the run list
 * is kept in a separate lightweight store.
 */

const DB_NAME = 'track-geometry-recorder';
const DB_VERSION = 1;
const RUNS = 'runs';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RUNS)) {
        const store = db.createObjectStore(RUNS, { keyPath: 'id' });
        store.createIndex('startedAt', 'summary.startedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Build the short description shown in the run list.
 * @param {Object} run
 * @returns {Object}
 */
export function summarise(run) {
  const samples = run.acceleration.length;
  const duration = samples > 1 ? run.acceleration[samples - 1].t : 0;
  return {
    startedAt: run.meta?.startedAt ?? new Date().toISOString(),
    elr: run.meta?.elr ?? '',
    track: run.meta?.track ?? '',
    trainType: run.meta?.trainType ?? '',
    initialMileageMi: run.meta?.initialMileageMi ?? 0,
    samples,
    fixes: run.gnss.length,
    markers: run.markers?.length ?? 0,
    durationS: duration,
    rateHz: duration > 0 ? (samples - 1) / duration : 0,
  };
}

/**
 * Save a raw run.
 * @param {Object} run
 * @returns {Promise<string>} the identifier of the stored run
 */
export async function saveRun(run) {
  const db = await openDatabase();
  const id =
    (run.meta?.startedAt ?? new Date().toISOString()) +
    '-' +
    Math.random().toString(36).slice(2, 8);
  const tx = db.transaction(RUNS, 'readwrite');
  tx.objectStore(RUNS).put({ id, summary: summarise(run), run });
  await transactionDone(tx);
  db.close();
  return id;
}

/**
 * List the stored runs, most recent first.
 * @returns {Promise<Array<{id:string, summary:Object}>>}
 */
export async function listRuns() {
  const db = await openDatabase();
  const tx = db.transaction(RUNS, 'readonly');
  const request = tx.objectStore(RUNS).getAll();
  await transactionDone(tx);
  db.close();
  const records = request.result ?? [];
  return records
    .map(({ id, summary }) => ({ id, summary }))
    .sort((a, b) => (a.summary.startedAt < b.summary.startedAt ? 1 : -1));
}

/**
 * Load one run with its raw data.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function loadRun(id) {
  const db = await openDatabase();
  const tx = db.transaction(RUNS, 'readonly');
  const request = tx.objectStore(RUNS).get(id);
  await transactionDone(tx);
  db.close();
  return request.result ?? null;
}

/**
 * Delete a run.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteRun(id) {
  const db = await openDatabase();
  const tx = db.transaction(RUNS, 'readwrite');
  tx.objectStore(RUNS).delete(id);
  await transactionDone(tx);
  db.close();
}
