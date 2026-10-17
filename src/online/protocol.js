// src/online/protocol.js
// Online play (pure): room codes, the messages between devices, and what each
// device may see and do. The host's browser runs the game; guests only display
// what the host sends and send back the buttons their players press.
//
// Never send a guest an answer before it is answered: question objects are
// stripped of their answer fields until they are revealed, and board tiles never
// carry their question lists.

/** Bump when the messages change: devices on different versions are told to reload. */
export const PROTOCOL_VERSION = 2;

/** Largest message accepted (characters of JSON). A view with an image-free question is ~10 kB. */
export const MAX_MESSAGE_CHARS = 200_000;

// No 0/O or 1/I/L: codes are read aloud and typed from a projector.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
const PEER_PREFIX = "lab-room-";

// Cryptographically random number in [0, 1): codes and tokens must not be predictable.
export function secureRandom() {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}

export function makeRoomCode(rng = secureRandom) {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return code;
}

/** What a person typed ("abc-d2f", " ABCD2F ") → "ABCD2F", or "" if it can't be a room code. */
export function normalizeRoomCode(input) {
  const s = String(input || "").toUpperCase().replace(/[\s-]/g, "");
  return s.length === ROOM_CODE_LENGTH && [...s].every((c) => CODE_ALPHABET.includes(c)) ? s : "";
}

/** "ABCD2F" → "ABC-D2F" (easier to read aloud). */
export const formatRoomCode = (code) => (code ? `${code.slice(0, 3)}-${code.slice(3)}` : "");

/** The signalling-server id of a room's host. */
export const hostPeerId = (code) => `${PEER_PREFIX}${code}`;

/** Random id a guest device keeps for this room, so a refresh gets its player back. */
export function makeDeviceToken(rng = secureRandom) {
  return Array.from({ length: 16 }, () => Math.floor(rng() * 36).toString(36)).join("");
}

/** Link that opens the join screen for `code`. */
export function joinLink(pageUrl, code) {
  const url = new URL(pageUrl);
  url.search = "";
  url.hash = "";
  url.searchParams.set("join", formatRoomCode(code));
  return url.toString();
}

// ------------------------------------------------------------------
//  MESSAGES
// ------------------------------------------------------------------

// guest → host
const GUEST_TYPES = new Set(["hello", "claim", "release", "survey", "act", "members"]);
// host → guest
const HOST_TYPES = new Set(["welcome", "lobby", "phase", "board", "view", "survey", "summary", "error", "bye"]);

/**
 * Parse and check a message from the other side. Returns the message object or
 * null (wrong shape, unknown type, too big). `from` is "guest" or "host".
 */
export function readMessage(data, from) {
  let msg = data;
  if (typeof data === "string") {
    if (data.length > MAX_MESSAGE_CHARS) return null;
    try { msg = JSON.parse(data); } catch { return null; }
  } else {
    try { if (JSON.stringify(data).length > MAX_MESSAGE_CHARS) return null; } catch { return null; }
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.t !== "string") return null;
  const allowed = from === "guest" ? GUEST_TYPES : HOST_TYPES;
  return allowed.has(msg.t) ? msg : null;
}

// ------------------------------------------------------------------
//  WHAT GUESTS MAY SEE
// ------------------------------------------------------------------

const ANSWER_KEYS = ["answer", "answers", "numericAnswer", "tolerance", "correctOrder", "acceptedAnswers", "explanation", "optionOrder"];
const isQuestion = (o) => o && typeof o === "object" && typeof o.prompt === "string" && "format" in o;

/** A question without anything that gives its answer away. */
export function hideAnswer(q) {
  if (!isQuestion(q)) return q;
  const out = { ...q };
  ANSWER_KEYS.forEach((k) => delete out[k]);
  return out;
}

/** A tile without its question lists (guests never need them). */
export function publicTile(tile) {
  if (!tile || typeof tile !== "object") return tile;
  const { questions, quiz, ...rest } = tile; // eslint-disable-line no-unused-vars
  return rest;
}

/** Board for guests: names, prices, colours and rent, but no questions. */
export const publicBoard = (board) => (board || []).map(publicTile);

// Recursively drop question lists from board tiles nested anywhere in a value (activeCard.data, assets…).
function stripTiles(value, depth = 0) {
  if (depth > 6 || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => stripTiles(v, depth + 1));
  const out = {};
  const isTile = Number.isInteger(value.id) && typeof value.type === "string";
  for (const [k, v] of Object.entries(value)) {
    if (isTile && (k === "questions" || k === "quiz") && Array.isArray(v)) continue;
    out[k] = stripTiles(v, depth + 1);
  }
  return out;
}

// Dialog stages in which the open question has not been answered yet.
const UNANSWERED_STAGES = new Set(["QUESTION", "CHAOS_QUESTION"]);

/**
 * The game as guests see it. `view` holds the host's game state (see GameScreen's
 * `publishView`); questions are hidden until answered, tiles lose their questions.
 */
