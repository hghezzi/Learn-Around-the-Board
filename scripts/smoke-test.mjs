#!/usr/bin/env node
// End-to-end smoke test of the built app (Playwright). Run with `npm run smoke`.
// Each scenario plays the 16S demo; it fails if a player gets fewer than 10
// survey questions, if the page throws, or if the exported CSV is incomplete.
// Pick scenarios with SCENARIOS=teams,dark and the number of rolls with ROLLS=10.
import { preview } from "vite";
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import CryptoJS from "crypto-js";
import { encryptLockFile } from "../src/lockFile.js";
import { parseTsv } from "../src/tsvParser.js";
import { startPeerServer, routePeerJs, WEBRTC_ARGS } from "./lib/local-peer-server.mjs";

const ROLLS = Number(process.env.ROLLS || 10);
const server = await preview({ preview: { port: Number(process.env.SMOKE_PORT || process.env.PORT || 4181), strictPort: false }, logLevel: "error" });
const BASE = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: WEBRTC_ARGS });
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  ✗ ${msg}`); };

// Buttons the bot may press in game dialogs, in order of preference.
const DIALOG_BUTTONS = [/^Next question/i, /^Finish exam/i, /^Finish quiz/i, /^Start exam/i, /^Accept challenge/i,
  /^Start the rescue quiz/i, /^Keep playing/i, /^See final standings/i, /^Sell deed/i, /^Downgrade/i,
  /^Buy\b/i, /^Continue$/i, /^Skip$/i, /^Decline$/i, /^Pay full/i, /^Cancel$/i];

// Service workers are blocked except in the offline scenario: requests they answer
// from their cache would bypass page.route() mocks.
async function newPage(colorScheme = "light", { serviceWorkers = "block" } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme, acceptDownloads: true, serviceWorkers });
  const page = await context.newPage();
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  // The production Content-Security-Policy must never block anything the game needs.
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/i.test(m.text())) fail(`CSP: ${m.text().slice(0, 160)}`); });
  page.on("dialog", (d) => d.accept().catch(() => {}));
  return { context, page };
}

async function openDemo(page, url = BASE) {
  await page.goto(url);
  const noThanks = page.getByRole("button", { name: "No thanks" });
  if (await noThanks.count()) await noThanks.click();
  if (!url.includes("deck=")) await page.getByRole("button", { name: /Play the demo/ }).click();
  await page.getByText(/Loaded \d+ questions/).waitFor({ timeout: 15000 });
}

async function setupGame(page, teams) {
  await page.getByRole("button", { name: /Continue to game setup/ }).click();
  // Topic BEFORE team count: this order used to leave extra players without survey questions.
  await page.getByRole("button", { name: /^16S/ }).click();
  await page.getByRole("button", { name: /Confirm selection/i }).click();
  await page.getByRole("button", { name: teams === 1 ? /^Solo$/ : new RegExp(`^${teams} players$`) }).click();
  await page.getByRole("button", { name: /Start game/ }).click();
}

async function doSurvey(page, teams, label) {
  for (let p = 0; p < teams; p++) {
    await page.getByRole("button", { name: /Continue to Questions|Start Questions/ }).click();
    const counters = page.getByText(/^Question \d+ of \d+$/);
    const n = await counters.count();
    const total = n ? Number(((await counters.first().textContent()) || "").match(/of (\d+)/i)[1]) : 0;
    if (n !== 10 || total !== 10) fail(`${label}: player ${p + 1} got ${n} survey questions (expected 10)`);
    const options = page.getByRole("button", { name: /^A\./ });
    for (let k = 0; k < (await options.count()); k++) await options.nth(k).click();
    const inputs = page.locator('input[aria-label="Answer"]');
    for (let k = 0; k < (await inputs.count()); k++) await inputs.nth(k).fill("1");
    await page.getByRole("button", { name: p < teams - 1 ? /^Next Player$/ : /^(Start Game|Finish Surveys)$/ }).click();
  }
}

// Answer whatever question the dialog shows. Returns false when there is nothing to answer.
async function answerQuestion(dialog) {
  const option = dialog.getByRole("button", { name: /^A\./ });
  if (await option.count()) {
    if (await option.first().isEnabled()) { await option.first().click(); return true; }
    return false;
  }
  const submit = dialog.getByRole("button", { name: /^Submit answer$/ });
  if (!(await submit.count())) return false;
  const input = dialog.locator('input[aria-label="Answer"]');
  if ((await input.count()) && (await input.isEnabled())) await input.fill("1");
  const box = dialog.locator('input[type="checkbox"]');
  if ((await box.count()) && !(await dialog.locator('input[type="checkbox"]:checked').count())) await box.first().check();
  if (await submit.isEnabled()) { await submit.click(); return true; }
  return false;
}

async function playTurns(page, label, rolls = ROLLS) {
  let done = 0;
  for (let guard = 0; guard < 400; guard++) {
    if (!(await page.locator(".MuiModal-root").count())) {
      if (done >= rolls) return;
      const roll = page.getByRole("button", { name: /^Roll/ });
      if ((await roll.count()) && (await roll.isEnabled())) {
        await roll.click(); done++;
        // Every landing opens a dialog once the pawn stops (up to ~3 s). Don't use a fixed wait.
        await page.locator(".MuiModal-root").first().waitFor({ timeout: 10000 }).catch(() => {});
      }
      else await page.waitForTimeout(300);
      continue;
    }
    const dialog = page.locator(".MuiModal-root").last();
    if (/Final Standings/i.test(await dialog.innerText())) return;
    if (await answerQuestion(dialog)) continue;
    let clicked = false;
    for (const name of DIALOG_BUTTONS) {
      const button = dialog.getByRole("button", { name }).first();
      if ((await button.count()) && (await button.isEnabled())) { await button.click(); clicked = true; break; }
    }
    if (!clicked) await page.waitForTimeout(300);
  }
  fail(`${label}: gave up after 400 steps (a dialog may be stuck)`);
}

async function finishGame(page, teams, label) {
  if (!(await page.getByText(/Final Standings/i).count())) {
    // "No" must leave the game running; only "Yes" ends it.
    await page.getByRole("button", { name: /^End game$/ }).click();
    await page.getByRole("button", { name: /^No, keep playing$/ }).click();
    await page.getByText("End the game now?").waitFor({ state: "hidden" });
    if (await page.getByText(/Final Standings/i).count()) fail(`${label}: "No, keep playing" ended the game`);
    await page.getByRole("button", { name: /^End game$/ }).click();
    await page.getByRole("button", { name: /^Yes, end the game$/ }).click();
  }
  await page.getByRole("button", { name: /Continue to post-survey/i }).click();
  await doSurvey(page, teams, `${label} post`);
  await page.getByText(/Session complete/).waitFor();
}

function parseCsv(text) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

async function downloadCsv(page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Download results|Export CSV/ }).click(),
  ]);
  return parseCsv(readFileSync(await download.path(), "utf8"));
}

function checkCsv(rows, teams, label) {
  for (let p = 0; p < teams; p++) {
    for (const phase of ["pre", "post"]) {
      const n = rows.filter((r) => r.phase === phase && r.section === "quiz" && r.playerIndex === String(p)).length;
      if (n !== 10) fail(`${label}: CSV has ${n} ${phase}-survey answers for player ${p + 1} (expected 10)`);
    }
  }
  const results = rows.filter((r) => r.eventType === "GAME_RESULT").length;
  if (results !== teams) fail(`${label}: CSV has ${results} GAME_RESULT rows (expected ${teams})`);
  const info = rows.filter((r) => r.eventType === "TEAM_INFO").length;
  if (info !== teams) fail(`${label}: CSV has ${info} TEAM_INFO rows (expected ${teams})`);
}

// The board is showing. A new game opens with the quick rules: close them.
async function gameStarted(page) {
  await page.getByText("Game log").waitFor();
  const gotIt = page.getByRole("button", { name: /^Got it$/ });
  await gotIt.waitFor({ timeout: 2000 }).then(() => gotIt.click()).catch(() => {});
  await page.getByRole("dialog", { name: /How to play/ }).waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

async function teamScenario(teams, colorScheme = "light") {
  const label = `${colorScheme} ${teams} team(s)`;
  console.log(`▶ ${label}`);
  const { context, page } = await newPage(colorScheme);
  await openDemo(page);
  await setupGame(page, teams);
  await doSurvey(page, teams, `${label} pre`);
  await gameStarted(page);
  await playTurns(page, label, teams === 1 ? Math.max(ROLLS, 20) : ROLLS);
  if (teams === 1) {
    // Solo: a net-worth goal instead of rivals, and no chaos tokens.
    if (!(await page.getByText(/goal/).first().isVisible())) fail(`${label}: the solo goal isn't shown`);
    if (await page.getByRole("button", { name: /Chaos tokens/ }).count()) fail(`${label}: chaos tokens are shown in solo play`);
    if (!(await page.getByText(/Final Standings/i).count())) {
      await page.getByRole("button", { name: /^End game$/ }).click();
      await page.getByRole("button", { name: /^Yes, end the game$/ }).click();
    }
    if (!(await page.getByText(/Goal( reached)?.*net worth/).first().isVisible())) fail(`${label}: the end screen doesn't report the goal`);
  }
  await finishGame(page, teams, label);
  const rows = await downloadCsv(page);
  checkCsv(rows, teams, label);
  if (teams === 1) {
    // Every right answer on an own tile is paid by the bank; a wrong one costs the fine.
    const own = rows.filter((r) => r.eventType === "OWN_TILE_Q");
    const paid = rows.filter((r) => r.action === "SOLO_RENT").length;
    if (paid !== own.filter((r) => r.correct === "true").length) fail(`${label}: ${paid} SOLO_RENT rows for ${own.filter((r) => r.correct === "true").length} right own-tile answers`);
    console.log(`  solo: ${own.length} own-tile questions, ${paid} paid`);
  }
  await context.close();
}

