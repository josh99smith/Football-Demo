# Blitz: The League — Visual & Gameplay Reference

> **Source of truth for look, feel, and style.** Derived from a 24s gameplay
> capture of *Blitz: The League* (PS2-era, Midway) supplied as the inspiration
> target. Refer back to this doc — and the frames in `docs/reference/` — on every
> aesthetic/gameplay revision going forward. The original video is not stored in
> the repo (it lived in an ephemeral session upload); these notes + stills are the
> persistent record.

Reference stills (in `docs/reference/`):
- `blitz-hud.jpg` — in-play HUD: ground rings, name tags, scorebug, stiff-arm.
- `blitz-dirtyhit.jpg` — badge callout (`Dirty Hit!` + power number `93`) and the
  `3 YD LOSS` play-result text; standover pose.
- `blitz-touchdown.jpg` — `TOUCHDOWN!` badge callout.
- `blitz-standover.jpg` — low-angle intimidation/standover cinematic.
- `blitz-celebration.jpg` — post-score hero/flex cinematic, exaggerated build.

---

## The aesthetic in one line
Gritty, over-the-top, late-2000s arcade brutality: exaggerated musclebound
players, harsh stadium lighting with lens flare, hard-contrast/slightly
desaturated grade, motion-blurred bone-crunching hits, and a HUD that lives **on
the field** (rings + floating name tags) rather than in the corners.

## Signature visual language (what makes it read as Blitz)
1. **On-field player tags.** Every relevant player has a floating **name label**
   beneath them (HICKS, WATT, ALLAR, METCALF, BATTAGLIA, ROSS, HUNTER) — not just
   the one you control. The controlled man's tag is brightest.
2. **Ground reticle under the controlled player.** Concentric **pulsing blue
   rings** + a small directional marker. The ball carrier gets a **red, feathered
   "flame" swirl ring** instead. This is the primary "who am I / who's selected"
   indicator.
3. **Turbo as a ground arc.** Turbo reads as a **segmented radial meter wrapped
   around the player** (blue → yellow → red), drawn on the turf, not a top bar.
4. **Badge callouts.** Events pop a **circular icon + bold italic label**, often
   with a **power number** under it: `Dirty Hit! / 93`, `TOUCHDOWN!`,
   collision-rating numbers (`97`, `93`) flashed on impact.
5. **Play-result text** top-left: `3 YD LOSS`, gain/loss, big and terse.
6. **Broadcast scorebug** centered up top: orange **LED game clock** + `1ST QTR`,
   flanked by stadium scoreboard panels; helmet markers stand on the sideline.

## Signature camera / cinematics
- **Pre-play hero shots** — slow, low, close orbit on a star player.
- **Cinematic big-hit cam** — extreme close-ups, helmets flying past the lens,
  low ground angles, heavy motion blur, brief slow-mo.
- **Post-TD flex/standover cinematics** — camera looks *up* at the scorer flexing,
  or *down the barrel* at a flattened opponent's helmet (intimidation).

## Signature mechanics seen
- **Turbo** burst (already in the demo).
- **Stiff-arm / juke / broken tackles** with defenders sent sprawling (in the demo).
- **TAUNT** — showboat while running (ball held aloft); risk/reward.
- **DIRTY HIT / late hit** — extra-violent hit with a power rating; the Blitz
  hook (its "Clash"/injury system). Surfaces as the `Dirty Hit! 93` badge.
- **Diving / airborne tackles.**
- **Hit-power numbers** flashed on every meaningful collision.

---

## Implementation plan (phased, incremental)

Each phase is independently shippable and verified with the existing harness
(`node --check`, headless init, live WebGL render). Ordered by impact-to-effort —
the HUD phase alone makes the demo instantly read as Blitz.

### Phase A — On-field HUD language *(highest impact, low risk)*
- **A1. Floating name tags** under every player (CanvasTexture/sprite or CSS
  billboard projected to screen). Controlled = bright, others = dim; ball carrier
  highlighted. Reuse player ratings' surnames.
- **A2. Reskin the selection rings** (`ctrlRing`/`selRing`) into the Blitz reticle:
  concentric **pulsing blue rings** for the controlled defender/receiver; a
  **red feathered flame swirl** for the ball carrier.
- **A3. Turbo ground arc.** Add a segmented blue→yellow→red radial meter ring on
  the turf around the controlled player, driven by the existing turbo value
  (keep or retire the top-bar meter).
- **A4. Play-result text** top-left (`+12 YD`, `3 YD LOSS`, `INCOMPLETE`).

### Phase B — Badge callouts & juice
- **B1. Badge callout component** — circular icon + bold italic label + optional
  power number, replacing/augmenting the current text banners. Map: `BIG HIT!`,
  `GANG TACKLE!`, `TOUCHDOWN!`, `PICKED OFF!`, plus new `DIRTY HIT!`.
- **B2. Hit-power numbers** — compute a 60–99 "collision rating" from
  momentum + impulse on each tackle and flash it with the badge.
- **B3. Motion blur + harsher slow-mo** on big hits (radial/directional blur
  shader pass or a cheap fake), leaning into the existing bullet-time.

### Phase C — Cinematics & aesthetic grade *(uses video as pose/look reference)*
- **C1. Color grade / post.** Add a post pass: slight desaturation, raised
  contrast, vignette, warm stadium-light bloom + occasional lens flare from the
  light towers. This is the biggest single "feels like Blitz" lever.
- **C2. Pre-play hero cam** — a short low orbit on the star before the snap.
- **C3. Post-TD flex + standover cams** — look up at the scorer; look down at a
  downed opponent's helmet. Pairs with the celebration poses (Phase D).

### Phase D — Poses & new mechanics *(animations from the video as pose material)*
- **D1. Pose adaptations** (procedural one-shots or clips from `animations2.glb`):
  **flex/double-bicep celebration**, **taunt** (ball held aloft mid-stride),
  **standover** (winner stands over a downed player). Use the video frames as the
  target keyposes.
- **D2. TAUNT mechanic** — contextual showboat while in the open field; speed
  cost / fumble risk for style.
- **D3. DIRTY HIT** — a late/charged hit option that flashes the `Dirty Hit!`
  badge and a high power number; optional brief "injury"/stagger on the victim.
- **D4. Diving tackle** — an airborne lunge tackle (defense).

---

## Working agreement
On any future revision touching look/feel/gameplay, re-read this doc and the
reference stills first, and call out which Blitz element a change is serving.
