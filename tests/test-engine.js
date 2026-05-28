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
testAiReturnsLegalMove();

console.log("engine tests passed");
