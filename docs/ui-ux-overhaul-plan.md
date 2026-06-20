# UI / UX Overhaul — Phased Plan

A roadmap to take the Reapers football game's interface from "everything on screen
at once" to a clean, broadcast-style UI with **complete player control** — a real
pause menu, settings sub-menus, tabs, and context-aware HUD — grounded in the
current DOM/CSS in `index.html` + `src/style.css` and the builders in `src/main.js`.

> Lane note (per `CLAUDE.md`): this is the ENGINE/MECHANICS + UI lane. Settings
> that touch audio (volume sliders, mute) drive existing hooks like
> `TUNE.masterVolume` / `applyAudio()` — wire the controls here, but coordinate
> the actual audio behavior with the AUDIO session; don't edit `src/audio.js`.
> Re-read `docs/BLITZ_REFERENCE.md` for the broadcast look before styling.

---

## 1. The problem, diagnosed in the current code

The UI is all DOM overlays over a `<canvas>`, built ad-hoc. Three structural
issues cause the clutter (not just "too many buttons"):

1. **No information architecture / screen states.** Elements show/hide
   individually via `.hidden` toggles in `updateButtons()` (~3616) and friends.
   During play-select, ~10 overlays are visible simultaneously:
   `#topbar` (scoreboard), `#userstats` (TKL/CAT/INT), `#playresult`, `#simbar`
   (SKIP QTR / SIM GAME), `#fs-btn`, `#playercards`, `#playselect`, `#coach-btn`,
   `#joystick`, `#action-btn`+`#turbo-btn`. Nothing suppresses what's irrelevant
   to the current moment.

2. **No z-index layer system.** `src/style.css` hand-assigns `z-index` from 5→70
   with comments like *"above #playselect (35) so the debug-open tap isn't
   swallowed"* (style.css ~319). Every new element re-negotiates the stack by hand
   — fragile and a source of tap-eating bugs.

3. **No pause / settings menu exists.** Grep confirms the only "pause" is clock
   stoppage + replay scrub — there is **no** game menu. So utility actions
   (skip quarter, sim game, fullscreen) have nowhere to live and leak onto the
   field as always-on buttons.

Plus a concrete front-end bug: on the start screen the big `.sm-title`
("REAPERS FOOTBALL", style.css ~975+) overlaps the `.sm-versus` matchup row on
phone widths — the team names collide (see screenshot).

**What's already good and worth keeping:** the play-select deck is already a clean
card/pager pattern (`#playselect` w/ arrows + dots); the broadcast FX layers
(`#grade`, `#slowmo`, `#cut`, `#banner`) are nice; the replay overlay has a solid
control cluster. The debug panel (`buildDebugPanel` ~7618) is already a tabbed
panel we can mine for component patterns.

---

## 2. Design principles (the targets)

1. **Progressive disclosure.** Show only what the current game state needs.
   A live play needs almost no HUD; a pause needs everything.
2. **One home for utility.** Skip/sim/settings/quit live in the pause menu, off
   the field.
3. **A real layer system.** Replace hand-tuned z-indices with named tiers.
4. **Component reuse.** One modal, one tab bar, one slider, one toggle — reused
   everywhere (front-end, pause, settings, debug).
5. **Broadcast aesthetic + readable on a phone in landscape.** Safe-area aware,
   fluid type, big touch targets, no overlaps.
6. **Complete control, never trapped.** Every screen has a clear way in and out;
   pause is always reachable; nothing is a dead end.

---

## Phase 1 — Foundation: design tokens + layer system + UI state machine

**Goal:** the scaffolding every later phase builds on. No new screens yet — this
makes the rest fast and consistent.

- **Design tokens** (CSS custom properties in `:root`): color ramp (team
  home/away already exist as `--home`/`--away`), surface/overlay backgrounds,
  spacing scale, radius, fluid type scale (`clamp()`), the Blitz accent. Migrate
  existing magic values to tokens.
- **Named z-index tiers** — replace the 5→70 sprawl with a documented ladder, e.g.
  `--z-world:0`, `--z-hud:10`, `--z-fx:20`, `--z-cards:30`, `--z-overlay:40`,
  `--z-modal:50`, `--z-toast:60`, `--z-debug:70`. Map every element onto a tier;
  delete the "above X so taps aren't swallowed" comments.
- **UI state machine.** Today's `game.state` (PRESNAP/LIVE/AIR/RUN/REPLAY/…) drives
  gameplay; add a thin **UI layer** that maps each state → which HUD groups are
  visible, so visibility is declared in one place instead of scattered `.hidden`
  toggles. One `applyUIState()` called when state changes.
