// src/online/sessions.js
// The connection logic of online play, with the network injected so it can be
// tested without one (tests/online.test.js uses an in-memory network; the app uses
// peerTransport.js). No React here.
//
// A transport for the host:   { listen(onConnection), close() }
// A transport for a guest:     { connect() -> Promise<conn> }   (rejects with Error, .code "not-found" | "network")
// A connection (both sides):   { send(obj), onData(fn), onClose(fn), close() }
import { PROTOCOL_VERSION, readMessage, claimSlot, releaseSlots, slotsOf, checkGuestAction, guestView, makeDeviceToken, stepKey } from "./protocol.js";

/**
 * The host's side: who is connected, who plays which player, and what to send.
 * The app drives it: `setPhase`, `publishView`, `publishBoard`, and reacts to
 * `onChange` (lobby changes), `onAction`, `onSurvey` and `onMembers`.
 */
export class HostSession {
  constructor({ transport, playerCount, claims, meta = {}, handlers = {} }) {
    this.transport = transport;
    this.claims = claims ? [...claims] : Array(playerCount).fill(null);
    this.meta = meta; // { title, topic, module, imagesBase, names }
    this.handlers = handlers; // onChange(session), onAction(slots, name, args) -> bool, onSurvey(slots, msg), onMembers(slot, text), syncFor(token) -> msgs
    this.devices = new Map(); // token -> { conn, online, label }
    this.phase = "LOBBY";
    this.view = null; // latest full (host) view
    this.stepRev = 0; // numbers each change of turn, dialog or question (see stepKey)
    this.stepKey = "";
    this.lastAct = null; // { rev, name } of the last action run, so a double press runs once
    this.boardMsg = null;
    this.lastSent = new Map(); // token -> last view JSON (skip identical sends)
    this.closed = false;
  }

  start() {
    this.transport.listen((conn) => this.#accept(conn));
  }

  #accept(conn) {
    let token = null;
    conn.onData((data) => {
      const msg = readMessage(data, "guest");
      if (!msg) return;
      if (msg.t === "hello") {
        if (msg.v !== PROTOCOL_VERSION) { conn.send({ t: "error", code: "version", message: "This device has a different version of the game. Reload the page to update it, then join again." }); return; }
        token = typeof msg.token === "string" && /^[a-z0-9]{8,32}$/.test(msg.token) ? msg.token : makeDeviceToken();
        const known = this.devices.get(token);
        if (!known && this.phase !== "LOBBY" && slotsOf(this.claims, token).length === 0) {
          conn.send({ t: "error", code: "started", message: "This game has already started. Ask the host to add you before the next game." });
          return;
        }
        if (known?.conn && known.conn !== conn) known.conn.close();
        const label = known?.label || `Device ${this.devices.size + 1}`;
        this.devices.set(token, { conn, online: true, label });
        this.lastSent.delete(token);
        conn.send({ t: "welcome", v: PROTOCOL_VERSION, token, label, meta: this.meta, hostNow: Date.now() });
        this.#sendLobby();
        this.#sync(token);
        this.#changed();
        return;
      }
      if (!token || !this.devices.has(token)) return; // must say hello first
      const slots = slotsOf(this.claims, token);
      if (msg.t === "claim") {
        if (this.phase !== "LOBBY") return;
        const next = claimSlot(this.claims, msg.slot, token);
        if (next) { this.claims = next; this.#sendLobby(); this.#changed(); }
        else conn.send({ t: "error", code: "taken", message: "Someone else is already playing that player. Pick another one." });
      } else if (msg.t === "release") {
        if (this.phase !== "LOBBY") return;
        this.claims = this.claims.map((c, i) => (c === token && (msg.slot == null || msg.slot === i) ? null : c));
        this.#sendLobby(); this.#changed();
      } else if (msg.t === "act") {
        if (this.phase !== "GAME" || !this.view) return;
        // A press made on an older screen, or the same button pressed twice, does nothing.
        if (msg.rev !== this.stepRev) { conn.send({ t: "error", code: "stale", message: "The game moved on before that arrived. Check the screen and try again." }); return; }
        if (this.lastAct?.rev === msg.rev && this.lastAct.name === msg.name) return;
        const problem = checkGuestAction(msg, this.view, slots);
        if (problem) { conn.send({ t: "error", code: "action", message: problem === "not your turn" ? "It isn't your turn." : "That action wasn't accepted." }); return; }
        this.lastAct = { rev: msg.rev, name: msg.name };
        this.handlers.onAction?.(slots, msg.name, msg.args); // the app turns tile references back into its tiles
      } else if (msg.t === "survey") {
        if (!slots.length || (msg.phase !== "pre" && msg.phase !== "post")) return;
        this.handlers.onSurvey?.(slots, msg);
      } else if (msg.t === "members") {
        if (!slots.includes(msg.slot) || typeof msg.text !== "string") return;
        this.handlers.onMembers?.(msg.slot, msg.text.slice(0, 300));
      }
    });
    conn.onClose(() => {
      if (!token) return;
      const d = this.devices.get(token);
      if (d && d.conn === conn) { d.online = false; d.conn = null; this.#changed(); }
    });
  }

  #changed() { this.handlers.onChange?.(this); }

  #send(token, msg) {
    const d = this.devices.get(token);
    if (d?.online && d.conn) { try { d.conn.send(msg); } catch { /* the close handler marks it offline */ } }
  }

  #broadcast(msg) { for (const token of this.devices.keys()) this.#send(token, msg); }

  #lobbyMsg() {
    const labels = Object.fromEntries([...this.devices].map(([t, d]) => [t, d.label]));
    return { t: "lobby", claims: this.claims.map((c) => (c === "host" ? "host" : c ? (labels[c] || "Device") : null)), playerCount: this.claims.length };
  }

