import { describe, it, expect, beforeEach } from "vitest";
import {
  makeRoomCode, normalizeRoomCode, formatRoomCode, joinLink, readMessage, hideAnswer, publicBoard, guestView,
  canGuestAct, checkGuestAction, encodeArgs, decodeArgs, claimSlot, releaseSlots, slotsOf, lobbyReady, PROTOCOL_VERSION,
  cleanAnswers, cleanSliders, secureRandom, makeDeviceToken,
} from "../src/online/protocol.js";
import { HostSession, GuestSession } from "../src/online/sessions.js";
import { normalizeQuestion, prepareQuestion } from "../src/questionFormats.js";
import { surveyRows } from "../src/surveys.js";

const row = (o = {}) => ({ id: "q1", question: "Q?", option1: "A", option2: "B", option3: "C", option4: "D", correctIndex: "2", explanation: "Because B.", ...o });

// ---------------------------------------------------------------------------
// An in-memory network: messages go through JSON like the real one, asynchronously.
// ---------------------------------------------------------------------------
function memoryNetwork() {
  const rooms = new Map();
  const tick = () => new Promise((r) => setTimeout(r, 0));
  function pair() {
    const ends = [0, 1].map(() => ({ data: [], close: [], open: true }));
    const make = (me, other) => ({
      send: (msg) => { if (!me.open) throw new Error("closed"); const json = JSON.stringify(msg); setTimeout(() => other.open && other.data.forEach((fn) => fn(JSON.parse(json))), 0); },
      onData: (fn) => me.data.push(fn),
      onClose: (fn) => me.close.push(fn),
      close: () => { if (!me.open) return; me.open = false; other.open = false; setTimeout(() => { me.close.forEach((f) => f()); other.close.forEach((f) => f()); }, 0); },
    });
    return [make(ends[0], ends[1]), make(ends[1], ends[0])];
  }
  return {
    tick,
    host: (code) => ({ listen: (fn) => rooms.set(code, fn), close: () => rooms.delete(code) }),
    guest: (code) => ({
      connect: async () => {
        await tick();
        const accept = rooms.get(code);
        if (!accept) throw Object.assign(new Error("none"), { code: "not-found" });
        const [hostEnd, guestEnd] = pair();
        accept(hostEnd);
        return guestEnd;
      },
    }),
  };
}

const settle = async (net, n = 6) => { for (let i = 0; i < n; i++) await net.tick(); };

describe("room codes", () => {
  it("are 6 unambiguous characters and survive typing variations", () => {
    for (let i = 0; i < 50; i++) {
      const code = makeRoomCode();
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
      expect(normalizeRoomCode(formatRoomCode(code).toLowerCase())).toBe(code);
      expect(normalizeRoomCode(` ${code.slice(0, 3)} ${code.slice(3)} `)).toBe(code);
    }
    expect(normalizeRoomCode("ABC")).toBe("");
    expect(normalizeRoomCode("ABCD0O")).toBe(""); // 0 and O are never used
    expect(normalizeRoomCode(null)).toBe("");
  });

  it("codes and device tokens come from the browser's cryptographic random generator", () => {
    const xs = Array.from({ length: 200 }, secureRandom);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBe(200);
    expect(makeDeviceToken()).toMatch(/^[0-9a-z]{16}$/);
    expect(new Set(Array.from({ length: 100 }, () => makeRoomCode())).size).toBeGreaterThan(95);
  });

  it("make a join link without the page's other parameters", () => {
    expect(joinLink("https://x.io/SAB/?deck=demo#a", "ABCDEF")).toBe("https://x.io/SAB/?join=ABC-DEF");
  });
});

describe("messages", () => {
  it("accept known types from the right side only", () => {
    expect(readMessage('{"t":"hello","v":1}', "guest")).toEqual({ t: "hello", v: 1 });
    expect(readMessage({ t: "view", view: {} }, "host")).toEqual({ t: "view", view: {} });
    expect(readMessage({ t: "view" }, "guest")).toBeNull(); // guests can't send views
    expect(readMessage({ t: "act" }, "host")).toBeNull();
    expect(readMessage("not json", "guest")).toBeNull();
    expect(readMessage("[1,2]", "guest")).toBeNull();
    expect(readMessage({ t: "hello", pad: "x".repeat(300000) }, "guest")).toBeNull();
  });
});

