# Play-Calling & Playbook Overhaul — Phased Plan

A roadmap to make play-calling **matter** — so reading the defense and picking the
right answer is rewarded — and to make the plays themselves **fit the game's
NFL-Blitz arcade identity** (fast, over-the-top, signature concepts, ON FIRE).
Grounded in the current systems in `src/main.js`.

> Lane note (per `CLAUDE.md`): ENGINE/MECHANICS lane. Stays out of `src/audio.js`
> etc.; new result/announcer call-outs are hooks handed to the AUDIO session.
> Re-read `docs/BLITZ_REFERENCE.md` for look/feel before any aesthetic work. The
> play-select UI changes here should align with `docs/ui-ux-overhaul-plan.md`
> (Phase 6) so the two efforts share one card/tab system.

---

## 1. The system today, diagnosed

| Piece | Where | State |
|-------|-------|-------|
| Offense playbook | `PLAYS` ~2228 | **6 plays** (BOMBS/SLANTS/MESH/FLOOD + DIVE/SWEEP), each a `route(e, sx, los)` returning 2–3 coarse waypoints. |
| Formations | `OFF_FORM` ~2207, `DEF_FORM` ~2216 | **One** offensive + **one** defensive formation; plays only swap routes. |
| Defense playbook | `DEF_PLAYS` ~3364, `applyDefCall()` ~4609 | **4 calls** (MAN/ZONE/BLITZ/SPY) as small tweaks over a man base. |
| Selection | `choosePlay()` ~3425, `#playselect` cards | User picks offense play OR defense call by possession; 4 cards/page pager. |
| CPU calling | `snap()` ~4640/4654 | **Purely random** — no down/distance/score/tendency logic. |
| Outcome | route AI + `tryReception()` ~5466 | Catch resolves on separation/coverage tightness/ratings; concept-vs-coverage is only implicit geometry. |
| Play art | `makePlayArtSVG()` ~2285, `defenseArtPlan()` ~883 | Routes drawn from the real `route()` fns; coverage art from the def call. |

**Three reasons play-calling doesn't "matter" enough:**

1. **No explicit concept ⇄ coverage matchup.** With only 6 plays × 4 coverages and
   no leverage model, "the right call vs this look" isn't rewarded — outcomes ride
   on raw geometry + a dice roll, not on the *decision*.
2. **The opponent doesn't think.** Random CPU calls mean your defensive call isn't
   answering a tendency, and the CPU never punishes a bad offensive matchup.
3. **No feedback on *why*.** The result readout shows yards, never the reason
   ("MESH beat man!", "Blitz got home", "Cover-2 took the top off"), so players
   can't learn the read.

Plus: **one formation + tiny routes** means the pre-snap picture never varies and
the plays lack the signature arcade identity the rest of the game has.

**Worth keeping:** the data-driven `route()` model is elegant and the art is
auto-generated from it — extend that pattern rather than replace it.

---

## 2. Design goals

1. **Decisions are rewarded.** The *call* (not just stick skill) measurably swings
   success — a coverage beater gets someone open; a bad matchup gets stuffed.
2. **Legible.** The player can read the look pre-snap and is told the result's
   cause after — so they learn the rock-paper-scissors.
3. **Arcade-Blitz identity.** Punchy concepts with clear personalities, signature
   gadget plays, ON FIRE specials — not a sim playbook.
4. **Both sides have a real game.** Offense AND defense calls each carry
   risk/reward; a thinking CPU makes your calls answer something.
5. **Extends the existing data model**, so art/AI keep working for free.

---

## Phase 0 — Foundation: richer play data model + formations

**Goal:** the scaffolding everything else needs. Behavior unchanged; structure
upgraded.

- **Promote plays to objects with metadata** (keep `route()` for waypoints):
  `{ name, sub, formation, personnel, type: 'pass'|'run'|'rpo'|'trick',
  concept, beats: [...coverages], losesTo: [...coverages], tags, route() }`.
  Backfill the existing 6 with sensible `beats`/`losesTo` (e.g. MESH beats MAN,
  FLOOD beats ZONE, BOMBS beats single-high/BLITZ, SLANTS beat BLITZ).
- **Multiple formations:** a `FORMATIONS` table (Trips, Bunch, Spread, Empty,
  I/Singleback for runs) replacing the single `OFF_FORM`; each play references a
  formation so the pre-snap alignment varies. `makePlayArtSVG` already iterates
  `OFF_FORM` — point it at the play's formation.
