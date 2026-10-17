// src/App.jsx
import React, { useState, useEffect, useMemo, useRef, Suspense } from "react";
import { buildBoardFromTsv } from "./gameData"; 
import { lazyWithReload } from "./lazyLoad";
import { lockFormat, decryptLockFile } from "./lockFile";
import { setUpdateReloadSafe } from "./pwa";
import { parseTsv, getAllTopics, getModulesForTopic } from "./tsvParser";
import { validateQuestionRows } from "./tsvValidator";
import { buildSurveySets, buildConfidenceQuestions, surveyRows } from "./surveys";
import { readConfig } from "./config";
import { saveSnapshot, loadSnapshot, clearSnapshot } from "./autosave";
import { toCsv, resultsFilename, summarizeTeams, teamInfoRows, makeSessionId, buildPayload, sendResults, buildMailto, downloadText } from "./results";
import { bestPreSurveyPlayer } from "./gameRules";
import { BOT_LEVELS, BOT_LEVEL_IDS, DEFAULT_BOT_LEVEL } from "./bot";
import { resolveImage, isUploaded } from "./images";
import QuestionInput from "./QuestionInput";
import { resetConsent } from "./consent";
import ConsentBanner from "./ConsentBanner";
import PasswordDialog from "./components/PasswordDialog";
import InstallButton from "./components/InstallButton";
import RulesDialog from "./components/RulesDialog";
import SurveyView from "./SurveyView";
import JoinCodeForm from "./online/JoinCodeForm";
import { HostLobby, SurveyWait } from "./online/HostScreens";
import { useHostRoom } from "./online/useHostRoom";
import { makeRoomCode, normalizeRoomCode, formatRoomCode, hideAnswer, publicBoard, cleanAnswers, cleanSliders } from "./online/protocol";
import TeamToken from "./components/TeamToken";
import { DECK_SHORTCUTS, buildShareLink, isUnpublishedSheet, normalizeDeckUrl, normalizeImagesBase, readDeckParams } from "./deckLinks";
import { TEAM_COLORS, TEAM_SYMBOLS, TEAM_INK } from "./theme";

// The board (and its animation library) loads after the start page, which keeps the first
// visit fast. It is fetched in the background right away, so it is ready before a game starts.
const loadGameScreen = () => import("./GameScreen");
const GameScreen = lazyWithReload(loadGameScreen);
const GuestApp = lazyWithReload(() => import("./online/GuestApp"));
const MAX_FILE_BYTES = 5 * 1024 * 1024; // question files are a few hundred kB at most
const TOO_BIG = "This file is too large to be a question file (over 5 MB).";

import {
  Card, Typography, Container, ToggleButton, ToggleButtonGroup, Button,
  Box, Slider, Divider, Modal, Alert, Paper, TextField, Accordion, AccordionSummary, AccordionDetails,
} from "@mui/material";


function ValidationReport({ validation, imageMap, imageBase = "" }) {
  const [missingImages, setMissingImages] = useState([]);
  const images = validation ? validation.images : [];
  const imagesKey = images.join("|");
  // Only warn about images that can't be found anywhere (uploads, links, hosted copies).
  // A failed check (offline, or a host without CORS headers) is not proof that an image is missing.
  useEffect(() => {
    let cancelled = false;
    const candidates = images.filter((img) => !isUploaded(img, imageMap) && !/^(https?:|data:)/i.test(img));
    Promise.all(candidates.map(async (img) => {
      try {
        const res = await fetch(resolveImage(img, {}, imageBase), { method: "HEAD" });
        return res.ok && (res.headers.get("content-type") || "").startsWith("image/") ? null : img;
      } catch {
        return null;
      }
    })).then((found) => { if (!cancelled) setMissingImages(found.filter(Boolean)); });
    return () => { cancelled = true; };
  }, [imagesKey, imageMap, imageBase]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!validation) return null;
  const { errors, warnings } = validation;
  if (!errors.length && !warnings.length && !missingImages.length) return null;
  return (
    <Box sx={{ mb: 3, textAlign: "left" }}>
      {errors.length > 0 && (
        <Alert severity="error" sx={{ mb: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: "bold" }}>
            {errors.length} problem{errors.length > 1 ? "s" : ""} found in this question file. The game may not work correctly.
          </Typography>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {errors.map((e, i) => <li key={i}><Typography variant="caption">{e}</Typography></li>)}
          </ul>
        </Alert>
      )}
      {warnings.length > 0 && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          <details>
            <summary style={{ cursor: "pointer" }}>
              <Typography variant="body2" component="span">{warnings.length} note{warnings.length > 1 ? "s" : ""} about this question file</Typography>
            </summary>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {warnings.map((w, i) => <li key={i}><Typography variant="caption">{w}</Typography></li>)}
            </ul>
          </details>
        </Alert>
      )}
      {missingImages.length > 0 && (
        <Alert severity="info">
          <Typography variant="body2">
            {missingImages.length} image{missingImages.length > 1 ? "s" : ""} couldn't be found: {missingImages.join(", ")}.
            Those questions still work, just without the picture. If you have the files, add them with "Optional: upload images".
          </Typography>
        </Alert>
      )}
    </Box>
  );
}

