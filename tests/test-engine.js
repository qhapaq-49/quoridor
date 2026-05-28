"use strict";

const assert = require("assert");
const Engine = require("../scripts/engine.js");
const AI = require("../scripts/ai.js");

function testInitialPaths() {
  const state = Engine.createState(2);
  assert.strictEqual(Engine.shortestPath(state, 0).distance, 8);
  assert.strictEqual(Engine.shortestPath(state, 1).distance, 8);
  assert.strictEqual(Engine.legalPawnMoves(state, 0).length, 3);
}

function testWallBlockingAndOverlap() {
  let state = Engine.createState(2);
  const wall = { type: "wall", orientation: "h", r: 7, c: 4 };
  assert.ok(Engine.legalWall(state, "h", 7, 4, 0));
  state = Engine.applyAction(state, wall);
  assert.ok(Engine.blockedByWall(state, { r: 8, c: 4 }, { r: 7, c: 4 }));
  assert.ok(!Engine.legalWall(state, "h", 7, 4, 1));
  assert.ok(!Engine.legalWall(state, "h", 7, 5, 1));
  assert.ok(!Engine.legalWall(state, "v", 7, 4, 1));
}

function testJumpAndDiagonal() {
  const state = Engine.createState(2);
  state.pawns[0] = { r: 4, c: 4 };
  state.pawns[1] = { r: 3, c: 4 };
  let moves = Engine.legalPawnMoves(state, 0);
  assert.ok(moves.some((move) => move.to.r === 2 && move.to.c === 4));

  state.hWalls.add(Engine.key(2, 4));
  moves = Engine.legalPawnMoves(state, 0);
  assert.ok(!moves.some((move) => move.to.r === 2 && move.to.c === 4));
  assert.ok(moves.some((move) => move.to.r === 3 && move.to.c === 3));
  assert.ok(moves.some((move) => move.to.r === 3 && move.to.c === 5));
}

function testFourPlayerSetup() {
  const state = Engine.createState(4);
  assert.strictEqual(Engine.playerCount(state), 4);
  assert.deepStrictEqual(state.wallsRemaining, [5, 5, 5, 5]);
  for (let i = 0; i < 4; i += 1) {
    assert.strictEqual(Engine.shortestPath(state, i).distance, 8);
  }
}

function testAiLeafRecognizesImmediateLoss() {
  const state = Engine.createState(2);
  state.moveNumber = 30;
  state.turn = 0;
  state.pawns = [{ r: 4, c: 4 }, { r: 7, c: 4 }];
  state.wallsRemaining = [5, 5];

  const quietMove = { type: "move", player: 0, to: { r: 3, c: 4 } };
  const losingChild = Engine.applyKnownLegalAction(state, quietMove);
  assert.strictEqual(AI.evaluate(losingChild, 0), -96000);

  const result = AI.analyze(state, {
    timeLimit: 100000,
    maxDepth: 1,
    wallLimit: 8,
    randomness: 0,
    rootPlayer: 0
  });
  assert.strictEqual(result.bestMove.type, "wall");
  const blockedChild = Engine.applyKnownLegalAction(state, result.bestMove);
  assert.ok(!Engine.legalPawnMoves(blockedChild, 1).some((move) => move.to.r === 8));
}

function testAiNoWallRaceUsesTempo() {
  const rootTurn = Engine.createState(2);
  rootTurn.moveNumber = 80;
  rootTurn.turn = 0;
  rootTurn.pawns = [{ r: 2, c: 4 }, { r: 6, c: 4 }];
  rootTurn.wallsRemaining = [0, 0];

  const opponentTurn = Engine.cloneState(rootTurn);
  opponentTurn.turn = 1;

  assert.ok(AI.evaluate(rootTurn, 0) > 500);
  assert.ok(AI.evaluate(opponentTurn, 0) < -500);
}

function testAiAvoidsSevereWallTrapAtLeaf() {
  let state = Engine.createState(2);
  const actions = [
    { type: "move", to: { r: 7, c: 4 } },
    { type: "move", to: { r: 1, c: 4 } },
    { type: "move", to: { r: 6, c: 4 } },
    { type: "wall", orientation: "h", r: 5, c: 4 },
    { type: "move", to: { r: 6, c: 3 } },
    { type: "wall", orientation: "h", r: 5, c: 2 }
  ];
  for (const action of actions) state = Engine.applyAction(state, action);

  const fragileRun = { type: "move", player: 0, to: { r: 6, c: 2 } };
  const result = AI.analyze(state, {
    timeLimit: 100000,
    maxDepth: 1,
    wallLimit: 8,
    randomness: 0,
    rootPlayer: 0
  });

  assert.strictEqual(result.bestMove.type, "move");
  assert.ok(!Engine.actionEquals(result.bestMove, fragileRun));
}

