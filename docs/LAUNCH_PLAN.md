# Launch Plan — Polish & Ship

> Phased plan to take the game from "feature-rich Blitz-style demo" to a
> launchable product. Inspiration: **Blitz: The League** (see
> `docs/BLITZ_REFERENCE.md` + `docs/reference/*.jpg`). Re-read that doc on any
> look/feel/gameplay work. Phases are ordered so each is independently shippable
> and the early ones de-risk the later ones.

## Where we are (done)
The Blitz revamp **A–D is complete**, plus a lot of systems on top:
- **HUD on the field** — name tags, blue control reticle, red carrier swirl,
  turbo ground arc, top-left play-result, broadcast scorebug.
- **Juice** — badge callouts + hit-power numbers, DIRTY HIT tier, impact
  vignette, bullet-time, screen shake, helmet pop-off + blood spray + **lasting
  blood stains** (cleared each quarter).
- **Cinematics** — color grade + vignette, post-TD flex cam, fireworks cam,
  multi-angle instant replay.
- **Celebrations** — random, **home-team-only** fireworks **or** dark-arena red
  strobe + white-spotlight light show; sideline benches react; confetti.
- **Mechanics** — turbo, juke/spin/stiff-arm/hurdle/cage-jump, TAUNT, diving
  tackle, gang-tackle pile (late pile-on + drive + scaled collapse), break-tackle
  + loose-ball **scrum** mash, **fatigue**, **safeties**, **running clock**.
- **World** — cut-out photo crowd (~2,450), team benches (pace + emote), light
  towers, jumbotron ads, LED ribbon, Blitz Cola sideline carts.
- **Plumbing** — PWA (network-first SW so updates land), self-healing NaN/skeleton
  guards, GC-friendly replay/trail pooling, slimmed assets, auto-deploy to Pages.

---

## Cross-cutting (address before/while shipping)
- **⚠️ IP / branding.** "Blitz: The League" is Midway/WB IP and the in-game
  "BLITZ" wordmarks are placeholders. **Ship under an original name/logo** and
  scrub trademarked text/marks (cola cart, end-zone logos, title). Inspiration is
  fine; trade dress is not.
- **⚠️ Photosensitivity.** The light-show **red strobe** is a seizure risk. A
  **"reduced effects / no strobe" setting (and a first-run photosensitivity
  notice)** is a launch blocker, not a nice-to-have.
- **Verification harness is down.** The chromium/WebGL render harness stopped
  launching mid-session; visual changes are currently only `node --check` + the
  headless init harness. Restoring on-device/automated visual QA is Phase 1.

---

## Phase 1 — Stabilize & perform (foundation; do first)
**Goal:** rock-solid 60fps-ish on a mid phone, no drift over a full game, and a
working visual-QA loop. Nothing else matters if it stutters or corrupts.
- **Restore visual QA** — get the playwright/WebGL shooter launching again (or a
  substitute); add a scripted "play a full game" smoke capture.
- **Crowd/bench performance** — ~2,450 fan sprites + 14 bench characters are the
  draw-call risk. Rebuild the crowd as **one InstancedMesh with a billboard
  shader** (single draw call → can go denser for free); LOD/pause bench mixers
  when off-camera. Establish a **draw-call + frame budget** and profile on a real
  mid-tier Android + iPhone.
- **Long-soak stability** — auto-play 4 full quarters repeatedly; watch for NaN,
  skeleton drift, memory growth (replay buffers, blood stains, popped helmets,
  ragdolls). Confirm the recent self-healing guards hold.
- **Device/browser matrix** — iOS Safari, Android Chrome, desktop; landscape
  gate, fullscreen, touch controls, safe-areas.
- **Exit:** stable FPS target met on the matrix; a full game runs clean; visual QA
  loop usable.

## Phase 2 — Presentation polish (the Blitz "feel")
**Goal:** it should *sound and look* like a broadcast of a brutal arcade league.
- **Audio (biggest missing lever).** Blitz's signature is its gritty **announcer /
  play-by-play**. Add: PA + color commentary lines (snap, big hit, DIRTY HIT, TD,
  fumble, safety, ON FIRE), swelling **crowd ambience** tied to the action,
  **music** (menu + an ON-FIRE track), richer layered hit SFX, ref whistle.
