# Animation System Overhaul — Phased Plan

A roadmap to evolve the character animation system into the **perfect mix of
canned clips, procedural pose, physics/ragdoll, and additive layering** — with
**smooth transitions as the top priority at every seam**. Built on the
already-layered system in `src/main.js` + `src/ragdoll.js`.

> Lane note (per `CLAUDE.md`): ENGINE/MECHANICS lane (animation/physics/ragdolls
> are ours). Coordinates with `catching-mechanics-plan.md` (hand IK / catch poses),
> `tackling-overhaul-plan.md` (active ragdoll / contact poses), and
> `ui-ux-overhaul-plan.md` (a debug/tuning tab) — share the IK + physics-blend
> code with those, don't duplicate it. Re-read `docs/BLITZ_REFERENCE.md` first.

---

## 0. Execution directive (read first)

**Run all phases in succession, one after another — do NOT stop to wait for the
user between phases.** This plan is approved to execute end-to-end autonomously:

- Start at Phase 0 and proceed through Phase 6 without pausing for sign-off.
  Finishing a phase is the cue to immediately begin the next one.
- After each phase: run the verification gate (`node --check src/main.js
  src/ragdoll.js`, the headless init harness, and the playwright VISUAL shooter
  per `CLAUDE.md` — software rendering is ~2 fps, so use it for pose/transition
  checks, not timing), then **commit + push that phase** to the dev branch and
  continue.
- Only stop early if a verification gate fails and cannot be fixed, or a phase is
  genuinely blocked (e.g. a missing clip) — fix forward if you can, otherwise
  report the blocker and move to the next independent phase.
- Do not ask "should I start the next phase?" — the answer is always yes until
  Phase 6 is complete.

---

## 1. The system today (already a 4-layer mix)

| Layer | Where | State |
|-------|-------|-------|
| Canned clips | `setClip()` ~1733, `AnimationMixer`, `playOneShot()` ~7209 | idle/walk/run/sprint/backL/backR/block/dance/sulk + one-shots (juke/dive/spin/catch/throw/celebrate/getup/tackle/hitreact). |
| Locomotion crossfade | `setClip` | **Flat 0.18 s** `crossFadeFrom` between all gaits; foot-skating fixed by `timeScale = clamp(speed/refSpeed)`. |
| Procedural overlays | `updateAnimation()` ~7592, `blendBone/blendLean` ~7244, `easeWeight` ~4289 | Single-active priority (battle/grab/catch/throw/arm/block/sulk), eased weights `POSE_IN/POSE_OUT`; `blendBone` SLERPs bones toward targets. |
| Root "life" | `applyLocoLife()` ~7266, `applyHeadTrack()` ~7297 | Bank into turns, speed lean, idle breathing, head-on-a-swivel. |
| Physics ragdoll | `ragdoll.js` `TackleRagdoll`, `restoreRestPose()` ~7159 | `ragdolling` short-circuits `updateAnimation`; recovery hard-snaps to rest + `mixer.setTime(0)` + `getup`. |
| Carry/IK-ish | `applyCarryProtect`, catch-pose hand reach | Off-arm ball shield; catch reach by angle (no true IK yet). |

**Strengths to preserve:** the eased single-active overlay model (already gives
automatic procedural crossfades), the foot-skating timeScale sync, the
ragdoll-spawn-at-current-pose entry, and the per-character weight system.

**The smoothness seams to fix:**
1. **Flat 0.18 s gait crossfade** + discrete idle/walk/run/sprint states → pops on
   big speed jumps (sprint→idle), no continuous gait blend.
2. **One-shot exit** falls through to `setClip(want)` with no pose-matched blend —
   a dive/juke/celebrate that ends in an extreme pose can snap back to the gait.
3. **Ragdoll→getup teleports:** `restoreRestPose` hard-snaps the skeleton from the
   physics pose to a clean rest pose *before* the get-up plays — the worst seam.
4. **No unified controller:** transitions are imperative and scattered through one
   big `updateAnimation` if/else; blend times are magic numbers, not data.
5. **Overlays are single-active & replace-blended**, not additive — two upper-body
   intents can't cleanly co-exist, and procedural pose fights shared bones.

---

## 2. Design goals

1. **No visible snap, ever** — every state change (gait, one-shot, overlay,
   ragdoll in/out) blends; the worst-case one-frame bone delta is bounded.
2. **The right tool per motion** — canned for signature moves, blend-space for
   locomotion, additive procedural for reactive nuance, physics for impacts;
   composited cleanly, not fighting each other.
3. **Frame-rate independent & slow-mo safe** — transitions look identical at any
   fps and under bullet-time (the mixer already gets scaled dt).