- **Reusable components** (vanilla JS factories + CSS classes): `Modal`,
  `TabBar`, `Slider`, `Toggle`, `SegmentedControl`, `Button` (primary/ghost/danger).
  Refactor one existing surface (the difficulty buttons) onto `SegmentedControl`
  as the proof.

**Done when:** nothing renders differently, but visibility is centralized, the
z-index ladder is named, and the component kit exists. **Risk:** Low–Med (broad
but mechanical). Validate with `node --check` + the playwright visual shooter.

---

## Phase 2 — The pause menu (headline feature)

**Goal:** a single reachable hub for control — the thing most missing today.

- **Entry:** a small persistent **pause/gear button** (top corner, replacing the
  loose `#fs-btn`/`#simbar` clutter) + `Esc`/`P` on desktop. Pausable any time the
  ball is dead (between plays) and during live play (soft-pause the sim loop —
  `animate()`/`update(dt)` already centralize the tick, so gate it on a
  `game.paused` flag).
- **Structure: a `Modal` with a `TabBar`:**
  - **Resume** — big primary button (also tap-outside / Esc to close).
  - **Settings** — opens the Phase-4 settings tabs.
  - **Game** — Skip Quarter / Sim Game (move `#simbar` here), Restart, Quit to
    Menu. The field stops being a button bar.
  - **How to Play** — controls reference (joystick, TURBO, contextual ACTION
    labels: SNAP/THROW/JUKE/TACKLE/SWITCH…), the catch-type legend (ties into the
    catching plan), play-art explainer.
  - **Stats / Box score** — season + this-game numbers; fold in `#userstats`
    (TKL/CAT/INT) and the post-play card data so they're not always on screen.
- **Behavior:** dims the field with the existing `#grade`/vignette, traps focus,
  restores cleanly. Background sim frozen; replay/coach-cam states respected.

**Done when:** the player can pause from anywhere, reach every utility/setting,
and resume seamlessly — and SKIP/SIM/fullscreen are gone from the live field.
**Risk:** Med — needs the loop gate + focus handling. Build on Phase 1's `Modal`.

---

## Phase 3 — In-game HUD declutter (context-aware)

**Goal:** apply progressive disclosure so each moment shows only its essentials.

- **Live play:** minimal — just the broadcast scoreboard strip + the contextual
  ACTION + TURBO + joystick. Hide user-stats, play-result, coach, sim, fullscreen
  (all now in pause).
- **Pre-snap:** scoreboard + `#playselect` + coach-cam toggle. Nothing else.
- **Post-play:** result readout + replay prompt; auto-collapse after a beat.
- **Consolidate the scoreboard** (`#topbar`) into one broadcast bar: team marks +
  scores, clock/quarter, down & distance, play clock — sized so it never competes
  with the play cards. Use team colors (`--home/--away`) for identity instead of
  separate OFF/DEF tags.
- **Toasts/banners** (`#banner`, `#playresult`, "Tackled +15") routed through one
  toast component on the `--z-toast` tier with consistent placement + timing, so
  they stop stacking in the corner.
- **Auto-hide idle controls** during cinematic moments (replays, cut scenes,
  celebrations) — the FX layers already exist; just gate the HUD group.

**Done when:** at any instant the screen shows only what's relevant; the
play-select screen (the worst offender) is calm. **Risk:** Low — mostly wiring the
Phase-1 UI state map.

---

## Phase 4 — Settings, sub-menus & tabs

**Goal:** the "complete control" depth, organized so it never feels dense.

A `TabBar` inside the pause menu's **Settings** tab (or a standalone settings
modal reachable from the start menu too):

- **Audio** — master / music / SFX / announcer sliders + mutes → drive
  `TUNE.masterVolume` + the audio-session hooks (coordinate, don't edit
  `audio.js`).
- **Video** — quality preset (shadows, pixel ratio, crowd density), FPS counter
  toggle (`#fps`), brightness/vignette intensity (`#grade`).
- **Controls** — button layout (left/right-handed), joystick size/deadzone,
  vibration/haptics, desktop key reference, optional explicit catch/spin/dive
  shortcuts.
- **Gameplay** — difficulty (move the start-menu `ROOKIE/PRO/ALL-PRO` segmented
  control here too), quarter length, play clock on/off.
- **Camera** — chase distance/height, coach-cam default, screen-shake amount.
- **Accessibility** — text-size scale (hooks the fluid type tokens), reduced
  motion (tames shake/slow-mo/flash), colorblind-friendly team marks, high
  contrast.
