// src/online/GuestApp.jsx
// A player's own device in an online game: join with a code, pick a player, answer
// the surveys here, and play on the board the host's computer runs.
import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Card, Container, Typography, Alert, TextField, LinearProgress } from "@mui/material";
import SurveyView from "../SurveyView";
import TeamToken from "../components/TeamToken";
import { teamDisplayName } from "../labels";
import { resolveImage } from "../images";
import { lazyWithReload } from "../lazyLoad";
import { GuestSession } from "./sessions";
import { formatRoomCode, makeDeviceToken } from "./protocol";

const GameScreen = lazyWithReload(() => import("../GameScreen"));

// This device's id for a room, kept so a refresh (or reopening the link) gets its player back.
function deviceToken(code) {
  const key = `lab-guest:${code}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved && /^[a-z0-9]{8,32}$/.test(saved)) return saved;
    const token = makeDeviceToken();
    localStorage.setItem(key, token);
    return token;
  } catch {
    return makeDeviceToken();
  }
}

const FAILURES = {
  "not-found": "No game with this code is open. Check the code with your host: the host's game page must stay open.",
  network: "Couldn't connect to the game. Some school and company networks block live connections: try another network (for example a phone hotspot), or play on the host's computer.",
  version: "This device has a different version of the game than the host. Reload this page to update it, then join again.",
  started: "This game has already started without this device. Ask the host to add you to the next game.",
  bye: "The host closed the game or removed this device.",
  unsupported: "This browser can't join online games. Use an up-to-date Chrome, Edge, Firefox or Safari.",
};

function Screen({ children, width = "sm" }) {
  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default", color: "text.primary", py: { xs: 3, md: 6 } }}>
      <Container maxWidth={width}>{children}</Container>
    </Box>
  );
}

export default function GuestApp({ code, onLeave }) {
  const [status, setStatus] = useState({ state: "connecting" });
  const [meta, setMeta] = useState(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [lobby, setLobby] = useState({ claims: [], playerCount: 0, mine: [] });
  const [phase, setPhase] = useState("LOBBY");
  const [mine, setMine] = useState([]);
  const [tiles, setTiles] = useState(null);
  const [view, setView] = useState(null);
  const [survey, setSurvey] = useState(null); // { phase, sets: { slot: questions }, confidence, done }
  const [sentSurvey, setSentSurvey] = useState({}); // phase -> true once this device sent its answers
  const [summary, setSummary] = useState(null);
  const [names, setNames] = useState({});
  const [namesSent, setNamesSent] = useState(false);
  const [notice, setNotice] = useState("");
  const sessionRef = useRef(null);

  useEffect(() => {
    let session = null;
    let cancelled = false;
    (async () => {
      let transport;
      try {
        const { createGuestTransport } = await import("./peerTransport.js");
        transport = createGuestTransport(code, { deviceId: deviceToken(code).slice(0, 6) });
      } catch {
        if (!cancelled) setStatus({ state: "failed", detail: "network" });
        return;
      }
      if (cancelled) return;
      session = new GuestSession({
        transport,
        token: deviceToken(code),
        onStatus: (state, detail) => setStatus({ state, detail }),
        onMessage: (msg) => {
          if (msg.t === "welcome") { setMeta(msg.meta || {}); setClockOffset(typeof msg.hostNow === "number" ? msg.hostNow - Date.now() : 0); }
          else if (msg.t === "lobby") { setLobby(msg); setMine(msg.mine || []); }
          else if (msg.t === "phase") { setPhase(msg.phase); setMine(msg.mine || []); if (msg.phase !== "GAME") setView(null); }
          else if (msg.t === "board") setTiles(msg.tiles);
          else if (msg.t === "view") setView(msg.view);
          else if (msg.t === "survey") setSurvey(msg);
          else if (msg.t === "summary") setSummary(msg);
          else if (msg.t === "error" && msg.message) setNotice(msg.message);
        },
      });
      sessionRef.current = session;
      session.connect();
    })();
    return () => { cancelled = true; session?.close(); sessionRef.current = null; };
  }, [code]);

  const send = (msg) => sessionRef.current?.send(msg);
  const playerCount = lobby.playerCount || 0;
  const imageSrc = (name) => resolveImage(name, {}, meta?.imagesBase || "");
  const title = [meta?.topic, meta?.module].filter(Boolean).join(" / ");
  const online = useMemo(() => (view ? {
    role: "guest", view, mySlots: mine, clockOffset,
    send: (name, args) => { if (!send({ t: "act", name, args, rev: view.stepRev })) setNotice("Not connected to the host right now. Wait a moment and try again."); },
  } : null), [view, mine, clockOffset]);

  const banner = status.state === "reconnecting" && (
    <Alert severity="warning" sx={{ position: "fixed", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 2000, boxShadow: 3 }} role="status">
      Connection lost. Reconnecting to the host… If the host restarted the game with a new code, go back and join again.
    </Alert>
  );
  const noticeBar = notice && (
    <Alert severity="info" onClose={() => setNotice("")} sx={{ position: "fixed", bottom: 12, left: "50%", transform: "translateX(-50%)", zIndex: 2000, boxShadow: 3 }}>{notice}</Alert>
  );

  if (status.state === "failed") {
    return (
      <Screen>
        <Card sx={{ p: { xs: 3, md: 4 } }}>
          <Typography variant="h4" component="h1" gutterBottom>Couldn't join {formatRoomCode(code)}</Typography>
          <Alert severity="error" sx={{ mb: 2 }}>{FAILURES[status.detail] || FAILURES.network}</Alert>
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button variant="contained" onClick={() => window.location.reload()}>Try again</Button>
            <Button color="inherit" onClick={onLeave}>Back to the start page</Button>
          </Box>
        </Card>
      </Screen>
    );
  }

  if (!meta) {
    return (
      <Screen>
        <Card sx={{ p: { xs: 3, md: 4 } }} role="status" aria-live="polite">
          <Typography variant="h4" component="h1" gutterBottom>Joining {formatRoomCode(code)}…</Typography>
          <LinearProgress sx={{ my: 2 }} />
          <Typography color="text.secondary">Connecting to the host's game. This usually takes a few seconds.</Typography>
          <Button color="inherit" sx={{ mt: 2 }} onClick={onLeave}>Cancel</Button>
        </Card>
      </Screen>
    );
  }

  // --- Lobby: pick a player ---
  if (phase === "LOBBY") {
    return (
      <Screen>
        {banner}{noticeBar}
        <Card sx={{ p: { xs: 3, md: 4 } }}>
          <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 800 }}>Online game {formatRoomCode(code)}{title ? ` · ${title}` : ""}</Typography>
          <Typography variant="h4" component="h1" gutterBottom>Who are you playing as?</Typography>
          <Typography color="text.secondary" sx={{ mb: 2 }}>Pick your player. A player can be one student or a small group sharing this device.</Typography>
          <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0, display: "flex", flexDirection: "column", gap: 1 }}>
            {lobby.claims.map((holder, i) => {
              const isMine = mine.includes(i);
              return (
                <Box component="li" key={i} sx={{ display: "flex", alignItems: "center", gap: 1.5, p: 1.25, border: "2px solid", borderColor: isMine ? "primary.main" : "divider", borderRadius: 2, flexWrap: "wrap" }}>
                  <TeamToken index={i} />
                  <Typography sx={{ fontWeight: 800, flex: 1 }}>{teamDisplayName(i, playerCount)}</Typography>
                  {isMine
                    ? <><Typography sx={{ fontWeight: 800, color: "primary.main" }}>You ✓</Typography><Button size="small" onClick={() => send({ t: "release", slot: i })}>Change</Button></>
                    : holder
                      ? <Typography variant="body2" color="text.secondary">{holder === "host" ? "On the host's computer" : "Taken"}</Typography>
                      : <Button variant="contained" size="small" onClick={() => send({ t: "claim", slot: i })} aria-label={`Play as ${teamDisplayName(i, playerCount)}`}>Play as this player</Button>}
                </Box>
              );
            })}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }} role="status" aria-live="polite">
            {mine.length ? "You're in! The host starts the game when every player is ready." : "Waiting for you to pick a player."}
          </Typography>
          <Button color="inherit" sx={{ mt: 2 }} onClick={onLeave}>Leave</Button>
        </Card>
      </Screen>
    );
  }

  // --- Surveys, answered on this device for this device's players ---
  if (phase === "PRE_SURVEY" || phase === "POST_SURVEY") {
    const p = phase === "PRE_SURVEY" ? "pre" : "post";
    const ready = survey && survey.phase === p;
    if (!mine.length) {
      return <Screen>{banner}<Card sx={{ p: 4 }}><Typography variant="h5" component="h1">The players are answering the survey.</Typography></Card></Screen>;
    }
    if (!ready) return <Screen>{banner}<Card sx={{ p: 4 }} role="status"><Typography>Loading the survey…</Typography><LinearProgress sx={{ mt: 2 }} /></Card></Screen>;
    if (sentSurvey[p] || survey.done) {
      return (
        <Screen>
          {banner}
          <Card sx={{ p: { xs: 3, md: 4 } }} role="status" aria-live="polite">
            <Typography variant="h4" component="h1" gutterBottom>Thanks! <span aria-hidden>✓</span></Typography>
            <Typography color="text.secondary">Your answers are with the host. {p === "pre" ? "The game starts" : "The results appear"} when every player is done.</Typography>
            <LinearProgress sx={{ mt: 3 }} />
          </Card>
        </Screen>
      );
    }
    const sets = Array.from({ length: playerCount }, (_, i) => survey.sets?.[i] || []);
    return (
      <>
        {banner}{noticeBar}
        <SurveyView
          key={`${p}-${mine.join(",")}`}
          phase={p}
          playerCount={playerCount}
          players={mine}
          playerQuestionSets={sets}
          confidenceQuestions={survey.confidence || []}
          resolveImage={imageSrc}
          score={false}
          finishLabel="Send my answers"
          onComplete={({ sliders, answers }) => {
            if (send({ t: "survey", phase: p, sliders, answers })) setSentSurvey((s) => ({ ...s, [p]: true }));
            else setNotice("Not connected to the host yet. Your answers are kept: try Send again in a moment.");
          }}
        />
      </>
    );
  }

  // --- The game ---
  if (phase === "GAME") {
    if (!tiles || !online) return <Screen>{banner}<Card sx={{ p: 4 }} role="status"><Typography>Loading the board…</Typography><LinearProgress sx={{ mt: 2 }} /></Card></Screen>;
    return (
      <>
        {banner}{noticeBar}
        <Suspense fallback={<Box role="status" sx={{ p: 6, textAlign: "center" }}><Typography>Setting up the board…</Typography></Box>}>
          <GameScreen
            boardData={tiles}
            bigTopic={meta.topic || ""}
            module={meta.module || ""}
            playerCount={playerCount}
            imageBase={meta.imagesBase || ""}
            online={online}
            onExit={onLeave}
            onEndGame={() => {}}
          />
        </Suspense>
      </>
    );
  }

  // --- The end: scores, and names sent to the host ---
  const rows = summary?.summary || [];
  return (
    <Screen>
      {banner}
      <Card sx={{ p: { xs: 3, md: 4 } }}>
        <Box sx={{ textAlign: "center" }}>
          <Box aria-hidden sx={{ fontSize: 56, lineHeight: 1 }}>🏁</Box>
          <Typography variant="h4" component="h1" sx={{ mt: 1 }}>Session complete</Typography>
          <Typography color="text.secondary" sx={{ mt: 0.5 }}>Your host has the full results.</Typography>
        </Box>
        {rows.filter((t) => mine.includes(t.playerIndex)).map((t) => (
          <Box key={t.playerIndex} sx={{ mt: 3 }}>
            <Typography sx={{ fontWeight: 800, display: "flex", alignItems: "center", gap: 1 }}><TeamToken index={t.playerIndex} size={20} />{t.team}</Typography>
            <Typography color="text.secondary">Survey before: {t.preScore}/{t.surveyQuestions} · after: <strong>{t.postScore}/{t.surveyQuestions}</strong>{t.rank !== "" ? ` · final rank ${t.rank}` : ""}</Typography>
            <TextField
              fullWidth
              sx={{ mt: 1.5 }}
              label={`${t.team}: names or student IDs`}
              value={names[t.playerIndex] ?? ""}
              onChange={(e) => { setNamesSent(false); setNames((n) => ({ ...n, [t.playerIndex]: e.target.value })); }}
            />
          </Box>
        ))}
        {mine.length > 0 && (
          <Button
            variant="contained"
            size="large"
            sx={{ mt: 2 }}
            disabled={!mine.some((s) => (names[s] || "").trim())}
            onClick={() => { mine.forEach((s) => send({ t: "members", slot: s, text: names[s] || "" })); setNamesSent(true); }}
          >
            {namesSent ? "Sent to the host ✓" : "Send names to the host"}
          </Button>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>The host sends or downloads the results file for the class.</Typography>
        <Button color="inherit" sx={{ mt: 2 }} onClick={onLeave}>Back to the start page</Button>
      </Card>
    </Screen>
  );
}
