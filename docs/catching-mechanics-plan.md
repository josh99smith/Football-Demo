# Catching Mechanics — Phased Improvement Plan

A roadmap for improving the **existing** catching system in the Reapers football
game, grounded in what's already in `src/main.js`, and steered by how the big
football games (Madden / EA SPORTS) make receiving feel smooth and natural.

> Scope note: this plan is the ENGINE/MECHANICS lane (per `CLAUDE.md`). It stays
> out of `src/audio.js`, `assets/music/*`, `assets/vo/*`. Audio cues called out
> below (e.g. a new catch-type whoosh) are hooks to hand to the audio session,
> not work to do here.

---

## 1. What the game already does (and does well)

The catch pipeline is mature and lives entirely in `src/main.js`:

| System | Function(s) | Notes |
|--------|-------------|-------|
| Throw | `throwBall(power)` ~4545, `aimReceiver()` ~6293 | Power→arc solve (~31° lob→~10° bullet), iterative receiver-lead, QB-skill inaccuracy, arm-strength spiral. |
| Ball flight | `updateBall()` ~5190 | Real projectile + gravity, pulsing landing reticle, ON-FIRE-only in-flight nudge, "battle for the ball" trigger as it drops. |
| Catch geometry | `vReach`/`catchGap` ~5418/5427 | True **3D reach capsule** (shins→leap height, arm radius) — a high ball over the head correctly reads as out of reach. |
| Anticipatory commit | `commitCatchReach()` ~5446 | Fires the catch ANIMATION before the grab resolves; auto-selects style `leap` / `scoop` / `overshoulder` / `standing` from geometry. |
| Resolution | `tryReception()` ~5466 | Probabilistic: completion / drop / interception / breakup from receiver hands, coverage tightness, vertical jump-ball edge, QB/DB skill. |
| Secure-in | `startSecure()` ~5369 + `updateBall` `secured` branch | Ball homes into the hand bone on a time-keyed smoothstep; planted leaps get a downfield push so they don't dead-stop. |
| Procedural pose | `applyCatchPose()` ~6421 | Two-hand vs one-hand stab, over-the-shoulder arch, head-track; rig-agnostic arm bones. |
| Outcomes | `passBrokenUp()` ~5395, `ballLooseFromAir()` ~6052 | Drop/swat falls to turf; fence caroms become live loose balls. |
| Tuning | `TUNE.catch*`, `jumpReach`, `intChance`, `PASS_G/VMAX`, `CONTEST_R` | Already a rich, debuggable knob set. |

**Strengths to preserve:** the 3D reach capsule, anticipatory animation commit,
eased secure-in, ratings-driven contest math, and the debug knob culture. The
plan extends these rather than replacing them.

---

## 2. What the big games teach us — mapped to our gaps

Research into Madden/EA design notes + game-feel literature, lined up against the
current code:

1. **Catch *intent* is the player's choice.** Madden's identity is three catch
   styles as a risk/reward decision: **RAC** (catch in stride), **Possession**
   (secure, plant, protect), **Aggressive** (high-point, fight for it, jump
   early). → **Our gap:** the catch is 100% AI-resolved. The human aims + throws,
   then `tryReception()` decides everything. There is no user catch button and no
   style choice. *This is the #1 opportunity.*

2. **Catch outcome = ratings + positioning + timing.** We have ratings +
   positioning; we have **no timing input** the user can express. → add a catch
   window the user can hit.

3. **The ball is a first-class physics object** — contact mid-catch can organically
   knock it loose. → **Our gap:** only fence caroms go live; a DB contesting is a
   scripted swat, never a physics knockout.

4. **Depth comes from a library of two-player interactions** (box-out, hand-fight,
   mossing, simultaneous catch). → **Our gap:** contests are dice + separate
   reach/swat poses on each man, never a shared/relative animation.

5. **Smoothness = blending + responsiveness + clear affordance.** We already
   blend well (procedural poses over locomotion) and have the landing reticle. →
   missing: a "catchable now" cue and a catch-type affordance so a *user* catch
   feels fair.

---

## Phase 1 — User-controlled catch (the headline feature)

**Goal:** let the human *make* the catch, with the three Madden-style styles as a
risk/reward choice. This is the single biggest realism/engagement win and reuses
almost everything already built.

