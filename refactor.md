# Parser Refactor Notes

## Goal

Refactor `src/parser.ts` so the main parser loop is easier to read, easier to extend, and easier to reason about.

The target shape is:

- parse line
- recognize event
- hand event to stateful object
- move on

## Current Structure

The parser currently mixes 4 different layers in one file:

1. Stateful orchestration
   - `parseMatchLog`
   - controls sequencing, round lifecycle, and parser state

2. Low-level string parsing
   - line splitting
   - quoted value extraction
   - player token parsing
   - number extraction

3. Event recognition
   - `extractKillEvent`
   - `extractAssistEvent`
   - `extractUtilityPurchaseEvent`
   - `extractBombPlantEvent`
   - `extractGameOver`
   - etc.

4. Stateful mutation / aggregation
   - player upserts
   - round creation/finalization
   - stat accumulation
   - pending utility purchase buffering
   - team organization tracking

## Refactor Direction

The intended refactor is:

- treat the low-level parsing portion as an internal parsing foundation
- build domain-specific event extractors on top of that foundation
- keep those layers functional and as pure as possible
- isolate the mutation-heavy parts of state aggregation behind a small number of stateful objects

This is not a plan to convert everything to classes.

Classes should only be introduced where they help contain long-lived mutable state and enforce lifecycle rules.

Another way to describe the target architecture is:

1. parsing foundation
2. domain event extraction
3. stateful accumulation
4. top-level orchestration

This makes it possible to compose the application on top of a reusable internal parsing layer instead of keeping everything intertwined in one large module.

## Recommended Boundaries

### Keep as functions

- string/token parsing helpers
- event extractors
- normalization helpers
- small stat helpers
- derived value calculators
- plain data mappers

Examples:

- `parseLineIntoParts`
- `extractQuotedValue`
- `extractQuotedNumber`
- `extractNextPlayerToken`
- `parsePlayerToken`
- `normalizeSide`
- `normalizeThrownUtilityName`
- `extractKillEvent`
- `extractAttackEvent`
- `extractUtilityThrowEvent`
- `calculateAdr`
- `calculateHeadshotPercentage`
- `deriveRoundWinReason` if it can remain pure

### Good class candidates

- `MatchAccumulator`
  - owns match-level mutable state
  - examples: `players`, `rounds`, `currentRound`, `teamOrganizations`, `pendingUtilityPurchases`, `hasLiveMatchStarted`, `isRoundLive`, `latestRoundsPlayed`

- `RoundAccumulator`
  - owns active round mutable state
  - examples: round score, bomb info, kills/deaths/assists/damage, round player records, win outcome

### Possible future class candidate

- `PlayerRegistry`
  - only if player lifecycle logic grows enough to justify its own abstraction
  - not required from the start

## Design Principle

Use a class when the code is about:

- current state
- allowed state transitions
- side effects of those transitions
- protecting invariants

Use a function when the code is about:

- parsing a string
- recognizing an event
- normalizing a value
- computing a derived result

## Why This Helps

Right now the main loop does both of these at once:

- determine what kind of line it is
- directly mutate several pieces of state

That makes the loop large and mentally expensive.

The refactor should move it toward a clearer flow where the loop mostly orchestrates:

1. parse the raw line
2. identify the event or signal
3. pass it to the match/round state object
4. continue

This keeps mutation from floating around the main loop.

It also creates a clearer layering model:

- a reusable internal parsing foundation for tokenization, extraction, and normalization
- a domain-specific event layer built on top of those parsing primitives
- an application/state layer that decides how recognized events affect match state

That makes the parser easier to compose from smaller pieces, and makes it possible for other code to reuse the parsing/event recognition layers without depending on match lifecycle state.

## Suggested Module Shape

One reasonable target structure:

- `parser.ts`
  - `parseMatchLog`
  - top-level orchestration only

- `parser-types.ts`
  - public types
  - shared internal types if needed

- `parser-core/`
  - reusable parsing primitives
  - line parsing
  - quoted value helpers
  - number extraction
  - player token parsing
  - primitive normalization

- `parser-events/`
  - domain-specific event extractors
  - kill/assist/attack/bomb/utility/team/match event recognition built on top of `parser-core`

- `parser-state/`
  - `MatchAccumulator`
  - `RoundAccumulator`
  - match-level mutable state and lifecycle methods
  - active-round mutation and finalization logic

- `parser-derived.ts`
  - pure derived calculations and final shaping helpers

This structure reflects the intended dependency direction:

1. `parser-core` knows nothing about match state
2. `parser-events` depends on `parser-core`
3. `parser-state` depends on parsed/recognized information, not raw strings
4. `parser.ts` wires everything together

This can be collapsed or split further depending on how large the extractor layer becomes.

## Important Constraint

Avoid turning the current large module into one large class.

The goal is not “make parser.ts object-oriented”.

The goal is:

- keep most code functional
- make the parsing foundation reusable inside the codebase
- introduce only a few stateful objects where mutation is dense
- make the parser loop read like orchestration instead of state surgery

## Intended Outcome

After the refactor, the parser should be:

- easier to scan
- easier to extend with new event types
- easier to test in smaller pieces
- easier to reason about because parsing and mutation are separated

The core idea is to isolate mutation into a few well-chosen accumulator-style objects while keeping the parsing and extraction layers mostly pure.

The architectural idea is to build a small internal parsing stack that application logic can compose on top of:

- parsing foundation
- event extraction
- stateful accumulation
- final orchestration
