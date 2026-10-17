# LAB question file format

Contents: 1. How the file becomes a board · 2. Columns · 3. Row types · 4. Answer formats · 5. Recommended counts · 6. JSON schema for build_tsv.py · 7. Gotchas · 8. Config rows (instructor settings) · 9. Language, and what the game can't do

## 1. How the file becomes a board

- The game filters rows by the `bigTopic` and `module` the players pick. A **blank** `bigTopic` or `module` cell means "use in every game". Both cells accept comma-separated lists (`Week 3, Week 4`) to reuse a row in several games.
- Within a game, the **first 4 distinct `theme` values** (in file order, counting only `property` and `milestone` rows) become the 4 board sides. Extra themes are ignored. With fewer than 4, the board is broken.
- In each theme, the **first 2 distinct `subtheme` values** among its `property` rows become two colour groups of 3 tiles each. Group 1 tiles cost $100 and group 2 tiles cost $160. Each tile draws a random question from its subtheme's pool.
- Each side's corner is a **milestone**: a 6-question exam (5 correct to capture) drawn from that theme's `milestone` rows.
- Each side has one **core** tile, with questions drawn from all `core` rows, and one **Wildcard** tile, which draws a random `mishap` row (a "wildcard").
- `survey` rows form the pre- and post-game knowledge check: 10 random questions per player, and the same set again after the game. `confidence` rows become 0–10 sliders, shown before and after.
- `core`, `mishap`, `survey` and `confidence` rows are filtered by `bigTopic`/`module` too, so every game needs its own (or rows shared with a blank cell or a comma list).
- **Order matters**: put the rows for theme 1 first, then theme 2, and so on. Within each theme, list subtheme 1 before subtheme 2.

## 2. Columns

The header row must be exactly these names; they are case-sensitive. Column order doesn't matter, but build_tsv.py writes this order:

