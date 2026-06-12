# Football Demo

A small WebGL playground: a third-person character you can run around an
American football field using mobile touch controls.

Built with [three.js](https://threejs.org/). The character mesh and its
locomotion clips (idle / walk / run) are loaded from glTF and driven by an
`AnimationMixer` with cross-fading between states.

## Controls

| Input | Action |
| --- | --- |
| **Left joystick** | Move — push further to run faster |
| **SPRINT button** | Hold to sprint |
| **WASD / arrows** (desktop) | Move |
| **Shift** (desktop) | Sprint |

The camera is a chase cam that trails behind the player as they turn.

## Running locally

It's a static site — serve the folder over HTTP (ES module import maps need a
server, not `file://`):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Assets

- `assets/character.glb` — rigged character + idle pose
- `assets/animations.glb` — merged walk / run / directional clips sharing the
  same skeleton

## Deploy

Pushing to `main` publishes to GitHub Pages via
`.github/workflows/deploy-pages.yml`.
