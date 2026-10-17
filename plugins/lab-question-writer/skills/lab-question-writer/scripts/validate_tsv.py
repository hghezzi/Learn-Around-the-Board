#!/usr/bin/env python3
"""Validate a Learn Around the Board question file (TSV).

Usage:
    python validate_tsv.py questions.tsv [--images images/] [--json]

A standard-library mirror of the game's own checker (src/tsvValidator.js and
src/itemQuality.js in the LAB repository), plus authoring stats (answer-position
balance, image files). It also measures answer cues: how often a student who
always picks the longest (or shortest) option, or the option that repeats the
question's words, would be right, compared with chance; how many correct options
the select-all questions have; cells a spreadsheet would turn into formulas; and
short answers the game would also accept for a different term. Cue statistics
are reported per game when the file holds several. The report ends with the
"Results are sent to:" line, which says where the game sends student results.
Exit code 1 if any ERROR is found.
"""
import argparse
import json
import math
import os
import re
import sys
import unicodedata
from collections import Counter

KNOWN_TYPES = ["property", "milestone", "core", "mishap", "survey", "confidence", "config"]
CONFIG_KEYS = ["results_url", "instructor_email", "course", "ask_names"]
_EMAIL_CHAR = r"[^@\s?&#%,;:<>\"'()\[\]\\/]"  # mirrors EMAIL_PATTERN in src/config.js
EMAIL_RE = re.compile(rf"^{_EMAIL_CHAR}+@{_EMAIL_CHAR}+\.{_EMAIL_CHAR}+$")
QUIZ_TYPES = ["property", "milestone", "core", "survey"]
REQUIRED = ["id", "question", "type"]
QUIZ_HEADERS = ["option1", "option2", "option3", "option4", "correctIndex", "explanation"]
BOARD_HEADERS = ["theme", "subtheme"]
FILTER_HEADERS = ["bigTopic", "module"]
OPTIONAL = ["imageFile", "format", "answer", "tolerance"]
FORMATS = ["mcq", "multi", "numeric", "order", "text"]
FORMAT_ALIASES = {
    "": "mcq", "mc": "mcq", "mcq": "mcq", "multiple choice": "mcq", "tf": "mcq", "true/false": "mcq",
    "multi": "multi", "multiselect": "multi", "multi-select": "multi",
    "numeric": "numeric", "number": "numeric",
    "order": "order", "ordering": "order", "sequence": "order",
    "text": "text", "short": "text", "short text": "text",
}
SIDES, SUBS, MILESTONE_Q, SURVEY_Q = 4, 2, 6, 10