// The question file gets results config rows; the Google Apps Script endpoint is mocked.
async function resultsScenario() {
  console.log("▶ results (mock Google Sheet)");
  const { context, page } = await newPage();
  const cfg = (id, value) => [id, value, ...Array(10).fill(""), "config", "", "", "", ""].join("\t");
  await page.route("**/examples/16S_QIIME2_demo.tsv", async (route) => {
    const response = await route.fetch();
    const text = (await response.text()).replace(/\s+$/, "");
    const extra = [cfg("results_url", "https://script.google.com/macros/s/TEST/exec"), cfg("instructor_email", "instructor@example.edu"), cfg("course", "Smoke Test 101")];
    await route.fulfill({ response, body: `${text}\r\n${extra.join("\r\n")}\r\n` });
  });
  let posted = null;
  await page.route("https://script.google.com/**", async (route) => {
    posted = JSON.parse(route.request().postData() || "null");
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: '{"ok":true}' });
  });
  await openDemo(page);
  if (!(await page.getByText(/sends your results to the instructor of Smoke Test 101/).count())) fail("results: start page doesn't mention sending results");
  await setupGame(page, 1);
  await doSurvey(page, 1, "results pre");
  await gameStarted(page);
  await finishGame(page, 1, "results");
  const send = page.getByRole("button", { name: /Send results to instructor/ });
  if (await send.isEnabled()) fail("results: Send should be disabled until names are typed");
  if (await page.getByRole("button", { name: /Download results/ }).isEnabled()) fail("results: Download should be disabled until names are typed");
  await page.getByLabel(/names or student IDs/).first().fill("Test Student");
  if (!(await page.evaluate(() => localStorage.getItem("lab-autosave-v1")))) fail("results: the finished game should be saved until results are delivered");
  await send.click();
  await page.getByText(/^Sent!/).waitFor({ timeout: 10000 });
  // Shared computers: once results are sent, the saved game (with its answers) is deleted.
  if (await page.evaluate(() => localStorage.getItem("lab-autosave-v1"))) fail("results: the saved game should be deleted after sending");
  if (!posted) fail("results: nothing was posted");
  else {
    if (posted.app !== "science-around-the-board" || posted.course !== "Smoke Test 101") fail("results: payload is missing the app or course");
    if (posted.summary?.[0]?.members !== "Test Student") fail("results: summary is missing the student name");
    if (!(posted.rows?.length > 10)) fail("results: payload has too few rows");
    // The Apps Script collector drops columns whose names aren't simple, and caps their number.
    const keys = new Set([...(posted.summary || []), ...(posted.rows || [])].flatMap((r) => Object.keys(r)));
    const odd = [...keys].filter((k) => !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k));
    if (odd.length) fail(`results: the collector would drop these columns: ${odd.join(", ")}`);
    if (keys.size + 5 > 80) fail(`results: ${keys.size} columns, more than the collector keeps`);
  }
  const email = page.getByRole("link", { name: /Email results to instructor/ });
  const href = (await email.count()) ? await email.getAttribute("href") : "";
  if (!href.startsWith("mailto:instructor@example.edu?subject=")) fail(`results: Email link is wrong ("${href.slice(0, 60)}")`);
  else if (!decodeURIComponent(href).includes("Test Student")) fail("results: email draft doesn't name the team members");
  await context.close();
}

