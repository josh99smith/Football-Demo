# Animation Studio (Contact Lab Overhaul) — Phased Plan

Evolve the narrow **Contact Lab** into a full in-game **Animation Studio**: select
any character animation (canned clip OR procedural pose), scrub a timeline, edit
keyframes, drag bones to pose, author brand-new animations, and export it all.
"Grab every animation hook and make them editable." Built on the existing Lab +
animation system in `src/main.js`.

> Lane note (per `CLAUDE.md`): ENGINE/MECHANICS lane. Pairs with
> `animation-system-overhaul-plan.md` (the runtime controller it edits),
> `animation-sourcing-pipeline.md` (importing/exporting clips), and the catching/
> tackling plans (the poses it tunes). Reuse the debug-cam orbit + `DBG_KNOBS` +
> TUNE save/load that already power the Lab; don't duplicate them.

---

## 0. Execution directive (read first)

**Run all phases in succession, one after another — do NOT stop to wait for the
user between phases.** This plan is approved to execute end-to-end autonomously:

- Start at Phase 0 and proceed through Phase 6 without pausing for sign-off.
  Finishing a phase is the cue to immediately begin the next one.
- After each phase: run the verification gate (`node --check src/main.js
  src/ragdoll.js`, the headless init harness, and the playwright VISUAL shooter
  per `CLAUDE.md`), then **commit + push that phase** to the dev branch and
  continue.
- Only stop early if a verification gate fails and cannot be fixed, or a phase is
  genuinely blocked — fix forward if you can, otherwise report and move to the
  next independent phase.
- Do not ask "should I start the next phase?" — the answer is always yes until
  Phase 6 is complete.

---

## 1. What the Lab is today

`enterLab/updateLab/buildLabPanel` (~9316–9414) + `LAB_CONTACTS` + `#lab-panel`:

- Loads **two** players (red carrier A, blue defender B), hides the rest.
- Cycles **4 two-player contact poses** (`LAB_CONTACTS`: break-tackle battle,
  engaged block, wrap/gang drag, ball-protect), each a `place()` + `apply()`.
- Edits only **spacing knobs** (gap/lateral) via sliders; orbit camera.
- **Save** → `localStorage` (the live game reads it); **Copy** → JSON to bake into
  code defaults; **Reset** → `TUNE_DEFAULTS`.

It can't touch animations, keyframes, or bones — it's a contact-spacing tuner.

## 2. The animation hooks to "grab" (all of them)

The Studio must enumerate and drive every one of these:

- **Canned clips** (`actions` registry, per character): `idle, walk, run, sprint,
  backL, backR, block, dance, sulk, juke, catch, tackle, divecatch, scoop, vault,
  cagevault, hitreact, celebrate, getup, jab, kick, blownback`. Sourced via
  `subclip`/`inPlace(Y)` (frame range, in-place flag, `refSpeed`).
- **Procedural poses** (functions that pose bones each frame): `applyThrowPose`,
  `applyCatchPose`, `applyArmAction` (taunt/swat/reach/pick), `applyCarryProtect`,
  `applyBattleLean`, `applyBattleArms`, `applyGrabLean`, `applyBlockPose`,
  `applySulkPose`, `applyLocoLife` (bank/lean/breath), `applyHeadTrack`,
  `applyFootLock`, `applyRecoverBlend`.
- **Pose primitives:** `blendBone`, `blendLean`, `poseCardBone`, and the keyframe
  evaluator **`keyAngle([[t, value], …], t)`** — the procedural poses are *already*
  keyframe splines of per-bone angle over normalized time. Editing keyframes =
  editing these tables.
- **Bone refs** on each character: `upperArm(Rest)`, `foreArm(Rest)`,
  `leftArm/leftForeArm(Rest)`, `spineBone(Rest)`, `headBone`, `handBone`, and the
  full `restPose` snapshot — the editable targets.