function SummaryView({ playerCount, config, topic, module, preRows, postRows, gameRows, sessionId: savedSessionId, onReturn, onDelivered, remoteMembers = {} }) {
  // Names typed here; online, a player's device can send its names (used while the field here is untouched).
  const [typed, setMembers] = useState(() => Array(playerCount).fill(null));
  const members = typed.map((m, i) => m ?? remoteMembers[i] ?? "");
  const [fallbackId] = useState(() => makeSessionId());
  const sessionId = savedSessionId || fallbackId; // one id per game, so a re-sent result can be spotted
  const [sendState, setSendState] = useState({ status: "idle", message: "" });
  const summary = summarizeTeams({ preRows, postRows, gameRows, playerCount, members });
  const namesMissing = config.askNames && members.some((m) => !m.trim());
  const filename = resultsFilename(topic, module);
  const allRows = () => [...teamInfoRows(summary, sessionId), ...preRows, ...gameRows, ...postRows];
  const download = () => { downloadText(filename, toCsv(allRows())); onDelivered?.(); };
  const send = async () => {
    setSendState({ status: "sending", message: "" });
    const result = await sendResults(config.resultsUrl, buildPayload({ sessionId, config, topic, module, summary, rows: allRows() }));
    setSendState(result.status === "sent" ? { status: "sent", message: "" } : { status: "error", message: result.message });
    if (result.status === "sent") onDelivered?.();
  };
  // A real mailto: link (most reliable way to open the email app); clicking it also downloads the file to attach.
  const mailtoHref = config.instructorEmail
    ? buildMailto({ to: config.instructorEmail, course: config.course, topic, module, summary, filename })
    : "";
  const hasDelivery = Boolean(config.resultsUrl || config.instructorEmail);

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default", color: "text.primary", py: 6 }}>
      <Container maxWidth="sm">
        <Card sx={{ p: { xs: 3, md: 4 } }}>
          <Box sx={{ textAlign: "center" }}>
            <Box aria-hidden sx={{ fontSize: 56, lineHeight: 1 }}>🏁</Box>
            <Typography variant="h4" component="h1" sx={{ mt: 1 }}>Session complete</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>Nice work! Here's how your survey scores changed.</Typography>
          </Box>
          <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", my: 3, "& td, & th": { p: 1, borderBottom: "1px solid", borderColor: "divider", textAlign: "left" } }}>
            <thead><tr><th scope="col">Player</th><th scope="col">Survey before</th><th scope="col">Survey after</th><th scope="col">Change</th></tr></thead>
            <tbody>
              {summary.map((t) => {
                const delta = t.postScore - t.preScore;
                return (
                  <tr key={t.playerIndex}>
                    <td><Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}><TeamToken index={t.playerIndex} size={20} />{t.team}</Box></td>
                    <td>{t.preScore}/{t.surveyQuestions}</td>
                    <td><strong>{t.postScore}/{t.surveyQuestions}</strong></td>
                    <Box component="td" sx={{ fontWeight: 800, color: delta > 0 ? "success.main" : delta < 0 ? "error.main" : "text.secondary" }}>{delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : "±0"}</Box>
                  </tr>
                );
              })}
            </tbody>
          </Box>
          <Typography variant="h6" component="h2">Who played?</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            {config.askNames ? "Required by your instructor:" : "Optional:"} type the names or student IDs of everyone playing as each player.
          </Typography>
          {summary.map((t, i) => (
            <TextField
              key={i}
              fullWidth
              required={config.askNames}
              sx={{ mb: 1.5 }}
              label={`${TEAM_SYMBOLS[i]} ${t.team}: names or student IDs`}
              value={members[i]}
              onChange={(e) => setMembers((prev) => prev.map((m, j) => (j === i ? e.target.value : m)))}
            />
          ))}
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, mt: 2 }}>
            {config.resultsUrl && (
              <>
                <Button variant="contained" size="large" disabled={namesMissing || ["sending", "sent"].includes(sendState.status)} onClick={send}>
                  {sendState.status === "sending" ? "Sending…" : sendState.status === "sent" ? "Sent ✓" : "📤 Send results to instructor"}
                </Button>
                <Typography variant="caption" color="text.secondary">Goes to the results sheet named in this question file{config.course ? ` (${config.course})` : ""}.</Typography>
                {sendState.status === "sent" && <Alert severity="success">Sent! Your instructor has your results. You can also download a copy below.</Alert>}
                {sendState.status === "error" && <Alert severity="error">{sendState.message}</Alert>}
              </>
            )}
            {config.instructorEmail && (
              <>
                <Button variant={config.resultsUrl ? "outlined" : "contained"} size="large" disabled={namesMissing} href={mailtoHref} onClick={download}>✉ Email results to instructor</Button>
                <Typography variant="caption" color="text.secondary">Downloads the results file and opens your email app. Attach the file before sending.</Typography>
              </>
            )}
            <Button variant={hasDelivery ? "text" : "contained"} size="large" disabled={namesMissing} onClick={download}>⬇ Download results (CSV)</Button>
            {namesMissing && <Typography variant="caption" color="text.secondary">Type the names or student IDs for every player above to unlock these buttons.</Typography>}
            {!hasDelivery && <Typography variant="caption" color="text.secondary">Submit this file as your instructor asked, for example on your course page.</Typography>}
            <Button variant="text" color="inherit" onClick={onReturn}>Back to main menu</Button>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2 }}>
            Closing this tab before sending or downloading loses the results.
          </Typography>
        </Card>
      </Container>
    </Box>
  );
}

