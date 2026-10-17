import { describe, it, expect, vi } from "vitest";
import { parseTsv, parseTsvHeaders } from "../src/tsvParser.js";
import { validateQuestionRows, formatValidationReport } from "../src/tsvValidator.js";
import { DEMO_TSV, HEADER, makeTsv } from "./helpers.js";

vi.spyOn(console, "log").mockImplementation(() => {});

const validate = (text) => validateQuestionRows(parseTsv(text), parseTsvHeaders(text));

describe("validateQuestionRows", () => {
  it("accepts a complete file with no errors or warnings", () => {
    const r = validate(makeTsv());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.games).toHaveLength(1);
    expect(r.games[0].themes).toHaveLength(4);
  });

  it("accepts the demo file without errors", () => {
    expect(validate(DEMO_TSV).errors).toEqual([]);
  });

  it("errors when the board has fewer than 4 themes", () => {
    const r = validate(makeTsv({ themes: ["A", "B", "C"] }));
    expect(r.errors.join("\n")).toMatch(/needs 4 themes .* but found 3/);
  });

  it("warns when extra themes will be ignored", () => {
    const r = validate(makeTsv({ themes: ["A", "B", "C", "D", "E"] }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/only the first 4 are used/);
  });

  it("errors on missing required columns", () => {
    const text = "id\tquestion\nq1\tWhat?";
    expect(validate(text).errors.join("\n")).toMatch(/Missing required column\(s\): type/);
  });

  it("errors when correctIndex does not point to an option", () => {
    const bad = ["x1", "Q?", "A", "B", "", "", "3", "Exp", "Topic", "Mod", "T1", "T1-a", "property", ""].join("\t");
    expect(validate(makeTsv({ extra: [bad] })).errors.join("\n")).toMatch(/correctIndex .*"x1"/);
  });

  it("warns on unknown types, duplicate ids and non-lowercase types", () => {
    const rows = [
      ["q0", "Dup id", "A", "B", "", "", "1", "E", "Topic", "Mod", "T1", "T1-a", "property", ""],
      ["p1", "Post", "A", "B", "", "", "1", "E", "Topic", "Mod", "", "", "post", ""],
      ["s1", "Case", "A", "B", "", "", "1", "E", "Topic", "Mod", "", "", "Survey", ""],
    ].map((r) => r.join("\t"));
    const w = validate(makeTsv({ extra: rows })).warnings.join("\n");
    expect(w).toMatch(/Duplicate id/);
    expect(w).toMatch(/Unknown type.*"p1" \(post\)/);
    expect(w).toMatch(/not lowercase.*"s1"/);
  });

  it("errors when a theme has no milestone questions", () => {
    const text = [HEADER, ...makeTsv().split("\n").slice(1).filter((l) => !(l.includes("\tT2\t") && l.includes("\tmilestone\t")))].join("\n");
    expect(validate(text).errors.join("\n")).toMatch(/"T2" has no milestone questions/);
  });

  it("lists referenced image files", () => {
    const img = ["i1", "Q?", "A", "B", "", "", "1", "E", "Topic", "Mod", "T1", "T1-a", "property", "fig.png"].join("\t");
    expect(validate(makeTsv({ extra: [img] })).images).toEqual(["fig.png"]);
  });
});