- **Defense plays to objects** too: `{ name, shell, blitzers, beats, losesTo,
  pressure, deepHelp }` so coverages carry the same matchup metadata.
- **Per-route assignments** structure (so Phase 4 hot-routes/audibles can swap a
  single man's route without rewriting the concept).

**Done when:** the same 6 plays run identically, but each carries formation +
matchup metadata and the formation table drives alignment. **Risk:** Low–Med
(mechanical refactor). Validate with `node --check` + init harness + playwright.

---

## Phase 1 — Concept ⇄ coverage matchup (the "it matters" core)

**Goal:** make the *call itself* swing the play, legibly.

- **Leverage model:** at snap, compare the offensive concept's `beats/losesTo`
  with the defensive call. Apply a tangible **leverage** to the matched routes —
  not a hidden dice nudge but visible separation: a coverage-beating route gets a
  cleaner break / a step of cushion (tweak its waypoints or the covering
  defender's reaction delay), a bad matchup gets blanketed. Feeds naturally into
  the existing `tryReception()` separation math.
- **Defensive call bite (risk/reward both ways):**
  - **BLITZ** — real pressure (faster `cpuQBTimer`/sack window via `checkSack`)
    but vacates a zone → big-play window if the offense has the answer.
  - **ZONE** — squeezes deep, soft underneath (rewards FLOOD/curls).
  - **MAN** — tight, but beaten by rubs/crossers (MESH) and pure speed.
  - **SPY** — contains scrambles/RPO, lighter elsewhere.
- **Pre-snap read:** surface a coverage *shell* hint (single/two-high, blitz
  show) using the existing `defenseArtPlan()` so a good read is possible.
- **Result reason:** after the play, a one-line cause routed through the existing
  banner/`#playresult` — "MESH beat man!", "Blitz got home — SACK", "Cover-2 took
  the top off." This is what makes the matchup *felt*. (Announcer VO = audio-lane
  hook.)

**Done when:** the same stick play yields clearly different results based on the
call vs the coverage, and the player is told why. **Risk:** Med — tuning leverage
so it matters without feeling scripted; lean on `TUNE` knobs + `catchLog`/balance
telemetry.

---

## Phase 2 — Thinking CPU play-caller (offense + defense)

**Goal:** replace random with situational logic so your calls answer a real
opponent.

- Replace `snap()`'s random offense pick (4640) and random `applyDefCall` (4654)
  with a **situational caller** keyed on down & distance, field position, score,
  clock, and momentum (the game already tracks these + `tally`/difficulty).
  - Short yardage → runs / quick game; behind late → shots; red zone → fades/picks.
  - Defense weights coverage by the offense's down/distance tendency and mixes to
    avoid being predictable.
- **Tendency memory:** track what each side has called and lightly adapt (the CPU
  starts jumping your favorite concept → you must diversify).
- **Difficulty hook:** `rookie/pro/allpro` (~2590) scales how well the CPU reads
  matchups and disguises — extends the existing `cpuCatch/cpuAcc` pattern.

**Done when:** the CPU calls sensibly for the situation and adapts, so defensive
play-calling has a real target and bad offensive matchups get punished. **Risk:**
Med — mostly logic; gate aggressiveness behind difficulty + a `TUNE` knob.

---

## Phase 3 — Expanded playbook, formations & a real run game

**Goal:** breadth + arcade identity, built on the Phase-0 model.

- **More pass concepts** across the new formations: Smash, Curls/Flats, Verticals,
  Drive, Wheel, Screens (bubble/RB) — each with distinct `beats/losesTo` so the
  matchup layer has depth.
- **Real run game:** beyond DIVE/SWEEP — Counter, Draw, QB Keeper, Toss, Trap.
  Make **OL blocking matter**: blocks that win/lose by strength ratings open or
  close the lane (today OL just `job='block'`), so the run *call* + matchup decide
  success, not just stick.
- **More defensive looks:** Cover-2/3 variants, double-A blitz, robber, bracket
  the star WR — paired matchup metadata.
- **Personnel/identity:** concepts flavored to the Blitz vibe (aggressive names,
  bold art), each play visibly different in the call screen.

**Done when:** a deep, varied playbook where every concept has a clear job and
counter. **Risk:** Med — content volume; sequence after Phases 0–2 so each new
play plugs into the matchup + AI systems for free.

---

## Phase 4 — Pre-snap control: audibles, hot routes, motion, RPO/PA

**Goal:** let the player *adjust* to the look — the deepest expression of
play-calling mattering.

- **Audible:** flip to a different concept at the line (reuses `choosePlay` +
  re-running `route()` before `snap()`).
- **Hot routes:** change one receiver's route (Phase-0 per-route assignments)
  to beat the shown look — e.g. hot a slant vs blitz.
- **Pre-snap motion:** shift a receiver to change leverage / reveal man-vs-zone
  (motion that a man defender follows = man, ID'd coverage → better read).
- **Play-action / RPO:** on run-looking plays, a PA hold or a read-key RPO that
  punishes the defense's run/pass commit — pairs perfectly with the Phase-2 caller.
- **Defensive adjustments:** for the user on D — shift the shell, show/disguise
  blitz, set a double-team (mirrors offense audibles).

**Done when:** the user can win plays at the line by out-adjusting the look.
**Risk:** Med–High — input/UI surface + AI reactions; build on the UI plan's pause/
HUD components and the Phase-1 read system.

---

## Phase 5 — Signature & gadget plays + ON FIRE specials

**Goal:** the over-the-top arcade payoff that fits the game's identity.

- **Gadget plays:** flea-flicker, double pass, halfback pass, reverse, hook-and-
  ladder — high risk/reward, fitting the Blitz tone.
- **ON FIRE integration:** the existing ON FIRE state unlocks a special play slot
  / boosted concept (ties into the on-fire ball-nudge already in `updateBall`).
- **Signature team plays:** a Reapers/Demons trademark concept per team for flavor.

**Done when:** there are spectacular, situational calls that feel uniquely this
game. **Risk:** Med — each gadget is bespoke animation/logic; gate behind the
matchup + AI being solid.

---

## Phase 6 — Feedback, scouting & playbook UI

**Goal:** make the whole system legible and tunable.

- **Result reasons** (from Phase 1) expanded into a consistent post-play readout.
- **Scouting/tendencies HUD:** show the opponent's recent calls / favorite looks so
  the player can exploit them (and the CPU does the same to you).
- **Playbook UI:** with many plays, organize the call screen by formation/concept
  **tabs + filters** (shared with `ui-ux-overhaul-plan.md` Phase 6); enlarge route
  art on focus; show the matchup hint on each card.
- **Balance telemetry:** extend the existing `tally`/balance overlay with
  per-play success rates so play balance can be tuned without guesswork.

**Done when:** players understand and exploit the matchup game, and designers can
balance it from data. **Risk:** Low.

---

## 3. Sequencing, dependencies & first slice

| Phase | Theme | Depends on | Risk | Payoff |
|------:|-------|-----------|------|--------|
| 0 | Play data model + formations | — | Low–Med | Enables everything cleanly |
| 1 | Concept ⇄ coverage matchup + reasons | 0 | Med | **Play-calling matters** |
| 2 | Thinking CPU caller | 0,1 | Med | A real opponent to out-call |
| 3 | Expanded playbook + run game | 0–2 | Med | Depth + identity |
| 4 | Audibles / hot routes / motion / RPO | 0–3 | Med–High | Adjusting at the line |
| 5 | Gadget + ON FIRE specials | 1–3 | Med | Arcade payoff |
| 6 | Feedback / scouting / UI | 1–5 | Low | Legible + tunable |

**Critical path for "play-calling matters":** 0 → 1 → 2. Phase 0 makes it clean,
Phase 1 makes the call swing the play *with a stated reason*, Phase 2 gives you a
thinking opponent to out-call.

**Recommended first slice (one shippable increment):**
**Phase 0-lite + Phase 1 matchup + result reasons + a non-random defensive CPU.**
Add `beats/losesTo` metadata to the existing 6 plays and 4 coverages, apply a
visible leverage swing at snap, post a one-line cause on the result, and make the
CPU pick coverage by down & distance instead of pure random. That alone turns
play-calling from cosmetic into decisive — with the current playbook, no new art —
and proves the matchup model before expanding content. Validate with `node --check`,
the headless init harness, and the playwright shooter per `CLAUDE.md`.