// Instructors paste a question-file link and get a game link for students.
// Start page: a player joining an online game that their host opened.
function JoinOnline({ onJoin }) {
  const [open, setOpen] = useState(false);
  return (
    <Card sx={{ mt: 3, p: 2.5, textAlign: "left" }}>
      <Box sx={{ display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
        <Box aria-hidden sx={{ fontSize: 34, lineHeight: 1 }}>📡</Box>
        <Box sx={{ flex: "1 1 220px" }}>
          <Typography variant="h6" component="h2" sx={{ lineHeight: 1.2 }}>Join an online game</Typography>
          <Typography variant="body2" color="text.secondary">Your host opened a game and shows a room code. Play from this device.</Typography>
        </Box>
        {!open && <Button variant="outlined" onClick={() => setOpen(true)}>Enter a code</Button>}
      </Box>
      {open && <Box sx={{ mt: 2 }}><JoinCodeForm onJoin={onJoin} onCancel={() => setOpen(false)} /></Box>}
    </Card>
  );
}

function ShareLinkBuilder() {
  const [deck, setDeck] = useState("");
  const [images, setImages] = useState("");
  const [copied, setCopied] = useState(false);
  const pageUrl = `${window.location.origin}${window.location.pathname}`;
  const link = deck.trim() ? buildShareLink(pageUrl, deck, images) : "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <Accordion sx={{ mt: 3, textAlign: "left" }}>
      <AccordionSummary expandIcon={<span aria-hidden>▾</span>}>
        <Typography sx={{ fontWeight: 700 }}>🔗 For instructors: share your questions as a link</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Students open the link and your questions load automatically. Use a Google Sheets "Publish to web → Tab-separated values" link,
          a GitHub file, or any public .tsv or .lock link. Anyone with a plain .tsv link can read the answers; share an encrypted .lock file to keep them hidden.
        </Typography>
        {isUnpublishedSheet(deck) && <Alert severity="warning" sx={{ mb: 2 }}>This Sheets link isn't published yet: File → Share → Publish to web → Tab-separated values.</Alert>}
        <TextField fullWidth label="Link to your question file" value={deck} onChange={(e) => { setDeck(e.target.value); setCopied(false); }} sx={{ mb: 2 }} />
        <TextField fullWidth label="Link to your image folder (optional)" value={images} onChange={(e) => { setImages(e.target.value); setCopied(false); }} sx={{ mb: 2 }} />
        {link && (
          <>
            <TextField fullWidth label="Game link for students" value={link} slotProps={{ htmlInput: { readOnly: true } }} sx={{ mb: 1 }} />
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button variant="contained" onClick={copy}>{copied ? "Copied ✓" : "Copy link"}</Button>
              <Button href={link} target="_blank" rel="noopener">Test it</Button>
            </Box>
          </>
        )}
      </AccordionDetails>
    </Accordion>
  );
}

// --- MAIN APP ---

// Phases that are autosaved and can be resumed after a refresh.
const RESUMABLE_PHASES = ["PRE_SURVEY", "GAME", "POST_SURVEY", "SUMMARY"];

// A link with ?join=CODE opens this device as a player in someone else's online game.
export default function App() {
  const [joinCode, setJoinCode] = useState(() => normalizeRoomCode(new URLSearchParams(window.location.search).get("join")));
  const join = (code) => { window.history.replaceState(null, "", `?join=${formatRoomCode(code)}`); setJoinCode(code); };
  const leave = () => { window.history.replaceState(null, "", window.location.pathname); setJoinCode(""); };
  if (joinCode) {
    return (
      <Suspense fallback={<Box role="status" sx={{ p: 6, textAlign: "center", minHeight: "100vh", bgcolor: "background.default", color: "text.primary" }}><Typography>Opening the game…</Typography></Box>}>
        <GuestApp code={joinCode} onLeave={leave} />
      </Suspense>
    );
  }
  return <HostApp onJoin={join} />;
}

// Survey answers collected for an online game, by phase and player: { sliders, answers }.
const NO_SURVEYS = { pre: {}, post: {} };

function HostApp({ onJoin }) {
  const [phase, setPhase] = useState("SETUP");
  // Once results are sent or downloaded, the saved copy is deleted (shared computers) and not saved again.
  const [resultsDelivered, setResultsDelivered] = useState(false);
  // Where a question file loaded from a link came from (shown on the start page).
  const [deckHost, setDeckHost] = useState("");
  const [gameMode, setGameMode] = useState(null);
  const [playerCount, setPlayerCount] = useState(2);
  const [sessionMinutes, setSessionMinutes] = useState(0);
  // Solo: reach a net-worth goal, or play against the bot ("easy" | "medium" | "hard"; bot.js).
  const [soloMode, setSoloMode] = useState("goal");
  const [botLevel, setBotLevel] = useState(DEFAULT_BOT_LEVEL);
  const [startPlayer, setStartPlayer] = useState(0);
  const [allTsvRows, setAllTsvRows] = useState([]);
  const [loadingError, setLoadingError] = useState(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [selectedModule, setSelectedModule] = useState(null);
  const [moduleModalOpen, setModuleModalOpen] = useState(false);
  const [modules, setModules] = useState([]);
  const [preRows, setPreRows] = useState([]);
  const [postRows, setPostRows] = useState([]);
  const [gameRows, setGameRows] = useState([]);
  const [playerQuestionSets, setPlayerQuestionSets] = useState([]);
  const [confQ, setConfQ] = useState([]);
  
  // NEW STATES
  const [filesConfirmed, setFilesConfirmed] = useState(false);
  const [localImageMap, setLocalImageMap] = useState({});
  const [imagesBase, setImagesBase] = useState(""); // image folder link (?images=)
  const [pendingCipher, setPendingCipher] = useState(null); // encrypted file waiting for its password
  const [passwordError, setPasswordError] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  // Autosave: a saved session offered on the start page, the game's latest state and the state to resume from.
  const [resumeOffer, setResumeOffer] = useState(() => {
    const saved = loadSnapshot();
    return saved && RESUMABLE_PHASES.includes(saved.phase) ? saved : null;
  });
  const [gameSnapshot, setGameSnapshot] = useState(null);
  const [resumeGame, setResumeGame] = useState(null);
  const [sessionId, setSessionId] = useState("");
  // Online play (players on their own devices): "local" or "online", the open room, and what devices sent.
  const [playMode, setPlayMode] = useState("local");
  const [online, setOnline] = useState(null); // { code } while hosting
  const [surveyDone, setSurveyDone] = useState(NO_SURVEYS);
  const [answerHere, setAnswerHere] = useState([]); // players whose survey the host answers here instead
  const [remoteMembers, setRemoteMembers] = useState({});
  const onlineHandlers = useRef({});
  const runnerRef = useRef(null);
  const room = useHostRoom(onlineHandlers);
  const claims = room.lobby.claims;
  const hostSlots = claims.map((c, i) => (c === "host" ? i : -1)).filter((i) => i >= 0);
  const remoteSlots = claims.map((c, i) => (c && c !== "host" ? i : -1)).filter((i) => i >= 0);

  // The bot plays only on this computer (not in online games).
  const bot = useMemo(() => (playerCount === 1 && soloMode === "bot" && playMode === "local" ? { level: botLevel } : null), [playerCount, soloMode, playMode, botLevel]);

  const validation = useMemo(
    () => (allTsvRows.length ? validateQuestionRows(allTsvRows) : null),
    [allTsvRows]
  );
  const config = useMemo(() => readConfig(allTsvRows), [allTsvRows]);

  // Save the session in this browser so an accidental refresh doesn't lose it.
  useEffect(() => {
    if (!RESUMABLE_PHASES.includes(phase) || resultsDelivered) return;
    saveSnapshot({
      phase, sessionId, allTsvRows, imagesBase, gameMode, selectedModule, playerCount, sessionMinutes, startPlayer,
      botLevel: bot?.level || null,
      playerQuestionSets, confQ, preRows, postRows, gameRows, game: gameSnapshot,
      hadImages: Object.keys(localImageMap).length > 0,
      // Online: the room reopens with the same code, and devices get their players back.
      online: online ? { code: online.code, claims, surveyDone } : null,
    });
  }, [phase, sessionId, allTsvRows, imagesBase, gameMode, selectedModule, playerCount, sessionMinutes, startPlayer, bot,
      playerQuestionSets, confQ, preRows, postRows, gameRows, gameSnapshot, localImageMap, online, claims, surveyDone, resultsDelivered]);

  useEffect(() => {
    const handlePopState = () => window.history.pushState(null, document.title, window.location.href);
    const handleBeforeUnload = (e) => {
      if (phase !== "SETUP" && phase !== "SUMMARY") { e.preventDefault(); e.returnValue = "Game progress will be lost."; return "Game progress will be lost."; }
    };
    window.history.pushState(null, document.title, window.location.href);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [phase]);

  // Fetch the board code in the background once the start page is showing.
  useEffect(() => {
    const warm = () => loadGameScreen().catch(() => { /* retried when the game starts */ });
    const id = window.requestIdleCallback ? window.requestIdleCallback(warm, { timeout: 3000 }) : window.setTimeout(warm, 1500);
    return () => (window.cancelIdleCallback ? window.cancelIdleCallback(id) : window.clearTimeout(id));
  }, []);

  // A new version of the app may reload the page by itself only on an empty start page.
  useEffect(() => { setUpdateReloadSafe(phase === "SETUP" && allTsvRows.length === 0 && !resumeOffer); }, [phase, allTsvRows, resumeOffer]);

  // Reset confirmation if file is cleared
  useEffect(() => {
    if (allTsvRows.length === 0) {
      setFilesConfirmed(false);
    }
  }, [allTsvRows]);

  // The board is built once per game (online, guests get its fixed parts).
  const boardData = useMemo(() => (gameMode && allTsvRows.length ? buildBoardFromTsv(gameMode, allTsvRows, selectedModule) : null), [gameMode, allTsvRows, selectedModule]);

  // --- Online play: what the room does when devices talk ---
  const surveyPhase = phase === "PRE_SURVEY" ? "pre" : phase === "POST_SURVEY" ? "post" : null;
  useEffect(() => {
    onlineHandlers.current = {
      onAction: (slots, name, args) => runnerRef.current?.(name, args),
      onSurvey: (slots, msg) => {
        if (msg.phase !== surveyPhase) return;
        const keys = confQ.map((c) => c.key);
        setSurveyDone((prev) => {
          const next = { ...prev, [msg.phase]: { ...prev[msg.phase] } };
          slots.forEach((slot) => {
            next[msg.phase][slot] = { sliders: cleanSliders(msg.sliders?.[slot], keys), answers: cleanAnswers(msg.answers?.[slot], (playerQuestionSets[slot] || []).length) };
          });
          return next;
        });
      },
      onMembers: (slot, text) => setRemoteMembers((m) => ({ ...m, [slot]: text })),
      // What a device needs for the current phase when it joins, reconnects or the phase changes.
      syncFor: (token, slots) => {
        if (surveyPhase) {
          return [{
            t: "survey", phase: surveyPhase, confidence: confQ,
            sets: Object.fromEntries(slots.map((slot) => [slot, (playerQuestionSets[slot] || []).map(hideAnswer)])),
            done: slots.length > 0 && slots.every((slot) => surveyDone[surveyPhase][slot]),
          }];
        }
        if (phase === "SUMMARY") return [{ t: "summary", summary: summarizeTeams({ preRows, postRows, gameRows, playerCount, members: [] }) }];
        return [];
      },
    };
  });
  // Tell the devices about every phase change (the board first, when the game starts).
  useEffect(() => {
    const session = room.session.current;
    if (!session || !online) return;
    if (phase === "GAME" && boardData) session.publishBoard(publicBoard(boardData));
    if (["LOBBY", "PRE_SURVEY", "GAME", "POST_SURVEY", "SUMMARY"].includes(phase)) session.setPhase(phase);
  }, [phase, online, room.room, room.session, boardData]);
  // An online survey ends when every player has answered, on a device or here.
  useEffect(() => {
    if (!online || !surveyPhase) return;
    const got = surveyDone[surveyPhase];
    const players = Array.from({ length: playerCount }, (_, i) => i);
    if (!players.every((i) => got[i])) return;
    const rows = surveyRows({
      phase: surveyPhase, players, questionSets: playerQuestionSets, confidence: confQ,
      sliders: players.map((i) => got[i].sliders), answers: players.map((i) => got[i].answers),
    });
    setAnswerHere([]);
    if (surveyPhase === "pre") { setPreRows(rows); setStartPlayer(bestPreSurveyPlayer(rows, playerCount)); setPhase("GAME"); }
    else { setPostRows(rows); setPhase("SUMMARY"); }
  }, [online, surveyPhase, surveyDone, playerCount, playerQuestionSets, confQ]);

  const roomMeta = () => ({ topic: gameMode || "", module: selectedModule || "", imagesBase });
  const closeRoom = () => { room.close(); setOnline(null); setSurveyDone(NO_SURVEYS); setRemoteMembers({}); setAnswerHere([]); };
  const openRoom = () => {
    forgetSavedGame();
    const code = makeRoomCode();
    setOnline({ code });
    setSurveyDone(NO_SURVEYS); setRemoteMembers({}); setAnswerHere([]);
    setPhase("LOBBY");
    room.open({ code, playerCount, meta: roomMeta() });
  };
  const startOnlineGame = () => {
    setSessionId(makeSessionId());
    setPlayerQuestionSets(buildSurveySets(allTsvRows, { topic: gameMode, module: selectedModule, playerCount }));
    setConfQ(buildConfidenceQuestions(allTsvRows, { topic: gameMode, module: selectedModule }));
    setSurveyDone(NO_SURVEYS);
    setPhase("PRE_SURVEY");
  };
  const recordLocalSurvey = (p) => ({ sliders, answers, players }) => {
    setSurveyDone((prev) => {
      const next = { ...prev, [p]: { ...prev[p] } };
      players.forEach((slot) => { next[p][slot] = { sliders: sliders[slot] || {}, answers: answers[slot] || [] }; });
      return next;
    });
    setAnswerHere((a) => a.filter((slot) => !players.includes(slot)));
  };
  const hostOnline = useMemo(() => (online ? {
    role: "host",
    publish: (view) => room.session.current?.publishView(view),
    bindRunner: (fn) => { runnerRef.current = fn; return () => { if (runnerRef.current === fn) runnerRef.current = null; }; },
    remoteSlots,
  } : null), [online, room.session, remoteSlots.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Handlers ---

  const parseAndLoad = (text) => {
    let rows = [];
    try { rows = parseTsv(text); } catch { /* reported below */ }
    if (rows.length > 0) { setAllTsvRows(rows); setGameMode(null); setSelectedModule(null); }
    else setLoadingError("This question file has no question rows. It needs a header line plus at least one row.");
  };
  const acceptQuestionText = (text) => {
    if (text.length > MAX_FILE_BYTES) { setLoadingError(TOO_BIG); return; }
    // Encrypted files from encryptor.html (see lockFile.js for both formats).
    if (lockFormat(text)) { setPasswordError(""); setPendingCipher(text); return; }
    if (!text.includes("\t")) {
      setLoadingError("This isn't a question file (.tsv or .lock). If you used a link, check that it points to the file itself, not to a web page.");
      return;
    }
    parseAndLoad(text);
  };
  const unlock = async (password) => {
    setUnlocking(true);
    let text = null;
    try {
      text = await decryptLockFile(pendingCipher, password);
    } catch (e) {
      setUnlocking(false);
      setPasswordError(e instanceof Error && /Web Crypto/.test(e.message) ? e.message : "Couldn't open the file. Check the internet connection and reload the page.");
      return;
    }
    setUnlocking(false);
    if (!text) { setPasswordError("That password didn't work. Passwords are case-sensitive."); return; }
    setPendingCipher(null);
    parseAndLoad(text);
  };
  const loadFromLink = async (input) => {
    setLoadingError(null);
    if (isUnpublishedSheet(input)) {
      setLoadingError("This Google Sheets link isn't published. In Google Sheets choose File → Share → Publish to web → Tab-separated values (.tsv), then use that link.");
      return;
    }
    const url = normalizeDeckUrl(input);
    if (!url) { setLoadingError("That doesn't look like a link to a question file."); return; }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      setDeckHost(DECK_SHORTCUTS[String(input).trim().toLowerCase()] ? "" : new URL(url, window.location.href).hostname);
      acceptQuestionText(text);
    } catch {
      setLoadingError(DECK_SHORTCUTS[String(input).trim().toLowerCase()]
        ? "Couldn't load the example questions. Check your internet connection and try again."
        : "Couldn't load the question file from this link. Check that it's public (for Google Sheets: Publish to web as TSV) and that you're online.");
    }
  };
  const forgetSavedGame = () => {
    clearSnapshot(); setGameSnapshot(null); setResumeGame(null);
  };
  // Back to the start page with no file (also drops ?deck= from the address bar).
  const resetFile = () => {
    forgetSavedGame();
    setAllTsvRows([]); setImagesBase(""); setDeckHost("");
    window.history.replaceState(null, "", window.location.pathname);
  };
  const resumeSaved = () => {
    const saved = resumeOffer;
    setAllTsvRows(saved.allTsvRows); setImagesBase(saved.imagesBase || "");
    setGameMode(saved.gameMode); setSelectedModule(saved.selectedModule); setPlayerCount(saved.playerCount);
    setSessionMinutes(saved.sessionMinutes); setStartPlayer(saved.startPlayer); setSessionId(saved.sessionId || "");
    if (saved.botLevel) { setSoloMode("bot"); setBotLevel(saved.botLevel); } else setSoloMode("goal");
    setPlayerQuestionSets(saved.playerQuestionSets); setConfQ(saved.confQ);
    setPreRows(saved.preRows); setPostRows(saved.postRows); setGameRows(saved.gameRows);
    setResumeGame(saved.game || null); setGameSnapshot(saved.game || null);
    setFilesConfirmed(true); setPhase(saved.phase); setResumeOffer(null);
    if (saved.online?.code) {
      setOnline({ code: saved.online.code });
      setSurveyDone(saved.online.surveyDone || NO_SURVEYS);
      setPlayMode("online");
      room.open({ code: saved.online.code, playerCount: saved.playerCount, claims: saved.online.claims, meta: { topic: saved.gameMode || "", module: saved.selectedModule || "", imagesBase: saved.imagesBase || "" } });
    }
  };
  const discardSaved = () => {
    clearSnapshot(); setResumeOffer(null);
    const { deck } = readDeckParams(window.location.search);
    if (deck) loadFromLink(deck);
  };

  // Shareable links: ?deck=<question file link or shortcut>&images=<image folder link>
  useEffect(() => {
    const { deck, images } = readDeckParams(window.location.search);
    if (images) setImagesBase(normalizeImagesBase(images));
    if (deck && !resumeOffer) loadFromLink(deck); // a saved game is offered first
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFileUpload = (e) => {
    setLoadingError(null);
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setLoadingError(TOO_BIG); e.target.value = ""; return; }
    setDeckHost("");
    const reader = new FileReader();
    reader.onload = (evt) => acceptQuestionText(String(evt.target.result || ""));
    reader.readAsText(file);
    e.target.value = ""; // allow choosing the same file again
  };

  const handleImageUpload = (e) => {
    const files = Array.from(e.target.files);
    const newMap = {};
    files.forEach(file => {
      newMap[file.name] = URL.createObjectURL(file);
    });
    setLocalImageMap(prev => ({ ...prev, ...newMap }));
  };

  const resolveImageSource = (imgName) => resolveImage(imgName, localImageMap, imagesBase);

  const selectTopic = (t) => {
    setGameMode(t);
    const mods = getModulesForTopic(allTsvRows, t);
    setModules(mods);
    setSelectedModule(mods[0] || null);
    setModuleModalOpen(true);
  };

  const confirmModule = () => {
    setModuleModalOpen(false);
  };

  // Survey sets are built here (not when the module is confirmed) so they always
  // match the final team count.
  const startGame = () => {
    forgetSavedGame(); // a new game replaces any saved one
    setResultsDelivered(false);
    setSessionId(makeSessionId());
    setPlayerQuestionSets(buildSurveySets(allTsvRows, { topic: gameMode, module: selectedModule, playerCount }));
    setConfQ(buildConfidenceQuestions(allTsvRows, { topic: gameMode, module: selectedModule }));
    setPhase("PRE_SURVEY");
  };

  // --- Render ---

  // REVISED LOGIC: Show Landing Page if NO Data OR Not Confirmed
  if (allTsvRows.length === 0 || !filesConfirmed) {
    const hasData = allTsvRows.length > 0;
    
    const choice = (icon, title, text, action) => (
      <Card
        component="button"
        onClick={action.onClick}
        sx={{ p: 2.5, textAlign: "left", cursor: "pointer", font: "inherit", color: "text.primary", bgcolor: "background.paper", display: "flex", gap: 2, alignItems: "center", width: "100%", transition: "transform .15s, box-shadow .15s", "&:hover": { transform: "translateY(-2px)", boxShadow: 6, borderColor: "primary.main" }, "&:focus-visible": { outline: "3px solid", outlineColor: "primary.main", outlineOffset: 2 }, "@media (prefers-reduced-motion: reduce)": { transition: "none", "&:hover": { transform: "none" } } }}
      >
        <Box aria-hidden sx={{ fontSize: 34, lineHeight: 1 }}>{icon}</Box>
        <Box component="span" sx={{ display: "block", flex: 1 }}>
          <Typography variant="h6" component="span" sx={{ display: "block", lineHeight: 1.2 }}>{title}</Typography>
          <Typography variant="body2" component="span" color="text.secondary" sx={{ display: "block" }}>{text}</Typography>
        </Box>
        <Box aria-hidden component="span" sx={{ fontSize: 22, color: "text.secondary" }}>›</Box>
      </Card>
    );

    return (
      <Box sx={{ minHeight: "100vh", bgcolor: "background.default", color: "text.primary", py: { xs: 4, md: 8 } }}>
        <Container maxWidth="sm" sx={{ textAlign: "center" }}>
          <Box aria-hidden sx={{ fontSize: 56, lineHeight: 1, mb: 1 }}>🎲</Box>
          <Typography variant="h2" component="h1" sx={{ fontSize: { xs: "2.4rem", md: "3.4rem" }, mb: 1, textWrap: "balance" }}>Learn Around the Board</Typography>
          <Typography variant="h6" component="p" color="text.secondary" sx={{ fontWeight: 500, mb: 4, textWrap: "balance" }}>
            Turn any course into a board-game review session: roll, answer, invest and outwit the other players.
          </Typography>

          {resumeOffer && !hasData && (
            <Alert
              severity="info"
              sx={{ mb: 2, textAlign: "left" }}
              action={
                <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                  <Button variant="contained" size="small" onClick={resumeSaved}>Resume</Button>
                  <Button size="small" color="inherit" onClick={discardSaved} sx={{ whiteSpace: "nowrap" }}>Start over</Button>
                </Box>
              }
            >
              <strong>Resume your game?</strong>{" "}
              Saved at {new Date(resumeOffer.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ·{" "}
              {[resumeOffer.gameMode, resumeOffer.selectedModule].filter(Boolean).join(" / ")} · {resumeOffer.playerCount === 1 ? (resumeOffer.botLevel ? `solo against the ${BOT_LEVELS[resumeOffer.botLevel]?.label || ""} bot` : "solo") : `${resumeOffer.playerCount} players`} ·{" "}
              {{ PRE_SURVEY: "pre-game survey", GAME: `turn ${resumeOffer.game?.totalTurns ?? 0}`, POST_SURVEY: "post-game survey", SUMMARY: "results screen" }[resumeOffer.phase]}.
              {resumeOffer.hadImages && " Uploaded images aren't saved; upload them again if your questions use them."}
            </Alert>
          )}
          {!hasData ? (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, textAlign: "left" }}>
              {choice("🧬", "Play the demo", "16S rRNA sequencing & QIIME 2 (the original course).", { onClick: () => loadFromLink("demo") })}
              {choice("📊", "Try a different subject", "Intro Statistics example, made with the question-writer skill.", { onClick: () => loadFromLink("stats") })}
              <Card sx={{ p: 2.5, display: "flex", gap: 2, alignItems: "center", bgcolor: "background.paper" }}>
                <Box aria-hidden sx={{ fontSize: 34, lineHeight: 1 }}>📂</Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="h6" component="h2" sx={{ lineHeight: 1.2 }}>Use your instructor's questions</Typography>
                  <Typography variant="body2" color="text.secondary">Upload the .tsv or encrypted .lock file you were given.</Typography>
                </Box>
                <Button variant="contained" component="label">
                  Upload
                  <input type="file" hidden accept=".tsv,.txt,.lock" onChange={handleFileUpload} />
                </Button>
              </Card>
            </Box>
          ) : (
            <Card sx={{ p: { xs: 3, md: 4 }, textAlign: "left" }}>
              <Alert severity="success" sx={{ mb: 2 }}>
                <strong>Loaded {allTsvRows.length} questions{deckHost ? ` from ${deckHost}` : ""}.</strong> Check the notes below, then continue.
              </Alert>
              {(config.resultsUrl || config.instructorEmail) && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  This question file sends your results to {config.course ? `the instructor of ${config.course}` : "an instructor"} at the end of the game.
                  {deckHost && ` It came from ${deckHost}: only play files your instructor gave you.`}
                </Alert>
              )}
              <ValidationReport validation={validation} imageMap={localImageMap} imageBase={imagesBase} />
              <Button variant="outlined" component="label" fullWidth size="large" color="secondary" sx={{ mb: 1 }}>
                🖼️ Optional: upload images
                <input type="file" hidden multiple accept="image/*" onChange={handleImageUpload} />
              </Button>
              {Object.keys(localImageMap).length > 0 && (
                <Typography variant="caption" sx={{ display: "block", mb: 1, color: "success.main", fontWeight: 700 }}>
                  {Object.keys(localImageMap).length} images ready.
                </Typography>
              )}
              <Button variant="contained" fullWidth size="large" color="success" sx={{ mt: 2, py: 1.5, fontSize: "1.1rem" }} onClick={() => setFilesConfirmed(true)}>
                Continue to game setup →
              </Button>
              <Button fullWidth size="small" color="inherit" sx={{ mt: 1 }} onClick={resetFile}>Use a different file</Button>
            </Card>
          )}

          {loadingError && <Alert severity="error" sx={{ mt: 2, textAlign: "left" }}>{loadingError}</Alert>}
          {!hasData && <JoinOnline onJoin={onJoin} />}
          {!hasData && <ShareLinkBuilder />}
          <InstallButton />

          <Typography variant="body2" sx={{ mt: 4 }}>
            <a href="#" onClick={(e) => { e.preventDefault(); setRulesOpen(true); }}>Quick rules</a> ·{" "}
            <a href="./guide/students.html" target="_blank" rel="noopener">Student guide</a> ·{" "}
            <a href="./guide/" target="_blank" rel="noopener">Instructor guide</a> ·{" "}
            <a href="./encryptor.html" target="_blank" rel="noopener">Encrypt a question file</a>
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
            Designed by Hans Ghezzi ·{" "}
            <a href="./privacy.html" target="_blank" rel="noopener">Privacy</a> ·{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); resetConsent(); }}>Analytics settings</a>
          </Typography>
        </Container>
        <ConsentBanner />
        {pendingCipher != null && <PasswordDialog error={passwordError} busy={unlocking} onSubmit={unlock} onCancel={() => setPendingCipher(null)} />}
        <RulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />
      </Box>
    );
  }

  // --- STANDARD GAME FLOW ---

  if (phase === "SETUP") {
    const topics = getAllTopics(allTsvRows);
    return (
      <Box sx={{ minHeight: "100vh", bgcolor: "background.default", color: "text.primary", py: 5, pb: 14 }}>
        <Container maxWidth="md">
          <Typography variant="h3" component="h1" sx={{ textAlign: "center", mb: 4 }}>Game setup</Typography>

          <Card sx={{ p: 3, mb: 3 }}>
            <Typography variant="h6" component="h2" gutterBottom>1 · How many players?</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: -0.5, mb: 1.5 }}>Players take turns. Each player can be one student or a small group.</Typography>
            <Box sx={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1.5 }}>
              {[1, 2, 3, 4].map((n) => (
                <Box
                  key={n}
                  component="button"
                  aria-pressed={playerCount === n}
                  onClick={() => setPlayerCount(n)}
                  sx={{ p: 1.5, borderRadius: 2, cursor: "pointer", font: "inherit", color: "text.primary", bgcolor: playerCount === n ? "action.selected" : "background.paper", border: "2px solid", borderColor: playerCount === n ? "primary.main" : "divider", "&:hover": { borderColor: "primary.main" }, "&:focus-visible": { outline: "3px solid", outlineColor: "primary.main", outlineOffset: 2 } }}
                >
                  <Box sx={{ display: "flex", justifyContent: "center", gap: 0.5, mb: 0.5 }}>
                    {TEAM_COLORS.slice(0, n).map((c, i) => <TeamToken key={i} index={i} size={20} />)}
                  </Box>
                  <Typography sx={{ fontWeight: 800 }}>{n === 1 ? "Solo" : `${n} players`}</Typography>
                </Box>
              ))}
            </Box>
          </Card>

          {playerCount === 1 && playMode === "local" && (
            <Card sx={{ p: 3, mb: 3 }}>
              <Typography variant="h6" component="h2">Solo: what's the challenge?</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                Reach a net-worth goal before time runs out, or play the full rules against the bot. Either way, only your own answers count in your results.
              </Typography>
              <ToggleButtonGroup value={soloMode} exclusive onChange={(_, v) => v !== null && setSoloMode(v)} fullWidth color="primary" aria-label="Solo challenge">
                <ToggleButton value="goal" sx={{ fontWeight: 800 }}><span aria-hidden>🎯&nbsp;</span>Reach a goal</ToggleButton>
                <ToggleButton value="bot" sx={{ fontWeight: 800 }}><span aria-hidden>🤖&nbsp;</span>Play against the bot</ToggleButton>
              </ToggleButtonGroup>
              {soloMode === "bot" && (
                <>
                  <Typography sx={{ fontWeight: 800, mt: 2, mb: 1 }} id="bot-level-label">Bot difficulty</Typography>
                  <ToggleButtonGroup value={botLevel} exclusive onChange={(_, v) => v !== null && setBotLevel(v)} fullWidth color="primary" aria-labelledby="bot-level-label">
                    {BOT_LEVEL_IDS.map((id) => (
                      <ToggleButton key={id} value={id} sx={{ flexDirection: "column", py: 1 }}>
                        <Box component="span" sx={{ fontWeight: 800 }}>{BOT_LEVELS[id].label}</Box>
                        <Box component="span" sx={{ fontSize: "0.75rem", textTransform: "none" }}>answers about {Math.round(BOT_LEVELS[id].accuracy * 100)}% right</Box>
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                    Answer about as well as the bot and you have an even chance. You watch its turns, including its answers and the explanations.
                  </Typography>
                </>
              )}
            </Card>
          )}

          <Card sx={{ p: 3, mb: 3 }}>
            <Typography variant="h6" component="h2">2 · Session length</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              The game ends when one player is left standing, or when time runs out (highest net worth wins).
            </Typography>
            <ToggleButtonGroup value={sessionMinutes} exclusive onChange={(_, v) => v !== null && setSessionMinutes(v)} fullWidth color="primary">
              {[0, 30, 45, 60, 90].map((m) => <ToggleButton key={m} value={m} sx={{ fontWeight: 800 }}>{m === 0 ? "No timer" : `${m} min`}</ToggleButton>)}
            </ToggleButtonGroup>
          </Card>

          <Card sx={{ p: 3, mb: 3 }}>
            <Typography variant="h6" component="h2">3 · Where do players play?</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Online, each player joins on their own computer, tablet or phone with a room code, and this computer runs the game. <strong>Beta:</strong> some school networks block live connections, so try it once before class.
            </Typography>
            <ToggleButtonGroup value={playMode} exclusive onChange={(_, v) => v !== null && setPlayMode(v)} fullWidth color="primary">
              <ToggleButton value="local" sx={{ fontWeight: 800 }}>On this computer</ToggleButton>
              <ToggleButton value="online" sx={{ fontWeight: 800 }}>On their own devices (beta)</ToggleButton>
            </ToggleButtonGroup>
          </Card>

          <Card sx={{ p: 3 }}>
            <Typography variant="h6" component="h2" gutterBottom>4 · Choose a topic</Typography>
            <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 1.5 }}>
              {topics.map((t) => (
                <Box
                  key={t}
                  component="button"
                  aria-pressed={gameMode === t}
                  onClick={() => selectTopic(t)}
                  sx={{ p: 2.5, borderRadius: 2, cursor: "pointer", font: "inherit", textAlign: "left", color: "text.primary", bgcolor: gameMode === t ? "action.selected" : "background.paper", border: "2px solid", borderColor: gameMode === t ? "primary.main" : "divider", transition: "transform .15s", "&:hover": { transform: "translateY(-2px)", borderColor: "primary.main" }, "&:focus-visible": { outline: "3px solid", outlineColor: "primary.main", outlineOffset: 2 }, "@media (prefers-reduced-motion: reduce)": { transition: "none", "&:hover": { transform: "none" } } }}
                >
                  <Typography variant="h6" component="span" sx={{ display: "block", color: "primary.main" }}>{t}</Typography>
                  <Typography variant="body2" component="span" color="text.secondary" sx={{ display: "block" }}>{gameMode === t && selectedModule ? `Module: ${selectedModule}` : "Select to choose a module"}</Typography>
                </Box>
              ))}
            </Box>
          </Card>
        </Container>

        <Paper elevation={6} sx={{ p: 2, position: "fixed", bottom: 0, left: 0, right: 0, display: "flex", justifyContent: "center", alignItems: "center", gap: 2, zIndex: 100, borderRadius: 0 }}>
          <Button size="small" color="inherit" onClick={resetFile}>Change file</Button>
          <Typography variant="body2" color="text.secondary" sx={{ display: { xs: "none", sm: "block" }, fontWeight: 700 }} aria-live="polite">
            {gameMode ? `${playerCount === 1 ? (bot ? `Solo vs ${BOT_LEVELS[bot.level].label} bot` : "Solo") : `${playerCount} players`} · ${sessionMinutes ? `${sessionMinutes} min` : "no timer"}${playMode === "online" ? " · online" : ""} · ${[gameMode, selectedModule].filter(Boolean).join(" / ")}` : "Choose a topic to start"}
          </Typography>
          <Button variant="contained" color="success" size="large" disabled={!gameMode} onClick={playMode === "online" ? openRoom : startGame} sx={{ px: 6, py: 1.5, fontSize: "1.15rem" }}>{playMode === "online" ? "Open the online room" : "Start game"} <span aria-hidden>&nbsp;→</span></Button>
        </Paper>

        <Modal open={moduleModalOpen} onClose={() => setModuleModalOpen(false)}>
          <Box role="dialog" aria-modal="true" aria-labelledby="module-title" sx={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: "min(400px, 92vw)", maxHeight: "90vh", overflowY: "auto", bgcolor: "background.paper", color: "text.primary", p: 4, borderRadius: 3, boxShadow: 24, outline: "none" }}>
            <Typography id="module-title" variant="h6" component="h2">Select module</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{gameMode}: which part of the course should the board cover?</Typography>
            {modules.length > 0 ? modules.map((m) => <Button key={m} fullWidth size="large" aria-pressed={selectedModule === m} variant={selectedModule === m ? "contained" : "outlined"} onClick={() => setSelectedModule(m)} sx={{ mb: 1 }}>{selectedModule === m && <span aria-hidden>✓&nbsp;</span>}{m}</Button>) : <Typography>This topic has no separate modules; the whole topic is used.</Typography>}
            <Divider sx={{ my: 2 }} />
            <Button fullWidth variant="contained" color="success" size="large" sx={{ py: 1.25 }} onClick={confirmModule}>Confirm selection</Button>
          </Box>
        </Modal>
      </Box>
    );
  }

  if (phase === "LOBBY") {
    return (
      <HostLobby
        code={online?.code || ""}
        status={room.status}
        lobby={room.lobby}
        playerCount={playerCount}
        onHostSlot={(slot, on) => room.session.current?.setHostSlot(slot, on)}
        onFreeSlot={(slot) => room.session.current?.freeSlot(slot)}
        onRemoveDevice={(token) => room.session.current?.removeDevice(token)}
        onStart={startOnlineGame}
        onBack={() => { closeRoom(); setPhase("SETUP"); }}
      />
    );
  }

  // Online surveys: players answer on their devices; this computer answers for its own players.
  if (online && surveyPhase) {
    const done = Array.from({ length: playerCount }, (_, i) => Boolean(surveyDone[surveyPhase][i]));
    const here = [...new Set([...hostSlots, ...answerHere])].filter((i) => !done[i]).sort((a, b) => a - b);
    if (here.length) {
      return <SurveyView key={`${surveyPhase}-${here.join(",")}`} phase={surveyPhase} playerCount={playerCount} players={here} playerQuestionSets={playerQuestionSets} confidenceQuestions={confQ} resolveImage={resolveImageSource} score={false} finishLabel="Done" onComplete={recordLocalSurvey(surveyPhase)} />;
    }
    return <SurveyWait phase={surveyPhase} playerCount={playerCount} done={done} holders={claims} devices={room.lobby.devices} onAnswerHere={(i) => setAnswerHere((a) => [...a, i])} />;
  }

  if (phase === "PRE_SURVEY") return <SurveyView key="pre" phase="pre" playerCount={playerCount} playerQuestionSets={playerQuestionSets} confidenceQuestions={confQ} resolveImage={resolveImageSource} onComplete={d => { setPreRows(d.tidyRows); setStartPlayer(bestPreSurveyPlayer(d.tidyRows, playerCount)); setPhase("GAME"); }} />;
  if (phase === "GAME") return <Suspense fallback={<Box role="status" sx={{ p: 6, textAlign: "center" }}><Typography>Setting up the board…</Typography></Box>}><GameScreen boardData={boardData} online={hostOnline} bot={bot} bigTopic={gameMode} module={selectedModule} playerCount={playerCount} startingPlayerIndex={startPlayer} sessionMinutes={sessionMinutes} tsvRows={allTsvRows} imageMap={localImageMap} imageBase={imagesBase} resume={resumeGame} onSnapshot={setGameSnapshot} onEndGame={d => { setGameRows(d); setPhase("POST_SURVEY"); }} onExit={() => { forgetSavedGame(); closeRoom(); setPhase("SETUP"); setGameMode(null); }} /></Suspense>;
  if (phase === "POST_SURVEY") return <SurveyView key="post" phase="post" playerCount={playerCount} playerQuestionSets={playerQuestionSets} confidenceQuestions={confQ} resolveImage={resolveImageSource} onComplete={d => { setPostRows(d.tidyRows); setPhase("SUMMARY"); }} />;
  return <SummaryView playerCount={playerCount} config={config} topic={gameMode} module={selectedModule} preRows={preRows} postRows={postRows} gameRows={gameRows} sessionId={sessionId} remoteMembers={remoteMembers} onDelivered={() => { setResultsDelivered(true); clearSnapshot(); }} onReturn={() => { closeRoom(); setPhase("SETUP"); setGameMode(null); resetFile(); }} />;
}