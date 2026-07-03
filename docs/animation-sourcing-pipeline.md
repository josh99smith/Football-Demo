# Animation Sourcing & Retarget Pipeline

How to add new football-specific player animations to the game so they "just
work" with the existing loader, retargeting, and procedural-overlay systems.
This is a **process/reference doc**, not a phased build plan — follow it whenever
you add clips.

> Lane note (per `CLAUDE.md`): ENGINE/MECHANICS lane. Pairs with
> `animation-system-overhaul-plan.md` (the runtime blending) — this doc is the
> upstream content pipeline that feeds it. Re-read `docs/BLITZ_REFERENCE.md` for
> the over-the-top arcade look new clips should hit.

---

## 0. The constraint that drives everything

The runtime is simple and rigid about one thing: a clip only retargets if its
skeleton's **bone names exactly match the character rig**. Established facts about
the pipeline (from `src/main.js` / `src/ragdoll.js`):

- Character is a **Meshy-style rig** (~26 bones: `Hips`, `Spine01`, `neck`,
  `head_end`, `LeftUpLeg`, `LeftLeg`, `LeftFoot`, `LeftArm`, `LeftForeArm`,
  `LeftHand`, … and the right-side mirror).
- Clips ship in `.glb` files (`animations.glb`, `animations2–5.glb`) and retarget
  onto the character **because both share the exact same bone names** (verified).
- They're loaded via `GLTFLoader`, looked up by clip name (`byName['Running']`,
  `byName['Jump_to_Catch_and_Fall']`, …), then post-processed:
  - **trimmed** with `THREE.AnimationUtils.subclip(clip, name, startFrame, endFrame, fps)`,
  - made **in-place** with `inPlace` / `inPlaceY` (root motion stripped so the
    code drives position; vertical kept for jumps/dives via `inPlaceY`).
- Files are large (~8 MB each) and this is a **mobile web** game — size matters.

So: **any** source works as long as you retarget to this exact skeleton, strip
root motion, name the clip, and keep the file small.

---

## 1. Set up the retarget pipeline ONCE (the real unlock)

Do this first; then every source below is plug-and-play.

1. **Export the target skeleton.** Get the game's actual character rig into Blender
   (from `assets/character.glb`) — this is your retarget *target*, guaranteeing
   matching bone names on export.
2. **Pick a retargeter:**
   - **Rokoko Blender plugin** (free) — solid, retargets most mocap skeletons.
   - **Auto-Rig Pro** (~$40 Blender addon) — best remap controls / batch support.
3. **Retarget** the source motion onto the character skeleton in Blender.
4. **Strip root motion** so the clip is in-place (the code expects this; it adds
   world movement itself). Keep vertical for aerial moves (mirrors `inPlaceY`).
5. **Name the clip** clearly and consistently (see §4) — names are the runtime key.
6. **Export `.glb`**, batching several related clips into one file (like
   `animations2–5.glb`) to cut HTTP requests.
7. **Compress** with `gltf-transform` (Draco + quantization) before committing —
   essential on mobile. Target a meaningful size cut vs the raw export.

Once this is a repeatable recipe, sourcing is just "get motion → run recipe."

---

## 2. Where to get the motions (ranked for football specificity)

1. **Mixamo (free)** — the generic baseline you already use (locomotion, falls,
   generic catch/celebrate). Thin on football-specific moves, but free and easy.
2. **AI video mocap — best for niche, football-specific moves you can't find.**
   Act the exact move out with a phone, convert, retarget:
   - **DeepMotion** — single-camera, exports **GLB directly**, has text-to-motion.
   - **Move.ai** — highest fidelity (single/multi-phone), FBX/BVH out.
   - **Plask / Rokoko Vision** — free/cheap prototyping, GLB/FBX out.
   Use this for jukes, stiff-arms, swats, route breaks, QB throws, signature
   celebrations, tackle variants — the stuff the overhaul plans call for.
3. **Paid pro sports packs** — polished, game-ready football motion:
   - **MoCap Online** (dedicated football/sports packs, FBX/Blender).
   - **ActorCore (Reallusion)** (per-motion or subscription).
   - **Rokoko Motion Library** (+ their free sports pack to start).

## 3. Stylize for the Blitz look

Mocap is realistic; the game is over-the-top arcade. Two levers (both already in
the codebase's spirit):

- **Exaggerate in Blender** before export — bigger key poses, snappier timing.
- **Lean on the procedural layer** — `applyThrowPose` / `applyCatchPose` / the
  planned additive overlays + IK push a believable mocap base into Blitz
  territory at runtime. New clips are the *base*, not the final look.

---

## 4. Conventions so new clips drop straight in

- **Bone names:** must match the rig exactly (retarget to the exported character).
- **Clip names:** descriptive PascalCase/underscore, matching how the code keys
  them (e.g. `Stiff_Arm_Right`, `Route_Break_In`, `Spin_Move`, `QB_Throw_Bullet`).
  Add the lookup + `subclip`/`inPlace` wiring next to the existing ones.
- **In-place:** strip root motion (`inPlace`); keep vertical for aerial clips
  (`inPlaceY`). The sim owns horizontal position.
- **Frame rate / trim:** note the fps and the useful frame range so the
  `subclip(clip, name, start, end, fps)` call is exact (clips often have wind-up
  / long falls to cut, like the catch clips already do).
- **`refSpeed`:** for any new locomotion clip, set `clip.userData.refSpeed` (yd/s
  the gait was authored for) so the foot-skating timeScale sync works.
- **Batching:** group related new clips into one `.glb`; load + merge into the
  `byName` map alongside the current packs.
- **Compression:** run `gltf-transform` before committing; verify load + visual in
  the playwright shooter.

---

## 5. Checklist — adding one new clip

1. Source the motion (Mixamo / AI mocap / pack).
2. Retarget onto the character skeleton in Blender (matching bone names).
3. Strip root motion (in-place; keep vertical if aerial); exaggerate for Blitz.
4. Name it; export to a (batched) `.glb`; compress with `gltf-transform`.
5. In `src/main.js`: add the `byName[...]` lookup + `subclip`/`inPlace(Y)` slice +
   `oneShot`/locomotion wiring; set `refSpeed` if it's a gait.
6. Verify: `node --check`, headless init harness, playwright VISUAL shooter
   (confirm it retargets, plays, and blends per `CLAUDE.md`).
7. Commit + push.

---

## 6. Recommended starter approach

Set up the **Blender + Rokoko/Auto-Rig Pro** retarget recipe once, then:
**Mixamo for the free baseline + DeepMotion or Move.ai (phone-capture yourself)
for the football-specific moves**, reserving a **MoCap Online / ActorCore** pack
purchase for polished QB / route / tackle motion if you want pro quality fast.
That gets specificity, your exact rig, and mobile-sized files — and the clips feed
straight into the animation-system-overhaul blending work.
