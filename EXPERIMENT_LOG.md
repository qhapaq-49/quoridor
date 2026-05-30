# Quoridor AI Experiment Log

This file keeps the tuning history readable after the fact. Benchmarks are small-sample regression checks, not rating claims.

## Baseline Before This Log

Commit `6827078 Account for opponent wall race pressure` is the current stable baseline.

- Added conditional widening of root wall candidates when we have a large wall lead and the opponent is close enough to need stronger blocking.
- Added a penalty for spending all walls while the opponent still has walls and the race lead is not large enough.
- Known checks at that point:
  - gori 2,500 seed 300: 2-0.
  - gori 7,500 seeds 301/520/700/900: 6-2 total.
  - gori 20,000 seeds 132/500/740: 4-2 total, breakdown 2-0, 1-1, 1-1.
  - gori 60,000 seed 123: 1-0.
  - Self-play versus previous version: 11-5.

## 2026-05-30 Continued Tuning

### Exact Pawn Race Earlier

Idea: once both players have no walls, use the exact pawn-race solver immediately instead of waiting until move 44.

Results:

- No move threshold: gori 20,000 seeds 132/500/740 stayed 4-2, and self-play versus `HEAD` was 8-8.
- However, artificial tests with very early wall exhaustion became much slower.
- Threshold `moveNumber >= 36`: tests returned to acceptable time, but gori 20,000 seeds 132/500/740 fell to 3-3.

Decision: rejected for now. The idea is correct for real endgames, but the current implementation needs a cheaper trigger or cache strategy before it is safe as default.

### Route Width Static Evaluation

Idea: reward having more edges on our shortest-path DAG than the opponent, because robust routes should be harder to block.

Implementation tried:

- Added `routeWidth2p` / `routeWidth4p`.
- Evaluated `shortestPathEdgeInfo(...).edges.length` for root and opponents.

Results:

- gori 20,000 seed 740 improved to 2-0.
- gori 20,000 seed 132 collapsed to 0-2.
- seed 500 stayed 1-1.

Decision: rejected. The feature overvalued wide-looking routes in positions where the concrete race or wall economy mattered more.

### Gori-Style No-Wall Endgame Branch Restriction

Idea copied from gorisanson/quoridor-ai: when the opponent has no walls, restrict our pawn moves to shortest-path progress and keep only walls that actually extend the opponent route.

Results:

- Self-play versus `HEAD`: 8-8.
- gori 20,000 seed 132: 1-1.
- gori 20,000 seed 740: 0-2.

Decision: rejected. This heuristic is good for gori's MCTS branching factor, but it hurt our alpha-beta move selection.

### Weight Sweeps Around Wall Economy And Route Choice

Tried several static-eval weight bundles:

- Higher `wallPressure2p`, `wallLead`, `opponentWallRaceBuffer`.
- Higher race/distance terms.
- Higher no-wall race penalties.
- Higher `opponentNoImprovingBonus`, `noImprovingPenalty`, `crampedPenalty`.
- Higher center and wall-lead route terms.

Results:

- Most bundles lost self-play directly.
- The route-cramping bundle reached self-play 10-6 once, but then lost to gori checks: seed 132 became 1-1 and seed 500 became 0-2.
- Strong wall-value bundle was self-play 5-11 and seed 132 only 1-1.

Decision: rejected. The current evaluator is already near a fragile balance; broad static weight shifts tend to break known gori wins.

### Rollout Verification Of Top Alpha-Beta Moves

Idea: after alpha-beta ranks the top moves, run short randomized rollouts to detect walls that look good statically but lose long-term.

Results:

- Self-play: 7-9.
- gori 20,000 seed 500: 1-1.
- gori 20,000 seed 132: 0-2.

Decision: rejected. The rollout policy is too noisy and misranks known-good tactical choices.

### Midgame Wall-Deficit Penalty

Observed losing pattern: in seed 500, the AI spent walls while already far behind in wall count, producing only a modest path lead and then losing the pawn race.

Tried targeted root wall penalty:

- Only after the move would leave us down at least three walls.
- Only in midgame.
- Only when the resulting path lead was not enough to justify the wall deficit.

Results:

- The targeted losing position changed from a wall to a pawn move.
- Self-play: 9-7.
- gori 20,000 seed 132: 1-1.
- gori 20,000 seed 500: 1-1.

Decision: rejected. It fixed the local symptom, but gave back an existing win and did not improve total gori score.

### Opening Book Variants

Tried forcing the existing opening wall variants instead of the default first legal candidate.

Results on gori 20,000 seed 500:

- Variant 1: 0-2.
- Variant 2: 0-2.
- Variant 3: 1-1.

Follow-up for variant 3:

- seed 132: 1-1.
- seed 740: 1-1.

Decision: rejected. Variant 3 was not bad, but it did not beat the default known set.

### Experimental MCTS Engine

Rechecked the separate `scripts/experimental-mcts.js` engine.

Results:

- gori 7,500 seed 301: 0-2.
- gori 20,000 seed 500: 0-2.

Decision: rejected as the main engine. Our alpha-beta remains much stronger.

### Shallow Wall Candidate Limit

