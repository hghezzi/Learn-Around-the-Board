// src/GameScreen.jsx
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { MotionConfig, motion } from 'framer-motion';
import {
  Button,
  Modal,
  Box,
  Typography,
  Card,
  Chip,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import { DEFAULT_CHANCE_CARDS } from './questionBank';
import { LABELS, teamDisplayName, money, signedMoney } from './labels';
import { matchesTopicAndModule } from './tsvBoardBuilder';
import { BOARD_SIZE } from './gameData';
import {
  getSubgroupTiles, getRentMultiplier, computeRent, rankPlayers, nextActivePlayer, activePlayers,
  ECONOMY, QUIZ_RULES, startingMoney, pickRandom, canUpgradeSubgroup, nextUpgradeLevel, upgradeCost, applyUpgrade,
  bankruptcyAction, downgradeSubgroup, sellDeed, releaseTiles, acquireTile, chaosStealCost, chaosFailPenalty, chaosTargets, chaosTokensForSale,
  netWorth, soloGoal, soloOwnTileIncome,
} from './gameRules';
import { getPersonalBest, recordPersonalBest, getBotRecord, recordBotGame } from './personalBest';
import {
  BOT_LEVELS, BOT_PACE, botKnows, botResponse, resultDelay, shouldBuy, shouldTryMilestone, upgradeChoice, chaosChoice, liquidationChoice,
} from './bot';
import { prepareQuestion, checkAnswer, parseMishapAmount } from './questionFormats';
import { resolveImage } from './images';
import { pickQuestion, pickQuestions, recordAnswer } from './questionPicker';
import { canGuestAct, encodeArgs, decodeArgs } from './online/protocol';
import QuestionInput from './QuestionInput';
import Board from './components/Board';
import Dice from './components/Dice';
import TeamPanel from './components/TeamPanel';
import RulesDialog from './components/RulesDialog';
import { celebrate } from './components/confetti';
import { TEAM_COLORS, TEAM_SYMBOLS, TEAM_INK, SR_ONLY } from './theme';

// Ids for the game dialog's accessible name and the latest outcome (read with the next action).
const TITLE_ID = 'game-dialog-title';
const OUTCOME_ID = 'game-dialog-outcome';

const modalStyle = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(700px, 94vw)',
  maxHeight: '92vh',
  overflowY: 'auto',
  bgcolor: 'background.paper',
  boxShadow: 24,
  p: 4,
  borderRadius: 3,
  outline: 'none',
  borderTop: '6px solid var(--mui-palette-primary-main)',
  color: 'text.primary',
};

const HOP_MS = 170; // pawn speed, per tile
const LANDING_PAUSE_MS = 400; // pause on the destination tile before its dialog opens

// Milestone exam or Rescue Quiz in progress.
const NO_QUIZ = {
  active: false,
  mode: null, // 'MILESTONE_ACQUIRE' | 'MILESTONE_CHALLENGE' | 'GRANT'
  tile: null,
  questions: [],
  qIndex: 0,
  score: 0,
  mistakes: 0,
  targetScore: 0,
  maxMistakes: Infinity,
  waiting: false, // answered; showing the explanation and the Next button
  selected: null,
  result: null,
  isCorrect: null,
  history: [], // UI only: right/wrong per answered question
};

// `bot` ({ level }): a solo game against the computer, which plays as the second player.
function generatePlayers(count, bot = null) {
  const seats = bot ? 2 : count;
  return Array.from({ length: seats }, (_, i) => ({
    id: i,
    name: bot && i === 1 ? LABELS.botName(BOT_LEVELS[bot.level]?.label || bot.level) : teamDisplayName(i, count),
    color: TEAM_COLORS[i],
    position: 0,
    money: startingMoney(seats),
    jailed: false,
    chaosTokens: 0,
    rescueUsed: false,
    eliminated: false,
    ...(bot && i === 1 ? { bot: { level: bot.level } } : {}),
  }));
}

/**
 * useState plus a ref that always holds the newest value, updated in the same
 * call as the setter. Handlers and timers read the ref, so several updates in
 * one handler (or a timer created renders ago) never see stale data.
 * The setter accepts a value or a pure updater, like useState's.
 */
function useLatestState(initial) {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const set = useCallback((next) => {
    ref.current = typeof next === 'function' ? next(ref.current) : next;
    setValue(ref.current);
  }, []);
  return [value, set, ref];
}

const noop = () => {};

/**
 * Game state that the host owns. On a guest device the value comes from the host's
 * latest view (`gv[key]`) and the setter does nothing; elsewhere it is useLatestState.
 */
function useShared(gv, key, initial) {
  const [value, set, ref] = useLatestState(initial);
  const guestValue = gv ? gv[key] : undefined;
  useLayoutEffect(() => { if (gv) ref.current = guestValue; }, [gv, guestValue, ref]);
  return gv ? [guestValue, noop, ref] : [value, set, ref];
}

// ------------------------------------------------------------------
//  MAIN COMPONENT
//
//  Turn flow: Roll -> pawn hops -> checkLanding opens a dialog -> the dialog
//  ends with passTurn(). passTurn is the single place where a team in debt
//  is sent to liquidation / the Rescue Quiz / elimination, so the feedback and
//  explanation that caused the debt are always shown first.
// ------------------------------------------------------------------

