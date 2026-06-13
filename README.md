# 7-on-7 Blitz Football

A mobile-friendly WebGL arcade football game — NFL Blitz-style 7-on-7: run a
full passing play from snap to score.

## Blitz rules

- **30 yards for a first down**, drives start on your own 20. No punts, no
  field goals — you go for it.
- **Four short quarters** on a running game clock (it stops between plays) with
  a **halftime**, then a FINAL and a one-tap **REMATCH**. A **delay-of-game
  play clock** ticks pre-snap and auto-snaps if you stall.
- **Line-of-scrimmage (blue) and first-down (yellow) markers** stripe the field
  with sideline down-marker posts so you always know the sticks.
- **Turnovers are live**: an interception can be **returned for a touchdown**
  (you flip to defense and chase the runner — stop him and it's just a
  turnover), and **big hits can force fumbles** that the defense may recover.
- **Turbo meter**: hold TURBO for a 1.4x burst; the meter drains while you
  burn it and refills when you don't (including between plays).
- **JUKE** (run phase): a hard lateral burst — time it as a tackler arrives
  and he *whiffs right past* (and hits the turf, courtesy of the ragdolls).
  A lone arm-tackle can also be **broken** outright (strength + momentum vs
  the pile; turbo and ON FIRE help, a gang is hard to slip).
- **Break-tackle battle**: a clean one-on-one hit can trigger a Tecmo-style
  tug-of-war — **mash the action button** (or tap the on-screen bar) to break
  free before the timer/CPU wins. Win and you burst out with a step of
  immunity; lose and you go straight down.
- **ON FIRE**: score 3 straight touchdowns and your whole offense ignites —
  flaming ball, +12% team speed, and unlimited turbo. An interception or a
  turnover on downs puts the fire out.
- Bullet passes, a faster squad on both sides, and most square hits are BIG. Built with [three.js](https://threejs.org/). One rigged
character is cloned 14 times (each with its own skeleton) and driven by
shared idle / walk / run glTF clips.

## How to play

You start every play as the **quarterback**.

1. **Pick a play** from the four-play call screen (BOMBS / SLANTS / MESH /
   FLOOD — tap a card or press 1–4), then **tap SNAP**. Your six receivers run
   that concept's routes; the defense covers them man-to-man.
2. **Aim with the left stick** — the receiver you point toward (yellow arrow +
   ring) becomes your target. Push the stick to scramble too.
3. **Tap THROW for a lob, hold for a bullet** to the targeted receiver.
4. On a catch you **take over the receiver** — run for the end zone. Hold
   **SPRINT** for a burst. Defenders pursue and tackle on contact.
5. **Throw a pick and you flip to defense** — take over the nearest man and
   chase the returner down before he takes it the other way for six.

Touchdowns, tackles, incompletions and interceptions all reset for the next
play, with **down & distance** and the **score** tracked on the HUD.

### Controls

| Input | Action |
| --- | --- |
| **Left joystick** | Move + aim the targeted receiver (camera-relative) |
| **SNAP** then **THROW** (tap=lob, hold=bullet) / **JUKE** | Contextual action button |
| **TURBO** (hold) | Sprint burst — QB scramble or ball carrier |
| **SPIN** (run) | Spin past a defender — or **stiff-arm** (truck) one right in front |
| **DIVE** (run) | Committed forward lunge for the sticks/pylon — then you're down |
| **PITCH** (run) | Lateral to a trailing teammate (risky near coverage) |
| **WASD / arrows** (desktop) | Move + aim |
| **Space** | Snap / throw / juke |
| **Q / E / F** (desktop) | Spin / dive / pitch |
| **Shift** | Turbo |

Cross the line of scrimmage as the QB to commit to a **scramble** (the play
becomes a run and your receivers block for you).

## Player AI

The steering AI is adapted from
[Football-Game](https://github.com/josh99smith/Football-Game):

- **Defenders** solve a true pursuit/cut-off angle to meet the ball carrier
  (instead of trailing), and gang-pursue with anti-clumping separation.
- **Coverage** is man-to-man with goal-side leverage; DBs break on the ball
  once it's in the air. A deep safety patrols the middle third.
- **Receivers** run crisp route cuts (gather, then burst out of the break) and
  work back to open grass after the route; off-ball teammates pick up the
  nearest rusher to block once you take off running.

## Ragdoll tackles

Tackles are resolved with real physics ([Rapier](https://rapier.rs/), vendored
in `vendor/rapier/`), ported from Football-Game's `TackleRagdoll`:

- On contact the carrier's **current animated pose is snapshotted** and a
  capsule rigid body is spawned per limb, thrown with the runner's momentum
  plus the hit impulse — every tackle falls differently.
- The fall reaction is picked from the contact: **high knock, low cut, side
  swipe, or a gang-tackle twist**; the lead tacklers recoil and tumble too.
- Soft **anatomical cone+twist joint limits** (enforced per physics substep)
  keep bodies from folding or candy-wrappering; collision groups keep a pile
  from exploding.
- The skinned mesh bones are **driven from the rigid bodies** each frame, and
  the ball is spotted where the pile's mass-weighted momentum slid to.

## Game feel

Controls, camera and juice follow Football-Game's systems:

- **Movement** integrates toward the stick at a real acceleration, braking
  harder than it accelerates (hardest with no input) for crisp cuts and stops;
  heading is rate-limited so players carve through turns. Turbo is 1.35x.
- **Camera** is an eased chase cam that pans (never snaps): as QB it drifts
  toward the receiver you're targeting, follows the ball in flight, then
  settles in low behind the runner. Tackles cut to a **cinematic 3/4 close-up**
  that pushes in on real time.
- **Juice**: trauma-based screen shake plus a directional kick that shoves the
  camera the way the runner is driven; **smooth bullet-time slow-mo with a FOV
  zoom-in** on big hits and gang tackles (no freeze-frame — ragdoll physics
  steps by the scaled frame delta so the fall is smooth at any speed);
  center-screen callouts (BIG HIT! / GANG TACKLE! / TOUCHDOWN! / PICKED OFF!).

## Running locally

Static site — serve over HTTP (ES module import maps need a server):

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Project layout

- `index.html` / `src/style.css` — shell, HUD, touch controls
- `src/main.js` — field, character cloning, play-state machine, route &
  coverage AI, ball flight, scoring
- `assets/character.glb` — rigged character + idle pose
- `assets/animations.glb` — locomotion + action clips on the character's own
  rig: breathing idle, walk, run, RunFast (sprint), dodge-roll juke, catch,
  get-ups, backpedals, sharp turn
- `vendor/three/` — vendored three.js + GLTFLoader + SkeletonUtils (no CDN)
- `vendor/rapier/` — vendored Rapier3D physics (ragdoll tackles)

## Deploy

The default branch publishes to GitHub Pages via
`.github/workflows/deploy-pages.yml`.