- **Weights/knobs:** `TUNE.animThrow/animCatch/animArm/animBank/runLean/animBreath/
  animHead/...` and the per-character eased overlay weights.

---

## Phase 0 — Foundation: Animation Studio shell + hook registry

**Goal:** turn the Lab into a general studio that can enumerate and drive *any*
hook, without losing the current contact-spacing tooling.

- **Hook registry:** one data-driven manifest describing every animation above —
  for canned clips: name, source slice params; for procedural poses: the function,
  its edited bone channels, and (where it uses `keyAngle`) the keyframe tables;
  for contact poses: the existing `place/apply`. This is the "grab all the hooks"
  core everything else reads.
- **Generalize the scene:** let the Studio show **1, 2, or N** characters (single-
  player poses like throw/catch need only one; contact needs two) — extend
  `enterLab` selection beyond the hardcoded A/B.
- **Tabbed shell** (reuse the UI-overhaul `TabBar` when available): **Clips ·
  Procedural · Contact · Bones · Export**. Keep the current contact sliders living
  under **Contact**.
- **Refactor** `keyAngle` poses to read their keyframe tables from the registry
  (data) instead of inline literals, so edits have somewhere to live. No visual
  change yet.

**Done when:** the Studio lists and can select/drive every hook; existing contact
editing still works. **Risk:** Med (refactor breadth) — lean on the snap detector
from the animation-system plan + playwright parity shots.

---

## Phase 1 — Timeline & playback

**Goal:** inspect any animation frame-by-frame.