export default function GameScreen({
  boardData,
  playerCount,
  startingPlayerIndex = 0,
  onExit,
  onEndGame,
  imageMap = {},
  imageBase = '',
  tsvRows = [],
  sessionMinutes = 0,
  bigTopic = '',
  module = '',
  resume = null, // autosaved game to continue (see App.jsx / autosave.js)
  onSnapshot,
  bot = null, // solo against the computer: { level: 'easy' | 'medium' | 'hard' } (bot.js)
  // Online play (see src/online/). Host: { role: 'host', publish(view), bindRunner(fn), names }.
  // Guest: { role: 'guest', view, mySlots, send(name, args), clockOffset, status }.
  online = null,
}) {
  const isGuest = online?.role === 'guest';
  const isHost = online?.role === 'host';
  const gv = isGuest ? online.view : null;
  // A resumed game keeps the freshly built board (its tiles share question arrays)
  // and restores only what changes during play: each tile's owner and level.
  const [hostBoard, setBoard, boardRef] = useLatestState(() => (resume?.tiles
    ? boardData.map((t, i) => {
      const [owner = null, level = 0, paid] = resume.tiles[i] || [];
      return { ...t, owner, level, paid: owner == null ? 0 : paid ?? t.price };
    })
    : boardData));
  // A guest's board: the host's fixed tiles (boardData, without questions) with the latest owners and levels.
  const guestBoard = useMemo(() => (gv ? boardData.map((t, i) => {
    const [owner = null, level = 0, paid = 0] = gv.tiles?.[i] || [];
    return { ...t, owner, level, paid };
  }) : null), [gv, boardData]);
  useLayoutEffect(() => { if (guestBoard) boardRef.current = guestBoard; }, [guestBoard, boardRef]);
  const board = isGuest ? guestBoard : hostBoard;
  const [players, setPlayers, playersRef] = useShared(gv, 'players', () => resume?.players ?? generatePlayers(playerCount, bot));
  const [turn, setTurn, turnRef] = useShared(gv, 'turn', resume?.turn ?? (startingPlayerIndex || 0));
  const [totalTurns, setTotalTurns, totalTurnsRef] = useShared(gv, 'totalTurns', resume?.totalTurns ?? 0);
  // Which questions were asked and missed (questionPicker.js): unseen first, missed ones again later.
  const [asked, setAsked, askedRef] = useLatestState(resume?.asked ?? {});
  const getImgSrc = (imgName) => resolveImage(imgName, imageMap, imageBase);
  // True from the roll until the turn is passed: never autosave a half-finished turn.
  const turnInProgressRef = useRef(false);

  // Timers (pawn hops, landing pause, money floats) are cancelled if the game unmounts.
  const timersRef = useRef(new Set());
  useEffect(() => {
    const timers = timersRef.current;
    return () => { timers.forEach((id) => { clearTimeout(id); clearInterval(id); }); timers.clear(); };
  }, []);
  const later = (fn, ms) => {
    const id = setTimeout(() => { timersRef.current.delete(id); fn(); }, ms);
    timersRef.current.add(id);
  };

  // isMoving covers the whole move, up to the landing dialog: nothing else can open meanwhile.
  const [isMoving, setIsMoving] = useShared(gv, 'isMoving', false);
  const [dice, setDice] = useShared(gv, 'dice', resume?.dice ?? [1, 1]);
  const [rollId, setRollId] = useShared(gv, 'rollId', 0);
  const [logs, setLogs] = useShared(gv, 'logs', () => (resume
    ? ['Game resumed.', ...(resume.logs || [])].slice(0, 10)
    : [bot ? `${LABELS.soloTeam} plays against the ${LABELS.botName(BOT_LEVELS[bot.level]?.label || bot.level)}.`
      : playerCount > 1 ? `${generatePlayers(playerCount)[startingPlayerIndex || 0].name} starts (best pre-game survey score).` : 'System initialized.']));

  // Modal + flow state
  const [modalOpen, setModalOpen] = useShared(gv, 'modalOpen', false);
  const [activeCard, setActiveCard] = useShared(gv, 'activeCard', null);
  const [modalStage, setModalStage] = useShared(gv, 'modalStage', 'QUESTION');
  // Result of the last answer or event: { tone: 'good'|'bad'|'neutral', title, detail, explanation, note }.
  const [feedback, setFeedback] = useShared(gv, 'feedback', null);
  // The question just answered, shown again with the answer revealed (UI only).
  const [lastAnswer, setLastAnswer] = useShared(gv, 'lastAnswer', null);
  const [exitOpen, setExitOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  // A new game opens with the quick rules; a resumed one doesn't.
  const [rulesOpen, setRulesOpen] = useState(() => !resume);
  const [manageOpen, setManageOpen] = useState(false);
  const [moneyFloats, setMoneyFloats] = useShared(gv, 'moneyFloats', {});
  const [quizState, setQuizState] = useShared(gv, 'quizState', NO_QUIZ);
  const [hoverTile, setHoverTile] = useState(null);
  const [logRows, setLogRows] = useState(resume?.logRows ?? []);

  // Optional session timer: when it runs out, the game ends on net worth.
  const [hostEndsAt] = useState(() => (resume ? resume.endsAt ?? null : (sessionMinutes > 0 ? Date.now() + sessionMinutes * 60000 : null)));
  // A guest counts down with the host's end time, corrected for the difference between the two clocks.
  const endsAt = isGuest ? (gv.endsAt == null ? null : gv.endsAt - (online.clockOffset || 0)) : hostEndsAt;
  const [now, setNow] = useState(() => Date.now());
  const standingsShownRef = useRef(false);
  useEffect(() => {
    if (!endsAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [endsAt]);
  const timeLeftMs = endsAt ? Math.max(0, endsAt - now) : null;
  const timeUp = endsAt != null && timeLeftMs === 0;

  // Wildcard cards: the file's `mishap` rows for this game, or the built-in neutral set.
  const mishapPool = useMemo(() => {
    const fromFile = tsvRows
      .filter((r) => (r.type || '').trim().toLowerCase() === 'mishap' && matchesTopicAndModule(r, bigTopic, module))
      .map((r) => ({ msg: r.question, fact: r.explanation }));
    return fromFile.length > 0 ? fromFile : DEFAULT_CHANCE_CARDS;
  }, [tsvRows, bigTopic, module]);

  const currentPlayer = players[turn];
  // The team whose turn it is, as of the latest update (for handlers and timers).
  const activePlayer = () => playersRef.current[turnRef.current];
  // Solo play: no rivals, so own tiles ask a question and the bank pays rent, and a
  // net-worth goal replaces the ranking (see gameRules.js SOLO). Chaos tokens are hidden.
  const isSolo = players.length === 1;
  const goal = isSolo ? soloGoal(sessionMinutes) : 0;
  const soloWorth = isSolo ? netWorth(players[0], board) : 0;
  const soloMilestones = isSolo ? board.filter((t) => t.type === 'milestone' && t.owner === 0).length : 0;
  // Solo against the bot: the two-player rules, and the bot (player 1) plays its own turns.
  const botPlayer = players.find((p) => p.bot) || null;
  const botTurn = Boolean(currentPlayer?.bot) && !isGuest;
  // Turns are numbered so "Skip ahead" speeds up only the bot turn it was pressed in.
  const [turnSeq, setTurnSeq] = useState(0);
  const [skipSeq, setSkipSeq] = useState(-1);
  const botFast = botTurn && skipSeq === turnSeq;

  // Every button a player presses is a named action. Locally it runs at once; on a
  // guest device it is sent to the host, which runs the same function (online play).
  const actionsRef = useRef({});
  const act = (name, fn) => {
    actionsRef.current[name] = fn;
    // onClick={fn} passes the click event: it can't (and needn't) travel to the host.
    return isGuest ? (...args) => online.send(name, encodeArgs(args.filter((x) => !(x && typeof x === 'object' && 'nativeEvent' in x)))) : fn;
  };
  // Online host: let the app run guests' actions here (tile references become this board's tiles).
  useEffect(() => {
    if (!isHost) return undefined;
    return online.bindRunner((name, args) => {
      const fn = actionsRef.current[name];
      if (fn) fn(...decodeArgs(args || [], boardRef.current));
    });
  }, [isHost, online, boardRef]);
  // Messages that would interrupt the host's screen (alert) are only shown on one computer.
  const warn = (msg) => { if (!online) alert(msg); };

  // ------------------------------------------------------------------
  //  LOGGING (game log + CSV rows)
  // ------------------------------------------------------------------
  const addLog = (msg) => {
    setLogs((prev) => {
      const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      return [`[${time}] ${msg}`, ...prev].slice(0, 10);
    });
  };

  const addCSVEvent = (event) => {
    setLogRows((prev) => [...prev, event]);
  };

  // One row per answered question, whatever the format. The bot's answers are not the
  // student's: they are never logged, and its questions stay "unseen" for the student.
  const logAnswer = (eventType, q, result, meta = {}) => {
    if (activePlayer()?.bot) return;
    setAsked((h) => recordAnswer(h, q, result.correct, totalTurnsRef.current));
    addCSVEvent({
      eventType,
      turn: totalTurnsRef.current,
      playerIndex: turnRef.current,
      playerName: activePlayer()?.name || '',
      questionId: q?.id || '',
      format: q?.format || 'mcq',
      prompt: q?.prompt || '',
      response: result.responseText,
      correctAnswer: result.correctText,
      correct: result.correct,
      timestamp: new Date().toISOString(),
      ...meta,
    });
  };

  // Unique questions across the board (property tiles share question arrays).
  const allBoardQuestions = () => [...new Set(boardRef.current.flatMap((t) => t.questions || []))];

  // ------------------------------------------------------------------
  //  TRANSACTIONS
  //  CSV columns: action, amount, moneyBefore, moneyAfter, tileId, tileName, notes.
  // ------------------------------------------------------------------
  const handleTransaction = (playerId, amount, meta = {}) => {
    const player = playersRef.current.find((p) => p.id === playerId);
    const before = player?.money || 0;
    setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, money: p.money + amount } : p)));

    const floatId = Date.now();
    setMoneyFloats((prev) => ({ ...prev, [playerId]: { amount, visible: true, id: floatId } }));
    later(() => {
      setMoneyFloats((prev) => ({ ...prev, [playerId]: { ...prev[playerId], visible: false } }));
    }, 2000);

    addCSVEvent({
      eventType: 'TRANSACTION',
      turn: totalTurnsRef.current,
      playerIndex: playerId,
      playerName: player?.name || '',
      playerColor: player?.color || '',
      action: meta.action || 'MONEY_CHANGE',
      amount,
      moneyBefore: before,
      moneyAfter: before + amount,
      tileId: meta.tileId ?? '',
      tileName: meta.tileName ?? '',
      notes: meta.notes ?? '',
      timestamp: new Date().toISOString(),
    });
  };

  // ------------------------------------------------------------------
  //  TURN PASSING, BANKRUPTCY, LIQUIDATION, ELIMINATION
  // ------------------------------------------------------------------

  // Liquidation if assets cover the debt, else the one Rescue Quiz, else elimination.
  const resolveDebt = (player) => {
    const action = bankruptcyAction(player, boardRef.current);
    if (action === 'liquidate') {
      setActiveCard({ type: 'LIQUIDATION', debt: Math.abs(player.money), assets: boardRef.current.filter((t) => t.owner === player.id) });
      setModalStage('LIQUIDATION');
      setModalOpen(true);
    } else if (action === 'eliminate') {
      eliminatePlayer(player.id, 'Bankrupt again after using the Rescue Quiz');
    } else if (action === 'rescue') {
      setActiveCard({ type: 'GRANT', debt: Math.abs(player.money) });
      setModalStage('GRANT_INTRO');
      setModalOpen(true);
    }
  };

  // End the current team's turn. A team in debt must settle it first.
  const passTurn = act('passTurn', () => {
    const p = activePlayer();
    if (p && !p.eliminated && p.money < 0) {
      resolveDebt(p);
      return;
    }
    turnInProgressRef.current = false;
    setModalOpen(false);
    setTurn(nextActivePlayer(playersRef.current, turnRef.current));
    setTurnSeq((n) => n + 1);
  });

  // A team that cannot pay its debts leaves the game; its tiles return to the bank.
  const eliminatePlayer = (playerId, reason) => {
    const name = playersRef.current[playerId]?.name || 'Player';
    setBoard((prev) => releaseTiles(prev, playerId));
    setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, eliminated: true, eliminatedAt: totalTurnsRef.current, money: 0 } : p)));
    addLog(`${name} has been eliminated.`);
    addCSVEvent({ eventType: 'ELIMINATED', turn: totalTurnsRef.current, playerIndex: playerId, playerName: name, notes: reason, timestamp: new Date().toISOString() });
    setActiveCard({ type: 'ELIMINATED', playerId, name, reason });
    setModalStage('ELIMINATED');
    setModalOpen(true);
  };

  const continueAfterElimination = act('continueAfterElimination', () => {
    const all = playersRef.current;
    const remaining = activePlayers(all);
    if (all.length > 1 && remaining.length === 1) {
      setActiveCard({ type: 'WIN', msg: `${remaining[0].name} is the last player standing!` });
      setModalStage('WIN');
      addLog(`VICTORY: ${remaining[0].name} is the last player standing.`);
    } else if (remaining.length === 0) {
      openStandings(true, 'eliminated');
    } else {
      passTurn();
    }
  });

  // Liquidation: an upgraded tile loses one level across its subgroup; an
  // unupgraded one is sold back to the bank. The turn ends once out of debt.
  const handleSellAsset = act('sellAsset', (listedTile) => {
    const player = activePlayer();
    const tile = boardRef.current[listedTile.id];
    if (!player || !tile || tile.owner !== player.id) return;
    let nextBoard;
    let cash;
    if (tile.level > 0) {
      const r = downgradeSubgroup(boardRef.current, tile, player.id);
      nextBoard = r.board;
      cash = r.refund;
      setBoard(nextBoard);
      handleTransaction(player.id, cash, { action: 'LIQUIDATION_DOWNGRADE', tileId: tile.id, tileName: tile.name, notes: `Downgraded sub-theme to Level ${tile.level - 1}` });
    } else {
      const r = sellDeed(boardRef.current, tile);
      nextBoard = r.board;
      cash = r.value;
      setBoard(nextBoard);
      handleTransaction(player.id, cash, { action: 'LIQUIDATION_SALE', tileId: tile.id, tileName: tile.name, notes: 'Sold deed' });
    }
    const money = player.money + cash;
    if (money >= 0) {
      addLog(`${player.name} cleared debt. Turn ends.`);
      passTurn();
    } else {
      setActiveCard((prev) => ({ ...prev, debt: Math.abs(money), assets: nextBoard.filter((t) => t.owner === player.id) }));
    }
  });

  // ------------------------------------------------------------------
  //  RESCUE QUIZ & CHAOS TOKENS
  // ------------------------------------------------------------------
  const startGrantExam = act('startRescue', () => {
    const pool = pickQuestions(allBoardQuestions(), QUIZ_RULES.rescue.questions, askedRef.current, totalTurnsRef.current);
    if (pool.length === 0) { handleGrantResult(true); return; }
    setQuizState({
      ...NO_QUIZ, active: true, mode: 'GRANT', questions: pool.map((q) => prepareQuestion(q)), targetScore: QUIZ_RULES.rescue.pass,
    });
    setModalStage('GRANT_QUIZ');
  });

  const handleGrantResult = (passed) => {
    const player = activePlayer();
    if (!passed) {
      eliminatePlayer(player.id, 'Did not pass the Rescue Quiz');
      return;
    }
    const debt = Math.max(0, -player.money);
    handleTransaction(player.id, debt + ECONOMY.rescueBonus, { action: 'EMERGENCY_GRANT', notes: 'Rescue Quiz passed' });
    setPlayers((prev) => prev.map((p) => (p.id === player.id ? { ...p, rescueUsed: true } : p)));
    setFeedback({ tone: 'good', title: LABELS.rescued, detail: `Your ${money(debt)} debt is cleared and you receive ${money(ECONOMY.rescueBonus)} to keep playing.`, note: "This was your only rescue: if you go bankrupt again, you are out." });
    setModalStage('GRANT_RESULT');
  };

  const handleBuyChaosToken = act('buyChaosToken', () => {
    if (!chaosTokensForSale(boardRef.current)) {
      warn('Chaos Tokens are locked! They only become available after ALL 4 Milestones have been captured.');
      return;
    }
    const player = activePlayer();
    if (player.money < ECONOMY.chaosTokenPrice) {
      warn(`Insufficient funds to buy a Chaos Token ($${ECONOMY.chaosTokenPrice}).`);
      return;
    }
    handleTransaction(player.id, -ECONOMY.chaosTokenPrice, { action: 'BUY_CHAOS', notes: 'Purchased token' });
    setPlayers((prev) => prev.map((p) => (p.id === player.id ? { ...p, chaosTokens: p.chaosTokens + 1 } : p)));
    addLog(`${player.name} bought a Chaos Token.`);
  });

  // ------------------------------------------------------------------
  //  MILESTONE EXAMS (6 questions, 5 to pass, stop on the 2nd mistake)
  // ------------------------------------------------------------------
  const startQuiz = act('startQuiz', (tile, mode) => {
    // A milestone without its own questions (the validator reports it) borrows the board's.
    const source = tile.quiz?.length ? tile.quiz : allBoardQuestions();
    if (source.length === 0) return;
    const rules = QUIZ_RULES.milestone;
    setQuizState({
      ...NO_QUIZ, active: true, mode, tile,
      questions: pickQuestions(source, rules.questions, askedRef.current, totalTurnsRef.current).map((q) => prepareQuestion(q)),
      targetScore: rules.pass, maxMistakes: rules.maxMistakes,
    });
    setLastAnswer(null);
    setModalStage('QUIZ_START');
    setModalOpen(true);
  });

  const handleQuizAnswer = act('answerQuiz', (response) => {
    if (quizState.waiting) return;
    const currentQ = quizState.questions[quizState.qIndex];
    const result = checkAnswer(currentQ, response);
    logAnswer(quizState.mode === 'GRANT' ? 'GRANT_Q' : 'MILESTONE_Q', currentQ, result, {
      tileId: quizState.tile?.id ?? '', tileName: quizState.tile?.name ?? '', questionNumber: quizState.qIndex + 1,
    });
    // Show the explanation and a Next button.
    setQuizState((prev) => ({
      ...prev,
      waiting: true,
      selected: response,
      result,
      isCorrect: result.correct,
      score: prev.score + (result.correct ? 1 : 0),
      mistakes: prev.mistakes + (result.correct ? 0 : 1),
      history: [...(prev.history || []), result.correct],
    }));
  });

  const handleNextQuestion = act('nextQuestion', () => {
    const isGrant = quizState.mode === 'GRANT';
    // A milestone exam stops at the 2nd mistake; the Rescue Quiz always runs to the end.
    if (!isGrant && quizState.mistakes >= quizState.maxMistakes) {
      finishQuiz(false);
      return;
    }
    if (quizState.qIndex < quizState.questions.length - 1) {
      setQuizState((prev) => ({ ...prev, qIndex: prev.qIndex + 1, waiting: false, selected: null, result: null, isCorrect: null }));
      return;
    }
    const passed = quizState.score >= quizState.targetScore;
    if (isGrant) handleGrantResult(passed);
    else finishQuiz(passed);
  });

  const finishQuiz = (passed) => {
    const { tile, mode } = quizState;
    const playerId = turnRef.current;
    const owner = boardRef.current[tile.id]?.owner;

    if (mode === 'MILESTONE_ACQUIRE') {
      if (passed) {
        handleTransaction(playerId, -tile.price, { action: 'MILESTONE_ACQUIRE', tileId: tile.id, tileName: tile.name });
        setBoard((prev) => acquireTile(prev, tile, playerId, tile.price));
        if (!isSolo) setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, chaosTokens: p.chaosTokens + 1 } : p)));
        addLog(`${activePlayer().name} captured the ${tile.name} milestone!`);
        setModalStage('MILESTONE_SUCCESS');
      } else {
        addLog(`${activePlayer().name} didn't pass the ${tile.name} exam.`);
        setModalStage('MILESTONE_FAIL');
      }
    } else if (mode === 'MILESTONE_CHALLENGE') {
      const baseRent = tile.baseRent || 0;
      const fee = passed ? Math.floor(baseRent / 2) : baseRent;
      handleTransaction(playerId, -fee, { action: passed ? 'MILESTONE_CHALLENGE_SUCCESS' : 'MILESTONE_CHALLENGE_FAIL', tileId: tile.id, tileName: tile.name });
      if (owner != null) handleTransaction(owner, fee, { action: 'MILESTONE_RENT_RECEIVED', tileId: tile.id, tileName: tile.name });
      setFeedback(passed
        ? { tone: 'good', title: 'Exam passed!', detail: `You pay only half the milestone fee: ${money(fee)}.` }
        : { tone: 'bad', title: 'Exam not passed', detail: `You pay the full milestone fee: ${money(fee)}.` });
      addLog(`${activePlayer().name} paid ${money(fee)} on the ${tile.name} milestone.`);
      setModalStage('FEEDBACK_INCORRECT');
    }
  };

  // Landing on a rival's milestone and declining the exam.
  const payMilestoneFee = act('payMilestoneFee', () => {
    const tile = boardRef.current[activeCard.data.id];
    const fee = tile.baseRent || 0;
    handleTransaction(turnRef.current, -fee, { action: 'MILESTONE_FULL_FEE', tileId: tile.id, tileName: tile.name });
    if (tile.owner != null) handleTransaction(tile.owner, fee, { action: 'MILESTONE_RENT_RECEIVED', tileId: tile.id, tileName: tile.name });
    passTurn();
  });

  // ------------------------------------------------------------------
  //  MOVING AND LANDING
  // ------------------------------------------------------------------
  const openCard = (card, stage) => {
    setActiveCard(card);
    setModalStage(stage);
    setModalOpen(true);
  };

  const checkLanding = (didPassGo) => {
    const p = activePlayer();
    const tile = boardRef.current[p.position];

    if (didPassGo) {
      handleTransaction(p.id, ECONOMY.lapBonus, { action: 'PASS_GO' });
      addLog(LABELS.passStart);
    }

    setFeedback(null);
    setLastAnswer(null);

    if (tile.owner === p.id) {
      const pool = tile.type === 'milestone' ? tile.quiz : tile.questions;
      if (isSolo && pool?.length) {
        const q = prepareQuestion(pickQuestion(pool, askedRef.current, totalTurnsRef.current));
        openCard({ type: 'OWN_TILE', data: tile, q, income: soloOwnTileIncome(boardRef.current, tile) }, 'QUESTION');
        return;
      }
      openCard({ type: 'MSG', data: tile, msg: LABELS.ownTile }, 'MSG');
      return;
    }

    if (tile.type === 'milestone') {
      if (tile.owner != null) {
        openCard({ type: 'MILESTONE_CHALLENGE', data: tile, ownerId: tile.owner }, 'MILESTONE_CHALLENGE_INTRO');
      } else if (activePlayer().money >= tile.price) {
        openCard({ type: 'MILESTONE', data: tile }, 'MILESTONE_INTRO');
      } else {
        openCard({ type: 'MSG', data: tile, msg: LABELS.cannotAffordMilestone(tile.price) }, 'MSG');
      }
      return;
    }

    if (tile.questions && tile.questions.length > 0) {
      const q = prepareQuestion(pickQuestion(tile.questions, askedRef.current, totalTurnsRef.current));
      if (tile.owner != null) {
        openCard({
          type: 'RENT_DEFENSE', data: tile, q, rent: computeRent(boardRef.current, tile),
          ownerName: playersRef.current[tile.owner]?.name || LABELS.rivalTeam, ownerId: tile.owner, payerId: p.id, payerName: p.name,
        }, 'QUESTION');
      } else {
        openCard({ type: 'QUESTION', data: tile, q }, 'QUESTION');
      }
      return;
    }

    if (tile.type === 'chance') {
      const card = pickRandom(mishapPool) || { msg: 'Unexpected expense (-$100)', fact: null };
      const amount = parseMishapAmount(card.msg);
      if (amount !== 0) handleTransaction(p.id, amount, { action: 'LAB_MISHAP', tileId: tile.id, tileName: tile.name, notes: card.msg });
      addLog(`${LABELS.chanceCard} for ${p.name}${amount ? ` (${signedMoney(amount)})` : ''}.`);
      openCard({ type: 'MISHAP', data: { ...tile, fact: card.fact || null }, msg: card.msg, amount }, 'MISHAP');
      return;
    }

    // A tile with no questions (e.g. no core rows in the file).
    openCard({ type: 'MSG', data: tile, msg: 'Event triggered.' }, 'MSG');
  };

  const handleRoll = act('roll', () => {
    const p = activePlayer();
    if (isMoving || timeUp || turnInProgressRef.current || !p || p.eliminated) return;
    // Debts are settled before a turn ends, so this only happens with a game saved by an older version.
    if (p.money < 0) { resolveDebt(p); return; }
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    setDice([d1, d2]);
    setRollId((n) => n + 1);
    turnInProgressRef.current = true;
    setIsMoving(true);

    const steps = d1 + d2;
    const passesGo = p.position + steps >= BOARD_SIZE;
    let stepsTaken = 0;
    const hop = setInterval(() => {
      setPlayers((prev) => prev.map((player, index) => (index === turnRef.current ? { ...player, position: (player.position + 1) % BOARD_SIZE } : player)));
      stepsTaken++;
      if (stepsTaken < steps) return;
      clearInterval(hop);
      timersRef.current.delete(hop);
      setTotalTurns((n) => n + 1);
      later(() => { setIsMoving(false); checkLanding(passesGo); }, LANDING_PAUSE_MS);
    }, HOP_MS);
    timersRef.current.add(hop);
  });

  // ------------------------------------------------------------------
  //  QUESTIONS ON PROPERTY AND CORE TILES
  // ------------------------------------------------------------------

  // Unowned tile: right answer -> option to buy; wrong answer -> small fine.
  const handleAnswer = act('answerProperty', (response) => {
    const { q, data: tile } = activeCard;
    const result = checkAnswer(q, response);
    logAnswer('PROPERTY_Q', q, result, { tileId: tile.id, tileName: tile.name });
    setLastAnswer({ q, response, result });
    if (result.correct) {
      setFeedback({ tone: 'good', title: 'Correct!', explanation: q.explanation || '' });
      setModalStage('DECISION');
    } else {
      setFeedback({ tone: 'bad', title: 'Not quite', detail: `That costs you ${money(ECONOMY.wrongAnswerPenalty)}.`, explanation: q.explanation || '' });
      handleTransaction(turnRef.current, -ECONOMY.wrongAnswerPenalty, { action: 'QUESTION_PENALTY', tileId: tile.id, tileName: tile.name, notes: 'Incorrect on acquisition question' });
      setModalStage('FEEDBACK_INCORRECT');
    }
  });

  const handleBuy = act('buy', () => {
    const tile = activeCard.data;
    if (activePlayer().money < tile.price) { warn('Insufficient funds!'); return; }
    handleTransaction(turnRef.current, -tile.price, { action: 'BUY_PROPERTY', tileId: tile.id, tileName: tile.name });
    setBoard((prev) => acquireTile(prev, tile, turnRef.current, tile.price));
    addLog(`${activePlayer().name} bought ${tile.type === 'property' ? tile.sub : tile.name} for ${money(tile.price)}.`);
    passTurn();
  });

  // Rival's tile: a right answer halves the rent.
  const handleRentChallengeAnswer = act('answerRent', (response) => {
    const { q, data: tile, rent, payerId, ownerId } = activeCard;
    const result = checkAnswer(q, response);
    logAnswer('RENT_Q', q, result, { tileId: tile.id, tileName: tile.name });
    const rentToPay = result.correct ? Math.floor(rent / 2) : rent;
    const ownerName = activeCard.ownerName;
    setLastAnswer({ q, response, result });
    setFeedback(result.correct
      ? { tone: 'good', title: 'Correct: half rent!', detail: `You pay ${money(rentToPay)} to ${ownerName} instead of ${money(rent)}.`, explanation: q.explanation || '' }
      : { tone: 'bad', title: 'Not quite: full rent', detail: `You pay ${money(rentToPay)} to ${ownerName}.`, explanation: q.explanation || '' });
    addLog(`${activeCard.payerName} paid ${money(rentToPay)} rent to ${ownerName}.`);
    handleTransaction(payerId, -rentToPay, { action: 'RENT_PAYMENT', tileId: tile.id, tileName: tile.name });
    if (ownerId != null) handleTransaction(ownerId, rentToPay, { action: 'RENT_RECEIVED', tileId: tile.id, tileName: tile.name });
    setModalStage('FEEDBACK_INCORRECT');
  });

  // Solo: your own tile. A right answer collects its rent from the bank; a wrong one costs the usual fine.
  const handleOwnTileAnswer = act('answerOwnTile', (response) => {
    const { q, data: tile, income } = activeCard;
    const result = checkAnswer(q, response);
    logAnswer('OWN_TILE_Q', q, result, { tileId: tile.id, tileName: tile.name });
    setLastAnswer({ q, response, result });
    if (result.correct) {
      setFeedback({ tone: 'good', title: 'Correct: rent collected!', detail: `The bank pays you ${money(income)} for ${tileLabel(tile)}.`, explanation: q.explanation || '' });
      handleTransaction(turnRef.current, income, { action: 'SOLO_RENT', tileId: tile.id, tileName: tile.name });
      addLog(`${activePlayer().name} collected ${money(income)} rent from the bank.`);
    } else {
      setFeedback({ tone: 'bad', title: 'Not quite: no rent this time', detail: `That costs you ${money(ECONOMY.wrongAnswerPenalty)}.`, explanation: q.explanation || '' });
      handleTransaction(turnRef.current, -ECONOMY.wrongAnswerPenalty, { action: 'QUESTION_PENALTY', tileId: tile.id, tileName: tile.name, notes: 'Incorrect on own tile' });
    }
    setModalStage('FEEDBACK_INCORRECT');
  });

  // Solo: note the turn the goal is first reached (once per game; the row is saved with the game).
  const goalReachedTurn = isSolo ? (logRows.find((r) => r.eventType === 'SOLO_GOAL')?.turn ?? null) : null;
  useEffect(() => {
    if (!isSolo || isGuest || goalReachedTurn != null || soloWorth < goal) return;
    addCSVEvent({ eventType: 'SOLO_GOAL', turn: totalTurnsRef.current, playerIndex: 0, playerName: players[0]?.name || '', netWorth: soloWorth, notes: `Reached the ${money(goal)} goal`, timestamp: new Date().toISOString() });
    addLog(`GOAL: ${players[0]?.name} reached ${money(goal)} net worth!`);
    celebrate(players[0]?.color);
  }, [isSolo, isGuest, goalReachedTurn, soloWorth, goal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Autosave between turns only: a refresh in the middle of a turn returns to its start.
  useEffect(() => {
    if (!onSnapshot || isMoving || modalOpen || manageOpen || turnInProgressRef.current) return;
    onSnapshot({ tiles: board.map((t) => [t.owner ?? null, t.level || 0, t.paid || 0]), players, turn, totalTurns, logs, logRows, dice, endsAt, asked });
  }, [onSnapshot, board, players, turn, totalTurns, logs, logRows, dice, endsAt, asked, isMoving, modalOpen, manageOpen]);

  // Online host: send the game as it stands after every change (each guest gets a copy
  // without unanswered answers; see online/protocol.js guestView).
  useEffect(() => {
    if (!isHost) return;
    online.publish({
      tiles: board.map((t) => [t.owner ?? null, t.level || 0, t.paid || 0]),
      players, turn, totalTurns, isMoving, dice, rollId, logs, modalOpen, activeCard, modalStage,
      feedback, lastAnswer, moneyFloats, quizState, endsAt,
    });
  }, [isHost, online, board, players, turn, totalTurns, isMoving, dice, rollId, logs, modalOpen, activeCard, modalStage,
      feedback, lastAnswer, moneyFloats, quizState, endsAt]);

  // ------------------------------------------------------------------
  //  CHAOS CHALLENGE (spend a token to try to steal a rival's property)
  // ------------------------------------------------------------------
  const openChaosSelect = act('openChaosSelect', () => {
    setFeedback(null);
    setLastAnswer(null);
    openCard({ type: 'CHAOS_SELECT' }, 'CHAOS_SELECT');
  });

  const handleSelectChaosTarget = act('selectChaosTarget', (tile) => {
    if (activePlayer().chaosTokens <= 0) { warn('No chaos tokens available.'); return; }
    // Only a rival's tile outside a complete set (the list the dialog shows).
    if (!chaosTargets(boardRef.current, activePlayer().id).some((t) => t.id === tile?.id)) return;
    // Duel on the target tile's own questions (fallback: any board question).
    const pool = tile.questions?.length ? tile.questions : allBoardQuestions();
    if (pool.length === 0) { warn('This question file has no questions for a Chaos challenge.'); return; }
    setActiveCard({ type: 'CHAOS_CHALLENGE', data: tile, q: prepareQuestion(pickQuestion(pool, askedRef.current, totalTurnsRef.current)), ownerId: tile.owner });
    setModalStage('CHAOS_QUESTION');
  });

  const handleChaosAnswer = act('answerChaos', (response) => {
    const { q } = activeCard;
    const player = activePlayer();
    const tile = boardRef.current[activeCard.data.id];
    const result = checkAnswer(q, response);
    logAnswer('CHAOS_Q', q, result, { tileId: tile.id, tileName: tile.name });
    setLastAnswer({ q, response, result });
    const ownerName = playersRef.current[tile.owner]?.name || LABELS.rivalTeam;
    setPlayers((prev) => prev.map((p) => (p.id === player.id ? { ...p, chaosTokens: Math.max(0, p.chaosTokens - 1) } : p)));

    if (result.correct) {
      const cost = chaosStealCost(tile);
      // The token is spent either way (no refund); the Challenge button is disabled when the team can't pay.
      if (player.money < cost) { setFeedback({ tone: 'neutral', title: 'Correct, but not enough cash', detail: `Taking this tile costs ${money(cost)} and you have ${money(player.money)}. The token is used up.`, explanation: q.explanation || '' }); setModalStage('FEEDBACK_INCORRECT'); return; }
      handleTransaction(player.id, -cost, { action: 'CHAOS_STEAL', tileId: tile.id, tileName: tile.name });
      if (tile.owner != null) handleTransaction(tile.owner, cost, { action: 'CHAOS_SELL', tileId: tile.id, tileName: tile.name });
      setBoard((prev) => acquireTile(prev, tile, player.id, cost));
      setFeedback({ tone: 'good', title: 'Chaos success!', detail: `You take ${tile.sub || tile.name} from ${ownerName} for ${money(cost)}.`, explanation: q.explanation || '' });
      addLog(`${player.name} took ${tile.sub || tile.name} from ${ownerName} with a chaos token.`);
    } else {
      const penalty = chaosFailPenalty(tile);
      handleTransaction(player.id, -penalty, { action: 'CHAOS_FAIL', tileId: tile.id, tileName: tile.name });
      setFeedback({ tone: 'bad', title: 'Chaos challenge failed', detail: `Penalty: ${money(penalty)}.`, explanation: q.explanation || '' });
    }
    setModalStage('FEEDBACK_INCORRECT');
  });

  // ------------------------------------------------------------------
  //  UPGRADES
  // ------------------------------------------------------------------
  const handleUpgrade = act('upgrade', () => {
    const playerId = turnRef.current;
    const tile = boardRef.current[activeCard.data.id];
    if (!canUpgradeSubgroup(boardRef.current, tile, playerId)) { warn('You must own all tiles in this sub-theme and keep node levels even.'); return; }
    const level = nextUpgradeLevel(boardRef.current, tile);
    if (level <= tile.level) { warn('No upgrades available.'); return; }
    const cost = upgradeCost(tile, level);
    if (activePlayer().money < cost) { warn('Insufficient funds.'); return; }
    handleTransaction(playerId, -cost, { action: 'UPGRADE_SUBTHEME', tileId: tile.id, tileName: tile.name, notes: `Level ${level}` });
    setBoard((prev) => applyUpgrade(prev, tile, playerId, level));
    addLog(`${activePlayer().name} upgraded ${tile.sub} to level ${level}.`);
    setModalOpen(false);
  });

  const declineMilestone = act('declineMilestone', () => { setModalOpen(false); passTurn(); });
  const closeDialog = act('closeDialog', () => setModalOpen(false));
  const openUpgradeOffer = act('openUpgradeOffer', (tile) => { setActiveCard({ type: 'UPGRADE_OFFER', data: tile }); setModalOpen(true); });

  const openLabManager = () => {
    if (isGuest) { setManageOpen(true); return; } // only the dialog opens; choosing a group is sent to the host
    setFeedback(null);
    setModalStage(null);
    setManageOpen(true);
  };

  const handleTileHover = (tile) => {
    if (!tile) { setHoverTile(null); return; }
    const rent = (tile.type === 'property' || tile.type === 'sequencing_core') ? computeRent(board, tile) : 0;
    const mult = (tile.type === 'property' || tile.type === 'sequencing_core') ? getRentMultiplier(board, tile) : 0;
    setHoverTile({ ...tile, rent, multiplier: mult });
  };
  const clearHover = () => setHoverTile(null);

  // ------------------------------------------------------------------
  //  END OF GAME
  // ------------------------------------------------------------------

  // Final standings: opened by END GAME, by the timer, or after a last-standing win.
  const openStandings = (forced, reason) => {
    openCard({ type: 'STANDINGS', forced, reason }, 'STANDINGS');
  };

  // Time's up: let the current turn finish (no dialog open, pawn not moving), then end.
  useEffect(() => {
    if (timeUp && !standingsShownRef.current && !modalOpen && !isMoving && !manageOpen) {
      standingsShownRef.current = true;
      addLog("Time's up!");
      openStandings(true, 'time');
    }
  });

  useEffect(() => {
    if (!modalOpen) return;
    if (modalStage === 'WIN' || (modalStage === 'STANDINGS' && players.length > 1)) celebrate();
    if (modalStage === 'MILESTONE_SUCCESS') celebrate(playersRef.current[turnRef.current]?.color);
  }, [modalOpen, modalStage, players.length, playersRef, turnRef]);

  // Solo end screen: answers right this game, and the best result on this computer.
  const bestKey = { topic: bigTopic, module, minutes: sessionMinutes };
  const soloAccuracy = () => {
    const answered = logRows.filter((r) => typeof r.correct === 'boolean' && r.questionId !== undefined);
    const right = answered.filter((r) => r.correct).length;
    return { right, total: answered.length, pct: answered.length ? Math.round((100 * right) / answered.length) : null };
  };

  const handleEndGame = (reason = 'ended') => {
    const standings = rankPlayers(playersRef.current, boardRef.current);
    const resultRows = standings.map((r) => ({
      eventType: 'GAME_RESULT',
      turn: totalTurnsRef.current,
      playerIndex: r.id,
      playerName: r.name,
      rank: r.rank,
      netWorth: r.netWorth,
      cash: r.cash,
      assets: r.assets,
      eliminated: r.eliminated,
      endReason: reason,
      ...(playersRef.current[r.id]?.bot ? { bot: playersRef.current[r.id].bot.level } : {}),
      timestamp: new Date().toISOString(),
    }));
    if (isSolo && !isGuest && standings[0]) recordPersonalBest(bestKey, { netWorth: standings[0].netWorth, accuracy: soloAccuracy().pct });
    if (botPlayer && !isGuest) recordBotGame(bestKey, botPlayer.bot.level, botResult(standings));
    if (typeof onEndGame === 'function') onEndGame([...logRows, ...resultRows]);
  };

  // Against the bot: did the student win this game?
  const botResult = (standings) => {
    const me = standings.find((r) => r.id === 0);
    const them = standings.find((r) => r.id === botPlayer?.id);
    return { won: Boolean(me && them && !me.eliminated && (them.eliminated || me.netWorth > them.netWorth)), netWorth: me?.netWorth ?? 0 };
  };

  // ------------------------------------------------------------------
  //  THE BOT (solo against the computer). bot.js decides; it presses the same
  //  actions a person does, one step at a time, paced so the student can follow
  //  its question, answer and explanation. Skip ahead speeds up the rest of its turn.
  // ------------------------------------------------------------------
  const botPaused = rulesOpen || endOpen || exitOpen || manageOpen;
  useEffect(() => {
    if (!botTurn || botPaused) return undefined;
    const me = currentPlayer;
    const level = me.bot.level;
    const pace = botFast ? BOT_PACE.fast : BOT_PACE.normal;
    const answer = (q, submit) => ({ delay: pace.question, run: () => submit(botResponse(q, botKnows(level))) });
    const after = (text, run, exam = false) => ({ delay: resultDelay(text, botFast, exam), run });
    const press = (run, delay = pace.step) => ({ delay, run });
    const step = (() => {
      if (isMoving) return null;
      if (!modalOpen) {
        if (turnInProgressRef.current || timeUp) return null;
        const up = upgradeChoice(board, me.id, me.money);
        if (up) return press(() => openUpgradeOffer(up.tile));
        if (chaosChoice(board, me)) return press(openChaosSelect);
        return press(handleRoll);
      }
      const type = activeCard?.type;
      if (type === 'UPGRADE_OFFER') return press(handleUpgrade, pace.question);
      switch (modalStage) {
        case 'QUESTION':
          if (type === 'QUESTION') return answer(activeCard.q, handleAnswer);
          if (type === 'RENT_DEFENSE') return answer(activeCard.q, handleRentChallengeAnswer);
          return null;
        case 'DECISION': return after(feedback?.explanation, () => (shouldBuy(me, activeCard.data) ? handleBuy() : passTurn()));
        case 'FEEDBACK_INCORRECT': return after(feedback?.explanation, passTurn);
        case 'MSG': return after(activeCard?.msg, passTurn);
        case 'MISHAP': return after(`${activeCard?.msg || ''} ${activeCard?.data?.fact || ''}`, passTurn);
        case 'MILESTONE_INTRO': return press(() => (shouldTryMilestone(me, activeCard.data) ? startQuiz(activeCard.data, 'MILESTONE_ACQUIRE') : declineMilestone()), pace.question);
        case 'MILESTONE_CHALLENGE_INTRO': return press(() => startQuiz(activeCard.data, 'MILESTONE_CHALLENGE'), pace.question);
        case 'QUIZ_START':
        case 'GRANT_QUIZ': {
          const q = quizState.active ? quizState.questions[quizState.qIndex] : null;
          if (!q) return null;
          return quizState.waiting ? after(q.explanation, handleNextQuestion, true) : answer(q, handleQuizAnswer);
        }
        case 'MILESTONE_SUCCESS':
        case 'MILESTONE_FAIL':
        case 'GRANT_RESULT': return after(feedback?.detail, passTurn);
        case 'GRANT_INTRO': return press(startGrantExam, pace.question);
        case 'LIQUIDATION': {
          const t = liquidationChoice(board, me.id);
          return t ? press(() => handleSellAsset(t), pace.question) : null;
        }
        case 'ELIMINATED': return after('', continueAfterElimination);
        case 'CHAOS_SELECT': {
          const t = chaosChoice(board, me);
          return press(() => (t ? handleSelectChaosTarget(t) : closeDialog()));
        }
        case 'CHAOS_QUESTION': return answer(activeCard.q, handleChaosAnswer);
        default: return null; // the standings and the winner screen are the student's
      }
    })();
    if (!step) return undefined;
    const id = setTimeout(step.run, step.delay);
    return () => clearTimeout(id);
  }, [botTurn, botPaused, botFast, isMoving, modalOpen, modalStage, activeCard, quizState, feedback, turn, board, timeUp]); // eslint-disable-line react-hooks/exhaustive-deps

  const formatClock = (ms) => {
    const total = Math.ceil(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  // Shared question renderer (prompt + image + any answer format).
  const renderQuestion = (q, onSubmit, opts = {}) => (
    <>
      <Typography component="p" sx={{ mb: 2, fontWeight: 800, fontSize: '1.15rem', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>{q.prompt}</Typography>
      <QuestionInput
        key={opts.key || q.id || q.prompt}
        question={q}
        onSubmit={onSubmit}
        reveal={opts.reveal || null}
        watching={!canAct}
        resolveImage={getImgSrc}
        imageMaxHeight={opts.imageMaxHeight || 250}
      />
    </>
  );
  // The answered question again, locked, with the right answer marked.
  const renderAnswered = () => lastAnswer && renderQuestion(lastAnswer.q, () => {}, {
    key: `answered-${lastAnswer.q.id || lastAnswer.q.prompt}`,
    reveal: { ...lastAnswer.result, response: lastAnswer.response },
    imageMaxHeight: 160,
  });

  const title = module || bigTopic || 'Learn Around the Board';
  const inDebt = currentPlayer.money < 0;
  // In debt (only possible with a game saved by an older version), Roll opens the debt dialog.
  const rollLabel = timeUp ? "Time's up" : botTurn ? 'The bot is playing…' : isMoving ? 'Moving…' : (inDebt ? 'Settle debt' : `Roll — ${currentPlayer.name}`);
  const tileLabel = (t) => (t?.type === 'property' ? t.sub : t?.name) || '';
  const ownerName = (id) => (id === 99 || id == null ? LABELS.rivalTeam : players[id]?.name || LABELS.rivalTeam);

  // Upgrade groups the current team owns at least one tile of.
  const ownedGroups = (() => {
    const seen = new Map();
    board.forEach((t) => { if (t.type === 'property' && t.owner === turn && !seen.has(`${t.group}|${t.sub}`)) seen.set(`${t.group}|${t.sub}`, t); });
    return [...seen.values()].map((t) => {
      const groupTiles = getSubgroupTiles(board, t);
      const owned = groupTiles.filter((g) => g.owner === turn).length;
      const full = owned === groupTiles.length;
      const level = t.level || 0;
      const next = nextUpgradeLevel(board, t);
      const canLevel = full && next > level;
      const cost = canLevel ? upgradeCost(t, next) : 0;
      return { tile: t, size: groupTiles.length, owned, full, level, next, canLevel, cost };
    });
  })();
  // Rent of `tile` on a board where `change` has been applied to it (or to its group).
  const rentIf = (tile, change, wholeGroup = false) => {
    const hypo = board.map((t) => {
      const hit = wholeGroup ? (t.type === 'property' && t.group === tile.group && t.sub === tile.sub) : t.id === tile.id;
      return hit ? { ...t, ...change } : t;
    });
    return computeRent(hypo, hypo[tile.id]);
  };
  const quizTile = quizState.tile;
  const dialogTile = activeCard?.data || (['QUIZ_START', 'MILESTONE_SUCCESS', 'MILESTONE_FAIL'].includes(modalStage) ? quizTile : null);
  const showDialogTop = !['STANDINGS', 'WIN', 'ELIMINATED'].includes(modalStage) && !['STANDINGS', 'WIN', 'ELIMINATED'].includes(activeCard?.type);
  // Online: a guest device acts only for its own player, on its turn; the host can always act
  // (for a player whose device has dropped, for example).
  const hostOnlyScreen = ['STANDINGS', 'WIN'].includes(modalStage) || ['STANDINGS', 'WIN'].includes(activeCard?.type);
  // During the bot's turn the student watches; the standings and the winner screen stay theirs.
  const botWatching = botTurn && !hostOnlyScreen;
  const canAct = (!isGuest || canGuestAct({ turn, modalOpen, modalStage, activeCard }, online.mySlots)) && !botWatching;
  const playsElsewhere = isHost && (online.remoteSlots || []).includes(turn);
  const waitingNote = isGuest && !canAct
    ? (hostOnlyScreen ? 'Waiting for the host to continue.' : `${currentPlayer.name} is playing. You'll see every move here.`)
    : playsElsewhere ? `${currentPlayer.name} plays on their own device. You can still act for them if their device has dropped.` : '';

  const resultHeading = () => {
    if (activeCard?.type === 'RENT_DEFENSE') return `Rent due · ${tileLabel(activeCard.data)}`;
    if (activeCard?.type === 'OWN_TILE') return `Your tile · ${tileLabel(activeCard.data)}`;
    if (activeCard?.type === 'CHAOS_CHALLENGE') return `Chaos challenge · ${tileLabel(activeCard.data)}`;
    return `${LABELS.questionTitle} · ${tileLabel(activeCard?.data)}`;
  };

  return (
    <MotionConfig reducedMotion="user">
    <Box sx={{ bgcolor: 'background.default', color: 'text.primary', minHeight: '100vh', px: { xs: 1, md: 3 }, py: 2 }}>
      <Box component="header" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, justifyContent: 'space-between', alignItems: 'center', maxWidth: 1500, mx: 'auto', mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography variant="h5" component="h1" sx={{ fontWeight: 600 }}><span aria-hidden>🎲 </span>Learn Around the Board</Typography>
          <Chip label={`Turn ${totalTurns}`} size="small" color="primary" />
          {endsAt && (
            <Chip
              label={timeUp ? "Time's up" : `⏱ ${formatClock(timeLeftMs)}`}
              size="small"
              color={timeUp ? 'error' : timeLeftMs <= 5 * 60000 ? 'warning' : 'default'}
              aria-label={timeUp ? "Time's up" : `Time remaining ${formatClock(timeLeftMs)}`}
            />
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button variant="text" onClick={() => setRulesOpen(true)} startIcon={<span aria-hidden>📖</span>}>{LABELS.howToPlay}</Button>
          {!isGuest && <Button variant="outlined" color="warning" disabled={isMoving} onClick={() => setEndOpen(true)}>End game</Button>}
          <Button variant="text" color="error" onClick={() => setExitOpen(true)}>{isGuest ? 'Leave game' : 'Exit session'}</Button>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'flex-start', gap: { xs: 2, md: 2.5 }, maxWidth: 1500, mx: 'auto' }}>
        {/* On screens narrower than the board (phones), the board scrolls sideways inside this box
            instead of widening the page, so dialogs and the player panel still fit the screen. */}
        <Box sx={{ flex: '1 1 640px', display: 'flex', justifyContent: 'safe center', maxWidth: 1000, minWidth: 0, overflowX: 'auto', pb: 1 }}>
          <Board board={board} players={players} onTileHover={handleTileHover} onTileLeave={clearHover}>
            <Typography component="h2" sx={{ fontFamily: '"Fredoka", sans-serif', fontWeight: 600, fontSize: 'max(18px, 3.2cqw)', lineHeight: 1.1, textAlign: 'center', textWrap: 'balance' }}>{title}</Typography>
            {module && bigTopic && <Typography sx={{ fontSize: 'max(12px, 1.5cqw)', color: 'text.secondary', fontWeight: 700, mt: '-0.8cqw' }}>{bigTopic}</Typography>}

            <Box aria-live="polite" sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 0.75, pr: 2, py: 0.6, borderRadius: 99, bgcolor: 'background.paper', boxShadow: 1, border: '2px solid', borderColor: currentPlayer.color }}>
              <TeamDot player={currentPlayer} size={26} />
              <Typography sx={{ fontWeight: 800 }}>{currentPlayer.name}'s turn</Typography>
              <Typography sx={{ fontWeight: 700, color: inDebt ? 'error.main' : 'text.secondary' }}>· {money(currentPlayer.money)}</Typography>
            </Box>

            <Dice values={dice} rollId={rollId} />

            <Button
              variant="contained"
              size="large"
              onClick={handleRoll}
              disabled={timeUp || !canAct}
              aria-disabled={isMoving || undefined}
              sx={{
                bgcolor: TEAM_INK[currentPlayer.id], color: 'common.white', px: 5, py: 1.25, fontSize: '1.15rem', boxShadow: 3, minWidth: 220,
                '&:hover': { bgcolor: TEAM_INK[currentPlayer.id], filter: 'brightness(1.12)' },
                ...(isMoving ? { opacity: 0.75, cursor: 'progress' } : {}),
              }}
            >
              {rollLabel}
            </Button>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'center' }}>
              <Button variant="outlined" disabled={isMoving || !canAct} onClick={openLabManager} startIcon={<span aria-hidden>⭐</span>}>{LABELS.upgrades}</Button>
              {!isSolo && (
                <Button variant="outlined" color="secondary" disabled={isMoving || !canAct} onClick={openChaosSelect} startIcon={<span aria-hidden>⚡</span>}>
                  Chaos tokens: {currentPlayer.chaosTokens}
                </Button>
              )}
            </Box>

            <Box sx={{ minHeight: '7cqw', width: '80%', maxWidth: 420 }}>
              {hoverTile ? (
                <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: 'background.paper', borderLeft: `6px solid ${hoverTile.color}`, boxShadow: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 800 }}>{hoverTile.type === 'property' ? `${hoverTile.sub} · ${hoverTile.name}` : hoverTile.name}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {LABELS.tileTypes[hoverTile.type] || hoverTile.type}
                    {hoverTile.price > 0 && ` · ${money(hoverTile.price)}`}
                    {hoverTile.owner != null ? ` · Owner: ${ownerName(hoverTile.owner)}` : (hoverTile.price > 0 ? ' · For sale' : '')}
                  </Typography>
                  {(hoverTile.type === 'property' || hoverTile.type === 'sequencing_core') && hoverTile.owner != null && (
                    <Typography variant="caption" sx={{ display: 'block' }}>
                      Rent now: <strong>{money(hoverTile.rent)}</strong>{hoverTile.type === 'sequencing_core'
                        ? ` (${money(hoverTile.baseRent)} for each of the owner's ${hoverTile.multiplier} core tile${hoverTile.multiplier === 1 ? '' : 's'})`
                        : ` (base ${money(hoverTile.baseRent)} × ${hoverTile.multiplier.toFixed(1)}${hoverTile.level ? `, level ${hoverTile.level}` : ''})`}
                    </Typography>
                  )}
                </Box>
              ) : (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center' }}>
                  Hover over or tab to a tile for details. New here? <Box component="button" type="button" onClick={() => setRulesOpen(true)} sx={{ font: 'inherit', color: 'primary.main', textDecoration: 'underline', background: 'none', border: 0, p: 0, cursor: 'pointer' }}>See how to play</Box>.
                </Typography>
              )}
            </Box>
            <Typography sx={{ fontSize: 'max(11px, 1.1cqw)', color: 'text.secondary' }}>© Hans Ghezzi · Learn Around the Board</Typography>
          </Board>
        </Box>

        <Box component="aside" aria-label="Players and game log" sx={{ flex: '1 1 260px', maxWidth: { lg: 380 }, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 2, alignItems: 'start' }}>
          <TeamPanel players={players} board={board} turn={turn} moneyFloats={moneyFloats} goal={goal} goalReached={isSolo && (goalReachedTurn != null || soloWorth >= goal)} milestones={soloMilestones} />
          <Card sx={{ p: 2 }}>
            <Typography variant="overline" component="h2" color="text.secondary" sx={{ fontWeight: 800 }}>Game log</Typography>
            <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, maxHeight: 260, overflowY: 'auto', fontSize: '0.85rem', color: 'text.secondary' }}>
              {logs.map((l, i) => (
                <Box component="li" key={i} sx={{ py: 0.6, borderBottom: '1px solid', borderColor: 'divider', color: i === 0 ? 'text.primary' : undefined, fontWeight: i === 0 ? 700 : 400 }}>{l}</Box>
              ))}
            </Box>
          </Card>
        </Box>
      </Box>

      <Modal open={modalOpen} disableEscapeKeyDown>
        <Box role="dialog" aria-modal="true" aria-labelledby={TITLE_ID} sx={{ ...modalStyle, ...(dialogTile?.color ? { borderTopColor: dialogTile.color } : {}) }}>
          {showDialogTop && <DialogTop tile={dialogTile} player={currentPlayer} />}
          {waitingNote && <Alert severity="info" icon={<span aria-hidden>👀</span>} sx={{ mb: 2 }}>{waitingNote}</Alert>}
          {botWatching && (
            <Alert
              severity="info"
              icon={<span aria-hidden>🤖</span>}
              sx={{ mb: 2, alignItems: 'center' }}
              action={!botFast && <Button color="inherit" size="small" onClick={() => setSkipSeq(turnSeq)}>{LABELS.skipAhead}<span aria-hidden>&nbsp;⏩</span></Button>}
            >
              {botFast ? 'Skipping ahead to your turn…' : LABELS.botPlaying}
            </Alert>
          )}
          {/* A disabled fieldset disables every button and input inside: a guest watches until it's their turn. */}
          <Box component="fieldset" disabled={!canAct} sx={{ border: 0, p: 0, m: 0, minWidth: 0, '&:disabled button, &:disabled input': { cursor: 'default' } }}>

          {activeCard?.type === 'LIQUIDATION' && modalStage === 'LIQUIDATION' && (() => {
            const rows = [];
            const groupsSeen = new Set();
            activeCard.assets.forEach((a) => {
              const t = board.find((b) => b.id === a.id) || a;
              if (t.level > 0) {
                const key = `${t.group}|${t.sub}`;
                if (groupsSeen.has(key)) return;
                groupsSeen.add(key);
                const n = getSubgroupTiles(board, t).length;
                rows.push({ t, kind: 'downgrade', value: downgradeSubgroup(board, t, currentPlayer.id).refund, n });
              } else rows.push({ t, kind: 'sell', value: sellDeed(board, t).value });
            });
            return (
              <>
                <Typography id={TITLE_ID} variant="h4" component="h2" color="error" gutterBottom>{LABELS.outOfMoney}</Typography>
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center', p: 1.5, mb: 2, borderRadius: 2, bgcolor: 'error.light' }}>
                  <Typography sx={{ fontWeight: 800 }}>Cash: <Box component="span" sx={{ color: 'error.main' }}>{money(currentPlayer.money)}</Box></Typography>
                  <Typography>Raise <strong>{money(Math.max(0, -currentPlayer.money))}</strong> to get back to $0 and end your turn.</Typography>
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>Sell a tile for half its price, or remove one upgrade level from a whole colour group for half its upgrade cost.</Typography>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {rows.map(({ t, kind, value, n }) => (
                    <Box key={t.id} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1.25, border: '1px solid', borderColor: 'divider', borderLeft: `6px solid ${t.color}`, borderRadius: 2 }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography sx={{ fontWeight: 800 }}>{tileLabel(t)}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {t.type === 'property' ? t.group : LABELS.tileTypes[t.type]}
                          {kind === 'downgrade' ? ` · ${n} tiles · level ${t.level}` : ` · bought for ${money(t.price)}`}
                        </Typography>
                      </Box>
                      <Button variant="contained" color="error" onClick={() => handleSellAsset(t)} sx={{ flexShrink: 0 }}>
                        {kind === 'downgrade' ? 'Downgrade group' : 'Sell deed'} {signedMoney(value)}
                      </Button>
                    </Box>
                  ))}
                </Box>
              </>
            );
          })()}

          {activeCard?.type === 'GRANT' && modalStage === 'GRANT_INTRO' && (
            <>
              <Typography id={TITLE_ID} variant="h4" component="h2" color="error" gutterBottom><span aria-hidden>🛟 </span>{LABELS.bankrupt}</Typography>
              <Typography sx={{ mb: 1.5 }}>
                You are <strong>{money(activeCard.debt)}</strong> in debt, and selling everything still wouldn't cover it.
              </Typography>
              <Typography sx={{ mb: 2 }}>
                One last chance: the <strong>{LABELS.rescueQuiz}</strong>. Answer <strong>2 of 3</strong> questions correctly and your debt is cleared, plus {money(ECONOMY.rescueBonus)} to keep playing.
              </Typography>
              <Alert severity="warning" sx={{ mb: 3 }}>
                Each player gets <strong>one</strong> rescue per game. If you don't pass, or you go bankrupt again later, you are out and your tiles return to the bank.
              </Alert>
              <Button fullWidth size="large" variant="contained" autoFocus onClick={startGrantExam}>Start the rescue quiz</Button>
            </>
          )}

          {modalStage === 'GRANT_QUIZ' && quizState.active && (
            <>
              <QuizProgress title={LABELS.rescueQuiz} quiz={quizState} need={quizState.targetScore} rescue />
              {renderQuestion(quizState.questions[quizState.qIndex], handleQuizAnswer, {
                key: `grant-${quizState.qIndex}`,
                reveal: quizState.waiting ? { ...quizState.result, response: quizState.selected } : null,
              })}
              {quizState.waiting && (
                <OutcomePanel feedback={{ tone: quizState.isCorrect ? 'good' : 'bad', title: quizState.isCorrect ? 'Correct!' : 'Not quite', explanation: quizState.questions[quizState.qIndex].explanation || '' }}>
                  <Button fullWidth size="large" variant="contained" aria-describedby={OUTCOME_ID} onClick={handleNextQuestion}>
                    {quizState.qIndex < quizState.questions.length - 1 ? 'Next question' : 'Finish quiz'}
                  </Button>
                </OutcomePanel>
              )}
            </>
          )}

          {modalStage === 'GRANT_RESULT' && (
            <OutcomePanel feedback={feedback} titleId={TITLE_ID} big>
              <Button fullWidth size="large" variant="contained" onClick={passTurn}>Keep playing</Button>
            </OutcomePanel>
          )}

          {activeCard?.type === 'WIN' && modalStage === 'WIN' && (() => {
            const winner = activePlayers(players)[0];
            return (
              <Box sx={{ textAlign: 'center', py: 1 }}>
                <motion.div initial={{ scale: 0.3, rotate: -15 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 12 }}>
                  <Box aria-hidden sx={{ fontSize: 84, lineHeight: 1 }}>🏆</Box>
                </motion.div>
                <Typography id={TITLE_ID} variant="h3" component="h2" color="primary" sx={{ mt: 1 }}>Victory!</Typography>
                {winner && (
                  <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, mt: 1.5, px: 2, py: 0.75, borderRadius: 99, border: '2px solid', borderColor: winner.color }}>
                    <TeamDot player={winner} size={28} />
                    <Typography variant="h6" component="p">{winner.name}</Typography>
                  </Box>
                )}
                <Typography sx={{ mt: 1.5 }}>{activeCard.msg}</Typography>
                <Button fullWidth size="large" variant="contained" autoFocus sx={{ mt: 3 }} onClick={() => openStandings(true, 'last_standing')}>See final standings</Button>
              </Box>
            );
          })()}

          {activeCard?.type === 'ELIMINATED' && modalStage === 'ELIMINATED' && (
            <>
              <Typography id={TITLE_ID} variant="h4" component="h2" color="error" gutterBottom>{LABELS.eliminated}</Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, color: 'text.secondary' }}>
                {players[activeCard.playerId] && <TeamDot player={players[activeCard.playerId]} />}
                <Typography sx={{ fontWeight: 800, textDecoration: 'line-through' }}>{activeCard.name}</Typography>
              </Box>
              <Typography sx={{ mb: 1 }}>
                <strong>{activeCard.name}</strong> could not cover its debts and is out of the game. Its tiles return to the bank, ready to be bought again.
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>Reason: {activeCard.reason}.</Typography>
              <Button fullWidth size="large" variant="contained" autoFocus onClick={continueAfterElimination}>Continue</Button>
            </>
          )}

          {activeCard?.type === 'STANDINGS' && modalStage === 'STANDINGS' && (() => {
            const standings = rankPlayers(players, board);
            const leader = standings[0];
            const tied = standings.filter((r) => !r.eliminated && r.netWorth === leader?.netWorth);
            const reasonText = {
              time: "Time's up! The player with the highest net worth (cash + tile value) wins.",
              last_standing: 'Last player standing!',
              eliminated: 'No players remain.',
              ended: 'Ending the game now ranks players by net worth (cash + tile value).',
            }[activeCard.reason];
            const soloReason = { time: "Time's up!", ended: 'Game over.', eliminated: 'Out of money.' }[activeCard.reason];
            const medal = ['🥇', '🥈', '🥉'];
            return (
              <>
                <Typography id={TITLE_ID} variant="h4" component="h2" gutterBottom>Final Standings</Typography>
                <Typography sx={{ mb: 2 }}>{isSolo ? soloReason || reasonText : reasonText}</Typography>
                {isSolo && leader && (() => {
                  const acc = soloAccuracy();
                  const best = getPersonalBest(bestKey);
                  const reached = goalReachedTurn != null;
                  return (
                    <Box sx={{ mb: 2 }}>
                      <Alert severity={reached ? 'success' : 'info'} icon={<span aria-hidden>🎯</span>} sx={{ mb: 1.5, fontWeight: 700 }}>
                        {reached
                          ? `Goal reached on turn ${goalReachedTurn}: ${money(goal)} net worth. You finished with ${money(leader.netWorth)}.`
                          : `Goal: ${money(goal)} net worth. You reached ${money(leader.netWorth)} (${Math.round((100 * Math.max(0, leader.netWorth)) / goal)}% of the goal).`}
                      </Alert>
                      <Box component="ul" sx={{ m: 0, pl: 2.5, '& li': { mb: 0.5 } }}>
                        {acc.total > 0 && <li>Questions answered correctly: <strong>{acc.right} of {acc.total}</strong> ({acc.pct}%).</li>}
                        <li>Milestones captured: <strong>{soloMilestones} of 4</strong>{soloMilestones === 4 ? ' (bonus achieved!)' : ''}.</li>
                        <li>{!best ? 'This is your first finished game with these questions and this session length on this computer.'
                          : leader.netWorth > best.netWorth ? `New personal best! Your previous best was ${money(best.netWorth)}.`
                            : `Your personal best on this computer: ${money(best.netWorth)}.`}</li>
                      </Box>
                    </Box>
                  );
                })()}
                {botPlayer && !isGuest && (() => {
                  const level = botPlayer.bot.level;
                  const prev = getBotRecord(bestKey, level) || { wins: 0, games: 0 };
                  const { won } = botResult(standings);
                  const wins = prev.wins + (won ? 1 : 0);
                  const games = prev.games + 1;
                  return (
                    <Alert severity={won ? 'success' : 'info'} icon={<span aria-hidden>🤖</span>} sx={{ mb: 2 }}>
                      {won ? `You beat the ${botPlayer.name}!` : `The ${botPlayer.name} wins this time.`}
                      {' '}Your record against it on this computer, counting this game: <strong>{wins} win{wins === 1 ? '' : 's'} in {games} game{games === 1 ? '' : 's'}</strong>.
                      {won && level !== 'hard' ? ` Ready for ${level === 'easy' ? 'Medium' : 'Hard'}?` : ''}
                    </Alert>
                  );
                })()}
                {players.length > 1 && leader && !leader.eliminated && (
                  <Alert severity="success" icon={<span aria-hidden>🏆</span>} sx={{ mb: 2, fontWeight: 700 }}>
                    {tied.length > 1 ? `It's a tie: ${tied.map((t) => t.name).join(' & ')}` : `${leader.name} wins`} with a net worth of {money(leader.netWorth)}.
                  </Alert>
                )}
                <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', mb: 2, '& td, & th': { p: 1, borderBottom: '1px solid', borderColor: 'divider', textAlign: 'right' }, '& th': { fontSize: '0.85rem', color: 'text.secondary' }, '& td:nth-of-type(2), & th:nth-of-type(2)': { textAlign: 'left' } }}>
                  <caption style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Final standings by net worth</caption>
                  <thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Cash</th><th scope="col">Tiles</th><th scope="col">Net worth</th></tr></thead>
                  <tbody>
                    {standings.map((r) => (
                      <Box component="tr" key={r.id} sx={{ bgcolor: r.rank === 1 && !r.eliminated && players.length > 1 ? 'action.selected' : undefined, color: r.eliminated ? 'text.secondary' : undefined }}>
                        <td><span aria-hidden>{!r.eliminated && players.length > 1 ? `${medal[r.rank - 1] || ''} ` : ''}</span>{r.rank}</td>
                        <td>
                          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                            <TeamDot player={players[r.id]} size={20} />
                            <strong>{r.name}</strong>{r.eliminated ? ' (eliminated)' : ''}
                          </Box>
                        </td>
                        <td>{money(r.cash)}</td>
                        <td>{money(r.assets)}</td>
                        <td><strong>{money(r.netWorth)}</strong></td>
                      </Box>
                    ))}
                  </tbody>
                </Box>
                <Alert severity="info" sx={{ mb: 2 }}>Next: the post-game survey. Then send or download your results on the final screen.</Alert>
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                  {!activeCard.forced && <Button sx={{ flex: '1 1 160px' }} size="large" variant="outlined" onClick={() => setModalOpen(false)}>Back to game</Button>}
                  <Button sx={{ flex: '1 1 220px' }} size="large" variant="contained" color="success" autoFocus onClick={() => handleEndGame(activeCard.reason)}>Continue to post-survey</Button>
                </Box>
              </>
            );
          })()}

          {activeCard?.type === 'MILESTONE' && modalStage === 'MILESTONE_INTRO' && (
            <>
              <Typography id={TITLE_ID} variant="h4" component="h2" color="primary"><span aria-hidden>🏆 </span>{activeCard.data.name} milestone</Typography>
              <Typography sx={{ mt: 1, mb: 2 }}>This corner is free. Capture it by passing a 6-question exam.</Typography>
              <Box component="ul" sx={{ m: 0, mb: 2, pl: 2.5, '& li': { mb: 0.75 } }}>
                <li>Get <strong>5 of 6</strong> right. Your second mistake ends the exam.</li>
                <li>Pass: pay <strong>{money(activeCard.data.price)}</strong>, own the corner (rivals pay {money(activeCard.data.baseRent)} when they land) and earn a <strong>⚡ {LABELS.chaosToken.toLowerCase()}</strong>.</li>
                <li>Don't pass: nothing is charged.</li>
              </Box>
              <Box sx={{ mt: 3, display: 'flex', gap: 2 }}>
                <Button fullWidth size="large" variant="contained" autoFocus onClick={() => startQuiz(activeCard.data, 'MILESTONE_ACQUIRE')}>Start exam</Button>
                <Button fullWidth size="large" variant="outlined" onClick={declineMilestone}>Decline</Button>
              </Box>
            </>
          )}

          {activeCard?.type === 'MILESTONE_CHALLENGE' && modalStage === 'MILESTONE_CHALLENGE_INTRO' && (() => {
            const fee = board.find((t) => t.id === activeCard.data.id)?.baseRent || 0;
            return (
              <>
                <Typography id={TITLE_ID} variant="h4" component="h2" color="error"><span aria-hidden>⚠️ </span>{LABELS.rivalMilestone}</Typography>
                <Typography sx={{ mt: 1, mb: 2 }}>
                  <strong>{ownerName(activeCard.ownerId)}</strong> owns {activeCard.data.name}. The landing fee is <strong>{money(fee)}</strong>.
                </Typography>
                <Stakes good={`pass the 6-question exam (5 right) and pay half: ${money(Math.floor(fee / 2))}.`} bad={`fail it and pay the full ${money(fee)}.`} />
                <Box sx={{ mt: 3, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                  <Button sx={{ flex: '1 1 200px' }} size="large" variant="contained" color="warning" autoFocus onClick={() => startQuiz(activeCard.data, 'MILESTONE_CHALLENGE')}>Accept challenge</Button>
                  <Button sx={{ flex: '1 1 200px' }} size="large" variant="outlined" onClick={payMilestoneFee}>Pay full fee ({money(fee)})</Button>
                </Box>
              </>
            );
          })()}

          {modalStage === 'QUIZ_START' && quizState.active && quizState.mode !== 'GRANT' && (
            <>
              <QuizProgress
                title={`Milestone exam · ${quizTile?.name || ''}`}
                quiz={quizState}
                need={quizState.targetScore}
                onQuit={quizState.waiting ? null : () => finishQuiz(false)}
              />
              {renderQuestion(quizState.questions[quizState.qIndex], handleQuizAnswer, {
                key: `quiz-${quizState.qIndex}`,
                reveal: quizState.waiting ? { ...quizState.result, response: quizState.selected } : null,
              })}
              {quizState.waiting && (() => {
                const over = quizState.mistakes >= quizState.maxMistakes;
                const last = quizState.qIndex >= quizState.questions.length - 1;
                return (
                  <OutcomePanel feedback={{
                    tone: quizState.isCorrect ? 'good' : 'bad',
                    title: quizState.isCorrect ? 'Correct!' : 'Not quite',
                    detail: over ? 'That was your second mistake, so the exam ends here.' : (!quizState.isCorrect ? 'One mistake used. One more ends the exam.' : ''),
                    explanation: quizState.questions[quizState.qIndex].explanation || '',
                  }}>
                    <Button fullWidth size="large" variant="contained" aria-describedby={OUTCOME_ID} onClick={handleNextQuestion}>
                      {over || last ? 'Finish exam' : 'Next question'}
                    </Button>
                  </OutcomePanel>
                );
              })()}
            </>
          )}

          {modalStage === 'MILESTONE_SUCCESS' && (
            <Box sx={{ textAlign: 'center' }}>
              <motion.div initial={{ scale: 0.3 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 12 }}>
                <Box aria-hidden sx={{ fontSize: 72, lineHeight: 1 }}>🏆</Box>
              </motion.div>
              <Typography id={TITLE_ID} variant="h4" component="h2" color="success.main" sx={{ mt: 1 }}>Milestone captured!</Typography>
              <Typography sx={{ mt: 1 }}>
                {quizState.score} of {quizState.questions.length} correct. <strong>{currentPlayer.name}</strong> now owns {quizTile?.name} ({signedMoney(-(quizTile?.price || 0))}){isSolo ? `. Land here again to answer for ${money(ECONOMY.milestoneFee)} from the bank.` : ` and earns a ⚡ ${LABELS.chaosToken.toLowerCase()}.`}
              </Typography>
              <Button fullWidth size="large" variant="contained" autoFocus sx={{ mt: 3 }} onClick={passTurn}>Continue</Button>
            </Box>
          )}

          {modalStage === 'MILESTONE_FAIL' && (
            <Box sx={{ textAlign: 'center' }}>
              <Typography id={TITLE_ID} variant="h4" component="h2" color="error" sx={{ mt: 1 }}>Exam not passed</Typography>
              <Typography sx={{ mt: 1 }}>
                {quizState.score} of {quizState.questions.length} correct (you needed {quizState.targetScore}). Nothing is charged: try again next time you land here.
              </Typography>
              <Button fullWidth size="large" variant="contained" autoFocus sx={{ mt: 3 }} onClick={passTurn}>Continue</Button>
            </Box>
          )}

          {activeCard?.type === 'QUESTION' && modalStage === 'QUESTION' && (
            <>
              <Typography id={TITLE_ID} variant="h5" component="h2" sx={{ mb: 1.5 }}>{LABELS.questionTitle} · {tileLabel(activeCard.data)}</Typography>
              <Stakes good={`you may buy this tile for ${money(activeCard.data.price)}.`} bad={`you pay ${money(ECONOMY.wrongAnswerPenalty)}.`} />
              {renderQuestion(activeCard.q, handleAnswer)}
            </>
          )}

          {activeCard?.type === 'QUESTION' && modalStage === 'DECISION' && (() => {
            const tile = activeCard.data;
            const canAfford = currentPlayer.money >= tile.price;
            const rentWhenOwned = rentIf(tile, { owner: currentPlayer.id });
            return (
              <>
                <Typography id={TITLE_ID} variant="h5" component="h2" sx={{ mb: 1.5 }}>{LABELS.questionTitle} · {tileLabel(tile)}</Typography>
                {renderAnswered()}
                <OutcomePanel feedback={feedback}>
                  <Box sx={{ p: 2, borderRadius: 2, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                    <Typography sx={{ fontWeight: 800, fontSize: '1.1rem' }}>{LABELS.buyPrompt(tile.price)}</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      You have {money(currentPlayer.money)}{canAfford ? `, leaving ${money(currentPlayer.money - tile.price)}` : ''}.
                      {' '}Rivals who land here would pay {money(rentWhenOwned)}{tile.type === 'property' ? ', more once you own the whole colour group' : tile.type === 'sequencing_core' ? `, $${ECONOMY.coreRentStep} more for each other core tile you own` : ''}.
                    </Typography>
                    {!canAfford && <Alert severity="warning" sx={{ mt: 1.5 }}>Not enough cash to buy this tile.</Alert>}
                    <Box sx={{ display: 'flex', gap: 1.5, mt: 2 }}>
                      <Button fullWidth size="large" variant="contained" aria-describedby={OUTCOME_ID} onClick={handleBuy} disabled={!canAfford}>{LABELS.buy} for {money(tile.price)}</Button>
                      <Button fullWidth size="large" variant="outlined" onClick={passTurn}>{LABELS.skip}</Button>
                    </Box>
                  </Box>
                </OutcomePanel>
              </>
            );
          })()}

          {activeCard?.type === 'MSG' && modalStage === 'MSG' && (
            <>
              <Typography id={TITLE_ID} variant="h5" component="h2" gutterBottom>{tileLabel(activeCard.data)}</Typography>
              <Typography sx={{ fontSize: '1.1rem' }}>{activeCard.msg}</Typography>
              <Button fullWidth size="large" variant="contained" autoFocus sx={{ mt: 3 }} onClick={passTurn}>Continue</Button>
            </>
          )}

          {activeCard?.type === 'MISHAP' && modalStage === 'MISHAP' && (
            <Box sx={{ textAlign: 'center' }}>
              <motion.div initial={{ rotateY: 90, opacity: 0 }} animate={{ rotateY: 0, opacity: 1 }} transition={{ duration: 0.45 }}>
                <Box aria-hidden sx={{ fontSize: 56, lineHeight: 1 }}>🃏</Box>
                <Typography id={TITLE_ID} variant="h4" component="h2" sx={{ mt: 1 }}>{LABELS.chanceCard}</Typography>
                <Typography sx={{ mt: 1.5, fontSize: '1.15rem', fontWeight: 700 }}>{activeCard.msg}</Typography>
                {activeCard.amount ? (
                  <Box sx={{ display: 'inline-block', mt: 2, px: 2.5, py: 0.75, borderRadius: 99, fontWeight: 900, fontSize: '1.4rem', bgcolor: activeCard.amount > 0 ? 'success.light' : 'error.light', color: activeCard.amount > 0 ? 'success.main' : 'error.main' }}>
                    {signedMoney(activeCard.amount)}
                  </Box>
                ) : null}
              </motion.div>
              {activeCard.data.fact && (
                <Box sx={{ mt: 2.5, p: 2, borderRadius: 2, bgcolor: 'info.light', textAlign: 'left' }}>
                  <Typography variant="overline" sx={{ fontWeight: 800, color: 'info.main', lineHeight: 1.5 }}>Did you know?</Typography>
                  <Typography>{activeCard.data.fact}</Typography>
                </Box>
              )}
              <Button fullWidth size="large" variant="contained" autoFocus sx={{ mt: 3 }} onClick={passTurn}>Continue</Button>
            </Box>
          )}

          {modalStage === 'FEEDBACK_INCORRECT' && activeCard?.type !== 'MISHAP' && activeCard?.type !== 'WIN' && (
            <>
              {lastAnswer ? (
                <>
                  <Typography id={TITLE_ID} variant="h5" component="h2" sx={{ mb: 1.5 }}>{resultHeading()}</Typography>
                  {renderAnswered()}
                  <OutcomePanel feedback={feedback}>
                    <Button fullWidth size="large" variant="contained" aria-describedby={OUTCOME_ID} onClick={passTurn}>Continue</Button>
                  </OutcomePanel>
                </>
              ) : (
                <OutcomePanel feedback={feedback} titleId={TITLE_ID} big>
                  <Button fullWidth size="large" variant="contained" onClick={passTurn}>Continue</Button>
                </OutcomePanel>
              )}
            </>
          )}

          {activeCard?.type === 'UPGRADE_OFFER' && (() => {
            const tile = board.find((t) => t.id === activeCard.data.id) || activeCard.data;
            const g = ownedGroups.find((x) => x.tile.group === tile.group && x.tile.sub === tile.sub);
            if (!g) return null;
            const rentNow = computeRent(board, tile);
            const rentAfter = rentIf(tile, { level: g.next }, true);
            const canPay = currentPlayer.money >= g.cost;
            return (
              <>
                <Typography id={TITLE_ID} variant="h5" component="h2" sx={{ mb: 2 }}>{LABELS.upgradeTitle}: {tile.sub}</Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 2, p: 2, borderRadius: 2, bgcolor: 'action.hover', textAlign: 'center' }}>
                  <Box>
                    <Typography variant="overline" color="text.secondary">Now</Typography>
                    <Stars level={g.level} />
                    <Typography sx={{ fontWeight: 800 }}>Rent {money(rentNow)}</Typography>
                  </Box>
                  <Box aria-hidden sx={{ fontSize: 28, color: 'text.secondary' }}>→</Box>
                  <Box>
                    <Typography variant="overline" color="text.secondary">After</Typography>
                    <Stars level={g.next} />
                    <Typography sx={{ fontWeight: 800, color: 'success.main' }}>Rent {money(rentAfter)}</Typography>
                  </Box>
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                  Rent is per tile, for all {g.size} {tile.sub} tiles. You have {money(currentPlayer.money)}.
                </Typography>
                {!canPay && <Alert severity="warning" sx={{ mt: 1.5 }}>Not enough cash for this upgrade.</Alert>}
                <Button fullWidth size="large" variant="contained" autoFocus={canPay} disabled={!canPay || !g.canLevel} onClick={handleUpgrade} sx={{ mt: 2 }}>{LABELS.upgrade} for {money(g.cost)}</Button>
                <Button fullWidth size="large" autoFocus={!canPay} onClick={closeDialog} sx={{ mt: 1 }}>Cancel</Button>
              </>
            );
          })()}

          {activeCard?.type === 'OWN_TILE' && modalStage === 'QUESTION' && (
            <>
              <Typography id={TITLE_ID} variant="h5" component="h2" sx={{ mb: 0.5 }}>Your tile pays rent: <Box component="span" sx={{ color: 'success.main' }}>{money(activeCard.income)}</Box></Typography>
              <Typography sx={{ mb: 1.5 }}>You own {tileLabel(activeCard.data)}. Answer its question to collect the rent from the bank.</Typography>
              <Stakes good={`the bank pays you ${money(activeCard.income)}.`} bad={`you pay ${money(ECONOMY.wrongAnswerPenalty)}.`} />
              {renderQuestion(activeCard.q, handleOwnTileAnswer, { imageMaxHeight: 200 })}
            </>
          )}

          {activeCard?.type === 'RENT_DEFENSE' && modalStage === 'QUESTION' && (
            <>
              <Typography id={TITLE_ID} variant="h5" component="h2" sx={{ mb: 0.5 }}>Rent due: <Box component="span" sx={{ color: 'error.main' }}>{money(activeCard.rent)}</Box></Typography>
              <Typography sx={{ mb: 1.5 }}>
                <strong>{activeCard.ownerName}</strong> owns {tileLabel(activeCard.data)}. Answer to cut the rent in half.
              </Typography>
              <Stakes good={`pay only ${money(Math.floor(activeCard.rent / 2))}.`} bad={`pay the full ${money(activeCard.rent)}.`} />
              {renderQuestion(activeCard.q, handleRentChallengeAnswer, { imageMaxHeight: 200 })}
            </>
          )}

          {modalStage === 'CHAOS_SELECT' && activeCard?.type === 'CHAOS_SELECT' && (() => {
            const targets = chaosTargets(board, currentPlayer.id);
            const tokens = currentPlayer.chaosTokens;
            const buyBlocked = !chaosTokensForSale(board) ? 'Unlocks once all 4 milestones have been captured.' : currentPlayer.money < ECONOMY.chaosTokenPrice ? `You need ${money(ECONOMY.chaosTokenPrice)}.` : '';
            return (
              <>
                <Typography id={TITLE_ID} variant="h5" component="h2" gutterBottom><span aria-hidden>⚡ </span>Chaos tokens</Typography>
                <Typography sx={{ mb: 2 }}>
                  You have <strong>{tokens} token{tokens === 1 ? '' : 's'}</strong>. Spend one to challenge for a rival's tile: answer its question right to take it for half price. Answer wrong and you pay a small penalty. Either way the token is used up and your turn ends. Complete sets are protected.
                </Typography>
                {tokens === 0 && <Alert severity="info" sx={{ mb: 2 }}>Capture a milestone (corner tile) to earn a token.</Alert>}
                {targets.length === 0 ? (
                  <Typography color="text.secondary" sx={{ mb: 2 }}>No rival tiles can be challenged right now (complete sets are protected).</Typography>
                ) : (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 320, overflowY: 'auto', mb: 2 }}>
                    {targets.map((t) => {
                      const cost = chaosStealCost(t);
                      const short = currentPlayer.money < cost;
                      return (
                      <Box key={t.id} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1.25, border: '1px solid', borderColor: 'divider', borderLeft: `6px solid ${t.color}`, borderRadius: 2 }}>
                        <TeamDot player={players[t.owner]} size={22} />
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography sx={{ fontWeight: 800 }}>{t.sub} {t.level > 0 && <Stars level={t.level} inline />}</Typography>
                          <Typography variant="body2" color="text.secondary">{t.group} · owned by {ownerName(t.owner)} · take it for {money(cost)}{short ? ` (you need ${money(cost)})` : ''}</Typography>
                        </Box>
                        <Button variant="contained" disabled={tokens <= 0 || short} onClick={() => handleSelectChaosTarget(t)} aria-label={`Challenge for ${t.sub} owned by ${ownerName(t.owner)}`}>Challenge</Button>
                      </Box>
                      );
                    })}
                  </Box>
                )}
                <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover', display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                  <Box sx={{ flex: '1 1 200px' }}>
                    <Typography sx={{ fontWeight: 800 }}>Buy a token for {money(ECONOMY.chaosTokenPrice)}</Typography>
                    <Typography variant="body2" color="text.secondary">{buyBlocked || 'Available now.'}</Typography>
                  </Box>
                  <Button variant="outlined" color="secondary" disabled={Boolean(buyBlocked)} onClick={handleBuyChaosToken}>Buy token</Button>
                </Box>
                <Button fullWidth size="large" autoFocus sx={{ mt: 2 }} onClick={closeDialog}>Cancel</Button>
              </>
            );
          })()}

          {modalStage === 'CHAOS_QUESTION' && activeCard?.type === 'CHAOS_CHALLENGE' && (
            <>
              <Typography id={TITLE_ID} variant="h5" component="h2" sx={{ mb: 0.5 }}>Chaos challenge · {tileLabel(activeCard.data)}</Typography>
              <Typography sx={{ mb: 1.5 }}>Owned by <strong>{ownerName(activeCard.data?.owner)}</strong>. One question decides it.</Typography>
              <Stakes good={`take the tile for ${money(chaosStealCost(activeCard.data))}.`} bad={`pay a ${money(chaosFailPenalty(activeCard.data))} penalty.`} />
              {renderQuestion(activeCard.q, handleChaosAnswer)}
            </>
          )}
          </Box>
        </Box>
      </Modal>

      <Modal open={manageOpen} onClose={() => setManageOpen(false)}>
        <Box role="dialog" aria-modal="true" aria-labelledby="upgrades-title" sx={modalStyle}>
          <DialogTop player={currentPlayer} />
          <Typography id="upgrades-title" variant="h5" component="h2" gutterBottom><span aria-hidden>⭐ </span>{LABELS.upgrades}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Own every tile of a colour group to upgrade it. Each level multiplies the rent rivals pay: 1× → 3× → 6× → 10× → 20×.
          </Typography>
          {ownedGroups.length === 0 ? (
            <Alert severity="info">You don't own any tiles yet. Answer a property question correctly to buy one.</Alert>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 360, overflowY: 'auto' }}>
              {ownedGroups.map((g) => {
                const reason = !g.full ? `Own all ${g.size} to upgrade (${g.owned}/${g.size})` : g.level >= 4 ? 'Maximum level' : !g.canLevel ? 'Levels must be even first' : currentPlayer.money < g.cost ? `Needs ${money(g.cost)}` : '';
                return (
                  <Box key={g.tile.id} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1.25, border: '1px solid', borderColor: 'divider', borderLeft: `6px solid ${g.tile.color}`, borderRadius: 2 }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 800 }}>{g.tile.sub} <Stars level={g.level} inline /></Typography>
                      <Typography variant="body2" color="text.secondary">{g.tile.group} · {g.owned} of {g.size} owned{reason ? ` · ${reason}` : ` · next level ${money(g.cost)}`}</Typography>
                    </Box>
                    <Button
                      variant="contained"
                      disabled={Boolean(reason)}
                      aria-label={`Upgrade ${g.tile.sub}`}
                      onClick={() => { setManageOpen(false); openUpgradeOffer(g.tile); }}
                    >
                      Upgrade
                    </Button>
                  </Box>
                );
              })}
            </Box>
          )}
          <Button fullWidth size="large" autoFocus onClick={() => setManageOpen(false)} sx={{ mt: 2 }}>Close</Button>
        </Box>
      </Modal>

      <RulesDialog
        playerCount={players.length}
        bot={Boolean(botPlayer)}
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        intro={totalTurns === 0 ? 'Quick rules before your first roll. Open them again any time with How to play at the top.' : ''}
      />

      <Dialog open={exitOpen} onClose={() => setExitOpen(false)} aria-labelledby="exit-title" aria-describedby="exit-text">
        <DialogTitle id="exit-title">Leave this game?</DialogTitle>
        <DialogContent>
          <Typography id="exit-text">{isGuest
            ? 'This device stops following the game. The game goes on on the host, who can play for you; open the join link again to come back.'
            : 'The current game and its results will be lost. To finish properly, use End game instead.'}</Typography>
        </DialogContent>
        <DialogActions>
          <Button autoFocus onClick={() => setExitOpen(false)}>No, stay in the game</Button>
          <Button color="error" variant="contained" onClick={() => { setExitOpen(false); onExit(); }}>Yes, leave</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={endOpen} onClose={() => setEndOpen(false)} aria-labelledby="end-title" aria-describedby="end-text">
        <DialogTitle id="end-title">End the game now?</DialogTitle>
        <DialogContent>
          <Typography id="end-text">The final standings are shown, ranked by net worth, and then everyone takes the post-game survey.</Typography>
        </DialogContent>
        <DialogActions>
          <Button autoFocus onClick={() => setEndOpen(false)}>No, keep playing</Button>
          <Button color="warning" variant="contained" onClick={() => { setEndOpen(false); openStandings(false, 'ended'); }}>Yes, end the game</Button>
        </DialogActions>
      </Dialog>
    </Box>
    </MotionConfig>
  );
}

