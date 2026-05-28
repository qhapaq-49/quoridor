(function () {
  "use strict";

  const Engine = window.QuoridorEngine;
  const AI = window.QuoridorAI;
  const canvas = document.getElementById("boardCanvas");
  const ctx = canvas.getContext("2d");

  const ui = {
    status: document.getElementById("statusLine"),
    newGame: document.getElementById("newGameButton"),
    undo: document.getElementById("undoButton"),
    modeButtons: Array.from(document.querySelectorAll(".mode-button")),
    toolButtons: Array.from(document.querySelectorAll(".tool-button")),
    hint: document.getElementById("hintButton"),
    strength: document.getElementById("strengthSelect"),
    randomness: document.getElementById("randomnessSlider"),
    showHints: document.getElementById("showHintsToggle"),
    players: document.getElementById("playerList"),
    summary: document.getElementById("analysisSummary"),
    candidates: document.getElementById("candidateList")
  };

  const COLORS = {
    board: "#d7ae62",
    boardAlt: "#e4c382",
    groove: "#8b6738",
    wall: "#4a3623",
    wallGhost: "rgba(31, 122, 97, 0.55)",
    wallBad: "rgba(199, 75, 75, 0.55)",
    legal: "rgba(31, 122, 97, 0.22)",
    hint: "rgba(255, 208, 92, 0.88)",
    accent: "#1f7a61",
    text: "#1f2a24"
  };

  const geometry = {
    size: 742,
    start: 54,
    cell: 58,
    gap: 14,
    get pitch() {
      return this.cell + this.gap;
    }
  };

  let state = Engine.createState(2);
  let history = [];
  let tool = "move";
  let hover = null;
  let analysis = null;
  let thinking = false;
  let playerTypes = ["human", "ai", "ai", "ai"];

  function init() {
    bindEvents();
    resetGame(2);
  }

  function bindEvents() {
    ui.newGame.addEventListener("click", () => resetGame(state.mode));
    ui.undo.addEventListener("click", undo);
    ui.hint.addEventListener("click", () => runAnalysis(true));
    ui.strength.addEventListener("change", () => {
      analysis = null;
      maybeRunAi();
      render();
    });
    ui.randomness.addEventListener("input", () => renderCandidates());
    ui.showHints.addEventListener("change", () => render());

    for (const button of ui.modeButtons) {
      button.addEventListener("click", () => resetGame(Number(button.dataset.mode)));
    }

    for (const button of ui.toolButtons) {
      button.addEventListener("click", () => {
        tool = button.dataset.tool;
        updateToolButtons();
        render();
      });
    }

    canvas.addEventListener("mousemove", (event) => {
      hover = hitTest(event);
      render();
    });
    canvas.addEventListener("mouseleave", () => {
      hover = null;
      render();
    });
    canvas.addEventListener("click", onBoardClick);
  }

  function resetGame(mode) {
    state = Engine.createState(mode);
    history = [];
    analysis = null;
    thinking = false;
    tool = "move";
    if (mode === 2) playerTypes = ["human", "ai", "ai", "ai"];
    else playerTypes = ["human", "ai", "ai", "ai"];
    updateModeButtons();
    updateToolButtons();
    buildPlayerControls();
    render();
    maybeRunAi();
  }

  function buildPlayerControls() {
    ui.players.innerHTML = "";
    const seats = Engine.seatsForMode(state.mode);
    for (let i = 0; i < seats.length; i += 1) {
      const row = document.createElement("div");
      row.className = "player-row";
      row.dataset.player = String(i);

      const dot = document.createElement("span");
      dot.className = "player-dot";
      dot.style.background = seats[i].color;

      const info = document.createElement("div");
      const name = document.createElement("div");
      name.className = "player-name";
      name.textContent = seats[i].label;
      const meta = document.createElement("div");
      meta.className = "player-meta";
      meta.dataset.meta = String(i);
      info.append(name, meta);

      const select = document.createElement("select");
      select.dataset.playerType = String(i);
      select.innerHTML = '<option value="human">人間</option><option value="ai">AI</option>';
      select.value = playerTypes[i] || "ai";
      select.addEventListener("change", () => {
        playerTypes[i] = select.value;
        analysis = null;
        render();
        maybeRunAi();
      });

      row.append(dot, info, select);
      ui.players.append(row);
    }
  }

  function onBoardClick(event) {
    if (thinking || state.winner !== null || playerTypes[state.turn] !== "human") return;
    const hit = hitTest(event);
    if (!hit) return;

    let action = null;
    if (tool === "move" && hit.kind === "cell") {
      action = { type: "move", to: { r: hit.r, c: hit.c } };
    } else if ((tool === "h" || tool === "v") && hit.kind === "wall") {
      action = { type: "wall", orientation: tool, r: hit.r, c: hit.c };
    }

    if (!action || !Engine.isLegalAction(state, action, state.turn)) return;
    commitAction(action);
  }

  function commitAction(action) {
    history.push(Engine.cloneState(state));
    state = Engine.applyAction(state, action);
    analysis = null;
    hover = null;
    render();
    maybeRunAi();
  }

  function undo() {
    if (thinking || history.length === 0) return;
    state = history.pop();
    analysis = null;
    render();
  }

  function maybeRunAi() {
    if (thinking || state.winner !== null || playerTypes[state.turn] !== "ai") return;
    thinking = true;
    render();

    window.setTimeout(() => {
      const result = runSearch();
      if (result.chosenMove) {
        history.push(Engine.cloneState(state));
        state = Engine.applyAction(state, result.chosenMove);
      }
      analysis = null;
      thinking = false;
      render();
      window.setTimeout(maybeRunAi, 90);
    }, 80);
  }

  function runAnalysis(force) {
    if (thinking || state.winner !== null) return;
    if (!force && !ui.showHints.checked) return;
    analysis = runSearch();
    render();
  }

  function runSearch() {
    const avoid = recentAnalysisHistory();
    return AI.analyze(state, {
      strength: ui.strength.value,
      randomness: Number(ui.randomness.value) / 100,
      rootPlayer: state.turn,
      avoid: avoid.states,
      avoidPawnKeys: avoid.pawns
    });
  }

  function recentAnalysisHistory() {
    const states = new Set();
    const pawns = new Set();
    const start = Math.max(0, history.length - 12);
    for (let i = start; i < history.length; i += 1) addAvoidState(history[i], states, pawns);
    addAvoidState(state, states, pawns);
    return { states, pawns };
  }

  function addAvoidState(item, states, pawns) {
    states.add(Engine.stateHash(item));
    const pawn = item.pawns[state.turn];
    pawns.add(Engine.key(pawn.r, pawn.c));
  }

  function render() {
    drawBoard();
    renderStatus();
    renderPlayers();
    renderCandidates();
    ui.undo.disabled = thinking || history.length === 0;
    ui.hint.disabled = thinking || state.winner !== null;
  }

  function renderStatus() {
    if (state.winner !== null) {
      ui.status.textContent = Engine.seatsForMode(state.mode)[state.winner].label + " の勝ち";
      return;
    }
    const current = Engine.seatsForMode(state.mode)[state.turn].label;
    const actor = playerTypes[state.turn] === "ai" ? "AI" : "人間";
    ui.status.textContent = thinking ? current + " AI 思考中" : current + " " + actor + " の手番";
  }

  function renderPlayers() {
    const rows = Array.from(ui.players.querySelectorAll(".player-row"));
    for (const row of rows) {
      const player = Number(row.dataset.player);
      row.classList.toggle("is-turn", state.winner === null && player === state.turn);
      const meta = row.querySelector("[data-meta]");
      const path = Engine.shortestPath(state, player);
      meta.textContent = "壁 " + state.wallsRemaining[player] + " / 最短 " + path.distance;
    }
  }

  function renderCandidates() {
    if (!analysis || !ui.showHints.checked) {
      ui.summary.textContent = thinking ? "AI 思考中" : "解析待ち";
      ui.candidates.innerHTML = "";
      return;
    }

    ui.summary.textContent = "深さ " + analysis.depth + " / " + analysis.timeMs + "ms / " + analysis.nodes + " nodes";
    ui.candidates.innerHTML = "";
    for (const entry of analysis.candidates) {
      const li = document.createElement("li");
      const name = document.createElement("div");
      name.textContent = Engine.actionToNotation(state, entry.action);
      const score = document.createElement("div");
      score.className = "candidate-score";
      score.textContent = "評価 " + Math.round(entry.score);
      li.append(name, score);
      ui.candidates.append(li);
    }
  }

  function drawBoard() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawBase();
    drawCoordinates();
    drawLegalMoves();
    drawHint();
    drawWalls();
    drawHover();
    drawPawns();
  }

  function drawBase() {
    const g = geometry;
    ctx.fillStyle = COLORS.board;
    ctx.fillRect(0, 0, g.size, g.size);

    for (let r = 0; r < Engine.SIZE; r += 1) {
      for (let c = 0; c < Engine.SIZE; c += 1) {
        const rect = cellRect(r, c);
        ctx.fillStyle = (r + c) % 2 === 0 ? COLORS.boardAlt : "#d5aa59";
        roundRect(rect.x, rect.y, rect.w, rect.h, 7);
        ctx.fill();
      }
    }

    ctx.fillStyle = COLORS.groove;
    for (let r = 0; r < Engine.WALL_SIZE; r += 1) {
      for (let c = 0; c < Engine.WALL_SIZE; c += 1) {
        const h = wallRect("h", r, c);
        const v = wallRect("v", r, c);
        ctx.globalAlpha = 0.2;
        roundRect(h.x, h.y + h.h * 0.25, h.w, h.h * 0.5, 4);
        ctx.fill();
        roundRect(v.x + v.w * 0.25, v.y, v.w * 0.5, v.h, 4);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawCoordinates() {
    const g = geometry;
    ctx.save();
    ctx.fillStyle = "rgba(31, 42, 36, 0.58)";
    ctx.font = "15px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let c = 0; c < Engine.SIZE; c += 1) {
      const x = g.start + c * g.pitch + g.cell / 2;
      ctx.fillText(String.fromCharCode(97 + c), x, g.size - 25);
    }
    for (let r = 0; r < Engine.SIZE; r += 1) {
      const y = g.start + r * g.pitch + g.cell / 2;
      ctx.fillText(String(Engine.SIZE - r), 26, y);
    }
    ctx.restore();
  }

  function drawLegalMoves() {
    if (state.winner !== null || playerTypes[state.turn] !== "human" || tool !== "move") return;
    ctx.save();
    for (const move of Engine.legalPawnMoves(state, state.turn)) {
      const rect = cellRect(move.to.r, move.to.c);
      ctx.fillStyle = COLORS.legal;
      circle(rect.x + rect.w / 2, rect.y + rect.h / 2, 16);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHint() {
    if (!analysis || !ui.showHints.checked || !analysis.bestMove) return;
    ctx.save();
    const action = analysis.bestMove;
    if (action.type === "move") {
      const rect = cellRect(action.to.r, action.to.c);
      ctx.strokeStyle = COLORS.hint;
      ctx.lineWidth = 6;
      circle(rect.x + rect.w / 2, rect.y + rect.h / 2, 22);
      ctx.stroke();
    } else {
      const rect = wallRect(action.orientation, action.r, action.c);
      ctx.fillStyle = COLORS.hint;
      roundRect(rect.x, rect.y, rect.w, rect.h, 6);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawWalls() {
    ctx.save();
    ctx.fillStyle = COLORS.wall;
    for (const value of state.hWalls) {
      const wall = Engine.parseKey(value);
      const rect = wallRect("h", wall.r, wall.c);
      roundRect(rect.x, rect.y, rect.w, rect.h, 6);
      ctx.fill();
    }
    for (const value of state.vWalls) {
      const wall = Engine.parseKey(value);
      const rect = wallRect("v", wall.r, wall.c);
      roundRect(rect.x, rect.y, rect.w, rect.h, 6);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHover() {
    if (!hover || state.winner !== null || thinking || playerTypes[state.turn] !== "human") return;
    if ((tool === "h" || tool === "v") && hover.kind === "wall") {
      const legal = Engine.legalWall(state, tool, hover.r, hover.c, state.turn);
      const rect = wallRect(tool, hover.r, hover.c);
      ctx.save();
      ctx.fillStyle = legal ? COLORS.wallGhost : COLORS.wallBad;
      roundRect(rect.x, rect.y, rect.w, rect.h, 6);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawPawns() {
    const seats = Engine.seatsForMode(state.mode);
    ctx.save();
    for (let i = 0; i < seats.length; i += 1) {
      const pawn = state.pawns[i];
      const rect = cellRect(pawn.r, pawn.c);
      const x = rect.x + rect.w / 2;
      const y = rect.y + rect.h / 2;

      ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
      circle(x + 2, y + 4, 20);
      ctx.fill();

      ctx.fillStyle = seats[i].color;
      circle(x, y, 20);
      ctx.fill();

      ctx.lineWidth = state.turn === i && state.winner === null ? 5 : 2;
      ctx.strokeStyle = state.turn === i && state.winner === null ? COLORS.accent : "rgba(0,0,0,0.26)";
      ctx.stroke();

      ctx.fillStyle = i === 0 ? "#1f2a24" : "#ffffff";
      ctx.font = "700 15px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), x, y + 1);
    }
    ctx.restore();
  }

  function hitTest(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;

    if (tool === "h" || tool === "v") {
      const wall = findWallHit(tool, x, y);
      if (wall) return wall;
    }

    for (let r = 0; r < Engine.SIZE; r += 1) {
      for (let c = 0; c < Engine.SIZE; c += 1) {
        const cell = cellRect(r, c);
        if (x >= cell.x && x <= cell.x + cell.w && y >= cell.y && y <= cell.y + cell.h) {
          return { kind: "cell", r, c };
        }
      }
    }
    return null;
  }

  function findWallHit(orientation, x, y) {
    const pad = 7;
    for (let r = 0; r < Engine.WALL_SIZE; r += 1) {
      for (let c = 0; c < Engine.WALL_SIZE; c += 1) {
        const rect = wallRect(orientation, r, c);
        if (
          x >= rect.x - pad &&
          x <= rect.x + rect.w + pad &&
          y >= rect.y - pad &&
          y <= rect.y + rect.h + pad
        ) {
          return { kind: "wall", r, c };
        }
      }
    }
    return null;
  }

  function cellRect(r, c) {
    const g = geometry;
    return {
      x: g.start + c * g.pitch,
      y: g.start + r * g.pitch,
      w: g.cell,
      h: g.cell
    };
  }

  function wallRect(orientation, r, c) {
    const g = geometry;
    if (orientation === "h") {
      return {
        x: g.start + c * g.pitch,
        y: g.start + r * g.pitch + g.cell,
        w: g.cell * 2 + g.gap,
        h: g.gap
      };
    }
    return {
      x: g.start + c * g.pitch + g.cell,
      y: g.start + r * g.pitch,
      w: g.gap,
      h: g.cell * 2 + g.gap
    };
  }

  function roundRect(x, y, w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function circle(x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  }

  function updateModeButtons() {
    for (const button of ui.modeButtons) {
      button.classList.toggle("is-active", Number(button.dataset.mode) === state.mode);
    }
  }

  function updateToolButtons() {
    for (const button of ui.toolButtons) {
      button.classList.toggle("is-active", button.dataset.tool === tool);
    }
  }

  init();
})();