def parse_tsv(text):
    """Same rules as the game: skip blank and '#' lines, split on tabs, unwrap quotes."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [l for l in text.split("\n") if l.strip() and not l.strip().startswith("#")]
    if not lines:
        return [], []
    headers = [h.strip() for h in lines[0].split("\t")]
    rows = []
    for ln in lines[1:]:
        cols = ln.split("\t")
        row = {}
        for i, h in enumerate(headers):
            v = cols[i].strip() if i < len(cols) else ""
            if len(v) >= 2 and v.startswith('"') and v.endswith('"'):
                v = v[1:-1].replace('""', '"')
            row[h] = v
        rows.append(row)
    return headers, rows


def parse_list(s):
    return [x.strip().strip('"') for x in s.split(",")] if s else []


def matches(row, topic, module):
    rt = (row.get("bigTopic") or "").strip()
    if topic and rt and topic not in parse_list(rt):
        return False
    rm = (row.get("module") or "").strip()
    if module and rm and module not in parse_list(rm):
        return False
    return True


def ordered_unique(items):
    out = []
    for x in items:
        if x and x not in out:
            out.append(x)
    return out


SPACES = "\s\u00a0\u202f\u2009"


def parse_number(v):
    """Mirror of parseNumber in src/questionFormats.js: numbers as people type them.

    "1,500" / "1 500" / "1,000.5" use thousands separators (groups of 3 digits);
    "2,5" / "0,05" / "1.000,5" use a decimal comma; "−5" (Unicode minus) and "1e-3"
    work. Ambiguous mixes such as "1,2.3" are rejected. Returns None if not a number.
    """
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    s = re.sub("[\u2212\u2012\u2013\ufe63\uff0d]", "-", str(v if v is not None else "").strip())
    if re.fullmatch(f"[-+]?[0-9]{{1,3}}([{SPACES}][0-9]{{3}})+([.,][0-9]+)?", s):
        s = re.sub(f"[{SPACES}]", "", s)
    comma, dot = s.rfind(","), s.rfind(".")
    if comma >= 0 and dot >= 0:
        if comma > dot and re.fullmatch(r"[-+]?[0-9]{1,3}(\.[0-9]{3})+,[0-9]+", s):
            s = s.replace(".", "").replace(",", ".", 1)
        elif dot > comma and re.fullmatch(r"[-+]?[0-9]{1,3}(,[0-9]{3})+\.[0-9]+", s):
            s = s.replace(",", "")
        else:
            return None
    elif comma >= 0:
        if re.fullmatch(r"[-+]?[1-9][0-9]{0,2}(,[0-9]{3})+", s):
            s = s.replace(",", "")
        elif re.fullmatch(r"[-+]?[0-9]*,[0-9]+", s):
            s = s.replace(",", ".", 1)
    if not re.fullmatch(r"[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)(e[-+]?[0-9]+)?", s, re.I):
        return None
    return float(s)


def normalize_text(s):
    """Mirror of normalizeText: drop accents and punctuation, lowercase, collapse spaces."""
    s = unicodedata.normalize("NFKD", str(s if s is not None else ""))
    s = "".join(ch for ch in s if not ("\u0300" <= ch <= "\u036f")).lower()
    s = "".join(ch if unicodedata.category(ch)[0] in "LN" or ch.isspace() else " " for ch in s)
    return " ".join(s.split())


def parse_index_list(v):
    """Mirror of parseIndexList: unique 0-based indices from "1,3"; None marks an invalid entry."""
    parts = [p for p in re.split(r"[,;|\s]+", str(v if v is not None else "")) if p]
    vals = {(n - 1) if n is not None else None for n in (js_parse_int(p) for p in parts)}
    return sorted(vals, key=lambda x: (x is None, x if x is not None else 0))


def js_parse_int(v):
    """parseInt(v, 10) from JavaScript: the leading integer, or None."""
    m = re.match(r"\s*([-+]?[0-9]+)", str(v if v is not None else ""))
    return int(m.group(1)) if m else None


def tolerance_ok(v):
    s = str(v or "").strip()
    if not s:
        return True
    if s.endswith("%"):
        s = s[:-1]
    n = parse_number(s)
    return n is not None and n >= 0


def explicit_amount(text):
    s = text or ""
    return bool(re.search(r"[+\-−]\s*\$\s*\d", s) or re.search(r"\(\s*[+\-−]\s*\d[\d,]*\s*\)", s))


# Links instructors often paste instead of the collector's Web app URL; they can never work.
NOT_A_COLLECTOR = re.compile(r"^https://(?:docs\.google\.com/(?:forms|spreadsheets)/|forms\.gle/|script\.google\.com/.*/dev(?:[?#/]|$))", re.I)
# The only results address the game uses (mirror of COLLECTOR_URL in src/config.js).
COLLECTOR = re.compile(r"^https://script\.google\.com/(?:a/macros/[^/]+|macros)/s/[^/?#]+/exec(?:[?#]|$)", re.I)


def check_config(r, label, errors, warnings):
    """Instructor settings (type = config): setting name in `id`, value in `question`."""
    key = (r.get("id") or "").strip().lower()
    value = (r.get("question") or "").strip()
    if key not in CONFIG_KEYS:
        warnings.append(f"Unknown config setting {label} will be ignored. Valid settings: {', '.join(CONFIG_KEYS)}.")
        return
    if not value:
        errors.append(f'Config "{key}" has no value; put the value in the question column.')
        return
    if key == "results_url":
        if not re.match(r"^https://", value, re.I):
            errors.append('Config "results_url" must be an https:// link (the Web app URL from Google Apps Script).')
        elif NOT_A_COLLECTOR.match(value):
            errors.append('Config "results_url" is a Google Form, Google Sheet or test (/dev) link, not the collector\'s Web app URL (https://script.google.com/macros/s/…/exec), so "Send results to instructor" would fail. Follow the collector setup and copy the Web app URL that ends in /exec.')
        elif not COLLECTOR.match(value):
            errors.append('Config "results_url" isn\'t a Google Apps Script Web app link (https://script.google.com/macros/s/…/exec). The game sends results only to the LAB collector and ignores any other address, so "Send results to instructor" won\'t appear.')
    if key == "instructor_email" and not EMAIL_RE.match(value):
        errors.append('Config "instructor_email" is not a valid email address.')
    if key == "ask_names" and value.lower() not in ("yes", "no", "y", "n", "true", "false", "1", "0"):
        warnings.append('Config "ask_names" should be yes or no.')


def summarize(labels, n=5):
    return ", ".join(labels) if len(labels) <= n else ", ".join(labels[:n]) + f" and {len(labels) - n} more"


# ---------- Answer-option quality (mirror of src/itemQuality.js) ----------
# Same rules, thresholds and messages as the game's checker; keep them in step.
# Students play one game (bigTopic + module) at a time, so when a file holds several
# games the statistical cues are measured per game; single-row checks are file-wide.
BOARD_TYPES = ["property", "milestone", "core"]
MIN_CUE_ITEMS, CUE_MARGIN, Z_95 = 10, 0.1, 1.645
LONG_RATIO, LONG_MIN_GAP = 1.5, 10
MIN_ABSOLUTE_OPTIONS, SURVEY_DUP_JACCARD = 6, 0.6
MIN_MULTI_ITEMS, MULTI_COUNT_SHARE = 6, 0.7
TYPO_MIN_LENGTH = 8  # mirrors TYPO_MIN_LENGTH in src/questionFormats.js
# English, then Spanish, French and Portuguese (accents are removed before matching).
ABSOLUTE_WORDS = [
    "always", "never", "all", "none", "only", "every", "must", "cannot", "impossible",
    "completely", "entirely", "totally", "absolutely", "guaranteed", "guarantees",
    "siempre", "nunca", "jamas", "solo", "solamente", "unicamente", "exclusivamente", "totalmente", "todos", "todas",
    "ninguno", "ninguna", "ningun", "nada", "nadie", "imposible",
    "toujours", "jamais", "seulement", "uniquement", "tous", "toutes", "aucun", "aucune",
    "sempre", "apenas", "somente", "nenhum", "nenhuma", "impossivel",
]
STOPWORDS = set("""
about after also among another because been before being best between both does doing each either
from have having here into just least less like many more most much must need only other over same
should show some such than that their them then there these they this those through under used using
very were what when where which while will with would your following true false statement
""".split())
SPREADSHEET_ERROR = re.compile(r"^#(?:NAME\?|REF!|VALUE!|DIV/0!|N/A|NUM!|NULL!|SPILL!|CALC!|ERROR!)$", re.I)
OPTION_REFERENCE = [
    re.compile(r"\b(?:all|none|both|neither)\s+of\s+(?:the\s+)?(?:above|below|these|those|the\s+(?:other\s+)?(?:options|answers|choices))\b", re.I),
    re.compile(r"\b(?:[Oo]ptions?|[Aa]nswers?|[Cc]hoices?)\s+[A-D1-4]\b"),
    re.compile(r"\b(?:[Bb]oth|[Ee]ither|[Nn]either|[Oo]nly)\s+[A-D]\s+(?:and|or|nor)\s+[A-D]\b"),
    re.compile(r"\b(?:todas|ninguna|nenhuma)\s+(?:(?:de|das|dos)\s+)?(?:(?:las|as|os)\s+)?(?:anteriores|opciones|alternativas)\b", re.I),
]
TEXT_CELLS = ["question", "option1", "option2", "option3", "option4", "explanation", "answer"]
ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"]  # mirrors ROMAN_NUMERALS in src/questionFormats.js


def js_round(x):
    """Math.round from JavaScript (Python's round() rounds halves to even)."""
    return int(math.floor(x + 0.5))


def pct(x):
    return js_round(100 * x)


def words(text):
    """Words in any script: accents and punctuation removed, as the game does for typed answers."""
    return [w for w in normalize_text(text).split(" ") if w]


def content_words(text):
    """Content words: 4+ characters, not a function word, with a plural "s" removed."""
    out = set()
    for w in words(text):
        if len(w) < 4 or w in STOPWORDS:
            continue
        out.add(w[:-1] if len(w) > 4 and w.endswith("s") else w)
    return out


def has_absolute(text):
    return any(w in ABSOLUTE_WORDS for w in words(text))


def leading_apostrophe(value):
    """Text whose leading apostrophe a spreadsheet may take as its "keep as text" mark and drop."""
    return (value or "").strip().startswith("'")


def formula_prone(value):
    """Text a spreadsheet would turn into a formula: starts with - + = @, and isn't just a number."""
    s = (value or "").strip()
    return len(s) >= 2 and s[0] in "-+=@" and parse_number(re.sub(r"%$", "", s)) is None


def edit_distance(a, b):
    dp = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, dp[0] = dp[0], i
        for j in range(1, len(b) + 1):
            tmp = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (0 if a[i - 1] == b[j - 1] else 1))
            prev = tmp
    return dp[len(b)]