- **Input:** add catch-type buttons to the existing action row (mirror the
  `actionBtn` setup ~3164/3206) + keyboard for desktop. While the ball is in the
  air to the user's receiver:
  - **RAC** — catch in stride, preserve momentum/heading (flows straight into
    `enterRun`). Smallest reach, biggest YAC.
  - **Possession** — plant + secure; widest *timing* leniency, lowest drop risk,
    kills momentum.
  - **Aggressive** — must be armed *early*; forces the `leap`/high-point style,
    largest vertical reach, but momentum loss and (Phase 3) hit risk.
- **Wire into existing code, don't fork it:**
  - The armed style overrides the auto-pick in `commitCatchReach()` (5446)
    instead of reading geometry.
  - It feeds `tryReception()` (5466) as a modifier on `base`/`pCatch`: possession
    +catch/−reach, aggressive +reach/+vertical edge/−security, RAC neutral catch
    but a post-catch momentum bonus in the `secured`→`enterRun` handoff (5363).
  - Add a **timing term**: a `catchInput` window opens when `catchGap < ~1.4`
    (reuse the `commitCatchReach` "imminent" test). Press inside it = bonus;
    miss/late = penalty. Surface a single `userCatchScore` so CPU receivers keep
    using pure AI odds and the human's input layers on top.
- **AI fallback unchanged:** CPU receivers (and the user's other, non-targeted
  WRs) keep auto-resolving exactly as today — so nothing regresses.

**Done when:** on your own pass you can choose how to attack the ball, good timing
is rewarded, and each style visibly + statistically differs. **Risk:** Low–Med —
mostly additive; the hard part is window tuning, which the existing `TUNE` +
`catchLog` telemetry already support.

---

## Phase 2 — Pre-catch feedback & game-feel for the user catch

**Goal:** make the Phase 1 catch feel *fair and smooth* — the layer that turns a
mechanic into something that reads naturally.

- **"Catchable now" cue:** when the user-catch window opens (Phase 1), pulse the
  receiver's `selRing`/reticle or flash the catch button hot (reuse the `setAction`
  `hot` styling ~3613). Mirrors the landing-ring readability already in place.
- **Catch-type affordance:** show which style is armed (button highlight / small
  HUD glyph) so the choice is legible mid-flight.
- **Input buffering:** accept a catch press fired slightly *before* the window
  opens (queue it, consume on open) so a fractionally-early tap never feels
  ignored — the top game-feel complaint in football titles.
- **Weight on the big ones:** extend the existing `timeScale.slow()` /
  `shake.add()` already used in `startSecure` (5382) to scale with catch
  difficulty — a contested aggressive grab gets more slow-mo punch than a flat
  checkdown.
- **Camera:** a subtle ease that keeps ball + receiver framed during descent
  (hook into the existing chase/coach cam) so the user can read the timing.
- *(Audio-lane hooks, hand off:)* a per-style catch sound + a "window open" tick.

**Done when:** a new player completes intentional catches without a tutorial and
the throw→track→press→secure sequence reads as one motion. **Risk:** Low.

---

## Phase 3 — Contested catches as physics + ball knockouts

**Goal:** make contests feel organic instead of diced, per EA's "ball is a physics
object" principle.

- **Knockout-on-contact:** when a defender's reach/swat (the `passBrokenUp` path,
  5395) actually intersects the ball's volume during the secure glide, route the
  ball through a real deflection (extend `ballLooseFromAir` 6052, which already
  makes a live loose ball) instead of always a scripted incompletion. A tipped
  ball can then be recovered by either team — drama the engine can already model
  (it has fumble recovery via `recoverFumble`/`nearestTeamToBall`).
- **Tip → live ball:** on a deflection at the catch point, give the ball a small
  random pop and leave it `loose` so the existing loose-ball scramble takes over.
- **Possession-vs-hit:** tie the Phase-1 styles to consequences — a possession
  catch into traffic risks the jarring-hit/fumble path; RAC into space gets clean
  YAC. Reuse the tackle/`beginTackle` + strip systems already present.
- **Defender high-point:** currently picks happen mainly in tight coverage / off
  caroms (see the comment at 5488–5490). Optionally let a DB who clearly
  out-leaps the WR (`dbReachV` already computed, 5515) play a genuine high-point
  pick animation rather than only a swat.

**Done when:** throwing into coverage is a real risk/reward read and the ball
behaves believably when contested. **Risk:** Med–High — touches ragdoll/loose-ball
and physics timing; gate behind a `TUNE` flag and validate with the headless +
playwright harness in `CLAUDE.md`.

---

## Phase 4 — Animation & IK depth (the "natural-looking" pass)

