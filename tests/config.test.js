import { describe, it, expect } from "vitest";
import { readConfig } from "../src/config.js";

const cfg = (id, question) => ({ id, question, type: "config" });

describe("readConfig", () => {
  it("returns empty settings when there are no config rows", () => {
    expect(readConfig([{ id: "q1", question: "Why?", type: "property" }])).toEqual({ resultsUrl: "", instructorEmail: "", course: "", askNames: false });
  });

  it("reads the settings and asks for names when results are delivered", () => {
    const config = readConfig([
      cfg("results_url", "https://script.google.com/macros/s/abc/exec"),
      cfg("instructor_email", "prof@uni.edu"),
      cfg("course", "BIOL 101"),
    ]);
    expect(config).toEqual({ resultsUrl: "https://script.google.com/macros/s/abc/exec", instructorEmail: "prof@uni.edu", course: "BIOL 101", askNames: true });
  });

  it("lets the instructor turn names off or on explicitly", () => {
    expect(readConfig([cfg("instructor_email", "prof@uni.edu"), cfg("ask_names", "no")]).askNames).toBe(false);
    expect(readConfig([cfg("ask_names", "Yes")]).askNames).toBe(true);
  });

  it("uses only Apps Script collector links, so a question file can't send results elsewhere", () => {
    for (const url of ["https://example.com/collect", "https://evil.example/macros/s/X/exec", "https://script.google.com.evil.example/macros/s/X/exec",
      "https://script.google.com/macros/s/X/dev", "https://docs.google.com/spreadsheets/d/1abc/edit"]) {
      expect(readConfig([cfg("results_url", url)]).resultsUrl).toBe("");
    }
    expect(readConfig([cfg("results_url", "https://script.google.com/a/macros/uni.edu/s/AKfy/exec")]).resultsUrl).toBe("https://script.google.com/a/macros/uni.edu/s/AKfy/exec");
  });

  it("ignores invalid links and addresses", () => {
    const config = readConfig([cfg("results_url", "http://example.com/collect"), cfg("instructor_email", "not-an-email")]);
    expect(config.resultsUrl).toBe("");
    expect(config.instructorEmail).toBe("");
    expect(config.askNames).toBe(false);
  });

  it("matches keys and types case-insensitively and ignores blank values", () => {
    const config = readConfig([{ id: " Course ", question: " Stats 200 ", type: "Config" }, cfg("instructor_email", "  ")]);
    expect(config.course).toBe("Stats 200");
    expect(config.instructorEmail).toBe("");
  });

  it("refuses email addresses that would add recipients or headers to the mailto: link", () => {
    for (const bad of ["x@y.edu?bcc=evil@e.com", "a@b.edu&cc=x@y.com", "a,b@c.edu", "a b@c.edu", "a@b", "a@b.edu#x"]) {
      expect(readConfig([cfg("instructor_email", bad)]).instructorEmail).toBe("");
    }
    for (const good of ["prof@ubc.ca", "first.last+sab@mail.uni.edu", "jose@universidad.es"]) {
      expect(readConfig([cfg("instructor_email", good)]).instructorEmail).toBe(good);
    }
  });
});