def text_accepts(response, answers):
    """Mirror of checkAnswer for the text format in src/questionFormats.js."""
    got = normalize_text(response)
    if not got:
        return False
    for a in answers:
        want = normalize_text(a)
        if got == want or got.replace(" ", "") == want.replace(" ", ""):
            return True
        digits = lambda t: re.sub(r"[^0-9]", "", t)  # noqa: E731
        romans = lambda t: " ".join(w for w in t.split(" ") if w in ROMAN)  # noqa: E731
        if (len(want) >= TYPO_MIN_LENGTH and got[0] == want[0] and digits(got) == digits(want)
                and romans(got) == romans(want)
                and abs(len(got) - len(want)) <= 1 and edit_distance(got, want) <= 1):
            return True
    return False


def text_near_miss(r, terms):
    """First near miss the game would also accept (mirror of textNearMiss in src/itemQuality.js).

    Another term from the file one letter different from an accepted answer ("adsorption"
    for "absorption"). Numbers and Roman numerals must match exactly in the game. Terms that
    only add or drop a letter ("safer" for "safe") are left alone.
    """
    answers = [a.strip() for a in str(r.get("answer") or "").split("|") if a.strip()]
    own = [x for x in (normalize_text(a) for a in answers) if x]
    if not own:
        return None

    def same_term(c):
        return any(c == a or c.replace(" ", "") == a.replace(" ", "") for a in own)

    candidates = [c for c in (normalize_text(t) for t in terms) if any(len(a) == len(c) for a in own)]
    seen = set()
    for c in candidates:
        if not c or c in seen:
            continue
        seen.add(c)
        if not same_term(c) and text_accepts(c, answers):
            return c
    return None


def fmt_num(x):
    """Format like JavaScript's String(number): 1.5 -> '1.5', 2.0 -> '2'."""
    return str(int(x)) if float(x).is_integer() else str(x)


def strategy_score(picked, correct):
    return 1 / len(picked) if correct in picked else 0


def new_tally():
    return {"items": 0, "score": 0.0, "chance": 0.0, "variance": 0.0}


def add_to_tally(t, score, n):
    t["items"] += 1
    t["score"] += score
    t["chance"] += 1 / n
    t["variance"] += (1 / n) * (1 - 1 / n)


def cue_margin(t):
    return max(CUE_MARGIN * t["items"], Z_95 * math.sqrt(t["variance"]))


def beats_chance(t):
    return t["items"] >= MIN_CUE_ITEMS and t["score"] - t["chance"] > cue_margin(t)


def below_chance(t):
    return t["items"] >= MIN_CUE_ITEMS and t["chance"] - t["score"] > cue_margin(t)


def jaccard(a, b):
    if len(a) < 3 or len(b) < 3:
        return 0
    shared = len(a & b)
    return shared / (len(a) + len(b) - shared)


def row_facts(r, label, t):
    """What one quiz row contributes to the statistical cue checks."""
    fmt = FORMAT_ALIASES.get((r.get("format") or "").strip().lower())
    options = [(r.get(f"option{k}") or "").strip() for k in range(1, 5)]
    options = [o for o in options if o]
    f = {"row": id(r), "label": label, "type": t, "format": fmt, "options": options,
         "stem_words": content_words(r.get("question") or ""), "mcq": None, "multi_correct": None}
    if fmt == "multi" and len(options) >= 3:
        idxs = parse_index_list(r.get("correctIndex"))
        if idxs and all(k is not None and 0 <= k < len(options) for k in idxs):
            f["multi_correct"] = len(idxs)
    if fmt != "mcq" or len(options) < 3:
        return f
    m = re.match(r"^\s*([-+]?\d+)", str(r.get("correctIndex") or ""))
    if not m:
        return f
    correct = int(m.group(1)) - 1
    if correct < 0 or correct >= len(options):
        return f
    n = len(options)
    lengths = [len(o) for o in options]
    longest_idx = [k for k, ln in enumerate(lengths) if ln == max(lengths)]
    shortest_idx = [k for k, ln in enumerate(lengths) if ln == min(lengths)]
    # Word-overlap cue: the option that echoes the question's wording.
    shared = [len(content_words(o) & f["stem_words"]) for o in options]
    overlap = None
    if max(shared) > 0:
        overlap = strategy_score([k for k, sh in enumerate(shared) if sh == max(shared)], correct)
    f["mcq"] = {
        "n": n, "correct": correct, "lengths": lengths, "longest_idx": longest_idx,
        "longest": strategy_score(longest_idx, correct), "shortest": strategy_score(shortest_idx, correct),
        "overlap": overlap, "absolute": [k for k, o in enumerate(options) if has_absolute(o)],
    }
    return f


