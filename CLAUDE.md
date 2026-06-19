# Project conventions

## Branches & deploy
- **Dev branch:** `claude/loving-planck-svymf8` — do all development here.
- **Pages branch:** `claude/football-game-demo-6gi1s5` — the repo default branch;
  GitHub Pages deploys from it via `.github/workflows/deploy-pages.yml`.
- **Standing rule:** after committing + pushing a change to the dev branch,
  bring the Pages branch up to the dev tip and push it so the live site stays
  current — without being asked each time. Confirm the deploy run kicks off.

## Multi-session coordination (IMPORTANT)
Two Claude sessions work this repo in parallel and **both push**:
- **This session — ENGINE & MECHANICS** (gameplay, physics/ragdolls, animation,
  camera, UI/menus, tools/debug, collisions). Work here.
- **The other session — AUDIO & MUSIC** (sound, music, announcer VO, audio assets).
  Stay out of `src/audio.js`, `assets/music/*`, `assets/vo/*`, and
  `docs/COMMENTARY_SCRIPT.md` unless asked — that's their lane.

Because both push, the Pages branch is **NOT always a clean fast-forward** — the
other session commits directly to it. So the deploy step is a **merge**, never a
force/clobber (never destroy their audio work):

1. Commit + push your change to **dev**.
2. `git fetch origin <pages>`; then **merge** `origin/<pages>` into dev
   (`git merge --no-edit origin/claude/football-game-demo-6gi1s5`). Conflicts are
   rare (different files/lanes) — resolve keeping BOTH sides' intent if any.
3. `node --check` + init harness on the merged tree; confirm both your changes and
   their audio changes survived (`grep` a known marker from each).
4. Push **dev**, then fast-forward **Pages** to the merged dev tip and push it.
5. Confirm the deploy run kicks off.

If a push is rejected as non-fast-forward, it means the other session pushed —
fetch + merge + retry (per above). Never `--force` either shared branch.


## Blitz revamp
- `docs/BLITZ_REFERENCE.md` (+ `docs/reference/*.jpg`) is the source of truth for
  look/feel/gameplay. Re-read it on any aesthetic/gameplay revision.

## Verify before pushing
- `node --check src/main.js src/ragdoll.js`
- Headless init harness in `/tmp/h` (expects "COMPLETED WITHOUT THROW"; the
  `*.scale.setScalar` line is the stub, not a real error).
- Live WebGL render via the playwright shooter for visual changes. Launch
  chromium with `--no-sandbox --disable-dev-shm-usage --use-gl=swiftshader
  --enable-unsafe-swiftshader` (the `--disable-dev-shm-usage` flag is required —
  without it chromium fails to launch once `/dev/shm` fills). Use a short
  per-click timeout (`{timeout:350}`) so missed clicks don't stall 30s. Software
  rendering runs at only ~2 fps, so it's for VISUAL checks, not FPS/clock timing.
