"use strict";

const Engine = require("./engine.js");
const BaseAI = require("./ai.js");

const INF = 1e9;

function analyze(state, options = {}) {
  const rootPlayer = options.rootPlayer === undefined ? state.turn : options.rootPlayer;
  const timeLimit = options.timeLimit || 1200;
  const maxPlies = options.maxPlies || 80;
  const exploration = options.exploration || 1.15;
  const started = Date.now();
  const deadline = started + timeLimit;
  const opening = openingMove(state, rootPlayer);
  if (opening) {
    return {
      bestMove: opening,
      chosenMove: opening,
      candidates: [{ action: opening, visits: 0, score: normalizedScore(BaseAI.evaluate(Engine.applyKnownLegalAction(state, opening), rootPlayer)) }],
      rollouts: 0,
      timeMs: Date.now() - started
    };
  }
  const rootActions = BaseAI.candidateActions(state, state.turn, {
    wallLimit: options.wallLimit || 10
  }).slice(0, options.rootLimit || 18);

  if (!rootActions.length) {
    return { bestMove: null, chosenMove: null, candidates: [], rollouts: 0, timeMs: Date.now() - started };
  }

  const stats = rootActions.map((action) => ({
    action,
    visits: 0,
    total: 0,
    prior: normalizedScore(BaseAI.evaluate(Engine.applyKnownLegalAction(state, action), rootPlayer))
  }));

  let rollouts = 0;
  while (Date.now() < deadline) {
    const selected = select(stats, rollouts + 1, exploration);
    const child = Engine.applyKnownLegalAction(state, selected.action);
    const value = simulate(child, rootPlayer, maxPlies, deadline, options);
    selected.visits += 1;
    selected.total += value;
    rollouts += 1;
  }

  const ranked = stats
    .map((entry) => ({
      action: entry.action,
      visits: entry.visits,
      score: entry.visits > 0 ? entry.total / entry.visits : entry.prior
    }))
    .sort((a, b) => b.score - a.score || b.visits - a.visits);

  return {
    bestMove: ranked[0].action,
    chosenMove: ranked[0].action,
    candidates: ranked.slice(0, 8),
    rollouts,
    timeMs: Date.now() - started
  };
}

function select(stats, totalVisits, exploration) {
  let best = null;
  let bestScore = -INF;
  for (const entry of stats) {
    const exploitation = entry.visits > 0 ? entry.total / entry.visits : entry.prior;
    const explore = entry.visits > 0 ? exploration * Math.sqrt(Math.log(totalVisits + 1) / entry.visits) : INF;
    const score = exploitation + explore;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

function simulate(startState, rootPlayer, maxPlies, deadline, options) {
  let state = startState;
  for (let ply = 0; ply < maxPlies && state.winner === null && Date.now() < deadline; ply += 1) {
    const action = rolloutAction(state, options);
    if (!action) break;
    state = Engine.applyKnownLegalAction(state, action);
  }
  if (state.winner !== null) return state.winner === rootPlayer ? 1 : 0;
  return normalizedScore(BaseAI.evaluate(state, rootPlayer));
}

function rolloutAction(state, options) {
  const player = state.turn;
  const moves = Engine.legalPawnMoves(state, player);
  for (const move of moves) {
    const child = Engine.applyKnownLegalAction(state, move);
    if (child.winner === player) return move;
  }

  if (Math.random() < 0.72) return randomShortestMove(state, player, moves);

  if (state.wallsRemaining[player] > 0) {
    const walls = BaseAI.candidateWalls(state, player, options.rolloutWallLimit || 5);
    if (walls.length > 0) return walls[Math.floor(Math.random() * Math.min(3, walls.length))];
  }

  return moves[Math.floor(Math.random() * moves.length)] || null;
}

function randomShortestMove(state, player, moves) {
  let bestDistance = Infinity;
  const bestMoves = [];
  for (const move of moves) {
    const child = Engine.applyKnownLegalAction(state, move);
    const distance = Engine.shortestPath(child, player).distance;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMoves.length = 0;
      bestMoves.push(move);
    } else if (distance === bestDistance) {
      bestMoves.push(move);
    }
  }
  return bestMoves[Math.floor(Math.random() * bestMoves.length)] || moves[0] || null;
}

function openingMove(state, player) {
  if (state.mode !== 2) return null;
  const pawn = state.pawns[player];
  if (state.moveNumber <= 2) {
    const to = player === 0 ? { r: pawn.r - 1, c: pawn.c } : { r: pawn.r + 1, c: pawn.c };
    const action = { type: "move", player, to };
    return Engine.isLegalAction(state, action, player) ? action : null;
  }

  const opponent = 1 - player;
  const opponentPawn = state.pawns[opponent];
  if (state.moveNumber <= 5 && state.wallsRemaining[player] > 0 && opponentPawn.c === 4) {
    let candidates = null;
    if (opponentPawn.r === 6) {
      candidates = [
        { type: "wall", player, orientation: "h", r: 5, c: 3 },
        { type: "wall", player, orientation: "h", r: 5, c: 4 },
        { type: "wall", player, orientation: "v", r: 4, c: 3 },
        { type: "wall", player, orientation: "v", r: 4, c: 4 }
      ];
    } else if (opponentPawn.r === 2) {
      candidates = [
        { type: "wall", player, orientation: "h", r: 2, c: 3 },
        { type: "wall", player, orientation: "h", r: 2, c: 4 },
        { type: "wall", player, orientation: "v", r: 3, c: 3 },
        { type: "wall", player, orientation: "v", r: 3, c: 4 }
      ];
    }
    if (candidates) {
      for (const action of candidates) {
        if (Engine.legalWall(state, action.orientation, action.r, action.c, player)) return action;
      }
    }
  }

  if (state.moveNumber <= 12 && state.wallsRemaining[player] <= 9 && pawn.c === 4) {
    const to = player === 0 && pawn.r >= 5 ? { r: pawn.r - 1, c: pawn.c } : player === 1 && pawn.r <= 3 ? { r: pawn.r + 1, c: pawn.c } : null;
    if (to) {
      const action = { type: "move", player, to };
      return Engine.isLegalAction(state, action, player) ? action : null;
    }
  }
  return null;
}

function normalizedScore(score) {
  return 1 / (1 + Math.exp(-score / 420));
}

module.exports = { analyze };
