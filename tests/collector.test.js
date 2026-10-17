// Runs the Google Apps Script results collector against a fake spreadsheet,
// since the real Google services can't be reached from tests.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SOURCE = readFileSync(fileURLToPath(new URL("../public/tools/lab-results-collector.gs", import.meta.url)), "utf8");

function fakeSheet() {
  const cells = [];
  const sheet = {
    cells,
    frozen: 0,
    getLastRow: () => cells.length,
    getLastColumn: () => Math.max(0, ...cells.map((r) => r.length)),
    setFrozenRows: (n) => { sheet.frozen = n; },
    getRange: (row, col, numRows, numCols) => {
      const range = {
        getValues: () => Array.from({ length: numRows }, (_, i) =>
          Array.from({ length: numCols }, (_, j) => (cells[row - 1 + i] || [])[col - 1 + j] ?? "")),
        setValues: (values) => {
          values.forEach((vals, i) => {
            cells[row - 1 + i] = cells[row - 1 + i] || [];
            vals.forEach((v, j) => { cells[row - 1 + i][col - 1 + j] = v; });
          });
          return range;
        },
        setFontWeight: () => range,
      };
      return range;
    },
  };
  return sheet;
}

function loadCollector({ withCache = false, withProps = false } = {}) {
  const sheets = {};
  const store = {};
  const context = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = fakeSheet()) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    ...(withCache ? { CacheService: { getScriptCache: () => ({ get: (k) => store[k] ?? null, put: (k, v) => { store[k] = v; } }) } } : {}),
    ...(withProps ? { PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => store[`p:${k}`] ?? null, setProperty: (k, v) => { store[`p:${k}`] = v; } }) } } : {}),
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (text) => ({ setMimeType: () => ({ text }) }) },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  const postRaw = (contents) => JSON.parse(context.doPost({ postData: { contents } }).text);
  const post = (data) => postRaw(JSON.stringify(data));
  return { sheets, post, postRaw, get: () => JSON.parse(context.doGet().text) };
}

const submission = (extra = {}) => ({
  app: "learn-around-the-board", version: 1, sessionId: "s1", course: "BIOL 101", topic: "16S", module: "QIIME2",
  summary: [{ playerIndex: 0, team: "Red Team", members: "Ana", preScore: 4, postScore: 7 }],
  rows: [{ eventType: "TEAM_INFO", playerIndex: 0, members: "Ana" }, { phase: "pre", section: "quiz", correct: true }],
  ...extra,
});

