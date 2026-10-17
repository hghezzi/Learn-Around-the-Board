// src/tsvValidator.js
// ------------------------------------------------------------
// Checks a question file (TSV) against what the game engine
// actually needs, and explains problems in instructor-friendly
// language. Used by the upload screen (App.jsx), by
// `npm run validate-tsv` (scripts/validate-tsv.mjs) and by tests.
//
// Severity:
//   error   -> the game will crash, misbehave, or a question can
//              never be answered correctly
//   warning -> the game runs, but content is ignored, repeated or
//              falls back to built-in defaults
// ------------------------------------------------------------

import { getAllTopics, getModulesForTopic } from "./tsvParser.js";
import { matchesTopicAndModule } from "./tsvBoardBuilder.js";
import { FORMATS, parseFormat, parseIndexList, parseNumber, parseTolerance, hasExplicitMishapAmount, normalizeText } from "./questionFormats.js";
import { CONFIG_KEYS, COLLECTOR_URL, EMAIL_PATTERN, readConfig } from "./config.js";
import { checkItemQuality, formatCueSummary, formatMultiSummary } from "./itemQuality.js";

export const KNOWN_TYPES = ["property", "milestone", "core", "mishap", "survey", "confidence", "config"];
const QUIZ_TYPES = ["property", "milestone", "core", "survey"];
const REQUIRED_HEADERS = ["id", "question", "type"];
const QUIZ_HEADERS = ["option1", "option2", "option3", "option4", "correctIndex", "explanation"];
const BOARD_HEADERS = ["theme", "subtheme"];
const FILTER_HEADERS = ["bigTopic", "module"];
const OPTIONAL_HEADERS = ["imageFile", "format", "answer", "tolerance"];

const BOARD_SIDES = 4;
const SUBTHEMES_PER_SIDE = 2;
const MILESTONE_QUIZ_SIZE = 6;
const SURVEY_QUIZ_SIZE = 10;

const rowLabel = (row, i) => (row.id ? `"${row.id}"` : `row ${i + 2}`);