def tally_cues(facts):
    """Statistical cues over one set of rows (the file, or one game)."""
    longest, shortest, overlap = new_tally(), new_tally(), new_tally()
    mile_longest, mile_shortest = new_tally(), new_tally()
    absolute = {"options": 0, "correct": 0, "chance": 0.0, "variance": 0.0}
    multi_counts, multi_items = {}, 0
    for f in facts:
        if f["multi_correct"]:
            multi_items += 1
            multi_counts[f["multi_correct"]] = multi_counts.get(f["multi_correct"], 0) + 1
        q = f["mcq"]
        if not q:
            continue
        n = q["n"]
        add_to_tally(longest, q["longest"], n)
        add_to_tally(shortest, q["shortest"], n)
        if f["type"] == "milestone":
            add_to_tally(mile_longest, q["longest"], n)
            add_to_tally(mile_shortest, q["shortest"], n)
        if q["overlap"] is not None:
            add_to_tally(overlap, q["overlap"], n)
        for k in q["absolute"]:
            absolute["options"] += 1
            if k == q["correct"]:
                absolute["correct"] += 1
            absolute["chance"] += 1 / n
            absolute["variance"] += (1 / n) * (1 - 1 / n)
    # Survey items that repeat a board item (the pre/post survey would measure memory of it).
    boards = [f for f in facts if f["type"] in BOARD_TYPES]
    survey_dups = []
    for s in (f for f in facts if f["type"] == "survey"):
        match = next((b for b in boards if jaccard(s["stem_words"], b["stem_words"]) >= SURVEY_DUP_JACCARD), None)
        if match:
            survey_dups.append(f"{s['label']} ≈ {match['label']}")
    return {"longest": longest, "shortest": shortest, "mile_longest": mile_longest, "mile_shortest": mile_shortest, "overlap": overlap, "absolute": absolute,
            "multi_counts": multi_counts, "multi_items": multi_items, "survey_dups": survey_dups}


def cue_warnings(t, prefix):
    warnings = []
    for which in ("longest", "shortest"):
        tally = t[which]
        rate = pct(tally["score"] / tally["items"]) if tally["items"] else 0
        chance = pct(tally["chance"] / tally["items"]) if tally["items"] else 0
        if beats_chance(tally):
            warnings.append(f"{prefix}Length cue: always picking the {which} option would answer {rate}% of the {tally['items']} multiple-choice questions correctly (chance is {chance}%). Vary which option is {which}, so that length gives nothing away.")
        elif below_chance(tally):
            warnings.append(f"{prefix}Length cue: always picking the {which} option would answer only {rate}% of the {tally['items']} multiple-choice questions correctly (chance is {chance}%), so students can rule the {which} option out. Vary which option is {which}, so that length gives nothing away.")
    # The milestone exam (5 of 6) is where a shape cue pays most, so its pool is checked on its own.
    for which in ("longest", "shortest"):
        tally = t[f"mile_{which}"]
        if not beats_chance(tally) and not below_chance(tally):
            continue
        only = "only " if below_chance(tally) else ""
        warnings.append(f"{prefix}Length cue in the milestone questions: always picking the {which} option would answer {only}{pct(tally['score'] / tally['items'])}% of the {tally['items']} milestone multiple-choice questions correctly (chance is {pct(tally['chance'] / tally['items'])}%). Vary which option is {which} within the milestone pools too.")
    overlap, absolute = t["overlap"], t["absolute"]
    if beats_chance(overlap):
        warnings.append(f"{prefix}Wording cue: picking the option that repeats the most words from the question would answer {pct(overlap['score'] / overlap['items'])}% of the {overlap['items']} multiple-choice questions where an option repeats a question word (chance is {pct(overlap['chance'] / overlap['items'])}%). Echo the question's key words in the distractors too, or in none of the options.")
    if absolute["options"] >= MIN_ABSOLUTE_OPTIONS and absolute["chance"] - absolute["correct"] >= max(1.5, Z_95 * math.sqrt(absolute["variance"])):
        which = "none" if absolute["correct"] == 0 else f"only {absolute['correct']}"
        warnings.append(f'{prefix}Absolute-word cue: {absolute["options"]} options use words such as "always", "never", "all" or "only", but {which} of them are correct answers (about {js_round(absolute["chance"])} expected by chance). Test-wise students rule such options out; use these words in correct answers too, or avoid them.')
    if t["multi_items"] >= MIN_MULTI_ITEMS:
        count, items = sorted(t["multi_counts"].items(), key=lambda kv: (-kv[1], kv[0]))[0]
        if items / t["multi_items"] >= MULTI_COUNT_SHARE:
            plural = "" if count == 1 else "s"
            warnings.append(f"{prefix}Select-all cue: {items} of the {t['multi_items']} select-all-that-apply questions have exactly {count} correct option{plural}, so students can learn to tick {count}. Vary the number of correct options (anywhere from 1 to 4).")
    if t["survey_dups"]:
        warnings.append(f"{prefix}Survey question nearly repeats a board question, so students practise the survey item itself during the game: {summarize(t['survey_dups'])}. Write a different item on the same learning objective.")
    return warnings