describe("question formats in the validator", () => {
  const H = HEADER + "\tformat\tanswer\ttolerance";
  const row = (id, { options = ["A", "B", "C", "D"], correctIndex = "", format = "", answer = "", tolerance = "", type = "property" } = {}) =>
    [id, "Q?", ...options, correctIndex, "Exp", "Topic", "Mod", "T1", "T1-a", type, "", format, answer, tolerance].join("\t");
  const base = makeTsv().split("\n").slice(1).map((l) => `${l}\t\t\t`);
  const run = (...rows) => validate([H, ...base, ...rows].join("\n"));

  it("accepts valid rows of every format", () => {
    const r = run(
      row("mu1", { format: "multi", correctIndex: "1,3" }),
      row("n1", { format: "numeric", options: ["", "", "", ""], answer: "1,500", tolerance: "10%" }),
      row("o1", { format: "order" }),
      row("t1", { format: "text", options: ["", "", "", ""], answer: "beta|beta diversity" }),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("reports invalid format-specific fields", () => {
    const e = run(
      row("m1", { format: "multi", correctIndex: "1,7" }),
      row("n1", { format: "numeric", answer: "lots" }),
      row("n2", { format: "numeric", answer: "3", tolerance: "abc" }),
      row("t1", { format: "text", answer: "" }),
      row("x1", { format: "essay" }),
    ).errors.join("\n");
    expect(e).toMatch(/Multi-select.*"m1"/);
    expect(e).toMatch(/Numeric.*"n1"/);
    expect(e).toMatch(/Invalid tolerance.*"n2"/);
    expect(e).toMatch(/Short-text.*"t1"/);
    expect(e).toMatch(/Unknown format.*"x1" \(essay\)/);
  });

  it("warns when a multiple-choice row lists several correct options", () => {
    const r = run(row("mc2", { correctIndex: "1,3" }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/several options .* only the first counts: "mc2"/);
  });

  it("errors when every accepted short answer is only punctuation", () => {
    const e = run(row("t2", { format: "text", options: ["", "", "", ""], answer: "?|!" })).errors.join("\n");
    expect(e).toMatch(/Short-text.*"t2"/);
  });

  it("accepts a decimal comma in numeric answers", () => {
    expect(run(row("n3", { format: "numeric", options: ["", "", "", ""], answer: "2,5", tolerance: "0,1" })).errors).toEqual([]);
  });

  it("warns about mishaps without an explicit amount", () => {
    const w = run(["mm", "Something broke", "", "", "", "", "", "Fact", "Topic", "Mod", "", "", "mishap", "", "", "", ""].join("\t")).warnings.join("\n");
    expect(w).toMatch(/Mishap without an explicit amount.*"mm"/);
  });
});

describe("config rows and format counts", () => {
  const cfg = (id, value) => [id, value, "", "", "", "", "", "", "", "", "", "", "config", ""].join("\t");
  const withConfig = (...rows) => validate([makeTsv(), ...rows].join("\n"));

  it("accepts valid instructor settings without errors or warnings", () => {
    const r = withConfig(
      cfg("results_url", "https://script.google.com/macros/s/AKfy123/exec"),
      cfg("instructor_email", "prof@uni.edu"),
      cfg("course", "BIOL 101"),
      cfg("ask_names", "no"),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("explains bad links, addresses, values and unknown settings", () => {
    const r = withConfig(
      cfg("results_url", "http://example.com/collect"),
      cfg("instructor_email", "prof-at-uni"),
      cfg("course", ""),
      cfg("colour", "blue"),
      cfg("ask_names", "maybe"),
    );
    const e = r.errors.join("\n");
    const w = r.warnings.join("\n");
    expect(e).toMatch(/"results_url" must be an https:\/\/ link/);
    expect(e).toMatch(/"instructor_email" is not a valid email address/);
    expect(e).toMatch(/"course" has no value/);
    expect(w).toMatch(/Unknown config setting "colour"/);
    expect(w).toMatch(/"ask_names" should be yes or no/);
  });

  it("errors when the results link isn't an Apps Script web app (the game ignores it)", () => {
    const e = withConfig(cfg("results_url", "https://example.com/collect")).errors.join("\n");
    expect(e).toMatch(/isn't a Google Apps Script Web app link.*ignores any other address/);
  });

  it("counts questions per answer format", () => {
    const f = validate(DEMO_TSV).formatCounts;
    expect(f.mcq).toBeGreaterThan(100);
    ["multi", "numeric", "order", "text"].forEach((k) => expect(f[k]).toBeGreaterThanOrEqual(1));
    expect(validate(makeTsv()).formatCounts).toEqual({ mcq: 43, trueFalse: 0, multi: 0, numeric: 0, order: 0, text: 0 }); // 4 themes x (2 + 6) + 1 core + 10 survey
  });
});

describe("results delivery line", () => {
  const cfg = (...pairs) => pairs.map(([k, v]) => [k, v, "", "", "", "", "", "", "", "", "", "", "config", ""].join("\t"));
  const delivery = (...pairs) => validate(makeTsv({ extra: cfg(...pairs) })).delivery;

  it("says when results are only downloaded, and that Download never waits for names", () => {
    expect(delivery()).toBe("Results are sent to: nowhere; students only download the results file (CSV). Name/ID field: optional.");
    // The end screen marks the field required but never disables Download (App.jsx SummaryView).
    expect(delivery(["ask_names", "yes"])).toBe("Results are sent to: nowhere; students only download the results file (CSV). Name/ID field: required before Send, Email or Download.");
  });

  it("names the collector and email the game will use, and when names are required", () => {
    expect(delivery(["instructor_email", "prof@uni.edu"])).toBe("Results are sent to: an email to prof@uni.edu (students attach the file). Name/ID field: required before Send, Email or Download.");
    expect(delivery(["results_url", "https://script.google.com/macros/s/X/exec"], ["ask_names", "no"], ["course", "BIOL 1"]))
      .toBe("Results are sent to: the results collector at https://script.google.com/macros/s/X/exec. Name/ID field: optional. Course label: BIOL 1.");
    expect(delivery(["results_url", "https://script.google.com/a/macros/uni.edu/s/X/exec"])).toMatch(/^Results are sent to: the results collector at /);
    expect(delivery(["results_url", "https://example.com/collect"])).toMatch(/^Results are sent to: nowhere; students only download/);
  });

  it.each([
    "https://docs.google.com/forms/d/e/1FAIpQLSf-Test/viewform",
    "https://docs.google.com/spreadsheets/d/1abc/edit#gid=0",
    "https://script.google.com/macros/s/AKfyTest/dev",
    "https://forms.gle/AbCdEf123",
  ])("errors on a Form, Sheet or test link instead of the collector: %s", (url) => {
    const r = validate(makeTsv({ extra: cfg(["results_url", url]) }));
    expect(r.errors.join("\n")).toMatch(/is a Google Form, Google Sheet or test \(\/dev\) link, not the collector's Web app URL/);
    expect(r.delivery).toMatch(/^Results are sent to: nowhere/);
  });

  it.each([
    "https://script.google.com/macros/s/AKfyTest/exec",
    "https://script.google.com/a/macros/uni.edu/s/AKfyTest/exec",
  ])("accepts the collector's Web app URL without errors or warnings: %s", (url) => {
    const r = validate(makeTsv({ extra: cfg(["results_url", url]) }));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("leaves out a destination the game would ignore", () => {
    expect(delivery(["results_url", "http://example.com/collect"])).toMatch(/^Results are sent to: nowhere/);
  });

  it("is printed in the report", () => {
    expect(formatValidationReport(validate(makeTsv()))).toMatch(/\nResults are sent to: nowhere/);
  });
});