function testAiPrefersGateWallToContactWall() {
  let state = Engine.createState(2);
  const actions = [
    { type: "move", to: { r: 7, c: 4 } },
    { type: "move", to: { r: 1, c: 4 } },
    { type: "move", to: { r: 6, c: 4 } },
    { type: "move", to: { r: 2, c: 4 } },
    { type: "wall", orientation: "h", r: 2, c: 3 },
    { type: "wall", orientation: "h", r: 1, c: 5 },
    { type: "move", to: { r: 5, c: 4 } },
    { type: "move", to: { r: 2, c: 5 } },
    { type: "move", to: { r: 4, c: 4 } },
    { type: "move", to: { r: 3, c: 5 } }
  ];
  for (const action of actions) state = Engine.applyAction(state, action);

  const result = AI.analyze(state, {
    timeLimit: 100000,
    maxDepth: 2,
    wallLimit: 6,
    randomness: 0,
    rootPlayer: 0
  });

  assert.strictEqual(result.bestMove.type, "wall");
  assert.strictEqual(result.bestMove.orientation, "h");
  assert.strictEqual(result.bestMove.r, 4);
  assert.strictEqual(result.bestMove.c, 5);
}

function testAiConvertsWallLeadWithPawnMove() {
  let state = Engine.createState(2);
  const actions = [
    { type: "move", to: { r: 7, c: 4 } },
    { type: "move", to: { r: 1, c: 4 } },
    { type: "move", to: { r: 6, c: 4 } },
    { type: "move", to: { r: 2, c: 4 } },
    { type: "wall", orientation: "h", r: 2, c: 3 },
    { type: "wall", orientation: "h", r: 1, c: 5 },
    { type: "move", to: { r: 5, c: 4 } },
    { type: "wall", orientation: "h", r: 0, c: 0 },
    { type: "move", to: { r: 4, c: 4 } },
    { type: "wall", orientation: "v", r: 3, c: 4 }
  ];
  for (const action of actions) state = Engine.applyAction(state, action);

  const shallow = AI.analyze(state, {
    timeLimit: 100000,
    maxDepth: 2,
    wallLimit: 6,
    randomness: 0,
    rootPlayer: 0
  });
  assert.strictEqual(shallow.bestMove.type, "move");

  const result = AI.analyze(state, {
    timeLimit: 100000,
    maxDepth: 3,
    wallLimit: 6,
    randomness: 0,
    rootPlayer: 0
  });

  assert.strictEqual(result.bestMove.type, "move");
  assert.deepStrictEqual(result.bestMove.to, { r: 5, c: 4 });
}

function testAiMaintainsTempoWithLargeWallLead() {
  let state = Engine.createState(2);
  const actions = [
    { type: "move", to: { r: 7, c: 4 } },
    { type: "move", to: { r: 1, c: 4 } },
    { type: "move", to: { r: 6, c: 4 } },
    { type: "move", to: { r: 2, c: 4 } },
    { type: "wall", orientation: "h", r: 2, c: 3 },
    { type: "wall", orientation: "h", r: 1, c: 5 },
    { type: "move", to: { r: 5, c: 4 } },
    { type: "wall", orientation: "h", r: 0, c: 0 },
    { type: "move", to: { r: 4, c: 4 } },
    { type: "wall", orientation: "v", r: 3, c: 4 },
    { type: "move", to: { r: 5, c: 4 } },
    { type: "wall", orientation: "v", r: 2, c: 5 }
  ];
  for (const action of actions) state = Engine.applyAction(state, action);

  const result = AI.analyze(state, {
    timeLimit: 100000,
    maxDepth: 3,
    wallLimit: 6,
    randomness: 0,
    rootPlayer: 0
  });

  assert.strictEqual(result.bestMove.type, "move");
  assert.deepStrictEqual(result.bestMove.to, { r: 5, c: 5 });
}

function testAiPreservesCentralRouteWithWallLead() {
  let state = Engine.createState(2);
  const actions = [
    { type: "move", to: { r: 7, c: 4 } },
    { type: "move", to: { r: 1, c: 4 } },
    { type: "move", to: { r: 6, c: 4 } },
    { type: "move", to: { r: 2, c: 4 } },
    { type: "wall", orientation: "h", r: 2, c: 3 },
    { type: "wall", orientation: "h", r: 1, c: 5 },
    { type: "move", to: { r: 5, c: 4 } },
    { type: "wall", orientation: "h", r: 0, c: 0 },
    { type: "move", to: { r: 4, c: 4 } },
    { type: "wall", orientation: "v", r: 3, c: 4 },
    { type: "move", to: { r: 5, c: 4 } },
    { type: "wall", orientation: "v", r: 2, c: 5 },
    { type: "move", to: { r: 5, c: 5 } },
    { type: "wall", orientation: "h", r: 1, c: 3 }
  ];
  for (const action of actions) state = Engine.applyAction(state, action);

  const result = AI.analyze(state, {
    timeLimit: 100000,
    maxDepth: 3,
    wallLimit: 6,
    randomness: 0,
    rootPlayer: 0
  });

  assert.strictEqual(result.bestMove.type, "move");
  assert.deepStrictEqual(result.bestMove.to, { r: 5, c: 4 });
}

