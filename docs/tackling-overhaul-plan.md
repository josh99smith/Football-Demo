# Tackling Overhaul — Phased Plan (Visuals & Systems)

A roadmap to elevate the game's tackling — both how it **looks** (falls, contact,
piles, hits) and how it **plays** (player control, outcomes, depth) — building on
the substantial system already in `src/main.js` + `src/ragdoll.js`. Tuned to the
NFL-Blitz arcade identity: violent, spectacular, but readable.

> Lane note (per `CLAUDE.md`): ENGINE/MECHANICS lane (physics/ragdolls/animation
> are explicitly ours). New hit/grunt/announcer cues are hooks handed to the
> AUDIO session — don't edit `src/audio.js`. Re-read `docs/BLITZ_REFERENCE.md`
> for the look before any aesthetic work.

---

## 0. Execution directive (read first)

**Run all phases in succession, one after another — do NOT stop to wait for the
user between phases.** This plan is approved to execute end-to-end autonomously:

- Start at Phase 0 and proceed through Phase 6 without pausing for sign-off.
  Finishing a phase is the cue to immediately begin the next one.
- After each phase: run the verification gate (`node --check src/main.js
  src/ragdoll.js`, the headless init harness, and the playwright shooter per
  `CLAUDE.md` — note software rendering is ~2 fps, so it's for VISUAL checks),
  then **commit + push that phase** to the dev branch and continue.
- Only stop early if a verification gate fails and cannot be fixed, or a phase is
  genuinely blocked (e.g. a missing animation asset) — fix forward if you can,
  otherwise report the blocker and move to the next independent phase.
- Do not ask "should I start the next phase?" — the answer is always yes until
  Phase 6 is complete.

---

## 1. The system today

| Area | Where | State |
|------|-------|-------|
| Physics ragdoll | `ragdoll.js` `TackleRagdoll` | Rapier capsules + spherical joints, **passive/limp** with soft cone+twist limits, momentum-driven, NaN-safe, cage walls. |
| Fall variants | `pickVariant()` ragdoll.js | `highKnock/lowCut/sideSwipe/angledBack/twist` — different velocity tiers per body part. |
| Tackle resolution | `beginTackle()` ~6502 | Whiff(juke)/battle/break/wrap-drag/instant-ragdoll/fumble/strip branches; gang swarm; big/dirty/gang-hit tiers. |
| Wrap & drag | `beginDrag/updateDrag/collapseDrag` ~6679 | Tacklers latch + drive the runner down over a beat; late pile-on; stat-driven takedown time + drive. |
| Break-tackle | `startBattle/updateBattle` ~6416, `tryBreak` | 1-on-1 mash duel + strength/momentum break chance. |
| Knockdown recovery | `knockdownDefender/updateKnockdownRecovery` ~6354 | Whiffed/knocked defenders ragdoll, then pop up and re-pursue. |
| Hit FX | inside `beginTackle` | Bullet-time tiers, `hitZoom`, `shake`, `impactFlash`, dust `burst`, `popHelmet`/`tearInHalf` gore. |
| Animations | `tackleClip`, `hitReactClip`, `getUpClips` | Lead tackler: one head-down lunge clip then pops to idle. Carrier: limp ragdoll; broken-tackle stagger clip. **Wrap/drag pose is procedural** (churning legs + brace arms). |
| Contact editor | Contact Lab (`LAB_CONTACTS`) | A two-player contact-pose / spacing editor already exists — reuse for authoring poses. |
| Tuning | `TUNE.tackleReach/swarmRadius/fumbleChance/battleChance/staggerDur/gapGrab/knockdownRecover/catchHitRisk/ragdolls/gore` | Rich knob set already wired into the debug panel. |

**Strengths to preserve:** the physics ragdoll, the multi-path resolution, the
hit-tier juice, and the debug/Lab tooling. This plan deepens these.

**Gaps (the improvement surface):**
- **Falls are fully limp** — no bracing/ball-protection; every fall is passive.
- **Lead-tackler & pile poses are thin** — one lunge clip + procedural wrap; no
  form-tackle / shoulder / ankle / hit-stick variety; hands don't land on the body.
- **Defense tackling is one-button** — `ACTION = TACKLE`; no player skill in *how*
  you hit (hit-stick), so big hits are RNG, not earned.
- **Outcome depth is mostly RNG** — bad-angle/arm tackles, leg-drive yards-after-
  contact, and missed-tackle-by-rating aren't modeled distinctly.

---

## 2. Design goals

1. **Lifelike contact** — falls that brace and react, hands/shoulders that land on
   the body, feet that plant — not limp dummies.
2. **Earned spectacle** — the biggest hits come from player skill + good angles,
   not pure dice; arcade-violent but legible.
3. **Player agency on defense** — a hit-stick choice (high/low/wrap) with timing
   and risk/reward, mirroring the catch-type system in `catching-mechanics-plan.md`.
4. **Depth without chaos** — more tackle outcomes (arm tackle, drag, TFL, broken)
   that read clearly and stay stable in piles.
5. **Build on what exists** — extend the ragdoll + resolution + Lab, don't replace.

---

## Phase 0 — Foundation: tackle telemetry + tuning consolidation

**Goal:** instrument before changing, so later phases are tunable and provable.

- A **tackle debug overlay** (extend the existing balance overlay / `catchLog`
  pattern): log each tackle's type (whiff/battle/break/drag/instant/fumble/strip),
  closing speed, angle, gang size, chosen variant, and yards-after-contact.
- **Consolidate tackle knobs** under one debug tab; add any missing
  (e.g. ragdoll bracing weight, hit-stick window) as no-ops now so later phases
  just flip them on.
- Capture **baseline screenshots/clips** of representative tackles via the
  playwright shooter for before/after comparison.

**Done when:** every tackle is measurable and all knobs live in one place; no
behavior change. **Risk:** Low.

---

## Phase 1 — Active-ragdoll & fall realism (visuals core)

**Goal:** the single biggest visual lift — make bodies fall like bodies.

- **Light active ragdoll:** in `TackleRagdoll.applyLimits` add a small
  pose-matching torque toward a target pose (the existing joints already spring to
  rest limits — extend with a weak "brace/protect" target) so a falling player
  partially resists: arms come out to brace, the ball-carrier curls to protect.
  Weighted by a new `TUNE` knob; fades as the body settles (`age`-based, already
  present). Keep it subtle so it never fights the physics into stiffness.
- **Contact-point hand/shoulder IK:** when a tackler latches (`latchGrabber`) or
  lands the hit, drive his hands/shoulder onto the carrier's torso bone instead of
  the current fixed fan-slot offset — so wraps actually grip the body.
- **Foot plant + ground-contact:** keep planted feet from sliding during the
  wrap/drag (the legs currently "churn" at a fixed speed); add ground-contact so
  hands/knees hitting the turf read on impact.
- **Lead-tackler follow-through:** instead of "lunge then pop to idle," let the
  lead optionally ride the pile down (a light ragdoll-in on big square hits) so
  the tackler isn't unnaturally upright after a violent collision.

**Done when:** falls and wraps look like real contact — bracing, gripping,
planting — across the variant set. **Risk:** Med–High (physics tuning); gate each
sub-feature behind a `TUNE` knob and verify stability in gang piles.

---

## Phase 2 — Tackle animation library + two-player contact poses

**Goal:** replace the thin clip/procedural set with authored variety.

- **New clips** (check `animations2–5.glb` for unused names first; slice/retarget
  like `tackleClip` via `subclip`+`inPlace`): **form wrap-up**, **shoulder/hit-
  stick launch**, **ankle/shoestring dive** (pairs with the existing `diveTackle`
  AI path), **gang-wrap**, and a **carrier brace/lower-shoulder** for contact.
- **Two-player contact poses via the Contact Lab:** author relative
  tackler↔carrier poses for the common contacts (square-up, side wrap, gang) so
  the moment of contact reads as a real collision, not two independent clips.
  The Lab already edits two-player spacing — feed its values into `beginDrag`/
  `latchGrabber`.
- **Carrier reactions:** distinct hit-reacts by hit direction/height blended over
  the run (extend `hitReactClip` to a small set).
- **Get-up variety:** more stand-up clips + a quicker "pop-up" for minor knockdowns
  (`getUpClips` already supports a set).

**Done when:** the tackler and carrier have varied, contact-synced animations for
each tackle type. **Risk:** Med (asset/authoring dependency); sequence after
Phase 1 so poses blend into the improved ragdoll.

---

## Phase 3 — Player-controlled tackling: the hit-stick (systems core)

**Goal:** make defense a skill — *how* you tackle is a choice, mirroring catches.

- **Hit-stick input** when you control a defender closing on the carrier (extend
  the `ACTION=TACKLE` button + add modifiers / keys, reusing the catch-type input
  pattern `input.catchEdge`):
  - **Wrap (safe)** — high success, minimal yards-after, no fumble bonus.
  - **High hit (big)** — timing-gated launch: huge hit + fumble chance on success,
    but **whiff/penalty risk** if mistimed or off-angle.
  - **Low hit (cut)** — reliably brings down a fast runner, less spectacle.
- **Timing + angle window:** a hit-stick window opens inside `tackleReach`; a clean
  press at a good pursuit angle = the violent path (`big`), a bad angle/late press
  = an arm tackle (Phase 4) or a whiff. Surface a "now" cue (ties to the UI plan).
- **Feeds the existing branches:** the choice sets the `big`/`force` inputs into
  `beginTackle` and the fumble odds, rather than today's pure RNG — so big hits are
  earned. CPU defenders pick a hit type by rating/situation.
- **Elusiveness symmetry (offense):** refine the carrier's contact moves
  (truck/stiff-arm/spin/juke — inputs already exist) as direct counters to hit
  types, so the collision is a mini rock-paper-scissors.

**Done when:** the player decides how to tackle, good timing/angle is rewarded with
the big hit, and mistakes get punished. **Risk:** Med — input/UI + balancing the
window; lean on Phase 0 telemetry.

---

## Phase 4 — Tackle outcome & physics depth

**Goal:** more distinct, believable results beyond hit-vs-whiff.

- **Bad-angle & arm tackles:** a defender who arrives off-angle or late gets only
  an **arm tackle** — a chance to drag the runner down, otherwise he slips through
  with a stagger (extends the break/`tryBreak` path).
- **Yards-after-contact / leg drive:** the `updateDrag` drive model already lets a
  strong runner sneak forward — expand into visible extra-yards battles and
  **tackle-for-loss** when the defense wins decisively.
- **Missed tackles by rating:** poor `tackle` rating → more whiffs/broken tackles;
  elite → reliable wraps. Make the rating legible in outcomes.
- **Pursuit & second-level:** improve pursuit angles so the swarm converges
  naturally; a beaten first tackler's whiff sets up a clean second-man cleanup.
- **Pile stability:** stress-test gang piles with the new active ragdoll; ensure
  the collision-group bits + `VMAX` caps still prevent blow-ups.

**Done when:** tackles resolve into a believable spread (clean, arm, broken, TFL,
gang) driven by angle/rating/momentum. **Risk:** Med — AI + physics interaction;
verify with telemetry that the spread is sane.

---

## Phase 5 — Hit FX, camera & replay polish

**Goal:** maximize the spectacle of the now-earned big hits.

- **Contact FX:** richer impact particles, sweat/mist on big hits, **turf
  scuff/divots** under a drag, jersey ripple — layered on the existing `burst`.
- **Hit-stick camera:** a dedicated punch-in + directional shove for a clean
  hit-stick (extend `hitZoom`/`shake.kick`); scale slow-mo to the *earned* power,
  not just RNG tier.
- **Dedicated big-hit replay angle:** a low/close "hit cam" added to the replay
  angle set, auto-selected for `bigHit` plays (the replay system already flags
  `replay.bigHit`).
- **Gore tuning:** keep `popHelmet`/`tearInHalf` but tie frequency to earned power
  and the `gore` knob so it punctuates rather than spams.
- **Audio hooks:** distinct cues per hit type/intensity handed to the audio lane.

**Done when:** big hits feel like an event — camera, FX, and replay all sell the
collision. **Risk:** Low–Med (mostly additive FX).

---

## Phase 6 — Ratings, tuning & balance telemetry

**Goal:** make the whole system tunable and balanced.

- **Split tackle ratings:** from the single `tackle` rating into `hitPower`,
  `wrapTackle`, `pursuit` (feeding `hitPower()`, `dragTakedownTime`, AI pursuit) so
  defenders feel distinct — extends the existing `RATINGS`/`rt` model.
- **Per-type success telemetry:** extend Phase-0 logging into the balance overlay
  (whiff %, broken %, fumble %, avg yards-after-contact) to tune against.
- **Difficulty hooks:** `rookie/pro/allpro` scale CPU hit timing/whiff rates and
  the user's hit-stick leniency (extends the `cpuCatch/cpuAcc` pattern).
- **Final balance pass** with the playwright shooter + telemetry so tackling is
  spectacular but fair across difficulties.

**Done when:** defenders feel distinct, the outcome spread is balanced, and it all
tunes from data without code spelunking. **Risk:** Low.

---

## 3. Sequencing, dependencies & first slice

| Phase | Theme | Depends on | Risk | Payoff |
|------:|-------|-----------|------|--------|
| 0 | Telemetry + knob consolidation | — | Low | Measurable, tunable base |
| 1 | Active-ragdoll & fall realism | 0 | Med–High | **Biggest visual lift** |
| 2 | Animation library + contact poses | 1 | Med | Authored variety |
| 3 | Hit-stick (player control) | 0 | Med | **Biggest systems lift** |
| 4 | Outcome & physics depth | 1,3 | Med | Believable spread |
| 5 | FX / camera / replay polish | 1–4 | Low–Med | Earned spectacle |
| 6 | Ratings / tuning / telemetry | 1–5 | Low | Balanced + tunable |

**Critical path:** 0 → 1 (visuals) and 0 → 3 (systems) are the two headline tracks;
both feed Phase 4. Phase 5 polishes; Phase 6 balances.

**Starting increment (then keep going — do not stop here):**
**Phase 0 telemetry + the Phase-1 active-ragdoll bracing + contact-point hand IK.**
That alone makes every fall and wrap look dramatically more lifelike using the
existing physics, with full measurement in place — then continue straight through
the hit-stick (Phase 3) and on to Phase 6 per the Execution directive above. This
is the first increment, not a stopping point. Validate each step with
`node --check`, the headless init harness, and the playwright VISUAL shooter per
`CLAUDE.md`.