// Links instructors often paste instead of the collector's Web app URL; they can never work.
const NOT_A_COLLECTOR = /^https:\/\/(?:docs\.google\.com\/(?:forms|spreadsheets)\/|forms\.gle\/|script\.google\.com\/.*\/dev(?:[?#/]|$))/i;
const COLLECTOR = COLLECTOR_URL;

// Instructor settings (type = config): the setting name goes in `id`, its value in `question`.
function checkConfigRow(row, label, errors, warnings) {
  const key = (row.id || "").trim().toLowerCase();
  const value = (row.question || "").trim();
  if (!CONFIG_KEYS.includes(key)) {
    warnings.push(`Unknown config setting ${label} will be ignored. Valid settings: ${CONFIG_KEYS.join(", ")}.`);
    return;
  }
  if (!value) {
    errors.push(`Config "${key}" has no value; put the value in the question column.`);
    return;
  }
  if (key === "results_url") {
    if (!/^https:\/\//i.test(value)) errors.push('Config "results_url" must be an https:// link (the Web app URL from Google Apps Script).');
    else if (NOT_A_COLLECTOR.test(value)) errors.push('Config "results_url" is a Google Form, Google Sheet or test (/dev) link, not the collector\'s Web app URL (https://script.google.com/macros/s/…/exec), so "Send results to instructor" would fail. Follow the collector setup and copy the Web app URL that ends in /exec.');
    else if (!COLLECTOR.test(value)) errors.push('Config "results_url" isn\'t a Google Apps Script Web app link (https://script.google.com/macros/s/…/exec). The game sends results only to the LAB collector and ignores any other address, so "Send results to instructor" won\'t appear.');
  }
  if (key === "instructor_email" && !EMAIL_PATTERN.test(value)) errors.push('Config "instructor_email" is not a valid email address.');
  if (key === "ask_names" && !["yes", "no", "y", "n", "true", "false", "1", "0"].includes(value.toLowerCase())) warnings.push('Config "ask_names" should be yes or no.');
}

/**
 * Where the end screen sends results, as the game reads the config rows. Config rows
 * route student names and scores off the student's computer, so the CLI report
 * always prints this line for the instructor to check.
 */
export function describeDelivery(rows) {
  const cfg = readConfig(rows);
  const to = [];
  if (cfg.resultsUrl) to.push(`the results collector at ${cfg.resultsUrl}`);
  if (cfg.instructorEmail) to.push(`an email to ${cfg.instructorEmail} (students attach the file)`);
  const where = to.length ? to.join(" and ") : "nowhere; students only download the results file (CSV)";
  // The end screen keeps Send, Email and Download disabled while required names are missing.
  const names = cfg.askNames ? "required before Send, Email or Download" : "optional";
  const course = cfg.course ? ` Course label: ${cfg.course}.` : "";
  return `Results are sent to: ${where}. Name/ID field: ${names}.${course}`;
}

function countFormats(rows) {
  const counts = { mcq: 0, trueFalse: 0, multi: 0, numeric: 0, order: 0, text: 0 };
  rows.forEach((row) => {
    if (!QUIZ_TYPES.includes((row.type || "").trim().toLowerCase())) return;
    const format = parseFormat(row.format);
    if (!format) return;
    counts[format]++;
    if (format === "mcq" && [row.option1, row.option2, row.option3, row.option4].filter((o) => o && o.length > 0).length === 2) counts.trueFalse++;
  });
  return counts;
}

const formatLine = (f) => `mcq ${f.mcq} (true/false ${f.trueFalse}), multi ${f.multi}, numeric ${f.numeric}, order ${f.order}, text ${f.text}`;

function summarizeLabels(labels, max = 5) {
  if (labels.length <= max) return labels.join(", ");
  return `${labels.slice(0, max).join(", ")} and ${labels.length - max} more`;
}

/**
 * Validate parsed TSV rows.
 * @param {object[]} rows   output of parseTsv()
 * @param {string[]} headers header names (optional; inferred from rows)
 * @returns {{ errors: string[], warnings: string[], games: object[], images: string[], formatCounts: object, cues: object|null }}
 */
export function validateQuestionRows(rows, headers) {
  const errors = [];
  const warnings = [];
  const cols = headers && headers.length ? headers : Object.keys(rows[0] || {});
  const formatCounts = { mcq: 0, trueFalse: 0, multi: 0, numeric: 0, order: 0, text: 0 };

  if (!rows.length) {
    errors.push("The file has no question rows (it needs a header line plus at least one row).");
    return { errors, warnings, games: [], images: [], formatCounts, cues: null, delivery: "" };
  }

  // ---------- Headers ----------
  const missingRequired = REQUIRED_HEADERS.filter((h) => !cols.includes(h));
  if (missingRequired.length) {
    errors.push(`Missing required column(s): ${missingRequired.join(", ")}. Column names are case-sensitive.`);
  }
  const missingOther = [...QUIZ_HEADERS, ...BOARD_HEADERS, ...FILTER_HEADERS].filter((h) => !cols.includes(h));
  if (missingOther.length) {
    warnings.push(`Missing column(s): ${missingOther.join(", ")}. Column names are case-sensitive.`);
  }
  const unknownCols = cols.filter(
    (h) => h && ![...REQUIRED_HEADERS, ...QUIZ_HEADERS, ...BOARD_HEADERS, ...FILTER_HEADERS, ...OPTIONAL_HEADERS].includes(h)
  );
  if (unknownCols.length) {
    warnings.push(`Unrecognised column(s) will be ignored: ${unknownCols.join(", ")}.`);
  }

  // ---------- Row-level checks ----------
  const seenIds = new Map();
  const badType = [];
  const caseType = [];
  const badAnswer = [];
  const mcqManyAnswers = [];
  const fewOptions = [];
  const noExplanation = [];
  const noQuestion = [];
  const badFormat = [];
  const badMulti = [];
  const badNumeric = [];
  const badTolerance = [];
  const badText = [];
  const vagueMishap = [];
  const images = new Set();

  rows.forEach((row, i) => {
    const label = rowLabel(row, i);
    const rawType = (row.type || "").trim();
    const type = rawType.toLowerCase();

    if (row.id) seenIds.set(row.id, (seenIds.get(row.id) || 0) + 1);
    if (row.imageFile) images.add(row.imageFile.trim());

    if (!KNOWN_TYPES.includes(type)) {
      badType.push(`${label} (${rawType || "blank"})`);
      return;
    }
    if (rawType !== type) caseType.push(label);
    if (type === "config") {
      checkConfigRow(row, label, errors, warnings);
      return;
    }
    if (!(row.question || "").trim()) noQuestion.push(label);

    if (type === "mishap" && !hasExplicitMishapAmount(row.question)) vagueMishap.push(label);

    if (QUIZ_TYPES.includes(type)) {
      const format = parseFormat(row.format);
      if (!format) {
        badFormat.push(`${label} (${row.format})`);
        return;
      }
      const options = [row.option1, row.option2, row.option3, row.option4].filter((o) => o && o.length > 0);
      formatCounts[format]++;
      if (format === "mcq" && options.length === 2) formatCounts.trueFalse++;
      if (format === "mcq") {
        if (options.length < 2) fewOptions.push(label);
        const idx = parseInt(row.correctIndex, 10);
        if (Number.isNaN(idx) || idx < 1 || idx > options.length) badAnswer.push(label);
        else if (parseIndexList(row.correctIndex).length > 1) mcqManyAnswers.push(label);
      } else if (format === "multi") {
        if (options.length < 2) fewOptions.push(label);
        const idxs = parseIndexList(row.correctIndex);
        if (!idxs.length || idxs.some((i) => Number.isNaN(i) || i < 0 || i >= options.length)) badMulti.push(label);
      } else if (format === "order") {
        if (options.length < 2) fewOptions.push(label);
      } else if (format === "numeric") {
        if (Number.isNaN(parseNumber(row.answer))) badNumeric.push(label);
        if (!parseTolerance(row.tolerance)) badTolerance.push(label);
      } else if (format === "text") {
        if (!String(row.answer || "").split("|").some((a) => normalizeText(a))) badText.push(label);
      }
      if (type !== "survey" && !(row.explanation || "").trim()) noExplanation.push(label);
    }
  });

  const dupIds = [...seenIds.entries()].filter(([, n]) => n > 1).map(([id]) => `"${id}"`);
  if (dupIds.length) warnings.push(`Duplicate id(s): ${summarizeLabels(dupIds)}. Ids should be unique so exported data can be traced back to questions.`);
  if (badType.length) warnings.push(`Unknown type, row will be ignored: ${summarizeLabels(badType)}. Valid types: ${KNOWN_TYPES.join(", ")}.`);
  if (caseType.length) warnings.push(`Type is not lowercase: ${summarizeLabels(caseType)}. The game accepts it, but lowercase keeps the file consistent.`);
  if (noQuestion.length) errors.push(`Empty question text: ${summarizeLabels(noQuestion)}.`);
  if (fewOptions.length) errors.push(`Fewer than 2 answer options: ${summarizeLabels(fewOptions)}.`);
  if (badAnswer.length) errors.push(`correctIndex is missing or does not point to a filled option (use 1-4): ${summarizeLabels(badAnswer)}. These questions can never be answered correctly.`);
  if (badFormat.length) errors.push(`Unknown format: ${summarizeLabels(badFormat)}. Valid formats: ${FORMATS.join(", ")} (blank = mcq). These rows are skipped by this check.`);
  if (mcqManyAnswers.length) warnings.push(`correctIndex lists several options but the format is multiple choice, so only the first counts: ${summarizeLabels(mcqManyAnswers)}. For select-all-that-apply, set format to multi.`);
  if (badMulti.length) errors.push(`Multi-select correctIndex must list filled options, e.g. "1,3": ${summarizeLabels(badMulti)}.`);
  if (badNumeric.length) errors.push(`Numeric questions need a number in the "answer" column: ${summarizeLabels(badNumeric)}.`);
  if (badTolerance.length) errors.push(`Invalid tolerance (use a number like 0.5 or a percentage like 5%): ${summarizeLabels(badTolerance)}.`);
  if (badText.length) errors.push(`Short-text questions need accepted answers (with letters or digits) in the "answer" column, separated by | : ${summarizeLabels(badText)}.`);
  if (vagueMishap.length) warnings.push(`Mishap without an explicit amount such as (+$100) or (-$50): ${summarizeLabels(vagueMishap)}. The default +$50 / -$100 will be used.`);
  if (noExplanation.length) warnings.push(`No explanation: ${summarizeLabels(noExplanation)}. Explanations are shown after every answer and are the main teaching moment.`);

  // ---------- The games (bigTopic + module) players can pick ----------
  const scopes = [];
  let topics = getAllTopics(rows);
  if (!topics.length) topics = [null];
  topics.forEach((topic) => {
    let modules = topic ? getModulesForTopic(rows, topic) : [];
    if (!modules.length) modules = [null];
    modules.forEach((module) => {
      const name = [topic, module].filter(Boolean).join(" / ") || "(all rows)";
      scopes.push({ name, topic, module, rows: rows.filter((r) => matchesTopicAndModule(r, topic, module)) });
    });
  });

  // ---------- Answer-option quality (cues that give answers away), per game ----------
  const quality = checkItemQuality(rows, scopes);
  errors.push(...quality.errors);
  warnings.push(...quality.warnings);

  // ---------- Per-game (bigTopic + module) checks ----------
  const games = [];
  scopes.forEach(({ name, topic, module, rows: scoped }, gameIndex) => {
    const ofType = (t) => scoped.filter((r) => (r.type || "").trim().toLowerCase() === t);

    const boardRows = scoped.filter((r) => ["property", "milestone"].includes((r.type || "").trim().toLowerCase()));
    const themes = [];
    boardRows.forEach((r) => {
      const th = (r.theme || "").trim();
      if (th && !themes.includes(th)) themes.push(th);
    });

    const game = { name, topic, module, themes: [], counts: {}, formatCounts: countFormats(scoped), cues: quality.cues.games ? quality.cues.games[gameIndex] : null };
    KNOWN_TYPES.forEach((t) => { game.counts[t] = ofType(t).length; });

    if (themes.length < BOARD_SIDES) {
      errors.push(`[${name}] The board needs ${BOARD_SIDES} themes (one per side) but found ${themes.length}${themes.length ? `: ${themes.join(", ")}` : ""}. The board will be incomplete and the game can break.`);
    } else if (themes.length > BOARD_SIDES) {
      warnings.push(`[${name}] Found ${themes.length} themes; only the first ${BOARD_SIDES} are used (${themes.slice(0, BOARD_SIDES).join(", ")}). Ignored: ${themes.slice(BOARD_SIDES).join(", ")}.`);
    }

    themes.slice(0, BOARD_SIDES).forEach((theme) => {
      const themeRows = scoped.filter((r) => (r.theme || "").trim() === theme);
      const props = themeRows.filter((r) => (r.type || "").trim().toLowerCase() === "property");
      const miles = themeRows.filter((r) => (r.type || "").trim().toLowerCase() === "milestone");
      const subs = [];
      props.forEach((r) => {
        const st = (r.subtheme || "").trim();
        if (st && !subs.includes(st)) subs.push(st);
      });
      const subCounts = subs.map((st) => ({
        name: st,
        questions: props.filter((r) => (r.subtheme || "").trim() === st).length,
      }));
      game.themes.push({ name: theme, subthemes: subCounts, milestoneQuestions: miles.length });

      if (props.length === 0) {
        errors.push(`[${name}] Theme "${theme}" has no property questions, so its 6 property tiles cannot ask anything.`);
      } else if (subs.length < SUBTHEMES_PER_SIDE) {
        warnings.push(`[${name}] Theme "${theme}" has ${subs.length} subtheme(s); each side uses ${SUBTHEMES_PER_SIDE}. Both property groups will reuse the same questions.`);
      } else if (subs.length > SUBTHEMES_PER_SIDE) {
        warnings.push(`[${name}] Theme "${theme}" has ${subs.length} subthemes; only the first ${SUBTHEMES_PER_SIDE} are used. Ignored: ${subs.slice(SUBTHEMES_PER_SIDE).join(", ")}.`);
      }
      if (miles.length === 0) {
        errors.push(`[${name}] Theme "${theme}" has no milestone questions, so its corner exam cannot start.`);
      } else if (miles.length < MILESTONE_QUIZ_SIZE) {
        warnings.push(`[${name}] Theme "${theme}" has ${miles.length} milestone question(s); exams ask ${MILESTONE_QUIZ_SIZE}, so questions will repeat within an exam.`);
      }
    });

    if (game.counts.core === 0) warnings.push(`[${name}] No "core" questions; the 4 core tiles will show a generic event instead of a question.`);
    if (game.counts.mishap === 0) warnings.push(`[${name}] No "mishap" rows; the built-in general wildcards will be used.`);
    if (game.counts.survey === 0) warnings.push(`[${name}] No "survey" questions; the pre/post knowledge check will be empty.`);
    else if (game.counts.survey < SURVEY_QUIZ_SIZE) warnings.push(`[${name}] Only ${game.counts.survey} survey question(s); each player normally gets ${SURVEY_QUIZ_SIZE}.`);
    if (game.counts.confidence === 0) warnings.push(`[${name}] No "confidence" rows; the pre/post surveys will have no confidence sliders.`);

    games.push(game);
  });

  return { errors, warnings, games, images: [...images], formatCounts, cues: quality.cues, delivery: describeDelivery(rows) };
}

/** Format a validation result as plain text (CLI output). */
export function formatValidationReport(result) {
  const lines = [];
  result.games.forEach((g) => {
    lines.push(`Game: ${g.name}`);
    g.themes.forEach((t, i) => {
      const subs = t.subthemes.map((s) => `${s.name} (${s.questions})`).join(", ") || "none";
      lines.push(`  Side ${i + 1}: ${t.name} | subthemes: ${subs} | milestone questions: ${t.milestoneQuestions}`);
    });
    const c = g.counts;
    lines.push(`  core: ${c.core}, mishap: ${c.mishap}, survey: ${c.survey}, confidence: ${c.confidence}`);
    if (result.games.length > 1) {
      lines.push(`  formats: ${formatLine(g.formatCounts)}`);
      [formatCueSummary(g.cues), formatMultiSummary(g.cues)].filter(Boolean).forEach((l) => lines.push(`  ${l}`));
    }
  });
  const f = result.formatCounts;
  if (f) lines.push(`Formats: ${formatLine(f)}`);
  [formatCueSummary(result.cues), formatMultiSummary(result.cues), result.delivery].filter(Boolean).forEach((l) => lines.push(l));
  if (result.images.length) lines.push(`Images referenced (${result.images.length}): ${result.images.join(", ")}`);
  lines.push("");
  result.errors.forEach((e) => lines.push(`ERROR: ${e}`));
  result.warnings.forEach((w) => lines.push(`WARNING: ${w}`));
  lines.push("");
  lines.push(`${result.errors.length} error(s), ${result.warnings.length} warning(s).`);
  return lines.join("\n");
}

