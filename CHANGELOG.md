# Changelog

Notable changes to Learn Around the Board (called Science Around the Board until October 2026). The live site is deployed automatically from `main` once CI passes (`.github/workflows/deploy.yml`); dates are deploy dates. The instructor-facing summary is the *What's new* section of the [Instructor Guide](guide/instructor-guide.md).

## Unreleased: public release preparation (October 2026)

### Security: results address, shared computers, online codes
- `readConfig` uses `results_url` only when it is a Google Apps Script Web app (`COLLECTOR_URL` in `src/config.js`); the validators (JS and Python) report any other address as an error. A shared question file can no longer route students' results to another server.
- The start page names the course a file sends results for and the site a linked file came from; the end screen names the course next to Send.
- Sending or downloading results deletes the autosaved game and stops saving it (shared computers).
- Room codes and device tokens use `crypto.getRandomValues` (`secureRandom` in `src/online/protocol.js`).

### New name: Learn Around the Board (LAB)
- The game, guides, skill (`lab-question-writer`), plugin marketplace (`lab`), files (`LAB_*_Guide.pdf`, `lab_results_*.csv`, `lab-results-collector.gs`, `examples/16S_QIIME2_demo.tsv`) and the site address (`/Learn-Around-the-Board/`) use the new name. Old `.lock` files (`SAB-LOCK-v2`) still open, and the results collector accepts submissions from older games.

### Solo against the bot, and the Enter fix
- Solo players can play the two-player rules against a bot (Easy, Medium, Hard; `src/bot.js`, levels sized with `scripts/bot-sim.mjs`). Its turns show its question, answer and explanation; Skip ahead speeds them up. Its answers are never logged; its `GAME_RESULT` row has a new `bot` column.
- Fixed: Enter on a typed answer also pressed the next button (skipping the explanation, or buying the tile).

### Online play (beta)
- Players can join from their own devices with a room code (`?join=`): the host's browser runs the game and devices connect peer-to-peer through PeerJS (WebRTC). Per-device surveys, read-only views for watchers, reconnects, host Resume, names sent from devices. Local play is unchanged; online code loads only when chosen. New tests: `tests/online.test.js`, the `online` smoke scenario, online screens in `a11y`, and a privacy check that local play opens no connection.

### Gameplay (changes scores)
- Starting cash by number of players: $2,500 solo, $2,000 / $1,500 / $1,250 each for 2 / 3 / 4 players (from a 3,000-game simulation per setting).
- A rival milestone's fee is $250; a core tile's rent is $50 per core tile its owner holds (up to $200).
- In-game wording says "player" instead of "team" (Red Player, Solo Player, "you pay…").
- Questions: unseen ones first; a question answered wrongly returns about 6 turns later (`src/questionPicker.js`), for tiles, exams, chaos challenges and the Rescue Quiz.
- Economy: property rent ×2.5 (50% of the price).
- Net worth counts money actually spent: each tile at what its owner paid, each upgrade once per group (it was counted once per tile). Liquidation returns half of what was paid, consistently.
- Chaos: complete sets can't be challenged; the token is spent and the turn ends either way; Challenge is disabled when the team can't pay.
- Short answers: one typo is forgiven only in answers of 8+ characters and never in the first letter or a number.
- A new game opens with the quick rules (**How to play**); the start page has a **Quick rules** link. The setup screen says "players" instead of "teams".

### CSV
- Survey `selectedIndex` is the option number in the question file (1–4) rather than the on-screen position; `TRANSACTION` rows have a `timestamp`.

### Content
- The demo's five figures were redrawn from synthetic data (`scripts/make-demo-images.py`, `sab_*.png`); the 11 earlier hosted images of uncertain origin are no longer served.

### Changed
- **New `.lock` encryption.** The encryptor now uses PBKDF2-SHA256 (600,000 rounds) and AES-256-GCM through the browser's Web Crypto API, and says honestly what it protects against. Existing `.lock` files still open. The encryptor no longer loads a script from a CDN and works offline.
- **Updates reach players reliably.** An open page checks for a new deploy every 30 minutes and when the tab is focused again. An empty start page reloads into the new version by itself; during a session a notice offers **Reload** instead of interrupting the game.
- Faster first load: the board code, the confetti and the legacy decryption code load separately, and the demo images are about a third smaller.
- The results collector script (version 2) limits submission size, rows, columns and submissions per minute, and shortens very long text.
- Choosing **No thanks** after allowing analytics now switches Google Analytics off at once and deletes its cookies. Analytics no longer receives a game link's query string.
- Instructor email addresses containing `?`, `&`, `,` and similar characters are rejected, so they can't add recipients to the email draft. CSV cells starting with a tab or carriage return are also neutralised.

### Added
- A Content-Security-Policy on the app and the encryptor; link previews (Open Graph and Twitter cards), a canonical URL and a meta description; a `404.html` that sends old or mistyped links to the game, keeping `?deck=`.
- An error screen with **Reload** instead of a blank page.
- `npm run privacy` (consent, share-link and CSP checks) and an `update` smoke-test scenario.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CITATION.cff`, issue and pull-request templates, and Dependabot.

### Removed
- Old code backups (`BackupCode/`), the unused Docusaurus site (`website/`) and an outdated README image. They held the last traces of the project's old name.

## 2026-10-05
Results to the instructor (Google Sheet, email, download), shareable game links, autosave and resume, install as an app and offline play, demo fixes, subject-neutral wording, dark mode, the redesigned board, new question formats, the file checker, the question-writer skill and the Intro Statistics example. See the guide's *What's new*.

## 2026-03-05
The March 2026 edition of the Instructor Guide (archived in `public/archive/`).

## 2025-12-08
First version, built for UBC MICB 475.
