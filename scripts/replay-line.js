"use strict";

const fs = require("fs");
const Engine = require("./engine.js");
const AI = require("./ai.js");

function parseArgs(argv) {
  const args = {
    moves: null,
    file: null,
    game: 1,
    tracePlayer: null,
    traceTop: 5,
    timeLimit: 950,
    maxDepth: 4,
    randomness: 0,
    stopAfter: Infinity
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--moves") args.moves = next, i += 1;
    else if (arg === "--file") args.file = next, i += 1;
    else if (arg === "--game") args.game = Number(next), i += 1;
    else if (arg === "--trace-player") args.tracePlayer = Number(next), i += 1;
    else if (arg === "--trace-top") args.traceTop = Number(next), i += 1;
    else if (arg === "--time-limit") args.timeLimit = Number(next), i += 1;
    else if (arg === "--max-depth") args.maxDepth = Number(next), i += 1;
    else if (arg === "--randomness") args.randomness = Number(next), i += 1;
    else if (arg === "--stop-after") args.stopAfter = Number(next), i += 1;
    else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }

  if (!args.moves && !args.file) throw new Error("Provide --moves or --file.");
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/replay-line.js --moves LIST [options]

Options:
  --file PATH          Read moves from a JSONL benchmark log
  --game N            Game number when using --file, default 1
  --trace-player N    Only trace one player, default all players
  --trace-top N       Candidate count, default 5
  --time-limit N      Analysis time limit in ms, default 950
  --max-depth N       Max search depth, default 4
  --randomness X      AI randomness, default 0
  --stop-after N      Stop after N plies
`);
}

function movesFromFile(file, gameNumber) {
  const lines = fs.readFileSync(file, "utf8").split(/\n+/).filter(Boolean);
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record.type !== "seed" || !record.games) continue;
    const game = record.games.find((item) => item.game === gameNumber);
    if (game) return game.moves.join(" ");
  }
  throw new Error("No recorded game " + gameNumber + " in " + file);
}

function parseMove(text, player) {
  const move = text.replace(/^[A-Z]:/, "");
  const kind = move[0];
  if (kind === "H" || kind === "V") {
    const square = move.slice(1);
    return {
      type: "wall",
      player,
      orientation: kind === "H" ? "h" : "v",
      r: Engine.WALL_SIZE - Number(square.slice(1)),
      c: square.charCodeAt(0) - 97
    };
  }
  return {
    type: "move",
    player,
    to: {
      r: Engine.SIZE - Number(move.slice(1)),
      c: move.charCodeAt(0) - 97
    }
  };
}

function actionText(action) {
  if (!action) return "null";
  if (action.type === "move") return Engine.squareName(action.to.r, action.to.c);
  return (action.orientation === "h" ? "H" : "V") + Engine.wallName(action.r, action.c);
}

function recentStateHashes(history) {
  const avoid = new Set();
  for (let i = Math.max(0, history.length - 12); i < history.length; i += 1) {
    avoid.add(Engine.stateHash(history[i]));
  }
  return avoid;
}

function recentPawnKeys(history, player) {
  const avoid = new Set();
  for (let i = Math.max(0, history.length - 10); i < history.length; i += 1) {
    const pawn = history[i].pawns[player];
    avoid.add(Engine.key(pawn.r, pawn.c));
  }
  return avoid;
}

function main() {
  const args = parseArgs(process.argv);
  const moveText = args.moves || movesFromFile(args.file, args.game);
  const moves = moveText.trim().split(/\s+/).filter(Boolean);
  let state = Engine.createState(2);
  const history = [state];

  for (let ply = 0; ply < moves.length && ply < args.stopAfter && state.winner === null; ply += 1) {
    const player = state.turn;
    const actual = parseMove(moves[ply], player);
    if (args.tracePlayer === null || args.tracePlayer === player) {
      const result = AI.analyze(state, {
        strength: "strong",
        rootPlayer: player,
        randomness: args.randomness,
        timeLimit: args.timeLimit,
        maxDepth: args.maxDepth,
        avoid: recentStateHashes(history),
        avoidPawnKeys: recentPawnKeys(history, player)
      });
      console.log(JSON.stringify({
        ply: ply + 1,
        player,
        actual: actionText(actual),
        best: actionText(result.bestMove),
        depth: result.depth,
        nodes: result.nodes,
        timeMs: result.timeMs,
        pawns: state.pawns.map((pawn) => Engine.squareName(pawn.r, pawn.c)),
        wallsRemaining: state.wallsRemaining,
        distances: Engine.allShortestPaths(state).map((path) => path.distance),
        candidates: result.candidates.slice(0, args.traceTop).map((entry) => ({
          move: actionText(entry.action),
          score: Math.round(entry.score)
        }))
      }));
    }
    if (!Engine.isLegalAction(state, actual, player)) {
      throw new Error("Illegal replay action on ply " + (ply + 1) + ": " + moves[ply]);
    }
    state = Engine.applyKnownLegalAction(state, actual);
    history.push(state);
  }
}

main();
