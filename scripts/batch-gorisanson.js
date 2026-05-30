"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const args = {
    seeds: [],
    seedStart: 1,
    seedCount: 0,
    gamesPerSeed: 2,
    out: null,
    passThrough: []
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--seeds") {
      args.seeds = parseSeeds(next);
      i += 1;
    } else if (arg === "--seed-start") {
      args.seedStart = Number(next);
      i += 1;
    } else if (arg === "--seed-count") {
      args.seedCount = Number(next);
      i += 1;
    } else if (arg === "--games-per-seed") {
      args.gamesPerSeed = Number(next);
      i += 1;
    } else if (arg === "--out") {
      args.out = next;
      i += 1;
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      args.passThrough.push(arg);
      if (next !== undefined && !next.startsWith("--")) {
        args.passThrough.push(next);
        i += 1;
      }
    }
  }

  if (args.seeds.length === 0) {
    if (!Number.isFinite(args.seedCount) || args.seedCount <= 0) {
      throw new Error("Provide --seeds or --seed-count.");
    }
    for (let i = 0; i < args.seedCount; i += 1) args.seeds.push(args.seedStart + i);
  }
  if (!Number.isFinite(args.gamesPerSeed) || args.gamesPerSeed <= 0) {
    throw new Error("--games-per-seed must be positive.");
  }
  return args;
}

function parseSeeds(text) {
  return text.split(",").flatMap((part) => {
    const trimmed = part.trim();
    if (!trimmed) return [];
    const range = trimmed.match(/^(-?\d+)\.\.(-?\d+)$/);
    if (!range) return [Number(trimmed)];
    const start = Number(range[1]);
    const end = Number(range[2]);
    const step = start <= end ? 1 : -1;
    const values = [];
    for (let value = start; value !== end + step; value += step) values.push(value);
    return values;
  });
}

function printHelp() {
  console.log(`Usage: node scripts/batch-gorisanson.js [batch options] [benchmark options]

Batch options:
  --seeds LIST          Comma list or ranges, e.g. 132,500,740 or 100..119
  --seed-start N        First seed when using --seed-count
  --seed-count N        Number of consecutive seeds
  --games-per-seed N    Games per seed, default 2
  --out PATH            Write JSONL log to PATH

All other options are passed to scripts/benchmark-gorisanson.js.

Example:
  node scripts/batch-gorisanson.js --seeds 132,500,740 --games-per-seed 2 --rollouts 20000 --our-randomness 0 --our-time-limit 950 --our-max-depth 4 --quiet --out benchmarks/gori20k.jsonl
`);
}

function runSeed(args, seed) {
  const childArgs = [
    path.join("scripts", "benchmark-gorisanson.js"),
    "--seed", String(seed),
    "--games", String(args.gamesPerSeed),
    ...args.passThrough
  ];
  if (!childArgs.includes("--quiet")) childArgs.push("--quiet");

  const started = Date.now();
  const result = spawnSync(process.execPath, childArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32
  });
  const durationMs = Date.now() - started;

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error("benchmark failed for seed " + seed + " with status " + result.status);
  }

  const lines = result.stdout.trim().split(/\n+/).filter(Boolean);
  const records = lines.map((line) => JSON.parse(line));
  const summaryRecord = records.find((record) => record.type === "summary");
  if (!summaryRecord) throw new Error("No summary line for seed " + seed);
  return {
    type: "seed",
    seed,
    durationMs,
    summary: summaryRecord.summary
  };
}

function aggregate(seedRecords) {
  const totals = seedRecords.reduce((acc, record) => {
    const summary = record.summary;
    acc.games += summary.games;
    acc.wins += summary.wins;
    acc.losses += summary.losses;
    acc.draws += summary.draws;
    acc.lightWins += summary.lightWins;
    acc.darkWins += summary.darkWins;
    acc.weightedPlies += summary.avgPlies * summary.games;
    acc.weightedOurThink += summary.avgOurThinkMs * summary.games;
    acc.weightedGoriThink += summary.avgGorisansonThinkMs * summary.games;
    acc.weightedDepth += summary.avgOurDepth * summary.games;
    acc.weightedNodes += summary.avgOurNodes * summary.games;
    acc.durationMs += record.durationMs;
    return acc;
  }, {
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    lightWins: 0,
    darkWins: 0,
    weightedPlies: 0,
    weightedOurThink: 0,
    weightedGoriThink: 0,
    weightedDepth: 0,
    weightedNodes: 0,
    durationMs: 0
  });

  return {
    type: "summary",
    seeds: seedRecords.length,
    games: totals.games,
    wins: totals.wins,
    losses: totals.losses,
    draws: totals.draws,
    winRate: totals.games ? totals.wins / totals.games : 0,
    lightWins: totals.lightWins,
    darkWins: totals.darkWins,
    avgPlies: divide(totals.weightedPlies, totals.games),
    avgOurThinkMs: divide(totals.weightedOurThink, totals.games),
    avgGorisansonThinkMs: divide(totals.weightedGoriThink, totals.games),
    avgOurDepth: divide(totals.weightedDepth, totals.games),
    avgOurNodes: divide(totals.weightedNodes, totals.games),
    durationMs: totals.durationMs
  };
}

function divide(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function appendLine(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
}

function main() {
  const args = parseArgs(process.argv);
  const config = {
    type: "config",
    seeds: args.seeds,
    gamesPerSeed: args.gamesPerSeed,
    passThrough: args.passThrough,
    startedAt: new Date().toISOString()
  };
  console.log(JSON.stringify(config));
  if (args.out) appendLine(args.out, config);

  const seedRecords = [];
  for (const seed of args.seeds) {
    const record = runSeed(args, seed);
    seedRecords.push(record);
    console.log(JSON.stringify(record));
    if (args.out) appendLine(args.out, record);
  }

  const summary = aggregate(seedRecords);
  console.log(JSON.stringify(summary));
  if (args.out) appendLine(args.out, summary);
}

if (require.main === module) main();