**Goal:** broaden the clip/pose library so catches at every height/angle look
authored, not generic. Biggest pure visual-quality lift.

- **Hand IK to the ball.** `applyCatchPose` (6421) already reaches the arms by
  *angle*; add a light two-bone IK so the hands actually converge on the ball's
  predicted intercept point (blended over the clip). This is the single highest-
  impact "natural" change — hands meeting the ball every time.
- **New clips** (assets already ship `animations2–5.glb`; check for unused names
  before authoring): a true **possession/secure-and-protect**, a **sideline
  toe-tap** (pairs with Phase 5), a dedicated **high-point/contested grab**, and a
  **one-hand stab**. Slice/retarget the same way `catchClip`/`diveCatchClip` are
  built (`subclip` + `inPlace`, ~1382/1430).
- **Contact-frame sync:** keep the "close the hands" frame aligned with the
  `startSecure` resolution (already the design — preserve it for new clips).
- **Two-player contested interaction:** a relative box-out/hand-fight pose pairing
  the WR and DB during the descent (extends the "battle for the ball" trigger at
  5304–5317 from "both reach independently" to "they contest each other").

**Done when:** catches read as the player reaching for *that* ball, including
contested grabs. **Risk:** High — asset/authoring dependency; sequence after
Phases 1–3 so gameplay isn't blocked on art. Validate one IK reach early.

---

## Phase 5 — Sidelines, boundaries & situational catches

**Goal:** situational realism that the caged field currently precludes.

- **Toe-tap / feet-in-bounds:** today the cage means no out-of-bounds
  (`keepReceiverInbounds` 2855 + `clampToField`). Introduce a true sideline so a
  catch near it requires getting feet down — pairs with the Phase-4 toe-tap clip
  and the Phase-1 possession style.
- **Back-of-end-zone & corner-fade** catches as recognized situations.
- **Catch-and-protect near contact** vs **extend for the pylon** as a late micro-
  choice on the carrier.

**Done when:** sideline and end-zone catches play by real rules. **Risk:** Med —
interacts with the cage/clamp design; may be partial/optional.

---

## Phase 6 — Ratings, traits & tuning depth

**Goal:** make catching a tunable system, extending the existing ratings.

- The contest math already reads `rt.skill`/`rt.speed` (`vReach` 5418,
  `tryReception` 5495+). Split into football-specific attributes:
  `catchInTraffic`, `spectacularCatch`, `hands`, feeding the Phase-1/3 modifiers
  and Phase-4 clip selection.
- **Catch traits** that bias CPU receivers' auto-style choice (RAC / Possession /
  Aggressive man), mirroring Madden — slots straight into the `commitCatchReach`
  auto-pick.
- **Difficulty already exists** (`rookie/pro/allpro`, `cpuCatch`/`cpuAcc` ~2590);
  extend with a user-catch leniency term per difficulty.
- **Telemetry:** `catchLog` (5492) already logs gap/height/branch — add a small
  catch-rate / drop-cause overlay to balance against.

**Done when:** receiver builds feel distinct and the system tunes without code
spelunking. **Risk:** Low.

---

## 3. Sequencing, dependencies & recommended first slice

| Phase | Theme | Depends on | Risk | Payoff |
|------:|-------|-----------|------|--------|
| 1 | User catch + 3 styles | — | Low–Med | The headline feature |
| 2 | Feedback & game feel | 1 | Low | Makes it feel fair |
| 3 | Contest physics + knockouts | 1 | Med–High | Drama / realism |
| 4 | Animation & IK depth | 1–3 | High (assets) | Looks natural |
| 5 | Sidelines & situational | 1,4 | Med | Situational realism |
| 6 | Ratings / traits / tuning | 1–4 | Low | Replayability |

**Critical path for "smooth & natural-looking":** 1 → 2 → 4. Phase 1 gives the
player agency; Phase 2 makes that agency feel fair; Phase 4 (hand IK + clips) is
where the *look* is won. Phases 3/5/6 add depth on top.

**Recommended first slice (one shippable increment):**
**Phase 1 RAC-only + the Phase-2 "catchable now" cue.** On your own pass, press to
catch in stride inside a timing window, with a button that lights up when the
window opens. It reuses `commitCatchReach` / `tryReception` / `startSecure` almost
verbatim, adds one button and one modifier, and instantly turns the catch from a
spectator moment into a play you make. Validate with `node --check`, the headless
init harness, and the playwright shooter per `CLAUDE.md` before pushing.
