// src/autosave.js
// Best-effort session autosave in this browser (localStorage), so an accidental
// refresh doesn't lose the game. Cleared on "Back to main menu"/"Exit session".
// The question file is stored once under its own key (it can be large); each
// save after that writes only the game state, which stays small.
const KEY = "lab-autosave-v1";
const FILE_KEY = "lab-autosave-file-v1";
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

let savedFile = null; // the question rows last written under FILE_KEY (by reference)
let fileId = "";
const listeners = new Set();

/** Be told whether the latest save worked (true) or failed, e.g. storage full (false). */
export function onSaveResult(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const report = (ok) => listeners.forEach((fn) => fn(ok));

/** Saves the session; returns false if the browser refused (storage full or blocked). */
export function saveSnapshot(snapshot) {
  const { allTsvRows, ...state } = snapshot;
  try {
    if (allTsvRows !== savedFile) {
      fileId = `${Date.now().toString(36)}-${(allTsvRows || []).length}`;
      localStorage.setItem(FILE_KEY, JSON.stringify({ id: fileId, rows: allTsvRows || [] }));
      savedFile = allTsvRows;
    }
    localStorage.setItem(KEY, JSON.stringify({ ...state, fileId, version: 2, savedAt: Date.now() }));
    report(true);
    return true;
  } catch {
    savedFile = null; // write the file again next time
    report(false);
    return false;
  }
}

export function loadSnapshot() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!s || (s.version !== 1 && s.version !== 2)) return null;
    if (Date.now() - s.savedAt > MAX_AGE_MS) { clearSnapshot(); return null; }
    if (s.version === 1) return s; // saved by an older version: the rows are inside
    const file = JSON.parse(localStorage.getItem(FILE_KEY) || "null");
    if (!file || file.id !== s.fileId || !Array.isArray(file.rows)) return null;
    return { ...s, allTsvRows: file.rows };
  } catch { return null; }
}

export function clearSnapshot() {
  savedFile = null;
  try { localStorage.removeItem(KEY); localStorage.removeItem(FILE_KEY); } catch { /* ignore */ }
}