Idea: reduce wall candidates near the leaves so the fixed time limit reaches more complete depth and avoids noisy partial depth-4 searches.

Results:

- `shallowWallLimit=4`: gori 20,000 seeds 500/132/740 were 2-0, 1-1, 1-1; self-play 9-7.
- `replyWallLimit=5, shallowWallLimit=4`: seed 500 fell to 1-1; seed 132 stayed 1-1; self-play 9-7.
- `shallowWallLimit=3`: initially looked strong at 2-0, 2-0, 1-1, but preset and single reruns were unstable, including seed 500 falling to 0-2 or 1-1.

Decision: rejected for now. This may still be useful, but time-limit instability makes the apparent gain unreliable.

### Max Depth 3

Idea: a complete shallower search might beat partial depth 4.

Results:

- gori 20,000 seed 740: 0-2.
- seed 132: 1-1.

Decision: rejected. Depth 4 remains necessary despite partial completion.

### Quiescence Action Adjustment

Idea: regular search adds `actionAdjustment`, but quiescence did not. Tried applying it there too for consistency.

Results:

- `npm run check` and `npm test` passed.
- gori 20,000 seed 132: 1-1.
- gori 20,000 seed 500: 0-2.

Decision: rejected. The adjustment terms are tuned for normal search nodes and overbias quiescence tactical lines.

### Batch Gori Measurement Harness

Problem: several late-stage tuning attempts looked good on one or two seeds, then regressed on another known seed or on rerun. The old one-command benchmark made larger checks cumbersome.

Change:

- Added `scripts/batch-gorisanson.js`.
- It runs `scripts/benchmark-gorisanson.js` over a seed list or seed range.
- It prints per-seed JSON summaries and an aggregate summary.
- It can append JSONL logs with `--out`, so exact benchmark conditions and results can be revisited later.
- Added `--record-games` after the first batch showed rerun instability; this stores per-game records and moves for loss review.

Decision: adopted. This is measurement infrastructure, not a playing-strength change.

First larger baseline with the new runner:

- `benchmarks/gori2500_baseline_20260530.jsonl`
- gori 2,500, seeds 1000..1007, 2 games per seed: 13-3, win rate 81.25%.
- Draws: 0. Light wins: 7. Dark wins: 6.
- Average ours: 455.5ms/move. Average gori: 478.7ms/move.
- Seeds 1000, 1005, and 1006 were only 1-1, so even 2.5k is not yet a solved baseline.


### Early Forward-Wall Trap Penalty

Observed pattern: gori 2,500 seed 1005 could bait our pawn into an early side step, then immediately place a front wall and force retreating moves. The shallow search sometimes chose that side step under the 950ms limit even though a longer trace preferred a wall.

Change:

- In early 2-player positions where we have a tempo lead and no meaningful wall lead, penalize pawn moves that increase our shortest distance.
- Also penalize such early pawn moves when the opponent has an immediate legal front wall that would lengthen our route by at least two steps.

Results:

- Targeted seed 1005 trace after `O:e2 G:e8 O:e3 G:Hd3`: 950ms search changed the problematic `f3` choice to `Hf2`.
- gori 2,500 seed 1005 record rerun: 1-1 after the prior recorded 0-2.
- gori 2,500 seeds 1000..1007, 2 games each: 14-2, win rate 87.5%, average ours 492.3ms/move, average gori 761.8ms/move. The stable baseline on the same set was 13-3.
- gori 20,000 seeds 132/500/740, 2 games each: 4-2, average ours 475.7ms/move, average gori 2995.4ms/move.

Decision: adopted cautiously. It is a real improvement on the larger 2,500 set and does not regress the known 20,000 set, but the gain is still small and time-limit instability remains visible.

### Replay Line Analysis Tool

Added `scripts/replay-line.js` to replay a recorded benchmark game and print our candidate ranking at each selected turn without rerunning gorisanson. This exposed a seed 500 loss where a 120ms/depth-1 view preferred `g5`, while a deeper 600ms/depth-2 view preferred `e4`.

Decision: adopted as analysis tooling. It makes loss review cheaper and helps separate evaluation errors from incomplete-search instability.

### Rejected Race-Behind Trap Extension

Idea: extend the front-wall trap penalty to cases where we are already behind in the pawn race, so the seed 500 `g5` jump would be rejected even at shallow depth.

Result:

- Local replay changed the shallow seed 500 choice from `g5` to `e4`.
- But gori 20,000 seed 500 immediately regressed to 0-2.

Decision: rejected. The local symptom was real, but the broader condition broke other play.

## Lessons So Far

- Local tactical fixes often repair one visible loss and break a previous win. gori seeds 132/500/740 should stay in the minimum regression set.
- Small self-play leads such as 9-7 or 10-6 are not enough when gori checks regress.
- Time-limit alpha-beta results can be unstable under system load. Promising changes need single-process reruns before adoption.
- gorisanson's heuristics are useful as ideas, but MCTS branching heuristics do not transfer directly to our alpha-beta evaluator.
- The strongest next direction is probably a more principled evaluation feature or a faster deterministic search, not more scalar weight nudging.