- **Camera & replay** — tighten big-hit motion blur, ensure replays reliably
  showcase the signature moment; cut timing; a "highlight" cut on DIRTY HITs.
- **Lighting/grade** — bloom from the towers/jumbotron, occasional lens flare, a
  consistent night grade (vet against the reference stills).
- **UI consistency** — scorebug, menus, play-select route art, fonts, the
  broadcast lower-thirds; unify spacing/typography.
- **Exit:** a 30-second clip reads unmistakably as "Blitz."

## Phase 3 — Gameplay depth (Blitz inspiration)
**Goal:** more than one-and-done plays — systems that reward aggression.
- **CLASH / rage mode** — Blitz: The League's hook. Build a Clash meter from big
  hits / dirty hits / breakaways; spend it for an "unleashed" powered play
  (extend ON FIRE into a chargeable, dramatic state with its own VFX/cam).
- **Injury system** — brutal-hit consequence: a chance a player is dinged on a
  DIRTY HIT (limps off / reduced ratings for the drive), with an **X-ray/replay
  flourish**. Ties into the helmet pop + blood already in.
- **Playbook depth** — more offensive concepts + defensive calls, simple
  formations, an audible. Keep the 2-button scheme.
- **Difficulty** — selectable difficulty; final AI tuning pass (sacks, pursuit,
  coverage, CPU play-calling) building on recent balance work.
- **Post-game stats** — yards, TDs, big hits, longest run, ON-FIRE streak.
- *(Optional, very Blitz)* between-play **wager/risk** beats.
- **Exit:** a full game has momentum swings and "did you see that" moments.

## Phase 4 — Modes, meta & onboarding
**Goal:** reasons to come back + a clean first run.
- **Modes** — Quick Play vs a **Season/Gauntlet** (a run of escalating opponents
  with a win/lose arc).
- **Team select / skins** — beyond red vs blue: a few teams (names, colors,
  helmets); pick yours.
- **Settings** — effects intensity / **reduced-motion + no-strobe** (see
  cross-cutting), audio volumes, control options, camera shake amount.
- **Persistence** — high scores, longest streak, settings, last team
  (localStorage).
- **Onboarding** — a short interactive tutorial / contextual control hints; the
  contextual ACTION button already self-labels — lean on that.
- **Exit:** a new player understands the controls in <30s and has a reason to
  replay.

## Phase 5 — Launch readiness
**Goal:** shippable, observable, safe, discoverable.
- **PWA** — verify install + **offline** + the network-first **update flow**
  end-to-end; polished icons/splash; "add to home screen" UX.
- **Share** — capture/share a big-play **replay clip or screenshot**; OG/Twitter
  meta + a simple **landing page**.
- **Telemetry** — lightweight analytics + **error reporting** so post-launch
  breakage surfaces (we've been flying blind on device).
- **Accessibility & safety** — photosensitivity notice + reduced-effects default
  check, colorblind-friendly reticle/markers, legible text sizes, pause.
- **Branding/legal** — original name + logo, scrub trademarks (see cross-cutting).
- **Final QA gate** — performance budget met, full-game soak clean, matrix signed
  off, no console errors.
- **Exit:** tagged release, deployed, monitored.

---

## Suggested order & sequencing
1 → 2 → 3 → 4 → 5, but **pull two cross-cutting items forward**: the
**no-strobe/reduced-effects setting** and the **branding scrub** should land
early (cheap, and they're launch blockers). Performance (Phase 1) gates
everything because the crowd/bench cost compounds as we add VFX.

## Working agreement
Each phase ships in small, verified commits (per `CLAUDE.md`): `node --check`,
headless init, on-device/visual check when the harness is back, then dev →
fast-forward Pages. Re-read `docs/BLITZ_REFERENCE.md` before look/feel work.
