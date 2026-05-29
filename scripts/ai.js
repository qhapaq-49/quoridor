(function (root) {
  "use strict";

  const Engine = typeof require === "function" ? require("./engine.js") : root.QuoridorEngine;
  const INF = 1e9;
  const TACTICAL_WALL_PRIOR = 220;
  const PAWN_RACE_CACHE_LIMIT = 64;
  const pawnRaceCache = new Map();

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
    const immediateWin = immediateWinningMove(state, state.turn);
    if (immediateWin) {
      return {
        bestMove: immediateWin,
        chosenMove: immediateWin,
        candidates: [{ action: immediateWin, score: 100000, rank: 1 }],
        depth: 0,
        nodes: 0,
        timeMs: Math.round(now() - started)
      };
    }
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
        score: evaluate(child, rootPlayer) + actionAdjustment(state, action, rootPlayer) - repetitionPenalty(child, rootPlayer, action, opts),
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
          score += actionAdjustment(state, entry.action, rootPlayer);
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
      const score = search(child, depth - 1, rootPlayer, alpha, beta, deadline, opts, table, bumpNode) + actionAdjustment(state, action, rootPlayer);
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
    let value = standPat;
    if (maximizing) alpha = Math.max(alpha, value);
    else beta = Math.min(beta, value);
    if (alpha >= beta) return value;
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
    return immediateWinningMove(state, player) !== null;
  }

  function immediateWinningMove(state, player) {
    const goal = Engine.seatsForMode(state.mode)[player].goal;
    return Engine.legalPawnMoves(state, player).find((move) => isGoalByName(goal, move.to.r, move.to.c)) || null;
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
        score: evaluate(Engine.applyKnownLegalAction(state, action), rootPlayer) + actionAdjustment(state, action, rootPlayer),
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

  function actionAdjustment(state, action, rootPlayer) {
    if (state.mode !== 2) return 0;
    const actor = action.player === undefined ? state.turn : action.player;
    let quality = action.type === "wall" ? action.adjustment || 0 : moveActionQuality(state, action, actor);
    if (action.type === "wall" && actor === rootPlayer) quality += action.rootAdjustment || 0;
    return actor === rootPlayer ? quality : -quality;
  }

  function moveActionQuality(state, action, player) {
    if (action.type !== "move") return 0;
    if (state.moveNumber > 28) return lateMoveActionQuality(state, action, player);
    const target = 1 - player;
    const wallLead = state.wallsRemaining[player] - state.wallsRemaining[target];
    if (wallLead < 0) return 0;

    const beforeDistance = safeDistance(shortestGoalDistance(state, player));
    const beforeOpponentDistance = safeDistance(shortestGoalDistance(state, target));
    const tempoLead = beforeDistance + 1 <= beforeOpponentDistance;
    const strongWallLead = wallLead >= 3 && beforeDistance <= beforeOpponentDistance + 1;
    if (!tempoLead && !strongWallLead) return 0;

    const beforeProgress = Engine.goalDistanceProgress(state, player);
    const beforeCenter = centerControlScore(state, player);
    const original = state.pawns[player];
    let afterDistance = beforeDistance;
    let afterProgress = beforeProgress;
    let afterCenter = beforeCenter;

    try {
      state.pawns[player] = { r: action.to.r, c: action.to.c };
      afterDistance = safeDistance(shortestGoalDistance(state, player));
      afterProgress = Engine.goalDistanceProgress(state, player);
      afterCenter = centerControlScore(state, player);
    } finally {
      state.pawns[player] = original;
    }

    let quality = 0;
    if (tempoLead && wallLead <= 1 && afterProgress < beforeProgress) quality -= 240;
    if (strongWallLead) {
      quality += (afterCenter - beforeCenter) * 180;
      if (afterDistance > beforeDistance) quality -= 220;
      if (afterProgress < beforeProgress) quality -= 130;
      if (afterCenter <= 2 && afterDistance >= beforeDistance) quality -= 80;
    }
    return quality;
  }

  function lateMoveActionQuality(state, action, player) {
    if (state.mode !== 2) return 0;
    const target = 1 - player;
    if (state.wallsRemaining[target] !== 0 || state.wallsRemaining[player] > 2) return 0;

    const beforeSelf = safeDistance(shortestGoalDistance(state, player));
    const beforeTarget = safeDistance(shortestGoalDistance(state, target));
    if (beforeSelf <= beforeTarget) return 0;

    const original = state.pawns[player];
    let afterSelf = beforeSelf;
    try {
      state.pawns[player] = { r: action.to.r, c: action.to.c };
      afterSelf = safeDistance(shortestGoalDistance(state, player));
    } finally {
      state.pawns[player] = original;
    }

    if (afterSelf < beforeSelf) return 180;
    if (afterSelf > beforeSelf) return -220;
    return 0;
  }

  function wallActionQualityFromPaths(state, wall, player, beforePaths, afterPaths) {
    if (state.mode !== 2) return 0;
    const target = 1 - player;
    const beforeSelf = safeDistance(beforePaths[player].distance);
    const afterSelf = safeDistance(afterPaths[player].distance);
    const beforeTarget = safeDistance(beforePaths[target].distance);
    const afterTarget = safeDistance(afterPaths[target].distance);
    const targetDelta = Math.max(0, afterTarget - beforeTarget);
    const selfDelta = Math.max(0, afterSelf - beforeSelf);
    const anchored = wallTouchesEdge(wall) || wallTouchesExisting(state, wall);
    let quality = targetDelta * 55 - selfDelta * 75;

    if (!anchored && targetDelta <= 1) quality -= 70;
    if (targetDelta <= 1 && wallBlocksPawnForward(state, wall, target)) {
      const pressure = state.wallsRemaining[player] - state.wallsRemaining[target];
      const pathLead = beforeTarget - beforeSelf;
      if (beforeTarget <= 3 && pathLead < 0) quality += wallBlocksPawnPrimaryForward(state, wall, target) ? 195 : 155;
      else quality -= pathLead >= 0 || pressure >= 2 ? 150 : 25;
    }
    if (targetDelta >= 1 && wallBlocksPawnSecondStep(state, wall, target)) {
      quality += 120;
      if (state.moveNumber <= 14) quality += centralWallBonus(wall);
    }
    const pressure = state.wallsRemaining[player] - state.wallsRemaining[target];
    const pathLead = beforeTarget - beforeSelf;
    if (pressure >= 3 && pathLead < 0 && beforeSelf >= 12 && selfDelta === 0 && pathLead + targetDelta <= 0) quality -= 260;
    if (pressure >= 3 && targetDelta <= 1 && !anchored && wallDistanceToPawn(state, wall, target) <= 2) quality -= 130;
    if (state.moveNumber <= 18) {
      if (pressure >= 2 && pathLead >= 1 && targetDelta <= 2) quality -= 720;
      if (pressure >= 3 && pathLead >= 0 && targetDelta <= 1) quality -= 260;
      if (pressure >= 2 && beforeSelf >= beforeTarget - 1 && targetDelta <= 1) quality -= 150 + pressure * 70;
      if (pressure >= 2 && wallSupportsHomeEdge(state, wall, player)) quality += 45;
    }
    if (anchored && targetDelta >= 1) quality += 25;
    if (targetDelta >= 2) quality += 80;
    if (state.wallsRemaining[target] === 0 && targetDelta >= 2 && selfDelta === 0 && wallDistanceToPawn(state, wall, target) <= 3) quality += 300;
    if (selfDelta > 0 && targetDelta <= selfDelta) quality -= 80;

    return quality;
  }

  function rootWallAdjustment(state, wall, player, beforePaths, afterPaths) {
    if (state.mode !== 2) return 0;
    const target = 1 - player;
    const beforeSelf = safeDistance(beforePaths[player].distance);
    const afterSelf = safeDistance(afterPaths[player].distance);
    const beforeTarget = safeDistance(beforePaths[target].distance);
    const afterTarget = safeDistance(afterPaths[target].distance);
    const targetDelta = Math.max(0, afterTarget - beforeTarget);
    const selfDelta = Math.max(0, afterSelf - beforeSelf);
    const pressure = state.wallsRemaining[player] - state.wallsRemaining[target];
    const pathLead = beforeTarget - beforeSelf;
    const afterPathLead = afterTarget - afterSelf;
    const ownWallsAfter = state.wallsRemaining[player] - 1;
    if (
      state.moveNumber <= 24 &&
      beforeSelf >= beforeTarget + 2 &&
      afterSelf >= afterTarget + 2 &&
      beforeTarget > 3 &&
      selfDelta === 0 &&
      targetDelta <= 4
    ) {
      return -360 - Math.min(5, afterSelf - afterTarget) * 110;
    }
    if (
      state.moveNumber >= 18 &&
      state.moveNumber <= 36 &&
      beforeSelf >= beforeTarget + 1 &&
      afterPathLead <= 1 &&
      afterSelf >= 8 &&
      afterTarget >= 8 &&
      ownWallsAfter <= state.wallsRemaining[target] &&
      selfDelta === 0 &&
      targetDelta <= 1
    ) {
      return -420 - Math.min(4, state.wallsRemaining[target] - ownWallsAfter) * 120;
    }
    if (state.moveNumber <= 18 && pressure >= 3 && pathLead < 0 && targetDelta >= 1 && selfDelta === 0 && wallDistanceToPawn(state, wall, player) <= 2) return 520;
    if (state.moveNumber >= 12 && state.moveNumber <= 22 && pressure <= 1 && pathLead < 0 && targetDelta <= 2 && selfDelta === 0) return -320;
    if (state.moveNumber >= 20 && state.moveNumber <= 30 && pressure <= -2 && pathLead <= -2 && state.wallsRemaining[player] <= 4 && targetDelta <= 2 && selfDelta === 0) return -380;
    if (state.moveNumber >= 24 && state.moveNumber <= 32 && pressure <= -3 && state.wallsRemaining[player] <= 1 && pathLead <= 0 && targetDelta <= 2 && selfDelta === 0) return -300;
    if (state.moveNumber >= 30 && state.wallsRemaining[target] === 0 && state.wallsRemaining[player] <= 3 && pathLead < 0 && targetDelta <= 1 && selfDelta === 0) return -650;
    if (state.moveNumber >= 24 && state.moveNumber <= 36 && pressure >= 3 && state.wallsRemaining[target] <= 2 && pathLead <= -2 && afterPathLead >= 0 && targetDelta >= 2 && selfDelta <= targetDelta && wallDistanceToPawn(state, wall, target) <= 3) return 320;
    if (state.moveNumber >= 30 && state.wallsRemaining[target] === 0 && state.wallsRemaining[player] <= 2 && pathLead < 0 && targetDelta <= 2 && selfDelta === 0) return -360;
    return 0;
  }

  function wallDistanceToPawn(state, wall, player) {
    const pawn = state.pawns[player];
    let best = 99;
    for (let dr = 0; dr <= 1; dr += 1) {
      for (let dc = 0; dc <= 1; dc += 1) {
        const r = wall.r + dr;
        const c = wall.c + dc;
        best = Math.min(best, Math.abs(pawn.r - r) + Math.abs(pawn.c - c));
      }
    }
    return best;
  }

  function wallBlocksPawnForward(state, wall, player) {
    const pawn = state.pawns[player];
    const goal = Engine.seatsForMode(state.mode)[player].goal;
    if (wall.orientation === "h" && (goal === "row0" || goal === "row8")) {
      const frontRow = goal === "row0" ? pawn.r - 1 : pawn.r;
      return wall.r === frontRow && (wall.c === pawn.c || wall.c === pawn.c - 1);
    }
    if (wall.orientation === "v" && (goal === "col0" || goal === "col8")) {
      const frontCol = goal === "col0" ? pawn.c - 1 : pawn.c;
      return wall.c === frontCol && (wall.r === pawn.r || wall.r === pawn.r - 1);
    }
    return false;
  }

  function wallBlocksPawnPrimaryForward(state, wall, player) {
    const pawn = state.pawns[player];
    const goal = Engine.seatsForMode(state.mode)[player].goal;
    if (wall.orientation === "h" && (goal === "row0" || goal === "row8")) {
      const frontRow = goal === "row0" ? pawn.r - 1 : pawn.r;
      return wall.r === frontRow && wall.c === pawn.c;
    }
    if (wall.orientation === "v" && (goal === "col0" || goal === "col8")) {
      const frontCol = goal === "col0" ? pawn.c - 1 : pawn.c;
      return wall.c === frontCol && wall.r === pawn.r;
    }
    return false;
  }

  function wallBlocksPawnSecondStep(state, wall, player) {
    const pawn = state.pawns[player];
    const goal = Engine.seatsForMode(state.mode)[player].goal;
    if (wall.orientation === "h" && (goal === "row0" || goal === "row8")) {
      const gateRow = goal === "row0" ? pawn.r - 2 : pawn.r + 1;
      return wall.r === gateRow && (wall.c === pawn.c || wall.c === pawn.c - 1);
    }
    if (wall.orientation === "v" && (goal === "col0" || goal === "col8")) {
      const gateCol = goal === "col0" ? pawn.c - 2 : pawn.c + 1;
      return wall.c === gateCol && (wall.r === pawn.r || wall.r === pawn.r - 1);
    }
    return false;
  }

  function wallSupportsHomeEdge(state, wall, player) {
    const goal = Engine.seatsForMode(state.mode)[player].goal;
    if (wall.orientation === "h" && goal === "row0") return wall.r === Engine.WALL_SIZE - 1;
    if (wall.orientation === "h" && goal === "row8") return wall.r === 0;
    if (wall.orientation === "v" && goal === "col0") return wall.c === Engine.WALL_SIZE - 1;
    if (wall.orientation === "v" && goal === "col8") return wall.c === 0;
    return false;
  }

  function wallTouchesEdge(wall) {
    if (wall.orientation === "h") return wall.c === 0 || wall.c === Engine.WALL_SIZE - 1;
    return wall.r === 0 || wall.r === Engine.WALL_SIZE - 1;
  }

  function centralWallBonus(wall) {
    const center = wall.orientation === "h" ? wall.c + 0.5 : wall.r + 0.5;
    return Math.max(0, 3 - Math.abs(center - 4)) * 25;
  }

  function wallTouchesExisting(state, wall) {
    const ownSet = wall.orientation === "h" ? state.hWalls : state.vWalls;
    if (wall.orientation === "h") {
      if (ownSet.has(wallKey(wall.r, wall.c - 1)) || ownSet.has(wallKey(wall.r, wall.c + 1))) return true;
      return (
        state.vWalls.has(wallKey(wall.r - 1, wall.c)) ||
        state.vWalls.has(wallKey(wall.r, wall.c)) ||
        state.vWalls.has(wallKey(wall.r - 1, wall.c + 1)) ||
        state.vWalls.has(wallKey(wall.r, wall.c + 1))
      );
    }

    if (ownSet.has(wallKey(wall.r - 1, wall.c)) || ownSet.has(wallKey(wall.r + 1, wall.c))) return true;
    return (
      state.hWalls.has(wallKey(wall.r, wall.c - 1)) ||
      state.hWalls.has(wallKey(wall.r, wall.c)) ||
      state.hWalls.has(wallKey(wall.r + 1, wall.c - 1)) ||
      state.hWalls.has(wallKey(wall.r + 1, wall.c))
    );
  }

  function evaluate(state, rootPlayer) {
    if (state.winner !== null) return state.winner === rootPlayer ? 100000 : -100000;

    const immediateWinner = immediateWinningPlayer(state);
    if (immediateWinner !== null) return immediateWinner === rootPlayer ? 96000 : -96000;

    const exactPawnRaceScore = pawnRaceScore(state, rootPlayer);
    if (exactPawnRaceScore !== null) return exactPawnRaceScore;

    const count = Engine.playerCount(state);
    const rootDistance = safeDistance(shortestGoalDistance(state, rootPlayer));
    const rootRacePlies = racePliesToGoal(state, rootPlayer, rootDistance);
    let nearestOpponent = 99;
    let nearestOpponentRacePlies = 999;
    let sumOpponentDistance = 0;
    let opponentWalls = 0;
    let opponentProgress = 0;
    let opponentMobility = 0;
    let opponentImprovingMoves = 0;
    let opponentEqualMoves = 0;
    let opponentCenter = 0;

    for (let i = 0; i < count; i += 1) {
      if (i === rootPlayer) continue;
      const distance = safeDistance(shortestGoalDistance(state, i));
      nearestOpponent = Math.min(nearestOpponent, distance);
      nearestOpponentRacePlies = Math.min(nearestOpponentRacePlies, racePliesToGoal(state, i, distance));
      sumOpponentDistance += distance;
      opponentWalls += state.wallsRemaining[i];
      opponentProgress = Math.max(opponentProgress, Engine.goalDistanceProgress(state, i));
      const opponentRouteChoicesForPlayer = pawnRouteChoices(state, i, distance);
      opponentMobility += opponentRouteChoicesForPlayer.total;
      opponentImprovingMoves += opponentRouteChoicesForPlayer.improving;
      opponentEqualMoves += opponentRouteChoicesForPlayer.equal;
      opponentCenter += centerControlScore(state, i);
    }

    const opponentCount = count - 1;
    const averageOpponentDistance = sumOpponentDistance / opponentCount;
    const averageOpponentWalls = opponentWalls / opponentCount;
    const raceDelta = nearestOpponentRacePlies - rootRacePlies;
    const wallLead = state.wallsRemaining[rootPlayer] - averageOpponentWalls;
    const wallPressureBalance = state.wallsRemaining[rootPlayer] * nearestOpponentRacePlies - averageOpponentWalls * rootRacePlies;
    const rootProgress = Engine.goalDistanceProgress(state, rootPlayer);
    const rootRouteChoices = pawnRouteChoices(state, rootPlayer, rootDistance);
    const rootCenter = centerControlScore(state, rootPlayer);
    const averageOpponentCenter = opponentCenter / opponentCount;
    const rootMobility = rootRouteChoices.total;

    let score = 0;
    score += (nearestOpponent - rootDistance) * 132;
    score += (averageOpponentDistance - rootDistance) * 42;
    score += raceDelta * (count === 2 ? 24 : 12);
    score += wallPressureBalance * (count === 2 ? 5 : 2);
    if (raceDelta > 0) score -= rootRacePlies * (count === 2 ? 10 : 4);
    score += (state.wallsRemaining[rootPlayer] - averageOpponentWalls) * 13;
    score += (rootProgress - opponentProgress) * 8;
    score += (rootMobility - opponentMobility / opponentCount) * 4;
    score += (rootRouteChoices.improving - opponentImprovingMoves / opponentCount) * (count === 2 ? 36 : 16);
    score += (rootRouteChoices.equal - opponentEqualMoves / opponentCount) * (count === 2 ? 12 : 5);
    score += (rootCenter - averageOpponentCenter) * (count === 2 ? 10 : 4);
    if (count === 2 && state.moveNumber <= 24 && wallLead >= 3 && rootDistance <= nearestOpponent) {
      score += rootRouteChoices.equal * 55 + rootCenter * 45;
      if (rootRouteChoices.total <= 3) score -= 180;
    }
    if (count === 2 && rootRouteChoices.improving === 0 && rootDistance > 1) score -= 120;
    if (count === 2 && opponentImprovingMoves === 0 && nearestOpponent > 1) score += 90;

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

  function pawnRaceScore(state, rootPlayer) {
    if (state.mode !== 2 || state.moveNumber < 44 || state.wallsRemaining[0] !== 0 || state.wallsRemaining[1] !== 0) return null;
    const solver = pawnRaceSolverFor(state);
    const p0 = state.pawns[0].r * Engine.SIZE + state.pawns[0].c;
    const p1 = state.pawns[1].r * Engine.SIZE + state.pawns[1].c;
    const index = pawnRaceIndex(p0, p1, state.turn);
    const winner = solver.winner[index];
    if (winner < 0) return null;
    const plies = solver.depth[index];
    if (winner === rootPlayer) return 86000 - plies * 12;
    return -86000 + plies * 12;
  }

  function pawnRaceSolverFor(state) {
    const key = pawnRaceWallKey(state);
    const cached = pawnRaceCache.get(key);
    if (cached) return cached;
    const solver = createPawnRaceSolver(state);
    if (pawnRaceCache.size >= PAWN_RACE_CACHE_LIMIT) pawnRaceCache.delete(pawnRaceCache.keys().next().value);
    pawnRaceCache.set(key, solver);
    return solver;
  }

  function pawnRaceWallKey(state) {
    return Array.from(state.hWalls).sort().join(";") + "/" + Array.from(state.vWalls).sort().join(";");
  }

  function pawnRaceIndex(p0, p1, turn) {
    return ((p0 * Engine.SIZE * Engine.SIZE + p1) * 2 + turn);
  }

  function createPawnRaceSolver(baseState) {
    const cells = Engine.SIZE * Engine.SIZE;
    const stateCount = cells * cells * 2;
    const winner = new Int8Array(stateCount);
    const depth = new Int16Array(stateCount);
    const degree = new Int8Array(stateCount);
    const maxLosingDepth = new Int16Array(stateCount);
    winner.fill(-1);

    const predecessors = Array.from({ length: stateCount }, () => []);
    const queue = [];
    const tmp = Engine.cloneState(baseState);
    tmp.wallsRemaining = [0, 0];
    tmp.winner = null;

    for (let p0 = 0; p0 < cells; p0 += 1) {
      for (let p1 = 0; p1 < cells; p1 += 1) {
        if (p0 === p1) continue;
        for (let turn = 0; turn < 2; turn += 1) {
          const id = pawnRaceIndex(p0, p1, turn);
          setPawnRacePawns(tmp, p0, p1);
          tmp.turn = turn;
          if (tmp.pawns[0].r === 0) {
            winner[id] = 0;
            queue.push(id);
            continue;
          }
          if (tmp.pawns[1].r === Engine.SIZE - 1) {
            winner[id] = 1;
            queue.push(id);
            continue;
          }

          const moves = Engine.legalPawnMoves(tmp, turn);
          degree[id] = moves.length;
          for (const move of moves) {
            const nextP0 = turn === 0 ? move.to.r * Engine.SIZE + move.to.c : p0;
            const nextP1 = turn === 1 ? move.to.r * Engine.SIZE + move.to.c : p1;
            predecessors[pawnRaceIndex(nextP0, nextP1, 1 - turn)].push(id);
          }
        }
      }
    }

    for (let head = 0; head < queue.length; head += 1) {
      const child = queue[head];
      const childWinner = winner[child];
      const childDepth = depth[child];
      for (const parent of predecessors[child]) {
        if (winner[parent] >= 0) continue;
        const turn = parent & 1;
        if (childWinner === turn) {
          winner[parent] = turn;
          depth[parent] = childDepth + 1;
          queue.push(parent);
        } else {
          maxLosingDepth[parent] = Math.max(maxLosingDepth[parent], childDepth + 1);
          degree[parent] -= 1;
          if (degree[parent] === 0) {
            winner[parent] = 1 - turn;
            depth[parent] = maxLosingDepth[parent];
            queue.push(parent);
          }
        }
      }
    }

    return { winner, depth };
  }

  function setPawnRacePawns(state, p0, p1) {
    state.pawns[0] = { r: (p0 / Engine.SIZE) | 0, c: p0 % Engine.SIZE };
    state.pawns[1] = { r: (p1 / Engine.SIZE) | 0, c: p1 % Engine.SIZE };
  }

  function centerControlScore(state, player) {
    const pawn = state.pawns[player];
    const goal = Engine.seatsForMode(state.mode)[player].goal;
    const axis = goal === "row0" || goal === "row8" ? pawn.c : pawn.r;
    return Math.max(0, 4 - Math.abs(axis - 4));
  }

  function pawnRouteChoices(state, player, currentDistance) {
    const moves = Engine.legalPawnMoves(state, player);
    const original = state.pawns[player];
    let improving = 0;
    let equal = 0;
    try {
      for (const move of moves) {
        state.pawns[player] = { r: move.to.r, c: move.to.c };
        const distance = shortestGoalDistance(state, player);
        if (distance < currentDistance) improving += 1;
        else if (distance === currentDistance) equal += 1;
      }
    } finally {
      state.pawns[player] = original;
    }
    return { total: moves.length, improving, equal };
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
    if (state.wallsRemaining[player] === 10 && state.wallsRemaining[opponent] === 10 && legalCandidates.length > 0) {
      return legalCandidates[0];
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
      const adjustment = wallActionQualityFromPaths(state, wall, player, paths, afterPaths);
      const rootAdjustment = rootWallAdjustment(state, wall, player, paths, afterPaths);
      const score = wallDeltaScoreFromPaths(state, wall, player, paths, afterPaths, pathWidths, afterWidths) + wall.reason;
      scored.push(Object.assign(wall, { prior: score, adjustment, rootAdjustment }));
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