// Encrypted (.lock) uploads, shared links and their error messages.
async function filesScenario() {
  console.log("▶ .lock upload and links");
  const { context, page } = await newPage();
  await page.goto(BASE);
  await page.getByRole("button", { name: "No thanks" }).click();
  const lock = CryptoJS.AES.encrypt(readFileSync("public/examples/16S_QIIME2_demo.tsv", "utf8"), "Class-Pass").toString();
  await page.setInputFiles('input[type="file"][accept*=".lock"]', { name: "questions.lock", mimeType: "text/plain", buffer: Buffer.from(lock) });
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Class password/).fill("wrong");
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await dialog.getByText(/password didn't work/).waitFor();
  await dialog.getByLabel(/Class password/).fill("Class-Pass");
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await page.getByText(/Loaded 183 questions/).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /Use a different file/ }).click();
  // Files from the current encryptor (PBKDF2 + AES-GCM).
  const lock2 = await encryptLockFile(readFileSync("public/examples/16S_QIIME2_demo.tsv", "utf8"), "Class-Pass-2");
  await page.setInputFiles('input[type="file"][accept*=".lock"]', { name: "questions2.lock", mimeType: "text/plain", buffer: Buffer.from(lock2) });
  await dialog.getByLabel(/Class password/).fill("Class-Pass");
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await dialog.getByText(/password didn't work/).waitFor({ timeout: 10000 });
  await dialog.getByLabel(/Class password/).fill("Class-Pass-2");
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await page.getByText(/Loaded 183 questions/).waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500); // image checks run in the background
  if (await page.getByText(/couldn't be found/).count()) fail("files: the demo reports missing images, but all its images are hosted");
  await page.getByRole("button", { name: /Use a different file/ }).click();
  // A question whose image exists nowhere is listed, and only that one.
  const stats = readFileSync("public/examples/intro_statistics.tsv", "utf8").replace(/\s+$/, "");
  const header = stats.split(/\r?\n/)[0].split("\t");
  const extra = header.map((h) => ({ id: "img_missing_1", question: "What does this figure show?", option1: "A", option2: "B", correctIndex: "1",
    explanation: "Because.", type: "survey", imageFile: "missing_figure.png" }[h] ?? "")).join("\t");
  await page.setInputFiles('input[type="file"][accept*=".lock"]', { name: "q.tsv", mimeType: "text/tab-separated-values", buffer: Buffer.from(`${stats}\n${extra}\n`) });
  await page.getByText(/1 image couldn't be found: missing_figure\.png\./).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /Use a different file/ }).click();
  await page.setInputFiles('input[type="file"][accept*=".lock"]', { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("just some notes") });
  await page.getByText(/This isn't a question file/).waitFor();

  await page.goto(`${BASE}?deck=stats`);
  await page.getByText(/Loaded \d+ questions/).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: /Continue to game setup/ }).click();
  if (!(await page.getByRole("button", { name: /^Statistics/ }).count())) fail("files: ?deck=stats didn't load the statistics example");
  await page.goto(`${BASE}?deck=${encodeURIComponent("https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0")}`);
  await page.getByText(/isn't published/).first().waitFor();
  await context.close();
}

// A shared link (?deck=demo), then a refresh mid-game and "Resume".
async function resumeScenario() {
  console.log("▶ link + resume");
  const { context, page } = await newPage();
  await openDemo(page, `${BASE}?deck=demo`);
  await setupGame(page, 2);
  await doSurvey(page, 2, "resume pre");
  await gameStarted(page);
  await playTurns(page, "resume", 3);
  const turn = page.getByText(/^Turn \d+$/);
  const before = await turn.textContent();
  const worth = page.getByText(/^Net worth [-−]?\$[\d,]+$/); // team panel only (tile cards also show prices)
  const worthBefore = await worth.allTextContents();
  await page.reload();
  await page.getByRole("button", { name: /^Resume$/ }).click();
  await gameStarted(page);
  const after = await turn.textContent();
  if (before !== after) fail(`resume: came back at "${after}", expected "${before}"`);
  const worthAfter = await worth.allTextContents();
  if (!worthBefore.length || worthBefore.join() !== worthAfter.join()) fail(`resume: net worth changed from ${worthBefore} to ${worthAfter}`);
  if (!(await page.getByText("Game resumed.").count())) fail("resume: the log doesn't say the game was resumed");
  // Finish the game: the CSV must still hold the pre-game surveys answered before the refresh.
  await playTurns(page, "resume after", 2);
  await finishGame(page, 2, "resume");
  checkCsv(await downloadCsv(page), 2, "resume");
  // Back to the main menu forgets the saved game.
  await page.getByRole("button", { name: /Back to main menu/ }).click();
  await page.reload();
  if (await page.getByRole("button", { name: /^Resume$/ }).count()) fail("resume: the save wasn't cleared after the main menu");
  await context.close();
}

// After one online visit the app (and the demo) must work with no network.
async function offlineScenario() {
  console.log("▶ offline after first visit");
  const { context, page } = await newPage("light", { serviceWorkers: "allow" });
  await page.goto(BASE);
  // The browser's install offer (Chrome/Edge) shows "Install as an app"; simulate it.
  await page.evaluate(() => {
    const offer = new Event("beforeinstallprompt");
    offer.prompt = () => { window.__installPrompted = true; };
    offer.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(offer);
  });
  await page.getByRole("button", { name: /Install as an app/ }).click();
  if (!(await page.evaluate(() => window.__installPrompted))) fail("offline: Install as an app didn't open the browser's install prompt");
  await page.getByRole("button", { name: /Install as an app/ }).waitFor({ state: "detached" });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload(); // let the service worker control the page
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) fail("offline: the service worker isn't controlling the page");
  await context.setOffline(true);
  await page.reload();
  const noThanks = page.getByRole("button", { name: "No thanks" });
  if (await noThanks.count()) await noThanks.click();
  await page.getByRole("button", { name: /Play the demo/ }).click();
  await page.getByText(/Loaded \d+ questions/).waitFor({ timeout: 10000 });
  await setupGame(page, 1);
  await doSurvey(page, 1, "offline pre");
  await gameStarted(page);
  // The encryptor works offline too.
  await page.goto(`${BASE}encryptor.html`);
  if (!(await page.getByRole("heading", { name: "Question Encryptor" }).count())) fail("offline: the encryptor didn't open offline");
  await context.close();
}

// A new deploy: an idle start page reloads by itself; with a file loaded, a notice offers Reload.
async function updateScenario() {
  console.log("▶ new version available");
  const swPath = "dist/sw.js";
  const original = readFileSync(swPath, "utf8");
  const { context, page } = await newPage("light", { serviceWorkers: "allow" });
  try {
    await page.goto(BASE);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    const deploy = (n) => writeFileSync(swPath, `${original}\n// smoke-test deploy ${n}\n`);
    const checkForUpdate = () => page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    // 1. Nothing loaded yet: the page reloads into the new version without asking.
    await page.evaluate(() => { window.__oldPage = true; });
    deploy(1);
    await checkForUpdate();
    await page.waitForFunction(() => !window.__oldPage, null, { timeout: 20000 }).catch(() => fail("update: an idle start page didn't reload into the new version"));
    // 2. A file is loaded: never reload by surprise, show the notice instead.
    const noThanks = page.getByRole("button", { name: "No thanks" });
    if (await noThanks.count()) await noThanks.click();
    await page.getByRole("button", { name: /Play the demo/ }).click();
    await page.getByText(/Loaded \d+ questions/).waitFor({ timeout: 10000 });
    await page.evaluate(() => { window.__oldPage = true; });
    deploy(2);
    await checkForUpdate();
    await page.getByText(/A new version of the game is ready/).waitFor({ timeout: 20000 }).catch(() => fail("update: no notice about the new version"));
    if (!(await page.evaluate(() => window.__oldPage))) fail("update: the page reloaded while a file was loaded");
  } finally {
    writeFileSync(swPath, original);
    await context.close();
  }
}

// Debt is settled only after the feedback that caused it: a saved game is injected
// (Red at tile 2 with $10, owning a milestone; Blue owns the core on tile 4) and
// Math.random is fixed so the dice roll 1 + 1.
async function debtScenario() {
  console.log("▶ debt after rent (deterministic)");
  const { context, page } = await newPage();
  const rows = parseTsv(readFileSync("public/examples/16S_QIIME2_demo.tsv", "utf8"));
  const team = (id, name, color, position, money) => ({ id, name, color, position, money, jailed: false, chaosTokens: 0, rescueUsed: false, eliminated: false });
  const tiles = Array.from({ length: 36 }, (_, i) => [i === 4 ? 1 : i === 9 ? 0 : null, 0]);
  const snapshot = {
    version: 1, savedAt: Date.now(), phase: "GAME", sessionId: "debt-test", allTsvRows: rows, imagesBase: "", gameMode: "16S", selectedModule: "QIIME2",
    playerCount: 2, sessionMinutes: 0, startPlayer: 0, playerQuestionSets: [[], []], confQ: [], preRows: [], postRows: [], gameRows: [],
    game: { tiles, players: [team(0, "Red Player", "#e53935", 2, 20), team(1, "Blue Player", "#1e88e5", 0, 1500)], turn: 0, totalTurns: 5, logs: [], logRows: [], dice: [1, 1], endsAt: null },
  };
  await page.addInitScript((s) => {
    if (!sessionStorage.getItem("seeded")) { localStorage.setItem("lab-autosave-v1", s); sessionStorage.setItem("seeded", "1"); }
    Math.random = () => 0;
  }, JSON.stringify(snapshot));
  await page.goto(BASE);
  const noThanks = page.getByRole("button", { name: "No thanks" });
  if (await noThanks.count()) await noThanks.click();
  await page.getByRole("button", { name: /^Resume$/ }).click();
  await page.getByRole("button", { name: /^Roll/ }).click();
  const dialog = page.locator(".MuiModal-root").last();
  await dialog.getByText(/Rent due: \$50/i).waitFor({ timeout: 10000 });
  if (!(await answerQuestion(dialog))) fail("debt: couldn't answer the rent question");
  await dialog.getByRole("button", { name: /^Continue$/i }).waitFor({ timeout: 5000 }).catch(async () => fail(`debt: no feedback dialog (${(await page.locator("body").innerText()).slice(0, 300)})`));
  if (/Out of money/i.test(await dialog.innerText())) fail("debt: liquidation replaced the rent feedback");
  await dialog.getByRole("button", { name: /^Continue$/i }).click();
  await page.getByText(/Out of money/).waitFor({ timeout: 5000 }).catch(async () => fail(`debt: no liquidation after the feedback (${(await page.locator("body").innerText()).slice(0, 600)})`));
  await page.getByRole("button", { name: /^Sell deed/i }).click();
  await page.getByText(/Blue Player's turn/).waitFor({ timeout: 5000 }).catch(() => fail("debt: the turn didn't pass after clearing the debt"));
  await context.close();
}

// A Wildcard that bankrupts the team: its text must stay readable, then the
// Rescue Quiz follows, and failing it eliminates the team (last team standing wins).
async function bankruptScenario() {
  console.log("▶ bankruptcy and rescue quiz");
  const { context, page } = await newPage();
  await page.route("**/examples/16S_QIIME2_demo.tsv", async (route) => {
    const response = await route.fetch();
    const lines = (await response.text()).replace(/\s+$/, "").split(/\r?\n/);
    const header = lines[0].split("\t");
    const mishap = header.map((h) => ({ id: "m_crash", question: "Total disaster! (-$5000)", explanation: "Smoke fun fact.", bigTopic: "16S", module: "QIIME2", type: "mishap" }[h] ?? "")).join("\t");
    await route.fulfill({ response, body: `${[...lines.filter((l) => !/\tmishap\t/.test(l)), mishap].join("\r\n")}\r\n` });
  });
  await openDemo(page);
  await setupGame(page, 2);
  await doSurvey(page, 2, "bankrupt pre");
  await gameStarted(page);
  for (let step = 0; step < 300; step++) {
    const modal = page.locator(".MuiModal-root").last();
    if (!(await page.locator(".MuiModal-root").count())) {
      const roll = page.getByRole("button", { name: /^Roll/ });
      if (await roll.isEnabled()) { await roll.click(); await page.locator(".MuiModal-root").first().waitFor({ timeout: 10000 }).catch(() => {}); }
      else await page.waitForTimeout(200);
      continue;
    }
    const text = await modal.innerText();
    if (/Total disaster/.test(text)) {
      await page.waitForTimeout(500);
      if (!/Smoke fun fact/.test(await modal.innerText())) fail("bankrupt: the Wildcard was replaced before the team could read it");
      await modal.getByRole("button", { name: /^Continue$/i }).click();
      // First bankruptcy: the Rescue Quiz is offered. After a passed rescue, a second one eliminates the player.
      await page.getByText(/Bankrupt!|Player eliminated/).first().waitFor({ timeout: 5000 }).catch(() => {});
      const after = await page.locator(".MuiModal-root").last().innerText().catch(() => "");
      if (/Player eliminated/.test(after) && !/after using the Rescue Quiz/.test(after)) fail(`bankrupt: eliminated without a Rescue Quiz (${after.slice(0, 200)})`);
      else if (!/Bankrupt!|Player eliminated/.test(after)) fail(`bankrupt: no Rescue Quiz offer after the Wildcard (${after.slice(0, 200)})`);
      continue;
    }
    if (/Victory!/i.test(text)) { await context.close(); return; }
    // Answer wrong on purpose: pick the last option (fails some rescue quizzes).
    const options = modal.getByRole("button", { name: /^[A-D]\./ });
    if ((await options.count()) && (await options.first().isEnabled())) { await options.last().click(); continue; }
    if (await answerQuestion(modal)) continue;
    let clicked = false;
    for (const name of [/^Next question/i, /^Finish quiz/i, /^Finish exam/i, /^Start the rescue quiz/i, /^Keep playing/i, /^Continue$/i, /^Skip$/i, /^Decline$/i, /^Pay full/i]) {
      const button = modal.getByRole("button", { name }).first();
      if ((await button.count()) && (await button.isEnabled())) { await button.click(); clicked = true; break; }
    }
    if (!clicked) await page.waitForTimeout(200);
  }
  fail("bankrupt: no team was eliminated after 300 steps");
  await context.close();
}

// Pressing Enter to submit a typed answer must not also press the next button:
// the explanation stays on screen, and a right answer doesn't buy the tile by itself.
// Every property question becomes numeric (answer 7) and the dice roll 1 + 1.
async function enterScenario() {
  console.log("▶ Enter keeps the explanation on screen");
  for (const typed of ["1", "7"]) {
    const { context, page } = await newPage();
    await page.addInitScript(() => { Math.random = () => 0; });
    await page.route("**/examples/16S_QIIME2_demo.tsv", async (route) => {
      const response = await route.fetch();
      const lines = (await response.text()).replace(/\s+$/, "").split(/\r?\n/);
      const header = lines[0].split("\t");
      const col = Object.fromEntries(header.map((h, i) => [h, i]));
      const body = lines.slice(1).map((l) => {
        const c = l.split("\t");
        if (c[col.type] !== "property") return l;
        c[col.format] = "numeric"; c[col.answer] = "7"; c[col.tolerance] = "";
        return c.join("\t");
      });
      await route.fulfill({ response, body: `${[lines[0], ...body].join("\r\n")}\r\n` });
    });
    await openDemo(page);
    await setupGame(page, 2);
    await doSurvey(page, 2, "enter pre");
    await gameStarted(page);
    await page.getByRole("button", { name: /^Roll/ }).click();
    const dialog = page.locator(".MuiModal-root").last();
    const input = dialog.locator('input[aria-label="Answer"]');
    await input.waitFor({ timeout: 10000 });
    const cash = async () => (await page.getByText(/Red Player's turn/).locator("..").innerText()).match(/\$[\d,]+/)?.[0];
    const before = await cash();
    await input.fill(typed);
    await input.press("Enter");
    await page.waitForTimeout(800);
    const label = typed === "7" ? "enter (right answer)" : "enter (wrong answer)";
    if (!(await dialog.getByText(/^Why$/).count())) fail(`${label}: the explanation is gone after pressing Enter`);
    if (typed === "7") {
      if (!(await dialog.getByRole("button", { name: /^Buy\b/ }).count())) fail(`${label}: the buy choice was skipped`);
      if ((await cash()) !== before) fail(`${label}: money changed (${before} → ${await cash()}) without a choice`);
    } else if (!(await dialog.getByRole("button", { name: /^Continue$/ }).count())) fail(`${label}: the result screen was skipped`);
    // A second Enter (focus is on the explanation, not a button) still does nothing.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    if (!(await dialog.getByText(/^Why$/).count())) fail(`${label}: a second Enter skipped the explanation`);
    await context.close();
  }
}

// Solo against the bot: the bot plays its own turns (the student can only watch or
// skip ahead), and only the student's answers reach the results file.
async function botScenario() {
  console.log("▶ solo against the bot");
  const { context, page } = await newPage();
  await openDemo(page);
  await page.getByRole("button", { name: /Continue to game setup/ }).click();
  await page.getByRole("button", { name: /^16S/ }).click();
  await page.getByRole("button", { name: /Confirm selection/i }).click();
  await page.getByRole("button", { name: /^Solo$/ }).click();
  await page.getByRole("button", { name: /Play against the bot/ }).click();
  await page.getByRole("button", { name: /^Medium/ }).click();
  await page.getByRole("button", { name: /Start game/ }).click();
  await doSurvey(page, 1, "bot pre");
  await gameStarted(page);
  let watched = 0, skipped = 0, rolls = 0, sawBotAnswer = false;
  for (let guard = 0; guard < 900; guard++) {
    const modal = page.locator(".MuiModal-root").last();
    if (!(await page.locator(".MuiModal-root").count())) {
      const roll = page.getByRole("button", { name: /^Roll/ });
      const ready = (await roll.count()) && (await roll.isEnabled());
      if (ready && rolls >= 12) break; // the student's turn, between dialogs
      if (ready) { await roll.click(); rolls++; await page.locator(".MuiModal-root").first().waitFor({ timeout: 10000 }).catch(() => {}); }
      else await page.waitForTimeout(200);
      continue;
    }
    const text = await modal.innerText();
    if (/Final Standings/i.test(text)) break;
    if (/The bot is playing/.test(text)) {
      watched++;
      if (/^why$/im.test(text)) sawBotAnswer = true; // innerText is upper-cased like the label
      // Its buttons are the bot's: the student can't press them.
      const enabled = await modal.locator("fieldset button:enabled, fieldset input:enabled").count();
      if (enabled) fail(`bot: ${enabled} control(s) usable by the student during the bot's turn`);
      // Once the bot's answer and explanation have been seen, skip ahead on every bot turn.
      if (sawBotAnswer) await modal.getByRole("button", { name: /Skip ahead/ }).click().catch(() => {});
      else await page.waitForTimeout(400);
      continue;
    }
    if (/Skipping ahead/.test(text)) { skipped++; await page.waitForTimeout(150); continue; }
    if (await answerQuestion(modal)) continue;
    let clicked = false;
    for (const name of DIALOG_BUTTONS) {
      const button = modal.getByRole("button", { name }).first();
      if ((await button.count()) && (await button.isEnabled())) { await button.click(); clicked = true; break; }
    }
    if (!clicked) await page.waitForTimeout(250);
  }
  if (!watched) fail("bot: the bot never played a turn");
  if (!sawBotAnswer) fail("bot: never saw the bot's answer and explanation");
  if (!skipped) fail("bot: Skip ahead was never offered");
  if (!(await page.getByText(/Final Standings/i).count())) {
    await page.getByRole("button", { name: /^End game$/ }).click();
    await page.getByRole("button", { name: /^Yes, end the game$/ }).click();
  }
  await page.getByText(/Your record against it on this computer/).waitFor({ timeout: 10000 }).catch(() => fail("bot: the standings don't show the record against the bot"));
  await page.getByRole("button", { name: /Continue to post-survey/i }).click();
  await doSurvey(page, 1, "bot post");
  await page.getByText(/Session complete/).waitFor();
  const rows = await downloadCsv(page);
  const answers = rows.filter((r) => /_Q$/.test(r.eventType));
  if (answers.some((r) => r.playerIndex !== "0")) fail("bot: the bot's answers are in the results file");
  if (!rows.some((r) => r.eventType === "TRANSACTION" && r.playerIndex === "1")) fail("bot: no bot moves in the results file");
  const results = rows.filter((r) => r.eventType === "GAME_RESULT");
  if (results.length !== 2 || results.find((r) => r.playerIndex === "1")?.bot !== "medium") fail(`bot: GAME_RESULT rows are wrong (${JSON.stringify(results.map((r) => [r.playerIndex, r.bot]))})`);
  if (rows.filter((r) => r.eventType === "TEAM_INFO").length !== 1) fail("bot: the bot got a TEAM_INFO row");
  for (const phase of ["pre", "post"]) {
    const n = rows.filter((r) => r.phase === phase && r.section === "quiz").length;
    if (n !== 10) fail(`bot: ${n} ${phase}-survey answers (expected 10, the student's only)`);
  }
  console.log(`  bot: watched ${watched} bot dialogs, skipped ahead ${skipped} times, ${answers.length} student answers`);
  await context.close();
}

// ---------------------------------------------------------------------------
// ONLINE PLAY: a host and two guest devices, through a local signalling server
// (the public one can't be reached from CI). Covers the lobby, surveys on each
// device, turns played on guests, a guest refresh, a host refresh with Resume,
// the end screen with names sent from devices, the CSV, and a wrong room code.
// ---------------------------------------------------------------------------
let peerServer = null;
async function onlinePage(colorScheme = "light", width = 1300) {
  if (!peerServer) peerServer = await startPeerServer();
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, acceptDownloads: true, serviceWorkers: "block" });
  await routePeerJs(context, peerServer.port);
  const page = await context.newPage();
  page.on("pageerror", (e) => fail(`online page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/i.test(m.text())) fail(`online CSP: ${m.text().slice(0, 160)}`); });
  page.on("dialog", (d) => d.accept().catch(() => {}));
  return { context, page };
}

// One player's survey on one device.
async function onlineSurvey(page, finish, label) {
  await page.getByRole("button", { name: /Continue to Questions|Start Questions/ }).click({ timeout: 20000 });
  const n = await page.getByText(/^Question \d+ of \d+$/).count();
  if (n !== 10) fail(`${label}: ${n} survey questions (expected 10)`);
  const options = page.getByRole("button", { name: /^A\./ });
  for (let k = 0; k < (await options.count()); k++) await options.nth(k).click();
  const inputs = page.locator('input[aria-label="Answer"]');
  for (let k = 0; k < (await inputs.count()); k++) await inputs.nth(k).fill("1");
  await page.getByRole("button", { name: finish }).click();
}

async function dismissRules(page) {
  const got = page.getByRole("button", { name: /^Got it$/ });
  await got.waitFor({ timeout: 15000 }).then(() => got.click()).catch(() => {});
}

// Play `rolls` turns: whoever's turn it is acts on their own device.
async function playOnline(pages, owner, rolls, label) {
  const host = pages.host;
  let done = 0;
  let checkedWatcher = false;
  for (let guard = 0; guard < 500; guard++) {
    const banner = await host.getByText(/^(Red|Blue|Green|Orange) Player's turn$/).first().textContent().catch(() => "");
    const color = (banner.match(/^(\w+)/) || [])[1];
    const page = pages[owner[color]];
    if (!page) { await host.waitForTimeout(200); continue; }
    const modals = page.locator(".MuiModal-root");
    if (await modals.count()) {
      const dialog = modals.last();
      const text = await dialog.innerText().catch(() => "");
      if (/Final Standings/i.test(text)) return;
      // A watching device can't press anything in the dialog.
      if (!checkedWatcher && owner[color] !== "host") {
        const other = Object.entries(owner).find(([, who]) => who !== owner[color] && who !== "host");
        if (other) {
          const watcher = pages[other[1]];
          const buttons = watcher.locator(".MuiModal-root fieldset button:enabled, .MuiModal-root fieldset input:enabled");
          if (await watcher.locator(".MuiModal-root fieldset").count()) {
            checkedWatcher = true;
            if (await buttons.count()) fail(`${label}: a watching device could press a button in someone else's dialog`);
          }
        }
      }
      if (await answerQuestion(dialog)) { await page.waitForTimeout(250); continue; }
      let clicked = false;
      for (const name of DIALOG_BUTTONS) {
        const button = dialog.getByRole("button", { name }).first();
        if ((await button.count()) && (await button.isEnabled())) { await button.click(); clicked = true; break; }
      }
      await page.waitForTimeout(clicked ? 250 : 300);
      continue;
    }
    if (done >= rolls) return;
    const roll = page.getByRole("button", { name: /^Roll/ });
    if ((await roll.count()) && (await roll.isEnabled())) {
      await roll.click(); done++;
      await page.locator(".MuiModal-root").first().waitFor({ timeout: 10000 }).catch(() => {});
    } else await page.waitForTimeout(300);
  }
  fail(`${label}: gave up after 500 steps (a dialog may be stuck on a device)`);
}

