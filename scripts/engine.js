(function (root) {
  "use strict";

  const SIZE = 9;
  const WALL_SIZE = 8;
  const DIRS = [
    { dr: -1, dc: 0, name: "N" },
    { dr: 1, dc: 0, name: "S" },
    { dr: 0, dc: -1, name: "W" },
    { dr: 0, dc: 1, name: "E" }
  ];

  const PLAYER_SEATS = {
    2: [
      { id: 0, label: "P1", start: { r: 8, c: 4 }, goal: "row0", color: "#f5f1e8" },
      { id: 1, label: "P2", start: { r: 0, c: 4 }, goal: "row8", color: "#26322f" }
    ],
    4: [
      { id: 0, label: "P1", start: { r: 8, c: 4 }, goal: "row0", color: "#f5f1e8" },
      { id: 1, label: "P2", start: { r: 4, c: 0 }, goal: "col8", color: "#2c7bd0" },
      { id: 2, label: "P3", start: { r: 0, c: 4 }, goal: "row8", color: "#26322f" },
      { id: 3, label: "P4", start: { r: 4, c: 8 }, goal: "col0", color: "#c05252" }
    ]
  };

  function key(r, c) {
    return r + "," + c;
  }

  function parseKey(value) {
    const parts = value.split(",").map(Number);
    return { r: parts[0], c: parts[1] };
  }

  function inBoard(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  function inWallBoard(r, c) {
    return r >= 0 && r < WALL_SIZE && c >= 0 && c < WALL_SIZE;
  }

  function cloneState(state) {
    return {
      mode: state.mode,
      turn: state.turn,
      moveNumber: state.moveNumber,
      winner: state.winner,
      pawns: state.pawns.map((p) => ({ r: p.r, c: p.c })),
      wallsRemaining: state.wallsRemaining.slice(),
      hWalls: new Set(state.hWalls),
      vWalls: new Set(state.vWalls)
    };
  }

  function createState(mode) {
    const seats = PLAYER_SEATS[mode] || PLAYER_SEATS[2];
    const walls = mode === 4 ? 5 : 10;
    return {
      mode,
      turn: 0,
      moveNumber: 1,
      winner: null,
      pawns: seats.map((seat) => ({ r: seat.start.r, c: seat.start.c })),
      wallsRemaining: seats.map(() => walls),
      hWalls: new Set(),
      vWalls: new Set()
    };
  }

  function playerCount(state) {
    return state.mode === 4 ? 4 : 2;
  }

  function seatsForMode(mode) {
    return PLAYER_SEATS[mode] || PLAYER_SEATS[2];
  }

  function goalReached(state, player) {
    const pawn = state.pawns[player];
    const goal = seatsForMode(state.mode)[player].goal;
    if (goal === "row0") return pawn.r === 0;
    if (goal === "row8") return pawn.r === SIZE - 1;
    if (goal === "col0") return pawn.c === 0;
    if (goal === "col8") return pawn.c === SIZE - 1;
    return false;
  }

  function goalDistanceProgress(state, player) {
    const pawn = state.pawns[player];
    const goal = seatsForMode(state.mode)[player].goal;
    if (goal === "row0") return SIZE - 1 - pawn.r;
    if (goal === "row8") return pawn.r;
    if (goal === "col0") return SIZE - 1 - pawn.c;
    if (goal === "col8") return pawn.c;
    return 0;
  }

  function isGoalCell(state, player, r, c) {
    const goal = seatsForMode(state.mode)[player].goal;
    if (goal === "row0") return r === 0;
    if (goal === "row8") return r === SIZE - 1;
    if (goal === "col0") return c === 0;
    if (goal === "col8") return c === SIZE - 1;
    return false;
  }

  function occupiedBy(state, r, c) {
    const count = playerCount(state);
    for (let i = 0; i < count; i += 1) {
      if (state.pawns[i].r === r && state.pawns[i].c === c) return i;
    }
    return -1;
  }

  function hasHWallAt(state, r, c) {
    return inWallBoard(r, c) && state.hWalls.has(key(r, c));
  }

  function hasVWallAt(state, r, c) {
    return inWallBoard(r, c) && state.vWalls.has(key(r, c));
  }

  function blockedByWall(state, from, to) {
    const dr = to.r - from.r;
    const dc = to.c - from.c;
    if (Math.abs(dr) + Math.abs(dc) !== 1) return true;

    if (dr !== 0) {
      const r = Math.min(from.r, to.r);
      const c = from.c;
      return hasHWallAt(state, r, c) || hasHWallAt(state, r, c - 1);
    }

    const r = from.r;
    const c = Math.min(from.c, to.c);
    return hasVWallAt(state, r, c) || hasVWallAt(state, r - 1, c);
  }

  function canStep(state, from, to) {
    return inBoard(to.r, to.c) && !blockedByWall(state, from, to);
  }

  function legalPawnMoves(state, player) {
    const from = state.pawns[player];
    const moves = [];
    const seen = new Set();

    function addMove(r, c, jump) {
      const moveKey = key(r, c);
      if (!inBoard(r, c) || occupiedBy(state, r, c) !== -1 || seen.has(moveKey)) return;
      seen.add(moveKey);
      moves.push({ type: "move", player, to: { r, c }, jump: !!jump });
    }

    for (const dir of DIRS) {
      const adjacent = { r: from.r + dir.dr, c: from.c + dir.dc };
      if (!canStep(state, from, adjacent)) continue;

      const occupant = occupiedBy(state, adjacent.r, adjacent.c);
      if (occupant === -1) {
        addMove(adjacent.r, adjacent.c, false);
        continue;
      }

      const behind = { r: adjacent.r + dir.dr, c: adjacent.c + dir.dc };
      const canJumpStraight =
        inBoard(behind.r, behind.c) &&
        occupiedBy(state, behind.r, behind.c) === -1 &&
        canStep(state, adjacent, behind);

      if (canJumpStraight) {
        addMove(behind.r, behind.c, true);
        continue;
      }

      for (const side of perpendicularDirs(dir)) {
        const diagonal = { r: adjacent.r + side.dr, c: adjacent.c + side.dc };
        if (canStep(state, adjacent, diagonal)) addMove(diagonal.r, diagonal.c, true);
      }
    }

    return moves;
  }

  function perpendicularDirs(dir) {
    if (dir.dr !== 0) {
      return [
        { dr: 0, dc: -1 },
        { dr: 0, dc: 1 }
      ];
    }
    return [
      { dr: -1, dc: 0 },
      { dr: 1, dc: 0 }
    ];
  }

  function wallCollision(state, orientation, r, c) {
    const here = key(r, c);
    if (!inWallBoard(r, c)) return true;
    if (orientation === "h") {
      return (
        state.hWalls.has(here) ||
        state.hWalls.has(key(r, c - 1)) ||
        state.hWalls.has(key(r, c + 1)) ||
        state.vWalls.has(here)
      );
    }
    return (
      state.vWalls.has(here) ||
      state.vWalls.has(key(r - 1, c)) ||
      state.vWalls.has(key(r + 1, c)) ||
      state.hWalls.has(here)
    );
  }

  function addWallUnchecked(state, orientation, r, c) {
    if (orientation === "h") state.hWalls.add(key(r, c));
    else state.vWalls.add(key(r, c));
  }

  function removeWallUnchecked(state, orientation, r, c) {
    if (orientation === "h") state.hWalls.delete(key(r, c));
    else state.vWalls.delete(key(r, c));
  }

  function legalWall(state, orientation, r, c, player) {
    if (state.winner !== null) return false;
    if (player !== undefined && state.wallsRemaining[player] <= 0) return false;
    if (orientation !== "h" && orientation !== "v") return false;
    if (wallCollision(state, orientation, r, c)) return false;

    addWallUnchecked(state, orientation, r, c);
    let ok = true;
    const count = playerCount(state);
    for (let i = 0; i < count; i += 1) {
      if (shortestPath(state, i).distance === Infinity) {
        ok = false;
        break;
      }
    }
    removeWallUnchecked(state, orientation, r, c);
    return ok;
  }

  function legalWalls(state, player) {
    if (state.wallsRemaining[player] <= 0) return [];
    const walls = [];
    for (let r = 0; r < WALL_SIZE; r += 1) {
      for (let c = 0; c < WALL_SIZE; c += 1) {
        if (legalWall(state, "h", r, c, player)) walls.push({ type: "wall", player, orientation: "h", r, c });
        if (legalWall(state, "v", r, c, player)) walls.push({ type: "wall", player, orientation: "v", r, c });
      }
    }
    return walls;
  }

  function legalActions(state, player) {
    const p = player === undefined ? state.turn : player;
    return legalPawnMoves(state, p).concat(legalWalls(state, p));
  }

  function isLegalAction(state, action, player) {
    const p = player === undefined ? state.turn : player;
    if (!action || action.player !== undefined && action.player !== p) return false;
    if (action.type === "move") {
      return legalPawnMoves(state, p).some((move) => move.to.r === action.to.r && move.to.c === action.to.c);
    }
    if (action.type === "wall") {
      return legalWall(state, action.orientation, action.r, action.c, p);
    }
    return false;
  }

  function applyKnownLegalAction(state, action) {
    const next = cloneState(state);
    const player = state.turn;

    if (action.type === "move") {
      next.pawns[player] = { r: action.to.r, c: action.to.c };
      if (goalReached(next, player)) next.winner = player;
    } else {
      addWallUnchecked(next, action.orientation, action.r, action.c);
      next.wallsRemaining[player] -= 1;
    }

    if (next.winner === null) {
      next.turn = (state.turn + 1) % playerCount(state);
      next.moveNumber = state.moveNumber + 1;
    }

    return next;
  }

  function applyAction(state, action) {
    const player = state.turn;
    if (!isLegalAction(state, action, player)) {
      throw new Error("Illegal action: " + JSON.stringify(action));
    }
    return applyKnownLegalAction(state, action);
  }

  function shortestPath(state, player) {
    const start = state.pawns[player];
    const queue = [{ r: start.r, c: start.c }];
    const visited = new Set([key(start.r, start.c)]);
    const previous = new Map();
    const distance = new Map([[key(start.r, start.c), 0]]);
    let goalKey = null;

    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head];
      const currentKey = key(current.r, current.c);
      const dist = distance.get(currentKey);
      if (isGoalCell(state, player, current.r, current.c)) {
        goalKey = currentKey;
        break;
      }

      for (const dir of DIRS) {
        const next = { r: current.r + dir.dr, c: current.c + dir.dc };
        const nextKey = key(next.r, next.c);
        if (!canStep(state, current, next) || visited.has(nextKey)) continue;
        visited.add(nextKey);
        previous.set(nextKey, currentKey);
        distance.set(nextKey, dist + 1);
        queue.push(next);
      }
    }

    if (goalKey === null) return { distance: Infinity, path: [] };

    const path = [];
    let cursor = goalKey;
    while (cursor) {
      path.push(parseKey(cursor));
      cursor = previous.get(cursor);
    }
    path.reverse();
    return { distance: distance.get(goalKey), path };
  }

  function allShortestPaths(state) {
    const count = playerCount(state);
    const paths = [];
    for (let i = 0; i < count; i += 1) paths.push(shortestPath(state, i));
    return paths;
  }

  function actionEquals(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === "move") return a.to.r === b.to.r && a.to.c === b.to.c;
    return a.orientation === b.orientation && a.r === b.r && a.c === b.c;
  }

  function actionToNotation(state, action) {
    if (!action) return "";
    if (action.type === "move") return squareName(action.to.r, action.to.c);
    return (action.orientation === "h" ? "横壁 " : "縦壁 ") + wallName(action.r, action.c);
  }

  function squareName(r, c) {
    return String.fromCharCode(97 + c) + (SIZE - r);
  }

  function wallName(r, c) {
    return String.fromCharCode(97 + c) + (WALL_SIZE - r);
  }

  function stateHash(state) {
    const h = Array.from(state.hWalls).sort().join(";");
    const v = Array.from(state.vWalls).sort().join(";");
    const pawns = state.pawns.map((p) => p.r + "." + p.c).join("|");
    return [state.mode, state.turn, pawns, state.wallsRemaining.join("."), h, v].join("/");
  }

  const api = {
    SIZE,
    WALL_SIZE,
    DIRS,
    PLAYER_SEATS,
    createState,
    cloneState,
    playerCount,
    seatsForMode,
    key,
    parseKey,
    inBoard,
    inWallBoard,
    occupiedBy,
    goalReached,
    goalDistanceProgress,
    blockedByWall,
    canStep,
    legalPawnMoves,
    legalWall,
    wallCollision,
    legalWalls,
    legalActions,
    isLegalAction,
    applyAction,
    applyKnownLegalAction,
    shortestPath,
    allShortestPaths,
    actionEquals,
    actionToNotation,
    squareName,
    wallName,
    stateHash
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.QuoridorEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