def cue_stats(t):
    def rate(x):
        return x["score"] / x["items"] if x["items"] else None

    lo, ov, ab = t["longest"], t["overlap"], t["absolute"]
    return {
        "items": lo["items"],
        "chance": lo["chance"] / lo["items"] if lo["items"] else None,
        "longest": rate(lo),
        "shortest": rate(t["shortest"]),
        "overlap": rate(ov),
        "overlapItems": ov["items"],
        "overlapChance": ov["chance"] / ov["items"] if ov["items"] else None,
        "absoluteOptions": ab["options"],
        "absoluteCorrect": ab["correct"],
        "absoluteChance": ab["chance"],
        "multiItems": t["multi_items"],
        "multiCounts": {str(k): v for k, v in sorted(t["multi_counts"].items())},
    }


def check_item_quality(rows, games=None):
    """Cues that let test-wise students find the answer without the content.

    `games` is a list of (name, rows) pairs; with more than one, the statistical
    cues are measured and reported per game (and listed in cues["games"]).
    """
    games = games or []
    errors, warnings = [], []
    apostrophe_cells = []
    sheet_errors, formula_cells, option_refs, dup_options, article_cue, long_items, near_misses = [], [], [], [], [], [], []
    facts = []
    # Terms a short answer could be confused with: every option and every accepted answer.
    terms = []
    for r in rows:
        if (r.get("type") or "").strip().lower() not in QUIZ_TYPES:
            continue
        terms.extend((r.get(f"option{k}") or "").strip() for k in range(1, 5) if (r.get(f"option{k}") or "").strip())
        if FORMAT_ALIASES.get((r.get("format") or "").strip().lower()) == "text":
            terms.extend(a.strip() for a in str(r.get("answer") or "").split("|") if a.strip())

    for i, r in enumerate(rows):
        label = f'"{r["id"]}"' if r.get("id") else f"row {i + 2}"
        t = (r.get("type") or "").strip().lower()
        if not t or t == "config":
            continue
        if any(SPREADSHEET_ERROR.match((r.get(c) or "").strip()) for c in TEXT_CELLS):
            sheet_errors.append(label)
        fmt = FORMAT_ALIASES.get((r.get("format") or "").strip().lower())
        if any(not (c == "answer" and fmt == "numeric") and formula_prone(r.get(c)) for c in TEXT_CELLS):
            formula_cells.append(label)
        # The matcher ignores punctuation in text answers, so a lost apostrophe there is harmless.
        if any(c != "answer" and leading_apostrophe(r.get(c)) for c in TEXT_CELLS):
            apostrophe_cells.append(label)
        if t not in QUIZ_TYPES:
            continue
        f = row_facts(r, label, t)
        facts.append(f)
        if fmt == "text":
            miss = text_near_miss(r, terms)
            if miss:
                near_misses.append(f'{label} ("{miss}")')
        if fmt not in ("mcq", "multi"):
            continue
        options = f["options"]
        if any(rx.search(o) for o in options for rx in OPTION_REFERENCE):
            option_refs.append(label)
        lowered = [o.lower() for o in options]
        if len(set(lowered)) < len(lowered):
            dup_options.append(label)
        q = f["mcq"]
        if not q:
            continue
        # Grammatical cue: "...is an" followed by options that don't all fit.
        end = re.sub(r"[\s:._…-]+$", "", (r.get("question") or "").strip()).lower()
        art = re.search(r"\b(an?)$", end)
        if art:
            fits = [bool(re.match(r"[aeiou]", o, re.I)) == (art.group(1) == "an") for o in options]
            if not all(fits):
                article_cue.append(label)
        # A single correct answer much longer than its distractors.
        lengths, correct = q["lengths"], q["correct"]
        others = [ln for k, ln in enumerate(lengths) if k != correct]
        mean_other = sum(others) / len(others)
        lc = lengths[correct]
        if q["longest_idx"] == [correct] and lc >= LONG_RATIO * mean_other and lc - mean_other >= LONG_MIN_GAP:
            long_items.append(f"{label} ({lc} vs {js_round(mean_other)} characters)")

    if sheet_errors:
        errors.append(f'Spreadsheet error value (such as #NAME?) instead of text: {summarize(sheet_errors)}. A spreadsheet treated text starting with "-", "+", "=" or "@" as a formula. Retype it with an apostrophe in front (for example \'--input-path), then export the file again.')
    if formula_cells:
        warnings.append(f'Cell starts with "-", "+", "=" or "@": {summarize(formula_cells)}. Excel and Google Sheets turn such text into a formula (#NAME? or #ERROR!) when the file is opened there. Start the cell with a word, or wrap a command or flag in backticks (for example `--p-trim-left`).')
    if apostrophe_cells:
        warnings.append(f"Cell starts with an apostrophe ('): {summarize(apostrophe_cells)}. Excel and Google Sheets may take a leading apostrophe as their \"keep as text\" mark and drop it when the file is edited there. Use double quotes for quoted speech, or backticks for code.")
    if option_refs:
        warnings.append(f'Option refers to other options ("all of the above", "both A and B", "option 2"): {summarize(option_refs)}. Options are shuffled in the game, so use the multi (select all that apply) format instead.')
    if dup_options:
        warnings.append(f"Two or more options are identical: {summarize(dup_options)}.")
    if article_cue:
        warnings.append(f'Question ends with "a" or "an", which rules out options that don\'t fit grammatically: {summarize(article_cue)}. End with "a(n)" or rephrase the question.')
    if long_items:
        warnings.append(f"Correct answer much longer than the other options ({fmt_num(LONG_RATIO)}× their average length or more): {summarize(long_items)}. Students can pick it without knowing the content; make the distractors just as detailed, or trim the correct answer.")
    if near_misses:
        warnings.append(f"Short-answer question would also accept a different term, because the game forgives one typo in answers of 8 or more letters: {summarize(near_misses)}. Use multiple choice when two terms differ by one letter (absorption and adsorption), or add the other spelling to the accepted answers if it is also correct.")

    # Statistical cues: per game when the file has several, otherwise for the whole file.
    total = tally_cues(facts)
    cues = cue_stats(total)
    if len(games) > 1:
        cues["games"] = []
        for name, game_rows in games:
            in_game = {id(r) for r in game_rows}
            t = tally_cues([f for f in facts if f["row"] in in_game])
            warnings.extend(cue_warnings(t, f"[{name}] "))
            cues["games"].append({"name": name, **cue_stats(t)})
    else:
        warnings.extend(cue_warnings(total, ""))
    return errors, warnings, cues