describe("hiding answers from guests", () => {
  const formats = [
    row(),
    row({ format: "multi", correctIndex: "1,3" }),
    row({ format: "numeric", answer: "42", tolerance: "1", option1: "", option2: "", option3: "", option4: "" }),
    row({ format: "order" }),
    row({ format: "text", answer: "beta|β", option1: "", option2: "", option3: "", option4: "" }),
  ];
  it("strips every answer field, in every format", () => {
    for (const r of formats) {
      const q = prepareQuestion(normalizeQuestion(r));
      const hidden = JSON.stringify(hideAnswer(q));
      for (const k of ["\"answer\"", "answers", "numericAnswer", "tolerance", "correctOrder", "acceptedAnswers", "explanation", "optionOrder"]) expect(hidden).not.toContain(k);
      expect(hidden).toContain("Q?");
    }
  });

  it("never sends tile question lists, and hides the open question until it is answered", () => {
    const q = prepareQuestion(normalizeQuestion(row()));
    const tile = { id: 3, type: "property", name: "T", questions: [q], quiz: [q] };
    expect(publicBoard([tile])[0]).toEqual({ id: 3, type: "property", name: "T" });
    const asking = guestView({ modalOpen: true, modalStage: "QUESTION", activeCard: { type: "QUESTION", data: tile, q }, quizState: null });
    expect(JSON.stringify(asking)).not.toContain("Because B.");
    expect(asking.activeCard.data.questions).toBeUndefined();
    expect(asking.activeCard.q.answer).toBeUndefined();
    const answered = guestView({ modalOpen: true, modalStage: "DECISION", activeCard: { type: "QUESTION", data: tile, q }, lastAnswer: { q, response: 1, result: {} } });
    expect(answered.activeCard.q.answer).toBe(q.answer); // revealed once answered
  });

  it("shows exam questions one at a time", () => {
    const qs = [0, 1, 2].map((i) => prepareQuestion(normalizeQuestion(row({ id: `q${i}`, question: `Q${i}`, explanation: `E${i}` }))));
    const v = (qIndex, waiting) => guestView({ modalStage: "QUIZ", quizState: { questions: qs, qIndex, waiting, tile: { id: 0, type: "milestone", quiz: qs } } }).quizState;
    expect(v(0, false).questions.map((q) => q.prompt)).toEqual(["Q0", "", ""]);
    expect(v(0, false).questions[0].explanation).toBeUndefined();
    expect(v(0, true).questions[0].explanation).toBe("E0");
    expect(v(1, false).questions[0].explanation).toBe("E0");
    expect(v(1, false).questions[1].explanation).toBeUndefined();
    expect(v(1, false).tile.quiz).toBeUndefined();
  });
});

describe("who may act", () => {
  const view = (o = {}) => ({ turn: 1, modalOpen: false, modalStage: null, activeCard: null, ...o });
  it("only the device holding the current player, and never on host-only screens", () => {
    expect(canGuestAct(view(), [1])).toBe(true);
    expect(canGuestAct(view(), [0, 2])).toBe(false);
    expect(canGuestAct(view({ modalOpen: true, modalStage: "STANDINGS", activeCard: { type: "STANDINGS" } }), [1])).toBe(false);
    expect(canGuestAct(view({ modalOpen: true, modalStage: "WIN", activeCard: { type: "WIN" } }), [1])).toBe(false);
    expect(canGuestAct(view({ modalOpen: true, modalStage: "QUESTION" }), [1])).toBe(true);
  });

  it("checks the action name and arguments", () => {
    expect(checkGuestAction({ name: "roll", args: [] }, view(), [1])).toBeNull();
    expect(checkGuestAction({ name: "endGame", args: [] }, view(), [1])).toBe("unknown action");
    expect(checkGuestAction({ name: "roll", args: [] }, view(), [0])).toBe("not your turn");
    expect(checkGuestAction({ name: "answerQuiz", args: [{ evil: 1 }] }, view(), [1])).toBe("bad arguments");
    expect(checkGuestAction({ name: "answerQuiz", args: ["x".repeat(501)] }, view(), [1])).toBe("bad arguments");
    expect(checkGuestAction({ name: "answerQuiz", args: [[2, 0, 1]] }, view(), [1])).toBeNull();
    expect(checkGuestAction({ name: "sellAsset", args: [{ $tile: 4 }] }, view(), [1])).toBeNull();
  });

  it("sends tiles by reference and gets the host's own tile back", () => {
    const board = [{ id: 0, type: "property" }, { id: 1, type: "property", secret: true }];
    const sent = encodeArgs([{ id: 1, type: "property", questions: ["x"] }, 2, "a"]);
    expect(sent).toEqual([{ $tile: 1 }, 2, "a"]);
    expect(decodeArgs(sent, board)[0]).toBe(board[1]);
  });
});