// ------------------------------------------------------------------
//  PRESENTATION HELPERS
// ------------------------------------------------------------------

/** Round team token: symbol on a deep team colour (white text stays readable). */
function TeamDot({ player, size = 24 }) {
  if (!player) return null;
  return (
    <Box
      aria-hidden
      sx={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        bgcolor: TEAM_INK[player.id] || player.color, color: 'common.white', fontSize: Math.round(size * 0.5), lineHeight: 1,
        boxShadow: `0 0 0 2px ${player.color}`,
      }}
    >
      {TEAM_SYMBOLS[player.id]}
    </Box>
  );
}

function Stars({ level = 0, inline = false }) {
  return (
    <Box component="span" role="img" aria-label={`Level ${level} of 4`} sx={{ color: 'warning.main', letterSpacing: 1, fontSize: inline ? '0.9rem' : '1.3rem', display: inline ? 'inline' : 'block', whiteSpace: 'nowrap' }}>
      {'★'.repeat(level)}<Box component="span" sx={{ color: 'text.disabled' }}>{'☆'.repeat(Math.max(0, 4 - level))}</Box>
    </Box>
  );
}

/** Top strip of every game dialog: which tile, and whose turn. */
function DialogTop({ tile, player }) {
  const kind = tile ? ({ property: tile.group, sequencing_core: LABELS.tileTypes.sequencing_core, milestone: 'Milestone', chance: LABELS.chanceTile }[tile.type] || '') : '';
  const name = tile ? (tile.type === 'property' ? tile.sub : tile.name) : '';
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, mb: 2, pb: 1.5, borderBottom: '1px solid', borderColor: 'divider', flexWrap: 'wrap' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        {tile && <Box aria-hidden sx={{ width: 14, height: 14, borderRadius: 1, bgcolor: tile.color, flexShrink: 0 }} />}
        {tile && <Typography variant="body2" sx={{ fontWeight: 800 }}>{name}</Typography>}
        {kind && kind !== name && <Typography variant="body2" color="text.secondary">· {kind}</Typography>}
      </Box>
      {player && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <TeamDot player={player} size={22} />
          <Typography variant="body2" sx={{ fontWeight: 800 }}>{player.name}</Typography>
          <Typography variant="body2" sx={{ fontWeight: 700, color: player.money < 0 ? 'error.main' : 'text.secondary' }}>{money(player.money)}</Typography>
        </Box>
      )}
    </Box>
  );
}