def format_cue_summary(c):
    """One-line summary of the answer cues (same text as the game's CLI report)."""
    if not c or not c["items"]:
        return ""
    parts = [f"longest option correct {pct(c['longest'])}%", f"shortest {pct(c['shortest'])}%", f"chance {pct(c['chance'])}%"]
    if c["overlapItems"]:
        parts.append(f"most words shared with the question {pct(c['overlap'])}% of {c['overlapItems']} (chance {pct(c['overlapChance'])}%)")
    parts.append(f"absolute words in {c['absoluteOptions']} options, {c['absoluteCorrect']} correct ({js_round(c['absoluteChance'])} expected)")
    return f"Answer cues ({c['items']} multiple-choice questions with 3+ options): {', '.join(parts)}"


def format_multi_summary(c):
    """One-line summary of how many correct options the select-all questions have."""
    if not c or not c.get("multiItems"):
        return ""
    parts = [f"{k} correct: {v}" for k, v in sorted(c["multiCounts"].items(), key=lambda kv: int(kv[0]))]
    return f"Select-all questions ({c['multiItems']}): {', '.join(parts)}"


def read_config(rows):
    """Mirror of readConfig in src/config.js: the settings the game actually uses."""
    raw = {}
    for r in rows:
        if (r.get("type") or "").strip().lower() != "config":
            continue
        key, value = (r.get("id") or "").strip().lower(), (r.get("question") or "").strip()
        if key and value:
            raw[key] = value
    url = raw.get("results_url", "") if COLLECTOR.match(raw.get("results_url", "")) else ""
    email = raw.get("instructor_email", "") if EMAIL_RE.match(raw.get("instructor_email", "")) else ""
    ask = raw.get("ask_names", "").lower()
    ask_names = ask in ("yes", "y", "true", "1") if ask else bool(url or email)
    return {"resultsUrl": url, "instructorEmail": email, "course": raw.get("course", ""), "askNames": ask_names}


def describe_delivery(rows):
    """Where the end screen sends results (mirror of describeDelivery in src/tsvValidator.js)."""
    cfg = read_config(rows)
    to = []
    if cfg["resultsUrl"]:
        to.append(f"the results collector at {cfg['resultsUrl']}")
    if cfg["instructorEmail"]:
        to.append(f"an email to {cfg['instructorEmail']} (students attach the file)")
    where = " and ".join(to) if to else "nowhere; students only download the results file (CSV)"
    # The end screen keeps Send, Email and Download disabled while required names are missing.
    names = "required before Send, Email or Download" if cfg["askNames"] else "optional"
    course = f" Course label: {cfg['course']}." if cfg["course"] else ""
    return f"Results are sent to: {where}. Name/ID field: {names}.{course}"


def count_formats(rows):
    counts = {"mcq": 0, "trueFalse": 0, "multi": 0, "numeric": 0, "order": 0, "text": 0}
    for r in rows:
        if (r.get("type") or "").strip().lower() not in QUIZ_TYPES:
            continue
        fmt = FORMAT_ALIASES.get((r.get("format") or "").strip().lower())
        if fmt is None:
            continue
        counts[fmt] += 1
        if fmt == "mcq" and len([o for o in (r.get(f"option{k}", "") for k in range(1, 5)) if o]) == 2:
            counts["trueFalse"] += 1
    return counts


def format_line(f):
    return f"mcq {f['mcq']} (true/false {f['trueFalse']}), multi {f['multi']}, numeric {f['numeric']}, order {f['order']}, text {f['text']}"