  #sendLobby() {
    const lobby = this.#lobbyMsg();
    for (const token of this.devices.keys()) this.#send(token, { ...lobby, mine: slotsOf(this.claims, token) });
  }

  // Everything a device needs to catch up after joining or reconnecting.
  #sync(token) {
    this.#send(token, { t: "phase", phase: this.phase, mine: slotsOf(this.claims, token) });
    if (this.boardMsg) this.#send(token, this.boardMsg);
    if (this.view && this.phase === "GAME") this.#sendView(token);
    for (const m of this.handlers.syncFor?.(token, slotsOf(this.claims, token)) || []) this.#send(token, m);
  }

  #sendView(token) {
    const json = JSON.stringify({ ...guestView(this.view), stepRev: this.stepRev });
    if (this.lastSent.get(token) === json) return;
    this.lastSent.set(token, json);
    this.#send(token, `{"t":"view","view":${json}}`);
  }

  // --- used by the app ---

  /** Lobby: the host's own screen plays `slot` (or stops). */
  setHostSlot(slot, on) {
    if (this.phase !== "LOBBY") return;
    if (on) { const next = claimSlot(this.claims, slot, "host"); if (next) this.claims = next; }
    else if (this.claims[slot] === "host") this.claims = this.claims.map((c, i) => (i === slot ? null : c));
    this.#sendLobby(); this.#changed();
  }

  /** Lobby: free a player claimed by a device (the device stays connected). */
  freeSlot(slot) {
    if (this.phase !== "LOBBY") return;
    this.claims = this.claims.map((c, i) => (i === slot ? null : c));
    this.#sendLobby(); this.#changed();
  }

  /** Lobby: change the number of players (slots beyond it are freed). */
  setPlayerCount(n) {
    if (this.phase !== "LOBBY") return;
    this.claims = Array.from({ length: n }, (_, i) => this.claims[i] ?? null);
    this.#sendLobby(); this.#changed();
  }

  /** Remove a device (it is told why and its players are freed). */
  removeDevice(token) {
    const d = this.devices.get(token);
    if (d?.conn) { try { d.conn.send({ t: "bye", message: "The host removed this device from the game." }); } catch { /* ignore */ } d.conn.close(); }
    this.devices.delete(token);
    this.lastSent.delete(token);
    if (this.phase === "LOBBY") this.claims = releaseSlots(this.claims, token);
    this.#sendLobby(); this.#changed();
  }

  setMeta(meta) { this.meta = { ...this.meta, ...meta }; }

  /** Move every device to a new phase; `extra` is merged into the message. */
  setPhase(phase, extra = {}) {
    this.phase = phase;
    for (const token of this.devices.keys()) {
      this.#send(token, { t: "phase", phase, mine: slotsOf(this.claims, token), ...extra });
      for (const m of this.handlers.syncFor?.(token, slotsOf(this.claims, token)) || []) this.#send(token, m);
    }
    this.#changed();
  }

  /** The board's fixed parts (names, prices, colours), already without questions. */
  publishBoard(tiles) {
    this.boardMsg = { t: "board", tiles };
    this.#broadcast(this.boardMsg);
  }

  /** The game state after every change; each guest gets the safe version, once per change. */
  publishView(view) {
    this.view = view;
    const key = stepKey(view);
    if (key !== this.stepKey) { this.stepKey = key; this.stepRev++; }
    for (const token of this.devices.keys()) this.#sendView(token);
  }

  /** Send any message to the devices holding `slot` (or every device when slot is null). */
  sendTo(slot, msg) {
    for (const token of this.devices.keys()) if (slot == null || slotsOf(this.claims, token).includes(slot)) this.#send(token, msg);
  }

  deviceList() {
    return [...this.devices].map(([token, d]) => ({ token, label: d.label, online: d.online, slots: slotsOf(this.claims, token) }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#broadcast({ t: "bye", message: "The host closed the game." });
    for (const d of this.devices.values()) d.conn?.close();
    this.transport.close();
  }
}

/** Delays between reconnection attempts (ms); the last one repeats. */
export const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000];