| column | used by | meaning |
|---|---|---|
| `id` | all | unique, stable id (e.g. `prop_t1s1_01`) |
| `question` | all | prompt text (for mishaps, the event text) |
| `option1`–`option4` | mcq, multi, order | answer options. For true/false, fill only 1–2 |
| `correctIndex` | mcq, multi | mcq: `1`–`4`. multi: list such as `1,3` |
| `explanation` | all | shown after answering (for mishaps: the fun fact or lesson) |
| `bigTopic` | all | main-menu topic |
| `module` | all | sub-menu module |
| `theme` | property, milestone | board side |
| `subtheme` | property (milestone optional) | property group within the side. For `core` rows, the first core row's subtheme names the core tile |
| `type` | all | `property`, `milestone`, `core`, `mishap`, `survey`, `confidence`, `config` (lowercase) |
| `imageFile` | optional | exact image filename, or an https URL (prefer files: a link makes every student's browser contact that site and breaks silently) |
| `format` | optional | `mcq` (default if blank), `multi`, `numeric`, `order`, `text` |
| `answer` | numeric, text | numeric: the number. text: accepted answers separated by `|` |
| `tolerance` | numeric | blank means exact; `0.5` is ± absolute; `5%` is ± relative |

## 3. Row types

- `property`: needs `theme` and `subtheme`. A recall or understanding question.
- `milestone`: needs `theme`. A synthesis or application question.
- `core`: the cross-cutting skill. `theme` is free text (e.g. `Core`), and `subtheme` names the tile (e.g. `UNIX`).
- `mishap`: `question` = event text with an explicit amount, e.g. `Freezer failure! Samples thawed. (-$100)` or `Scholarship awarded! (+$150)`. The game charges or pays exactly that amount. `explanation` = fun fact. No options are needed. Theme the text as the instructor chose (the subject, or general study life); the game's own wording is neutral. Keep the `$` and the sign in the amount, whatever the course's currency or language: that is what the game reads.
- `survey`: knowledge-check question in any format. `theme` and `subtheme` are optional (handy for your own analysis).
- `confidence`: `question` = a statement such as "I am confident I can explain …". No options are needed.
- `config`: an instructor setting, not a question: `id` = the setting name, `question` = its value. See section 8.

## 4. Answer formats

Every format is marked simply correct or incorrect.

| format | fill in | students see | marked correct when |
|---|---|---|---|
| `mcq` | option1–4, `correctIndex` | shuffled buttons | they click the right option |
| true/false | option1 `True`, option2 `False` (in the course's language), `correctIndex` | two buttons | as mcq |
| `multi` | option1–4, `correctIndex` like `1,3` | checkboxes plus Submit | the selection matches **exactly** |
| `numeric` | `answer` (e.g. `1500`), optional `tolerance` | number box | within tolerance (`1,500`, `1 500` and a decimal comma such as `2,5` all work) |
| `order` | option1–4 **in the correct order** | shuffled list with ↑/↓ buttons | the order matches exactly |
| `text` | `answer` e.g. `beta|beta diversity|β` | text box | it matches an accepted answer, ignoring case, accents, punctuation and extra spaces. One typo is forgiven on answers of 8 or more characters, but not in the first letter, a number or a Roman numeral ("type ii" is never accepted for "type i"), so short terms such as `alkane` must be exact |

Tips:
- **multi**: vary the number of correct options across the file (1, 2, 3, occasionally all 4); no single count should cover more than about half of the multi items, or students learn to "tick two". The game already shows "Select all that apply." under the question, so don't say how many are correct. The validator's `Select-all questions:` line shows the counts.
- **numeric**: state units in the prompt ("in base pairs") and, for any non-integer answer, the rounding ("to one decimal place"). The box accepts a unit after the number ("12 kg", "0.5 mL", "25 °C" count as the number) and "2e4", "20 000", "0,5" and "50%", but rejects "2 × 10⁴" and a unit before the number. For powers of ten, ask for the number in a stated unit ("in units of 10⁶ M⁻¹ s⁻¹"). If the tolerance is generous (dates within 5 years), say so in the stem. Use tolerance `0` when the rounding is being tested and a tolerance for estimates or values read from a plot. Give every constant or table value the calculation needs in the stem.
- **text**: keep answers to 1–3 words and list every reasonable synonym. Accents, case and punctuation are already ignored, so don't list accent variants; do list the plural of answers under 8 letters. Avoid free-response questions with many valid phrasings, and give a word-count hint ("two words") only if every accepted answer has that count.
  - Don't use `text` when changing one letter gives a different, wrong term of 8 or more letters (absorption/adsorption): the typo rule would accept it. Numbers and Roman numerals are safe (Type I/Type II, Photosystem I/II). Use multiple choice; the validator warns about these.
  - Code output with brackets or quotes (`[1, 2]` vs `(1, 2)`) can't be told apart once punctuation is ignored; use multiple choice.
- **order**: 3–4 steps with one unambiguous sequence. When steps could be done in either order (two multiplications), make each step name its input ("divide the daily dose by 3"). Don't let a step quote the previous step's result, or students can chain the numbers instead of knowing the method.
- **true/false**: balance True and False about 50/50, and use absolute words ("always", "never") in true statements as often as in false ones.

## 5. Recommended counts (per bigTopic/module game)

**Hard limits** (validator ERROR; the board breaks): at least 4 themes per game (only the first 4 are used), each with at least 1 property row and 1 milestone row. **Everything else below is a recommendation.** With less, the game still loads and plays but repeats questions sooner (validator WARNING), so say "too few to play well", never "won't load".

| per game | 45 min | 60 min | 90 min | why |
|---|---|---|---|---|
| property, per subtheme | 6 | 8 | 10 | each subtheme pool feeds 3 tiles; the busiest pool is asked about 8 times an hour |
| milestone, per theme | 8 | 8 | 10 | each exam asks 6, and each side's exam is taken 1–3 times |
| core | 6 | 8 | 10 | shared by 4 tiles |
| mishap | 6 | 8 | 8 | variety keeps wildcard tiles fun |

Whatever the length: **survey** 15 rows for 1–2 players and 20 for 3–4 (each player draws 10, and a bigger pool varies the sets between players), and **confidence** (optional; ask the instructor) 4–5 statements (one per theme, plus the core skill if it is an LO; up to 8 when there are more LOs, see SKILL.md §3).

Use the nearest column and interpolate for other lengths. The numbers assume roughly one turn per minute for the whole table. Players share one computer and take turns, so the number of questions asked depends on time, not on player count; player count only changes the survey pool. The game prefers unseen questions and asks a missed one again later, so some repetition is deliberate.

## 6. JSON schema for build_tsv.py

A JSON list. Each object uses the column names above; any omitted key becomes blank. You may use `options` (a list of up to 4) instead of option1–4, and `correct` instead of `correctIndex`:

```json
[
  {"id": "prop_t1s1_01", "type": "property", "theme": "Sequencing basics", "subtheme": "Library prep",
   "question": "What is the main purpose of adding adapters during library preparation?",
   "options": ["To let fragments bind the flow cell and primers", "To remove PCR duplicates", "To fragment the DNA", "To label samples by species"],
   "correct": 1,
   "explanation": "Adapters contain the sequences that hybridise to the flow cell and prime sequencing. Duplicates are removed bioinformatically, not by adapters."},
  {"id": "prop_t1s2_04", "type": "property", "format": "numeric", "theme": "Sequencing basics", "subtheme": "Read quality",
   "question": "A Phred score of Q30 corresponds to an error probability of 1 in how many base calls?",
   "answer": 1000, "explanation": "Q = -10·log10(P), so Q30 means P = 0.001, or 1 error in 1,000 calls."},
  {"id": "mis_01", "type": "mishap", "question": "Someone left the -80 °C freezer open overnight! (-$100)",
   "explanation": "Repeated freeze-thaw cycles fragment DNA and degrade enzymes; aliquot your reagents."}
]
```

Pass `--bigTopic` and `--module` to build_tsv.py to fill those columns on every row that leaves the key out (config rows excepted). Write `"module": ""` to keep a row shared by every game. For a file with several games, set both per row.

To edit an existing file, convert it first: `python build_tsv.py --to-json old.tsv old.json` keeps every column, and rebuilding gives back the same cells.

## 7. Gotchas

- No tabs or line breaks inside cells; build_tsv.py replaces them with spaces.
- Keep `type` values lowercase (the game accepts other cases, but the validator warns).
- Correct answers must not depend on option position ("both A and C"), because options are shuffled. Use the `multi` format instead.
- Avoid "All of the above" and "None of the above" for the same reason, and never refer to "option C" in an explanation; name the option's content instead.
- Spreadsheets turn a cell that starts with `-`, `+`, `=` or `@` into a formula, so `--p-sampling-depth` becomes `#NAME?` or `#ERROR!` after a round trip through Excel or Google Sheets. Start the cell with a word, or wrap commands and flags in backticks (`` `--p-sampling-depth` ``). The validator warns about such cells before the damage, and reports `#NAME?`, `#ERROR!` and similar values as errors after it. Backticks show as typed in the game (they aren't rendered), which reads fine for code.
- A cell that starts and ends with a straight quote (a code option such as `"w"`) is written by build_tsv.py in spreadsheet form and reads back exactly.
- Code must fit on one line. Use one-line statements (`for i in range(3): print(i)`) or describe the structure in words, or show longer code as an image; in Python, a compound statement can't follow `;`, so check that one-lined code still runs.
- A cell that starts with an apostrophe (quoted speech, a Python string such as `'abc'`) may lose it in a spreadsheet, which treats a leading apostrophe as its "keep as text" mark. Use double quotes for speech and backticks for code; the validator warns about these cells.
- Times, ratios and fractions (`3:00 p.m.`, `1:50,000`, `3/4`) may turn into times or dates in a spreadsheet. Check them after editing there, or write them in words ("a scale of 1 to 50,000").
- Unicode subscripts, superscripts and symbols (H₂O, 10²³, β, →) display fine; avoid `^` and `_` markup.
- Keep prompts under about 300 characters; players read them aloud under time pressure.
- An encrypted `.lock` file can't be validated. Validate the plain `.tsv` first, then encrypt.

## 8. Config rows (instructor settings)

Optional rows that set up how results reach the instructor. Put the setting name in `id`, its value in `question` and `config` in `type`, and leave the other columns blank. Settings apply to the whole file, whatever topic and module the players pick (build_tsv.py leaves `bigTopic` and `module` blank on config rows).

| `id` | value (`question` column) | effect |
|---|---|---|
| `results_url` | the collector's Web app URL, `https://script.google.com/macros/s/…/exec` | the end screen shows **Send results to instructor**, which adds each player's results to the instructor's Google Sheet. A Google Form or Sheet link, a test `/dev` URL or any other address never works: the game ignores anything that isn't an Apps Script `/exec` link (validator ERROR) |
| `instructor_email` | an email address | the end screen shows **Email results to instructor**: it downloads the results file and opens a pre-addressed email; students attach the file |
| `course` | e.g. `BIOL 301 – Week 5` | labels the results (Sheet rows and the email subject) |
| `ask_names` | `yes` or `no` | `yes`: the end screen marks the "names or student IDs" boxes as required and keeps **Send**, **Email** and **Download** disabled until every player's box is filled, so it works with download-only results too. `no`: the boxes are optional. Default: `yes` when `results_url` or `instructor_email` is set. The game can't ask for student numbers rather than names; tell students which to type |

Without config rows, students simply download the results file (CSV) and submit it as the instructor asks.

JSON for build_tsv.py:

```json
[
  {"id": "results_url", "type": "config", "question": "https://script.google.com/macros/s/AKfy…/exec"},
  {"id": "instructor_email", "type": "config", "question": "prof@university.edu"},
  {"id": "course", "type": "config", "question": "BIOL 301 – Week 5"}
]
```

**Setting up the Google Sheet collector** (once per course, about 5 minutes):

1. Create a Google Sheet, for example "LAB results – BIOL 301".
2. Choose Extensions → Apps Script. Delete the sample code, paste the collector script from https://hghezzi.github.io/Learn-Around-the-Board/tools/lab-results-collector.gs and save.
3. Choose Deploy → New deployment, select type **Web app**, set Execute as: **Me** and Who has access: **Anyone**, then Deploy and authorize.
4. Copy the Web app URL (it ends in `/exec`) into a `results_url` config row.
5. Test: play a quick solo game with the file and click **Send results to instructor**. A "Summary" tab (one row per player) and a "Details" tab (every answer and transaction) appear in the Sheet.
6. If the script is edited later, use Deploy → Manage deployments → Edit → Version: New version, so the URL stays the same.

Notes:
- Anyone who has the link can send data to the Sheet, so treat it like an unlisted form link. The collector only accepts game submissions and stops typed text from becoming formulas.
- A plain `.tsv` shows its config rows to anyone who opens it. Encrypt the file (`.lock`) if the address or link shouldn't be visible.
- Take the URL and address only from the instructor's own message, read them back, and check the validator's `Results are sent to:` line before delivery: it shows exactly where the game will send results and whether the name boxes are required.
- What is sent: the names or IDs students type (the boxes are always shown; required when `ask_names` is on, optional otherwise), each player's pre/post survey score and rank, and every answer and transaction row. The email subject also lists the players' names.
- If an institution doesn't allow Google services for student data, use `instructor_email` or plain downloads instead, and ask students to type student numbers or initials rather than full names if required.

## 9. Language, and what the game can't do

Facts to state accurately; don't promise more.

**Language.** Everything the file contains (themes, subthemes, menu names, questions, options including True/False, explanations, wildcards, survey and confidence statements) can be in any language, and should all be in the course's language. The game's own interface (buttons, rules, tile names, survey and end screens) is **English only** and not yet configurable. Typed answers ignore accents (`nitrificacion` matches `nitrificación`), numeric answers accept a decimal comma (`1,26`), and wildcard amounts keep the `(-$100)` form (in Mexico and much of Latin America `$` is also the peso sign).

For a non-English class, offer a glossary of the on-screen terms, translated with their meaning:

| on screen | meaning |
|---|---|
| Pre-Game Survey / Post-Game Survey | the knowledge check and confidence sliders before and after play |
| How to play | the quick rules |
| Roll | roll the dice and move |
| Buy / Skip | buy the tile after a right answer, or pass |
| Upgrades / Upgrade | raise the rent of a complete colour group |
| Core tile | the cross-cutting skill tile (one per side) |
| Milestone (6-question exam) / Start exam | a corner: 5 of 6 right captures it |
| Rival's milestone | a corner another player owns; you pay a fee |
| Wildcard | a random event that adds or takes money |
| Chaos token | earned at a milestone; spend it to challenge for a rival's tile |
| Lap bonus | +$200 for passing START |
| Out of money! / Bankrupt! / Rescue Quiz | selling first, then one 3-question quiz (2 right keeps you in) |
| Select all that apply. / Enter a number. / Type your answer. / Use the arrows to put the items in the correct order. | the hint under each answer format |
| Submit answer | check the answer |
| Time's up / End game / Final Standings | the session timer, ending early, and the ranking by net worth |
| Session complete / Who played? | the end screen, and the boxes for names or student IDs |
| ⬇ Download results (CSV) / Send results to instructor / Email results to instructor | the ways to hand in results |
| Exit session / Back to main menu | leave the game |

**Requests the game can't do**, with the closest alternative:

| request | what the game does | offer instead |
|---|---|---|
| more than 4 themes (e.g. one per week) | uses the first 4 themes and ignores the rest | map the weeks to the 8 subthemes, or split into two games (modules) |
| partial credit | every format is marked all-or-nothing | smaller select-all items (4 short options, each one checkable fact); the CSV has every response for re-scoring by hand |
| one format everywhere | works, but milestones need 5 of 6 right, so an all-multi or all-numeric corner is very hard | the instructor's format as the largest share, with multiple choice in the milestones |
| buttons in another language, another currency, renamed tiles | not configurable yet | content in their language, the glossary above, `$` amounts |
| image descriptions for screen readers | every figure gets the same generic alt text | state what the question needs in the stem; keep figure-only items few |
| very few questions | loads, but repeats questions within a session and within exams | the counts in §5, or keep their number for one part (e.g. the survey) |

