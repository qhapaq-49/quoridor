(function (root) {
  "use strict";

  const Engine = typeof require === "function" ? require("./engine.js") : root.QuoridorEngine;
  const INF = 1e9;
  const TACTICAL_WALL_PRIOR = 220;

  const PRESETS = {
    fast: { timeLimit: 450, maxDepth: 2, wallLimit: 6 },
    balanced: { timeLimit: 800, maxDepth: 3, wallLimit: 6 },
    strong: { timeLimit: 1600, maxDepth: 4, wallLimit: 6 }
  };

  function now() {
    if (root.performance && typeof root.performance.now === "function") return root.performance.now();
    return Date.now();
  }

  function analyze(state, options) {
    const opts = Object.assign({}, PRESETS.balanced, options || {});
    const preset = PRESETS[opts.strength] || {};
    Object.assign(opts, preset, options || {});
    if (state.mode === 4) {
      opts.timeLimit = Math.min(opts.timeLimit, 700);
      opts.maxDepth = Math.min(opts.maxDepth, 2);
      opts.wallLimit = Math.min(opts.wallLimit, 4);
    }
    const started = now();
    const deadline = started + opts.timeLimit;
    const rootPlayer = opts.rootPlayer === undefined ? state.turn : opts.rootPlayer;
    const randomAmount = Math.max(0, Math.min(1, opts.randomness === undefined ? 0.16 : opts.randomness));
    const table = new Map();
    let completedDepth = 0;
    let nodes = 0;

    const bookMove = chooseOpeningBookMove(state, rootPlayer, opts.bookVariant, randomAmount) || chooseOpeningFollowupMove(state, rootPlayer);
    if (bookMove) {
      return {
        bestMove: bookMove,
        chosenMove: bookMove,
        candidates: [{ action: bookMove, score: evaluate(Engine.applyKnownLegalAction(state, bookMove), rootPlayer), rank: 1 }],
        depth: 0,
        nodes: 0,
        timeMs: Math.round(now() - started)
      };
    }

    let rootActions = candidateActions(state, state.turn, opts);
    if (rootActions.length === 0) {
      return {
        bestMove: null,
        chosenMove: null,
        candidates: [],
        depth: 0,
        nodes: 0,
        timeMs: Math.round(now() - started)
      };
    }

    let ranked = rootActions.map((action) => {
      const child = Engine.applyKnownLegalAction(state, action);
      return {
        action,
        score: evaluate(child, rootPlayer) - repetitionPenalty(child, rootPlayer, action, opts),
        prior: action.prior || 0
      };
    });
    ranked.sort((a, b) => b.score - a.score || b.prior - a.prior);

    for (let depth = 1; depth <= opts.maxDepth; depth += 1) {
      if (now() > deadline) break;
      const depthResults = [];
      let depthComplete = true;

      for (const entry of ranked) {
        if (now() > deadline) {
          depthComplete = false;
          break;
        }
        const child = Engine.applyKnownLegalAction(state, entry.action);
        let score;
        try {
          score = search(child, depth - 1, rootPlayer, -INF, INF, deadline, opts, table, () => {
            nodes += 1;
          });
          score -= repetitionPenalty(child, rootPlayer, entry.action, opts);
        } catch (err) {
          if (err && err.timeout) {
            depthComplete = false;
            break;
          }
          throw err;
        }
        depthResults.push({ action: entry.action, score, prior: entry.prior });
      }

      if (!depthComplete || depthResults.length === 0) break;
      ranked = depthResults.sort((a, b) => b.score - a.score || b.prior - a.prior);
      completedDepth = depth;
    }

    ranked = ranked.map((entry, index) => ({
      action: entry.action,
      score: entry.score,
      rank: index + 1
    }));

    if ((opts.verifyRollouts || 0) > 0 && ranked.length > 1 && now() < deadline) {
      ranked = verifyRankedWithRollouts(state, ranked, rootPlayer, opts, deadline);
    }

    const chosen = chooseWithRandomness(ranked, randomAmount);
    return {
      bestMove: ranked[0] ? ranked[0].action : null,
      chosenMove: chosen ? chosen.action : ranked[0].action,
      candidates: ranked.slice(0, 8),
      depth: completedDepth,
      nodes,
      timeMs: Math.round(now() - started)
    };
  }

  function search(state, depth, rootPlayer, alpha, beta, deadline, opts, table, bumpNode) {
    if (now() > deadline) {
      const err = new Error("Search timeout");
      err.timeout = true;
      throw err;
    }
    bumpNode();

    if (state.winner !== null) return evaluate(state, rootPlayer);
    if (depth <= 0) return quiescence(state, rootPlayer, alpha, beta, deadline, opts, bumpNode, opts.quiescenceDepth === undefined ? 1 : opts.quiescenceDepth);

    const hash = Engine.stateHash(state) + ":" + depth + ":" + rootPlayer;
    const cached = table.get(hash);
    if (cached !== undefined) return cached;

    const maximizing = state.turn === rootPlayer;
    let actions = candidateActions(state, state.turn, searchOptionsForDepth(opts, depth));
    if (actions.length === 0) return evaluate(state, rootPlayer);

    actions = orderActionsForRoot(state, actions, rootPlayer, maximizing, depth);

    let value = maximizing ? -INF : INF;
    let exact = true;
    for (const action of actions) {
      const child = Engine.applyKnownLegalAction(state, action);
      const score = search(child, depth - 1, rootPlayer, alpha, beta, deadline, opts, table, bumpNode);
      if (maximizing) {
        value = Math.max(value, score);
        alpha = Math.max(alpha, value);
      } else {
        value = Math.min(value, score);
        beta = Math.min(beta, value);
      }
      if (alpha >= beta) {
        exact = false;
        break;
      }
    }

    if (exact) table.set(hash, value);
    return value;
  }

  function quiescence(state, rootPlayer, alpha, beta, deadline, opts, bumpNode, depth) {
    if (now() > deadline) {
      const err = new Error("Search timeout");
      err.timeout = true;
      throw err;
    }
    bumpNode();

    const standPat = evaluate(state, rootPlayer);
    if (depth <= 0 || Math.abs(standPat) >= 90000) return standPat;

    const actions = forcingActions(state, state.turn, opts);
    if (actions.length === 0) return standPat;

    const maximizing = state.turn === rootPlayer;
    let value = maximizing ? -INF : INF;
    for (const action of actions) {
      const child = Engine.applyKnownLegalAction(state, action);
      const score = quiescence(child, rootPlayer, alpha, beta, deadline, opts, bumpNode, depth - 1);
      if (maximizing) {
        value = Math.max(value, score);
        alpha = Math.max(alpha, value);
      } else {
        value = Math.min(value, score);
        beta = Math.min(beta, value);
      }
      if (alpha >= beta) break;
    }
    return value;
  }

  function forcingActions(state, player, opts) {
    const winningMoves = Engine.legalPawnMoves(state, player).filter((move) => isGoalByName(Engine.seatsForMode(state.mode)[player].goal, move.to.r, move.to.c));
    if (winningMoves.length > 0) return winningMoves;

    const threats = immediateGoalThreatPlayers(state, player);
    if (state.wallsRemaining[player] <= 0) return [];

    if (threats.length === 0) return tacticalWallActions(state, player, 3);

    const walls = candidateWalls(state, player, Math.max(opts.wallLimit || 6, 8));
    return walls.filter((wall) => {
      const child = Engine.applyKnownLegalAction(state, wall);
      return threats.every((threatPlayer) => !hasImmediateGoalMove(child, threatPlayer));
    });
  }

  function tacticalWallActions(state, player, limit) {
    if (state.mode !== 2 || state.wallsRemaining[player] <= 0) return [];
    const target = 1 - player;
    const beforeTarget = shortestGoalDistance(state, target);
    if (beforeTarget === Infinity) return [];

    const candidates = new Map();
    const path = shortestPathEdgeInfo(state, target);
    function add(orientation, r, c, reason) {
      if (!Engine.inWallBoard(r, c)) return;
      const id = orientation + ":" + r + "," + c;
      const existing = candidates.get(id);
      if (existing) {
        existing.reason += reason;
        return;
      }
      candidates.set(id, { type: "wall", player, orientation, r, c, reason });
    }
    for (const edge of path.edges) addWallsBlockingEdge(edge.from, edge.to, 1, add);

    const scored = [];
    const preliminary = Array.from(candidates.values()).sort((a, b) => b.reason - a.reason).slice(0, 12);
    for (const wall of preliminary) {
      if (Engine.wallCollision(state, wall.orientation, wall.r, wall.c)) continue;
      let targetAfter = Infinity;
      let selfAfter = Infinity;
      withTemporaryWall(state, wall, () => {
        targetAfter = shortestGoalDistance(state, target);
        selfAfter = shortestGoalDistance(state, player);
      });
      if (targetAfter === Infinity || selfAfter === Infinity) continue;
      const delta = targetAfter - beforeTarget;
      const prior = delta * 100 + wall.reason;
      if (prior < TACTICAL_WALL_PRIOR) continue;
      wall.prior = prior;
      scored.push(wall);
    }

    return scored.sort((a, b) => b.prior - a.prior).slice(0, limit);
  }

  function immediateGoalThreatPlayers(state, player) {
    const threats = [];
    const count = Engine.playerCount(state);
    for (let i = 0; i < count; i += 1) {
      if (i !== player && hasImmediateGoalMove(state, i)) threats.push(i);
    }
    return threats;
  }

  function hasImmediateGoalMove(state, player) {
    const goal = Engine.seatsForMode(state.mode)[player].goal;
    return Engine.legalPawnMoves(state, player).some((move) => isGoalByName(goal, move.to.r, move.to.c));
  }

  function searchOptionsForDepth(opts, depth) {
    const copy = Object.create(opts);
    const rootLimit = opts.wallLimit || 6;
    const replyLimit = opts.replyWallLimit || rootLimit;
    const shallowLimit = opts.shallowWallLimit || rootLimit;
    copy.wallLimit = Math.min(rootLimit, depth <= 1 ? shallowLimit : replyLimit);
    return copy;
  }

  function orderActionsForRoot(state, actions, rootPlayer, maximizing, depth) {
    void depth;
    return actions
      .map((action) => ({
        action,
        score: evaluate(Engine.applyKnownLegalAction(state, action), rootPlayer),
        prior: action.prior || 0
      }))
      .sort((a, b) => {
        if (maximizing) return b.score - a.score || b.prior - a.prior;
        return a.score - b.score || b.prior - a.prior;
      })
      .map((entry) => entry.action);
  }

  function chooseWithRandomness(ranked, randomAmount) {
    if (!ranked.length) return null;
    if (randomAmount <= 0.005) return ranked[0];

    const best = ranked[0].score;
    const margin = 35 + randomAmount * 180;
    const pool = ranked.slice(0, 5).filter((entry) => best - entry.score <= margin);
    if (pool.length <= 1) return ranked[0];

    const temperature = 18 + randomAmount * 150;
    const weights = pool.map((entry) => Math.exp((entry.score - best) / temperature));
    const total = weights.reduce((sum, value) => sum + value, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < pool.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  function verifyRankedWithRollouts(state, ranked, rootPlayer, opts, deadline) {
    const top = Math.min(opts.verifyTop || 3, ranked.length);
    const perAction = Math.max(1, Math.floor(opts.verifyRollouts || 0));
    const scale = opts.verifyScale || 360;
    const maxPlies = opts.verifyMaxPlies || 70;
    const rolloutWallLimit = opts.verifyRolloutWallLimit || 4;

    const verified = ranked.map((entry, index) => {
      if (index >= top || now() >= deadline) return entry;
      const child = Engine.applyKnownLegalAction(state, entry.action);
      let total = 0;
      let count = 0;
      for (let i = 0; i < perAction && now() < deadline; i += 1) {
        total += rolloutValue(child, rootPlayer, maxPlies, rolloutWallLimit, deadline);
        count += 1;
      }
      if (count === 0) return entry;
      const average = total / count;
      return Object.assign({}, entry, { score: entry.score + (average - 0.5) * scale, verify: average, verifyCount: count });
    });

    return verified
      .sort((a, b) => b.score - a.score)
      .map((entry, index) => Object.assign({}, entry, { rank: index + 1 }));
  }

  function rolloutValue(startState, rootPlayer, maxPlies, wallLimit, deadline) {
    let state = startState;
    for (let ply = 0; ply < maxPlies && state.winner === null && now() < deadline; ply += 1) {
      const action = rolloutAction(state, wallLimit);
      if (!action) break;
      state = Engine.applyKnownLegalAction(state, action);
    }
    if (state.winner !== null) return state.winner === rootPlayer ? 1 : 0;
    return normalizedScore(evaluate(state, rootPlayer));
  }

  function rolloutAction(state, wallLimit) {
    const player = state.turn;
    const moves = Engine.legalPawnMoves(state, player);
    for (const move of moves) {
      const child = Engine.applyKnownLegalAction(state, move);
      if (child.winner === player) return move;
    }

    if (Math.random() < 0.72) return randomShortestMove(state, player, moves);

    if (state.wallsRemaining[player] > 0) {
      const walls = candidateWalls(state, player, wallLimit);
      if (walls.length > 0) return walls[Math.floor(Math.random() * Math.min(3, walls.length))];
    }

    return moves[Math.floor(Math.random() * moves.length)] || null;
  }

  function randomShortestMove(state, player, moves) {
    let bestDistance = Infinity;
    const bestMoves = [];
    for (const move of moves) {
      const child = Engine.applyKnownLegalAction(state, move);
      const distance = shortestGoalDistance(child, player);
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

  function normalizedScore(score) {
    return 1 / (1 + Math.exp(-score / 420));
  }

  function repetitionPenalty(state, player, action, opts) {
    let penalty = 0;
    if (opts.avoid && opts.avoid.has(Engine.stateHash(state))) penalty += 300;
    if (action.type === "move" && opts.avoidPawnKeys) {
      const pawn = state.pawns[player];
      if (opts.avoidPawnKeys.has(Engine.key(pawn.r, pawn.c))) penalty += 35;
    }
    return penalty;
  }

  function evaluate(state, rootPlayer) {
    if (state.winner !== null) return state.winner === rootPlayer ? 100000 : -100000;

    const immediateWinner = immediateWinningPlayer(state);
    if (immediateWinner !== null) return immediateWinner === rootPlayer ? 96000 : -96000;

    const count = Engine.playerCount(state);
    const rootDistance = safeDistance(shortestGoalDistance(state, rootPlayer));
    const rootRacePlies = racePliesToGoal(state, rootPlayer, rootDistance);
    let nearestOpponent = 99;
    let nearestOpponentRacePlies = 999;
    let sumOpponentDistance = 0;
    let opponentWalls = 0;
    let opponentProgress = 0;
    let opponentMobility = 0;

    for (let i = 0; i < count; i += 1) {
      if (i === rootPlayer) continue;
      const distance = safeDistance(shortestGoalDistance(state, i));
      nearestOpponent = Math.min(nearestOpponent, distance);
      nearestOpponentRacePlies = Math.min(nearestOpponentRacePlies, racePliesToGoal(state, i, distance));
      sumOpponentDistance += distance;
      opponentWalls += state.wallsRemaining[i];
      opponentProgress = Math.max(opponentProgress, Engine.goalDistanceProgress(state, i));
      opponentMobility += Engine.legalPawnMoves(state, i).length;
    }

    const opponentCount = count - 1;
    const averageOpponentDistance = sumOpponentDistance / opponentCount;
    const averageOpponentWalls = opponentWalls / opponentCount;
    const raceDelta = nearestOpponentRacePlies - rootRacePlies;
    const wallPressureBalance = state.wallsRemaining[rootPlayer] * nearestOpponentRacePlies - averageOpponentWalls * rootRacePlies;
    const rootProgress = Engine.goalDistanceProgress(state, rootPlayer);
    const rootMobility = Engine.legalPawnMoves(state, rootPlayer).length;

    let score = 0;
    score += (nearestOpponent - rootDistance) * 132;
    score += (averageOpponentDistance - rootDistance) * 42;
    score += raceDelta * (count === 2 ? 24 : 12);
    score += wallPressureBalance * (count === 2 ? 5 : 2);
    if (raceDelta > 0) score -= rootRacePlies * (count === 2 ? 10 : 4);
    score += (state.wallsRemaining[rootPlayer] - averageOpponentWalls) * 13;
    score += (rootProgress - opponentProgress) * 8;
    score += (rootMobility - opponentMobility / opponentCount) * 4;

    if (rootDistance <= 1) score += 720;
    if (nearestOpponent <= 1) score -= 880;
    if (rootDistance <= 2 && state.wallsRemaining[rootPlayer] === 0) score += 120;
    if (nearestOpponent <= 2 && state.wallsRemaining[rootPlayer] > 0) score -= 120;

    if (count === 2 && state.wallsRemaining[rootPlayer] === 0 && averageOpponentWalls === 0) {
      score += raceDelta * 180;
      if (raceDelta > 0) score += 650;
      else if (raceDelta < 0) score -= 650;
    }

    if (state.wallsRemaining[rootPlayer] === 0 && nearestOpponentRacePlies <= rootRacePlies) score -= 180;
    if (averageOpponentWalls === 0 && rootRacePlies < nearestOpponentRacePlies) score += 150;

    return score;
  }

  function safeDistance(distance) {
    return distance === Infinity ? 99 : distance;
  }

  function immediateWinningPlayer(state) {
    return hasImmediateGoalMove(state, state.turn) ? state.turn : null;
  }

  function racePliesToGoal(state, player, distance) {
    if (distance <= 0) return 0;
    const count = Engine.playerCount(state);
    const turnOffset = (player - state.turn + count) % count;
    return turnOffset + (distance - 1) * count + 1;
  }

  function chooseOpeningBookMove(state, player, variant, randomAmount) {
    if (state.mode !== 2 || state.moveNumber > 5 || state.wallsRemaining[player] <= 0) return null;
    const opponent = 1 - player;
    const pawn = state.pawns[opponent];
    if (pawn.c !== 4) return null;

    const candidates = openingWallCandidates(pawn.r, player);
    if (!candidates) return null;
    const legalCandidates = candidates.filter((action) => Engine.legalWall(state, action.orientation, action.r, action.c, player));
    if (variant !== undefined && variant !== null && Number.isFinite(Number(variant))) {
      const preferred = candidates[((Number(variant) % candidates.length) + candidates.length) % candidates.length];
      if (Engine.legalWall(state, preferred.orientation, preferred.r, preferred.c, player)) return preferred;
    }
    if (legalCandidates.length > 0 && randomAmount > 0.005 && Math.random() < Math.min(0.5, randomAmount * 2.5)) {
      return legalCandidates[Math.floor(Math.random() * legalCandidates.length)];
    }
    let best = null;
    let bestScore = -INF;
    for (const action of candidates) {
      if (!Engine.legalWall(state, action.orientation, action.r, action.c, player)) continue;
      const score = evaluate(Engine.applyKnownLegalAction(state, action), player);
      if (score > bestScore) {
        best = action;
        bestScore = score;
      }
    }
    return best;
  }

  function openingWallCandidates(targetRow, player) {
    if (targetRow === 6) {
      return [
        { type: "wall", player, orientation: "h", r: 5, c: 3 },
        { type: "wall", player, orientation: "h", r: 5, c: 4 },
        { type: "wall", player, orientation: "v", r: 4, c: 3 },
        { type: "wall", player, orientation: "v", r: 4, c: 4 }
      ];
    }
    if (targetRow === 2) {
      return [
        { type: "wall", player, orientation: "h", r: 2, c: 3 },
        { type: "wall", player, orientation: "h", r: 2, c: 4 },
        { type: "wall", player, orientation: "v", r: 3, c: 3 },
        { type: "wall", player, orientation: "v", r: 3, c: 4 }
      ];
    }
    return null;
  }

  function chooseOpeningFollowupMove(state, player) {
    if (state.mode !== 2 || state.moveNumber > 12) return null;
    if (state.wallsRemaining[player] > 9) return null;
    const pawn = state.pawns[player];
    if (pawn.c !== 4) return null;

    let to = null;
    if (player === 0 && pawn.r >= 5) to = { r: pawn.r - 1, c: pawn.c };
    if (player === 1 && pawn.r <= 3) to = { r: pawn.r + 1, c: pawn.c };
    if (!to) return null;

    const action = { type: "move", player, to };
    if (!Engine.isLegalAction(state, action, player)) return null;
    return action;
  }

  function candidateActions(state, player, options) {
    const opts = options || {};
    const moves = Engine.legalPawnMoves(state, player).map((move) => {
      move.prior = movePrior(state, move, player);
      return move;
    });

    let walls = [];
    if (state.wallsRemaining[player] > 0) {
      walls = candidateWalls(state, player, opts.wallLimit || 14).map((wall) => {
        wall.prior = wall.prior || 0;
        return wall;
      });
    }

    return moves.concat(walls).sort((a, b) => (b.prior || 0) - (a.prior || 0));
  }

  function movePrior(state, move, player) {
    const before = shortestGoalDistance(state, player);
    const child = Engine.applyKnownLegalAction(state, move);
    const after = shortestGoalDistance(child, player);
    let prior = (safeDistance(before) - safeDistance(after)) * 70;
    if (after <= 1) prior += 500;
    if (move.jump) prior += 18;
    return prior;
  }

  function candidateWalls(state, player, limit) {
    const candidates = new Map();
    const count = Engine.playerCount(state);
    const paths = [];
    const pathWidths = Array(count).fill(0);

    function add(orientation, r, c, reason) {
      if (!Engine.inWallBoard(r, c)) return;
      const id = orientation + ":" + r + "," + c;
      const existing = candidates.get(id);
      if (existing) {
        existing.reason += reason;
        return;
      }
      candidates.set(id, { type: "wall", player, orientation, r, c, reason });
    }

    for (let p = 0; p < count; p += 1) {
      const path = shortestPathEdgeInfo(state, p);
      paths.push(path);
      pathWidths[p] = path.edges.length;
      for (const edge of path.edges) {
        addWallsBlockingEdge(edge.from, edge.to, (p === player ? 1 : 9), add);
      }
    }

    for (const pawn of state.pawns) {
      for (let r = pawn.r - 2; r <= pawn.r + 1; r += 1) {
        for (let c = pawn.c - 2; c <= pawn.c + 1; c += 1) {
          add("h", r, c, 1);
          add("v", r, c, 1);
        }
      }
    }

    for (const item of state.hWalls) {
      const wall = Engine.parseKey(item);
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) add("h", wall.r + dr, wall.c + dc, 3);
      }
    }
    for (const item of state.vWalls) {
      const wall = Engine.parseKey(item);
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) add("v", wall.r + dr, wall.c + dc, 3);
      }
    }

    const scored = [];
    const preliminary = Array.from(candidates.values())
      .sort((a, b) => b.reason - a.reason)
      .slice(0, Math.max(limit * 4, 24));
    for (const wall of preliminary) {
      if (Engine.wallCollision(state, wall.orientation, wall.r, wall.c)) continue;

      const afterPaths = [];
      const afterWidths = [];
      let reachable = true;
      withTemporaryWall(state, wall, () => {
        for (let p = 0; p < count; p += 1) {
          const path = shortestPathEdgeInfo(state, p);
          if (path.distance === Infinity) {
            reachable = false;
            break;
          }
          afterPaths.push(path);
          afterWidths.push(path.edges.length);
        }
      });
      if (!reachable) continue;
      const score = wallDeltaScoreFromPaths(state, wall, player, paths, afterPaths, pathWidths, afterWidths) + wall.reason;
      scored.push(Object.assign(wall, { prior: score }));
    }

    scored.sort((a, b) => b.prior - a.prior);
    return scored.slice(0, limit);
  }

  function withTemporaryWall(state, wall, fn) {
    const set = wall.orientation === "h" ? state.hWalls : state.vWalls;
    const key = wallKey(wall.r, wall.c);
    set.add(key);
    try {
      return fn();
    } finally {
      set.delete(key);
    }
  }

  function shortestPathEdgeInfo(state, player) {
    const fromStart = shortestDistancesFrom(state, [state.pawns[player]]);
    const goals = goalCells(state, player);
    const fromGoals = shortestDistancesFrom(state, goals);
    let best = Infinity;
    for (const goal of goals) best = Math.min(best, fromStart[cellIndex(goal.r, goal.c)]);
    if (best === Infinity) return { distance: Infinity, edges: [] };

    const edges = [];
    for (let r = 0; r < Engine.SIZE; r += 1) {
      for (let c = 0; c < Engine.SIZE; c += 1) {
        const fromIndex = cellIndex(r, c);
        if (fromStart[fromIndex] === Infinity) continue;
        const from = { r, c };
        for (const dir of Engine.DIRS) {
          const to = { r: r + dir.dr, c: c + dir.dc };
          if (!canStepCells(state, r, c, to.r, to.c)) continue;
          if (fromStart[fromIndex] + 1 + fromGoals[cellIndex(to.r, to.c)] === best) {
            edges.push({ from, to });
          }
        }
      }
    }
    return { distance: best, edges };
  }

  function shortestDistancesFrom(state, starts) {
    const total = Engine.SIZE * Engine.SIZE;
    const dist = Array(total).fill(Infinity);
    const queue = Array(total);
    let tail = 0;
    for (const start of starts) {
      const index = cellIndex(start.r, start.c);
      dist[index] = 0;
      queue[tail] = index;
      tail += 1;
    }

    for (let head = 0; head < tail; head += 1) {
      const index = queue[head];
      const r = ((index / Engine.SIZE) | 0);
      const c = index - r * Engine.SIZE;
      const currentDist = dist[index];
      for (const dir of Engine.DIRS) {
        const nr = r + dir.dr;
        const nc = c + dir.dc;
        if (!canStepCells(state, r, c, nr, nc)) continue;
        const nextIndex = cellIndex(nr, nc);
        if (dist[nextIndex] <= currentDist + 1) continue;
        dist[nextIndex] = currentDist + 1;
        queue[tail] = nextIndex;
        tail += 1;
      }
    }
    return dist;
  }

  function cellIndex(r, c) {
    return r * Engine.SIZE + c;
  }

  function wallKey(r, c) {
    return r + "," + c;
  }

  function shortestGoalDistance(state, player) {
    const start = state.pawns[player];
    const goal = Engine.seatsForMode(state.mode)[player].goal;
    const dist = Array(Engine.SIZE * Engine.SIZE).fill(-1);
    const queue = Array(Engine.SIZE * Engine.SIZE);
    const startIndex = start.r * Engine.SIZE + start.c;
    dist[startIndex] = 0;
    queue[0] = startIndex;

    for (let head = 0, tail = 1; head < tail; head += 1) {
      const index = queue[head];
      const r = ((index / Engine.SIZE) | 0);
      const c = index - r * Engine.SIZE;
      const currentDistance = dist[index];
      if (isGoalByName(goal, r, c)) return currentDistance;

      for (const dir of Engine.DIRS) {
        const nr = r + dir.dr;
        const nc = c + dir.dc;
        if (!canStepCells(state, r, c, nr, nc)) continue;
        const nextIndex = cellIndex(nr, nc);
        if (dist[nextIndex] >= 0) continue;
        dist[nextIndex] = currentDistance + 1;
        queue[tail] = nextIndex;
        tail += 1;
      }
    }

    return Infinity;
  }

  function canStepCells(state, r, c, nr, nc) {
    if (nr < 0 || nr >= Engine.SIZE || nc < 0 || nc >= Engine.SIZE) return false;
    if (nr !== r) {
      const wallRow = r < nr ? r : nr;
      return !state.hWalls.has(wallKey(wallRow, c)) && !state.hWalls.has(wallKey(wallRow, c - 1));
    }
    const wallCol = c < nc ? c : nc;
    return !state.vWalls.has(wallKey(r, wallCol)) && !state.vWalls.has(wallKey(r - 1, wallCol));
  }

  function isGoalByName(goal, r, c) {
    if (goal === "row0") return r === 0;
    if (goal === "row8") return r === Engine.SIZE - 1;
    if (goal === "col0") return c === 0;
    if (goal === "col8") return c === Engine.SIZE - 1;
    return false;
  }

  function goalCells(state, player) {
    const goal = Engine.seatsForMode(state.mode)[player].goal;
    const cells = [];
    for (let i = 0; i < Engine.SIZE; i += 1) {
      if (goal === "row0") cells.push({ r: 0, c: i });
      else if (goal === "row8") cells.push({ r: Engine.SIZE - 1, c: i });
      else if (goal === "col0") cells.push({ r: i, c: 0 });
      else if (goal === "col8") cells.push({ r: i, c: Engine.SIZE - 1 });
    }
    return cells;
  }

  function addWallsBlockingEdge(a, b, weight, add) {
    const dr = b.r - a.r;
    const dc = b.c - a.c;
    if (Math.abs(dr) + Math.abs(dc) !== 1) return;

    if (dr !== 0) {
      const r = Math.min(a.r, b.r);
      add("h", r, a.c, weight);
      add("h", r, a.c - 1, weight);
    } else {
      const c = Math.min(a.c, b.c);
      add("v", a.r, c, weight);
      add("v", a.r - 1, c, weight);
    }
  }

  function wallDeltaScoreFromPaths(state, wall, player, beforePaths, afterPaths, beforeWidths, afterWidths) {
    const count = Engine.playerCount(state);
    let score = 0;

    for (let p = 0; p < count; p += 1) {
      const before = safeDistance(beforePaths[p].distance);
      const after = safeDistance(afterPaths[p].distance);
      const delta = after - before;
      const widthDelta = Math.max(-8, Math.min(8, (beforeWidths[p] || 0) - (afterWidths[p] || 0)));
      if (p === player) {
        score -= delta * 44;
        score -= widthDelta * 2;
      } else {
        score += delta * (count === 2 ? 82 : 58);
        score += widthDelta * (count === 2 ? 4 : 3);
      }
    }

    const rootAfter = safeDistance(afterPaths[player].distance);
    if (rootAfter <= 2) score -= 26;
    return score;
  }

  const api = {
    analyze,
    evaluate,
    candidateActions,
    candidateWalls,
    PRESETS
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.QuoridorAI = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