4. **Data-driven & measurable** — blend times are config; a debug overlay shows
   state, weights, and flags snaps.
5. **Extend, don't replace** — keep the eased-overlay model, the foot-skating sync,
   and the ragdoll; refactor them into one controller.

---

## Phase 0 — Foundation: a unified animation controller + instrumentation

**Goal:** consolidate the scattered logic into one per-character controller so
every later phase has a single, consistent place to make transitions smooth.

- **`AnimController`** wrapping each character's mixer + overlays + physics handoff,
  with an explicit update order: (1) base layer (clips/blend-space), (2) additive
  procedural layer, (3) physics override, (4) root life + IK. Refactor
  `updateAnimation`/`setClip`/`playOneShot`/`easeWeight` into it with **no behavior
  change**.
- **Data-driven blend table:** replace magic blend numbers (the 0.18 crossfade,
  `POSE_IN/POSE_OUT`, one-shot holds) with a per-transition config so durations are
  tunable and intentional.
- **Frame-rate-independent easing:** standardize on exponential smoothing
  (`1 - pow(k, dt)`) for weights/leans so blends are identical at any fps.
- **Animation debug overlay:** current base state, active overlays + live weights,
  blend timers, and a **snap detector** (flag any per-frame bone-rotation delta
  above a threshold) — the measurement backbone for "prioritize smoothness."

**Done when:** identical on-screen behavior, but all animation flows through one
controller with data-driven blends and a live debug overlay. **Risk:** Med (broad
refactor); lean on the snap detector + playwright to prove parity.

---

## Phase 1 — Locomotion blend space (continuous gaits)

**Goal:** kill gait pops — the most common transition the player sees.

- **1D speed blend:** replace discrete idle→walk→run→sprint + 0.18 crossfades with
  a continuous blend keyed on speed, so the body accelerates *through* the gait
  continuum with no cut. Keep the `refSpeed` foot-skating sync per blended clip.
- **2D directional blend:** fold backpedal (backL/backR) and the existing
  directional/turn clips (`BackLeft_run`, `Run_Sharp_Turn_Right`) into a
  strafe/turn blend so cuts and coverage drops are smooth (preserve the current
  backpedal hysteresis to avoid flicker).
- **Velocity-aware transitions:** bigger speed/direction deltas get slightly longer
  blends; tiny ones snap-blend fast — no fixed 0.18 everywhere.

**Done when:** acceleration, cuts, stops, and backpedals read as one continuous
motion with no gait snapping. **Risk:** Med — blend-space tuning; verify with the
snap detector across the speed range.

---

## Phase 2 — Seamless one-shots & interruptibility

**Goal:** make discrete actions (juke/dive/spin/celebrate/throw/catch) enter and
exit without snapping.

- **Pose-matched exit:** when a one-shot ends, blend from its final pose back into
  the live blend-space gait (instead of the current fall-through `setClip`), so a
  dive/spin/celebration settles into the run.
- **Additive upper-body actions:** where the lower body should keep moving (throw,
  catch reach, arm swat, taunt), run the action as an **additive** upper-body layer
  over the locomotion blend rather than a full-body one-shot — the legs never stop
  to play an arm motion. (Replaces `fit` time-warping where a blend looks better.)
- **Interruptibility:** a higher-priority event (a hit, a fumble, a catch) can cut
  a one-shot via a fast blend instead of a hard switch — no T-pose flash, no
  frozen mid-clip.

**Done when:** every one-shot blends cleanly in and out and can be interrupted
gracefully. **Risk:** Med — depends on Phase 0 controller + Phase 1 blend space.

---

## Phase 3 — Procedural as a true additive layer (the "perfect mix")

**Goal:** the reactive nuance layer that makes canned motion feel alive, composited
cleanly over everything.

- **Additive overlay compositing:** convert the procedural poses (lean, carry-
  protect, head-track, brace, reach, breathing) to an additive layer with **bone
  arbitration** so multiple intents co-exist (e.g. carry-protect + head-track + turn
  lean) instead of today's single-active replace-blend.
- **Foot-lock IK:** plant the stance foot to the turf to eliminate residual skating
  and the `groundClamp` float/sink — the biggest "grounded" win. Toggle by quality.
- **Hand IK targets:** a shared two-bone arm IK used by the catch reach
  (`catching-mechanics-plan` Phase 2) and tackle grips (`tackling-overhaul-plan`
  Phase 1) — author once here, reuse there.
- **Secondary motion:** subtle overshoot/settle on hard stops and direction
  changes, weight-shift on idle — layered, not baked.