/** What a right and a wrong answer mean, shown before the question. */
function Stakes({ good, bad }) {
  const cell = (ok, text) => (
    <Box sx={{ p: 1.25, borderRadius: 2, bgcolor: ok ? 'success.light' : 'error.light', display: 'flex', gap: 1, alignItems: 'baseline' }}>
      <Box component="span" aria-hidden sx={{ color: ok ? 'success.main' : 'error.main', fontWeight: 900 }}>{ok ? '✓' : '✗'}</Box>
      <Typography variant="body2"><strong>{ok ? 'Right:' : 'Wrong:'}</strong> {text}</Typography>
    </Box>
  );
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1, mb: 2.5 }}>
      {cell(true, good)}
      {cell(false, bad)}
    </Box>
  );
}

// Buttons under a result ignore input this long after it appears: a held key or a
// double click can't skip the explanation.
const OUTCOME_ARM_MS = 400;

/**
 * Result of an answer or event, with the explanation (the teaching moment) and the next action.
 * Keyboard focus lands on the result itself, never on its buttons: a key press that
 * submitted the answer can't also press Continue or Buy, and screen readers read the
 * explanation first. Tab reaches the buttons.
 */
function OutcomePanel({ feedback, titleId, big = false, children }) {
  const panelRef = useRef(null);
  const [armed, setArmed] = useState(false);
  const shown = Boolean(feedback);
  useEffect(() => {
    if (!shown) return undefined;
    panelRef.current?.focus({ preventScroll: true });
    const id = setTimeout(() => setArmed(true), OUTCOME_ARM_MS);
    return () => clearTimeout(id);
  }, [shown]);
  if (!feedback) return children || null;
  const tone = feedback.tone || 'neutral';
  const c = tone === 'good' ? 'success' : tone === 'bad' ? 'error' : 'info';
  return (
    <Box ref={panelRef} tabIndex={-1} role="group" aria-labelledby={OUTCOME_ID} sx={{ mt: big ? 0 : 2.5, p: { xs: 2, sm: 2.5 }, borderRadius: 3, border: '2px solid', borderColor: `${c}.main`, bgcolor: 'action.hover', '&:focus': { outline: 'none' }, '&:focus-visible': { outline: '3px solid', outlineColor: `${c}.main`, outlineOffset: 2 } }}>
      <Box id={OUTCOME_ID} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
        <motion.div initial={{ scale: 0.4, rotate: -25 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 14 }}>
          <Box aria-hidden sx={{ width: big ? 48 : 40, height: big ? 48 : 40, borderRadius: '50%', bgcolor: `${c}.main`, color: `${c}.contrastText`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: big ? 26 : 22 }}>
            {tone === 'good' ? '✓' : tone === 'bad' ? '✗' : 'i'}
          </Box>
        </motion.div>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id={titleId} variant={big ? 'h4' : 'h5'} component={titleId ? 'h2' : 'p'} sx={{ color: `${c}.main`, lineHeight: 1.2 }}>{feedback.title}</Typography>
          {feedback.detail && <Typography sx={{ mt: 0.5, fontWeight: 700 }}>{feedback.detail}</Typography>}
        </Box>
      </Box>
      {feedback.explanation && (
        <Box sx={{ mt: 2, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography variant="overline" component="p" color="text.secondary" sx={{ fontWeight: 800, lineHeight: 1.6 }}>Why</Typography>
          <Typography sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{feedback.explanation}</Typography>
        </Box>
      )}
      {feedback.note && <Alert severity="warning" sx={{ mt: 2 }}>{feedback.note}</Alert>}
      {children && <Box inert={!armed} sx={{ mt: 2.5 }}>{children}</Box>}
    </Box>
  );
}

/** Exam header: title, question count and one pip per question. */
function QuizProgress({ title, quiz, need, onQuit, rescue = false }) {
  const total = quiz.questions.length;
  const history = quiz.history || [];
  const mistakesLeft = Math.max(0, (quiz.maxMistakes || 2) - 1 - (quiz.mistakes || 0));
  const status = rescue
    ? `Need ${need} of ${total} correct · ${quiz.score} so far`
    : `Need ${need} of ${total} · ${mistakesLeft > 0 ? `${mistakesLeft} mistake allowed` : 'no more mistakes allowed'}`;
  return (
    <Box sx={{ mb: 2.5 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
        <Typography id={TITLE_ID} variant="h6" component="h2">{title}</Typography>
        {onQuit && <Button size="small" color="error" onClick={onQuit}>Give up</Button>}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', mt: 1 }}>
        <Box role="img" aria-label={`${history.filter(Boolean).length} right, ${history.filter((h) => h === false).length} wrong, question ${quiz.qIndex + 1} of ${total}`} sx={{ display: 'flex', gap: 0.75 }}>
          {Array.from({ length: total }, (_, i) => {
            const h = history[i];
            const state = h === true ? 'right' : h === false ? 'wrong' : i === quiz.qIndex ? 'current' : 'todo';
            const filled = state === 'right' || state === 'wrong';
            const c = state === 'right' ? 'success' : 'error';
            return (
              <Box key={i} sx={{
                width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 900,
                border: '2px solid', borderColor: filled ? `${c}.main` : state === 'current' ? 'primary.main' : 'divider',
                bgcolor: filled ? `${c}.main` : 'transparent', color: filled ? `${c}.contrastText` : state === 'current' ? 'primary.main' : 'text.secondary',
              }}>
                {state === 'right' ? '✓' : state === 'wrong' ? '✗' : i + 1}
              </Box>
            );
          })}
        </Box>
        <Typography variant="body2" sx={{ fontWeight: 700 }} color="text.secondary">Question {quiz.qIndex + 1} of {total} · {status}</Typography>
      </Box>
    </Box>
  );
}