def validate(headers, rows, image_dir=None):
    errors, warnings, games = [], [], []
    if not rows:
        return {"errors": ["The file has no question rows (it needs a header line plus at least one row)."], "warnings": [], "games": [], "stats": {}, "delivery": ""}

    missing = [h for h in REQUIRED if h not in headers]
    if missing:
        errors.append(f"Missing required column(s): {', '.join(missing)}. Column names are case-sensitive.")
    other = [h for h in QUIZ_HEADERS + BOARD_HEADERS + FILTER_HEADERS if h not in headers]
    if other:
        warnings.append(f"Missing column(s): {', '.join(other)}. Column names are case-sensitive.")
    unknown = [h for h in headers if h and h not in REQUIRED + QUIZ_HEADERS + BOARD_HEADERS + FILTER_HEADERS + OPTIONAL]
    if unknown:
        warnings.append(f"Unrecognised column(s) will be ignored: {', '.join(unknown)}.")

    buckets = {k: [] for k in ["type", "case", "noq", "few", "ans", "fmt", "mcqmany", "multi", "num", "tol", "text", "noexp", "mishap"]}
    ids = Counter(r.get("id") for r in rows if r.get("id"))
    images, positions = set(), Counter()
    format_counts = {"mcq": 0, "trueFalse": 0, "multi": 0, "numeric": 0, "order": 0, "text": 0}
    for i, r in enumerate(rows):
        label = f'"{r["id"]}"' if r.get("id") else f"row {i + 2}"
        raw = (r.get("type") or "").strip()
        t = raw.lower()
        if r.get("imageFile"):
            images.add(r["imageFile"].strip())
        if t not in KNOWN_TYPES:
            buckets["type"].append(f"{label} ({raw or 'blank'})")
            continue
        if raw != t:
            buckets["case"].append(label)
        if t == "config":
            check_config(r, label, errors, warnings)
            continue
        if not (r.get("question") or "").strip():
            buckets["noq"].append(label)
        if t == "mishap" and not explicit_amount(r.get("question")):
            buckets["mishap"].append(label)
        if t not in QUIZ_TYPES:
            continue
        key = (r.get("format") or "").strip().lower()
        fmt = FORMAT_ALIASES.get(key)
        if fmt is None:
            buckets["fmt"].append(f"{label} ({r.get('format')})")
            continue
        opts = [r.get(f"option{k}", "") for k in range(1, 5)]
        opts = [o for o in opts if o]
        format_counts[fmt] += 1
        if fmt == "mcq" and len(opts) == 2:
            format_counts["trueFalse"] += 1
        if fmt == "mcq":
            if len(opts) < 2:
                buckets["few"].append(label)
            idx = js_parse_int(r.get("correctIndex", ""))
            if idx is None or idx < 1 or idx > len(opts):
                buckets["ans"].append(label)
            else:
                positions[idx] += 1
                listed = {p for p in re.split(r"[,;|\s]+", str(r.get("correctIndex", ""))) if p}
                if len({js_parse_int(p) for p in listed}) > 1:
                    buckets["mcqmany"].append(label)
        elif fmt == "multi":
            if len(opts) < 2:
                buckets["few"].append(label)
            idxs = parse_index_list(r.get("correctIndex", ""))
            if not idxs or any(x is None or x < 0 or x >= len(opts) for x in idxs):
                buckets["multi"].append(label)
        elif fmt == "order":
            if len(opts) < 2:
                buckets["few"].append(label)
        elif fmt == "numeric":
            if parse_number(r.get("answer")) is None:
                buckets["num"].append(label)
            if not tolerance_ok(r.get("tolerance")):
                buckets["tol"].append(label)
        elif fmt == "text":
            if not any(normalize_text(a) for a in str(r.get("answer", "")).split("|")):
                buckets["text"].append(label)
        if t != "survey" and not (r.get("explanation") or "").strip():
            buckets["noexp"].append(label)

    dups = [f'"{k}"' for k, n in ids.items() if n > 1]
    if dups:
        warnings.append(f"Duplicate id(s): {summarize(dups)}. Ids should be unique so exported data can be traced back to questions.")
    b = buckets
    if b["type"]:
        warnings.append(f"Unknown type, row will be ignored: {summarize(b['type'])}. Valid types: {', '.join(KNOWN_TYPES)}.")
    if b["case"]:
        warnings.append(f"Type is not lowercase: {summarize(b['case'])}. The game accepts it, but lowercase keeps the file consistent.")
    if b["noq"]:
        errors.append(f"Empty question text: {summarize(b['noq'])}.")
    if b["few"]:
        errors.append(f"Fewer than 2 answer options: {summarize(b['few'])}.")
    if b["ans"]:
        errors.append(f"correctIndex is missing or does not point to a filled option (use 1-4): {summarize(b['ans'])}. These questions can never be answered correctly.")
    if b["fmt"]:
        errors.append(f"Unknown format: {summarize(b['fmt'])}. Valid formats: {', '.join(FORMATS)} (blank = mcq). These rows are skipped by this check.")
    if b["mcqmany"]:
        warnings.append(f"correctIndex lists several options but the format is multiple choice, so only the first counts: {summarize(b['mcqmany'])}. For select-all-that-apply, set format to multi.")
    if b["multi"]:
        errors.append(f'Multi-select correctIndex must list filled options, e.g. "1,3": {summarize(b["multi"])}.')
    if b["num"]:
        errors.append(f'Numeric questions need a number in the "answer" column: {summarize(b["num"])}.')
    if b["tol"]:
        errors.append(f"Invalid tolerance (use a number like 0.5 or a percentage like 5%): {summarize(b['tol'])}.")
    if b["text"]:
        errors.append(f'Short-text questions need accepted answers (with letters or digits) in the "answer" column, separated by | : {summarize(b["text"])}.')
    if b["mishap"]:
        warnings.append(f"Mishap without an explicit amount such as (+$100) or (-$50): {summarize(b['mishap'])}. The default +$50 / -$100 will be used.")
    if b["noexp"]:
        warnings.append(f"No explanation: {summarize(b['noexp'])}. Explanations are shown after every answer and are the main teaching moment.")

    # The games (bigTopic + module) players can pick.
    scopes = []
    topics = ordered_unique(t for r in rows for t in parse_list((r.get("bigTopic") or "").strip())) or [None]
    for topic in topics:
        modules = []
        if topic:
            modules = ordered_unique(
                m for r in rows if topic in parse_list((r.get("bigTopic") or "").strip())
                for m in parse_list((r.get("module") or "").strip())
            )
        for module in modules or [None]:
            name = " / ".join(x for x in [topic, module] if x) or "(all rows)"
            scopes.append((name, [r for r in rows if matches(r, topic, module)]))

    q_errors, q_warnings, cues = check_item_quality(rows, scopes)
    errors.extend(q_errors)
    warnings.extend(q_warnings)

    typ = lambda r: (r.get("type") or "").strip().lower()  # noqa: E731
    for gi, (name, scoped) in enumerate(scopes):
        counts = Counter(typ(r) for r in scoped)
        themes = ordered_unique((r.get("theme") or "").strip() for r in scoped if typ(r) in ("property", "milestone"))
        game = {"name": name, "themes": [], "counts": {t: counts.get(t, 0) for t in KNOWN_TYPES},
                "format_counts": count_formats(scoped), "cues": cues["games"][gi] if "games" in cues else None}
        if len(themes) < SIDES:
            found = f": {', '.join(themes)}" if themes else ""
            errors.append(f"[{name}] The board needs {SIDES} themes (one per side) but found {len(themes)}{found}. The board will be incomplete and the game can break.")
        elif len(themes) > SIDES:
            warnings.append(f"[{name}] Found {len(themes)} themes; only the first {SIDES} are used ({', '.join(themes[:SIDES])}). Ignored: {', '.join(themes[SIDES:])}.")
        for th in themes[:SIDES]:
            props = [r for r in scoped if typ(r) == "property" and (r.get("theme") or "").strip() == th]
            miles = [r for r in scoped if typ(r) == "milestone" and (r.get("theme") or "").strip() == th]
            subs = ordered_unique((r.get("subtheme") or "").strip() for r in props)
            game["themes"].append({
                "name": th,
                "subthemes": {s: sum(1 for r in props if (r.get("subtheme") or "").strip() == s) for s in subs},
                "milestone": len(miles),
            })
            if not props:
                errors.append(f'[{name}] Theme "{th}" has no property questions, so its 6 property tiles cannot ask anything.')
            elif len(subs) < SUBS:
                warnings.append(f'[{name}] Theme "{th}" has {len(subs)} subtheme(s); each side uses {SUBS}. Both property groups will reuse the same questions.')
            elif len(subs) > SUBS:
                warnings.append(f'[{name}] Theme "{th}" has {len(subs)} subthemes; only the first {SUBS} are used. Ignored: {", ".join(subs[SUBS:])}.')
            if not miles:
                errors.append(f'[{name}] Theme "{th}" has no milestone questions, so its corner exam cannot start.')
            elif len(miles) < MILESTONE_Q:
                warnings.append(f'[{name}] Theme "{th}" has {len(miles)} milestone question(s); exams ask {MILESTONE_Q}, so questions will repeat within an exam.')
        c = game["counts"]
        if c["core"] == 0:
            warnings.append(f'[{name}] No "core" questions; the 4 core tiles will show a generic event instead of a question.')
        if c["mishap"] == 0:
            warnings.append(f'[{name}] No "mishap" rows; the built-in general wildcards will be used.')
        if c["survey"] == 0:
            warnings.append(f'[{name}] No "survey" questions; the pre/post knowledge check will be empty.')
        elif c["survey"] < SURVEY_Q:
            warnings.append(f'[{name}] Only {c["survey"]} survey question(s); each player normally gets {SURVEY_Q}.')
        if c["confidence"] == 0:
            warnings.append(f'[{name}] No "confidence" rows; the pre/post surveys will have no confidence sliders.')
        games.append(game)

    stats = {"rows": len(rows), "mcq_correct_positions": dict(sorted(positions.items())), "images": sorted(images),
             "format_counts": format_counts, "answer_cues": cues}
    if image_dir is not None:
        present = set(os.listdir(image_dir)) if os.path.isdir(image_dir) else set()
        missing_imgs = [i for i in sorted(images) if not re.match(r"^(https?:|data:)", i, re.I) and i not in present]
        stats["missing_images"] = missing_imgs
        if missing_imgs:
            warnings.append(f"Image file(s) not found in {image_dir}: {summarize(missing_imgs)}.")
    total = sum(positions.values())
    if total >= 12:
        most, n = max(positions.items(), key=lambda kv: kv[1])
        if n / total > 0.4:
            warnings.append(f"{n} of {total} multiple-choice answers are option {most}; spread correct answers across positions.")
    return {"errors": errors, "warnings": warnings, "games": games, "stats": stats, "delivery": describe_delivery(rows)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tsv")
    ap.add_argument("--images", help="folder with the image files referenced by imageFile")
    ap.add_argument("--json", action="store_true", help="print machine-readable JSON")
    args = ap.parse_args()
    with open(args.tsv, encoding="utf-8-sig") as f:
        text = f.read()
    if "\t" not in text:
        sys.exit(f"{args.tsv}: no tab characters found. Is this an encrypted .lock file? Validate the plain .tsv.")
    headers, rows = parse_tsv(text)
    result = validate(headers, rows, args.images)
    if args.json:
        print(json.dumps(result, indent=1, ensure_ascii=False))
    else:
        for g in result["games"]:
            print(f"Game: {g['name']}")
            for i, t in enumerate(g["themes"], 1):
                subs = ", ".join(f"{k} ({v})" for k, v in t["subthemes"].items()) or "none"
                print(f"  Side {i}: {t['name']} | subthemes: {subs} | milestone: {t['milestone']}")
            c = g["counts"]
            print(f"  core: {c['core']}, mishap: {c['mishap']}, survey: {c['survey']}, confidence: {c['confidence']}")
            if len(result["games"]) > 1:
                print(f"  formats: {format_line(g['format_counts'])}")
                for line in (format_cue_summary(g["cues"]), format_multi_summary(g["cues"])):
                    if line:
                        print(f"  {line}")
        s = result["stats"]
        print(f"Rows: {s['rows']}; mcq correct positions: {s['mcq_correct_positions']}")
        print(f"Formats: {format_line(s['format_counts'])}")
        for line in (format_cue_summary(s.get("answer_cues")), format_multi_summary(s.get("answer_cues")), result["delivery"]):
            if line:
                print(line)
        if s["images"]:
            print(f"Images referenced: {', '.join(s['images'])}")
        print()
        for e in result["errors"]:
            print(f"ERROR: {e}")
        for w in result["warnings"]:
            print(f"WARNING: {w}")
        print(f"\n{len(result['errors'])} error(s), {len(result['warnings'])} warning(s).")
    sys.exit(1 if result["errors"] else 0)


if __name__ == "__main__":
    main()