- **Persistence:** save to `localStorage` (the game already uses it for stats —
  `USER_STATS_KEY`); load on boot before first render.

**Done when:** every meaningful knob a player wants is reachable, grouped in tabs,
and persists across sessions. **Risk:** Med — many small bindings; sequence after
the component kit so each control is one line.

---

## Phase 5 — Front-end / start-menu redesign

**Goal:** fix the overlap and make the matchup screen a proper front-end.

- **Fix the title/matchup collision** (`.sm-title` over `.sm-versus`): a clear
  vertical rhythm — kicker → title (or compact logo) → `VS` matchup → actions —
  with the big watermark logo behind, not behind the team names. Constrain widths
  with the new spacing tokens so phone landscape never overlaps.
- **Matchup card:** team crest + name + OVR per side (data already there:
  `teamSideHTML`, `TEAMS`), top players as a compact roster **sub-panel/tab**
  ("Roster") rather than crammed under the names.
- **Mode select as cards/tabs:** **Exhibition (Kick Off)** vs **Gauntlet**
  (3-teams-win-or-restart) — currently two stacked buttons; make them clear mode
  cards with one-line descriptions.
- **Difficulty** via the shared `SegmentedControl`; **Settings** entry from here
  too (reuses Phase-4 modal).
- **Polish:** consistent hover/press states, the Blitz grit/seam treatment kept
  but tidied.

**Done when:** the front-end reads cleanly with no overlaps, and mode/difficulty/
roster/settings are all one tap away. **Risk:** Low–Med (mostly layout/CSS).

---

## Phase 6 — Play-select & coach-cam refinement

**Goal:** elevate the already-decent play picker.

- **Categories/tabs or filters** on the deck (e.g. Quick / Shot / Run / Special)
  instead of one long pager — fewer swipes to the play you want.
- **Formation/route preview** enlarged on focus; the route art (coach-cam) shown
  inline on the card hover/long-press.
- **Recommended / last-used** quick slots.
- Consistent card styling with the new tokens; bigger tap targets; clearer
  selected state.

**Done when:** picking a play is faster and the cards match the new design system.
**Risk:** Low.

---

## Phase 7 — Debug panel reconciliation & final polish

**Goal:** unify and finish.

- **Fold the debug panel** (`buildDebugPanel` ~7618) onto the Phase-1 `Modal`/
  `TabBar`/`Slider` components so it shares styling and the `--z-debug` tier —
  keep it gated behind `?debug` / the gear-FAB as today.
- **Motion pass:** consistent open/close transitions for all modals/menus
  (respecting the reduced-motion setting).
- **Pass on every breakpoint** (small phone → tablet) with the playwright shooter;
  verify safe-area insets, no overlaps, no tap-eating across the new z-ladder.
- **Sound hooks** for menu navigation handed to the audio session.

**Done when:** one coherent design system spans front-end, HUD, pause, settings,
play-select, and debug. **Risk:** Low.

---

## 3. Sequencing, dependencies & first slice

| Phase | Theme | Depends on | Risk | Payoff |
|------:|-------|-----------|------|--------|
| 1 | Tokens + layer system + UI state machine | — | Low–Med | Makes everything else fast/consistent |
| 2 | Pause menu | 1 | Med | The headline: complete control |
| 3 | HUD declutter | 1,2 | Low | Fixes the cluttered feeling |
| 4 | Settings / tabs / sub-menus | 1,2 | Med | Depth of control |
| 5 | Front-end redesign | 1 | Low–Med | Fixes the overlap bug |
| 6 | Play-select refinement | 1 | Low | Faster play calling |
| 7 | Debug reconciliation + polish | 1–6 | Low | One coherent system |

**Critical path:** 1 → 2 → 3. Phase 1 is the enabler; Phase 2 delivers the pause
menu the user asked for; Phase 3 is what makes the game *feel* uncluttered.

**Recommended first slice (one shippable increment):**
**Phase 1 (lite) + a minimal Phase 2 pause menu.** Ship the layer-tier tokens, a
reusable `Modal`+`TabBar`, a `game.paused` loop gate, and a pause menu with
**Resume / Game (Skip·Sim·Restart·Quit) / How to Play** — then immediately move
`#simbar` and `#fs-btn` off the live field into it. That alone removes the most
visible clutter and proves the component kit. Validate with `node --check`, the
headless init harness, and the playwright shooter per `CLAUDE.md` before pushing.