**Done when:** procedural reactions blend seamlessly on top of any base clip with
no bone-fighting, and feet stay planted. **Risk:** Med–High — IK + additive math;
gate each piece behind a knob and watch the snap detector.

---

## Phase 4 — Physics ↔ animation blending (the hardest seam)

**Goal:** smooth the ragdoll handoff in BOTH directions — especially recovery.

- **Blend-from-ragdoll get-up (the headline fix):** replace the hard
  `restoreRestPose` snap with a **pose-matched recovery** — sample the ragdoll's
  settled bone orientations, choose/orient the matching get-up clip (face-up vs
  face-down vs prone), and **crossfade from the physics pose into the get-up**, so
  the body rises from where and how it fell instead of teleporting to a rest pose.
- **Blend-to-ragdoll entry:** keep the instant handoff for violent hits (it spawns
  at the live pose — already smooth), but for soft falls/knockdowns add a brief
  active-ragdoll blend (shared with `tackling-overhaul-plan` Phase 1) so the
  transition into physics isn't a sudden limp drop.
- **Partial/additive physics:** allow a physics-driven reaction (a recoiling arm,
  a stumble) to blend over a still-animated body for glancing contact — not all-or-
  nothing ragdoll.
- **Stability:** ensure the new blends respect the existing NaN-sanitization, spin
  caps, and cage clamps in `ragdoll.js`.

**Done when:** going down and getting up read as continuous motion with no teleport
or snap. **Risk:** High — physics/anim interface; coordinate the shared code with
the tackling plan and stress-test piles.

---

## Phase 5 — Polish, retarget & consistency pass

**Goal:** eliminate every remaining seam and keep all models consistent.

- **Per-transition tuning:** dial each entry in the Phase-0 blend table using the
  snap detector until no flagged snaps remain across all states.
- **Alt-model parity:** ensure retargeted/alt rigs blend identically (the
  `headFix`/head-retarget path already exists) — same controller, same blends.
- **Slow-mo / bullet-time pass:** confirm transitions stay smooth under the
  existing `timeScale` scaling and replay scrubbing.
- **Idle & micro-life:** breathing, blink-equivalent weight shifts, fidget variety
  so a standing player is never a frozen statue between plays.

**Done when:** a full playtest surfaces no snaps in normal or slow-mo playback.
**Risk:** Low–Med.

---

## Phase 6 — Tuning, telemetry & performance

**Goal:** make the whole system tunable, measurable, and scalable.

- **Blend-tuning debug tab** (shared with `ui-ux-overhaul-plan`): all blend
  durations, overlay in/out times, IK weights, foot-lock on/off — live.
- **Snap telemetry in the balance overlay:** count/locations of flagged snaps so
  regressions are caught.
- **Quality scaling:** IK and additive layers scale by a quality setting / device
  perf (off on low-end), since this runs on phones; verify the controller degrades
  gracefully.
- **Final balance pass** with the playwright shooter + telemetry.

**Done when:** the system tunes from data, flags its own regressions, and scales
across devices. **Risk:** Low.

---

## 3. Sequencing, dependencies & first slice

| Phase | Theme | Depends on | Risk | Payoff |
|------:|-------|-----------|------|--------|
| 0 | Unified controller + snap detector | — | Med | The enabler + measurement |
| 1 | Locomotion blend space | 0 | Med | Kills the most-seen pops |
| 2 | Seamless one-shots + additive actions | 0,1 | Med | Clean discrete moves |
| 3 | Additive procedural + IK | 0–2 | Med–High | **The "perfect mix"** |
| 4 | Physics ↔ anim blending | 0,3 | High | Fixes the worst seam (get-up) |
| 5 | Polish / retarget / slow-mo | 1–4 | Low–Med | No remaining snaps |
| 6 | Tuning / telemetry / perf | 1–5 | Low | Tunable + scalable |

**Critical path for smoothness:** 0 → 1 → 2 → 4. Phase 0 makes transitions
data-driven and measurable; Phases 1–2 fix the everyday gait/one-shot seams;
Phase 4 fixes the ragdoll-recovery teleport. Phase 3 delivers the canned+procedural
mix; Phases 5–6 polish and tune.

**Starting increment (then keep going — do not stop here):**
**Phase 0 controller + snap detector, then the Phase-1 locomotion blend space.**
That replaces discrete gaits + the flat 0.18 crossfade with continuous, velocity-
aware blending and gives you a live snap detector to prove it — the most visible
smoothness win — then continue straight through one-shots, the additive procedural
mix, and the ragdoll get-up fix on to Phase 6 per the Execution directive above.
This is the first increment, not a stopping point. Validate each step with
`node --check`, the headless init harness, and the playwright VISUAL shooter per
`CLAUDE.md`.
