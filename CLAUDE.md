# Learn Around the Board (LAB)

A browser-only, property-trading review game for higher education by Hans Ghezzi. It was built for UBC MICB 475 (16S rRNA / QIIME2), and the engine is meant to work for any subject. Instructors write a question file (TSV), and students (1–4 players per computer; a player can be a small group) load it at https://hghezzi.github.io/Learn-Around-the-Board/. The project goal is to keep improving the platform and make it easy for **other teaching teams** to adopt. Favour changes that keep it subject-agnostic, zero-install and privacy-preserving.

License (see `LICENSE`): code under PolyForm Noncommercial 1.0.0, content (guides, question files, images, the skill's instructions) under CC BY-NC-SA 4.0; commercial rights reserved by Hans. Earlier copies stay CC BY-NC-SA 4.0. Question files instructors make are theirs. Contributions must allow Hans to relicense them (`CONTRIBUTING.md`).

## Pedagogy (why features exist)
- **Purpose:** it replaces review sessions. It rests on playful pedagogy, active recall, and frequent low-stakes assessment with an immediate explanation after every answer. It targets Bloom's "understand/apply", uses backward design from learning outcomes, and suits the BOPPPS lesson plan (80 min).
- **"Data sandwich":**
  - Pre-survey: confidence sliders plus 10 random `survey` MCQs per player.
  - Gameplay.
  - Post-survey: the same questions.
  - CSV export, which students submit to the LMS.
- **Mapping of content to mechanics:**
  - Property tiles hold recall questions.
  - Corner milestones hold harder synthesis questions.
  - Mishaps hold practical pitfalls and fun facts.
  - The `explanation` column is the main teaching moment.
- **Docs (one source of truth each):**
  - `guide/instructor-guide.md`: the living Instructor Guide, in Hans's first-person voice, built on his March 2026 edition (archived at `public/archive/`). It builds to `public/guide/index.html` and `public/LAB_Instructor_Guide.pdf`.
  - `guide/student-guide.md`: the Student Guide (rules and handing in results). It builds to `public/guide/students.html` and `public/LAB_Student_Guide.pdf`.
  - `README.md`: the GitHub front page. It links to the hosted guides instead of repeating them.
  - `.claude/skills/lab-question-writer/references/format.md`: the complete question-file spec.
  - The Markdown is read on GitHub as well as built, so it has no front matter: `<!-- toc -->` marks the contents, and links between the guides use the `.md` file names (the build rewrites them).
  - The old Docusaurus pages (`website/docs/`) were folded into the guides and removed.

## Stack & commands
- React 19, Vite 7, MUI 7, framer-motion and crypto-js. It is a static SPA with no backend.
- `npm run dev`: local dev server.
- `npm test`: Vitest unit tests in `tests/`.
- `npm run lint`: ESLint, scoped to app code.
- `npm run build`: production build to `dist/`.
- `npm run validate-tsv -- file.tsv`: check a question file. Exits 1 on errors.
- `npm run package-skill`: zip the question-writer skill to `public/downloads/` (also runs automatically before `build`; the output is gitignored).
- `npm run sync-plugin`: copy the skill into the Claude Code plugin (`plugins/lab-question-writer/skills/`). Run it after every skill edit; `tests/plugin.test.js` fails while the copies differ. `claude plugin validate .` checks the marketplace (`.claude-plugin/marketplace.json`, name `lab`); bump the plugin's `version` in `plugins/lab-question-writer/.claude-plugin/plugin.json` whenever the skill changes, or installed copies won't update; users install with `/plugin marketplace add hghezzi/Learn-Around-the-Board` and `/plugin install lab-question-writer@lab`.
- `npm run guide`: rebuilds both guides. It runs `vite build`, then `scripts/guide-screenshots.mjs` (Playwright screenshots into `guide/images/`), then `scripts/build-guide.mjs` (writes `public/guide/index.html`, `public/guide/students.html` and both PDFs, and fails on a link to a missing heading). `node scripts/build-guide.mjs` alone rebuilds them from the existing screenshots. The outputs are committed.
- `npm run smoke`: builds, then `scripts/smoke-test.mjs` plays the built app with Playwright (1–4 players, dark mode, mocked Google Sheet send, `.lock` and link loading, resume after a refresh, offline, and `online`: a host and two devices through a local PeerJS server from `scripts/lib/local-peer-server.mjs`, which also serves `a11y` and `guide`). Pick scenarios with `SCENARIOS=teams,dark,results,files,resume,offline,online`. **Run it before every deploy.** It takes about 5 minutes.
- `npm run privacy`: builds, then `scripts/privacy-check.mjs` checks with Playwright that nothing leaves the site before analytics opt-in or after "No thanks", that a change of mind deletes the GA cookies, that `javascript:`/`data:` share links are refused, that `404.html` redirects, and that the CSP blocks nothing. Smoke and privacy accept `PORT=`.
- `npm run a11y`: axe-core checks on the main screens in light and dark mode (including the password dialog, resume notice and end screen). It needs `npm run preview` running on port 4173.
- `python3 scripts/make-icons.py`: regenerates the install icons in `public/icons/` (Pillow).
- `npm run deploy`: builds and pushes `dist/` to the `gh-pages` branch (Vite `base` is `/Learn-Around-the-Board/`). Normally not needed: `.github/workflows/deploy.yml` deploys automatically after CI passes on `main` (and can be re-run by hand). Run it manually only when asked.
- CI (`.github/workflows/ci.yml`) runs lint and tests, validates both example TSVs with the JS and Python validators, builds, then plays the app end to end (`smoke`, `privacy`). A merge to `main` therefore goes live once CI is green.

## Code map
- `src/App.jsx`:
  - Phase machine: landing, then `SETUP` (players, session length, topic/module), `PRE_SURVEY`, `GAME`, `POST_SURVEY`, `SUMMARY`.
  - Landing: demo and Intro Statistics (`loadFromLink("demo"|"stats")`), upload a TSV or `.lock` (`PasswordDialog`; formats in `lockFile.js`), `?deck=`/`?images=` links, optional images, the validation report (lists only images that can't be found), `ShareLinkBuilder`, the "Resume your game?" offer, `InstallButton` and the consent banner.
  - `startGame()` builds the survey sets with the final team count (`surveys.js`) and a new `sessionId`.
  - Autosave: while in `PRE_SURVEY`…`SUMMARY`, App saves a snapshot (`autosave.js`), including the game's state from `GameScreen`'s `onSnapshot`. It is cleared by `resetFile()`/main menu, Exit session and `startGame()`.
  - `SurveyView` serves both pre and post surveys. The best pre-survey scorer starts the game (`bestPreSurveyPlayer`).
  - `SummaryView`: score table, names or IDs per team (required when `config.askNames`: Send, Email and Download stay disabled until filled), then Send (results sheet), Email (a `mailto:` link that also downloads the file) and Download. The CSV starts with `TEAM_INFO` rows.
- `src/GameScreen.jsx`: a single component (~1,860 lines) holding all turn logic and UI (moving the rules into a pure engine is planned), with modal flows keyed by `modalStage` / `activeCard.type`.
  - Start money by player count (`startingMoney(n)`: 2500/2000/1500/1250 for 1–4, `ECONOMY.startMoney`); passing START +$200 (the "lap bonus"). A new game opens `RulesDialog` (quick rules from `labels.js` `RULES`).
  - Question choice goes through `questionPicker.js` (unseen first, a missed question again after `REASK_AFTER_TURNS`); the shared history (`asked`) is saved with the game.
  - `checkLanding` reads `playersRef` and must not run side effects inside a state updater (StrictMode runs updaters twice in dev).
  - Autosave: `onSnapshot` fires only between turns (`turnInProgressRef` is set by the roll and cleared by `passTurn`). `resume` restores players, turn, logs, `asked` and tile `[owner, level, paid]` onto a freshly built board; tiles share question arrays, so the board itself is never serialized.
  - Property question: right gives the option to buy; wrong is −$20.
  - **Solo (1 player):** landing on your own tile asks one of its questions (`OWN_TILE` card, action `answerOwnTile`); right = the bank pays its rent (`soloOwnTileIncome`, CSV `SOLO_RENT`), wrong = −$20. A net-worth goal by session length (`SOLO.goals`/`soloGoal` in `gameRules.js`, sized by simulation) shows in `TeamPanel`; a `SOLO_GOAL` row marks when it is reached. No chaos tokens. The standings show goal, accuracy, milestones and a personal best (`personalBest.js`, localStorage `lab-best-v1`). Quick rules come from `rulesFor(playerCount)` in `labels.js`.
  - **Solo against the bot** (`bot` prop, `{ level }`; App `soloMode`/`botLevel`, local play only): the bot is player 1 with the normal two-player rules. One effect in GameScreen ("THE BOT") presses the same named actions a person does, one step at a time (`BOT_PACE`; **Skip ahead** = fast for that turn, via `turnSeq`/`skipSeq`). During its turn `botWatching` disables the student's controls except on the standings and winner screens. `logAnswer` skips the bot (no answer rows, no `asked` history); its `GAME_RESULT` row has `bot: level`. Record per level in `personalBest.js` (`getBotRecord`/`recordBotGame`). Rules from `rulesFor(n, bot)` (`BOT_RULE`).
  - Rent defense: right pays 50%.
  - Milestone exam: 6 questions, 5 to pass, failing on the 2nd mistake; a pass earns a chaos token.
  - Chaos steal at 50% of price, using the target tile's own questions. Complete sets (owner holds the whole subgroup) can't be targeted; the token is spent either way and the turn ends.
  - Liquidation, then **one** Rescue Quiz (2 of 3 to pass; CSV action `EMERGENCY_GRANT`). Failing it, or a second bankruptcy, eliminates the team and returns its tiles to the bank.
  - **The game ends** with last team standing (`WIN`), or with the `STANDINGS` modal ranking by net worth. Standings open from END GAME, from the optional `sessionMinutes` timer, or after a win. `handleEndGame` appends `GAME_RESULT` rows.
  - `logAnswer` writes one CSV row per answered question.
- `src/questionFormats.js` (pure):
  - Formats: `mcq | multi | numeric | order | text`.
  - `normalizeQuestion` turns a TSV row into a question; `prepareQuestion` shuffles the options and remaps answers.
  - `checkAnswer` returns `{correct, responseText, correctText}`. Text answers forgive one typo in answers of 8+ characters, never in the first letter, a number or a Roman numeral (`ROMAN_NUMERALS`); numeric answers accept a unit after the number (`parseNumericResponse`: "12 kg").
  - `parseMishapAmount` reads the amount from mishap text.
- `src/theme.js`:
  - MUI theme with light/dark `colorSchemes`, selected by the media query, so it follows the device setting. Exposed as CSS variables, e.g. `var(--mui-palette-board-felt)`; `v()` builds that string.
  - Custom `palette.board.*` colours.
  - `TEAM_COLORS` and `TEAM_SYMBOLS` (`TEAM_NAMES` is re-exported from `labels.js`).
  - Bundled Fredoka (headings) and Nunito (body) fonts.
  - **Never hard-code text or background colours in components; use theme tokens.** The old Vite template CSS caused white-on-white text in dark mode.
- `src/components/`:
  - `Board.jsx`: responsive 10×10 grid sized with container-query units. The centre holds the title, turn banner, dice and actions.
  - `Dice.jsx`, `TeamPanel.jsx`, and `confetti.js` (`celebrate()`, which respects reduced motion).
- `src/QuestionInput.jsx`: renders any format, in game mode (`onSubmit`, `reveal`) or survey mode (`survey`, `onChange`). Enter in an answer box calls `preventDefault` so the same key press can't reach the result screen; `OutcomePanel` (GameScreen) takes focus itself and keeps its buttons `inert` for 400 ms. `QuestionImage` hides images that fail to load.
- `src/tsvParser.js` (pure): `parseTsv`, `parseTsvHeaders`, `parseList` (comma lists), `getAllTopics`, `getModulesForTopic`.
- `src/tsvBoardBuilder.js` (pure):
  - Filters rows by `bigTopic`/`module`; a blank cell matches all.
  - The first 4 `theme`s (by first appearance in property/milestone rows) become the sides, and each side takes its first 2 `subtheme`s.
  - `core` rows are shared by all 4 core tiles.
  - Output shape: `{CoreTech, Side1..4}`.
- `src/gameData.js`:
  - Builds a fixed **36-tile** loop. Tiles 0/9/18/27 are milestones, and tile 0 (START) is Side4's milestone.
  - Each side is 3×sub1 ($100), core ($200), 3×sub2 ($160), Wildcard (internal type `chance`).
  - Base rent is 20% of price × `ECONOMY.rentScale` (2.5), so 50% of price; a core's base is `coreRentStep` ($50), multiplied by the number of core tiles its owner holds; a rival milestone's fee is `milestoneFee` ($250).
- `src/gameRules.js` (pure):
  - Rent multipliers: 0.5× without the full set, otherwise 1/3/6/10/20× by level.
  - Victory helpers: `assetValue`, `netWorth`, `rankPlayers`, `nextActivePlayer`, `bestPreSurveyPlayer`.
  - Net worth = cash + money spent: each tile's `paid` (price, or the chaos price) plus each subgroup's upgrades once (`upgradeSpend`). Every liquidation sale returns half of what was paid.
- `src/bot.js` (pure): bot levels (`BOT_LEVELS` accuracy 0.5/0.7/0.85, sized with `node scripts/bot-sim.mjs`, a Monte Carlo of the real rules), `botResponse(q, correct)` for every format, buying/milestone/upgrade/chaos/liquidation choices, and pacing (`resultDelay`). Tests in `tests/bot.test.js`.
- `src/images.js` (pure): `resolveImage(name, uploaded, base)`. Order: uploaded file, then http/data URL, then the `?images=` folder (`base`), then `./questionImages/<name>` (hosted in `public/questionImages`: only figures we can publish, drawn by `scripts/make-demo-images.py` or the skill).
- `src/surveys.js` (pure): `buildSurveySets` (10 per player) and `buildConfidenceQuestions`, filtered by topic/module.
- `src/config.js` (pure): `readConfig(rows)` reads `type=config` rows (`results_url`, `instructor_email`, `course`, `ask_names`).
- `src/results.js`: `toCsv` (formula-safe), `resultsFilename`, `summarizeTeams`, `teamInfoRows`, `buildPayload`, `sendResults` (text/plain POST, no CORS preflight), `buildMailto`, `downloadText`.
- `src/deckLinks.js` (pure): `?deck=`/`?images=` links. Shortcuts `demo`/`stats`; published Google Sheets become TSV exports and GitHub pages become raw links; `buildShareLink`, `isUnpublishedSheet`.
- `src/autosave.js`: `saveSnapshot`/`loadSnapshot`/`clearSnapshot` in localStorage (`lab-autosave-v1` for the state, `lab-autosave-file-v1` for the question rows, written once per file; 12-hour expiry, never throws; `onSaveResult` drives `SaveNotice` when storage is full). Sending or downloading results clears it.
- `src/components/PasswordDialog.jsx` and `src/components/InstallButton.jsx` (`main.jsx` keeps the `beforeinstallprompt` event in `window.__labInstallPrompt`).
- `vite.config.js`: two pages (`index.html`, `encryptor.html`); a production-only Content-Security-Policy `<meta>` (update it when the app loads something new; the smoke test fails on any CSP violation); a `vendor` chunk for React/MUI; `vite-plugin-pwa` (manifest, service worker with skipWaiting/clientsClaim, precache of the app, demo files, hosted images and Latin fonts; not the guide, PDFs or other font subsets).
- `src/pwa.js` + `src/components/UpdateNotice.jsx`: registers the service worker, checks for a new deploy every 30 min and on tab focus; a new version reloads an empty start page by itself, otherwise shows a "new version is ready" notice (never reloads mid-session). `GameScreen` is lazy-loaded (`lazyLoad.js` reloads once if an old chunk is gone) and prefetched at idle. `ErrorBoundary.jsx` wraps the app.
- `src/online/` (online play, beta): the host's browser runs the game; guests mirror it.
  - `protocol.js` (pure): room codes (crypto random), message checks, `ACTION_STAGES` (the dialog step each guest action is legal in; a new action needs an entry), `guestView` (answers hidden until answered, tiles without questions), `canGuestAct`/`checkGuestAction` (a device acts only for its players on their turn; standings and the winner screen are host-only), tile args by reference, survey-answer cleaning. Bump `PROTOCOL_VERSION` when messages change.
  - `sessions.js`: `HostSession` (lobby claims, devices, phase sync, one view send per change, reconnect by device token; `stepRev` numbers each step, guests send the one they saw, so stale presses and double taps are ignored) and `GuestSession` (auto-reconnect), with the network injected; `tests/online.test.js` uses an in-memory one.
  - `peerTransport.js`: PeerJS (WebRTC data channels; signalling at 0.peerjs.com, allowed in the CSP), loaded only when online play is chosen. `useHostRoom.js`, `HostScreens.jsx` (lobby, survey wait), `GuestApp.jsx` (?join=CODE), `JoinCodeForm.jsx`.
  - `GameScreen` takes `online`: on a guest, host-owned state comes from the view (`useShared`), and every button is a named action (`act(name, fn)`) sent to the host, which runs the same function. New buttons must go through `act` and be listed in `GUEST_ACTIONS`.
  - Surveys are answered on each device and scored on the host (`surveyRows` in `surveys.js`); the host can answer for a stuck device. Autosave stores the room code and claims, so Resume reopens the room.
- `src/lockFile.js` (pure, Web Crypto): `.lock` files. Current format `LAB-LOCK-v2:` (PBKDF2-SHA256 600k + AES-256-GCM); legacy CryptoJS files (`U2FsdGVkX1…`) still open, loading `crypto-js` on demand.
- `public/tools/lab-results-collector.gs`: the Google Apps Script instructors paste into their own Sheet (Summary and Details tabs). It enforces size, row, column, per-minute (inside the lock) and per-day row limits, records a `sessionId` only once, and its own fields (`receivedAt`, `course`…) override submitted ones; column names must match `^[A-Za-z][A-Za-z0-9_]{0,39}$` (the smoke test checks the game's payload). `tests/collector.test.js` runs it against a fake Sheet.
- `src/tsvValidator.js` (pure): instructor-facing checks that mirror what the engine needs. Shared by the UI, CLI and tests. **Update it, and its Python mirror in the skill, whenever engine assumptions change.**
- `src/itemQuality.js` (pure): answer-option checks called by the validator. It measures test-wise cues (how often "pick the longest/shortest option" or "pick the option that repeats the question's words" would be right versus chance, absolute words only in distractors, "all of the above", a/an grammar cues, identical options, survey items that repeat board items) and errors on spreadsheet error values such as `#NAME?`. It also reports cue figures per game and for milestone pools, select-all correct-count skew, formula-prone and leading-apostrophe cells, and short answers the typo rule would confuse. `tsvValidator.js` ends its report with a `Results are sent to:` line, and errors on a Google Form, Sheet or `/dev` link as `results_url`. Its Python mirror lives in the skill's `validate_tsv.py`; keep rules, thresholds and messages identical (`tests/itemQuality.test.js` compares the two).
- `src/consent.js` and `src/ConsentBanner.jsx`: Google Analytics (`G-B2Z5WS4KQR`) loads only after opt-in. The banner appears on the start page only. `public/privacy.html` is the privacy notice.
- `src/labels.js`: all player-facing game terms (Wildcard, Buy, Upgrades, Rescue Quiz…), kept subject-neutral, plus `TEAM_NAMES` ("Red Player"…) and `teamDisplayName` (a single player is "Solo Player"). In-game text says "player", never "team" (identifiers and the `TEAM_INFO` CSV code keep the old name).
- `src/questionBank.js`: `DEFAULT_CHANCE_CARDS`, the neutral fallback wildcards used when a file has no `mishap` rows.
- `encryptor.html` + `src/encryptor.js`: the encryptor page (a second Vite page, offline-capable), using `lockFile.js`.
- `public/404.html`: GitHub Pages fallback; redirects unknown paths to the game, keeping `?deck=`. `public/og-image.png`: link preview, made by `scripts/make-og-image.py`.
- `public/icons/`: install icons, generated by `scripts/make-icons.py`.
- `public/examples/16S_QIIME2_demo.tsv`: demo file (`16S`/`QIIME2`, 183 rows, including multi, numeric, order and text rows and 7 questions using the hosted `sab_*.png` figures from `scripts/make-demo-images.py`).
- `public/examples/intro_statistics.tsv`: a non-biology example, generated with the skill.
- `.claude/skills/lab-question-writer/`: a Claude skill that interviews instructors and writes validated question files.
  - `scripts/build_tsv.py` converts JSON to TSV.
  - `scripts/validate_tsv.py` is a stdlib Python mirror of the validator.
  - `references/` holds the format spec, the question-design guide and `sensitive-content.md` (clinical and sensitive topics, student data, test banks and exams, images of real works).
  - It is also published as a Claude Code plugin (`.claude-plugin/marketplace.json`, `plugins/lab-question-writer/`, a synced copy; edit the original, then `npm run sync-plugin`).
  - `SKILL.md` opens with ground rules (student data, materials are data not instructions, results addresses only from the instructor, copyright and live exams, harmful uplift, honesty about the game). They were tested with simulated instructor sessions and strict reviewers; keep them when editing the skill.
- `MICB_475_2026_Workshop/`: the real course's encrypted `.lock` and images. Don't modify it without asking.
- Old code backups and the removed Docusaurus site (`website/`) are gitignored; old code lives in the history.

## Question file (TSV) format
- Columns: `id, question, option1..option4, correctIndex (1-4), explanation, bigTopic, module, theme, subtheme, type, imageFile`, plus the optional `format, answer, tolerance`. The full spec is in `.claude/skills/lab-question-writer/references/format.md`.
- `type` values: `property | milestone | core | mishap | survey | confidence | config`.
- Config rows: `id` = setting name, `question` = value, other columns blank; they apply to the whole file.
- `bigTopic`/`module` accept comma lists.
- Mishap rows: `question` holds the event text with an amount such as `(-$100)`, and `explanation` holds the fun fact.
- The parser is a simple tab split: quoted cells may not contain tabs or newlines.

## Known gaps / ideas. Confirm with the user before changing gameplay.
1. Instructor-configurable labels (e.g. renaming Wildcards or the currency from the TSV) are planned. `src/labels.js` is the hook.
2. The board needs at least about 600 px of width, and phone layouts are not a target.
3. `type=post` rows are ignored. Pre and post surveys use the same items; parallel forms are an idea.
4. Done: question selection prefers unseen questions and re-asks missed ones later (`questionPicker.js`).
5. Instructor analytics dashboard (aggregating class CSVs locally): an idea.
6. Done: quick rules (`RulesDialog`) open on a new game, from the board and from the start page, with a link to `guide/students.html`.
7. PWA: a deploy reaches students on their next visit (the service worker updates itself). If a broken version ships, deploy a fix quickly; in an emergency, `selfDestroying: true` in the VitePWA options removes the service worker.
8. Google endpoints (Sheets links, Apps Script) can't be reached from the cloud sandbox. The smoke test mocks them and `tests/collector.test.js` uses a fake Sheet, so test the real Sheet flow by hand after deploying.
9. Online play (beta) is peer-to-peer through the public PeerJS service: untested on real school networks, iOS and other browsers from here (the sandbox can't reach PeerJS). A hosted relay would be needed if networks block WebRTC; uploaded images are not shared with devices.

## Conventions
- Develop on the session's assigned branch. Don't push to `main` or deploy unless asked; merging to `main` deploys automatically.
- Keep the pure logic (parser, builder, rules, validator) free of React so it stays testable. Add tests in `tests/` for rule changes.
- Teams use the live site for classes, so flag any change that alters gameplay, scoring or the CSV format.
- **Keep the guides current.** Every user-facing change updates `guide/instructor-guide.md` (and `guide/student-guide.md` when students see it) and adds a "What's new" entry to the Instructor Guide, then runs `npm run guide` and commits the regenerated outputs. Check button labels and numbers against the code.
- After UI changes, run `npm run a11y` and check both light and dark mode. Keep `npm run smoke` passing.
- **Keep in-game wording subject-neutral.** LAB is used for any field. Player-facing game terms live in `src/labels.js` and must not use lab or science vocabulary; any theming comes from the instructor's question file. CSV codes such as `LAB_MISHAP` and `EMERGENCY_GRANT` are kept for data continuity.