describe("lobby claims", () => {
  it("lets each player be held by one holder", () => {
    let c = [null, null, null];
    c = claimSlot(c, 0, "dev1");
    expect(claimSlot(c, 0, "dev2")).toBeNull();
    c = claimSlot(c, 1, "host");
    expect(slotsOf(c, "dev1")).toEqual([0]);
    expect(lobbyReady(c)).toBe(false);
    c = claimSlot(c, 2, "dev1");
    expect(lobbyReady(c)).toBe(true);
    expect(releaseSlots(c, "dev1")).toEqual([null, "host", null]);
    expect(claimSlot(c, 9, "x")).toBeNull();
  });
});

describe("survey answers from devices", () => {
  it("keep only plain values, one per question", () => {
    expect(cleanAnswers([1, "two", [0, 2], { evil: 1 }, "x".repeat(600)], 6)).toEqual([1, "two", [0, 2], null, null, null]);
    expect(cleanAnswers("nope", 2)).toEqual([null, null]);
    expect(cleanSliders({ a: 12, b: "3", c: "x", d: 4 }, ["a", "b", "c"])).toEqual({ a: 10, b: 3, c: 5 });
    expect(cleanSliders(null, ["a"])).toEqual({ a: 5 });
  });
});

describe("surveyRows", () => {
  it("scores answers on the host and records the file's option number", () => {
    const q = prepareQuestion(normalizeQuestion(row()));
    const pos = q.options.indexOf("B");
    const rows = surveyRows({ phase: "pre", players: [1], sliders: [{}, { c1: 7 }], answers: [[], [pos]], questionSets: [[], [q]], confidence: [{ key: "c1", label: "Conf" }] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ section: "confidence", playerIndex: 1, response: 7 });
    expect(rows[1]).toMatchObject({ section: "quiz", playerIndex: 1, correct: true, selectedIndex: 2, selectedOption: "B" });
  });
});