export function guestView(view) {
  if (!view) return view;
  const out = { ...view };
  if (view.activeCard) {
    const card = { ...view.activeCard };
    if (card.q && UNANSWERED_STAGES.has(view.modalStage)) card.q = hideAnswer(card.q);
    out.activeCard = stripTiles(card);
  }
  if (view.quizState) {
    const quiz = { ...view.quizState };
    const questions = quiz.questions || [];
    quiz.questions = questions.map((q, i) => {
      if (i < quiz.qIndex || (i === quiz.qIndex && quiz.waiting)) return q; // already answered
      if (i === quiz.qIndex) return hideAnswer(q);
      return { prompt: "", format: "mcq", options: [] }; // later questions: only their number is shown
    });
    out.quizState = stripTiles(quiz);
  }
  if (view.lastAnswer) out.lastAnswer = stripTiles(view.lastAnswer);
  if (view.feedback) out.feedback = stripTiles(view.feedback);
  return out;
}

// ------------------------------------------------------------------
//  WHAT GUESTS MAY DO
// ------------------------------------------------------------------

/**
 * Buttons a guest device can press, by the GameScreen action name. Everything a
 * player does on their turn; ending the game, the final standings and leaving
 * belong to the host.
 */
export const GUEST_ACTIONS = new Set([
  "roll", "answerProperty", "answerRent", "answerOwnTile", "answerQuiz", "answerChaos", "nextQuestion", "buy", "passTurn",
  "startQuiz", "declineMilestone", "payMilestoneFee", "startRescue", "sellAsset", "continueAfterElimination",
  "openChaosSelect", "selectChaosTarget", "buyChaosToken", "openUpgradeOffer", "upgrade", "closeDialog",
]);

// Dialogs only the host may answer (final standings, the winner screen).
const HOST_ONLY_STAGES = new Set(["STANDINGS", "WIN"]);

/** Whether the device holding `slots` may act now, given the current view. */
export function canGuestAct(view, slots) {
  if (!view || !Array.isArray(slots)) return false;
  if (!slots.includes(view.turn)) return false;
  if (view.modalOpen && (HOST_ONLY_STAGES.has(view.modalStage) || HOST_ONLY_STAGES.has(view.activeCard?.type))) return false;
  return true;
}

/** Check an action sent by a guest before the host runs it. */
export function checkGuestAction(msg, view, slots) {
  if (!msg || typeof msg.name !== "string" || !GUEST_ACTIONS.has(msg.name)) return "unknown action";
  if (!Array.isArray(msg.args) || msg.args.length > 3) return "bad arguments";
  if (!msg.args.every(isPlainArg)) return "bad arguments";
  if (!canGuestAct(view, slots)) return "not your turn";
  return null;
}

// Answers are an index, a list of indexes or strings, a number or a short text; tiles go by id.
function isPlainArg(a) {
  if (a == null || typeof a === "number" || typeof a === "boolean") return true;
  if (typeof a === "string") return a.length <= 500;
  if (Array.isArray(a)) return a.length <= 20 && a.every((x) => typeof x === "number" || (typeof x === "string" && x.length <= 500));
  if (typeof a === "object") return Object.keys(a).length === 1 && Number.isInteger(a.$tile);
  return false;
}

/** Replace tile arguments by a reference ({ $tile: id }) before sending. */
export const encodeArgs = (args) => args.map((a) => (a && typeof a === "object" && !Array.isArray(a) && Number.isInteger(a.id) && "type" in a ? { $tile: a.id } : a));

/** Turn tile references back into the host's own tiles. */
export const decodeArgs = (args, board) => args.map((a) => (a && typeof a === "object" && !Array.isArray(a) && Number.isInteger(a.$tile) ? board[a.$tile] : a));

/** Survey answers from another device: only plain values, one per question (blank -> null). */
export function cleanAnswers(list, length) {
  const ok = (a) => a == null || typeof a === "number" || (typeof a === "string" && a.length <= 500)
    || (Array.isArray(a) && a.length <= 20 && a.every((x) => typeof x === "number" || (typeof x === "string" && x.length <= 500)));
  return Array.from({ length }, (_, i) => (Array.isArray(list) && ok(list[i]) ? list[i] ?? null : null));
}

/** Confidence sliders from another device: whole numbers 0–10 for the known statements (5 if missing). */
export function cleanSliders(obj, keys) {
  return Object.fromEntries(keys.map((k) => {
    const v = obj && typeof obj === "object" ? Number(obj[k]) : NaN;
    return [k, Number.isFinite(v) ? Math.min(10, Math.max(0, Math.round(v))) : 5];
  }));
}

// ------------------------------------------------------------------
//  LOBBY
// ------------------------------------------------------------------

/**
 * Who plays which player: `claims[i]` is "host", a device token, or null (free).
 * Returns the updated claims, or null if the request can't be granted.
 */
export function claimSlot(claims, slot, holder) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= claims.length) return null;
  if (claims[slot] && claims[slot] !== holder) return null;
  return claims.map((c, i) => (i === slot ? holder : c));
}

export const releaseSlots = (claims, holder) => claims.map((c) => (c === holder ? null : c));

export const slotsOf = (claims, holder) => claims.map((c, i) => (c === holder ? i : -1)).filter((i) => i >= 0);

/** Every player has someone: a device, or the host's own screen. */
export const lobbyReady = (claims) => claims.length > 0 && claims.every(Boolean);