/**
 * A guest device: connects, says hello, reconnects by itself, and hands every
 * message from the host to `onMessage`. `onStatus` gets "connecting",
 * "connected", "reconnecting" or "failed" (with a reason).
 */
export class GuestSession {
  // Timers are wrapped: browsers throw "Illegal invocation" when setTimeout is called as a method of another object.
  constructor({ transport, token, onMessage, onStatus, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id) }) {
    this.transport = transport;
    this.token = token;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.conn = null;
    this.attempt = 0;
    this.everConnected = false;
    this.stopped = false;
    this.timer = null;
  }

  async connect() {
    if (this.stopped) return;
    this.onStatus?.(this.everConnected ? "reconnecting" : "connecting");
    let conn;
    try {
      conn = await this.transport.connect();
    } catch (err) {
      if (this.stopped) return;
      // A room that doesn't exist (yet): give up quickly on a first join, keep trying after a drop (the host may be reloading).
      if (!this.everConnected && err?.code === "not-found" && this.attempt >= 2) { this.onStatus?.("failed", "not-found"); return; }
      this.#retry();
      return;
    }
    if (this.stopped) { conn.close(); return; }
    this.conn = conn;
    this.attempt = 0;
    conn.onData((data) => {
      const msg = readMessage(data, "host");
      if (!msg) return;
      if (msg.t === "welcome") { this.token = msg.token; this.everConnected = true; this.onStatus?.("connected"); }
      if (msg.t === "error" && (msg.code === "version" || msg.code === "started")) { this.stopped = true; this.onStatus?.("failed", msg.code); }
      if (msg.t === "bye") { this.stopped = true; this.onStatus?.("failed", "bye"); }
      this.onMessage?.(msg);
    });
    conn.onClose(() => {
      if (this.conn !== conn) return;
      this.conn = null;
      if (!this.stopped) this.#retry();
    });
    conn.send({ t: "hello", v: PROTOCOL_VERSION, token: this.token });
  }

  #retry() {
    const delay = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)];
    this.attempt++;
    this.onStatus?.(this.everConnected ? "reconnecting" : "connecting");
    this.timer = this.setTimer(() => this.connect(), delay);
  }

  send(msg) {
    if (!this.conn) return false;
    try { this.conn.send(msg); return true; } catch { return false; }
  }

  close() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.conn?.close();
  }
}