describe("host and guest sessions", () => {
  let net;
  beforeEach(() => { net = memoryNetwork(); });

  function guest(code, token) {
    const log = { msgs: [], status: [] };
    const g = new GuestSession({ transport: net.guest(code), token, onMessage: (m) => log.msgs.push(m), onStatus: (s, d) => log.status.push(d ? `${s}:${d}` : s) });
    return { g, log, last: (t) => [...log.msgs].reverse().find((m) => m.t === t) };
  }

  it("runs a lobby: join, claim, take turns, and refuse others' actions", async () => {
    const actions = [];
    const host = new HostSession({ transport: net.host("R1"), playerCount: 2, handlers: { onAction: (slots, name, args) => actions.push({ slots, name, args }) } });
    host.start();
    const a = guest("R1", "aaaaaaaa1"); const b = guest("R1", "bbbbbbbb1");
    a.g.connect(); b.g.connect();
    await settle(net);
    expect(a.last("welcome")).toMatchObject({ v: PROTOCOL_VERSION, token: "aaaaaaaa1" });
    a.g.send({ t: "claim", slot: 0 });
    b.g.send({ t: "claim", slot: 0 });
    await settle(net);
    expect(host.claims[0]).toBe("aaaaaaaa1");
    expect(b.last("error").code).toBe("taken");
    b.g.send({ t: "claim", slot: 1 });
    await settle(net);
    expect(b.last("lobby").mine).toEqual([1]);

    host.setPhase("GAME");
    host.publishView({ turn: 0, modalOpen: false });
    await settle(net);
    expect(a.last("view").view.turn).toBe(0);
    b.g.send({ t: "act", name: "roll", args: [] });
    a.g.send({ t: "act", name: "roll", args: [] });
    await settle(net);
    expect(actions).toEqual([{ slots: [0], name: "roll", args: [] }]);
    expect(b.last("error").message).toMatch(/isn't your turn/);
  });

  it("sends each change once, and gives a reconnecting device its player and state back", async () => {
    const host = new HostSession({ transport: net.host("R2"), playerCount: 1 });
    host.start();
    const a = guest("R2", "cccccccc1");
    a.g.connect();
    await settle(net);
    a.g.send({ t: "claim", slot: 0 });
    await settle(net);
    host.setPhase("GAME");
    host.publishBoard([{ id: 0, type: "milestone" }]);
    host.publishView({ turn: 0, n: 1 });
    host.publishView({ turn: 0, n: 1 });
    await settle(net);
    expect(a.log.msgs.filter((m) => m.t === "view")).toHaveLength(1);

    // The connection drops: the guest reconnects by itself and catches up.
    a.g.conn.close();
    await settle(net);
    host.publishView({ turn: 0, n: 2 });
    await new Promise((r) => setTimeout(r, 700));
    await settle(net);
    expect(a.log.status).toContain("reconnecting");
    expect(a.last("view").view.n).toBe(2);
    expect(a.last("phase")).toMatchObject({ phase: "GAME", mine: [0] });
    expect(a.last("board").tiles).toHaveLength(1);
    a.g.close();
  });

  it("turns away new devices once the game has started, and old app versions", async () => {
    const host = new HostSession({ transport: net.host("R3"), playerCount: 1 });
    host.start();
    host.setHostSlot(0, true);
    host.setPhase("PRE_SURVEY");
    const late = guest("R3", "dddddddd1");
    late.g.connect();
    await settle(net);
    expect(late.log.status).toContain("failed:started");

    const old = new GuestSession({ transport: net.guest("R3"), token: "eeeeeeee1", onStatus: () => {}, onMessage: () => {} });
    const conn = await net.guest("R3").connect();
    const got = [];
    conn.onData((m) => got.push(m));
    conn.send({ t: "hello", v: PROTOCOL_VERSION + 1, token: "eeeeeeee1" });
    await settle(net);
    expect(got[0]).toMatchObject({ t: "error", code: "version" });
    old.close();
  });

  it("reports a room that doesn't exist", async () => {
    const a = guest("NOPE", "ffffffff1");
    a.g.setTimer = (fn) => setTimeout(fn, 0);
    a.g.connect();
    await new Promise((r) => setTimeout(r, 50));
    expect(a.log.status).toContain("failed:not-found");
  });

  it("passes surveys and names only for the device's own players", async () => {
    const surveys = []; const names = [];
    const host = new HostSession({ transport: net.host("R4"), playerCount: 2, handlers: { onSurvey: (slots, m) => surveys.push({ slots, phase: m.phase }), onMembers: (slot, text) => names.push({ slot, text }) } });
    host.start();
    const a = guest("R4", "gggggggg1");
    a.g.connect();
    await settle(net);
    a.g.send({ t: "claim", slot: 1 });
    await settle(net);
    a.g.send({ t: "survey", phase: "pre", answers: [] });
    a.g.send({ t: "members", slot: 1, text: "Ana" });
    a.g.send({ t: "members", slot: 0, text: "Not mine" });
    await settle(net);
    expect(surveys).toEqual([{ slots: [1], phase: "pre" }]);
    expect(names).toEqual([{ slot: 1, text: "Ana" }]);
  });
});
