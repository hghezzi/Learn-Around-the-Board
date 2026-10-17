// src/config.js
// Instructor settings stored in the question file as `config` rows:
//   type = config, id = setting name, question = value (other columns blank).
export const CONFIG_KEYS = ["results_url", "instructor_email", "course", "ask_names"];

// No spaces, and none of the characters that could add headers or recipients to a
// mailto: link (?, &, #, %, commas, semicolons...).
export const EMAIL_PATTERN = /^[^@\s?&#%,;:<>"'()[\]\\/]+@[^@\s?&#%,;:<>"'()[\]\\/]+\.[^@\s?&#%,;:<>"'()[\]\\/]+$/;

// Results go only to a Google Apps Script Web app (the LAB collector). Any other address is
// ignored, so a shared question file can't send students' names and answers to another server.
export const COLLECTOR_URL = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[^/?#]+\/exec(?:[?#]|$)/i;

export function readConfig(rows) {
  const raw = {};
  (rows || []).forEach((r) => {
    if ((r.type || "").trim().toLowerCase() !== "config") return;
    const key = (r.id || "").trim().toLowerCase();
    const value = (r.question || "").trim();
    if (key && value) raw[key] = value;
  });
  const resultsUrl = COLLECTOR_URL.test(raw.results_url || "") ? raw.results_url : "";
  const instructorEmail = EMAIL_PATTERN.test(raw.instructor_email || "") ? raw.instructor_email : "";
  const ask = (raw.ask_names || "").toLowerCase();
  const askNames = ask ? ["yes", "y", "true", "1"].includes(ask) : Boolean(resultsUrl || instructorEmail);
  return { resultsUrl, instructorEmail, course: raw.course || "", askNames };
}
