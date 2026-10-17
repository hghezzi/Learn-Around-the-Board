import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { saveSnapshot, loadSnapshot, clearSnapshot, onSaveResult } from "../src/autosave.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    get size() { return data.size; },
  };
}

describe("autosave", () => {
  beforeEach(() => { globalThis.localStorage = memoryStorage(); clearSnapshot(); });
  afterEach(() => { delete globalThis.localStorage; vi.useRealTimers(); });

  it("saves and loads a snapshot", () => {
    saveSnapshot({ phase: "GAME", playerCount: 2 });
    expect(loadSnapshot()).toMatchObject({ phase: "GAME", playerCount: 2, version: 2 });
  });

  it("stores the question file once and only the game state on each save", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ id: `q${i}`, question: "x".repeat(200) }));
    const writes = [];
    const setItem = localStorage.setItem;
    localStorage.setItem = (k, v) => { writes.push([k, v.length]); setItem(k, v); };
    saveSnapshot({ phase: "GAME", allTsvRows: rows, turn: 1 });
    saveSnapshot({ phase: "GAME", allTsvRows: rows, turn: 2 });
    saveSnapshot({ phase: "GAME", allTsvRows: rows, turn: 3 });
    expect(writes.filter(([k]) => k === "lab-autosave-file-v1")).toHaveLength(1);
    expect(Math.max(...writes.filter(([k]) => k === "lab-autosave-v1").map(([, n]) => n))).toBeLessThan(500);
    const loaded = loadSnapshot();
    expect(loaded.turn).toBe(3);
    expect(loaded.allTsvRows).toHaveLength(300);
  });

  it("still opens a game saved by the older format", () => {
    localStorage.setItem("lab-autosave-v1", JSON.stringify({ version: 1, savedAt: Date.now(), phase: "GAME", allTsvRows: [{ id: "a" }] }));
    expect(loadSnapshot().allTsvRows).toEqual([{ id: "a" }]);
  });

  it("ignores unknown versions and a game whose file is missing", () => {
    localStorage.setItem("lab-autosave-v1", JSON.stringify({ version: 9, savedAt: Date.now(), phase: "GAME" }));
    expect(loadSnapshot()).toBeNull();
    saveSnapshot({ phase: "GAME", allTsvRows: [{ id: "a" }] });
    localStorage.removeItem("lab-autosave-file-v1");
    expect(loadSnapshot()).toBeNull();
  });

  it("reports when saving fails, and when it works again", () => {
    const results = [];
    const stop = onSaveResult((ok) => results.push(ok));
    const setItem = localStorage.setItem;
    localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    expect(saveSnapshot({ phase: "GAME", allTsvRows: [] })).toBe(false);
    localStorage.setItem = setItem;
    expect(saveSnapshot({ phase: "GAME", allTsvRows: [] })).toBe(true);
    stop();
    expect(results).toEqual([false, true]);
  });

  it("drops snapshots older than 12 hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 5, 9, 0));
    saveSnapshot({ phase: "GAME" });
    vi.setSystemTime(new Date(2026, 9, 5, 21, 1));
    expect(loadSnapshot()).toBeNull();
    expect(localStorage.size).toBe(0);
  });

  it("clears the snapshot", () => {
    saveSnapshot({ phase: "SUMMARY" });
    clearSnapshot();
    expect(loadSnapshot()).toBeNull();
  });

  it("never throws when storage is full, blocked or corrupt", () => {
    localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    expect(() => saveSnapshot({ phase: "GAME" })).not.toThrow();
    localStorage.getItem = () => "{not json";
    expect(loadSnapshot()).toBeNull();
    delete globalThis.localStorage;
    expect(() => clearSnapshot()).not.toThrow();
    expect(loadSnapshot()).toBeNull();
  });
});