describe("results collector (Apps Script)", () => {
  let collector;
  beforeEach(() => { collector = loadCollector(); });

  it("answers a browser visit with a running message", () => {
    expect(collector.get()).toMatchObject({ ok: true });
  });

  it("writes a header and one row per team and per detail row", () => {
    expect(collector.post(submission())).toEqual({ ok: true });
    const summary = collector.sheets.Summary.cells;
    expect(summary[0].slice(0, 6)).toEqual(["receivedAt", "sessionId", "course", "topic", "module", "playerIndex"]);
    expect(summary).toHaveLength(2);
    expect(summary[1][summary[0].indexOf("members")]).toBe("Ana");
    expect(collector.sheets.Summary.frozen).toBe(1);
    expect(collector.sheets.Details.cells).toHaveLength(3);
  });

  it("accepts results from games made before the rename, and nothing else", () => {
    expect(collector.post(submission({ app: "science-around-the-board" }))).toEqual({ ok: true });
    expect(collector.post(submission({ app: "something-else" })).ok).toBe(false);
  });

  it("adds new columns without shifting earlier rows", () => {
    collector.post(submission());
    collector.post(submission({ sessionId: "s2", summary: [{ playerIndex: 0, team: "Solo Team", rank: 1 }] }));
    const [header, first, second] = collector.sheets.Summary.cells;
    expect(header).toContain("rank");
    expect(first[header.indexOf("sessionId")]).toBe("s1");
    expect(second[header.indexOf("sessionId")]).toBe("s2");
    expect(second[header.indexOf("rank")]).toBe(1);
    expect(second[header.indexOf("members")]).toBe("");
  });

  it("stops typed text from becoming a formula", () => {
    collector.post(submission({ summary: [{ playerIndex: 0, members: "=IMPORTXML(\"x\")" }] }));
    const [header, row] = collector.sheets.Summary.cells;
    expect(row[header.indexOf("members")]).toBe("'=IMPORTXML(\"x\")");
  });

  it("rejects anything that isn't a game submission", () => {
    expect(collector.post({ hello: "world" })).toMatchObject({ ok: false });
    expect(collector.postRaw("not json")).toMatchObject({ ok: false });
    expect(collector.postRaw("")).toMatchObject({ ok: false });
    expect(collector.post(null)).toMatchObject({ ok: false });
    expect(collector.sheets.Summary).toBeUndefined();
  });

  it("refuses oversized submissions", () => {
    expect(collector.postRaw("x".repeat(2000001))).toMatchObject({ ok: false });
    expect(collector.post(submission({ rows: Array.from({ length: 5001 }, () => ({ a: 1 })) }))).toMatchObject({ ok: false });
    expect(collector.post(submission({ summary: Array.from({ length: 21 }, () => ({ a: 1 })) }))).toMatchObject({ ok: false });
    expect(collector.sheets.Details).toBeUndefined();
  });

  it("keeps column names simple and caps the number of columns", () => {
    const junk = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`col${i}`, i]));
    collector.post(submission({ summary: [{ playerIndex: 0, "=evil()": 1, "a b": 2, _hidden: 3, ...junk }] }));
    const [header] = collector.sheets.Summary.cells;
    expect(header).toHaveLength(80);
    expect(header).not.toContain("=evil()");
    expect(header).not.toContain("a b");
    expect(header).not.toContain("_hidden");
  });

  it("shortens very long text, flattens objects and keeps numbers", () => {
    collector.post(submission({ summary: [{ playerIndex: 0, members: "a".repeat(5000), extra: { nested: "=1" }, score: 7 }] }));
    const [header, row] = collector.sheets.Summary.cells;
    expect(row[header.indexOf("members")]).toHaveLength(2000);
    expect(row[header.indexOf("extra")]).toBe('{"nested":"=1"}');
    expect(row[header.indexOf("score")]).toBe(7);
  });

  it("stops tab- and carriage-return-led text from becoming a formula too", () => {
    collector.post(submission({ summary: [{ playerIndex: 0, members: "\t=1+1", team: "\r=2" }] }));
    const [header, row] = collector.sheets.Summary.cells;
    expect(row[header.indexOf("members")]).toBe("'\t=1+1");
    expect(row[header.indexOf("team")]).toBe("'\r=2");
  });

  it("records a game sent twice only once, and the script's own fields win", () => {
    expect(collector.post(submission({ summary: [{ playerIndex: 0, members: "Ana", course: "FAKE", receivedAt: "x" }] }))).toEqual({ ok: true });
    expect(collector.post(submission())).toEqual({ ok: true, duplicate: true });
    const [header, row, extra] = collector.sheets.Summary.cells;
    expect(extra).toBeUndefined();
    expect(row[header.indexOf("course")]).toBe("BIOL 101");
    expect(row[header.indexOf("receivedAt")]).not.toBe("x");
    expect(collector.sheets.Details.cells).toHaveLength(3);
  });

  it("caps the rows added per day", () => {
    const capped = loadCollector({ withProps: true });
    const big = (i) => submission({ sessionId: `big${i}`, rows: Array.from({ length: 4999 }, () => ({ a: 1 })) });
    const results = Array.from({ length: 21 }, (_, i) => capped.post(big(i)));
    expect(results.filter((r) => r.ok)).toHaveLength(20); // 20 x 5,000 rows = the 100,000 daily limit
    expect(results.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/limit for today/) });
  });

  it("limits submissions per minute", () => {
    const limited = loadCollector({ withCache: true });
    const results = Array.from({ length: 125 }, (_, i) => limited.post(submission({ sessionId: `s${i}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(120);
    expect(results.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/busy/) });
  });
});
