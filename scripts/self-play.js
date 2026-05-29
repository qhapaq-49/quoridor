"use strict";

const Engine = require("./engine.js");
const AI = require("./ai.js");

function parseArgs(argv) {
  const args = {
    games: 20,
    seed: 1,
    maxPlies: 220,
    quiet: false,
    aStrength: "strong",
    bStrength: "strong",
    aRandomness: 0,
    bRandomness: 0,
    aTimeLimit: null,
    bTimeLimit: null,
    aMaxDepth: null,
    bMaxDepth: null,
    aWallLimit: null,
    bWallLimit: null,
    aReplyWallLimit: null,
    bReplyWallLimit: null,
    aShallowWallLimit: null,
    bShallowWallLimit: null,
    aQuiescenceDepth: null,
    bQuiescenceDepth: null,
    aVerifyRollouts: null,
    bVerifyRollouts: null,
    aVerifyTop: null,
    bVerifyTop: null,
    aVerifyScale: null,
    bVerifyScale: null,
    aVerifyMaxPlies: null,
    bVerifyMaxPlies: null,
    aVerifyRolloutWallLimit: null,
    bVerifyRolloutWallLimit: null,
    aBookVariant: null,
    bBookVariant: null
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--games") args.games = Number(next), i += 1;
    else if (arg === "--seed") args.seed = Number(next), i += 1;
    else if (arg === "--max-plies") args.maxPlies = Number(next), i += 1;
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--a-strength") args.aStrength = next, i += 1;
    else if (arg === "--b-strength") args.bStrength = next, i += 1;
    else if (arg === "--a-randomness") args.aRandomness = Number(next), i += 1;
    else if (arg === "--b-randomness") args.bRandomness = Number(next), i += 1;
    else if (arg === "--a-time-limit") args.aTimeLimit = Number(next), i += 1;
    else if (arg === "--b-time-limit") args.bTimeLimit = Number(next), i += 1;
    else if (arg === "--a-max-depth") args.aMaxDepth = Number(next), i += 1;
    else if (arg === "--b-max-depth") args.bMaxDepth = Number(next), i += 1;
    else if (arg === "--a-wall-limit") args.aWallLimit = Number(next), i += 1;
    else if (arg === "--b-wall-limit") args.bWallLimit = Number(next), i += 1;
    else if (arg === "--a-reply-wall-limit") args.aReplyWallLimit = Number(next), i += 1;
    else if (arg === "--b-reply-wall-limit") args.bReplyWallLimit = Number(next), i += 1;
    else if (arg === "--a-shallow-wall-limit") args.aShallowWallLimit = Number(next), i += 1;
    else if (arg === "--b-shallow-wall-limit") args.bShallowWallLimit = Number(next), i += 1;
    else if (arg === "--a-quiescence-depth") args.aQuiescenceDepth = Number(next), i += 1;
    else if (arg === "--b-quiescence-depth") args.bQuiescenceDepth = Number(next), i += 1;
    else if (arg === "--a-verify-rollouts") args.aVerifyRollouts = Number(next), i += 1;
    else if (arg === "--b-verify-rollouts") args.bVerifyRollouts = Number(next), i += 1;
    else if (arg === "--a-verify-top") args.aVerifyTop = Number(next), i += 1;
    else if (arg === "--b-verify-top") args.bVerifyTop = Number(next), i += 1;
    else if (arg === "--a-verify-scale") args.aVerifyScale = Number(next), i += 1;
    else if (arg === "--b-verify-scale") args.bVerifyScale = Number(next), i += 1;
    else if (arg === "--a-verify-max-plies") args.aVerifyMaxPlies = Number(next), i += 1;
    else if (arg === "--b-verify-max-plies") args.bVerifyMaxPlies = Number(next), i += 1;
    else if (arg === "--a-verify-rollout-wall-limit") args.aVerifyRolloutWallLimit = Number(next), i += 1;
    else if (arg === "--b-verify-rollout-wall-limit") args.bVerifyRolloutWallLimit = Number(next), i += 1;
    else if (arg === "--a-book-variant") args.aBookVariant = Number(next), i += 1;
    else if (arg === "--b-book-variant") args.bBookVariant = Number(next), i += 1;
    else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/self-play.js [options]

Options:
  --games N
  --seed N
  --max-plies N
  --quiet
  --a-strength fast|balanced|strong
  --b-strength fast|balanced|strong
  --a-randomness X
  --b-randomness X
  --a-time-limit N
  --b-time-limit N
  --a-max-depth N
  --b-max-depth N
  --a-wall-limit N
  --b-wall-limit N
  --a-reply-wall-limit N
  --b-reply-wall-limit N
  --a-shallow-wall-limit N
  --b-shallow-wall-limit N
  --a-quiescence-depth N
  --b-quiescence-depth N
  --a-verify-rollouts N
  --b-verify-rollouts N
  --a-verify-top N
  --b-verify-top N
  --a-verify-scale N
  --b-verify-scale N
  --a-verify-max-plies N
  --b-verify-max-plies N
  --a-verify-rollout-wall-limit N
  --b-verify-rollout-wall-limit N
  --a-book-variant N
  --b-book-variant N
`);
}

function installDeterministicRandom(seed) {
  let value = seed >>> 0;
  Math.random = function random() {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function optionsFor(args, side, rootPlayer) {
  const prefix = side === "A" ? "a" : "b";
  const options = {
    strength: args[prefix + "Strength"],
    randomness: args[prefix + "Randomness"],
    rootPlayer
  };
  const timeLimit = args[prefix + "TimeLimit"];
  const maxDepth = args[prefix + "MaxDepth"];
  const wallLimit = args[prefix + "WallLimit"];
  const replyWallLimit = args[prefix + "ReplyWallLimit"];
  const shallowWallLimit = args[prefix + "ShallowWallLimit"];
  const quiescenceDepth = args[prefix + "QuiescenceDepth"];
  const verifyRollouts = args[prefix + "VerifyRollouts"];
  const verifyTop = args[prefix + "VerifyTop"];
  const verifyScale = args[prefix + "VerifyScale"];
  const verifyMaxPlies = args[prefix + "VerifyMaxPlies"];
  const verifyRolloutWallLimit = args[prefix + "VerifyRolloutWallLimit"];
  const bookVariant = args[prefix + "BookVariant"];
  if (timeLimit !== null) options.timeLimit = timeLimit;
  if (maxDepth !== null) options.maxDepth = maxDepth;
  if (wallLimit !== null) options.wallLimit = wallLimit;
  if (replyWallLimit !== null) options.replyWallLimit = replyWallLimit;
  if (shallowWallLimit !== null) options.shallowWallLimit = shallowWallLimit;
  if (quiescenceDepth !== null) options.quiescenceDepth = quiescenceDepth;
  if (verifyRollouts !== null) options.verifyRollouts = verifyRollouts;
  if (verifyTop !== null) options.verifyTop = verifyTop;
  if (verifyScale !== null) options.verifyScale = verifyScale;
  if (verifyMaxPlies !== null) options.verifyMaxPlies = verifyMaxPlies;
  if (verifyRolloutWallLimit !== null) options.verifyRolloutWallLimit = verifyRolloutWallLimit;
  if (bookVariant !== null) options.bookVariant = bookVariant;
  return options;
}

function playGame(args, gameIndex) {
  let state = Engine.createState(2);
  const aPlayer = gameIndex % 2;
  const bPlayer = 1 - aPlayer;
  const moves = [];
  const history = [Engine.stateHash(state)];
  const stateHistory = [Engine.cloneState(state)];
  let aThinkMs = 0;
  let bThinkMs = 0;
  let aMoveCount = 0;
  let bMoveCount = 0;
  let aDepthTotal = 0;
  let bDepthTotal = 0;
  let aNodesTotal = 0;
  let bNodesTotal = 0;
  const started = Date.now();

  for (let ply = 0; ply < args.maxPlies && state.winner === null; ply += 1) {
    const side = state.turn === aPlayer ? "A" : "B";
    const t0 = Date.now();
    const analyzeOptions = optionsFor(args, side, state.turn);
    analyzeOptions.avoid = recentStates(history);
    analyzeOptions.avoidPawnKeys = recentPawnKeys(stateHistory, state.turn);
    const result = AI.analyze(state, analyzeOptions);
    const elapsed = Date.now() - t0;
    if (side === "A") {
      aThinkMs += elapsed;
      aMoveCount += 1;
      aDepthTotal += result.depth || 0;
      aNodesTotal += result.nodes || 0;
    } else {
      bThinkMs += elapsed;
      bMoveCount += 1;
      bDepthTotal += result.depth || 0;
      bNodesTotal += result.nodes || 0;
    }
    if (!result.chosenMove) break;
    moves.push(side + ":" + Engine.actionToNotation(state, result.chosenMove));
    state = Engine.applyAction(state, result.chosenMove);
    history.push(Engine.stateHash(state));
    stateHistory.push(Engine.cloneState(state));
  }

  const winner = state.winner;
  return {
    game: gameIndex + 1,
    aPlayer,
    bPlayer,
    winner,
    result: winner === aPlayer ? "A" : winner === bPlayer ? "B" : "draw",
    plies: state.moveNumber - 1,
    durationMs: Date.now() - started,
    aThinkMs,
    bThinkMs,
    aMoveCount,
    bMoveCount,
    aDepthTotal,
    bDepthTotal,
    aNodesTotal,
    bNodesTotal,
    moves
  };
}

function recentStates(history) {
  const avoid = new Set();
  const start = Math.max(0, history.length - 12);
  for (let i = start; i < history.length; i += 1) avoid.add(history[i]);
  return avoid;
}

function recentPawnKeys(history, player) {
  const avoid = new Set();
  const start = Math.max(0, history.length - 10);
  for (let i = start; i < history.length; i += 1) {
    const pawn = history[i].pawns[player];
    avoid.add(Engine.key(pawn.r, pawn.c));
  }
  return avoid;
}

function summarize(results) {
  const aWins = results.filter((result) => result.result === "A").length;
  const bWins = results.filter((result) => result.result === "B").length;
  const draws = results.filter((result) => result.result === "draw").length;
  return {
    games: results.length,
    aWins,
    bWins,
    draws,
    aWinRate: results.length ? aWins / results.length : 0,
    aLightWins: results.filter((result) => result.aPlayer === 0 && result.result === "A").length,
    aDarkWins: results.filter((result) => result.aPlayer === 1 && result.result === "A").length,
    avgPlies: average(results.map((result) => result.plies)),
    avgAThinkMs: average(results.map((result) => result.aThinkMs / Math.max(1, result.aMoveCount))),
    avgBThinkMs: average(results.map((result) => result.bThinkMs / Math.max(1, result.bMoveCount))),
    avgADepth: average(results.map((result) => result.aDepthTotal / Math.max(1, result.aMoveCount))),
    avgBDepth: average(results.map((result) => result.bDepthTotal / Math.max(1, result.bMoveCount))),
    avgANodes: average(results.map((result) => result.aNodesTotal / Math.max(1, result.aMoveCount))),
    avgBNodes: average(results.map((result) => result.bNodesTotal / Math.max(1, result.bMoveCount)))
  };
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function main() {
  const args = parseArgs(process.argv);
  installDeterministicRandom(args.seed);
  const results = [];
  console.log(JSON.stringify({ type: "config", args }));
  for (let i = 0; i < args.games; i += 1) {
    const result = playGame(args, i);
    results.push(result);
    if (!args.quiet) {
      console.log(JSON.stringify({
        type: "game",
        game: result.game,
        aPlayer: result.aPlayer,
        result: result.result,
        winner: result.winner,
        plies: result.plies,
        durationMs: result.durationMs,
        moves: result.moves
      }));
    }
  }
  console.log(JSON.stringify({ type: "summary", summary: summarize(results) }));
}

if (require.main === module) main();