- A **timeline scrubber** that drives normalized `t` (procedural poses) or clip
  time (canned), with play / pause / loop / speed and a weight slider (drives the
  hook's `w`). Reuse the replay scrub UI pattern.
- Live readout of the current frame/`t` and the resulting bone values.
- Works for one- and two-player hooks; the contact poses animate over the scrub.

**Done when:** you can scrub, loop, and slow-play any selected hook. **Risk:** Low.

---

## Phase 2 — Keyframe editor (curves)

**Goal:** add/move/delete keyframes — the heart of the request.

- For any `keyAngle`-based pose, render each **bone channel as an editable curve**
  of `[t, value]` points: drag points, add/delete keys, see the smoothstep spline
  (the same interpolation `keyAngle` uses) update live on the model.
- Multi-channel view (e.g. throw = upperArm/foreArm/leftArm/leftForeArm + lean +
  twist) with per-channel show/solo.
- Edits write back to the registry tables (Phase 0), so the running pose changes
  immediately and is exportable (Phase 5).
- Numeric entry for precise `t`/value; clamp to sane ranges.

**Done when:** procedural poses are fully keyframe-editable on a curve, live.
**Risk:** Med — curve UI + touch interaction; build on Phase 1's scrubber.

---

## Phase 3 — Direct bone manipulation (visual posing)

**Goal:** pose by grabbing bones, not just sliders.

- **Skeleton overlay + selectable bones** (clickable joints / a bone gizmo);
  rotate (and translate where relevant) the selected bone with drag or
  per-axis sliders, relative to `restPose`.
- **Pose→keyframe:** "set key at current t" reads the manually-posed bone angles
  back into the keyframe table — so visual posing authors keyframes (the natural
  workflow).
- **Bone hierarchy panel**, L/R **mirror**, reset-bone / reset-pose, and a numeric
  rotation/position readout per bone.
- Respect existing rest offsets and the alt-model head retarget (`headFix`).

**Done when:** you can click a bone, pose it, and bake it into a keyframe. **Risk:**
Med–High — picking + gizmo math on the rig; verify on both base and alt models.

---

## Phase 4 — Create & generate new animations

**Goal:** author brand-new animations, not just edit existing ones.

- **New procedural pose:** name it, pick the bone channels, keyframe it (Phases
  2–3), set its default weight/`TUNE` knob, and register it so the runtime can
  call it — a first-class new hook.
- **New/edited canned-clip variant:** edit a clip's `subclip` frame range, in-place
  flag, `refSpeed`, and blend time live, and save the recipe (feeds
  `animation-sourcing-pipeline.md`).
- **Generators:** mirror a pose L/R, retime (stretch/squash keys), blend two poses
  into a third, derive a pose from a held stance, ease-curve presets — quick ways
  to spin up variants.
- **Assign:** map a new/edited pose to where the game triggers it (catch style,
  tackle, celebration, etc.) so it's testable in context.

**Done when:** a new animation can be created in-Studio and played by the game.
**Risk:** Med — registration plumbing into the runtime.

---

## Phase 5 — Save / export / round-trip

**Goal:** persist and ship everything edited.

- Extend the current **Save (localStorage) / Copy (JSON)** to cover **all** Studio
  data — keyframe tables, bone edits, contact spacing, new poses, clip recipes —
  not just spacing knobs. The live game already reads localStorage on load.
- **Bake-to-code export:** emit the keyframe tables / pose definitions in the exact
  shape the source expects, so they can be pasted into `src/main.js` defaults.
- **glTF export** for new/edited canned clips where applicable, handing off to the
  sourcing pipeline (compression, in-place, naming).
- **Import** a saved set back into the Studio; per-pose reset to defaults; A/B
  compare two versions (reuse the debug A/B).

**Done when:** any edit can be saved, exported to code, and round-tripped. **Risk:**
Low–Med.

---

## Phase 6 — Polish, guardrails & integration

**Goal:** make it robust and pleasant to use.

- **Undo/redo**, presets, and per-bone limit clamps (anatomical guardrails so edits
  can't create impossible poses — mirror the ragdoll cone/twist limits).
- **Mobile/touch** ergonomics (the game is landscape phone-first): big handles,
  pinch-zoom on curves, panel that doesn't cover the model.
- **Integration:** expose the Studio as a tab in the debug panel + `?studio` entry;
  fold its chrome into the UI-overhaul component system; ensure entering/leaving
  cleanly restores game state (the current `enterLab/exitLab` pattern).
- **Validation pass:** drive every registered hook through the Studio and confirm it
  renders + exports correctly; snap-detector clean.

**Done when:** the Studio is stable, touch-friendly, integrated, and covers every
hook. **Risk:** Low–Med.

---

## 3. Sequencing, dependencies & first slice

| Phase | Theme | Depends on | Risk | Payoff |
|------:|-------|-----------|------|--------|
| 0 | Studio shell + hook registry | — | Med | "Grabs all hooks" — the enabler |
| 1 | Timeline & playback | 0 | Low | Inspect any animation |
| 2 | Keyframe curve editor | 0,1 | Med | **Edit keyframes** |
| 3 | Direct bone manipulation | 0,1 | Med–High | **Tweak bone positions** |
| 4 | Create / generate animations | 0–3 | Med | **Generate animations** |
| 5 | Save / export / round-trip | 0–4 | Low–Med | Ship the edits |
| 6 | Polish / guardrails / integration | 1–5 | Low–Med | Robust & usable |

**Critical path:** 0 → 1 → 2 → 3 → 4. Phase 0 (the hook registry) unlocks
everything; 1–3 deliver scrub + keyframe + bone editing; 4 adds authoring; 5–6
ship and harden it.

**Starting increment (then keep going — do not stop here):**
**Phase 0 hook registry + Studio shell, then the Phase-1 timeline and a first
Phase-2 keyframe curve on `applyThrowPose`.** That proves the registry can grab a
real hook, scrub it, and edit its keyframes live — the core of the request — then
continue straight through bone manipulation, authoring, and export to Phase 6 per
the Execution directive above. This is the first increment, not a stopping point.
Validate each step with `node --check`, the headless init harness, and the
playwright VISUAL shooter per `CLAUDE.md`.
