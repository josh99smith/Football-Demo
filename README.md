# 7-on-7 Football

A mobile-friendly WebGL football game: run a full 7-on-7 passing play from
snap to score. Built with [three.js](https://threejs.org/). One rigged
character is cloned 14 times (each with its own skeleton) and driven by
shared idle / walk / run glTF clips.

## How to play

You start every play as the **quarterback**.

1. **Tap SNAP** to start the play. Your six receivers run their routes; the
   defense covers them man-to-man.
2. **Cycle the target** with the **RECEIVER ▸** button (the yellow ring shows
   who you're aiming at). Scramble with the joystick if you need time.
3. **Tap THROW** to lead a pass to the targeted receiver.
4. On a catch you **take over the receiver** — run for the end zone. Hold
   **SPRINT** for a burst. Defenders pursue and tackle on contact.

Touchdowns, tackles, incompletions and interceptions all reset for the next
play, with **down & distance** and the **score** tracked on the HUD.

### Controls

| Input | Action |
| --- | --- |
| **Left joystick** | Move (camera-relative) |
| **SNAP / THROW / SPRINT** | Context button (right) |
| **RECEIVER ▸** | Cycle the targeted receiver |
| **WASD / arrows** (desktop) | Move |
| **Space** | Snap / throw / sprint |
| **E or Tab** | Cycle receiver |

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
- `assets/animations.glb` — walk / run / directional clips (shared skeleton)
- `vendor/three/` — vendored three.js + GLTFLoader + SkeletonUtils (no CDN)

## Deploy

The default branch publishes to GitHub Pages via
`.github/workflows/deploy-pages.yml`.
