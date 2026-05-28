"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Engine = require("./engine.js");
const OurAI = require("./ai.js");
const ExperimentalMcts = require("./experimental-mcts.js");

function parseArgs(argv) {
  const args = {
    gorisansonDir: process.env.GORISANSON_DIR || "/tmp/gorisanson-quoridor-ai/quoridor-ai-main",
    games: 4,
    rollouts: 2500,
    uct: 0.2,
    ourStrength: "strong",
    ourRandomness: 0.08,
    maxPlies: 220,
    seed: 1,
    strategy: "alphabeta",
    bookVariant: null,
    ourTimeLimit: null,
    ourMaxDepth: null,
    ourWallLimit: null
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--gorisanson-dir") args.gorisansonDir = next, i += 1;
    else if (arg === "--games") args.games = Number(next), i += 1;
    else if (arg === "--rollouts") args.rollouts = Number(next), i += 1;
    else if (arg === "--uct") args.uct = Number(next), i += 1;
    else if (arg === "--our-strength") args.ourStrength = next, i += 1;
    else if (arg === "--our-randomness") args.ourRandomness = Number(next), i += 1;
    else if (arg === "--max-plies") args.maxPlies = Number(next), i += 1;
    else if (arg === "--seed") args.seed = Number(next), i += 1;
    else if (arg === "--strategy") args.strategy = next, i += 1;
    else if (arg === "--book-variant") args.bookVariant = Number(next), i += 1;
    else if (arg === "--our-time-limit") args.ourTimeLimit = Number(next), i += 1;
    else if (arg === "--our-max-depth") args.ourMaxDepth = Number(next), i += 1;
    else if (arg === "--our-wall-limit") args.ourWallLimit = Number(next), i += 1;
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
  console.log(`Usage: node scripts/benchmark-gorisanson.js [options]

Options:
  --gorisanson-dir PATH   Path to gorisanson/quoridor-ai checkout
  --games N              Number of games, alternating colors
  --rollouts N           gorisanson MCTS rollouts per move
  --uct X                gorisanson UCT constant
  --our-strength NAME    fast | balanced | strong
  --our-randomness X     0..1
  --max-plies N          Abort a game after N plies
  --seed N               Deterministic Math.random seed
  --strategy NAME        alphabeta | mcts
  --book-variant N       Force opening-book candidate index
  --our-time-limit N     Override our AI time limit in ms
  --our-max-depth N      Override our AI max depth
  --our-wall-limit N     Override our AI wall candidate limit
`);
}

function installDeterministicRandom(seed) {
  let value = seed >>> 0;
  Math.random = function random() {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function loadGorisanson(dir) {
  const gamePath = path.join(dir, "src/js/game.js");
  const aiPath = path.join(dir, "src/js/ai.js");
  if (!fs.existsSync(gamePath) || !fs.existsSync(aiPath)) {
    throw new Error("Could not find gorisanson src/js/game.js and src/js/ai.js under " + dir);
  }
  vm.runInThisContext(fs.readFileSync(gamePath, "utf8"), { filename: gamePath });
  vm.runInThisContext(fs.readFileSync(aiPath, "utf8"), { filename: aiPath });
  return { Game, AI };
}

function ourStateFromGorisanson(game) {
  const state = Engine.createState(2);
  state.turn = game.turn % 2;
  state.moveNumber = game.turn + 1;
  state.winner = game.winner ? game.winner.index : null;
  state.pawns = game.board.pawns.map((pawn) => ({ r: pawn.position.row, c: pawn.position.col }));
  state.wallsRemaining = game.board.pawns.map((pawn) => pawn.numberOfLeftWalls);
  state.hWalls = new Set();
  state.vWalls = new Set();

  for (let r = 0; r < Engine.WALL_SIZE; r += 1) {
    for (let c = 0; c < Engine.WALL_SIZE; c += 1) {
      if (game.board.walls.horizontal[r][c]) state.hWalls.add(Engine.key(r, c));
      if (game.board.walls.vertical[r][c]) state.vWalls.add(Engine.key(r, c));
    }
  }
  return state;
}

function ourActionToGorisansonMove(action) {
  if (action.type === "move") return [[action.to.r, action.to.c], null, null];
  if (action.orientation === "h") return [null, [action.r, action.c], null];
  return [null, null, [action.r, action.c]];
}

function moveToText(move) {
  if (move[0]) return Engine.squareName(move[0][0], move[0][1]);
  if (move[1]) return "H" + Engine.wallName(move[1][0], move[1][1]);
  return "V" + Engine.wallName(move[2][0], move[2][1]);
}

function playGame(GameClass, GorisansonAI, opts, gameIndex) {
  const game = new GameClass(true);
  const ourPlayer = gameIndex % 2;
  const gorisansonPlayer = 1 - ourPlayer;
  const gorisanson = new GorisansonAI(opts.rollouts, opts.uct, false, false);
  const moves = [];
  const started = Date.now();
  let ourThinkMs = 0;
  let gorisansonThinkMs = 0;
  const stateHistory = [ourStateFromGorisanson(game)];

  for (let ply = 0; ply < opts.maxPlies && game.winner === null; ply += 1) {
    const player = game.turn % 2;
    let move;
    if (player === ourPlayer) {
      const state = ourStateFromGorisanson(game);
      const t0 = Date.now();
      const analyzeOptions = {
        strength: opts.ourStrength,
        randomness: opts.ourRandomness,
        rootPlayer: state.turn
      };
      if (opts.bookVariant !== null) analyzeOptions.bookVariant = opts.bookVariant;
      if (opts.ourTimeLimit !== null) analyzeOptions.timeLimit = opts.ourTimeLimit;
      if (opts.ourMaxDepth !== null) analyzeOptions.maxDepth = opts.ourMaxDepth;
      if (opts.ourWallLimit !== null) analyzeOptions.wallLimit = opts.ourWallLimit;
      analyzeOptions.avoid = recentStateHashes(stateHistory);
      analyzeOptions.avoidPawnKeys = recentPawnKeys(stateHistory, state.turn);
      const engine = opts.strategy === "mcts" ? ExperimentalMcts : OurAI;
      const result = engine.analyze(state, analyzeOptions);
      ourThinkMs += Date.now() - t0;
      if (!result.chosenMove) throw new Error("Our AI returned no move");
      move = ourActionToGorisansonMove(result.chosenMove);
    } else {
      const t0 = Date.now();
      move = silenceConsole(() => gorisanson.chooseNextMove(game));
      gorisansonThinkMs += Date.now() - t0;
    }

    if (!game.doMove(move, true)) {
      throw new Error("Illegal move from " + (player === ourPlayer ? "ours" : "gorisanson") + ": " + JSON.stringify(move));
    }
    moves.push((player === ourPlayer ? "O:" : "G:") + moveToText(move));
    stateHistory.push(ourStateFromGorisanson(game));
  }

  const winner = game.winner ? game.winner.index : null;
  return {
    game: gameIndex + 1,
    ourPlayer,
    gorisansonPlayer,
    winner,
    result: winner === ourPlayer ? "win" : winner === gorisansonPlayer ? "loss" : "draw",
    plies: game.turn,
    durationMs: Date.now() - started,
    ourThinkMs,
    gorisansonThinkMs,
    moves
  };
}

function recentStateHashes(history) {
  const avoid = new Set();
  const start = Math.max(0, history.length - 12);
  for (let i = start; i < history.length; i += 1) avoid.add(Engine.stateHash(history[i]));
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
  const wins = results.filter((result) => result.result === "win").length;
  const losses = results.filter((result) => result.result === "loss").length;
  const draws = results.filter((result) => result.result === "draw").length;
  const lightWins = results.filter((result) => result.ourPlayer === 0 && result.result === "win").length;
  const darkWins = results.filter((result) => result.ourPlayer === 1 && result.result === "win").length;
  return {
    games: results.length,
    wins,
    losses,
    draws,
    winRate: results.length ? wins / results.length : 0,
    lightWins,
    darkWins,
    avgPlies: average(results.map((result) => result.plies)),
    avgOurThinkMs: average(results.map((result) => result.ourThinkMs / Math.max(1, Math.ceil(result.plies / 2)))),
    avgGorisansonThinkMs: average(results.map((result) => result.gorisansonThinkMs / Math.max(1, Math.floor(result.plies / 2))))
  };
}

function silenceConsole(fn) {
  const originalLog = console.log;
  try {
    console.log = function noop() {};
    return fn();
  } finally {
    console.log = originalLog;
  }
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function main() {
  const opts = parseArgs(process.argv);
  installDeterministicRandom(opts.seed);
  const { Game: GameClass, AI: GorisansonAI } = loadGorisanson(opts.gorisansonDir);
  const results = [];

  console.log(JSON.stringify({ type: "config", opts }));
  for (let i = 0; i < opts.games; i += 1) {
    const result = playGame(GameClass, GorisansonAI, opts, i);
    results.push(result);
    console.log(JSON.stringify({
      type: "game",
      game: result.game,
      ourPlayer: result.ourPlayer,
      result: result.result,
      winner: result.winner,
      plies: result.plies,
      durationMs: result.durationMs,
      moves: result.moves
    }));
  }
  console.log(JSON.stringify({ type: "summary", summary: summarize(results) }));
}

if (require.main === module) main();