// Turn number and every player's net worth, as a device shows them.
const boardState = async (page) => [await page.getByText(/^Turn \d+$/).first().textContent(), ...(await page.getByText(/^Net worth [-−]?\$[\d,]+$/).allTextContents())].join(" | ");

async function onlineScenario() {
  console.log("▶ online: host + 2 devices");
  const { context: hc, page: host } = await onlinePage();
  const { context: ac, page: guestA } = await onlinePage("dark", 1100);
  const { context: bc, page: guestB } = await onlinePage("light", 900);
  await openDemo(host);
  await host.getByRole("button", { name: /Continue to game setup/ }).click();
  await host.getByRole("button", { name: /^16S/ }).click();
  await host.getByRole("button", { name: /Confirm selection/i }).click();
  await host.getByRole("button", { name: /^3 players$/ }).click();
  await host.getByRole("button", { name: /On their own devices/ }).click();
  await host.getByRole("button", { name: /Open the online room/ }).click();
  await host.getByText("The room is open").waitFor({ timeout: 20000 });
  const link = await host.getByLabel("Join link").inputValue();
  const code = new URL(link).searchParams.get("join");

  // Device A uses the link; device B types the code on the start page.
  await guestA.goto(link);
  await guestB.goto(BASE);
  const noThanks = guestB.getByRole("button", { name: "No thanks" });
  if (await noThanks.count()) await noThanks.click();
  await guestB.getByRole("button", { name: "Enter a code" }).click();
  await guestB.getByLabel("Room code").fill(code.toLowerCase());
  await guestB.getByRole("button", { name: /^Join$/ }).click();
  for (const g of [guestA, guestB]) await g.getByText("Who are you playing as?").waitFor({ timeout: 30000 });
  await guestA.getByRole("button", { name: "Play as Blue Player" }).click();
  await guestB.getByRole("button", { name: "Play as Blue Player" }).waitFor({ state: "detached", timeout: 5000 }).catch(() => fail("online: a taken player was still offered to another device"));
  await guestB.getByRole("button", { name: "Play as Green Player" }).click();
  await host.getByRole("button", { name: "Play on this computer" }).first().click(); // Red plays on the host
  const start = host.getByRole("button", { name: /Start the game/ });
  await start.waitFor();
  if (!(await start.isEnabled())) fail("online: Start stays off with every player assigned");
  await start.click();

  // Surveys on every device at once.
  await Promise.all([
    onlineSurvey(host, /^Done$/, "online host pre"),
    onlineSurvey(guestA, /^Send my answers$/, "online A pre"),
    onlineSurvey(guestB, /^Send my answers$/, "online B pre"),
  ]);
  for (const p of [host, guestA, guestB]) await p.getByText("Game log").waitFor({ timeout: 20000 });
  await Promise.all([host, guestA, guestB].map(dismissRules));

  const pages = { host, a: guestA, b: guestB };
  const owner = { Red: "host", Blue: "a", Green: "b" };
  await playOnline(pages, owner, 9, "online");
  await host.waitForTimeout(800);
  const [h1, a1, b1] = [await boardState(host), await boardState(guestA), await boardState(guestB)];
  if (h1 !== a1 || h1 !== b1) fail(`online: devices disagree:\n    host ${h1}\n    A    ${a1}\n    B    ${b1}`);

  // On its own turn, a device opens the chaos dialog (shown on every device) and cancels it,
  // and opens its Upgrades list (only on that device).
  for (let k = 0; k < 8; k++) {
    await playOnline(pages, owner, 0, "online settle");
    if (/^Blue/.test(await host.getByText(/Player's turn$/).first().textContent())) break;
    await playOnline(pages, owner, 1, "online to Blue");
  }
  if (/^Blue/.test(await host.getByText(/Player's turn$/).first().textContent()) && !(await host.locator(".MuiModal-root").count())) {
    await guestA.getByRole("button", { name: /^Chaos tokens/ }).click();
    await host.getByRole("heading", { name: /Chaos tokens/ }).waitFor({ timeout: 5000 }).catch(() => fail("online: the chaos dialog opened on a device didn't show on the host"));
    await guestA.locator(".MuiModal-root").getByRole("button", { name: /^Cancel$/ }).click();
    await host.locator(".MuiModal-root").waitFor({ state: "detached", timeout: 5000 }).catch(() => fail("online: Cancel on a device didn't close the dialog on the host"));
    await guestA.getByRole("button", { name: /^Upgrades/ }).click();
    await guestA.getByRole("heading", { name: /Upgrades/ }).waitFor({ timeout: 5000 }).catch(() => fail("online: Upgrades didn't open on the device"));
    if (await host.locator(".MuiModal-root").count()) fail("online: a device's Upgrades list opened on the host");
    await guestA.getByRole("button", { name: /^Close$/ }).click();
    if (await guestB.getByRole("button", { name: /^Roll/ }).isEnabled()) fail("online: a device can roll on someone else's turn");
  } else fail("online: never reached Blue's turn with no dialog open");

  // A device refreshes: it gets its player back.
  await guestA.reload();
  await guestA.getByText("Game log").waitFor({ timeout: 30000 });
  await dismissRules(guestA);
  if ((await boardState(guestA)) !== (await boardState(host))) fail("online: a refreshed device came back out of step");
  await playOnline(pages, owner, 3, "online after device refresh");

  // The host refreshes between turns: Resume reopens the same room and the devices reconnect.
  while (await host.locator(".MuiModal-root").count()) await playOnline(pages, owner, 0, "online settle");
  await host.waitForTimeout(500);
  const before = await boardState(host);
  await host.reload();
  await host.getByRole("button", { name: /^Resume$/ }).click();
  await host.getByText("Game log").waitFor({ timeout: 20000 });
  await guestB.getByText(/Reconnecting/).waitFor({ timeout: 10000 }).catch(() => {});
  await guestB.getByText(/Reconnecting/).waitFor({ state: "detached", timeout: 45000 }).catch(() => fail("online: a device didn't reconnect after the host's refresh"));
  await host.waitForTimeout(800);
  if ((await boardState(host)) !== before) fail(`online: the host resumed at "${await boardState(host)}", expected "${before}"`);
  if ((await boardState(guestB)) !== before) fail("online: a device shows a different game after the host's refresh");
  await playOnline(pages, owner, 3, "online after host refresh");

  // End of game: post-surveys on every device, names sent from the devices.
  while (await host.locator(".MuiModal-root").count()) await playOnline(pages, owner, 0, "online settle");
  if (await guestA.getByRole("button", { name: /^End game$/ }).count()) fail("online: a device can end the game");
  await host.getByRole("button", { name: /^End game$/ }).click();
  await host.getByRole("button", { name: /^Yes, end the game$/ }).click();
  await host.getByRole("button", { name: /Continue to post-survey/i }).click();
  await Promise.all([
    onlineSurvey(host, /^Done$/, "online host post"),
    onlineSurvey(guestA, /^Send my answers$/, "online A post"),
    onlineSurvey(guestB, /^Send my answers$/, "online B post"),
  ]);
  await host.getByText(/Session complete/).waitFor({ timeout: 20000 });
  for (const [g, name, who] of [[guestA, "Blue", "Ana Lee"], [guestB, "Green", "Sam Park"]]) {
    await g.getByText(/Session complete/).waitFor({ timeout: 20000 });
    await g.getByLabel(new RegExp(`${name} Player: names or student IDs`)).fill(who);
    await g.getByRole("button", { name: /Send names to the host/ }).click();
  }
  await host.waitForTimeout(800);
  if ((await host.getByLabel(/Blue Player: names or student IDs/).inputValue()) !== "Ana Lee") fail("online: the host didn't get the names sent from a device");
  await host.getByLabel(/Red Player: names or student IDs/).fill("Host Group");
  const rows = await downloadCsv(host);
  checkCsv(rows, 3, "online");
  const members = rows.filter((r) => r.eventType === "TEAM_INFO").map((r) => r.members);
  if (members.join("|") !== "Host Group|Ana Lee|Sam Park") fail(`online: CSV members are "${members.join("|")}"`);
  const answered = new Set(rows.filter((r) => /_Q$/.test(r.eventType)).map((r) => r.playerIndex));
  if (answered.size < 2) fail(`online: in-game answers weren't recorded for players on devices (${JSON.stringify(rows.reduce((acc, r) => { const k = r.eventType || r.phase; acc[k] = (acc[k] || 0) + 1; return acc; }, {}))})`);
  await Promise.all([hc.close(), ac.close(), bc.close()]);

  // A code that isn't open.
  const { context: wc, page: wrong } = await onlinePage();
  await wrong.goto(`${BASE}?join=ABC-DEF`);
  await wrong.getByText(/No game with this code is open/).waitFor({ timeout: 30000 }).catch(() => fail("online: a wrong code doesn't say so"));
  await wc.close();
}

const SCENARIOS = {
  debt: debtScenario,
  enter: enterScenario,
  bot: botScenario,
  bankrupt: bankruptScenario,
  teams: async () => { for (const n of [1, 2, 3, 4]) await teamScenario(n); },
  dark: () => teamScenario(3, "dark"),
  results: resultsScenario,
  files: filesScenario,
  resume: resumeScenario,
  offline: offlineScenario,
  update: updateScenario,
  online: onlineScenario,
};
const selected = (process.env.SCENARIOS || Object.keys(SCENARIOS).join(",")).split(",");
for (const name of selected) {
  if (!SCENARIOS[name]) { fail(`unknown scenario "${name}"`); continue; }
  try { await SCENARIOS[name](); } catch (e) { fail(`${name} crashed: ${e.message.split("\n")[0]}`); }
}
await browser.close();
server.httpServer.close();
peerServer?.close();
console.log(failures.length ? `\n${failures.length} problem(s) found.` : "\nAll smoke scenarios passed.");
process.exit(failures.length ? 1 : 0);
