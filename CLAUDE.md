# Project conventions

## Branches & deploy
- **Dev branch:** `claude/loving-planck-svymf8` — do all development here.
- **Pages branch:** `claude/football-game-demo-6gi1s5` — the repo default branch;
  GitHub Pages deploys from it via `.github/workflows/deploy-pages.yml`.
- **Standing rule:** after committing + pushing a change to the dev branch,
  **fast-forward the Pages branch to the dev tip and push it** so the live site
  stays current — without being asked each time. It's always a clean
  fast-forward (dev is strictly ahead). Confirm the deploy run kicks off.

## Blitz revamp
- `docs/BLITZ_REFERENCE.md` (+ `docs/reference/*.jpg`) is the source of truth for
  look/feel/gameplay. Re-read it on any aesthetic/gameplay revision.

## Verify before pushing
- `node --check src/main.js src/ragdoll.js`
- Headless init harness in `/tmp/h` (expects "COMPLETED WITHOUT THROW"; the
  `*.scale.setScalar` line is the stub, not a real error).
- Live WebGL render via the playwright shooter for visual changes.