function testAiTurnsTempoLeadIntoGateWall() {
  let state = Engine.createState(2);
  const actions = [
    { type: "move", to: { r: 7, c: 4 } },
    { type: "move", to: { r: 1, c: 4 } },
    { type: "move", to: { r: 6, c: 4 } },
    { type: "wall", orientation: "v", r: 4, c: 3 },
    { type: "move", to: { r: 5, c: 4 } },
    { type: "move", to: { r: 2, c: 4 } },
    { type: "move", to: { r: 4, c: 4 } },
    { type: "wall", orientation: "h", r: 3, c: 4 },
    { type: "move", to: { r: 5, c: 4 } },
    { type: "move", to: { r: 3, c: 4 } },
    { type: "wall", orientation: "v", r: 2, c: 3 },
    { type: "move", to: { r: 3, c: 5 } },
    { type: "wall", orientation: "v", r: 2, c: 5 },
    { type: "wall", orientation: "v", r: 4, c: 4 }
  ];
  for (const action of actions) state = Engine.applyAction(state, action);

  const result = AI.analyze(state, {
    timeLimit: 100000,
    maxDepth: 2,
    wallLimit: 6,
    randomness: 0,
    rootPlayer: 0
  });

  assert.strictEqual(result.bestMove.type, "wall");
  assert.strictEqual(result.bestMove.orientation, "v");
  assert.strictEqual(result.bestMove.r, 0);
  assert.strictEqual(result.bestMove.c, 5);
}

function testAiPrefersSecondStepGateInEvenRace() {
  let state = Engine.createState(2);
  const actions = [
    { type: "move", to: { r: 7, c: 4 } },
    { type: "move", to: { r: 1, c: 4 } },
    { type: "move", to: { r: 6, c: 4 } },
    { type: "wall", orientation: "h", r: 5, c: 3 },
    { type: "move", to: { r: 6, c: 5 } },
    { type: "move", to: { r: 2, c: 4 } },
    { type: "move", to: { r: 5, c: 5 } },
    { type: "move", to: { r: 3, c: 4 } },
    { type: "move", to: { r: 4, c: 5 } },
    { type: "move", to: { r: 4, c: 4 } },
    { type: "move", to: { r: 3, c: 5 } },
    { type: "wall", orientation: "h", r: 1, c: 4 },
    { type: "move", to: { r: 2, c: 5 } },
    { type: "wall", orientation: "v", r: 2, c: 5 },
    { type: "wall", orientation: "h", r: 5, c: 5 },
    { type: "wall", orientation: "v", r: 2, c: 4 },
    { type: "wall", orientation: "h", r: 5, c: 1 }
  ];
  for (const action of actions) state = Engine.applyAction(state, action);

  const result = AI.analyze(state, {
    timeLimit: 100000,
    maxDepth: 2,
    wallLimit: 6,
    randomness: 0,
    rootPlayer: 1
  });

  assert.strictEqual(result.bestMove.type, "wall");
  assert.strictEqual(result.bestMove.orientation, "h");
  assert.strictEqual(result.bestMove.r, 0);
  assert.strictEqual(result.bestMove.c, 5);
}

function testAiReturnsLegalMove() {
  const state = Engine.createState(2);
  const result = AI.analyze(state, {
    strength: "fast",
    timeLimit: 60,
    maxDepth: 1,
    randomness: 0,
    rootPlayer: 0
  });
  assert.ok(result.bestMove);
  assert.ok(Engine.isLegalAction(state, result.bestMove, 0));
}

testInitialPaths();
testWallBlockingAndOverlap();
testJumpAndDiagonal();
testFourPlayerSetup();
testAiLeafRecognizesImmediateLoss();
testAiNoWallRaceUsesTempo();
testAiAvoidsSevereWallTrapAtLeaf();
testAiPrefersGateWallToContactWall();
testAiConvertsWallLeadWithPawnMove();
testAiMaintainsTempoWithLargeWallLead();
testAiPreservesCentralRouteWithWallLead();
testAiTurnsTempoLeadIntoGateWall();
testAiPrefersSecondStepGateInEvenRace();
testAiReturnsLegalMove();

console.log("engine tests passed");
