import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { PhysicsWorld, TackleRagdoll, pickVariant } from './ragdoll.js';
import { BUILD } from './build.js';
import { AudioManager } from './audio.js';

const audio = new AudioManager();
// Suspend all audio when the tab/app is backgrounded (mobile keeps the music bed
// playing under another app otherwise); resume when it's foregrounded again.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => audio.setHidden(document.hidden));
  window.addEventListener('pagehide', () => audio.setHidden(true));   // iOS Safari app-switch
  window.addEventListener('pageshow', () => audio.setHidden(false));
}

// Build/version badge (corner of screen).
{
  const bb = document.getElementById('build-badge');
  if (bb) bb.textContent = `v${BUILD.version} · ${BUILD.date}`;
}

// ===========================================================================
// Renderer / scene / camera / lights
// ===========================================================================
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Richer, punchier color/contrast (cinematic tone mapping).
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x12203f, 130, 330); // night haze blends distance into the sky

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 7, -12);

// Free debug camera (orbit/zoom/pan) + rewind scrubber — toggled from the debug
// panel or the C key. While on, the sim is frozen so any angle can be inspected /
// screenshotted, and the play can be scrubbed back through the replay buffer.
const dbgCam = { on: false, az: 0.6, el: 0.55, dist: 16, target: new THREE.Vector3(0, 1.2, 0), scrub: -1, shot: false, autoRotate: false, follow: false, step: false };

// --- Sky dome (vertical gradient) + a crowd-filled stadium bowl ---
function gradientCanvas(stops, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); const grd = g.createLinearGradient(0, 0, 0, h);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
let adBoardTex = null;            // scrolling LED advert ring (animated each frame)
const crowdFlashes = [];          // pool of camera-flash sprites in the stands
const stadiumTowerVisuals = [];   // procedural corner-tower meshes (replaced by the GLB towers once loaded)
const towerGlows = [];            // additive bloom halos at the lamp banks (fake bloom + a slow flare twinkle)
const towerSpots = [];            // the 4 corner floodlights (dimmed during the light show for a dark arena)
let _glowTex = null;              // shared glow texture for the lamp bloom halos (lazily built)
let towerTemplate = null, wallTemplate = null, cartTemplate = null, goalpostTemplate = null, stadcornerTemplate = null; // imported stadium props
const procGoalposts = []; // the procedural goalposts (swapped for the GLB once it loads)
// Cage panels + perimeter walls, tagged by side, so the camera can hide whichever
// one it's standing BEHIND (otherwise it stares at the back of a wall, seeing nothing).
const camOccluders = []; // each: mesh with userData {cullSide:'px'|'nx'|'pz'|'nz', cullAt:number}
const cageGates = []; // openable cage gates: { pivot, open } — swing between plays
function makeAdTexture() {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#070b12'; g.fillRect(0, 0, 1024, 64);
  const ads = [['REAPER ENERGY', '#ff4a2a'], ['BLITZ COLA', '#ffd23a'], ['TURF KING', '#3fe08a'], ['NIGHT OWL TIRES', '#5a8bff'], ['GRIDIRON BANK', '#ff8af0'], ['MESHY MOTORS', '#7fe0ff']];
  g.font = 'bold 36px Arial Black, sans-serif'; g.textBaseline = 'middle';
  let x = 10, i = 0;
  while (x < 1024) { const [t, col] = ads[i++ % ads.length]; g.fillStyle = col; g.fillText(t, x, 34); x += g.measureText(t).width + 70; }
  // Negative repeat.x flips U so the text reads correctly on the BackSide ring
  // (seen from inside the cylinder it would otherwise be mirrored).
  const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(-9, 1); tex.offset.x = 1; tex.colorSpace = THREE.SRGBColorSpace; return tex;
}
{
  // Night sky: deep blue overhead fading to a city-glow horizon.
  const skyTex = gradientCanvas([[0, '#04060f'], [0.45, '#0a1430'], [0.8, '#172a52'], [1, '#2c3f66']], 8, 256);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(440, 32, 16),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }));
  scene.add(sky);
  // Stars scattered across the upper dome.
  const N = 700, sp = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random()), r = 420;
    sp[i * 3] = r * Math.sin(ph) * Math.cos(th); sp[i * 3 + 1] = r * Math.cos(ph) + 30; sp[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const starGeo = new THREE.BufferGeometry(); starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.7, sizeAttenuation: true, fog: false, transparent: true, opacity: 0.9 })));
  // Crowd: real rows of diverse people wrapped around the flared bowl wall (a
  // photographed crowd grid, tiled). A noisy speckle texture is the pre-load
  // fallback so the bowl is never bare while the image streams in.
  const cc = document.createElement('canvas'); cc.width = 256; cc.height = 128;
  const cg = cc.getContext('2d'); cg.fillStyle = '#0b1420'; cg.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 3000; i++) { cg.fillStyle = `hsl(${Math.random() * 360},${25 + Math.random() * 45}%,${28 + Math.random() * 48}%)`; cg.fillRect(Math.random() * 256, Math.random() * 128, 2, 2); }
  const crowdTex = new THREE.CanvasTexture(cc); crowdTex.wrapS = crowdTex.wrapT = THREE.RepeatWrapping; crowdTex.repeat.set(26, 3); crowdTex.colorSpace = THREE.SRGBColorSpace;
  const standsMat = new THREE.MeshStandardMaterial({ map: crowdTex, side: THREE.BackSide, roughness: 1 });
  new THREE.TextureLoader().load('assets/crowd.jpg', (tx) => {
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.repeat.set(9, 2); tx.colorSpace = THREE.SRGBColorSpace;
    tx.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    standsMat.map = tx; standsMat.needsUpdate = true;
  });
  const stands = new THREE.Mesh(new THREE.CylinderGeometry(96, 80, 34, 56, 1, true), standsMat);
  stands.position.y = 13; scene.add(stands);
  // Concrete stadium wall under the stands (real brick texture, loaded async).
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a5460, side: THREE.BackSide, roughness: 0.95 });
  new THREE.TextureLoader().load('assets/brick_diffuse.jpg', (tx) => {
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.repeat.set(46, 2); tx.colorSpace = THREE.SRGBColorSpace;
    wallMat.map = tx; wallMat.color.setHex(0x7e8590); wallMat.needsUpdate = true;
  });
  new THREE.TextureLoader().load('assets/brick_bump.jpg', (tx) => { tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.repeat.set(46, 2); wallMat.bumpMap = tx; wallMat.bumpScale = 0.4; wallMat.needsUpdate = true; });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(79, 79, 6, 64, 1, true), wallMat);
  wall.position.y = 3; scene.add(wall);
  // Animated LED advertising ribbon around the TOP of the stands (the field-level
  // spot is now hidden behind the perimeter walls). The stands run r80..96 / y-4..30,
  // so this rides the upper rim where it's clear of the walls and readable.
  const adRing = new THREE.Mesh(new THREE.CylinderGeometry(95, 95, 6, 64, 1, true),
    new THREE.MeshBasicMaterial({ map: makeAdTexture(), side: THREE.BackSide }));
  adRing.position.y = 30; scene.add(adRing); adBoardTex = adRing.material.map;
  // Cut-out fans: real individuals (sliced from a photo, dark bg keyed out) raked
  // up the bowl in front of the crowd texture. Rendered as ONE InstancedMesh per
  // atlas cell (each face pre-oriented toward the field center) — ~88 draw calls
  // for thousands of fans instead of one per sprite, with no per-frame cost.
  {
    const AC = 11, AR = 8, NCELLS = 88;      // atlas grid (88 distinct fans clipped from the sheet)
    new THREE.TextureLoader().load('assets/fans.png', (atlas) => {
      const img = atlas.image, cw = img.width / AC, ch = img.height / AR;
      const ROWS_N = 16, PER_ROW = 190;       // ~3000 fans, packed shoulder-to-shoulder
      const wallR = (y) => 80 + (y + 4) / 34 * 16;
      const byCell = Array.from({ length: NCELLS }, () => []); // placements grouped by fan type
      for (let r = 0; r < ROWS_N; r++) {
        const f = r / (ROWS_N - 1), yb = 1.5 + f * 24;
        for (let k = 0; k < PER_ROW; k++) {
          const a = (k / PER_ROW) * Math.PI * 2 + r * 0.5 * (Math.PI * 2 / PER_ROW) + (Math.random() - 0.5) * 0.018;
          const y = yb + (Math.random() - 0.5) * 0.7;
          const rr = wallR(y) - 4.2 - Math.random() * 1.2;
          const h = 2.5 + Math.random() * 0.7;
          byCell[(Math.random() * NCELLS) | 0].push({ x: Math.cos(a) * rr, y, z: Math.sin(a) * rr, w: h * 0.45, h });
        }
      }
      const baseGeo = new THREE.PlaneGeometry(1, 1);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
      for (let cell = 0; cell < NCELLS; cell++) {
        const list = byCell[cell]; if (!list.length) continue;
        const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(img, (cell % AC) * cw, Math.floor(cell / AC) * ch, cw, ch, 0, 0, cw, ch);
        const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, fog: true });
        const im = new THREE.InstancedMesh(baseGeo, mat, list.length); im.frustumCulled = false;
        list.forEach((pl, i) => {
          q.setFromAxisAngle(UP, Math.atan2(-pl.x, -pl.z)); // face the field center
          pos.set(pl.x, pl.y + pl.h * 0.5, pl.z); scl.set(pl.w, pl.h, 1);
          im.setMatrixAt(i, m.compose(pos, q, scl));
        });
        im.instanceMatrix.needsUpdate = true; scene.add(im);
      }
    });
  }
  // Crowd camera flashes: a pool of additive sprites that pop randomly in the stands.
  const flashTex = makeGlowTexture();
  for (let i = 0; i < 44; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    s.scale.set(1.4, 1.4, 1); s.userData.f = 0; scene.add(s); crowdFlashes.push(s);
  }
  // Four light towers in the corners (glowing lamp banks aimed at the field).
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.6, metalness: 0.4 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0c8, emissiveIntensity: 2.4 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.55, 30, 8), towerMat); pole.position.y = 15; g.add(pole);
    const bank = new THREE.Mesh(new THREE.BoxGeometry(8, 3.2, 0.8), lampMat); bank.position.y = 30; g.add(bank);
    g.position.set(sx * 44, 0, sz * 62);
    bank.rotation.y = Math.atan2(-g.position.x, -g.position.z); // face the field center
    scene.add(g); stadiumTowerVisuals.push(g); // removed if the GLB tower model loads
    // Each tower actually lights the field (constant cone, no falloff).
    const spot = new THREE.SpotLight(0xfff4d6, 1.6, 0, 0.66, 0.55, 0);
    spot.position.set(g.position.x, 31, g.position.z);
    spot.target.position.set(g.position.x * 0.12, 0, g.position.z * 0.12);
    scene.add(spot, spot.target);
    spot.userData.base = spot.intensity; towerSpots.push(spot); // dimmed during the light show
    // Fake bloom: a big soft halo + a tight bright core at the lamp bank. Lives
    // independent of the tower MESH so it survives the GLB swap. driveTowerGlows
    // gives it a slow lens-flare twinkle.
    addTowerGlow(g.position.x, 30, g.position.z);
  }
  // The moon: a soft additive glow high in the sky.
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeGlowTexture(), color: 0xcfe0ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  moon.scale.set(34, 34, 1); moon.position.set(-130, 170, 120); scene.add(moon);
}

// Drop the imported stadium props into the scene once their GLBs have loaded:
// the corner LIGHT TOWERS (replacing the procedural pole+bank visuals, keeping
// the spotlights) and a ring of graffiti WALLS just outside the cage, facing in.
function placeStadiumProps() {
  const boxOf = (o) => { const b = new THREE.Box3().setFromObject(o); return { size: b.getSize(new THREE.Vector3()), min: b.min }; };
  if (towerTemplate) {
    for (const v of stadiumTowerVisuals) scene.remove(v); // swap out the procedural towers
    const f = boxOf(towerTemplate), S = 34 / f.size.y; // ~34yd tall
    for (const [x, z] of [[-44, -62], [-44, 62], [44, -62], [44, 62]]) {
      const t = towerTemplate.clone(true);
      t.scale.setScalar(S);
      t.position.set(x, -f.min.y * S, z);   // base on the ground
      t.rotation.y = Math.atan2(-x, -z);     // aim the lamp bank at the field center
      t.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = true; } });
      scene.add(t);
    }
  }
  if (wallTemplate) { // perimeter graffiti walls (restored)
    const f = boxOf(wallTemplate), S = 9 / f.size.y, wW = f.size.x * S; // ~9yd tall segments
    const place = (x, z, ry) => {
      const w = wallTemplate.clone(true); w.scale.setScalar(S); w.position.set(x, -f.min.y * S, z); w.rotation.y = ry; scene.add(w);
      w.userData.cullSide = Math.abs(x) > Math.abs(z) ? (x > 0 ? 'px' : 'nx') : (z > 0 ? 'pz' : 'nz');
      w.userData.cullAt = Math.abs(x) > Math.abs(z) ? Math.abs(x) : Math.abs(z);
      camOccluders.push(w);
    };
    const nz = Math.ceil((HALF_L * 2) / wW); // sidelines, set back past the bench lane
    for (let i = 0; i < nz; i++) { const z = -HALF_L + wW * (i + 0.5); place(HALF_W + SIDELINE, z, -Math.PI / 2); place(-HALF_W - SIDELINE, z, Math.PI / 2); }
    const nx = Math.ceil((HALF_W * 2) / wW); // end lines
    for (let i = 0; i < nx; i++) { const x = -HALF_W + wW * (i + 0.5); place(x, HALF_L + SIDELINE, Math.PI); place(x, -HALF_L - SIDELINE, 0); }
  }
  // Blitz Cola coolers along each sideline (toward the outer edge of the bench
  // lane, long branded side facing the field).
  if (cartTemplate) {
    // Let the branding self-illuminate a bit so the cooler reads on the dark
    // night sideline (clones share these materials).
    cartTemplate.traverse((o) => { if (o.isMesh && o.material && o.material.map) { o.material.emissiveMap = o.material.map; o.material.emissive = new THREE.Color(0xffffff); o.material.emissiveIntensity = 0.4; o.material.needsUpdate = true; } });
    const f = boxOf(cartTemplate), S = 1.3 / f.size.y;      // ~1.3yd tall (reads from the broadcast cam)
    const lane = HALF_W + SIDELINE * 0.78;                   // outer part of the bench lane
    for (const side of [-1, 1]) for (const z of [-34, -10, 16, 38]) {
      const c = cartTemplate.clone(true); c.scale.setScalar(S);
      c.position.set(side * lane, -f.min.y * S, z);
      c.rotation.y = side < 0 ? -Math.PI / 2 : Math.PI / 2;  // long branded face toward the field
      c.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = true; } });
      scene.add(c);
    }
  }
  // Goalposts: swap the procedural posts for the imported model, scaled to ~11yd
  // tall, standing on each end line and facing the field.
  if (goalpostTemplate) {
    for (const p of procGoalposts) if (p.parent) p.parent.remove(p);
    const f = boxOf(goalpostTemplate), S = 11 / f.size.y;
    for (const z of [HALF_L - 0.6, -(HALF_L - 0.6)]) {
      const g = goalpostTemplate.clone(true);
      g.scale.setScalar(S);
      g.position.set(0, -f.min.y * S, z);
      g.rotation.y = z > 0 ? Math.PI : 0; // face inward toward the field
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = true; } });
      scene.add(g);
    }
  }
}

const hemi = new THREE.HemisphereLight(0x44588f, 0x0c1208, 0.6); // cool night ambient
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xb9c8ee, 0.85); // moonlight key (soft shadows)
sun.position.set(40, 70, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 250;
const sh = 70;
sun.shadow.camera.left = -sh; sun.shadow.camera.right = sh;
sun.shadow.camera.top = sh; sun.shadow.camera.bottom = -sh;
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
const rim = new THREE.DirectionalLight(0x6f86c0, 0.35); // faint cool rim for shape
rim.position.set(-50, 40, -30);
scene.add(rim);

// ===========================================================================
// Field  (1 unit = 1 yard, long axis = Z; offense attacks +Z)
// ===========================================================================
const FIELD_W = 53.3, HALF_W = FIELD_W / 2;
const FIELD_L = 120, HALF_L = FIELD_L / 2;
const GOAL_Z = HALF_L - 10;          // +50: offense's target goal line
const OWN_GOAL_Z = -(HALF_L - 10);   // -50
const CAGE_X = HALF_W, CAGE_Z = HALF_L; // active-play cage / chain-link fence at the out-of-bounds lines
const SIDELINE = 9; // margin between the cage fence and the outer walls — the team-bench lane

const turfMats = []; // {mat, rx, ry} — get the grass map once it loads
function buildField() {
  const field = new THREE.Group();
  const surroundMat = new THREE.MeshStandardMaterial({ color: 0x3c6e34, roughness: 1 });
  turfMats.push({ mat: surroundMat, rx: 60, ry: 60 });
  const surround = new THREE.Mesh(new THREE.PlaneGeometry(420, 420), surroundMat);
  surround.rotation.x = -Math.PI / 2; surround.position.y = -0.02;
  surround.receiveShadow = true; field.add(surround);
  // Team-bench lanes: a darker apron just outside each sideline (between the cage
  // fence and the outer walls) where the bench players pace and emote.
  const apMat = new THREE.MeshStandardMaterial({ color: 0x24301d, roughness: 1 });
  for (const sx of [-1, 1]) {
    const ap = new THREE.Mesh(new THREE.PlaneGeometry(SIDELINE, FIELD_L + 6), apMat);
    ap.rotation.x = -Math.PI / 2; ap.position.set(sx * (HALF_W + SIDELINE / 2), -0.01, 0);
    ap.receiveShadow = true; field.add(ap);
  }

  const stripes = 12, sl = FIELD_L / stripes;
  for (let i = 0; i < stripes; i++) {
    const sm = new THREE.MeshStandardMaterial({ color: i % 2 ? 0x6f8f55 : 0x7a9a5e, roughness: 1 });
    turfMats.push({ mat: sm, rx: 14, ry: 3 }); // grass detail, mow tint kept as color
    const m = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_W, sl), sm);
    m.rotation.x = -Math.PI / 2; m.position.set(0, 0, -HALF_L + sl * (i + 0.5));
    m.receiveShadow = true; m.userData.proc = true; field.add(m);
  }
  for (const dir of [-1, 1]) {
    const em = new THREE.MeshStandardMaterial({ color: dir < 0 ? 0x3f6fb0 : 0xb04a45, roughness: 1 });
    turfMats.push({ mat: em, rx: 14, ry: 2.5 });
    const ez = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_W, 10), em);
    ez.rotation.x = -Math.PI / 2; ez.position.set(0, 0.01, dir * (HALF_L - 5));
    ez.receiveShadow = true; ez.userData.proc = true; field.add(ez);
  }
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const line = (w, l, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat);
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.02, z); m.userData.proc = true; field.add(m);
  };
  line(0.4, FIELD_L, -HALF_W, 0); line(0.4, FIELD_L, HALF_W, 0);
  line(FIELD_W, 0.4, 0, -HALF_L); line(FIELD_W, 0.4, 0, HALF_L);
  line(FIELD_W, 0.5, 0, -GOAL_Z); line(FIELD_W, 0.5, 0, GOAL_Z);
  for (let y = -GOAL_Z + 5; y < GOAL_Z; y += 5) line(FIELD_W, 0.3, 0, y);
  line(FIELD_W, 0.5, 0, 0);
  for (let y = -GOAL_Z + 1; y < GOAL_Z; y += 1)
    for (const hx of [-6, 6]) line(0.9, 0.18, hx, y);
  // Goalposts stand on the END LINE (back of each end zone), just inside the cage.
  // Procedural by default; swapped for the GLB model in placeStadiumProps.
  const gp1 = goalPost(HALF_L - 0.6), gp2 = goalPost(-(HALF_L - 0.6));
  procGoalposts.push(gp1, gp2); field.add(gp1, gp2);
  return field;
}
function goalPost(z) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xf6c324, metalness: 0.5, roughness: 0.4 });
  const tube = (len, x, y, rz) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, len, 12), mat);
    m.castShadow = true; m.position.set(x, y, 0); if (rz) m.rotation.z = rz; return m;
  };
  const CROSS_Y = 3.33;   // crossbar at ~10 ft
  const UP_H = 9;         // tall uprights
  const HALF = 3.08;      // ~18.5 ft apart
  g.add(
    tube(CROSS_Y, 0, CROSS_Y / 2),                         // base pole
    tube(HALF * 2 + 0.2, 0, CROSS_Y, Math.PI / 2),         // crossbar
    tube(UP_H, -HALF, CROSS_Y + UP_H / 2),                 // left upright
    tube(UP_H, HALF, CROSS_Y + UP_H / 2),                  // right upright
  );
  g.position.z = z; return g;
}
const fieldGroup = buildField();
scene.add(fieldGroup);
// Real turf: one grass image, tiled per surface (mow stripes + end-zone colors
// stay as the material tint, multiplied over the grass detail).
new THREE.TextureLoader().load('assets/grass.jpg', (tex) => {
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  for (const { mat, rx, ry } of turfMats) {
    const tt = tex.clone(); tt.needsUpdate = true; tt.wrapS = tt.wrapT = THREE.RepeatWrapping; tt.repeat.set(rx, ry);
    mat.map = tt; mat.needsUpdate = true;
  }
});
// Subtle turf relief (grayscale bump) so the grass catches the floodlights.
new THREE.TextureLoader().load('assets/disturb.jpg', (tex) => {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  for (const { mat, rx, ry } of turfMats) {
    const tt = tex.clone(); tt.needsUpdate = true; tt.wrapS = tt.wrapT = THREE.RepeatWrapping; tt.repeat.set(rx, ry);
    mat.bumpMap = tt; mat.bumpScale = 0.08; mat.needsUpdate = true;
  }
});
// Optional custom field texture: drop a JPEG/PNG at assets/field.png (or .jpg).
// It maps onto one plane the size of the whole field (53.3 x 120 yd, end zones
// included) and replaces the procedural turf + lines. Image is portrait: its
// long (vertical) axis is the field length; top of the image = the -Z (blue)
// end, bottom = the +Z (red) end.
(function loadFieldTexture() {
  const tl = new THREE.TextureLoader();
  const apply = (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const surf = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_W, FIELD_L),
      new THREE.MeshStandardMaterial({ map: tex }));
    surf.rotation.x = -Math.PI / 2; surf.position.y = 0.03; surf.receiveShadow = true;
    fieldGroup.add(surf);
    fieldGroup.traverse((o) => { if (o.userData.proc) o.visible = false; }); // hide procedural markings
  };
  tl.load('assets/field.png', apply, undefined,
    () => tl.load('assets/field.jpg', apply, undefined, () => { /* none found — keep procedural field */ }));
})();

// --- Midfield logo + end-zone wordmarks (canvas decals on the turf) ---
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
{
  // Reapers crest: the real team logo, on the field center and in both end zones.
  const reapersTex = new THREE.TextureLoader().load('assets/reapers.png');
  reapersTex.colorSpace = THREE.SRGBColorSpace; reapersTex.anisotropy = 4;
  const crest = (w, z, rz) => { // logo art is ~1.836:1 (alpha-trimmed crest)
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 1.836), new THREE.MeshBasicMaterial({ map: reapersTex, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.rotation.z = rz; m.position.set(0, 0.05, z); m.userData.proc = true; fieldGroup.add(m); return m;
  };
  crest(24, 0, 0);                          // midfield crest (reads toward the main camera)
  crest(17, HALF_L - 5, Math.PI);           // far end zone (reads toward its goal)
  crest(17, -(HALF_L - 5), 0);              // near end zone
}

// --- Jumbotron: a hanging screen behind the blue end showing live score ---
let jumboCtx = null, jumboTex = null, jumboLast = '';
{
  const c = document.createElement('canvas'); c.width = 512; c.height = 256; jumboCtx = c.getContext('2d');
  jumboTex = new THREE.CanvasTexture(c); jumboTex.colorSpace = THREE.SRGBColorSpace;
  // The screen plane's group is rotated 180° to face the field; that rotation
  // already presents the texture the right way round, so no U-flip is needed.
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x10151c, roughness: 0.7, metalness: 0.3 });
  const jt = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(26, 13, 1.2), frameMat); jt.add(frame);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(24, 11), new THREE.MeshBasicMaterial({ map: jumboTex }));
  screen.position.z = 0.65; jt.add(screen);
  for (const sx of [-1, 1]) { const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 22, 8), frameMat); pole.position.set(sx * 9, -17, 0); jt.add(pole); }
  jt.position.set(0, 20, HALF_L + 6); jt.rotation.y = Math.PI; scene.add(jt); // behind the +Z end, screen faces the field (lowered so it's in shot more)
}

// --- Cage: tall, grungy chain-link boundary the ball bounces off (no OOB) ---
{
  // Hi-res weathered chain-link: rounded twisted-wire diamonds (shadow + steel +
  // highlight passes) with rust + grime, tiling seamlessly (step divides 512).
  const linkTex = canvasTex(512, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.lineCap = 'round';
    const step = 32;
    const diag = (down) => { for (let i = -h; i < w + h; i += step) { g.beginPath(); if (down) { g.moveTo(i, 0); g.lineTo(i + h, h); } else { g.moveTo(i, h); g.lineTo(i + h, 0); } g.stroke(); } };
    g.lineWidth = 7; g.strokeStyle = 'rgba(14,18,23,0.5)'; diag(true); diag(false);   // shadow
    g.lineWidth = 4.5; g.strokeStyle = 'rgba(120,134,150,0.72)'; diag(true); diag(false); // steel body
    g.lineWidth = 1.6; g.strokeStyle = 'rgba(206,216,228,0.85)'; diag(true); diag(false); // highlight
    for (let i = 0; i < 800; i++) { g.fillStyle = `rgba(${120 + Math.random() * 90 | 0},${48 + Math.random() * 45 | 0},${18 + Math.random() * 30 | 0},${0.08 + Math.random() * 0.32})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); } // rust
    for (let i = 0; i < 10; i++) { g.fillStyle = `rgba(8,12,16,${0.05 + Math.random() * 0.12})`; g.fillRect(Math.random() * w, Math.random() * h, 60 + Math.random() * 90, 60 + Math.random() * 90); } // grime
  });
  linkTex.wrapS = linkTex.wrapT = THREE.RepeatWrapping;
  const H = 7.5;
  const railMat = new THREE.MeshStandardMaterial({ color: 0x2b3138, metalness: 0.65, roughness: 0.5 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.7, roughness: 0.35, emissive: 0x20262c, emissiveIntensity: 0.4 });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a4149, metalness: 0.72, roughness: 0.42 });
  const linkPanel = (len, h = H) => {
    const t = linkTex.clone(); t.needsUpdate = true; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(Math.max(1, Math.round(len / 3)), Math.max(1, Math.round(h / 2.5)));
    return new THREE.Mesh(new THREE.PlaneGeometry(len, h), new THREE.MeshBasicMaterial({ map: t, transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.85 }));
  };
  const coilXf = []; // concertina loop transforms, batched into one InstancedMesh
  const _zAx = new THREE.Vector3(0, 0, 1), _runDir = new THREE.Vector3(), _qq = new THREE.Quaternion();
  // A single hinged gate leaf that fills a gap in the run (kept shut).
  function buildGate(cx, cz, ry, leafLen, hh) {
    const root = new THREE.Group(); root.position.set(cx, 0, cz); root.rotation.y = ry; scene.add(root);
    const pivot = new THREE.Group(); pivot.position.set(-leafLen / 2, 0, 0); root.add(pivot); // hinge at the gap edge
    const panel = linkPanel(leafLen, hh); panel.position.set(leafLen / 2, hh / 2, 0); pivot.add(panel);
    const post = (lx) => { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, hh, 8), frameMat); p.position.set(lx, hh / 2, 0); pivot.add(p); };
    post(0); post(leafLen);
    const rail = (ly) => { const r = new THREE.Mesh(new THREE.BoxGeometry(leafLen, 0.18, 0.18), frameMat); r.position.set(leafLen / 2, ly, 0); pivot.add(r); };
    rail(hh - 0.12); rail(0.18);
    cageGates.push({ pivot, open: 0 });
  }
  function buildRun(len, x, z, ry, gateLen, hh = H) {
    const dx = Math.cos(ry), dz = -Math.sin(ry); // along-run unit
    const cs = (px, pz) => { return { side: Math.abs(px) > Math.abs(pz) ? (px > 0 ? 'px' : 'nx') : (pz > 0 ? 'pz' : 'nz'), at: Math.abs(px) > Math.abs(pz) ? Math.abs(px) : Math.abs(pz) }; };
    // chain-link, skipping the centered gate gap
    const segs = gateLen > 0 ? [[-len / 2, -gateLen / 2], [gateLen / 2, len / 2]] : [[-len / 2, len / 2]];
    for (const [a, b] of segs) {
      const sl = b - a; if (sl <= 0.1) continue; const mid = (a + b) / 2;
      const m = linkPanel(sl, hh); m.position.set(x + dx * mid, hh / 2, z + dz * mid); m.rotation.y = ry; scene.add(m);
      const c = cs(x, z); m.userData.cage = true; m.userData.cullSide = c.side; m.userData.cullAt = c.at; camOccluders.push(m);
    }
    // rails + kick plate (continuous over the gate too)
    const top = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, 0.3), trimMat); top.position.set(x, hh, z); top.rotation.y = ry; scene.add(top);
    const bot = new THREE.Mesh(new THREE.BoxGeometry(len, 0.22, 0.22), railMat); bot.position.set(x, 0.15, z); bot.rotation.y = ry; scene.add(bot);
    const kick = new THREE.Mesh(new THREE.BoxGeometry(len, 0.7, 0.12), railMat); kick.position.set(x, 0.45, z); kick.rotation.y = ry; scene.add(kick);
    const n = Math.max(2, Math.round(len / 10));
    for (let i = 0; i <= n; i++) { const along = -len / 2 + (len / n) * i; const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, hh, 8), railMat); post.position.set(x + dx * along, hh / 2, z + dz * along); scene.add(post); }
    // barbed-wire strands just above the top rail
    for (const dy of [0.16, 0.32]) { const s = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.05), railMat); s.position.set(x, hh + dy, z); s.rotation.y = ry; scene.add(s); }
    // concertina (razor) coil loops running the top
    _runDir.set(dx, 0, dz); _qq.setFromUnitVectors(_zAx, _runDir);
    const stepC = 0.6, nl = Math.floor(len / stepC);
    for (let i = 0; i <= nl; i++) { const along = -len / 2 + stepC * i; coilXf.push({ x: x + dx * along, y: hh + 0.72, z: z + dz * along, q: _qq.clone() }); }
    if (gateLen > 0) buildGate(x, z, ry, gateLen, hh); // players/coaches/staff gate
  }
  // Perfect rectangle: sidelines span the full length, end lines the full width,
  // so corners meet cleanly (no overrun). End lines are lower (behind goalposts).
  buildRun(2 * CAGE_Z, CAGE_X, 0, Math.PI / 2, 5);    // +x sideline — players/coaches gate
  buildRun(2 * CAGE_Z, -CAGE_X, 0, Math.PI / 2, 5);   // -x sideline — players/coaches gate
  buildRun(2 * CAGE_X, 0, CAGE_Z, 0, 0, 3.5);         // +z end line (low)
  buildRun(2 * CAGE_X, 0, -CAGE_Z, 0, 5, 3.5);        // -z end line (low) — staff gate
  // Concertina coil: one InstancedMesh for all loops.
  if (coilXf.length) {
    const coilGeo = new THREE.TorusGeometry(0.42, 0.05, 5, 8);
    const coilMat = new THREE.MeshStandardMaterial({ color: 0xc2cad2, metalness: 0.85, roughness: 0.3 });
    const im = new THREE.InstancedMesh(coilGeo, coilMat, coilXf.length); im.frustumCulled = false;
    const m4 = new THREE.Matrix4(), sc = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    coilXf.forEach((c, i) => { p.set(c.x, c.y, c.z); im.setMatrixAt(i, m4.compose(p, c.q, sc)); });
    im.instanceMatrix.needsUpdate = true; scene.add(im);
  }
  // Pylons at the four corners of each end zone.
  const pylMat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff5a00, emissiveIntensity: 0.8 });
  for (const zz of [GOAL_Z, HALF_L, OWN_GOAL_Z, -HALF_L]) for (const xx of [-HALF_W + 0.3, HALF_W - 0.3]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.1, 8), pylMat);
    p.position.set(xx, 0.55, zz); scene.add(p);
  }
}
// Cage gates stay SHUT (closed for play). Kept as a function in case we animate
// them later; for now it just holds them closed.
function updateCageGates() {
  for (const g of cageGates) { g.open = 0; g.pivot.rotation.y = 0; }
}
function drawJumbo(quarter, clock, scoreLine, downLine) {
  if (jumboMode === 'ad') return;            // an ad is on the board — don't overwrite it
  const key = quarter + clock + scoreLine + downLine;
  if (key === jumboLast || !jumboCtx) return; jumboLast = key;
  const g = jumboCtx, w = 512, h = 256;
  g.fillStyle = '#06090f'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#16223a'; g.fillRect(0, 0, w, 44);
  g.fillStyle = '#ffd23a'; g.font = 'bold 26px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('REAPERS  STADIUM', w / 2, 23);
  g.font = 'bold 84px Arial Black, sans-serif'; g.fillStyle = '#fff'; g.fillText(scoreLine, w / 2, 118);
  g.font = 'bold 40px Arial, sans-serif'; g.fillStyle = '#7fe0ff'; g.fillText(`${quarter}   ${clock}`, w / 2, 186);
  g.font = 'bold 26px Arial, sans-serif'; g.fillStyle = '#cfe0ff'; g.fillText(downLine, w / 2, 226);
  jumboTex.needsUpdate = true;
}

// ---- Jumbotron ad rotation: cycle SCOREBOARD -> AD -> SCOREBOARD ----------
// Each ad is a function that paints the 512x256 board. To use a real image ad,
// drop a file in assets/ and add imageAd('assets/whatever.jpg') to JUMBO_ADS.
let jumboMode = 'score', jumboT = 14, jumboAdIdx = -1;
function imageAd(src) {
  const img = new Image(); let ok = false; img.onload = () => { ok = true; }; img.src = src;
  return (g, w, h) => {
    g.fillStyle = '#05070c'; g.fillRect(0, 0, w, h);
    if (!ok) return false; // not loaded yet — try again next cycle
    const r = Math.max(w / img.width, h / img.height); // cover-fit
    const dw = img.width * r, dh = img.height * r;
    g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return true;
  };
}
function adBG(g, w, h, a, b) { const grd = g.createLinearGradient(0, 0, w, h); grd.addColorStop(0, a); grd.addColorStop(0.55, b); grd.addColorStop(1, '#0a0c14'); g.fillStyle = grd; g.fillRect(0, 0, w, h); }
function adBolt(g, x, y, s) { g.fillStyle = '#ffd23a'; g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s * 0.5, y - s); g.lineTo(x + s * 0.1, y); g.lineTo(x + s * 0.6, y); g.lineTo(x - s * 0.4, y + s * 1.2); g.lineTo(x - s * 0.05, y + s * 0.2); g.lineTo(x - s * 0.55, y + s * 0.2); g.closePath(); g.fill(); }
function drawAdBlitz(g, w, h) {
  adBG(g, w, h, '#7a0f1a', '#3a0a12');
  g.strokeStyle = 'rgba(90,160,255,0.45)'; g.lineWidth = 7;
  for (let i = -1; i < 5; i++) { g.beginPath(); g.moveTo(i * 120, h); g.lineTo(i * 120 + 90, 0); g.stroke(); }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  adBolt(g, 56, 90, 30); adBolt(g, w - 56, 90, 30);
  g.font = 'italic 900 86px Arial Black, sans-serif'; g.lineWidth = 9; g.strokeStyle = '#0a0e1a';
  g.strokeText('BLITZ', w / 2, 96); g.fillStyle = '#ff3a4a'; g.fillText('BLITZ', w / 2, 96);
  g.font = 'italic 900 52px Arial Black, sans-serif'; g.strokeText('COLA', w / 2, 160); g.fillStyle = '#dfe7ff'; g.fillText('COLA', w / 2, 160);
  g.font = 'bold 28px Arial, sans-serif'; g.fillStyle = '#ffd23a'; g.fillText('HARDCORE FUEL', w / 2, 214);
}
function drawAdReaper(g, w, h) {
  adBG(g, w, h, '#2a0808', '#120a0a');
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'italic 900 70px Arial Black, sans-serif'; g.lineWidth = 8; g.strokeStyle = '#000';
  g.strokeText('REAPER', w / 2, 100); g.fillStyle = '#ff4a2a'; g.fillText('REAPER', w / 2, 100);
  g.font = 'italic 900 66px Arial Black, sans-serif'; g.strokeText('ENERGY', w / 2, 168); g.fillStyle = '#ffffff'; g.fillText('ENERGY', w / 2, 168);
  g.font = 'bold 24px Arial, sans-serif'; g.fillStyle = '#ff8a6a'; g.fillText('FEAR NOTHING.', w / 2, 220);
}
function drawAdTurf(g, w, h) {
  adBG(g, w, h, '#0d3a22', '#0a1a12');
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'italic 900 88px Arial Black, sans-serif'; g.lineWidth = 8; g.strokeStyle = '#04140c';
  g.strokeText('TURF KING', w / 2, 110); g.fillStyle = '#3fe08a'; g.fillText('TURF KING', w / 2, 110);
  g.font = 'bold 30px Arial, sans-serif'; g.fillStyle = '#dfffe9'; g.fillText('THE PROS PLAY ON', w / 2, 184);
  g.font = 'bold 24px Arial, sans-serif'; g.fillStyle = '#bff0d2'; g.fillText('REAPERS  STADIUM  TURF', w / 2, 222);
}
// Reapers crest board: the real team logo, contain-fit on a branded gradient.
// Preloaded (guarded so the headless init harness, which has no Image, stays safe);
// when it finishes loading we repaint the board if the crest is the live ad, so the
// first time it cycles in isn't a blank gradient.
let reapersLogoImg = null, reapersLogoOk = false;
if (typeof Image !== 'undefined') {
  reapersLogoImg = new Image();
  reapersLogoImg.onload = () => {
    reapersLogoOk = true;
    if (jumboMode === 'ad' && JUMBO_ADS[jumboAdIdx] === drawAdReapersLogo) { drawAdReapersLogo(jumboCtx, 512, 256); jumboTex.needsUpdate = true; }
  };
  reapersLogoImg.src = 'assets/reapers.png';
}
function drawAdReapersLogo(g, w, h) {
  adBG(g, w, h, '#3a0a12', '#0c0506');
  if (reapersLogoOk) {
    const r = Math.min((w * 0.9) / reapersLogoImg.width, (h * 0.86) / reapersLogoImg.height);
    const dw = reapersLogoImg.width * r, dh = reapersLogoImg.height * r;
    g.drawImage(reapersLogoImg, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  return true;
}
// Real photo ads drop in here once their files exist, e.g. imageAd('assets/ad_blitzcola.jpg').
const JUMBO_ADS = [drawAdReapersLogo, drawAdBlitz, drawAdReaper, drawAdTurf];
function tickJumbo(dt) {
  if (!jumboCtx) return;
  jumboT -= dt;
  if (jumboT > 0) return;
  if (jumboMode === 'score') {                 // flip to the next ad
    jumboMode = 'ad'; jumboT = 6;
    jumboAdIdx = (jumboAdIdx + 1) % JUMBO_ADS.length;
    JUMBO_ADS[jumboAdIdx](jumboCtx, 512, 256); jumboTex.needsUpdate = true;
  } else {                                      // back to the scoreboard
    jumboMode = 'score'; jumboT = 12; jumboLast = ''; updateHUD();
  }
}

function makeRing(color) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.95, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.03; m.visible = false;
  scene.add(m); return m;
}
// Blitz-style selection reticle: concentric pulsing blue rings + a center marker
// on the turf under the controlled player. (A Group, so .visible/.position still
// work like the old single ring.) Pulse is driven in updateReticles().
function makeBlueReticle() {
  const g = new THREE.Group();
  g.rotation.x = -Math.PI / 2; g.position.y = 0.035; g.visible = false;
  const rings = [];
  for (const [ri, ro] of [[0.5, 0.64], [0.8, 0.92]]) {
    const m = new THREE.Mesh(new THREE.RingGeometry(ri, ro, 44),
      new THREE.MeshBasicMaterial({ color: 0x49b6ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    g.add(m); rings.push(m);
  }
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.14, 16),
    new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
  g.add(dot);
  g.userData.rings = rings;
  scene.add(g); return g;
}
const selRing = makeRing(0xffd54a);
const ctrlRing = makeBlueReticle();
// Landing indicator: a target reticle on the turf where a thrown/loose ball
// will come down, so you can anticipate the play.
const landRing = (() => {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.65, 32),
    new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; g.add(ring);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.35, 20),
    new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
  dot.rotation.x = -Math.PI / 2; g.add(dot);
  g.position.y = 0.06; g.visible = false; scene.add(g); return g;
})();

// Red feathered "flame" swirl under the ball carrier (the Blitz carrier marker).
const carrierSwirl = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); const cx = 64, cy = 64;
  // Jagged double-ring of red/orange spokes, feathered toward the rim.
  for (let pass = 0; pass < 2; pass++) {
    const spokes = 30, rIn = 30 + pass * 6, rOut = 58 - pass * 4;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2 + pass * 0.1;
      const wob = 0.06 * Math.sin(i * 1.7);
      const x0 = cx + Math.cos(a) * rIn, y0 = cy + Math.sin(a) * rIn;
      const x1 = cx + Math.cos(a + wob) * rOut, y1 = cy + Math.sin(a + wob) * rOut;
      const grd = g.createLinearGradient(x0, y0, x1, y1);
      grd.addColorStop(0, 'rgba(255,180,40,0.9)'); grd.addColorStop(1, 'rgba(220,30,20,0)');
      g.strokeStyle = grd; g.lineWidth = 3.2; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.05; m.visible = false; scene.add(m); return m;
})();

// Turbo as a segmented radial gauge on the turf around the controlled player
// (blue -> yellow -> red), instead of only the corner bar. Redrawn when the
// fill quantum changes; positioned/shown in updateReticles().
const turboArc = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 2.9),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.04; m.visible = false; scene.add(m);
  m.userData.canvas = c; m.userData.tex = tex; m.userData.key = '';
  return m;
})();
const TURBO_SEGS = 22;
function drawTurboArc(frac, locked, fire) {
  const key = `${Math.round(frac * TURBO_SEGS)}|${locked ? 1 : 0}|${fire ? 1 : 0}`;
  if (key === turboArc.userData.key) return; turboArc.userData.key = key;
  const g = turboArc.userData.canvas.getContext('2d'); g.clearRect(0, 0, 128, 128);
  const cx = 64, cy = 64, rO = 60, rI = 49, gap = 0.10;
  for (let i = 0; i < TURBO_SEGS; i++) {
    const t = i / TURBO_SEGS, lit = t < frac;
    const a0 = -Math.PI / 2 + t * Math.PI * 2 + gap;
    const a1 = -Math.PI / 2 + (i + 1) / TURBO_SEGS * Math.PI * 2 - gap;
    let col;
    if (!lit) col = 'rgba(255,255,255,0.10)';
    else if (fire) col = '#ff7a1e';
    else if (locked) col = 'rgba(255,90,70,0.55)';
    else col = `hsl(${Math.round(205 - t * 205)}, 90%, 55%)`; // 205=blue -> 0=red
    g.beginPath(); g.arc(cx, cy, rO, a0, a1); g.arc(cx, cy, rI, a1, a0, true); g.closePath();
    g.fillStyle = col; g.fill();
  }
  turboArc.userData.tex.needsUpdate = true;
}

// Floating surname tag that hangs under each player (Blitz on-field labels). A
// billboard sprite child of the group, so it follows + always faces the camera;
// brightness/tint is set per-frame in updateNameTags().
function makeNameTag(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '700 34px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 7; g.strokeStyle = 'rgba(0,0,0,0.9)'; g.strokeText(text, 128, 36);
  g.fillStyle = '#ffffff'; g.fillText(text, 128, 36);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, opacity: 0 }));
  s.scale.set(2.6, 0.65, 1); s.center.set(0.5, 1.15); s.renderOrder = 7; s.position.set(0, 0.12, 0);
  return s;
}
const SURNAMES = ['HICKS', 'WATT', 'ALLAR', 'METCALF', 'BATTAGLIA', 'ROSS', 'HUNTER', 'REED',
  'CARTER', 'VANCE', 'DOBBS', 'MOSS', 'SHARP', 'BOONE', 'KANE', 'PIERCE', 'GREER', 'STORM',
  'COLE', 'RHODES', 'FOX', 'WADE', 'TATE', 'NIX', 'BELL', 'LANE', 'KRUG', 'DRAKE'];
// Is the ball live enough to show on-field selection chrome?
function reticleLive() {
  const s = game.state;
  return s === STATE.LIVE || s === STATE.AIR || s === STATE.RUN || s === STATE.RETURN ||
    s === STATE.TACKLE || s === STATE.BATTLE || s === STATE.LOOSE;
}
// Hide every on-field selection element + name tags (used when entering REPLAY,
// where the per-frame reticle update doesn't run).
function hideFieldChrome() {
  ctrlRing.visible = false; selRing.visible = false;
  carrierSwirl.visible = false; turboArc.visible = false;
  for (const ch of game.all) if (ch.nameTag) ch.nameTag.visible = false;
}
// Single per-frame authority for ALL on-field selection chrome: every ring's
// visibility + position is DERIVED from the current game state here, every frame,
// so nothing can ever strand on the turf (the scattered .visible toggles no longer
// matter — this overrides them). Not called during REPLAY (see hideFieldChrome).
function updateReticles() {
  const t = performance.now() * 0.001;
  const live = reticleLive();
  const ctl = game.controlled, c = game.carrier;
  // Gold ring on the targeted receiver: offense, pre-throw, on a real receiver.
  const rcv = game.receivers ? game.receivers[game.selected] : null;
  const selOn = game.userOnOffense && (game.state === STATE.PRESNAP || game.state === STATE.LIVE) && rcv && rcv.group && !rcv.ragdolling;
  selRing.visible = !!selOn;
  if (selOn) { selRing.position.set(rcv.group.position.x, 0.03, rcv.group.position.z); selRing.scale.set(1, 1, 1); } // (the user-catch cue pulses it; keep the pre-throw ring normal)
  // Blue concentric reticle on the controlled player (live play, or pre-snap D).
  const ctlOn = ctl && ctl.group && !ctl.ragdolling && (live || (game.state === STATE.PRESNAP && !game.userOnOffense));
  ctrlRing.visible = !!ctlOn;
  if (ctlOn) {
    const p = ctl.group.position; ctrlRing.position.set(p.x, 0.035, p.z);
    const rings = ctrlRing.userData.rings;
    for (let i = 0; i < rings.length; i++) {
      const ph = (t * 1.5 - i * 0.5) % 1; rings[i].material.opacity = 0.35 + 0.5 * (1 - (ph < 0 ? ph + 1 : ph));
    }
  }
  // Red feathered swirl on the ball carrier during live play.
  const swirlOn = c && c.group && !c.ragdolling && live;
  carrierSwirl.visible = !!swirlOn;
  if (swirlOn) {
    const p = c.group.position; carrierSwirl.position.set(p.x, 0.05, p.z);
    carrierSwirl.material.rotation = t * 0.7;
    const pul = 1 + Math.sin(t * 6) * 0.04; carrierSwirl.scale.set(pul, pul, 1);
  }
  // Turbo gauge ring under the controlled player during live play.
  const arcOn = ctl && ctl.group && !ctl.ragdolling && live;
  turboArc.visible = !!arcOn;
  if (arcOn) {
    const p = ctl.group.position; turboArc.position.set(p.x, 0.04, p.z);
    drawTurboArc(game.onFire ? 1 : game.turboMeter, game.turboLock, game.onFire);
  }
}
function updateNameTags() {
  if (!(reticleLive() || game.state === STATE.PRESNAP)) {
    for (const ch of game.all) if (ch.nameTag) ch.nameTag.visible = false; return;
  }
  const ctl = game.controlled;
  const myTeam = ctl && game.teamB.includes(ctl) ? game.teamB : game.teamA; // show your squad + the carrier
  for (const ch of game.all) {
    const tag = ch.nameTag; if (!tag) continue;
    const hot = ch === ctl || ch === game.carrier;
    const vis = !ch.ragdolling && (myTeam.includes(ch) || hot);
    tag.visible = vis; if (!vis) continue;
    tag.material.opacity = hot ? 1 : 0.3;
    tag.material.color.setHex(ch === game.carrier ? 0xff7a5a : (ch === ctl ? 0x8fdcff : 0xffffff));
  }
}


function makeFieldLine(color) {
  const g = new THREE.Group();
  const stripe = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_W, 0.8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 }));
  stripe.rotation.x = -Math.PI / 2; stripe.position.y = 0.05; g.add(stripe);
  const postMat = new THREE.MeshBasicMaterial({ color });
  for (const sx of [-HALF_W, HALF_W]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.8, 0.4), postMat);
    post.position.set(sx, 0.9, 0); g.add(post);
  }
  scene.add(g); return g;
}
const losLine = makeFieldLine(0xff3a30);
const firstDownLine = makeFieldLine(0xffe14a);

// ---- Coach-cam play art: the called play drawn flat on the turf during pre-snap
// (toggled by the PLAY ART button) so you can read it before the snap. OFFENSE =
// route ribbons (WR yellow, RB green, QB blue); DEFENSE = each man's assignment
// (rush red, man-cover blue, zone green, QB-spy yellow). Big, bright (toneMapped
// off so the colors pop), bold (a dark outline backing under each line). --------
const coachArt = new THREE.Group(); coachArt.visible = false; scene.add(coachArt);
const COACH_Y = 0.09; // sit just above the turf
function clearCoachArt() {
  for (const c of coachArt.children) { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }
  coachArt.clear();
}
function coachMat(color, opacity) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
}
// A flat ribbon lying on the turf along an XZ polyline (pts: {x,z}). width in yards.
function makeRibbon(pts, color, width, opacity, y) {
  const half = width * 0.5, n = pts.length, pos = [], idx = [];
  for (let i = 0; i < n; i++) {
    let dx = 0, dz = 0;
    if (i > 0) { dx += pts[i].x - pts[i - 1].x; dz += pts[i].z - pts[i - 1].z; }
    if (i < n - 1) { dx += pts[i + 1].x - pts[i].x; dz += pts[i + 1].z - pts[i].z; }
    const l = Math.hypot(dx, dz) || 1, px = -dz / l * half, pz = dx / l * half;
    pos.push(pts[i].x + px, y, pts[i].z + pz, pts[i].x - px, y, pts[i].z - pz);
    if (i < n - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  return new THREE.Mesh(g, coachMat(color, opacity));
}
// A bold route line: a dark outline backing with the bright color on top.
function addLine(pts, color, width) {
  coachArt.add(makeRibbon(pts, 0x05080a, width + 0.22, 0.6, COACH_Y));          // outline (bolder)
  coachArt.add(makeRibbon(pts, color, width, 0.98, COACH_Y + 0.01));            // bright fill
}
// A flat arrowhead on the turf at tip, pointing along dir {x,z}.
function makeArrow(tip, dir, color, size, opacity, y) {
  const l = Math.hypot(dir.x, dir.z) || 1, fx = dir.x / l, fz = dir.z / l, px = -fz, pz = fx;
  const bx = tip.x - fx * size, bz = tip.z - fz * size;
  const pos = [tip.x, y, tip.z, bx + px * size * 0.62, y, bz + pz * size * 0.62, bx - px * size * 0.62, y, bz - pz * size * 0.62];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex([0, 1, 2]);
  return new THREE.Mesh(g, coachMat(color, opacity));
}
function addArrow(tip, dir, color, size) {
  coachArt.add(makeArrow(tip, dir, 0x05080a, size + 0.3, 0.6, COACH_Y + 0.011)); // outline
  coachArt.add(makeArrow(tip, dir, color, size, 0.98, COACH_Y + 0.021));         // bright
}
// A disc marker flat on the turf (route start / player spot), with a dark rim.
function addDot(x, z, color, r) {
  const rim = new THREE.Mesh(new THREE.CircleGeometry(r + 0.12, 20), coachMat(0x05080a, 0.6));
  rim.rotation.x = -Math.PI / 2; rim.position.set(x, COACH_Y, z); coachArt.add(rim);
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 20), coachMat(color, 0.98));
  m.rotation.x = -Math.PI / 2; m.position.set(x, COACH_Y + 0.012, z); coachArt.add(m);
}
// A zone-coverage ring (an annulus) flat on the turf to mark the area a man drops to.
function addRing(x, z, r, color) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r - 0.28, r, 28), coachMat(color, 0.85));
  m.rotation.x = -Math.PI / 2; m.position.set(x, COACH_Y + 0.005, z); coachArt.add(m);
}
function buildOffenseArt() {
  if (!game.receivers) return;
  const play = PLAYS[game.playIndex] || PLAYS[0];
  game.receivers.forEach((r, e) => {
    const sp = r.group.position;
    const wpts = play.route(e, r.align.x, game.los);
    const pts = [{ x: sp.x, z: sp.z }, ...wpts.map((w) => ({ x: w.x, z: w.z }))];
    const col = r.role === 'RB' ? 0x6cff8a : 0xffe04a;
    addLine(pts, col, 0.7);
    const a = pts[pts.length - 1], b = pts[pts.length - 2] || a;
    addArrow(a, { x: a.x - b.x, z: a.z - b.z }, col, 1.6);
    addDot(sp.x, sp.z, 0xffffff, 0.55);
  });
  if (game.qb) { const q = game.qb.group.position; addDot(q.x, q.z, 0x8fd0ff, 0.62); }
}
// Work out each defender's pre-snap assignment from the called coverage (mirrors
// applyDefCall + the snap's base jobs) so the art matches what they'll do.
function defenseArtPlan() {
  const plan = [], call = game.defCall, d = game.dir, L = game.los;
  const qp = game.qb ? game.qb.group.position : { x: 0, z: L };
  let ci = 0; const thirds = [-15, 15, 0];
  for (const p of game.defense) {
    if (p.ragdolling) continue;
    const dp = p.group.position;
    const isRush = p.role === 'DL' || (call === 2 && p.role === 'LB');
    const isSpy = call === 3 && p.role === 'LB';
    let type, x, z;
    if (isRush) { type = 'rush'; x = qp.x; z = qp.z; }
    else if (isSpy) { type = 'spy'; x = qp.x; z = qp.z; }
    else if (call === 1 && p.role === 'CB') { type = 'zone'; x = thirds[ci++] ?? 0; z = L + d * 16; }
    else if (call === 1 && p.role === 'LB') { type = 'zone'; x = 0; z = L + d * 8; }
    else if (p.deep) { type = 'zone'; x = 0; z = L + d * 18; }
    else {
      const a = p.covers >= 0 && game.receivers && game.receivers[p.covers] ? game.receivers[p.covers].group.position : null;
      if (a) { type = 'cover'; x = a.x; z = a.z; } else { type = 'zone'; x = dp.x; z = L + d * 10; }
    }
    plan.push({ p, type, x, z });
  }
  return plan;
}
function buildDefenseArt() {
  if (!game.defense) return;
  const COL = { rush: 0xff5a3a, cover: 0x6aa0ff, zone: 0x3fe08a, spy: 0xffd23a };
  for (const it of defenseArtPlan()) {
    const sp = it.p.group.position, col = COL[it.type] || 0x6aa0ff;
    addLine([{ x: sp.x, z: sp.z }, { x: it.x, z: it.z }], col, 0.7);
    addArrow({ x: it.x, z: it.z }, { x: it.x - sp.x, z: it.z - sp.z }, col, 1.6);
    if (it.type === 'zone') addRing(it.x, it.z, 3.4, col);
    addDot(sp.x, sp.z, col, 0.55);
  }
}
function buildCoachArt() { if (game.userOnOffense) buildOffenseArt(); else buildDefenseArt(); }
let coachSig = '';
function updateCoachArt() {
  const showIt = game.coachCam && game.state === STATE.PRESNAP && !game.choosing && !game.gameOver;
  if (!showIt) { if (coachArt.visible || coachArt.children.length) { clearCoachArt(); coachArt.visible = false; coachSig = ''; } return; }
  const sig = `${game.userOnOffense ? 'O' + game.playIndex : 'D' + game.defCall}|${game.los.toFixed(1)}|${game.dir}`;
  if (sig !== coachSig || !coachArt.children.length) { clearCoachArt(); buildCoachArt(); coachSig = sig; }
  coachArt.visible = true;
}

// Floating target arrow that hovers over the selected receiver.
const targetArrow = (() => {
  const m = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.8, 4),
    new THREE.MeshBasicMaterial({ color: 0xffe14a }));
  m.rotation.x = Math.PI; m.visible = false; scene.add(m); return m;
})();

// Impact particle burst pool (dust/spark on hits).
const hitParticles = [];
(function initParticles() {
  const geo = new THREE.SphereGeometry(0.12, 6, 5);
  for (let i = 0; i < 70; i++) {
    const p = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
    p.visible = false; p.userData = { vx: 0, vy: 0, vz: 0, life: 0 }; scene.add(p); hitParticles.push(p);
  }
})();
function burst(x, y, z, color, n = 14, speed = 7) {
  let spawned = 0;
  for (const p of hitParticles) {
    if (p.userData.life > 0) continue;
    p.visible = true; p.position.set(x, y, z);
    p.material.color.setHex(color); p.material.opacity = 0.9;
    const a = Math.random() * Math.PI * 2, up = 1 + Math.random() * 4;
    const s = speed * (0.4 + Math.random());
    p.userData.vx = Math.cos(a) * s; p.userData.vz = Math.sin(a) * s; p.userData.vy = up;
    p.userData.life = 0.5 + Math.random() * 0.3;
    if (++spawned >= n) break;
  }
}
// Over-the-top gore: a red geyser of droplets from the neck when the lid pops
// off on a violent hit (Blitz: The League style). Strong upward gush + spread.
const BLOOD_COLS = [0x8e0712, 0x6a040d, 0xa50f1a]; // darker, deeper crimson droplets
function bloodSpray(x, y, z, n = 40) {
  let spawned = 0;
  for (const p of hitParticles) {
    if (p.userData.life > 0) continue;
    p.visible = true;
    p.position.set(x + (Math.random() - 0.5) * 0.16, y, z + (Math.random() - 0.5) * 0.16);
    p.material.color.setHex(BLOOD_COLS[(Math.random() * BLOOD_COLS.length) | 0]);
    p.material.opacity = 0.95;
    const a = Math.random() * Math.PI * 2, spread = 1.0 + Math.random() * 3.2; // wider gush
    p.userData.vx = Math.cos(a) * spread;
    p.userData.vz = Math.sin(a) * spread;
    p.userData.vy = 5 + Math.random() * 7; // gush up out of the neck
    p.userData.life = 0.5 + Math.random() * 0.6;
    if (++spawned >= n) break;
  }
  // Leave lasting stains on the turf where the blood lands (cleared each quarter):
  // a main pool + several scattered splatters of varied shape/size. Skipped during
  // a replay re-enactment so loops don't pile up duplicate stains (the live ones
  // from the play are already on the field).
  if (game.state === STATE.REPLAY) return;
  addBloodStain(x, z);
  const splats = 3 + (Math.random() * 3 | 0); // 3..5 extra
  for (let i = 0; i < splats; i++) {
    const r = 2 + Math.random() * 8;          // out to ~10yd
    addBloodStain(x + (Math.random() - 0.5) * r * 2, z + (Math.random() - 0.5) * r * 2);
  }
  addFenceBlood(x, y, z); // splatter the nearest fence too (if close enough)
}
// Persistent blood stains on the grass — flat splat decals that accumulate and
// stay until the quarter ends (clearBloodStains in advanceQuarter).
function makeBloodTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); g.clearRect(0, 0, 128, 128);
  const cx = 64, cy = 64;
  // Central pool: each lobe is radially SHADED (rich dark core -> deep red ->
  // soft dark rim) so the splat reads with depth instead of a flat blob.
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 20, R = 13 + Math.random() * 16;
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    const grd = g.createRadialGradient(px, py, 1, px, py, R);
    grd.addColorStop(0, `rgba(${72 + Math.random() * 28 | 0},${4 + Math.random() * 7 | 0},${6 + Math.random() * 7 | 0},0.96)`);
    grd.addColorStop(0.7, `rgba(${46 + Math.random() * 22 | 0},${2 + Math.random() * 5 | 0},${4 + Math.random() * 5 | 0},0.86)`);
    grd.addColorStop(1, 'rgba(24,0,2,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(px, py, R, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 26; i++) { // scattered droplets/splatter (darker)
    const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 38;
    g.fillStyle = `rgba(${56 + Math.random() * 40 | 0},${3 + Math.random() * 8 | 0},${5 + Math.random() * 8 | 0},${0.5 + Math.random() * 0.4})`;
    g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.2 + Math.random() * 5.5, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const bloodStains = [];
const bloodTextures = [];       // several distinct splat shapes for variety
let bloodStainI = 0;
(function initBloodStains() {
  for (let i = 0; i < 6; i++) bloodTextures.push(makeBloodTexture()); // 6 unique splats
  for (let i = 0; i < 64; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: bloodTextures[0], transparent: true, depthWrite: false, opacity: 0 }));
    m.position.y = 0.04; m.visible = false; m.renderOrder = 1; scene.add(m); bloodStains.push(m);
  }
})();
function addBloodStain(x, z) {
  const m = bloodStains[bloodStainI++ % bloodStains.length];
  m.material.map = bloodTextures[(Math.random() * bloodTextures.length) | 0]; m.material.needsUpdate = true; // varied splat
  m.position.set(THREE.MathUtils.clamp(x, -HALF_W + 1, HALF_W - 1), 0.04, THREE.MathUtils.clamp(z, -HALF_L + 1, HALF_L - 1));
  m.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2); // lay flat, random spin
  const s = 1.3 + Math.random() * 3.0; m.scale.set(s, s, 1);    // wider size variety
  m.material.opacity = 0.75 + Math.random() * 0.2; m.visible = true;
}
// --- Blood on the chain-link FENCE: vertical splats that run a little down the
// wire (a slight settle/slide) and stay until the quarter clears. ---
function makeDripTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const g = c.getContext('2d'); g.clearRect(0, 0, 64, 128);
  // Top splat blob (shaded).
  const grd = g.createRadialGradient(32, 30, 1, 32, 30, 26);
  grd.addColorStop(0, 'rgba(78,5,8,0.95)'); grd.addColorStop(0.65, 'rgba(50,3,5,0.85)'); grd.addColorStop(1, 'rgba(24,0,2,0)');
  g.fillStyle = grd; g.beginPath(); g.arc(32, 30, 26, 0, Math.PI * 2); g.fill();
  // A few runs dripping straight down, each tapering + a bead at the tip.
  for (let i = 0; i < 4; i++) {
    const x = 18 + Math.random() * 28, w = 2 + Math.random() * 4, len = 34 + Math.random() * 70;
    const lg = g.createLinearGradient(0, 26, 0, 26 + len);
    lg.addColorStop(0, 'rgba(62,4,6,0.85)'); lg.addColorStop(1, 'rgba(38,2,4,0)');
    g.fillStyle = lg; g.fillRect(x - w / 2, 26, w, len);
    g.fillStyle = 'rgba(56,3,6,0.7)'; g.beginPath(); g.arc(x, 26 + len, w * 0.9, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const fenceBlood = [];
const dripTextures = [];
let fenceBloodI = 0;
(function initFenceBlood() {
  for (let i = 0; i < 3; i++) dripTextures.push(makeDripTexture());
  for (let i = 0; i < 48; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: dripTextures[0], transparent: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide }));
    m.visible = false; m.renderOrder = 2; scene.add(m); fenceBlood.push(m);
  }
})();
// Splat blood onto the nearest fence panel (if the spray is near enough to reach
// it), at the spray height, oriented to face the field. Each splat then slides
// down a touch and settles.
function addFenceBlood(x, y, z) {
  const dpx = CAGE_X - x, dnx = x + CAGE_X, dpz = CAGE_Z - z, dnz = z + CAGE_Z;
  const near = Math.min(dpx, dnx, dpz, dnz);
  if (near > 16) return; // too far from any fence to splatter it
  let wx, wz, ry, axis; // axis = which way the splat spreads ALONG the wall
  if (near === dpx) { wx = CAGE_X - 0.06; wz = z; ry = -Math.PI / 2; axis = 'z'; }
  else if (near === dnx) { wx = -CAGE_X + 0.06; wz = z; ry = Math.PI / 2; axis = 'z'; }
  else if (near === dpz) { wx = x; wz = CAGE_Z - 0.06; ry = Math.PI; axis = 'x'; }
  else { wx = x; wz = -CAGE_Z + 0.06; ry = 0; axis = 'x'; }
  const n = 2 + (Math.random() * 3 | 0);
  for (let i = 0; i < n; i++) {
    const m = fenceBlood[fenceBloodI++ % fenceBlood.length];
    m.material.map = dripTextures[(Math.random() * dripTextures.length) | 0]; m.material.needsUpdate = true;
    const along = (Math.random() - 0.5) * 6;
    const hy = THREE.MathUtils.clamp(y + (Math.random() - 0.25) * 2.6, 0.7, 6.5);
    if (axis === 'z') m.position.set(wx, hy, THREE.MathUtils.clamp(wz + along, -CAGE_Z + 1, CAGE_Z - 1));
    else m.position.set(THREE.MathUtils.clamp(wx + along, -CAGE_X + 1, CAGE_X - 1), hy, wz);
    m.rotation.set(0, ry, 0);
    const w = 0.8 + Math.random() * 1.4; m.scale.set(w, w * (1.5 + Math.random() * 0.8), 1);
    m.material.opacity = 0.7 + Math.random() * 0.25; m.visible = true;
    m.userData.vy = 0.5 + Math.random() * 1.0; m.userData.rest = Math.max(0.4, hy - (0.5 + Math.random() * 0.8));
  }
}
function updateFenceBlood(dt) {
  for (const m of fenceBlood) {
    const u = m.userData;
    if (!m.visible || !u || !u.vy) continue;
    m.position.y -= u.vy * dt; u.vy *= Math.pow(0.12, dt); // slide down, decelerating into a settle
    if (m.position.y <= u.rest || u.vy < 0.03) { m.position.y = Math.max(u.rest, m.position.y); u.vy = 0; }
  }
}
function clearBloodStains() {
  for (const m of bloodStains) { m.visible = false; m.material.opacity = 0; }
  for (const m of fenceBlood) { m.visible = false; m.material.opacity = 0; if (m.userData) m.userData.vy = 0; }
}
// Touchdown confetti: a full-pool, multi-color shower that rains down.
function confetti(z, atX) {
  const x = Number.isFinite(atX) ? atX : (game.carrier ? game.carrier.group.position.x : 0);
  const zc = THREE.MathUtils.clamp(z, -HALF_L + 2, HALF_L - 2);
  const cols = [0xffd23a, 0xff5a5a, 0x5a8bff, 0x5aff8a, 0xff8af0, 0xffffff];
  let i = 0;
  for (const p of hitParticles) {
    p.visible = true;
    p.position.set(x + (Math.random() - 0.5) * 3, 3 + Math.random() * 2.5, zc + (Math.random() - 0.5) * 3);
    p.material.color.setHex(cols[i % cols.length]); p.material.opacity = 0.95;
    const a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 5;
    p.userData.vx = Math.cos(a) * s; p.userData.vz = Math.sin(a) * s; p.userData.vy = 6 + Math.random() * 5;
    p.userData.life = 1.1 + Math.random() * 0.6;
    if (++i >= hitParticles.length) break;
  }
}
function updateParticles(dt) {
  for (const p of hitParticles) {
    if (p.userData.life <= 0) continue;
    p.userData.life -= dt;
    if (p.userData.life <= 0) { p.visible = false; continue; }
    p.userData.vy -= 18 * dt;
    p.position.x += p.userData.vx * dt;
    p.position.y = Math.max(0.1, p.position.y + p.userData.vy * dt);
    p.position.z += p.userData.vz * dt;
    p.material.opacity = Math.min(0.9, p.userData.life * 2);
  }
}

// ---------------------------------------------------------------------------
// Flame effect (ON FIRE / turbo). r160 dropped THREE.Fire, so this is a pooled
// additive billboard-sprite emitter: soft blobs spawn at the target, rise and
// flicker while fading hot->dark, giving a volumetric flame. Tinted orange for
// ON FIRE, blue for turbo. No external texture (drawn to a canvas).
const FLAME_ORANGE = new THREE.Color(0xff6a18), FLAME_BLUE = new THREE.Color(0x3aa6ff);
function flameTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,240,210,0.7)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
class FlameEmitter {
  constructor(count = 36) {
    const tex = flameTexture();
    this.sprites = []; this.parts = []; this.acc = 0;
    for (let i = 0; i < count; i++) {
      const m = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
      const s = new THREE.Sprite(m); s.visible = false; s.renderOrder = 5; scene.add(s);
      this.sprites.push(s); this.parts.push({ life: 0, max: 1, vx: 0, vy: 0, vz: 0, base: 0.5 });
    }
    this.i = 0;
  }
  spawn(x, y, z, color, low) {
    const idx = this.i++ % this.sprites.length, s = this.sprites[idx], p = this.parts[idx];
    p.life = 0;
    if (low) { // turbo: short, ground-hugging jets that kick out from the feet
      s.position.set(x + (Math.random() - 0.5) * 0.7, y + Math.random() * 0.12, z + (Math.random() - 0.5) * 0.7);
      p.max = 0.3 + Math.random() * 0.25;
      p.vx = (Math.random() - 0.5) * 1.1; p.vy = 0.5 + Math.random() * 0.9; p.vz = (Math.random() - 0.5) * 1.1;
      p.base = 0.32 + Math.random() * 0.32;
    } else {  // ON FIRE: a tall flame rising off the body
      s.position.set(x + (Math.random() - 0.5) * 0.5, y + Math.random() * 0.3, z + (Math.random() - 0.5) * 0.5);
      p.max = 0.45 + Math.random() * 0.4;
      p.vx = (Math.random() - 0.5) * 0.7; p.vy = 1.8 + Math.random() * 1.8; p.vz = (Math.random() - 0.5) * 0.7;
      p.base = 0.55 + Math.random() * 0.5;
    }
    s.material.color.copy(color); s.material.opacity = 0.9; s.visible = true;
  }
  // color=null -> stop spawning (existing flames age out so it tapers smoothly).
  update(dt, x, y, z, color, rate = 70, low = false) {
    if (color) { this.acc += rate * dt; while (this.acc >= 1) { this.acc -= 1; this.spawn(x, y, z, color, low); } }
    else this.acc = 0;
    for (let k = 0; k < this.sprites.length; k++) {
      const s = this.sprites[k], p = this.parts[k];
      if (!s.visible) continue;
      p.life += dt; const t = p.life / p.max;
      if (t >= 1) { s.visible = false; s.material.opacity = 0; continue; }
      s.position.x += p.vx * dt; s.position.y += p.vy * dt; s.position.z += p.vz * dt;
      const sc = p.base * (1.1 - t * 0.7); s.scale.set(sc, sc, 1);
      s.material.opacity = (1 - t) * 0.85;
    }
  }
}
let ballFlame, playerFlame;
const _ST_FLAME = ['live', 'air', 'run', 'return', 'loose', 'battle', 'tackle'];
// Who's on fire right now: {player, pCol(1=orange/2=blue), ballCol}. Shared by
// the live emitter AND the replay recorder so the fx replay on the right body.
function computeFlame() {
  const st = game.state;
  const playing = _ST_FLAME.includes(st);
  const c = game.controlled;
  const turboOn = playing && input.turbo && !game.turboLock && (game.onFire || game.turboMeter > 0) && c && !c.ragdolling;
  const hot = game.userOnOffense ? (game.carrier || ball.holder || game.qb) : c; // ball handler / your defender
  const fireOn = (playing || st === STATE.DEAD) && game.onFire; // keep flames through the TD celebration
  let player = null, pCol = 0;
  if (turboOn) { player = c; pCol = 2; }
  else if (fireOn && hot && !hot.ragdolling) { player = hot; pCol = 1; }
  const userHasBall = game.userOnOffense && (ball.mode === 'carried' || ball.mode === 'flying');
  let ballCol = 0;
  if (fireOn && userHasBall) ballCol = 1; // ON FIRE flames the ball; turbo does NOT
  return { player, pCol, ballCol };
}
function emitFlames(dt, player, pCol, ballCol) {
  if (!ballFlame) return;
  // Turbo (blue) is dampened — a lighter wisp than the ON FIRE (orange) blaze.
  if (player) {
    const p = player.group.position;
    if (pCol === 2) playerFlame.update(dt, p.x, p.y + 0.06, p.z, FLAME_BLUE, 52, true); // TURBO: low jets at the feet only
    else playerFlame.update(dt, p.x, p.y + 0.55, p.z, FLAME_ORANGE, 85, false);          // ON FIRE: flame off the whole body
  } else playerFlame.update(dt, 0, 0, 0, null);
  if (ballCol) { const bp = ball.mesh.position; ballFlame.update(dt, bp.x, bp.y, bp.z, ballCol === 2 ? FLAME_BLUE : FLAME_ORANGE, ballCol === 2 ? 32 : 60); }
  else ballFlame.update(dt, 0, 0, 0, null);
}
// Live (non-replay): ON FIRE ball/carrier orange, turbo player blue; tapers off.
function updateFlames(dt) {
  const f = computeFlame();
  emitFlames(dt, f.player, f.pCol, f.ballCol);
}
// During the replay, replay the recorded flame fx on the replayed bodies.
function driveReplayFlames(dt, fi) {
  if (!ballFlame) return;
  const fx = game.replay.fx, e = fx.length ? fx[Math.min(fx.length - 1, Math.max(0, Math.round(fi)))] : null;
  if (!e) { emitFlames(dt, null, 0, 0); return; }
  emitFlames(dt, e.pIdx >= 0 ? game.all[e.pIdx] : null, e.pCol, e.ballCol);
}

// ===========================================================================
// Assets + character factory
// ===========================================================================
const loader = new GLTFLoader();
// KTX2 (Basis) texture support for compressed imported models (e.g. the stadium
// corner). detectSupport needs the renderer; transcoder wasm is vendored.
try {
  const ktx2 = new KTX2Loader().setTranscoderPath('vendor/three/addons/libs/basis/').detectSupport(renderer);
  loader.setKTX2Loader(ktx2);
} catch (e) { console.warn('KTX2 loader unavailable', e); }
// Meshopt-compressed geometry support (EXT_meshopt_compression) — e.g. the
// cheerleader model is exported meshopt-packed, so the decoder must be registered.
try { loader.setMeshoptDecoder(MeshoptDecoder); } catch (e) { console.warn('Meshopt decoder unavailable', e); }
const HEAD_SCALE = 1.6; // Blitz-style oversized heads (applied to both teams)
const HEAD_POP_SCALE = 0.05; // bare-headed models: shrink the real head to a nub when it pops off (non-zero, so ragdoll drive() never divides by zero)
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const loadGLB = (u) => new Promise((res, rej) => loader.load(u, res, undefined, rej));

let charTemplate, defTemplate, helmetOffTemplate, helmetDefTemplate, footballTemplate;
let BASE_HEAD_REST = null; // default rig's Head rest quaternion (clips are authored for it)
// Pull a template's Head bone rest-pose rotation (used to retarget alt-model heads).
function headRestOf(scene) {
  let q = null;
  if (scene) scene.traverse((o) => { if (o.isBone && o.name === 'Head') q = o.quaternion.clone(); });
  return q;
}
// Player-team model registry. Index 0 = the default model; each alt is appended at
// load (skipped if its .glb is missing). Entry: { name, template, helmet|null, scale,
// groundY }. TUNE.altModel indexes it; each alt gets its OWN helmet (or none yet).
const ALT_MODEL_DEFS = [
  { glb: 'assets/character_alt.glb', helmet: 'assets/helmet_alt.glb', name: 'ALT 1' },
  { glb: 'assets/character_alt2.glb', helmet: 'assets/helmet_alt2.glb', name: 'ALT 2' },
];
const PLAYER_MODELS = [];
let idleClip, walkClip, runClip, sprintClip, jukeClip, catchClip, tackleClip;
let backLClip, backRClip; // backpedal locomotion (left/right drift)
// Variety + new-move clips from the merged Meshy packs (animations2/3.glb).
let idleClips = [], walkClips = [], celebClips = [], getUpClips = [];
let danceClips = [], sulkClips = []; // end-of-game finale: winners dance, losers fume
// Pregame cinematic: a dedicated cheerleader model (its OWN rig + bundled clips).
let cheerTemplate = null, cheerClips = null, cheerScale = 1, cheerGroundY = 0;
let diveCatchClip, scoopClip, vaultClip, cageVaultClip;
let vaultClips = []; // hurdle pool (per-player variety, animations2/5.glb)
let blockClips = []; // engaged-PUSH pool (push-clip slices, animations4.glb): blocking + break-tackle
let jabClip, kickClip, blownBackClip; // post-play scuffle (attack + knockback, animations5.glb)
let hitReactClip; // broken-tackle stagger (Hit_in_Back_While_Running, animations5.glb)
let SCALE = 1, GROUND_Y = 0, DEF_SCALE = 1, DEF_GROUND_Y = 0;

function measureBoneSpan(root) {
  root.updateWorldMatrix(true, true);
  const wp = new THREE.Vector3();
  let lo = Infinity, hi = -Infinity;
  root.traverse((o) => { if (o.isBone) { o.getWorldPosition(wp); lo = Math.min(lo, wp.y); hi = Math.max(hi, wp.y); } });
  return { lo, hi, span: hi - lo };
}

// Rapier physics powers the ragdoll tackles. Loaded async; if it fails the
// game still runs — tackles just end the play without the ragdoll fall.
let physics = null;

async function loadAssets() {
  loadingText.textContent = 'Loading character…';
  const charGltf = await loadGLB('assets/character.glb');
  // Opposing (defense) team uses its own blue rigged character — same skeleton,
  // so the shared animation clips drive it too. Optional: fall back to the
  // offense model (tinted) if it's missing.
  let defGltf = null;
  try { defGltf = await loadGLB('assets/character_def.glb'); } catch (e) { console.warn('Defense model missing', e); }
  loadingText.textContent = 'Loading animations…';
  const animGltf = await loadGLB('assets/animations.glb');
  loadingText.textContent = 'Starting physics…';
  try { physics = await PhysicsWorld.create(); physics.addCageWalls(CAGE_X - 0.35, CAGE_Z - 0.35, 7.5); } // ragdolls bounce off the fence (inset so bodies don't poke through)
  catch (e) { console.warn('Physics unavailable — tackles will be instant', e); }
  charTemplate = charGltf.scene;
  defTemplate = defGltf ? defGltf.scene : null;
  // Team helmets (static meshes attached to each head).
  try { helmetOffTemplate = (await loadGLB('assets/helmet_off.glb')).scene; } catch (e) { console.warn('off helmet missing', e); }
  try { helmetDefTemplate = (await loadGLB('assets/helmet_def.glb')).scene; } catch (e) { console.warn('def helmet missing', e); }
  try { footballTemplate = (await loadGLB('assets/football.glb')).scene; } catch (e) { console.warn('football model missing', e); }
  // Imported stadium props (corner light towers + perimeter graffiti walls).
  try { towerTemplate = (await loadGLB('assets/lighttower.glb')).scene; } catch (e) { console.warn('light tower missing', e); }
  try { wallTemplate = (await loadGLB('assets/wall.glb')).scene; } catch (e) { console.warn('wall missing', e); }
  try { cartTemplate = (await loadGLB('assets/cart.glb')).scene; } catch (e) { console.warn('cart missing', e); }
  try { goalpostTemplate = (await loadGLB('assets/goalpost.glb')).scene; } catch (e) { console.warn('goalpost missing', e); }
  placeStadiumProps();
  // The new merged Meshy pack (idle/walk variety, celebrations, parkour, scoop,
  // diving catch). Stripped to animation-only; same rig, so it drives our model
  // by bone name. Added on top of the original clips (kept for sprint/juke/
  // tackle/backpedals/get-ups it doesn't include).
  let anim2 = null, anim3 = null;
  try { anim2 = await loadGLB('assets/animations2.glb'); } catch (e) { console.warn('animations2 missing', e); }
  // animations3.glb: dances (hip-hop / boom / cheer) + anger (stomp / tantrum)
  // for the end-of-game dance party, same rig, animation-only.
  try { anim3 = await loadGLB('assets/animations3.glb'); } catch (e) { console.warn('animations3 missing', e); }
  // animations4.glb: Meshy "push" clips (Push_Forward_and_Stop + Push_and_Walk_Forward),
  // repurposed as line-of-scrimmage blocking + the break-tackle drive (sliced into
  // variants below). Same rig, animation-only.
  let anim4 = null;
  try { anim4 = await loadGLB('assets/animations4.glb'); } catch (e) { console.warn('animations4 missing', e); }
  // animations5.glb: pack-7 clips. For now only the fight clips are wired (cosmetic
  // post-play scuffle): a jab, a flying kick, and the blown-back reaction.
  let anim5 = null;
  try { anim5 = await loadGLB('assets/animations5.glb'); } catch (e) { console.warn('animations5 missing', e); }
  const byName = {};
  for (const c of animGltf.animations) byName[c.name] = c;
  if (anim2) for (const c of anim2.animations) if (!byName[c.name]) byName[c.name] = c; // additive: don't override existing
  if (anim3) for (const c of anim3.animations) if (!byName[c.name]) byName[c.name] = c; // additive: dances + anger
  if (anim4) for (const c of anim4.animations) if (!byName[c.name]) byName[c.name] = c; // additive: push clips (block / battle drive)
  if (anim5) for (const c of anim5.animations) if (!byName[c.name]) byName[c.name] = c; // additive: pack-7 fight clips
  // Strip every clip to ROTATION-ONLY: the source clips carry root motion
  // (Hips position) that translates the body during the clip and then snaps
  // back to the spawn spot ("teleport"). We drive position from the game, so
  // the skeleton should only rotate in place.
  const inPlace = (clip) => {
    if (!clip) return clip;
    const c = clip.clone();
    c.tracks = c.tracks.filter((t) => t.name.endsWith('.quaternion'));
    return c;
  };
  // Like inPlace, but KEEPS the root (Hips) VERTICAL motion so jumps / vaults /
  // rolls actually leave the ground. Horizontal Hips drift is frozen (we drive
  // x/z from the game), and groundClamp() lift-normalizes ground contact at
  // runtime, so each clip's differing standing height doesn't matter.
  const inPlaceY = (clip) => {
    if (!clip) return clip;
    const c = clip.clone();
    c.tracks = c.tracks.filter((t) => {
      if (t.name.endsWith('.quaternion')) return true;
      if (t.name.endsWith('Hips.position')) {
        const v = t.values, x0 = v[0], z0 = v[2];
        for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; } // freeze X/Z, keep Y
        return true;
      }
      return false; // other bones' positions are constant bind offsets — drop
    });
    return c;
  };
  // All clips are authored on THIS rig, so they pose cleanly (no retargeting).
  // Tag each locomotion clip with its authored GROUND SPEED (world yd/s at
  // timeScale 1) so updateAnimation can match playback to travel and the feet
  // plant instead of skating. Measured via foot-vs-hip stance velocity (FK) and
  // calibrated so the run reads planted near baseSpeed; the new variety walks
  // are genuinely slow gaits, hence the much lower refs.
  const REF_SPEED = { Walking: 2.8, Casual_Walk: 1.55, Proud_Strut: 1.25, Running: 8.5, RunFast: 11.4, BackLeft_run: 4.6, BackRight_Run: 4.6 };
  const loco = (name, fallback) => {
    const src = byName[name] || fallback; if (!src) return null;
    const c = inPlace(src); c.userData = { refSpeed: REF_SPEED[name] || 0 }; return c;
  };
  idleClip = inPlace(byName['Idle_11'] || charGltf.animations[0]); // breathing idle
  walkClip = loco('Walking'); runClip = loco('Running');
  sprintClip = loco('RunFast', byName['Running']) || runClip;      // turbo sprint
  backLClip = loco('BackLeft_run') || walkClip; backRClip = loco('BackRight_Run') || backLClip; // backpedals
  jukeClip = inPlace(byName['Roll_Dodge_1']);                      // juke = dodge roll
  // Tackle = a head-down lunge (just the hit, no roll); defender pops back up
  // to idle when it ends. Sliced to the forward drive.
  const charge = byName['Male_Head_Down_Charge'];
  tackleClip = charge
    ? inPlace(THREE.AnimationUtils.subclip(charge, 'tackle', 0, 14, 30))
    : jukeClip;
  // Catch: slice out just the reach (the clip ends in a long fall), then in-place.
  catchClip = byName['Jump_to_Catch_and_Fall']
    ? inPlace(THREE.AnimationUtils.subclip(byName['Jump_to_Catch_and_Fall'], 'catch', 6, 34, 30))
    : null;
  // --- Variety + new-move clips (all rotation-only, like the rest) ---
  // Per-player idle / walk pools so a lineup reads as individuals (real mocap
  // variety instead of procedural arm offsets) and the huddle walk-back isn't
  // robotic. Fall back to the originals if the new pack didn't load.
  // Idle pool = the clean breathing stance only (Idle_11). The Idle_02/03/8/10
  // variety clips have arms-spread / off poses that look wrong standing on the field.
  idleClips = [idleClip].filter(Boolean);
  if (!idleClips.length) idleClips = [inPlace(byName['Idle_11'])];
  // Walk pool is just the gameplay-paced Walking clip: the Casual_Walk /
  // Proud_Strut variety are leisurely cutscene gaits (~half pace) that skate
  // when sped up to match real movement, so they're not used for locomotion.
  walkClips = [walkClip].filter(Boolean);
  if (!walkClips.length) walkClips = [inPlace(byName['Walking'])];
  // Touchdown celebrations (one per scorer, picked at character build). These
  // are dynamic (jumps) so keep their vertical motion -> inPlaceY.
  celebClips = ['Cheer_with_Both_Hands', 'Jumping_Punch', 'Show_Both_Arm_Muscles', 'Proud_Strut']
    .map((n) => byName[n] && inPlaceY(byName[n])).filter(Boolean);
  // End-of-game finale: real looping dances for the winners and angry / tantrum
  // clips for the losers (vertical kept so stomps land + the tantrum sits).
  danceClips = ['Hip_Hop_Dance', 'Hip_Hop_Dance_2', 'Hip_Hop_Dance_3', 'Boom_Dance', 'Cheer_with_Both_Hands']
    .map((n) => byName[n] && inPlaceY(byName[n])).filter(Boolean);
  sulkClips = ['Angry_To_Tantrum_Sit', 'Angry_Stomp', 'Angry_Ground_Stomp']
    .map((n) => byName[n] && inPlaceY(byName[n])).filter(Boolean);
  // Pregame cheerleader: its own model + bundled clips. They walk into formation
  // (Walking_Woman), DANCE the pop/boom dances, then walk off. All frozen in place
  // (inPlaceY) — the group is translated manually for locomotion. Height-normalized.
  try {
    const cg = await loadGLB('assets/cheerleader.glb');
    cheerTemplate = cg.scene;
    const an = {}; (cg.animations || []).forEach((a) => { an[a.name] = a; });
    cheerClips = {
      walk: inPlaceY(an['Walking_Woman'] || an['Walking'] || (cg.animations || [])[0]),
      dances: ['Boom_Dance', 'Bubble_Dance', 'Cherish_Pop_Dance', 'Love_You_Pop_Dance', 'Superlove_Pop_Dance']
        .map((n) => an[n] && inPlaceY(an[n])).filter(Boolean),
    };
    const cr = measureBoneSpan(cheerTemplate); cheerScale = 1.8 / cr.span; cheerGroundY = -(cr.lo * cheerScale - 0.05);
  } catch (e) { console.warn('cheerleader model missing', e); cheerTemplate = null; cheerClips = null; }
  // Diving catch, loose-ball scoop, hurdle vault, cage wall-jump — all leave the
  // ground, so keep root vertical motion (inPlaceY) + groundClamp at runtime.
  diveCatchClip = byName['Leap_Right_and_Catch']
    ? inPlaceY(THREE.AnimationUtils.subclip(byName['Leap_Right_and_Catch'], 'divecatch', 0, 30, 30)) // leap+secure (drop the long fall)
    : catchClip;
  scoopClip = byName['Male_Run_Forward_Pick_Up_Left'] ? inPlaceY(byName['Male_Run_Forward_Pick_Up_Left']) : null;
  // Hurdle pool: two obstacle jumps + the parkour vault, so a leaping defender/runner
  // doesn't always clear the pile the same way. Per-player pick in makeCharacter.
  vaultClips = ['Jump_Over_Obstacle_1', 'Jump_Over_Obstacle_2', 'Parkour_Vault_2']
    .map((n) => byName[n] && inPlaceY(byName[n])).filter(Boolean);
  vaultClip = vaultClips[0] || jukeClip; // default / fallback
  cageVaultClip = byName['Parkour_Vault_with_Roll'] ? inPlaceY(byName['Parkour_Vault_with_Roll']) : vaultClip;
  // Broken-tackle stagger (pack 7): the runner gets rocked but powers through.
  hitReactClip = byName['Hit_in_Back_While_Running'] ? inPlaceY(byName['Hit_in_Back_While_Running']) : null;
  // Get-ups (played after a ragdoll when walking back to the line) — keep vertical
  // motion so the body rises off the turf.
  getUpClips = ['Stand_Up4', 'Stand_Up7'].map((n) => byName[n] && inPlaceY(byName[n])).filter(Boolean);
  // Engaged-PUSH pool: the Meshy push clips repurposed as the line shove — used by
  // offensive blockers, the rushers they lock up, AND the break-tackle defender. To
  // get variety across the field, "Push_Forward_and_Stop" (a full shove) is taken
  // whole and the long "Push_and_Walk_Forward" drive is sliced into several frame
  // windows, so each player plays a DIFFERENT version. Rotation-only (in-place shove —
  // groundClamp plants the feet) and PingPong-looped at runtime so a sustained push
  // has no restart pop. Falls back to the procedural shove pose if the pack is missing.
  const pushStop = byName['Push_Forward_and_Stop'], pushWalk = byName['Push_and_Walk_Forward'];
  blockClips = [];
  if (pushStop) blockClips.push(inPlace(pushStop)); // one full push-and-set cycle
  if (pushWalk) for (const [a, b] of [[0, 90], [80, 170], [160, 240]]) // drive sliced into distinct shoves
    blockClips.push(inPlace(THREE.AnimationUtils.subclip(pushWalk, 'push', a, b, 30)));
  // Post-play SCUFFLE clips (pack 7): a jab + a flying kick for the instigator and
  // the blown-back reaction for the victim. Dynamic (the kick leaves the ground, the
  // victim topples back), so keep vertical root motion + groundClamp at runtime.
  jabClip = byName['Left_Jab_from_Guard'] ? inPlaceY(byName['Left_Jab_from_Guard']) : null;
  kickClip = byName['Rising_Flying_Kick'] ? inPlaceY(byName['Rising_Flying_Kick']) : null;
  blownBackClip = byName['Shot_and_Blown_Back'] ? inPlaceY(byName['Shot_and_Blown_Back']) : null;
  const raw = measureBoneSpan(charTemplate);
  SCALE = 1.8 / raw.span;
  GROUND_Y = -(raw.lo * SCALE - 0.05);
  // The shared animation clips were authored for the DEFAULT rig's Head bind.
  // Capture it so alt models (whose Head bone can be bound at a very different
  // angle) can retarget the head and not stare straight up — see ch.headFix.
  BASE_HEAD_REST = headRestOf(charTemplate);
  if (defTemplate) {
    const dr = measureBoneSpan(defTemplate);
    DEF_SCALE = 1.8 / dr.span;
    DEF_GROUND_Y = -(dr.lo * DEF_SCALE - 0.05);
  } else { DEF_SCALE = SCALE; DEF_GROUND_Y = GROUND_Y; }
  // Build the player-team model registry: default first (loaded), then each alt as
  // a LAZY placeholder — alt models can be big, so they only download when selected
  // (see ensurePlayerModel). Height is auto-normalized on load; helmet is per-model.
  PLAYER_MODELS.length = 0;
  PLAYER_MODELS.push({ name: 'DEFAULT', template: charTemplate, helmet: helmetOffTemplate || helmetDefTemplate, scale: SCALE, groundY: GROUND_Y, loaded: true });
  for (const def of ALT_MODEL_DEFS) PLAYER_MODELS.push({ name: def.name, glb: def.glb, helmetUrl: def.helmet, template: null, helmet: null, scale: SCALE, groundY: GROUND_Y, loaded: false });
}
// Lazy-load an alt model's mesh + helmet on first use (keeps big models off the
// startup download). Resolves with the registry entry; entry.template stays null
// (so callers fall back to the default model) if the .glb is missing/broken.
async function ensurePlayerModel(idx) {
  const e = PLAYER_MODELS[idx];
  if (!e || e.loaded) return e;
  try { e.template = (await loadGLB(e.glb)).scene; } catch (err) { console.warn('alt model missing', e.glb, err); e.loaded = true; return e; }
  try { e.helmet = (await loadGLB(e.helmetUrl)).scene; } catch (err) { e.helmet = null; } // bare-headed until provided
  const r = measureBoneSpan(e.template); e.scale = 1.8 / r.span; e.groundY = -(r.lo * e.scale - 0.05);
  e.loaded = true; return e;
}

function makeCharacter(team) {
  // Offense = original character; defense = its own blue rigged character (or a
  // blue-tinted fallback if that model didn't load). Each keeps its own skin.
  const isDef = team === 'def';
  // Defense uses its own BLUE-skinned model (character_def.glb — the same rig as
  // the offense with the team-red accents recolored to blue), so it animates and
  // attaches its head/helmet exactly like the offense. If that model is missing,
  // fall back to cloning the offense and tinting it blue.
  const useBlue = isDef && defTemplate;
  // Player team picks from the model registry (0 = default); defense uses its blue
  // model. A not-yet-loaded alt falls back to the default until ensurePlayerModel runs.
  let pm = (!isDef && PLAYER_MODELS.length) ? PLAYER_MODELS[THREE.MathUtils.clamp(TUNE.altModel | 0, 0, PLAYER_MODELS.length - 1)] : null;
  if (pm && !pm.template) pm = PLAYER_MODELS[0];
  const model = cloneSkeleton(pm ? pm.template : (useBlue ? defTemplate : charTemplate));
  const mScale = pm ? pm.scale : (isDef ? DEF_SCALE : SCALE);
  const mGroundY = pm ? pm.groundY : (isDef ? DEF_GROUND_Y : GROUND_Y);
  model.scale.multiplyScalar(mScale);
  model.position.y = mGroundY;
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.frustumCulled = false; o.userData.isBody = true;
      o.material = o.material.clone();
      if (isDef && !useBlue) { // fallback: tint the offense model blue
        o.material.color.setHex(0x5f8dff);
        o.material.emissive = new THREE.Color(0x1a3a8c);
        o.material.emissiveIntensity = 0.6;
      } else {
        // The skin ships fully self-lit (emissiveFactor 1 + emissive skin texture),
        // so scene lights barely touch it. Dial the glow down (TUNE.playerGlow) so the
        // body is lit by the floods/key like the helmet — tunable in the debug panel.
        o.material.emissiveIntensity = TUNE.playerGlow;
      }
      o.material.needsUpdate = true;
    }
  });
  const group = new THREE.Group();
  group.add(model);
  scene.add(group);
  // Hand bone the ball is tucked into while carrying, plus every bone's REST
  // local pose. The ragdoll drives bone positions during a tackle; since our
  // clips are rotation-only they never restore positions, so we snap bones
  // back to rest when the ragdoll is cleared (else the lower body stays under
  // the field and the next hit snapshots a broken pose).
  let handBone = null, upperArm = null, foreArm = null, leftArm = null, leftForeArm = null, leftHandBone = null;
  let headBone = null, headEnd = null, spineBone = null;
  const restPose = [];
  model.traverse((o) => {
    if (o.isBone) {
      if (o.name === 'RightHand') handBone = o;
      if (o.name === 'RightArm') upperArm = o;
      if (o.name === 'RightForeArm') foreArm = o;
      if (o.name === 'LeftArm') leftArm = o;
      if (o.name === 'LeftForeArm') leftForeArm = o;
      if (o.name === 'LeftHand') leftHandBone = o;
      if (o.name === 'Head') headBone = o;
      if (o.name === 'head_end') headEnd = o;
      if (o.name === 'Spine01' || (!spineBone && o.name === 'Spine')) spineBone = o; // waist bend (battle/block)
      restPose.push([o, o.position.clone(), o.quaternion.clone()]);
    }
  });
  const upperArmRest = upperArm ? upperArm.quaternion.clone() : null;
  const foreArmRest = foreArm ? foreArm.quaternion.clone() : null;
  const leftArmRest = leftArm ? leftArm.quaternion.clone() : null;
  const leftForeArmRest = leftForeArm ? leftForeArm.quaternion.clone() : null;
  const spineRest = spineBone ? spineBone.quaternion.clone() : null;
  // Head retarget: alt models bind the Head bone at a different angle than the
  // shared clips assume, so without this their heads pitch to the sky. headFix maps
  // the base-rig head pose onto THIS model's rest (applied after each mixer update).
  // ~identity (left null) for the default/defense rigs, which share the base bind.
  let headFix = null;
  if (headBone && BASE_HEAD_REST) {
    // K = baseRest^-1 * altRest, POST-multiplied onto each clip pose so the head
    // deforms like the base rig the clips were authored for (skin is relative to
    // THIS model's inverse bind). headBone.quaternion here is still the bind rest.
    const c = BASE_HEAD_REST.clone().invert().multiply(headBone.quaternion);
    if (Math.abs(c.w) < 0.99995) headFix = c; // only when this model's bind differs (> ~0.6 deg)
  }
  const mixer = new THREE.AnimationMixer(model);
  const mk = (clip) => {
    const a = mixer.clipAction(clip);
    a.setLoop(THREE.LoopRepeat, Infinity); a.enabled = true;
    a.setEffectiveWeight(0); a.play(); return a;
  };
  // Per-player idle + walk variety (real clips, not a procedural offset).
  const myIdle = (idleClips.length ? idleClips : [idleClip])[(Math.random() * (idleClips.length || 1)) | 0] || idleClip;
  const myWalk = (walkClips.length ? walkClips : [walkClip])[(Math.random() * (walkClips.length || 1)) | 0] || walkClip;
  const actions = { idle: mk(myIdle), walk: mk(myWalk), run: mk(runClip), sprint: mk(sprintClip), backL: mk(backLClip), backR: mk(backRClip) };
  const oneShot = (clip) => {
    const a = mixer.clipAction(clip);
    a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true;
    a.enabled = true; a.setEffectiveWeight(0); return a;
  };
  if (jukeClip) actions.juke = oneShot(jukeClip);
  if (catchClip) actions.catch = oneShot(catchClip);
  if (tackleClip) actions.tackle = oneShot(tackleClip);
  if (diveCatchClip) actions.divecatch = oneShot(diveCatchClip);
  if (scoopClip) actions.scoop = oneShot(scoopClip);
  // Per-player hurdle clip from the pool (variety), falling back to the single default.
  if (vaultClips.length) actions.vault = oneShot(vaultClips[(Math.random() * vaultClips.length) | 0]);
  else if (vaultClip) actions.vault = oneShot(vaultClip);
  if (cageVaultClip) actions.cagevault = oneShot(cageVaultClip);
  if (hitReactClip) actions.hitreact = oneShot(hitReactClip); // broken-tackle stagger
  if (celebClips.length) actions.celebrate = oneShot(celebClips[(Math.random() * celebClips.length) | 0]); // this player's TD dance
  if (getUpClips.length) actions.getup = oneShot(getUpClips[(Math.random() * getUpClips.length) | 0]); // pop up after a knockdown
  // End-of-game finale: a looping dance (winner) and a looping anger clip (loser),
  // each picked per player for variety.
  if (danceClips.length) actions.dance = mk(danceClips[(Math.random() * danceClips.length) | 0]);
  if (sulkClips.length) actions.sulk = mk(sulkClips[(Math.random() * sulkClips.length) | 0]);
  // Engaged push: a real clip-driven shove (used for blocking AND the break-tackle
  // drive). Each player picks a random VERSION (a different push slice) and a random
  // speed so a blocking line reads as individuals. PingPong-looped so the held push
  // cycles without a pop.
  let blockTS = 1;
  if (blockClips.length) {
    const a = mixer.clipAction(blockClips[(Math.random() * blockClips.length) | 0]);
    a.setLoop(THREE.LoopPingPong, Infinity); a.enabled = true; a.clampWhenFinished = false;
    a.setEffectiveWeight(0); a.play();
    blockTS = 0.82 + Math.random() * 0.5; // per-player tempo
    actions.block = a;
  }
  // Post-play scuffle one-shots (cosmetic): a jab / flying kick (instigator) and the
  // blown-back reaction (victim). Any player can be drawn into a fight.
  if (jabClip) actions.jab = oneShot(jabClip);
  if (kickClip) actions.kick = oneShot(kickClip);
  if (blownBackClip) actions.blownback = oneShot(blownBackClip);
  actions.idle.setEffectiveWeight(1);
  mixer.setTime(Math.random() * 4); // desync the gait so players aren't in lockstep
  actions.idle.timeScale = 0.82 + Math.random() * 0.5; // vary breathing speed per player

  // Helmet: a scaled clone of the team helmet PARENTED to the Head bone, so it
  // is rigidly attached (can't detach, follows head turns + ragdoll tumbles).
  // Local transform compensates for the bone's tiny world scale.
  let helmet = null;
  // Each player-team model carries its own helmet (the default + defense use the
  // original; alts use theirs, or go bare-headed until one's provided).
  const helmetScene = pm ? pm.helmet : (helmetOffTemplate || helmetDefTemplate);
  if (headBone) headBone.scale.setScalar(HEAD_SCALE); // Blitz-style big head (both teams)
  if (helmetScene && headBone && headEnd) {
    model.updateWorldMatrix(true, true);
    const hp = new THREE.Vector3(), ep = new THREE.Vector3(), hs = new THREE.Vector3(), hq = new THREE.Quaternion();
    headBone.matrixWorld.decompose(hp, hq, hs);  // head bone world pos/rot/scale
    headEnd.getWorldPosition(ep);
    const headH = Math.max(0.05, hp.distanceTo(ep));      // head length (world)
    const headWorldScale = (hs.x + hs.y + hs.z) / 3 || 0.0124;
    helmet = helmetScene.clone(true);
    helmet.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    // helmet bbox is ~2 units tall; size it to ~1.7x the (already enlarged) head.
    helmet.scale.setScalar((headH * 1.7) / (2.0 * headWorldScale));
    // This character has a tall armored collar that swallows the head, so seat
    // the helmet up at/above the crown (head_end) rather than the head centre.
    const up = new THREE.Vector3().subVectors(ep, hp).normalize();
    const centre = ep.clone().addScaledVector(up, headH * 0.5);
    helmet.position.copy(headBone.worldToLocal(centre));
    // Face forward: world-identity orientation at rest = headWorldQuat^-1.
    helmet.quaternion.copy(hq).invert();
    headBone.add(helmet);
    // Remember the rest attachment so a popped-off helmet can snap back next play.
    helmet.userData.rest = { parent: headBone, pos: helmet.position.clone(), quat: helmet.quaternion.clone(), scale: helmet.scale.clone() };
    helmet.userData.flying = false;
  } else if (!helmet && headBone && headEnd) {
    // Bare-headed model (no helmet GLB): build a HEAD prop so the head can pop off
    // just like a helmet. Invisible normally (the skinned head shows); on a pop it's
    // shown + flown while the real head shrinks to a nub (see popHelmet/restoreHelmet).
    model.updateWorldMatrix(true, true);
    const hp = new THREE.Vector3(), ep = new THREE.Vector3(), hs = new THREE.Vector3(), hq = new THREE.Quaternion();
    headBone.matrixWorld.decompose(hp, hq, hs);
    headEnd.getWorldPosition(ep);
    const headH = Math.max(0.05, hp.distanceTo(ep));
    const headWorldScale = (hs.x + hs.y + hs.z) / 3 || 0.0124;
    let skin = 0xb98a66; // skin tone; sample the body material if it isn't just white-on-texture
    model.traverse((o) => { if (o.isSkinnedMesh && o.material && o.material.color) { const c = o.material.color; if (c.r + c.g + c.b < 2.85) { skin = c.getHex(); } } });
    const headProp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), new THREE.MeshStandardMaterial({ color: skin, roughness: 0.85, metalness: 0.0 }));
    headProp.scale.setScalar((headH * 1.25) / headWorldScale); headProp.scale.y *= 1.15; // ~head-sized in the bone's local space, slightly egg-shaped
    headProp.position.copy(headBone.worldToLocal(hp.clone().lerp(ep, 0.5))); // head centre
    headProp.castShadow = true; headProp.frustumCulled = false; headProp.visible = false;
    headProp.userData.rest = { parent: headBone, pos: headProp.position.clone(), quat: headProp.quaternion.clone(), scale: headProp.scale.clone() };
    headProp.userData.flying = false; headProp.userData.isHead = true;
    headBone.add(headProp);
    helmet = headProp; // routed through the same pop/restore/flying-helmet machinery
  }

  return {
    group, model, mixer, actions, handBone, restPose, current: 'idle', active: actions.idle, mScale, mGroundY,
    upperArm, foreArm, upperArmRest, foreArmRest, spineBone, spineRest, leftHandBone,
    leftArm, leftForeArm, leftArmRest, leftForeArmRest, throwAnimT: 0, throwLaunch: 0.3,
    armPose: null, armPoseT: 0, armPoseDur: 0, armPoseTarget: null,
    headBone, headEnd, helmet, headFix, bones: restPose.map((e) => e[0]), // bone list for replay capture
    team, role: 'WR', job: 'idle', heading: 0,
    vel: new THREE.Vector3(), speed: 0, baseSpeed: 8.4, turbo: false,
    home: new THREE.Vector3(), desired: { x: 0, z: 0 },
    route: null, wp: 0, cutTimer: 0, jukeTimer: 0, jukeCd: 0, oneShotT: 0, spinT: 0, recoverT: 0, cageJumpCd: 0, engaged: false,
    tauntT: 0, tauntCd: 0, diveT: 0, diveCd: 0, // showboat window/cooldown + diving-tackle window/cooldown
    fatigue: 1, // 1 = fresh, drains with exertion -> less top speed / break power
    backped: false,
    // Procedural overlay blend weights (0..1): each eases in/out so a pose fades
    // smoothly over the locomotion clip instead of snapping on/off in one frame.
    throwW: 0, catchW: 0, armW: 0, battleW: 0, grabW: 0, sulkW: 0, catchRaise: 0.8, protectW: 0,
    // Locomotion "life": eased bank (lean into turns) + forward pitch (lean with
    // speed/turbo); prevHeading feeds the turn rate; breathPh desyncs idle breathing;
    // headYaw is the eased look-target offset (head-on-a-swivel in coverage).
    bank: 0, lean: 0, prevHeading: 0, breathPh: Math.random() * 6.283, headYaw: 0,
    blocking: false, blockFace: 0, blockW: 0, blockTS, // engaged-block (clip-driven; blockW/applyBlockPose = fallback)
    engaging: null, blockedBy: null, engageT: 0, shedCd: 0, // block lock-up / shed system
    covers: -1, deep: false, assignment: null, zonePoint: null, blockTarget: null,
    strength: 1, ragdoll: null, ragdolling: false,
  };
}

function setClip(ch, name) {
  if (ch.current === name) return;
  const next = ch.actions[name];
  next.reset(); next.enabled = true;
  next.setEffectiveTimeScale(1); next.setEffectiveWeight(1);
  next.crossFadeFrom(ch.active, 0.18, false); next.play();
  ch.active = next; ch.current = name;
}

// ===========================================================================
// Game state
// ===========================================================================
const STATE = { PRESNAP: 'presnap', LIVE: 'live', AIR: 'air', RUN: 'run', RETURN: 'return', TACKLE: 'tackle', BATTLE: 'battle', LOOSE: 'loose', DEAD: 'dead', RESET: 'reset', REPLAY: 'replay' };
// Live-tunable gameplay knobs, editable at runtime from the DEBUG panel (tap the
// version badge or press the ` key). Read everywhere instead of hard-coded values.
const TUNE_DEFAULTS = {
  fightChance: 0.18,     // post-play scuffle chance after a no-replay tackle/OOB
  fightKnockback: 3.2,   // how hard the scuffle victim is staggered back (yd/s)
  blockTempo: 1.0,       // global × on the engaged-push / break-tackle clip speed
  staggerDur: 0.4,       // broken-tackle ("BROKE IT!") hit-stagger length (s)
  fumbleChance: 1.0,     // × on the base fumble odds on a hit
  breakTackleEase: 1.0,  // × how easy the 1-on-1 break-tackle battle is (>1 easier)
  battleChance: 0.6,     // odds a lone 1-on-1 hit kicks off a break-tackle battle (vs a plain tackle)
  celebChance: 0.5,      // odds a home TD triggers a stadium celebration show
  quarterLen: 90,        // seconds of game clock per quarter (applies next quarter)
  turboMult: 1.28,       // turbo burst speed multiplier
  onFireBoost: 1.12,     // ON FIRE offense speed multiplier
  catchBias: 0.0,        // global nudge to catch/completion odds (+/-)
  intChance: 1.0,        // × odds a DB picks off a contested throw the receiver couldn't haul in (0 = never)
  fatigueDrain: 1.0,     // × how fast players gas out
  knockdownRecover: 1.6, // s before a knocked-down defender pops up & re-pursues (0 = stay down)
  playClock: 15,         // delay-of-game seconds before the snap (applies next play)
  swarmRadius: 4.2,      // yards: defenders within this of the carrier join the gang tackle
  jamYards: 5,           // coverage may JAM a route runner within this many yds of the LOS; past it, no body-blocking (illegal contact) — they can only cover
  // Contact spacing (the gap/offset where two players MEET) — tuned in the Contact Lab.
  gapBattle: 1.49,       // break-tackle: how far the tackler stands off the carrier (yd)
  latBattle: 0.0,        // break-tackle: tackler lateral offset (yd)
  gapBlock: 1.49,        // engaged block: half the chest-to-chest gap (yd)
  latBlock: 0.0,         // engaged block: defender lateral offset (yd)
  gapGrab: 1.5,          // wrap/gang drag: how far each grabber rings the carrier (yd)
  tackleReach: 1.5,      // contact radius for a tackle (yd)
  catchReach: 1.6,       // catch radius (intended receiver gets +1.0) (yd)
  catchGrab: 0.45,       // 3D slack on the reach volume: how far OUT of reach the ball can still be grabbed (yd)
  catchSecure: 0.22,     // ball-into-hands homing time once a catch is committed (s)
  catchLog: false,       // log catch telemetry (gap/height/branch) to the debug event log
  jumpReach: 1.0,        // weight of vertical reach in the jump-ball contest (0 = off, 2D)
  catchHeight: 1.0,      // × the catch collider's vertical reach (height)
  // User catch (Phase 1 RAC + Phase 2 cue): on your own pass, press CATCH in the
  // timing window to make the grab in stride. CPU receivers are unaffected.
  userCatch: true,       // enable the user-controlled catch on your targeted receiver
  catchWindow: 1.4,      // 3D gap (yd) at which the user-catch timing window opens as the ball drops in
  userCatchBonus: 0.18,  // max catch-odds bonus added for a well-timed user catch
  racBoost: 1.18,        // × baseSpeed burst out of a RAC (catch-in-stride) reception (YAC)
  catchMissPenalty: 0.06,// catch-odds penalty for a clearly mistimed user press (vs a clean AI grab)
  catchIK: 1.0,          // Phase 4: weight of the 2-bone hand IK that lands the hands on the ball (0 = off)
  possCatch: 0.12,       // POSSESSION style: flat catch-odds bonus (secure, lowest drop), no YAC
  aggContest: 0.16,      // AGGRESSIVE style: bonus to CONTESTED catches (high-point win)
  aggSecurity: 0.10,     // AGGRESSIVE style: penalty to UNCONTESTED catches (riskier hands)
  // Phase 3 — contested catches as physics (gate flag for all Phase-3 behavior).
  contestPhysics: true,  // a contested breakup can TIP the ball LIVE + jarring-hit risk on contested catches
  tipChance: 0.5,        // fraction of contested breakups that tip into a live loose ball (vs a clean incompletion)
  catchHitRisk: 0.55,    // added fumble probability on the jarring hit right after an EXPOSED contested catch (× style)
  catchExposeTime: 0.7,  // s a receiver stays exposed to a jarring hit after a contested catch
  engageReach: 1.5,      // blocker↔rusher lock-up radius (yd)
  bodyFit: 1.0,          // × the collider radius auto-measured from the model (1 = exact model width)
  playerSize: 1.0,       // × visual player model scale
  ballSize: 1.0,         // × visual football scale
  exposure: 1.3,         // renderer tone-mapping exposure (overall brightness)
  lightAmbient: 0.6,     // hemisphere (sky/ground) ambient intensity
  lightAmbientSky: '#44588f',    // hemisphere sky color
  lightAmbientGround: '#0c1208', // hemisphere ground color
  lightKey: 0.85,        // sun/moonlight key directional intensity
  lightKeyColor: '#b9c8ee',      // key/sun color
  lightRim: 0.35,        // cool rim directional intensity
  lightRimColor: '#6f86c0',      // rim color
  lightFloods: 1.0,      // × corner floodlight (tower spot) intensity
  lightFloodColor: '#fff4d6',    // floodlight color
  playerGlow: 0.35,      // player skin self-illumination (1 = fully self-lit, 0 = scene-lit only)
  altModel: 0,           // 0 = default model for your team; 1 = the alternate character_alt.glb model
  // Look / materials
  offenseTint: '#ffffff', defenseTint: '#ffffff', // per-team body color multiply
  skinRough: 1.0, skinMetal: 0.0,                  // player skin material
  turfTint: '#ffffff',                             // field grass color multiply
  runLean: 1.0,                                    // × forward body lean while running (lower = subtler)
  // Procedural animation intensities (× the eased pose weight; 0 = off, 1 = default)
  animBank: 1.0, animBreath: 1.0, animBlock: 1.0, animBattle: 1.0, animArm: 1.0,
  animCatch: 1.0, animThrow: 1.0, animGrab: 1.0, animSulk: 1.0, animHead: 1.0, animProtect: 1.0,
  // Camera framing
  camFov: 1.0, camDist: 1.0, camHeight: 1.0,       // × broadcast FOV / chase distance / height
  // FX / juice
  ragdolls: 1, gore: 1,                            // 0 = off
  shakeAmt: 1.0, hitZoomAmt: 1.0,                  // × screen shake / hit zoom-punch
  // World + audio
  fogColor: '#12203f', fogNear: 130, fogFar: 330,  // night haze
  masterVolume: 0.5,                               // master audio gain
  musicVolume: 0.8, sfxVolume: 1, voiceVolume: 1,  // per-channel mix (music / SFX / commentary)
  audioMuted: 0,                                   // 1 = mute everything
  // Debug visualization overlays (0/1)
  vizColliders: 0, vizVectors: 0, vizLabels: 0, vizLog: 0,
  // Difficulty fine-tune (multiply/offset on top of the rookie/pro/all-pro preset)
  cpuSpdMul: 1.0, cpuCatchAdd: 0.0, cpuAccMul: 1.0, userBreakMul: 1.0,
  // Play-calling matchup: how much a concept-vs-coverage edge swings coverage
  // separation (0 = calls are cosmetic; 1 = a beaten call gives a clear step).
  matchupLeverage: 1.0,
};
const TUNE = { ...TUNE_DEFAULTS };
// Apply persisted overrides (debug panel "Save") over the defaults at boot, so a
// tuned setup survives reloads. Guarded for the headless harness (no localStorage).
const TUNE_STORE_KEY = 'rfTune';
try {
  if (typeof localStorage !== 'undefined') {
    const saved = JSON.parse(localStorage.getItem(TUNE_STORE_KEY) || '{}');
    for (const k in TUNE_DEFAULTS) if (saved[k] !== undefined && typeof saved[k] === typeof TUNE_DEFAULTS[k]) TUNE[k] = saved[k];
  }
} catch (e) { /* ignore corrupt/unavailable storage */ }
// NFL Blitz rules: 30 yards for a first down, drives start on your own 20,
// four downs (no punts/FGs), short running quarters and a delay-of-game clock.
const DRIVE_START = -30, FIRST_DOWN_YDS = 30;
// Play-clock + quarter length are debug knobs (TUNE.playClock / TUNE.quarterLen).
const game = {
  state: STATE.PRESNAP,
  offense: [], defense: [], all: [],
  qb: null, controlled: null, carrier: null,
  selected: 5, receivers: [],
  los: DRIVE_START, firstDown: 0, down: 1,
  scoreOff: 0, scoreDef: 0,
  tally: { plays: 0, sacks: 0, fumbles: 0, picks: 0, bigPlays: 0 }, // balance telemetry (see balanceSummary)
  userStats: { tackles: 0, catches: 0, ints: 0 }, // the human player's plays (career; see USER_STATS_KEY)
  diff: 'pro', // difficulty (rookie/pro/allpro) — set on the start menu
  gauntlet: null, // {active, round, wins, champion} when running the gauntlet, else null (exhibition)
  paused: false, // soft-pause: the pause menu is open and the sim loop is frozen
  quarter: 1, gameClock: TUNE.quarterLen, snapClock: TUNE.playClock, gameOver: false,
  clockStopped: true, // running clock — only paused after a score/incomplete/turnover (until next snap)
  deadTimer: 0, tsFactor: 1,            // tsFactor = current slow-mo factor (1 = full speed)
  tackleTimer: 0, tackleSpotZ: 0, whistled: false, // ragdoll tackle: hold while physics plays the fall (whistled once per play)
  drag: { active: false, t: 0, dur: 0, hx: 0, hz: 0, grabbers: [], baseAng: 0, big: false, closing: 0, gangShown: 0 }, // wrap-and-drag-down before the pile collapses to ragdolls (+ dynamic pile-on state)
  returnActive: false, returner: null, // interception runback (defense carries)
  fumbleLost: false,                    // a hit popped the ball loose to the defense
  looseTimer: 0,                        // live-fumble scramble countdown
  looseCrowdT: 0,                       // how long 3+ players have crowded the loose ball
  scrum: { active: false, val: 0.5, timer: 0, x: 0, z: 0, cd: 0, crew: [] }, // loose-ball pile mash
  resetTimer: 0,                        // between-plays walk-back countdown
  cut: { phase: null, t: 0, mid: null },// broadcast fade dip that hides the reset snap
  replay: { frames: [], fx: [], events: [], pool: [], fxPool: [], evPool: [], i: 0, hold: 0, seg: 0, rate: 0.85, bigHit: false, phase: 'play', fade: 0, angleIdx: 0, loops: 0, snap: false, manual: false, paused: false, dir: 1 }, // instant-replay buffer (+ per-frame flame fx, + helmet-pop events, + free-lists of recycled buffers) + looping multi-angle cam (manual = user-driven cam + scrub). dir = the recorded play's attack direction so the replay frames it like the live view (not mirrored).
  pendingReplay: false, celebrating: false, // defer the replay until after the dead-ball beat (lets a TD celebration play)
  finale: null, // end-of-game dance party: { active, t, winners, losers, center } (see startFinale)
  playIndex: 0, defCall: 0, choosing: false, psPage: 0, psCat: 'all', cpuLastPlay: -1, autoSnapT: 0, // offense play / def call / select / page / play-select category filter / CPU last call / CPU snap timer
  lastPlayIndex: -1, // the offensive play actually run last (for the "LAST" tag in play-select)
  // Play-calling matchup (Phase 1): the concept-vs-coverage edge resolved at snap.
  // coverLev > 0 = offense beat the call (receivers get a step); < 0 = blanketed.
  matchup: null, coverLev: 0, coverClose: 1, cpuDefIdx: 0, cpuOffIdx: 0,
  tend: { userOff: [], userDef: [], cpuOff: [], cpuDef: [] }, // recent play/coverage calls per actor (tendency memory)
  coachCam: false, // pre-snap "play art" overlay toggle (route ribbons on the field)
  lab: false,      // Contact Lab mode (standalone two-player contact-pose editor)
  // Possession: the player (red team) attacks +Z; the CPU (blue) attacks -Z.
  // dir = the current offense's attacking direction. When the CPU has the ball
  // you play DEFENSE (control the nearest defender).
  userOnOffense: true, dir: 1, cpuQBTimer: 0,
  // Blitz systems: draining turbo meter, ON FIRE after 3 straight TDs.
  turboMeter: 1, turboLock: false, onFire: false, fireCount: 0,
  playClock: 0, lastBreak: -10,
  battle: { val: 0.5, timer: 0, tackler: null, cd: 0, flash: 0, playCount: 0 },
  throwCharge: 0, // hold the THROW button to charge tap=lob -> hold=bullet
  throwArmed: false, // a throw only arms on a fresh press in LIVE (not the snap press)
};
// ---- User-action tracker: a running, persisted record of the HUMAN player's
// plays — tackles he makes (his controlled defender brings the carrier down),
// catches by his offense, and interceptions by his defense. Career totals,
// stored across sessions; shown in the HUD badge + the debug Stats report. -------
const USER_STATS_KEY = 'rfUserStats';
try {
  if (typeof localStorage !== 'undefined') {
    const s = JSON.parse(localStorage.getItem(USER_STATS_KEY) || '{}');
    for (const k in game.userStats) if (Number.isFinite(s[k])) game.userStats[k] = s[k];
  }
} catch (e) { /* ignore corrupt/unavailable storage */ }
function saveUserStats() {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(USER_STATS_KEY, JSON.stringify(game.userStats)); } catch (e) { /* ignore */ }
}
// Credit one user action and flash the HUD. label drives the on-screen note.
function creditUserStat(key, label) {
  if (game.userStats[key] === undefined) return;
  game.userStats[key]++;
  saveUserStats();
  if (typeof dbgLogPush === 'function') dbgLogPush(`<b>YOU:</b> ${label} (${game.userStats[key]})`);
  flashUserStats(key);
}
// Did the human personally make this tackle? (his controlled defender, on defense)
function userMadeTackle(tackler) { return !game.userOnOffense && tackler && tackler === game.controlled; }
const THROW_CHARGE_MAX = 0.5; // seconds to a full bullet pass

const ball = {
  mesh: null, mode: 'carried', // 'carried' | 'flying' | 'secured' | 'rest'
  to: new THREE.Vector3(), targetRecv: null,
  // Projectile state while flying.
  vx: 0, vy: 0, vz: 0, g: 0, airTime: 0, flightTime: 1, startY: 1.2,
  spin: 0, spinRate: 0, hitFence: false,
  // Catch: ball homes into the catcher's hands before the play resolves.
  catcher: null, secureT: 0, secureFull: 0.2, secureFrom: new THREE.Vector3(), intercept: false, holder: null, intRolled: false,
  trail: [], trailHist: [], trailHead: 0, trailCount: 0, mats: [], // glowing comet trail (sprite pool, ring-buffered history) + ball materials
};
function makeGlowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,224,150,0.65)');
  grd.addColorStop(1, 'rgba(255,170,70,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// A bloom halo (big soft glow + bright core) at a stadium lamp. Pushed to
// towerGlows so driveTowerGlows can twinkle it like a harsh stadium floodlight.
function addTowerGlow(x, y, z) {
  _glowTex = _glowTex || makeGlowTexture();
  const mk = (s, op) => {
    const m = new THREE.SpriteMaterial({ map: _glowTex, color: 0xfff2d2, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false });
    const sp = new THREE.Sprite(m); sp.scale.set(s, s, 1); sp.position.set(x, y, z); sp.renderOrder = 3; scene.add(sp); return sp;
  };
  const halo = mk(13, 0.42), core = mk(5, 0.85);
  towerGlows.push({ halo, core, base: 1, phase: Math.random() * Math.PI * 2 });
}
// Slow, subtle floodlight shimmer (a hint of lens-flare life, not a strobe).
function driveTowerGlows(t) {
  for (const g of towerGlows) {
    const k = 0.9 + 0.1 * Math.sin(t * 1.7 + g.phase);
    g.halo.material.opacity = 0.42 * k; g.core.material.opacity = 0.85 * k;
    g.core.scale.setScalar(5 * (0.96 + 0.04 * k));
  }
}

// --- Home-team touchdown celebration: random FIREWORKS or LIGHT SHOW --------
// Only fires for the home (player's) team, and only sometimes. Two flavors:
//  - 'fireworks': realistic shells rise on a trail and burst into peonies +
//    glitter, framed by a dedicated sky cam (see driveSpecialCam 'fireworks').
//  - 'lightshow': the arena goes dark, a red strobe pulses and white spotlights
//    sweep the field.
const FW_COLORS = [0xff3b3b, 0x3aa0ff, 0xffd23a, 0x6dff7a, 0xff6ae0, 0xff9a3a, 0x9d7bff, 0xffffff];
const fwSparks = [];            // pooled additive glow sprites (spark + glitter)
const fwShells = [];            // rising shells (rockets) that burst at apex
const fwLights = [];            // brief colored point-flashes at each burst
const sweepLights = [];         // spotlights (white) for the light show
let fwLightI = 0;
let strobe = null;              // red strobe (light show)
// Stadium-celebration odds are TUNE.celebChance (debug-tunable).
const celebFx = { mode: null, t: 0, next: 0, z: 0, dim: 0, grand: false, lightsOn: false };
// Toggle ALL celebration lights together so the scene's light COUNT is constant
// during any celebration (otherwise per-burst point-light toggles change the
// count every frame, forcing a shader recompile cascade — the first-celebration
// frame-rate dip). The single celeb light config is pre-warmed at load.
function setCelebLights(on) {
  if (celebFx.lightsOn === on) return;
  celebFx.lightsOn = on;
  for (const L of sweepLights) { L.visible = on; if (!on) L.intensity = 0; }
  if (strobe) { strobe.visible = on; if (!on) strobe.intensity = 0; }
  for (const L of fwLights) { L.visible = on; L.intensity = 0; if (L.userData) L.userData.f = 0; }
}
// Compile the celebration light config's shaders during the load screen, so the
// first celebration doesn't stall the frame rate recompiling them in-game.
function prewarmCelebShaders() {
  if (!renderer || !scene || !camera) return;
  try {
    renderer.compile(scene, camera);   // gameplay light config
    setCelebLights(true);
    renderer.compile(scene, camera);   // celebration light config (all celeb lights on)
    setCelebLights(false);
  } catch (e) { /* best-effort warm-up */ }
}
(function initCelebFx() {
  const tex = makeGlowTexture();
  for (let i = 0; i < 640; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    s.visible = false; s.userData = { vx: 0, vy: 0, vz: 0, life: 0, max: 1, base: 1, drag: 0.3, glitter: false, ph: 0 }; scene.add(s); fwSparks.push(s);
  }
  for (let i = 0; i < 6; i++) { const L = new THREE.PointLight(0xffffff, 0, 80, 1.6); L.visible = false; L.userData = { f: 0 }; scene.add(L); fwLights.push(L); }
  for (let i = 0; i < 3; i++) {
    const L = new THREE.SpotLight(0xffffff, 0, 160, Math.PI / 10, 0.5, 1.0);
    L.position.set(Math.cos(i / 3 * Math.PI * 2) * 34, 42, Math.sin(i / 3 * Math.PI * 2) * 34);
    L.visible = false; scene.add(L); scene.add(L.target); sweepLights.push(L);
  }
  strobe = new THREE.HemisphereLight(0xff1818, 0x120000, 0); strobe.visible = false; scene.add(strobe);
})();
function spawnSpark(x, y, z, vx, vy, vz, life, base, col, drag, glitter) {
  for (const s of fwSparks) {
    const u = s.userData; if (u.life > 0) continue;
    s.visible = true; s.position.set(x, y, z); s.material.color.setHex(col); s.material.opacity = 1;
    u.vx = vx; u.vy = vy; u.vz = vz; u.life = u.max = life; u.base = base; u.drag = drag; u.glitter = glitter; u.ph = Math.random() * 6.283;
    s.scale.set(base, base, 1); return true;
  }
  return false;
}
function fireworkBurst(x, y, z, col) {
  const N = 58 + (Math.random() * 26 | 0);
  for (let i = 0; i < N; i++) {                       // peony: uniform sphere, drag-decelerated
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), sp = 9 + Math.random() * 10;
    spawnSpark(x, y, z, Math.sin(ph) * Math.cos(th) * sp, Math.cos(ph) * sp, Math.sin(ph) * Math.sin(th) * sp,
      1.1 + Math.random() * 1.0, 0.7 + Math.random() * 0.7, col, 0.28 + Math.random() * 0.12, false);
  }
  for (let i = 0; i < 20; i++) {                      // glitter twinkles that linger
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), sp = 4 + Math.random() * 8;
    spawnSpark(x, y, z, Math.sin(ph) * Math.cos(th) * sp, Math.cos(ph) * sp, Math.sin(ph) * Math.sin(th) * sp,
      1.5 + Math.random() * 1.1, 0.45 + Math.random() * 0.4, 0xfff4d0, 0.5, true);
  }
  const L = fwLights[fwLightI++ % fwLights.length];
  L.color.setHex(col); L.position.set(x, y, z); L.intensity = 10; L.userData.f = 1; // visible toggled as a group (setCelebLights)
}
function launchShell(x, z) {
  fwShells.push({ x, y: 1.5, z, vy: 27 + Math.random() * 9, fuse: 0.9 + Math.random() * 0.5, trail: 0, col: FW_COLORS[(Math.random() * FW_COLORS.length) | 0] });
}
const SPOT_MAX = 20; // dramatic white field spotlights (light show / party)
function applyArenaDim(dim) {           // dim the night lighting for the light show (0..1)
  const k = 1 - dim * 0.97;            // full dim crushes the arena to ~3% — nearly black, not pure 0
  hemi.intensity = TUNE.lightAmbient * k; sun.intensity = TUNE.lightKey * k; rim.intensity = TUNE.lightRim * k;
  for (const s of towerSpots) s.intensity = (s.userData.base || 1.6) * TUNE.lightFloods * k; // kill the floodlights too, else the field stays lit
}
// Apply the debug lighting knobs to the scene (the un-dimmed baseline). Called at
// boot and whenever a lighting slider changes.
// Set player-skin self-illumination so the bodies catch the scene lights (the GLB
// ships them fully self-lit). Skips the rare blue-tint fallback (no def model).
function applyPlayerGlow() {
  for (const ch of game.all) {
    if (!ch.model || (ch.team === 'def' && !defTemplate)) continue;
    ch.model.traverse((o) => { if (o.isMesh && o.material) { o.material.emissiveIntensity = TUNE.playerGlow; o.material.needsUpdate = true; } });
  }
}
function applyLighting() {
  renderer.toneMappingExposure = TUNE.exposure;
  hemi.intensity = TUNE.lightAmbient; hemi.color.set(TUNE.lightAmbientSky); hemi.groundColor.set(TUNE.lightAmbientGround);
  sun.intensity = TUNE.lightKey; sun.color.set(TUNE.lightKeyColor);
  rim.intensity = TUNE.lightRim; rim.color.set(TUNE.lightRimColor);
  for (const s of towerSpots) { s.intensity = (s.userData.base || 1.6) * TUNE.lightFloods; s.color.set(TUNE.lightFloodColor); }
}
const _tintC = new THREE.Color();
// Material knobs: per-team body tint + skin metal/rough, and a turf color multiply.
function applyLook() {
  for (const ch of game.all) {
    if (!ch.model) continue;
    const tint = ch.team === 'def' ? TUNE.defenseTint : TUNE.offenseTint;
    ch.model.traverse((o) => {
      if (o.isMesh && o.userData.isBody && o.material) {
        o.material.color.set(tint); o.material.roughness = TUNE.skinRough; o.material.metalness = TUNE.skinMetal; o.material.needsUpdate = true;
      }
    });
  }
  for (const tm of turfMats) { if (!tm.base) tm.base = tm.mat.color.clone(); tm.mat.color.copy(tm.base).multiply(_tintC.set(TUNE.turfTint)); }
}
function applyFog() {
  if (scene.fog) { scene.fog.color.set(TUNE.fogColor); scene.fog.near = TUNE.fogNear; scene.fog.far = TUNE.fogFar; }
}
function applyAudio() {
  try {
    audio.applyVolumes({
      master: TUNE.masterVolume, music: TUNE.musicVolume,
      sfx: TUNE.sfxVolume, voice: TUNE.voiceVolume, muted: !!TUNE.audioMuted,
    });
  } catch (e) { /* audio not ready */ }
  syncVolUI();
}
// Persist just the audio knobs into the shared tune store (coexists with the
// debug panel's Save — only the volume keys are touched).
function persistAudio() {
  try {
    if (typeof localStorage === 'undefined') return;
    const cur = JSON.parse(localStorage.getItem(TUNE_STORE_KEY) || '{}');
    for (const k of ['masterVolume', 'musicVolume', 'sfxVolume', 'voiceVolume', 'audioMuted']) cur[k] = TUNE[k];
    localStorage.setItem(TUNE_STORE_KEY, JSON.stringify(cur));
  } catch (e) { /* ignore */ }
}
// Player-facing volume controls: master + music/SFX/commentary sliders and a mute
// toggle, in a popover (the 🔊 HUD button) and mirrored on the start menu.
const VOL_CHANNELS = [
  { key: 'masterVolume', label: 'Master' }, { key: 'musicVolume', label: 'Music' },
  { key: 'sfxVolume', label: 'Sound FX' }, { key: 'voiceVolume', label: 'Commentary' },
];
function syncVolUI() {
  const muted = !!TUNE.audioMuted;
  const vb = document.getElementById('vol-btn');
  if (vb) { vb.classList.toggle('muted', muted); vb.textContent = muted ? '🔇' : '🔊'; }
  document.querySelectorAll('.sm-vol').forEach((b) => { b.classList.toggle('muted', muted); b.textContent = muted ? '🔇' : '🔊'; });
  const panel = document.getElementById('volpanel');
  if (panel && !panel.classList.contains('hidden')) {
    panel.querySelectorAll('input[type=range]').forEach((s) => {
      const v = TUNE[s.dataset.key]; s.value = String(v);
      const out = panel.querySelector(`.vp-val[data-key="${s.dataset.key}"]`); if (out) out.textContent = Math.round(v * 100) + '%';
    });
    const mb = panel.querySelector('.vp-mute'); if (mb) mb.classList.toggle('on', muted);
  }
}
function buildVolPanel() {
  const panel = document.getElementById('volpanel'); if (!panel || panel.dataset.built) return;
  panel.dataset.built = '1';
  const rows = VOL_CHANNELS.map(({ key, label }) =>
    `<div class="vp-row"><label>${label}<span class="vp-val" data-key="${key}">${Math.round(TUNE[key] * 100)}%</span></label>
     <input type="range" min="0" max="1" step="0.05" value="${TUNE[key]}" data-key="${key}" aria-label="${label} volume"></div>`).join('');
  panel.innerHTML = `<div class="vp-head"><span>Audio</span><button class="vp-mute" type="button">Mute</button></div>${rows}`;
  panel.addEventListener('input', (e) => {
    const s = e.target; if (!s.dataset || !s.dataset.key) return;
    audio.unlock(); // a slider drag is a gesture — make sure sound is live
    TUNE[s.dataset.key] = +s.value;
    applyAudio(); persistAudio();
  });
  panel.querySelector('.vp-mute').addEventListener('click', () => { audio.unlock(); toggleMute(); });
}
function toggleMute() { TUNE.audioMuted = TUNE.audioMuted ? 0 : 1; applyAudio(); persistAudio(); }
function toggleVolPanel(force) {
  buildVolPanel();
  const panel = document.getElementById('volpanel'); if (!panel) return;
  const show = force !== undefined ? force : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  if (show) { audio.unlock(); syncVolUI(); }
}
function setupVolumeUI() {
  const vb = document.getElementById('vol-btn');
  if (vb) vb.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleVolPanel(); });
  // Tap-away / Escape closes the popover.
  document.addEventListener('pointerdown', (e) => {
    const panel = document.getElementById('volpanel');
    if (!panel || panel.classList.contains('hidden')) return;
    if (panel.contains(e.target) || (vb && vb.contains(e.target))) return;
    toggleVolPanel(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleVolPanel(false); });
  syncVolUI();
}
function updateCelebFx(dt) {
  const t = performance.now() * 0.001;
  // spark physics (gravity + air drag + fade; glitter twinkles)
  for (const s of fwSparks) {
    const u = s.userData; if (u.life <= 0) continue;
    u.life -= dt;
    if (u.life <= 0) { s.visible = false; s.material.opacity = 0; continue; }
    u.vy -= 7 * dt;
    const dr = Math.pow(u.drag, dt); u.vx *= dr; u.vy *= dr; u.vz *= dr;
    s.position.x += u.vx * dt; s.position.y += u.vy * dt; s.position.z += u.vz * dt;
    const f = u.life / u.max;
    s.material.opacity = u.glitter ? f * (0.2 + 0.8 * Math.max(0, Math.sin(t * 46 + u.ph))) : f;
    const sc = u.base * (0.35 + f * 0.85); s.scale.set(sc, sc, sc);
  }
  for (const L of fwLights) { if (L.userData.f > 0) { L.userData.f -= dt * 2.4; L.intensity = Math.max(0, L.userData.f) * 10; } else L.intensity = 0; } // pulse intensity, never toggle visibility (constant light count)

  if (celebFx.mode === 'fireworks') {
    celebFx.t += dt;
    stepShells(dt);
    celebFx.next -= dt;
    if (celebFx.next <= 0 && celebFx.t < 3.2) {
      celebFx.next = 0.3 + Math.random() * 0.4;
      launchShell((Math.random() - 0.5) * 70, celebFx.z * 0.35 + (Math.random() - 0.5) * 50);
      if (Math.random() < 0.5) launchShell((Math.random() - 0.5) * 70, celebFx.z * 0.35 + (Math.random() - 0.5) * 50);
    }
    if (celebFx.t > 4.0 && fwShells.length === 0) celebFx.mode = null;
  } else if (celebFx.mode === 'party') {
    // End-of-game dance party: a partial dim (dancers stay lit), a rainbow strobe,
    // color-cycling sweep spotlights, and a steady drizzle of fireworks. Runs
    // until stopCelebParty() flips the mode off (REMATCH).
    celebFx.t += dt;
    celebFx.dim = Math.min(0.85, celebFx.dim + dt * 1.5); applyArenaDim(celebFx.dim); // near-black arena
    const hue = (t * 0.5) % 1;
    strobe.color.setHSL(hue, 1, 0.5);
    strobe.intensity = (Math.sin(t * 26) > 0 ? 1.9 : 0.25);
    for (let i = 0; i < sweepLights.length; i++) {
      const L = sweepLights[i];
      L.intensity = Math.min(L.intensity + dt * 16, SPOT_MAX);
      if (i === 0) { // KEY light pinned on the dance circle so the dancers stay lit in the dark
        L.color.setHex(0xffffff);
        L.target.position.set(0, 0, celebFx.z); L.target.updateMatrixWorld();
      } else {       // the rest sweep the field in color
        L.color.setHSL((hue + i / sweepLights.length) % 1, 1, 0.6);
        const a = celebFx.t * 2.4 + i * 2.1;
        L.target.position.set(Math.cos(a) * 18, 0, celebFx.z * 0.3 + Math.sin(a) * 18); L.target.updateMatrixWorld();
      }
    }
    stepShells(dt);
    celebFx.next -= dt;
    if (celebFx.next <= 0) {
      // Grand finale: a near-constant barrage across the sky; otherwise a steady drizzle.
      celebFx.next = celebFx.grand ? 0.22 + Math.random() * 0.22 : 0.55 + Math.random() * 0.5;
      const n = celebFx.grand ? 2 + (Math.random() * 2 | 0) : 1;
      for (let k = 0; k < n; k++) launchShell((Math.random() - 0.5) * 84, celebFx.z * 0.2 + (Math.random() - 0.5) * 64);
    }
  } else if (celebFx.mode === 'lightshow') {
    celebFx.t += dt;
    celebFx.dim = Math.min(1, celebFx.dim + dt * 2.5); applyArenaDim(celebFx.dim);
    strobe.intensity = (Math.sin(t * 52) > 0 ? 2.4 : 0) * celebFx.dim; // red strobe (visibility managed by setCelebLights)
    for (let i = 0; i < sweepLights.length; i++) {
      const L = sweepLights[i]; L.intensity = Math.min(L.intensity + dt * 16, SPOT_MAX);
      const a = celebFx.t * 2.0 + i * 2.1;
      L.target.position.set(Math.cos(a) * 20, 0, celebFx.z * 0.3 + Math.sin(a) * 20); L.target.updateMatrixWorld();
    }
    if (celebFx.t > 3.6) celebFx.mode = null;
  } else {
    // restore: ease the arena back up and fade the strobe + spotlights out
    if (celebFx.dim > 0) { celebFx.dim = Math.max(0, celebFx.dim - dt * 1.8); applyArenaDim(celebFx.dim); }
    strobe.intensity = celebFx.dim > 0 ? (Math.sin(t * 52) > 0 ? 2.4 : 0) * celebFx.dim : 0;
    for (const L of sweepLights) L.intensity = Math.max(0, L.intensity - dt * 6);
    // Celebration fully over → drop ALL celeb lights together (back to the
    // gameplay light count — that program is already compiled, so no stall).
    if (celebFx.lightsOn && celebFx.dim <= 0 && fwShells.length === 0) {
      let lit = false;
      for (const L of sweepLights) if (L.intensity > 0.01) lit = true;
      for (const L of fwLights) if (L.userData.f > 0) lit = true;
      if (!lit) setCelebLights(false);
    }
  }
}
function startFireworksCeleb(z, scorer) {
  celebFx.mode = 'fireworks'; celebFx.t = 0; celebFx.next = 0; celebFx.z = Number.isFinite(z) ? z : 0;
  setCelebLights(true); // all celeb lights on as a group (constant light count)
  if (scorer) startSpecialCam('fireworks', scorer, 4.0);
  audio.cheer(0.6);
}
function startLightShow(z) {
  celebFx.mode = 'lightshow'; celebFx.t = 0; celebFx.z = Number.isFinite(z) ? z : 0;
  setCelebLights(true);
  for (const L of sweepLights) { L.color.setHex(0xffffff); L.intensity = 0; } // white field spotlights
  audio.cheer(0.6);
}
// Rising shells trail then burst — shared by the fireworks celeb and the party.
function stepShells(dt) {
  for (let i = fwShells.length - 1; i >= 0; i--) {
    const sh = fwShells[i]; sh.y += sh.vy * dt; sh.vy -= 13 * dt; sh.fuse -= dt; sh.trail -= dt;
    if (sh.trail <= 0) { sh.trail = 0.02; spawnSpark(sh.x + (Math.random() - 0.5) * 0.3, sh.y, sh.z + (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 1.5, -1 - Math.random() * 2, (Math.random() - 0.5) * 1.5, 0.3 + Math.random() * 0.2, 0.35 + Math.random() * 0.25, 0xffd9a0, 0.6, false); }
    if (sh.fuse <= 0 || sh.vy < 2) { fireworkBurst(sh.x, sh.y, sh.z, sh.col); fwShells.splice(i, 1); }
  }
}
function startCelebParty(z, grand = false) {
  celebFx.mode = 'party'; celebFx.t = 0; celebFx.next = 0; celebFx.z = Number.isFinite(z) ? z : 0;
  celebFx.grand = grand; // grand = end-of-game barrage (way more fireworks)
  setCelebLights(true);
  for (const L of sweepLights) L.intensity = 0;
  audio.cheer(1);
}
function stopCelebParty() {
  if (celebFx.mode === 'party') { celebFx.mode = null; celebFx.grand = false; } // restore branch eases the arena back up + fades the lights
}
function makeBall() {
  // The ball lives in a GROUP whose local +Z is the long axis; the flight code
  // noses that axis along the arc and spins about it (the spiral).
  const group = new THREE.Group();
  ball.mats = [];
  if (footballTemplate) {
    const model = footballTemplate.clone(true);
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; o.material = o.material.clone(); ball.mats.push(o.material); } });
    model.rotation.y = -Math.PI / 2;       // model's long axis (local +X) -> group +Z
    model.scale.setScalar(0.6 / 1.894);    // ~0.6 yd long
    group.add(model);
  } else {
    // Fallback: a stretched ellipsoid (long axis = local +Z).
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0x7a3b16, roughness: 0.7, metalness: 0.05 }));
    m.scale.z = 1.8; m.castShadow = true; ball.mats.push(m.material);
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.225, 0.022, 8, 20),
      new THREE.MeshStandardMaterial({ color: 0xf2ead6, roughness: 0.6 }));
    stripe.rotation.y = Math.PI / 2; stripe.position.z = 0.16; m.add(stripe);
    const lace = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.26),
      new THREE.MeshStandardMaterial({ color: 0xf2ead6, roughness: 0.6 }));
    lace.position.set(0, 0.2, 0); m.add(lace);
    group.add(m);
  }
  scene.add(group); ball.mesh = group;
  const flame = new THREE.PointLight(0xff6622, 0, 7); // lit while ON FIRE
  group.add(flame); ball.flame = flame;
  // Glowing comet trail: a pool of additive sprites laid along recent positions.
  const tex = makeGlowTexture();
  for (let i = 0; i < 16; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: 0xffd27a, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0 }));
    s.visible = false; scene.add(s); ball.trail.push(s);
    ball.trailHist.push(new THREE.Vector3()); // pre-allocated ring slot (no per-frame clone)
  }
}
function updateTrail(airborne) {
  const N = ball.trail.length;
  if (!airborne) {
    if (ball.trailCount) { ball.trailCount = 0; for (const s of ball.trail) s.visible = false; }
    return;
  }
  ball.trailHead = (ball.trailHead + 1) % N;        // advance the ring head
  ball.trailHist[ball.trailHead].copy(ball.mesh.position); // write in place
  if (ball.trailCount < N) ball.trailCount++;
  const col = game.onFire ? 0xff5522 : 0xffd27a;
  for (let i = 0; i < N; i++) {
    const s = ball.trail[i];
    if (i >= ball.trailCount) { s.visible = false; continue; }
    const h = ball.trailHist[(ball.trailHead - i + N) % N]; // i=0 is newest (near the ball)
    s.visible = true; s.position.copy(h);
    const f = 1 - i / N; // brightest/biggest near the ball
    s.material.opacity = f * 0.6;
    s.material.color.setHex(col);
    const sc = 0.45 + f * 0.85;
    s.scale.set(sc, sc, sc);
  }
}
function setBallEmissive(hex, intensity) {
  for (const m of ball.mats) { if (m.emissive) { m.emissive.setHex(hex); m.emissiveIntensity = intensity; m.needsUpdate = true; } }
}
function setFireVisual(on) {
  ball.flame.intensity = on ? 3 : 0;
  setBallEmissive(on ? 0xff5500 : 0x000000, on ? 0.9 : 0);
}
function douseFire() {
  game.fireCount = 0;
  if (game.onFire) { game.onFire = false; setFireVisual(false); setStatus('Fire extinguished'); }
}

const clampX = (x) => THREE.MathUtils.clamp(x, -HALF_W + 1.5, HALF_W - 1.5);

// NFL-Blitz-style 7-on-7 personnel. Roster slot i gets this position.
// Offense: QB, 2 OL, 3 WR, RB. The eligible pass-catchers (game.receivers, in
// `elig` order) are the 3 WR + RB. Defense: 2 DL, 1 LB, 3 CB, 1 S.
const OFF_FORM = [
  { role: 'QB', x: 0,    dz: -6,   job: 'qb',    elig: -1 },
  { role: 'OL', x: -2.4, dz: -1,   job: 'block', elig: -1 },
  { role: 'OL', x: 2.4,  dz: -1,   job: 'block', elig: -1 },
  { role: 'WR', x: -22,  dz: -0.5, job: 'route', elig: 0 },
  { role: 'WR', x: -11,  dz: -0.5, job: 'route', elig: 1 },  // slot
  { role: 'WR', x: 22,   dz: -0.5, job: 'route', elig: 2 },
  { role: 'RB', x: -3.5, dz: -4,   job: 'route', elig: 3 },
];
const DEF_FORM = [
  { role: 'DL', x: -2.4, dz: 1.5,  job: 'rush',  covers: -1, deep: false },
  { role: 'DL', x: 2.4,  dz: 1.5,  job: 'rush',  covers: -1, deep: false },
  { role: 'LB', x: 0,    dz: 5,    job: 'cover', covers: 3,  deep: false },  // spies the RB
  { role: 'CB', x: -21,  dz: 4,    job: 'cover', covers: 0,  deep: false },
  { role: 'CB', x: -11,  dz: 5,    job: 'cover', covers: 1,  deep: false },
  { role: 'CB', x: 21,   dz: 4,    job: 'cover', covers: 2,  deep: false },
  { role: 'S',  x: 0,    dz: 16,   job: 'zone',  covers: -1, deep: true },
];

// Playbook: four concepts. route(e, sx, los) maps an eligible (e: 0/1/2 = WR
// L/slot/R, 3 = RB) and its start X to world waypoints off the scrimmage line.
const PLAYS = [
  {
    name: 'BOMBS', sub: 'Shots + RB check', type: 'pass', concept: 'Shots', beats: ['blitz'], losesTo: ['zone'],
    route(e, sx, los) {
      const toMid = Math.sign(-sx) || 1, P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + game.dir * dz);
      if (e === 3) return [P(sx - 8, 1), P(sx - 13, 3)];          // RB swing/check
      if (e === 1) return [P(sx, 14), P(sx + toMid * 12, 34)];    // slot post
      return [P(sx, 16), P(sx, 42)];                              // outside go
    },
  },
  {
    name: 'SLANTS', sub: 'Quick slants + flat', type: 'pass', concept: 'Quick', beats: ['blitz'], losesTo: ['man'],
    route(e, sx, los) {
      const toMid = Math.sign(-sx) || 1, P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + game.dir * dz);
      if (e === 3) return [P(sx - 6, 0.5), P(sx - 14, 3)];        // RB flat
      return [P(sx + toMid * 6, 8), P(sx + toMid * 13, 15)];      // slants
    },
  },
  {
    name: 'MESH', sub: 'Crossers + swing', type: 'pass', concept: 'Mesh', beats: ['man'], losesTo: ['zone'],
    route(e, sx, los) {
      const toMid = Math.sign(-sx) || 1, P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + game.dir * dz);
      if (e === 3) return [P(sx - 8, 1), P(sx - 14, 4)];          // RB swing
      if (e === 1) return [P(sx, 12), P(sx, 9)];                  // slot sit/drag
      return [P(sx, 6), P(sx + toMid * 22, 11)];                  // crossers
    },
  },
  {
    name: 'FLOOD', sub: 'Sidelines + flat', type: 'pass', concept: 'Flood', beats: ['zone'], losesTo: ['man'],
    route(e, sx, los) {
      const toSide = Math.sign(sx) || 1, toMid = Math.sign(-sx) || 1, P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + game.dir * dz);
      if (e === 3) return [P(sx - 6, 0.5), P(sx - 13, 3)];        // RB flat
      if (e === 0) return [P(sx, 14), P(sx + toSide * 8, 28)];    // corner
      if (e === 2) return [P(sx, 11), P(sx, 8)];                  // comeback
      return [P(sx + toMid * 4, 10), P(sx, 8)];                   // slot out/sit
    },
  },
  {
    name: 'DIVE', sub: 'HB up the gut', run: true, type: 'run', concept: 'Inside', beats: ['spy'], losesTo: ['blitz'],
    route(e, sx, los) {
      const P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + game.dir * dz);
      if (e === 3) return [P(sx + 4, 2), P(1, 9), P(0, 22)];      // RB cuts inside, upfield
      return [P(sx, 4)];                                          // WRs stalk-block
    },
  },
  {
    name: 'SWEEP', sub: 'HB bounce outside', run: true, type: 'run', concept: 'Outside', beats: ['blitz'], losesTo: ['spy'],
    route(e, sx, los) {
      const P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + game.dir * dz);
      if (e === 3) return [P(sx - 7, 1), P(-19, 7), P(-21, 24)];  // RB bounces wide then up
      return [P(sx, 5)];                                          // WRs stalk-block
    },
  },
];

// Render a play's actual routes as a little SVG diagram for the call screen.
// Uses the same route functions (at los=0, dir=1) so the art always matches.
function makePlayArtSVG(play) {
  const W = 100, H = 70, padX = 8, losY = H - 16, topY = 6, maxDepth = 40;
  const mapX = (x) => padX + ((x + HALF_W) / (2 * HALF_W)) * (W - 2 * padX);
  const mapY = (z) => losY - (THREE.MathUtils.clamp(z, -7, maxDepth) / maxDepth) * (losY - topY);
  const savedDir = game.dir; game.dir = 1; // diagram is drawn downfield (+Z)
  let art = '';
  for (const f of OFF_FORM) {
    const x0 = mapX(f.x), y0 = mapY(f.dz);
    if (f.role === 'OL') { art += `<rect x="${(x0 - 2.5).toFixed(1)}" y="${(mapY(0) - 2.5).toFixed(1)}" width="5" height="5" rx="1" fill="#9fb0c0"/>`; continue; }
    if (f.role === 'QB') { art += `<circle cx="${x0.toFixed(1)}" cy="${y0.toFixed(1)}" r="2.6" fill="#bfe3ff"/>`; continue; }
    const wpts = play.route(f.elig, f.x, 0);
    let d = `M ${x0.toFixed(1)} ${y0.toFixed(1)}`;
    for (const w of wpts) d += ` L ${mapX(w.x).toFixed(1)} ${mapY(w.z).toFixed(1)}`;
    const col = f.role === 'RB' ? '#7cfca0' : '#ffd54a';
    art += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    art += `<circle cx="${x0.toFixed(1)}" cy="${y0.toFixed(1)}" r="2.3" fill="#fff"/>`;
  }
  game.dir = savedDir;
  const los = `<line x1="${padX}" y1="${losY}" x2="${W - padX}" y2="${losY}" stroke="rgba(255,255,255,0.45)" stroke-width="1.4" stroke-dasharray="3 3"/>`;
  return `<svg class="ps-art" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${los}${art}</svg>`;
}

// --- Player ratings (0-99): speed, strength, stamina, skill, tackle ---------
// Roles get a base profile; each athlete adds a small persistent jitter so
// teammates differ. Ratings drive derived stats (baseSpeed/strength) and feed
// the catch / break-tackle / coverage / accuracy / turbo math.
const RAT_KEYS = ['speed', 'strength', 'stamina', 'skill', 'tackle'];
const RATINGS = {
  QB: [76, 68, 82, 90, 48], WR: [91, 60, 78, 87, 44], RB: [87, 80, 84, 80, 56], OL: [54, 93, 82, 42, 62],
  DL: [64, 91, 82, 46, 86], LB: [82, 84, 84, 60, 90], CB: [91, 62, 80, 82, 78], S: [86, 74, 82, 76, 84],
};
function applyRatings(p) {
  // A player's ratings are his own fixed roster numbers (persistent identity); the
  // old per-role table + random jitter is only a fallback if a roster is missing.
  const base = p.ratings || RATINGS[p.role] || RATINGS.WR;
  const r = {};
  for (let i = 0; i < RAT_KEYS.length; i++) {
    const v = THREE.MathUtils.clamp(base[i] + (p.ratings ? 0 : (p.jitter ? p.jitter[i] : 0)), 1, 99);
    r[RAT_KEYS[i]] = v / 99;     // normalized 0..1
    r[RAT_KEYS[i] + 'R'] = Math.round(v); // displayable 1..99
  }
  p.rt = r;
  p.baseSpeed = 6.6 + r.speed * 2.9;        // 6.6 .. 9.5 yd/s (toned-down global pace; rating spread kept)
  p.strength = 0.62 + r.strength * 0.76;    // 0.62 .. 1.38 (break/tackle power)
}
const ovr = (rr) => Math.round(rr.reduce((a, b) => a + b, 0) / rr.length);
// Per-game box score carried by each player (reset at kickoff / rematch).
const blankStats = () => ({ cmp: 0, att: 0, passYds: 0, passTD: 0, intThrown: 0, rec: 0, recYds: 0, recTD: 0, car: 0, rushYds: 0, rushTD: 0, tkl: 0, sack: 0, intCaught: 0 });
// Persistent rosters: the same names, positions and ratings every game. teamA is
// the HOME red REAPERS (the player), teamB the AWAY blue DEMONS (the CPU). Roster
// order maps to the formation slots: [QB, OL, OL, WR, WR, WR, RB] on offense (and
// DL/DL/LB/CB/CB/CB/S on defense). Ratings are [speed, strength, stamina, skill, tackle].
const TEAMS = {
  home: {
    name: 'REAPERS', abbr: 'RPR', color: '#c81e2a', logo: 'assets/reapers.png',
    players: [
      { name: 'GRIM', pos: 'QB', r: [74, 66, 84, 92, 46] },
      { name: 'BANE', pos: 'OL', r: [52, 95, 82, 40, 64] },
      { name: 'TOMB', pos: 'OL', r: [56, 90, 82, 44, 60] },
      { name: 'SHADE', pos: 'WR', r: [94, 58, 76, 88, 42] },
      { name: 'ASH', pos: 'WR', r: [90, 62, 80, 84, 46] },
      { name: 'RAVEN', pos: 'WR', r: [92, 60, 78, 90, 44] },
      { name: 'CRYPT', pos: 'RB', r: [88, 82, 84, 82, 58] },
    ],
  },
  away: {
    name: 'DEMONS', abbr: 'DMN', color: '#2f6bd6', logo: 'assets/demons.png',
    players: [
      { name: 'HEX', pos: 'QB', r: [72, 70, 82, 88, 50] },
      { name: 'BRUTE', pos: 'OL', r: [50, 96, 82, 38, 66] },
      { name: 'GORE', pos: 'OL', r: [54, 92, 80, 42, 62] },
      { name: 'BLAZE', pos: 'WR', r: [95, 56, 74, 86, 40] },
      { name: 'FANG', pos: 'WR', r: [89, 64, 80, 82, 48] },
      { name: 'VEX', pos: 'WR', r: [91, 60, 78, 88, 46] },
      { name: 'DREAD', pos: 'RB', r: [86, 84, 84, 80, 60] },
    ],
  },
};

// GAUNTLET MODE: face up to three opponents back to back, each tougher than the
// last (rising rosters + difficulty + color). Win to advance; lose and the whole
// run restarts from the first. Each entry overwrites TEAMS.away for its round.
const GAUNTLET_OPPONENTS = [
  { name: 'GHOULS', abbr: 'GHL', color: '#3fae5a', diff: 'rookie', players: [
    { name: 'ROT', pos: 'QB', r: [60, 58, 72, 76, 40] },
    { name: 'MOLD', pos: 'OL', r: [40, 84, 72, 30, 56] },
    { name: 'SLIME', pos: 'OL', r: [44, 80, 70, 32, 52] },
    { name: 'WISP', pos: 'WR', r: [83, 46, 64, 74, 32] },
    { name: 'MURK', pos: 'WR', r: [78, 52, 68, 70, 38] },
    { name: 'GLOOM', pos: 'WR', r: [80, 50, 66, 76, 36] },
    { name: 'LURK', pos: 'RB', r: [76, 72, 74, 68, 50] },
  ] },
  { name: 'DEMONS', abbr: 'DMN', color: '#2f6bd6', diff: 'pro', players: [
    { name: 'HEX', pos: 'QB', r: [72, 70, 82, 88, 50] },
    { name: 'BRUTE', pos: 'OL', r: [50, 96, 82, 38, 66] },
    { name: 'GORE', pos: 'OL', r: [54, 92, 80, 42, 62] },
    { name: 'BLAZE', pos: 'WR', r: [95, 56, 74, 86, 40] },
    { name: 'FANG', pos: 'WR', r: [89, 64, 80, 82, 48] },
    { name: 'VEX', pos: 'WR', r: [91, 60, 78, 88, 46] },
    { name: 'DREAD', pos: 'RB', r: [86, 84, 84, 80, 60] },
  ] },
  { name: 'TITANS', abbr: 'TTN', color: '#d6a82f', diff: 'allpro', players: [
    { name: 'COLOSSUS', pos: 'QB', r: [80, 78, 88, 95, 58] },
    { name: 'ATLAS', pos: 'OL', r: [58, 99, 90, 46, 74] },
    { name: 'TITAN', pos: 'OL', r: [62, 99, 88, 50, 70] },
    { name: 'BOLT', pos: 'WR', r: [99, 64, 82, 94, 48] },
    { name: 'QUAKE', pos: 'WR', r: [96, 72, 88, 90, 56] },
    { name: 'STORM', pos: 'WR', r: [98, 68, 86, 96, 54] },
    { name: 'GOLIATH', pos: 'RB', r: [94, 92, 92, 88, 68] },
  ] },
];

// whichever team has the ball, so the same AI drives either side.
function spawnTeams() {
  game.teamA = []; game.teamB = [];
  const home = TEAMS.home.players, away = TEAMS.away.players;
  for (let i = 0; i < 7; i++) {
    const a = makeCharacter('off'); const b = makeCharacter('def');
    a.surname = home[i].name; a.ratings = home[i].r; a.pos = home[i].pos; a.stats = blankStats(); a.cpu = false;
    b.surname = away[i].name; b.ratings = away[i].r; b.pos = away[i].pos; b.stats = blankStats(); b.cpu = true; // Demons are always the CPU
    a.nameTag = makeNameTag(a.surname); a.group.add(a.nameTag);
    b.nameTag = makeNameTag(b.surname); b.group.add(b.nameTag);
    game.teamA.push(a); game.teamB.push(b);
  }
  game.all = [...game.teamA, ...game.teamB];
  setupPossession();
}
// Team benches: an NFL-style team area per sideline (home = -X, away = +X), using
// the SAME models as the on-field players. 10 per side: 8 standing in two rows,
// watching the game / turning to talk to a teammate (+ erupting on big plays), and
// 2 pacing behind them. They're NOT in game.all (no play logic touches them), and
// they sit OUTSIDE the cage (front row past the ball's max reach ~28.65).
const BENCH_N = 10, BENCH_STAND = 8;        // per team: 8 standing, 2 pacing
const BENCH_FRONT_X = 28.8, BENCH_ROW_DX = 2.0, BENCH_PACE_X = 32.6; // apron lanes (×side)
const BENCH_Z0 = -16, BENCH_DZ = 4.5;       // standing cluster: 4 z-slots, two staggered rows
const BENCH_PACE_LO = -20, BENCH_PACE_HI = 2;
function spawnBench() {
  game.benchA = []; game.benchB = []; game.bench = [];
  for (let i = 0; i < BENCH_N; i++) {
    const a = makeCharacter('off'); setupBench(a, -1, i); game.benchA.push(a); // home team: -X sideline
    const b = makeCharacter('def'); setupBench(b, 1, i);  game.benchB.push(b); // away team: +X sideline
  }
  game.bench = [...game.benchA, ...game.benchB];
}
function setupBench(ch, side, i) {
  ch.isBench = true; ch.side = side;
  ch.faceField = side > 0 ? -Math.PI / 2 : Math.PI / 2; // inward toward the field
  ch.heading = ch.faceField;
  ch.emoteCd = 4 + Math.random() * 9;
  if (i < BENCH_STAND) {                                 // standing in the team area (two rows of 4)
    ch.benchRole = 'stand';
    const row = i < 4 ? 0 : 1, k = i - row * 4;
    ch.homeX = (BENCH_FRONT_X + row * BENCH_ROW_DX) * side;
    ch.homeZ = BENCH_Z0 + k * BENCH_DZ + (row ? BENCH_DZ / 2 : 0); // back row staggered
    ch.group.position.set(ch.homeX, 0, ch.homeZ);
    ch.chatCd = 2 + Math.random() * 6; ch.chatT = 0; ch.chatHeading = ch.faceField;
  } else {                                               // pacing behind the standing rows
    ch.benchRole = 'pace';
    ch.paceLane = BENCH_PACE_X * side;
    ch.group.position.set(ch.paceLane, 0, THREE.MathUtils.lerp(BENCH_PACE_LO, BENCH_PACE_HI, Math.random()));
    ch.benchTarget = ch.group.position.z; ch.benchWait = Math.random() * 3;
  }
  ch.group.rotation.set(0, ch.heading, 0);
}
function updateBench(dt) {
  if (!game.bench) return;
  for (const ch of game.bench) {
    if (ch.oneShotT > 0) { ch.oneShotT -= dt; ch.group.rotation.y = ch.heading; stepMixer(ch, dt); ch.group.position.y = 0; continue; }
    ch.emoteCd -= dt;
    if (ch.benchRole === 'pace') {                       // walk the sideline behind the bench
      const p = ch.group.position; let moving = false;
      if (ch.benchWait > 0) { ch.benchWait -= dt; ch.heading = ch.faceField; }
      else {
        const dz = ch.benchTarget - p.z;
        if (Math.abs(dz) > 0.5) {
          p.z += Math.sign(dz) * Math.min(Math.abs(dz), 2.4 * dt);
          p.x += (ch.paceLane - p.x) * Math.min(1, dt * 2);
          ch.heading = dz > 0 ? 0 : Math.PI; moving = true;
        } else {
          ch.heading = ch.faceField; ch.benchWait = 1.5 + Math.random() * 3;
          ch.benchTarget = THREE.MathUtils.clamp(p.z + (Math.random() - 0.5) * 30, BENCH_PACE_LO, BENCH_PACE_HI);
        }
      }
      setClip(ch, moving ? 'walk' : 'idle');
    } else {                                             // standing: watch the game, turn to chat
      ch.chatCd -= dt;
      if (ch.chatT > 0) { ch.chatT -= dt; ch.heading = ch.chatHeading; }
      else {
        ch.heading = ch.faceField;
        if (ch.chatCd <= 0) { // turn toward a neighbor up/down the line for a beat (talking)
          ch.chatT = 1.5 + Math.random() * 2.5; ch.chatCd = 5 + Math.random() * 8;
          ch.chatHeading = ch.faceField + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.45);
        }
      }
      setClip(ch, 'idle');
    }
    if (ch.emoteCd <= 0 && ch.actions.celebrate) {       // ambient react to the game
      playOneShot(ch, 'celebrate', 1.5 + Math.random(), true);
      ch.emoteCd = 9 + Math.random() * 11;
    }
    ch.group.rotation.y = ch.heading; stepMixer(ch, dt); ch.group.position.y = 0;
  }
}
// Both benches erupt (e.g. on a touchdown).
function benchReact() {
  if (!game.bench) return;
  for (const ch of game.bench) if (ch.actions.celebrate && Math.random() < 0.85) {
    playOneShot(ch, 'celebrate', 2 + Math.random(), true); ch.emoteCd = 6 + Math.random() * 6;
  }
}
// The cheerleaders: a pregame cinematic chorus line at midfield (walk on -> DANCE
// the model's pop/boom dances -> walk off), then for the rest of the game they post
// up on the sideline apron in two staggered lines and keep dancing/cheering. Pure
// cosmetics (NOT in game.all), beyond the cage fence so players/ball never reach
// them. Spawned HIDDEN; shown by the cinematic, then by placeCheerSideline.
const CHEER_N = 8;
const CHEER_ENTER_Z = 11;   // they start downfield and walk toward camera into the line at z=0
const CHEER_T_DANCE = 4;    // walked in + dancing by ~4s
const CHEER_T_EXIT = 19;    // start walking off at ~19s (cinematic is 25s)
const CHEER_WALK_SPD = 3.1, CHEER_EXIT_SPD = 5.0;
// Gameplay home: their OWN section on the HOME (-X) sideline apron, toward +Z (clear
// of the home bench team area at z<0), two staggered lines, OUTSIDE the cage (HALF_W ~
// 26.65; ball overshoots to ~CAGE_X+2 = 28.65) so nothing can touch them.
const CHEER_SIDE = -1; // -1 = home (-X) sideline, +1 = away (+X)
const CHEER_SIDE_X = 30, CHEER_ROW_GAP = 1.7, CHEER_Z_SPACING = 2.6, CHEER_SECTION_Z = 24;
function cheerAction(mixer, clip) { const a = mixer.clipAction(clip); a.setLoop(THREE.LoopRepeat, Infinity); a.enabled = true; a.setEffectiveWeight(0); a.play(); return a; }
function setCheerClip(ch, name) {
  if (ch.cur === name || !ch.acts[name]) return;
  const nx = ch.acts[name]; nx.reset(); nx.setEffectiveWeight(1);
  nx.crossFadeFrom(ch.acts[ch.cur], 0.3, false); nx.play(); ch.cur = name;
}
// The model ships fully self-lit; dim its emissive for the dark spotlit cinematic,
// restore it for the normally-lit gameplay sideline.
function setCheerEmissive(v) {
  if (!game.cheer) return;
  for (const ch of game.cheer) ch.model.traverse((o) => { if (o.isMesh && o.material) o.material.emissiveIntensity = v; });
}
function spawnCheer() {
  game.cheer = [];
  if (!cheerTemplate || !cheerClips || !cheerClips.walk || !cheerClips.dances.length) return; // no model -> no cast
  const span = 22, perRow = Math.ceil(CHEER_N / 2); // midfield line width; squad split into two rows
  for (let i = 0; i < CHEER_N; i++) {
    const model = cloneSkeleton(cheerTemplate);
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    model.scale.multiplyScalar(cheerScale);
    model.position.y = cheerGroundY;
    const group = new THREE.Group(); group.add(model); scene.add(group);
    const x = CHEER_N > 1 ? (i - (CHEER_N - 1) / 2) * (span / (CHEER_N - 1)) : 0;
    group.position.set(x, 0, CHEER_ENTER_Z); // start downfield, walk in toward the line
    group.rotation.y = Math.PI;              // face the home sideline / camera
    group.visible = false;                   // shown only during the cinematic / on the sideline
    const mixer = new THREE.AnimationMixer(model);
    const acts = { walk: cheerAction(mixer, cheerClips.walk), dance: cheerAction(mixer, cheerClips.dances[(Math.random() * cheerClips.dances.length) | 0]) };
    acts.walk.setEffectiveWeight(1);
    mixer.update(Math.random() * 1.5); // desync so the line isn't in lockstep
    // Sideline post: two staggered rows on the HOME (-X) apron, facing the field.
    const row = i < perRow ? 0 : 1, j = i - row * perRow, rowCount = row === 0 ? perRow : (CHEER_N - perRow);
    const sideX = (CHEER_SIDE_X + row * CHEER_ROW_GAP) * CHEER_SIDE;
    const sideZ = CHEER_SECTION_Z + (j - (rowCount - 1) / 2) * CHEER_Z_SPACING + (row ? CHEER_Z_SPACING / 2 : 0);
    game.cheer.push({ group, model, mixer, acts, cur: 'walk', isCheer: true, heading: Math.PI, side: x >= 0 ? 1 : -1, phase: 'enter', sideX, sideZ, sideHeading: CHEER_SIDE > 0 ? -Math.PI / 2 : Math.PI / 2 });
  }
}
// Send the squad to its sideline posts (two staggered lines) and keep them dancing
// for the rest of the game (called when the cinematic ends).
function placeCheerSideline() {
  if (!game.cheer) return;
  setCheerEmissive(1.3); // self-lit (a touch hot) so they read on the dim sideline apron
  for (const ch of game.cheer) {
    ch.phase = 'sideline'; ch.heading = ch.sideHeading;
    ch.group.position.set(ch.sideX, 0, ch.sideZ); ch.group.rotation.y = ch.heading;
    ch.group.visible = true; setCheerClip(ch, 'dance');
  }
}
// Cinematic clock drives the pregame choreography (walk in -> dance -> walk off);
// on the sideline ('sideline' phase) they simply dance/cheer in place.
function updateCheer(dt) {
  if (!game.cheer) return;
  const t = game.cinematic ? game.cinematic.t : 1e9;
  for (const ch of game.cheer) {
    const p = ch.group.position;
    if (ch.phase === 'sideline') {
      setCheerClip(ch, 'dance');                          // dance + cheer through the game
    } else {
      if (ch.phase === 'enter') {                          // walk forward to the line (z=0)
        const dz = 0 - p.z;
        if (t >= CHEER_T_DANCE || Math.abs(dz) < 0.15) { p.z = 0; ch.phase = 'dance'; }
        else { p.z += Math.sign(dz) * Math.min(Math.abs(dz), CHEER_WALK_SPD * dt); }
        ch.heading = Math.PI; setCheerClip(ch, 'walk');
      } else if (ch.phase === 'dance') {                   // hold the line and dance
        if (t >= CHEER_T_EXIT) ch.phase = 'exit';
        else { ch.heading = Math.PI; setCheerClip(ch, 'dance'); }
      }
      if (ch.phase === 'exit') {                           // walk off to the nearest sideline
        const tx = ch.side * (HALF_W + 3), dx = tx - p.x;
        if (Math.abs(dx) > 0.2) p.x += Math.sign(dx) * Math.min(Math.abs(dx), CHEER_EXIT_SPD * dt);
        ch.heading = ch.side > 0 ? Math.PI / 2 : -Math.PI / 2; setCheerClip(ch, 'walk');
      }
    }
    ch.group.rotation.y = ch.heading; stepMixer(ch, dt); ch.group.position.y = 0;
  }
}
// Assign offense (ball) / defense (cover) roles based on who has the ball,
// using the Blitz personnel formations. game.receivers = eligibles in `elig`
// order (WR L / slot / R, then RB).
function setupPossession() {
  game.dir = game.userOnOffense ? 1 : -1;
  const ball = game.userOnOffense ? game.teamA : game.teamB;
  const cover = game.userOnOffense ? game.teamB : game.teamA;
  game.offense = ball; game.defense = cover;
  game.qb = ball[0]; game.receivers = [];
  ball.forEach((p, i) => {
    const f = OFF_FORM[i];
    p.role = f.role; p.job = f.job; p.align = f; p.deep = false; p.covers = -1;
    applyRatings(p);
    if (f.elig >= 0) game.receivers[f.elig] = p;
  });
  cover.forEach((p, i) => {
    const f = DEF_FORM[i];
    p.role = f.role; p.job = f.job; p.align = f; p.deep = f.deep; p.covers = f.covers;
    applyRatings(p);
  });
  game.all = [...game.offense, ...game.defense];
}
// Direction-aware field references (the current offense attacks game.dir * +Z).
const atkGoalZ = () => (game.dir > 0 ? GOAL_Z : OWN_GOAL_Z);   // offense's target
const driveStartZ = () => game.dir * DRIVE_START;              // offense's own 20
const toGoYds = () => game.dir * (game.firstDown - game.los);  // yards to the sticks
const reachedGoal = (z) => (game.dir > 0 ? z >= GOAL_Z : z <= OWN_GOAL_Z);

// Set each player's formation spot (home) + facing. teleport=true snaps them
// there now (kickoff); teleport=false leaves them put so they can WALK back.
function placeFormation(teleport = true) {
  const L = game.los, d = game.dir;
  const fwd = d > 0 ? 0 : Math.PI;   // offense faces its attacking end
  game.offense.forEach((p) => {
    const a = p.align; p.home.set(a.x, 0, L + d * a.dz); p.resetHeading = fwd;
    if (teleport) { setPos(p, a.x, L + d * a.dz); p.heading = fwd; }
    p.route = null; p.wp = 0; p.cutTimer = 0;
  });
  game.defense.forEach((p) => {
    const a = p.align; p.home.set(a.x, 0, L + d * a.dz); p.resetHeading = fwd + Math.PI;
    if (teleport) { setPos(p, a.x, L + d * a.dz); p.heading = fwd + Math.PI; }
    p.assignment = null; p.zonePoint = null; p.blockTarget = null;
  });
}
function setPos(ch, x, z) { ch.group.position.set(x, 0, z); ch.vel.set(0, 0, 0); ch.speed = 0; }

// ===========================================================================
// Steering primitives (ported from Football-Game/Steering.ts; x,z plane)
// ===========================================================================
// Turbo burst multiplier is a debug knob (TUNE.turboMult).
// Difficulty: scales the CPU team (teamB) and a little player assist. cpuSpd =
// CPU speed mult; cpuCatch = +/- to CPU catch odds; cpuAcc = CPU throw-error mult
// (>1 = more errant); userBreak = your break-tackle mult.
const DIFF = {
  // cpuRead = how sharply the CPU reads matchups + calls the right look (0..1).
  rookie: { label: 'ROOKIE', cpuSpd: 0.93, cpuCatch: -0.12, cpuAcc: 1.18, userBreak: 1.25, cpuRead: 0.3 },
  pro:    { label: 'PRO',    cpuSpd: 1.00, cpuCatch: 0.00,  cpuAcc: 1.00, userBreak: 1.00, cpuRead: 0.55 },
  allpro: { label: 'ALL-PRO', cpuSpd: 1.06, cpuCatch: 0.10, cpuAcc: 0.85, userBreak: 0.82, cpuRead: 0.85 },
};
// Active difficulty with the debug multipliers/offsets folded in (TUNE.cpu*/userBreak*).
const diff = () => {
  const d = DIFF[game.diff] || DIFF.pro;
  return { cpuSpd: d.cpuSpd * TUNE.cpuSpdMul, cpuCatch: d.cpuCatch + TUNE.cpuCatchAdd, cpuAcc: d.cpuAcc * TUNE.cpuAccMul, userBreak: d.userBreak * TUNE.userBreakMul, cpuRead: d.cpuRead != null ? d.cpuRead : 0.55 };
};
// Fatigue: players tire as they exert, bleeding top speed (and break power) over
// a play so you can't sprint the whole field at full tilt. 1 = fresh, FAT_MIN = gassed.
const FAT_MIN = 0.45;
const fatigueSpeed = (ch) => 0.7 + 0.3 * THREE.MathUtils.clamp((ch.fatigue - FAT_MIN) / (1 - FAT_MIN), 0, 1); // 0.7 (gassed) .. 1.0 (fresh)
// Power falloff with fatigue: a gassed player hits / wraps / sheds / blocks weaker.
const fatiguePow = (ch) => 0.6 + 0.4 * THREE.MathUtils.clamp((ch.fatigue - FAT_MIN) / (1 - FAT_MIN), 0, 1); // 0.6 .. 1.0
// Contact is tiring: tackling, getting hit, wrestling a block all drain the tank
// (floored at FAT_MIN). The more contact + running a player does, the more he wears
// down over the drive (only partly recovered between plays — see preparePlay).
const drainFatigue = (ch, amt) => { if (ch) ch.fatigue = Math.max(FAT_MIN, ch.fatigue - amt * TUNE.fatigueDrain); };
function updateFatigue(ch, dt) {
  const stam = ch.rt ? ch.rt.stamina : 0.7;          // 0..1
  const exert = ch.speed / (ch.baseSpeed || 8);      // fraction of base top speed (turbo pushes >1)
  if (exert > 0.58) {                                // sprinting/turbo drains (quadratically — turbo costs most)
    ch.fatigue = Math.max(FAT_MIN, ch.fatigue - 0.18 * TUNE.fatigueDrain * (1.5 - stam) * exert * exert * dt);
  } else {                                           // jogging / idle recovers (faster with stamina)
    ch.fatigue = Math.min(1, ch.fatigue + (0.1 + stam * 0.12) * dt);
  }
}
const px = (p) => p.group ? p.group.position : p;
function seek(from, tx, tz) {
  const dx = tx - from.x, dz = tz - from.z, d = Math.hypot(dx, dz) || 1;
  return { x: dx / d, z: dz / d };
}
function pursueP(fromPos, target, predict = 0.18) {
  return seek(fromPos, px(target).x + target.vel.x * predict, px(target).z + target.vel.z * predict);
}
// Like seek but EASES IN: full magnitude beyond `slow`, ramping to ~0 at the
// target so the agent settles on its spot instead of overshooting + jittering.
function arrive(from, tx, tz, slow) {
  const dx = tx - from.x, dz = tz - from.z, d = Math.hypot(dx, dz);
  if (d < 1e-3) return { x: 0, z: 0 };
  const m = Math.min(1, d / slow);
  return { x: dx / d * m, z: dz / d * m };
}
function separation(self, others, radius) {
  let sx = 0, sz = 0, n = 0;
  const sp = px(self);
  for (const o of others) {
    if (o === self) continue;
    const op = px(o);
    const dx = sp.x - op.x, dz = sp.z - op.z, d = Math.hypot(dx, dz);
    if (d > 0 && d < radius) { sx += (dx / d) * (1 - d / radius); sz += (dz / d) * (1 - d / radius); n++; }
  }
  return n ? { x: sx, z: sz } : { x: 0, z: 0 };
}
const addSteer = (a, b, w = 1) => ({ x: a.x + b.x * w, z: a.z + b.z * w });
const dist2 = (a, b) => { const dx = a.x - b.x, dz = a.z - b.z; return dx * dx + dz * dz; };
const distXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const pastLine = (p) => game.dir * (px(p).z - game.los) > 1;

// ===========================================================================
// Defense AI (ported from DefenseAI.ts)
// ===========================================================================
function interceptPoint(d, carrier) {
  const dp = px(d), cp = px(carrier);
  if (dist2(dp, cp) < 3 * 3) return { x: cp.x, z: cp.z };  // square up for the hit
  const dSpeed = Math.max(7, d.baseSpeed);
  let t = distXZ(cp, dp) / dSpeed;
  for (let i = 0; i < 3; i++) {
    const fx = cp.x + carrier.vel.x * t, fz = cp.z + carrier.vel.z * t;
    t = Math.hypot(fx - dp.x, fz - dp.z) / dSpeed;
  }
  t = Math.min(t, 0.55);
  const predX = cp.x + carrier.vel.x * t;
  const predZ = cp.z + carrier.vel.z * t;
  const downSpeed = Math.max(0, game.dir * carrier.vel.z); // gaining ground toward the goal
  const lead = game.dir * Math.min(4, downSpeed * 0.45);   // cut-off leverage (goal-side)
  return { x: predX, z: game.dir > 0 ? Math.max(predZ, cp.z + lead) : Math.min(predZ, cp.z + lead) };
}
function nearestOffenseTo(point, maxDist) {
  let best = null, bestD = maxDist * maxDist;
  for (const o of game.offense) {
    if (o.job === 'block' || o.job === 'qb') continue;
    const d = dist2(px(o), point);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}
function nearestBlockerTo(point) {
  let best = null, bestD = Infinity;
  for (const o of game.offense) {
    if (o.ragdolling || (o.role !== 'OL' && o.job !== 'block')) continue; // linemen + anyone blocking
    const d = dist2(px(o), point); if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}
function updateDefense() {
  const carrier = game.carrier;
  const carrierIsRunning = !!carrier && (carrier.role !== 'QB' || pastLine(carrier));
  const inAir = ball.mode === 'flying';
  for (const d of game.defense) {
    d.blocking = false; // set true again by updateBlocks only while actually locked in a block
    if (d.ragdolling || d === game.controlled) continue; // knocked down, or the player drives him
    if (d.oneShotT > 0 && d.current === 'getup') { d.desired = { x: 0, z: 0 }; d.vel.x *= 0.8; d.vel.z *= 0.8; continue; } // getting up — hold until the clip finishes, then pursue
    if (d.blockedBy) { d.desired = { x: 0, z: 0 }; d.engaged = true; d.pursuit = false; continue; } // stuck in a block (updateBlocks holds him)
    d.engaged = false; d.pursuit = false;
    const dp = px(d);
    let steer = { x: 0, z: 0 };
    if (carrierIsRunning && carrier) {
      const ip = interceptPoint(d, carrier);
      steer = seek(dp, ip.x, ip.z);
      d.turbo = dist2(dp, px(carrier)) > 3 * 3; // turbo to run the ball carrier down
      d.pursuit = true;
      // A blocker in his lane screens this pursuer (slows him — opens a lane).
      // Lenient on a run: a blocker near and ahead of him counts as a block.
      const blk = nearestBlockerTo(dp);
      d.engaged = blockerScreens(dp, blk, px(carrier), 2.4, -0.15);
    } else if (d.job === 'rush') {
      // Pass rush: bear down on the QB; an OL right in front walls you off.
      const qp = px(game.qb);
      steer = seek(dp, qp.x, qp.z);
      const blk = nearestBlockerTo(dp);
      d.engaged = blockerScreens(dp, blk, qp, 2.0, 0.25) && !(carrier && carrier === game.qb);
      d.turbo = !d.engaged && dist2(dp, qp) > 9;
    } else if (d.job === 'spy') {
      // Shadow the QB a few yards goal-side to wall off the scramble lane.
      const qp = px(game.qb);
      steer = seek(dp, qp.x, qp.z + game.dir * 4);
      d.turbo = dist2(dp, qp) > 6 * 6;
    } else if (d.job === 'zone' || d.deep) {
      if (inAir) { steer = seek(dp, ball.to.x, ball.to.z); d.turbo = true; }
      else {
        const anchor = d.zonePoint || d.home;
        const threat = nearestOffenseTo(anchor, 9);
        const tp = threat ? px(threat) : anchor;
        // Beaten zone reacts slower to its threat underneath (deep help stays honest).
        const close = d.deep ? 1 : (game.coverClose || 1);
        steer = arrive(dp, tp.x, tp.z, 2.6 * close); // settle on the zone spot / threat instead of jittering
        d.turbo = threat != null && dist2(dp, px(threat)) > 5 * 5 && !((game.coverLev || 0) > 0 && !d.deep);
      }
    } else { // man cover
      if (inAir && (ball.targetRecv === game.receivers[d.covers])) {
        steer = seek(dp, ball.to.x, ball.to.z); d.turbo = true;
      } else if (inAir) {
        const a = game.receivers[d.covers]; steer = pursueP(dp, a, 0.2); d.turbo = true;
      } else {
        // Mirror the receiver with goal-side leverage, EASING into the spot so a
        // matched DB rides smoothly alongside him and settles when he's static —
        // no more full-speed micro-twitch. He only sprints when actually beaten.
        const a = game.receivers[d.covers];
        const ap = px(a);
        // Matchup leverage (Phase 1): a coverage-beating concept gives the WR a
        // step of cushion + a slower-closing DB; a blanketed matchup crowds him.
        const lev = game.coverLev || 0, close = game.coverClose || 1;
        const cushion = Math.max(0.2, 1.3 + lev * 1.5);
        const tx = ap.x + a.vel.x * 0.16;
        const tz = ap.z + a.vel.z * 0.16 + game.dir * cushion; // goal-side cushion
        const gap = distXZ(dp, ap);
        steer = arrive(dp, tx, tz, (gap > 3 ? 1.4 : 2.6) * close); // tighter ramp when trailing, softer when matched/beaten
        const gl = 4.5 + lev * 2; // beaten = less glued (lets the step open up)
        d.turbo = dist2(dp, ap) > gl * gl; // glued unless beaten
      }
    }
    const sep = separation(d, game.defense, 3.0);
    d.desired = addSteer(steer, sep, carrierIsRunning ? 0.18 : 0.5);
    // Coverage drop: face the threat (man = his receiver, otherwise the QB) and
    // hold it, so retreating into the cushion reads as a real DB backpedal. Once
    // the ball's thrown or it's a run, go back to pursuing (face the chase).
    if (!carrierIsRunning && !inAir && d.job !== 'rush') {
      const t = (d.covers >= 0 && game.receivers[d.covers]) ? px(game.receivers[d.covers]) : px(game.qb);
      d.heading = Math.atan2(t.x - dp.x, t.z - dp.z); d.holdHeading = true;
    } else d.holdHeading = false;
  }
}

// ===========================================================================
// Offense AI (ported from OffenseAI.ts)
// ===========================================================================
const ROUTE_REACH = 1.3, SIDE_MARGIN = 4, BACK_MARGIN = 3;
function nearestDefenderTo(point) {
  let best = null, bestD = Infinity;
  for (const d of game.defense) {
    if (d.ragdolling) continue;
    const dd = dist2(px(d), point); if (dd < bestD) { bestD = dd; best = d; }
  }
  return best;
}
function assignBlocks(blockForCarrier) {
  const protect = game.carrier || game.qb;
  const blockers = game.offense.filter((o) => o.job === 'block' || (blockForCarrier && o.job !== 'qb' && o !== game.carrier));
  for (const b of blockers) b.blockTarget = null;
  if (!protect) return;
  const pp = px(protect);
  const threats = game.defense.filter((d) => !d.ragdolling).sort((a, b) => dist2(px(a), pp) - dist2(px(b), pp));
  const taken = new Set();
  for (const threat of threats) {
    let best = null, bestD = Infinity;
    for (const b of blockers) {
      if (taken.has(b)) continue;
      const dd = dist2(px(b), px(threat));
      if (dd < bestD) { bestD = dd; best = b; }
    }
    if (best) { best.blockTarget = threat; taken.add(best); }
    if (taken.size === blockers.length) break;
  }
}
// --- Block engagement: blockers and defenders LOCK UP and wrestle ------------
// When a blocker reaches his man they engage: both are held at the point of
// contact in the shove pose (procedural), neither advancing, until the defender
// SHEDS the block. How long the lock holds is a strength/tackle duel (a stronger
// rusher sheds fast; a good blocker sustains it), plus a small random shed chance
// so it varies. On a shed the defender bursts free toward the ball; the blocker
// gets a brief cooldown before he can re-lock.
const SHED_BURST = 5.5; // block engage radius is TUNE.engageReach
function startEngage(o, d) {
  o.engaging = d; d.blockedBy = o;
  const bp = (0.55 + (o.rt ? o.rt.strength : 0.6)) * fatiguePow(o);   // blocker drive (weaker when gassed)
  const dp = (0.5 + (d.rt ? (d.rt.tackle + d.rt.strength) * 0.5 : 0.6)) * fatiguePow(d); // rusher shed (a tired rusher gets stuck longer)
  d.engageT = THREE.MathUtils.clamp(1.3 * bp / dp, 0.5, 3.2) * (0.7 + Math.random() * 0.7);
}
function endEngage(o, d, shed) {
  if (o) o.engaging = null;
  if (!d) return;
  d.blockedBy = null; d.shedCd = 0.45 + Math.random() * 0.5; d.engaged = false;
  if (shed) { // rip free, burst toward the ball carrier / QB
    const c = game.carrier || game.qb;
    if (c) { const dx = c.group.position.x - d.group.position.x, dz = c.group.position.z - d.group.position.z, l = Math.hypot(dx, dz) || 1; d.vel.x += dx / l * SHED_BURST; d.vel.z += dz / l * SHED_BURST; }
    triggerArmAction(d, 'swat', 0.35); // a rip/swim move as he sheds
    drainFatigue(d, 0.05); // ripping free takes a burst of energy
  }
}
function updateBlocks(dt) {
  for (const d of game.defense) if (d.shedCd > 0) d.shedCd -= dt;
  for (const o of game.offense) {
    if (o.ragdolling || o === game.carrier || o === game.controlled) { if (o.engaging) endEngage(o, o.engaging, false); continue; }
    // Drop a stale lock (target gone/ragdolled).
    if (o.engaging && (o.engaging.ragdolling || o.engaging.blockedBy !== o)) { o.engaging = null; }
    const d = o.engaging || o.blockTarget;
    if (!d || d.ragdolling || d === game.controlled) { if (o.engaging) endEngage(o, o.engaging, false); continue; } // never freeze the human
    if (!o.engaging) { // try to lock on
      if (!d.blockedBy && d.shedCd <= 0 && distXZ(px(o), px(d)) < TUNE.engageReach) startEngage(o, d);
      else continue;
    }
    // Sustain the lock: tick the duel, maybe shed (timer out or a random rip).
    d.engageT -= dt;
    const shedRoll = 0.25 * dt * (0.4 + (d.rt ? d.rt.tackle : 0.6));
    if (d.engageT <= 0 || Math.random() < shedRoll) { endEngage(o, d, true); continue; }
    // Locked: press the two CHEST TO CHEST so their hands/helmets meet (not standing
    // apart with arms in the air), face each other, churn in place (a slow wobble) —
    // both play the shove pose; the rusher is stuck. (Locked pairs are skipped by
    // the body-separation pass, so they're allowed to overlap into real contact.)
    const op = o.group.position, dp = d.group.position;
    let ax = dp.x - op.x, az = dp.z - op.z; let al = Math.hypot(ax, az);
    // Too close to read a reliable facing (a tiny/zero gap) — keep the blocker's
    // current heading as the axis instead of normalizing near-zero noise (which
    // would spin them in a circle). Otherwise normalize the real separation.
    if (al < 0.05) { ax = Math.sin(o.heading); az = Math.cos(o.heading); al = 1; } else { ax /= al; az /= al; }
    const mx = (op.x + dp.x) / 2, mz = (op.z + dp.z) / 2;
    const wob = Math.sin(game.playClock * 8 + o.breathPh) * 0.04;
    const half = Math.max(0.08, TUNE.gapBlock + wob); // half the chest-to-chest gap; floored so it never crosses 0 (flip/spin)
    const px2 = az, pz2 = -ax; // perpendicular, for the defender's lateral offset
    op.x = mx - ax * half; op.z = mz - az * half;
    dp.x = mx + ax * half + px2 * TUNE.latBlock; dp.z = mz + az * half + pz2 * TUNE.latBlock;
    o.heading = Math.atan2(ax, az); d.heading = Math.atan2(-ax, -az);
    o.vel.set(0, 0, 0); d.vel.set(0, 0, 0); o.speed = 0; d.speed = 0;
    o.blocking = true; d.blocking = true; d.engaged = true; d.pursuit = false;
    drainFatigue(o, 0.05 * dt); drainFatigue(d, 0.05 * dt); // wrestling the block tires both
  }
}
function clearEngagements() {
  for (const ch of game.all) { ch.engaging = null; ch.blockedBy = null; ch.engageT = 0; ch.shedCd = 0; ch.blocking = false; }
}
function keepReceiverInbounds(o) {
  const p = px(o);
  const edgeX = Math.min(HALF_W - p.x, p.x + HALF_W);
  if (edgeX < SIDE_MARGIN) {
    const inward = p.x > 0 ? -1 : 1;
    o.desired.x += inward * (1 - edgeX / SIDE_MARGIN) * 1.5;
  }
  const backEdge = Math.abs(game.dir * HALF_L - p.z); // back of the attacking end zone
  if (backEdge < BACK_MARGIN) o.desired.z -= game.dir * (1 - backEdge / BACK_MARGIN) * 1.8;
}
function updateOffense(dt) {
  const carrier = game.carrier;
  const carrierRunning = !!carrier && carrier.role !== 'QB';
  const qbScramble = !!carrier && carrier.role === 'QB' && pastLine(carrier);
  const blockForCarrier = carrierRunning || qbScramble;
  assignBlocks(blockForCarrier);

  for (const o of game.offense) {
    if (o === game.controlled || o === carrier || o.ragdolling) continue;
    const p = px(o);
    o.blocking = false; // set true below only while actively engaged on a block
    const job = blockForCarrier && o.job !== 'qb' ? 'block' : o.job;
    let steer = { x: 0, z: 0 };
    if (job === 'block') {
      const protect = carrier || game.qb;
      const threat = (o.blockTarget) || nearestDefenderTo(p);
      o.blocking = false;
      if (o.engaging) { o.desired = { x: 0, z: 0 }; o.blocking = true; o.turbo = false; continue; } // locked in a block (updateBlocks holds him)
      if (threat && protect) {
        const tp = px(threat), pp = px(protect);
        // Cut off his lane to the ball: get goal-side of the defender, right in his
        // path to the carrier and close, so contact happens and the body-collision
        // walls him off. Hustle (turbo) to the block until locked on, and face him.
        const dx = pp.x - tp.x, dz = pp.z - tp.z, dl = Math.hypot(dx, dz) || 1;
        const bx = tp.x + (dx / dl) * 0.7, bz = tp.z + (dz / dl) * 0.7;
        steer = seek(p, bx, bz);
        const dToThreat = distXZ(p, tp);
        o.turbo = dToThreat > 1.2;
        if (dToThreat < 2.0) { o.blocking = true; o.blockFace = Math.atan2(tp.x - p.x, tp.z - p.z); } // engaged: shove him (procedural pose)
      }
    } else if (job === 'route') {
      const cover = nearestDefenderTo(p);
      const coverD = cover ? distXZ(p, px(cover)) : Infinity;
      if (o.cutTimer > 0) o.cutTimer -= dt;
      // Run to the ball's projected landing (ball.to, updated each frame along
      // the live trajectory) to make a play on it — the target always does, and
      // any receiver near the trajectory breaks on it too, to up the catch odds.
      const onBall = ball.mode === 'flying' && (o === ball.targetRecv || distXZ(p, ball.to) < 9);
      if (onBall) {
        steer = seek(p, ball.to.x, ball.to.z); o.turbo = true;
      } else if (o.route && o.wp < o.route.length) {
        const wp = o.route[o.wp];
        const d = distXZ(p, wp);
        steer = seek(p, wp.x, wp.z);
        o.turbo = d > 2 || o.cutTimer > 0;
        if (d < ROUTE_REACH) { o.wp++; o.cutTimer = coverD < 3 ? 0.55 : 0.4; }
      } else {
        // Route finished: find open grass. Break off the nearest defender if
        // covered; otherwise drift back toward the QB's window as an outlet and
        // keep working downfield into space.
        const qbx = game.qb.group.position.x;
        let lat;
        if (cover && coverD < 7) { lat = Math.sign(p.x - px(cover).x) || 1; if (coverD < 2.6) o.cutTimer = 0.3; }
        else lat = Math.sign(qbx - p.x) * 0.3;
        steer = { x: lat, z: game.dir * (coverD < 4 ? 0.45 : 0.8) };
        o.turbo = coverD < 5;
      }
    }
    const sep = separation(o, game.offense, 2.6);
    o.desired = addSteer(steer, sep, 0.35);
    keepReceiverInbounds(o);
  }
}

// ===========================================================================
// Integration
// ===========================================================================
function applySteer(ch, dt) {
  // Committed to a planted catch (an aerial leap/dive): stop chasing the route and
  // plant — let velocity damp so he carries his stride INTO the jump, then holds at
  // the catch point. In-stride styles (scoop / standing / over-the-shoulder) are NOT
  // planted, so they keep their momentum and the catch flows straight into the run.
  if (ch.catchPlant && ch.oneShotT > 0) ch.desired = { x: 0, z: 0 };
  const dx = ch.desired.x, dz = ch.desired.z, len = Math.hypot(dx, dz);
  let speed = (ch.turbo ? ch.baseSpeed * TUNE.turboMult : ch.baseSpeed) * fatigueSpeed(ch);
  if (ch.cpu) speed *= diff().cpuSpd; // difficulty: scale the CPU team's pace
  if (game.onFire && ch.team === 'off') speed *= TUNE.onFireBoost; // ON FIRE: the whole offense burns
  // Chase-down burst: a defender pursuing the ball carrier in the open gets a
  // closing bonus scaled by SPEED (so a fast DB can actually run down a breakaway
  // — a thrilling chase, not an automatic TD). A late man WAY behind the carrier
  // gets a little extra catch-up so a long run is contestable, not a guaranteed six.
  if (ch.pursuit && ch.rt) {
    let bonus = (ch.turbo ? 0.62 : 0.18) * Math.max(0, ch.rt.speed - 0.4);
    if (game.carrier && distXZ(px(ch), px(game.carrier)) > 10) bonus += 0.1; // catch-up on a long breakaway
    speed *= 1 + bonus;
  }
  if (ch.engaged) speed *= 0.28; // a pass rusher walled off by a blocker is stalled hard
  let tvx = 0, tvz = 0;
  // Honor a SUB-UNIT desired as an arrival speed scale: seek() returns a unit
  // vector (full speed), but coverage uses arrive() which shrinks toward 0 near
  // the spot so a settled DB eases to a stop instead of full-speed micro-
  // correcting (the twitch).
  if (len > 1e-3) { const mag = Math.min(1, len); tvx = dx / len * speed * mag; tvz = dz / len * speed * mag; }
  const k = 1 - Math.pow(0.0009, dt); // acceleration smoothing
  ch.vel.x += (tvx - ch.vel.x) * k;
  ch.vel.z += (tvz - ch.vel.z) * k;
  ch.group.position.x += ch.vel.x * dt;
  ch.group.position.z += ch.vel.z * dt;
  ch.speed = Math.hypot(ch.vel.x, ch.vel.z);
  // holdHeading: keep facing where we're told (e.g. the CPU QB squared to his
  // target) instead of snapping to the travel direction (backpedal = backwards).
  if (ch.speed > 0.3 && !ch.holdHeading) ch.heading = Math.atan2(ch.vel.x, ch.vel.z);
  clampToField(ch);
}
function clampToField(ch) {
  // The cage is a hard wall: clamp inside it AND bounce the player off it (they
  // can never pass through). The margin is the body's half-WIDTH (shoulders/arms),
  // not just the pelvis — otherwise the torso pokes out through the fence.
  const p = ch.group.position, bx = CAGE_X - 0.75, bz = CAGE_Z - 0.75, R = 0.45;
  if (p.x > bx) { p.x = bx; if (ch.vel.x > 0) ch.vel.x = -ch.vel.x * R; }
  else if (p.x < -bx) { p.x = -bx; if (ch.vel.x < 0) ch.vel.x = -ch.vel.x * R; }
  if (p.z > bz) { p.z = bz; if (ch.vel.z > 0) ch.vel.z = -ch.vel.z * R; }
  else if (p.z < -bz) { p.z = -bz; if (ch.vel.z < 0) ch.vel.z = -ch.vel.z * R; }
}

// Hard body-to-body separation: upright players are soft cylinders (TUNE.bodyR) and
// may not interpenetrate. After everyone has moved, push any overlapping pair
// apart along their center line (half the penetration each) so blockers actually
// wall people off and a crowd stops melting into one blob. Cheap O(n^2) over the
// ~14 players. Ragdolls (their own physics) and the locked tackle/battle pile are
// skipped so those intentional overlaps stay coherent. 2*TUNE.bodyR (0.84) is well
// under TUNE.tackleReach (1.5), so contact never blocks a tackle from triggering first.
// Players are 3D CAPSULES auto-sized to the MODEL: radius = measured shoulder
// half-width, height = measured model height (both × playerSize × the bodyFit knob).
// The push-apart is horizontal but gated by VERTICAL overlap, so a player leaping/
// diving clear above another won't shove him. Standing players always overlap in Y.
let BODY_R0 = 0.42, BODY_H0 = 1.95, bodyMeasured = false, _v1 = null, _v2 = null; // fit from the model at runtime
// Fit the collider to the model's BODY: radius from shoulder-joint span (stable under
// arm animation, unlike a full mesh AABB which catches the swinging arms), height from
// the crown. One-time once a player is posed.
function measureBody() {
  const ch = game.all.find((c) => !c.ragdolling && c.model && c.upperArm && c.leftArm); if (!ch) return;
  if (!_v1) { _v1 = new THREE.Vector3(); _v2 = new THREE.Vector3(); }
  ch.model.updateWorldMatrix(true, true);
  ch.upperArm.getWorldPosition(_v1); ch.leftArm.getWorldPosition(_v2); // RightArm / LeftArm shoulder joints
  const span = Math.hypot(_v1.x - _v2.x, _v1.z - _v2.z); // shoulder width (world yd)
  let h = 1.95; if (ch.headEnd) { ch.headEnd.getWorldPosition(_v1); if (_v1.y > 1.4) h = _v1.y; } // crown height
  if (span > 0.1) { const sz = TUNE.playerSize || 1; BODY_R0 = Math.max(0.3, span / 2 * 1.3) / sz; BODY_H0 = h / sz; bodyMeasured = true; }
}
const colliderR = () => BODY_R0 * TUNE.playerSize * TUNE.bodyFit; // world-yard radius
const colliderH = () => BODY_H0 * TUNE.playerSize;
// Illegal-contact rule: past the jam zone, a coverage defender may not BODY-BLOCK a
// route runner (WR/RB running his route, not the ball carrier). Within TUNE.jamYards
// of the LOS a jam (contact) is allowed; beyond it the receiver runs through. Only
// during the pass phase, and never to the ball carrier or to pass rushers/linemen.
function coverageNoContact(A, B) {
  if (game.state !== STATE.LIVE && game.state !== STATE.AIR) return false;
  let off, def;
  if (A.team === 'off' && B.team === 'def') { off = A; def = B; }
  else if (B.team === 'off' && A.team === 'def') { off = B; def = A; }
  else return false;
  if (off === game.carrier) return false;                 // the ball carrier can always be hit
  if (!off.route || off.job !== 'route') return false;    // must be actively running a route (not a blocker/QB)
  if (def.job === 'rush' || def.role === 'DL') return false; // rushers aren't covering — keep the pocket solid
  const rel = game.dir * (off.group.position.z - game.los); // yards downfield of the LOS
  return rel > TUNE.jamYards;                              // past the jam zone: let him run his route
}
function resolveBodies() {
  const a = game.all, colH = colliderH(), min = colliderR() * 2, min2 = min * min;
  for (let i = 0; i < a.length; i++) {
    const A = a[i]; if (A.ragdolling || A.grabbing || A.engaging || A.blockedBy) continue;
    const ap = A.group.position;
    for (let j = i + 1; j < a.length; j++) {
      const B = a[j]; if (B.ragdolling || B.grabbing || B.engaging || B.blockedBy) continue;
      const bp = B.group.position;
      if (ap.y + colH < bp.y || bp.y + colH < ap.y) continue; // capsule: skip if vertical ranges don't overlap
      if (coverageNoContact(A, B)) continue;                  // coverage can't impede a route past the jam zone
      const dx = bp.x - ap.x, dz = bp.z - ap.z, d2 = dx * dx + dz * dz;
      if (d2 >= min2 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2), pen = (min - d) * 0.5, nx = dx / d, nz = dz / d;
      ap.x -= nx * pen; ap.z -= nz * pen;
      bp.x += nx * pen; bp.z += nz * pen;
    }
  }
}
// Does a blocker screen this defender from his target — close enough AND on the
// target side of him (not behind)? `rad`/`dotMin` tune how forgiving: pass rush is
// strict (a lineman beside the rusher shouldn't wall him); run pursuit is lenient
// (a downfield blocker rarely lines up perfectly on a moving carrier's lane).
function blockerScreens(dp, blk, target, rad = 2.0, dotMin = 0.25) {
  if (!blk) return false;
  const bp = px(blk);
  if (distXZ(bp, dp) > rad) return false;
  const tx = target.x - dp.x, tz = target.z - dp.z, tl = Math.hypot(tx, tz) || 1;
  const bx = bp.x - dp.x, bz = bp.z - dp.z, bl = Math.hypot(bx, bz) || 1;
  return (tx / tl) * (bx / bl) + (tz / tl) * (bz / bl) > dotMin; // blocker lies toward the target
}

// ===========================================================================
// Input
// ===========================================================================
const input = { x: 0, y: 0, action: false, turbo: false, actionEdge: false, battleMash: 0, spinEdge: false, diveEdge: false, pitchEdge: false, catchEdge: null };

// Floating joystick: it spawns under your thumb wherever you first touch the LEFT
// half of the screen (so you never have to find a fixed pad), and tracks from
// there. Touches on the right (the buttons) and on any UI control are ignored.
(function joystick() {
  const base = document.getElementById('joystick');
  const knob = document.getElementById('joystick-knob');
  const maxR = 50; let id = null, cx = 0, cy = 0;
  const EXCLUDE = '#action-btn,#turbo-btn,#simbar,#fs-btn,#vol-btn,#volpanel,#playselect,#startmenu,#pausemenu,#settingsmenu,#pause-btn,#install,.rp-continue,#build-badge,#debugpanel,#dbg-fab';
  const onLeft = (x, target) => !dbgCam.on && !replayManual() && !game.lab && x < window.innerWidth * 0.5 && !(target && target.closest && target.closest(EXCLUDE));
  const track = (clientX, clientY) => {
    let dx = clientX - cx, dy = clientY - cy; const d = Math.hypot(dx, dy);
    if (d > maxR) { dx = dx / d * maxR; dy = dy / d * maxR; }
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    input.x = dx / maxR; input.y = -dy / maxR;
  };
  const start = (clientX, clientY, ident) => {
    cx = clientX; cy = clientY; id = ident;
    base.style.left = clientX + 'px'; base.style.top = clientY + 'px'; base.classList.add('active');
    knob.style.transform = 'translate(0,0)'; input.x = 0; input.y = 0;
  };
  const end = () => { id = null; input.x = 0; input.y = 0; knob.style.transform = 'translate(0,0)'; base.classList.remove('active'); };
  window.addEventListener('touchstart', (e) => {
    if (id !== null) return; // already steering with one finger
    const t = e.changedTouches[0]; if (!t || !onLeft(t.clientX, e.target)) return;
    e.preventDefault(); audio.unlock(); start(t.clientX, t.clientY, t.identifier);
  }, { passive: false });
  window.addEventListener('touchmove', (e) => {
    if (id === null) return;
    const t = [...e.changedTouches].find((c) => c.identifier === id); if (!t) return;
    e.preventDefault(); track(t.clientX, t.clientY);
  }, { passive: false });
  const tend = (e) => { if (id === null) return; if (![...e.changedTouches].some((c) => c.identifier === id)) return; e.preventDefault(); end(); };
  window.addEventListener('touchend', tend, { passive: false });
  window.addEventListener('touchcancel', tend);
  window.addEventListener('mousedown', (e) => { if (id !== null || !onLeft(e.clientX, e.target)) return; audio.unlock(); start(e.clientX, e.clientY, 'mouse'); });
  window.addEventListener('mousemove', (e) => { if (id === 'mouse') track(e.clientX, e.clientY); });
  window.addEventListener('mouseup', () => { if (id === 'mouse') end(); });
})();

// ---- Free debug camera: orbit/zoom/pan, rewind scrub, screenshot ----------------
function applyDebugCam() {
  if (dbgCam.follow) { const c = game.carrier || game.qb || ball.holder; const p = c ? c.group.position : (ball.mesh ? ball.mesh.position : null); if (p) dbgCam.target.lerp(p, 0.25); }
  if (dbgCam.autoRotate) dbgCam.az += 0.012;
  const t = dbgCam.target, ce = Math.cos(dbgCam.el), se = Math.sin(dbgCam.el);
  camera.position.set(t.x + dbgCam.dist * ce * Math.sin(dbgCam.az), Math.max(0.3, t.y + dbgCam.dist * se), t.z + dbgCam.dist * ce * Math.cos(dbgCam.az));
  camera.lookAt(t);
}
const dbgScrubMax = () => Math.max(0, game.replay.frames.length - 1);
function setDbgScrub(i) {
  dbgCam.scrub = THREE.MathUtils.clamp(Math.round(i), 0, dbgScrubMax());
  const sl = document.getElementById('dbg-scrub'); if (sl) sl.value = dbgCam.scrub;
}
function toggleDebugCam(on) {
  dbgCam.on = on === undefined ? !dbgCam.on : on;
  if (dbgCam.on) {
    dbgCam.target.copy(cam.lookCur);                       // seed orbit from the live view
    const off = camera.position.clone().sub(dbgCam.target);
    dbgCam.dist = Math.max(3, off.length());
    dbgCam.az = Math.atan2(off.x, off.z);
    dbgCam.el = Math.asin(THREE.MathUtils.clamp(off.y / dbgCam.dist, -0.2, 0.99));
    const sl = document.getElementById('dbg-scrub'); if (sl) sl.max = dbgScrubMax();
    setDbgScrub(dbgScrubMax());                            // start at the latest recorded frame
  } else { dbgCam.scrub = -1; }
  const btn = document.getElementById('dbg-freecam'); if (btn) btn.textContent = 'Free Cam: ' + (dbgCam.on ? 'ON' : 'OFF');
  if (dbgPanelEl) dbgPanelEl.classList.toggle('cam-on', dbgCam.on);
}
// Capture the WebGL canvas to a PNG download (DOM overlays are not included — a
// clean shot of the 3D scene). Flagged here, grabbed right after the next render.
function saveCanvasPNG() {
  try { const a = document.createElement('a'); a.href = renderer.domElement.toDataURL('image/png'); a.download = `reapers_${Date.now()}.png`; a.click(); }
  catch (e) { setStatus('Screenshot failed'); }
}
// The orbit/zoom/pan canvas controls are live in the debug free-cam AND in manual
// replay mode (same machinery, driving dbgCam's az/el/dist/target).
function replayManual() { return game.state === STATE.REPLAY && game.replay.manual; }
function camDrag() { return dbgCam.on || replayManual() || game.lab; }
(function freecamControls() {
  const RK = 0.005;
  let drag = false, pan = false, lx = 0, ly = 0, pinch = 0;
  const rot = (dx, dy) => { dbgCam.az -= dx * RK; dbgCam.el = THREE.MathUtils.clamp(dbgCam.el + dy * RK, -0.2, 1.5); };
  const _r = new THREE.Vector3(), _u = new THREE.Vector3();
  const panT = (dx, dy) => {
    _r.setFromMatrixColumn(camera.matrix, 0); _u.setFromMatrixColumn(camera.matrix, 1);
    const s = dbgCam.dist * 0.0016; dbgCam.target.addScaledVector(_r, -dx * s).addScaledVector(_u, dy * s);
  };
  const zoom = (f) => { dbgCam.dist = THREE.MathUtils.clamp(dbgCam.dist * f, 2, 90); };
  canvas.addEventListener('mousedown', (e) => { if (!camDrag()) return; drag = true; pan = e.button === 2 || e.shiftKey; lx = e.clientX; ly = e.clientY; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => { if (!camDrag() || !drag) return; const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY; pan ? panT(dx, dy) : rot(dx, dy); });
  window.addEventListener('mouseup', () => { drag = false; });
  canvas.addEventListener('wheel', (e) => { if (!camDrag()) return; e.preventDefault(); zoom(1 + Math.sign(e.deltaY) * 0.08); }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => { if (camDrag()) e.preventDefault(); });
  const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  const dist2 = (a, b) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
  canvas.addEventListener('touchstart', (e) => {
    if (!camDrag()) return; e.preventDefault(); const t = e.touches;
    if (t.length >= 2) { pinch = dist2(t[0], t[1]); const m = mid(t[0], t[1]); lx = m.x; ly = m.y; }
    else if (t.length === 1) { lx = t[0].clientX; ly = t[0].clientY; pinch = 0; }
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    if (!camDrag()) return; e.preventDefault(); const t = e.touches;
    if (t.length >= 2) { const d = dist2(t[0], t[1]); if (pinch) zoom(pinch / d); const m = mid(t[0], t[1]); panT(m.x - lx, m.y - ly); lx = m.x; ly = m.y; pinch = d; }
    else if (t.length === 1) { rot(t[0].clientX - lx, t[0].clientY - ly); lx = t[0].clientX; ly = t[0].clientY; }
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => { if (!camDrag()) return; const t = e.touches; if (t.length) { lx = t[0].clientX; ly = t[0].clientY; } pinch = 0; }, { passive: false });
})();

const actionBtn = document.getElementById('action-btn');
const actionLabel = document.getElementById('action-label');
const turboBtn = document.getElementById('turbo-btn');
const coachBtn = document.getElementById('coach-btn');
if (coachBtn) coachBtn.addEventListener('click', (e) => {
  e.preventDefault();
  game.coachCam = !game.coachCam;
  coachBtn.classList.toggle('on', game.coachCam);
  updateCoachArt();
});
// User-action tracker HUD (your tackles / catches / interceptions).
const userStatsEl = document.getElementById('userstats');
const usEls = { tackles: document.getElementById('us-tkl'), catches: document.getElementById('us-cat'), ints: document.getElementById('us-int') };
const usItemFor = { tackles: 'us-k-tackles', catches: 'us-k-catches', ints: 'us-k-ints' };
function flashUserStats(key) {
  if (!userStatsEl) return;
  if (usEls[key]) usEls[key].textContent = game.userStats[key]; // update instantly on the action
  const item = userStatsEl.querySelector('.' + usItemFor[key]);
  if (item) { item.classList.remove('bump'); void item.offsetWidth; item.classList.add('bump'); }
}
function updateUserStatsHUD() {
  if (!userStatsEl) return;
  // Visible once you're in the game (hidden behind the start menu; replay CSS hides it).
  const sm = document.getElementById('startmenu');
  const onMenu = sm && !sm.classList.contains('hidden');
  userStatsEl.classList.toggle('hidden', !!onMenu);
  if (usEls.tackles) usEls.tackles.textContent = game.userStats.tackles;
  if (usEls.catches) usEls.catches.textContent = game.userStats.catches;
  if (usEls.ints) usEls.ints.textContent = game.userStats.ints;
}
// Two-button scheme: TURBO + one contextual ACTION button. (Desktop keeps the
// optional Q/E/F shortcuts for explicit spin/dive/pitch.)
(function buttons() {
  const press = (el, on, off) => {
    const d = (e) => { e.preventDefault(); audio.unlock(); el.classList.add('active'); on(); };
    const u = (e) => { if (e) e.preventDefault(); el.classList.remove('active'); off && off(); };
    el.addEventListener('touchstart', d, { passive: false });
    el.addEventListener('touchend', u, { passive: false });
    el.addEventListener('touchcancel', u);
    el.addEventListener('mousedown', d);
    window.addEventListener('mouseup', u);
  };
  press(actionBtn, () => { input.action = true; input.actionEdge = true; }, () => { input.action = false; });
  press(turboBtn, () => { input.turbo = true; }, () => { input.turbo = false; });
  // Catch-style buttons (shown only during a user pass in flight): tap to make the
  // grab in that style. Edge press → input.catchEdge, consumed in updateUserCatch.
  const cpress = (el, style) => {
    if (!el) return;
    const go = (e) => { e.preventDefault(); audio.unlock(); el.classList.add('active'); input.catchEdge = style; };
    const up = (e) => { if (e) e.preventDefault(); el.classList.remove('active'); };
    el.addEventListener('touchstart', go, { passive: false }); el.addEventListener('touchend', up, { passive: false }); el.addEventListener('touchcancel', up);
    el.addEventListener('mousedown', go); window.addEventListener('mouseup', up);
  };
  cpress(document.getElementById('catch-rac'), 'rac');
  cpress(document.getElementById('catch-poss'), 'poss');
  cpress(document.getElementById('catch-agg'), 'agg');
  // Skip / sim controls (tap fires on press; trigger once).
  const tap = (el, fn) => {
    if (!el) return;
    const go = (e) => { e.preventDefault(); e.stopPropagation(); audio.unlock(); fn(); };
    el.addEventListener('touchstart', go, { passive: false });
    el.addEventListener('mousedown', go);
  };
  tap(document.getElementById('sim-q'), () => skipQuarter());
  tap(document.getElementById('sim-end'), () => simToGameEnd());
})();

// Fullscreen toggle — on mobile this hides the browser address bar so the play
// isn't cut off at the top. (No-op on iOS Safari, which lacks the API; use Add
// to Home Screen there.)
// Exposed so the pause menu's "Fullscreen" button can drive the same toggle
// (the on-field #fs-btn is now hidden — relocated into the menu).
let toggleFullscreen = null, fsAvailable = false;
(function fullscreen() {
  const fsBtn = document.getElementById('fs-btn');
  const root = document.documentElement;
  if (!fsBtn || !root) return;
  // On iPhone Safari there is NO element-fullscreen API at all, so the button
  // can't work — hide it and tell the player how to get there instead.
  const canFs = !!(root.requestFullscreen || root.webkitRequestFullscreen);
  if (!canFs) { fsBtn.style.display = 'none'; return; }
  fsAvailable = true;
  const active = () => document.fullscreenElement || document.webkitFullscreenElement;
  const sync = () => fsBtn.classList.toggle('on', !!active());
  let lastTouch = 0;
  const toggle = (e) => {
    e.preventDefault(); e.stopPropagation(); audio.unlock();
    const p = active()
      ? (document.exitFullscreen || document.webkitExitFullscreen).call(document)
      : (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
    if (p && p.catch) p.catch(() => {}); // ignore rejections (e.g. no user gesture)
    fsBtn.classList.add('active'); setTimeout(() => fsBtn.classList.remove('active'), 130);
  };
  // The rest of the game's controls fire on touchstart; match that so the tap
  // reliably registers, and guard the synthetic click so it doesn't re-toggle.
  fsBtn.addEventListener('touchend', (e) => { lastTouch = Date.now(); toggle(e); }, { passive: false });
  fsBtn.addEventListener('click', (e) => { if (Date.now() - lastTouch < 700) return; toggle(e); });
  toggleFullscreen = () => toggle({ preventDefault() {}, stopPropagation() {} });
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
})();

// ===========================================================================
// Reusable UI kit (Phase 1): vanilla factories for the design-system components
// (.ui-* classes in style.css). One button, one tabbed panel — reused across the
// pause menu, settings, the front-end, and (later) the debug panel, so every
// surface shares styling and behavior instead of being hand-built ad hoc.
// ===========================================================================
// A styled button. variant: 'primary' | 'ghost' | 'danger'. Fires onClick on a
// real tap (unlocks audio first, like the rest of the controls).
function uiButton(label, variant, onClick) {
  const b = document.createElement('button');
  b.className = `ui-btn ui-btn-${variant || 'ghost'}`;
  b.innerHTML = label; // labels may carry an inline glyph
  b.addEventListener('click', (e) => { e.preventDefault(); audio.unlock(); if (onClick) onClick(e); });
  return b;
}
// A tabbed panel. tabs = [{ label, build(paneEl) }]. Returns the wired { bar,
// panes } elements (caller appends them) plus a select(i) to switch tabs.
function uiTabs(tabs) {
  const bar = document.createElement('div'); bar.className = 'ui-tabbar';
  const panes = document.createElement('div'); panes.className = 'ui-panes';
  const tabEls = [], paneEls = [];
  const select = (i) => {
    tabEls.forEach((t, k) => t.classList.toggle('on', k === i));
    paneEls.forEach((p, k) => p.classList.toggle('on', k === i));
  };
  tabs.forEach((t, i) => {
    const tb = document.createElement('button'); tb.className = 'ui-tab'; tb.textContent = t.label;
    tb.addEventListener('click', () => { uiSound('nav'); select(i); });
    const pane = document.createElement('div'); pane.className = 'ui-pane';
    if (t.build) t.build(pane);
    bar.appendChild(tb); panes.appendChild(pane);
    tabEls.push(tb); paneEls.push(pane);
  });
  select(0);
  return { bar, panes, select };
}

// A labeled slider row. opts: { min, max, step, value, format(v), onInput(v) }.
function uiSlider(label, opts) {
  const wrap = document.createElement('label'); wrap.className = 'ui-field';
  const top = document.createElement('div'); top.className = 'ui-field-top';
  const name = document.createElement('span'); name.className = 'ui-field-label'; name.textContent = label;
  const val = document.createElement('span'); val.className = 'ui-field-val';
  const fmt = opts.format || ((v) => v);
  const range = document.createElement('input'); range.type = 'range';
  range.min = opts.min; range.max = opts.max; range.step = opts.step != null ? opts.step : 1; range.value = opts.value;
  val.textContent = fmt(+range.value);
  range.addEventListener('input', () => { const v = +range.value; val.textContent = fmt(v); if (opts.onInput) opts.onInput(v); });
  top.appendChild(name); top.appendChild(val);
  wrap.appendChild(top); wrap.appendChild(range);
  return wrap;
}
// A labeled on/off toggle (styled switch).
function uiToggle(label, value, onChange) {
  const wrap = document.createElement('label'); wrap.className = 'ui-field ui-toggle';
  const name = document.createElement('span'); name.className = 'ui-field-label'; name.textContent = label;
  const sw = document.createElement('button'); sw.type = 'button'; sw.className = 'ui-switch'; sw.setAttribute('role', 'switch');
  const set = (v) => { sw.classList.toggle('on', !!v); sw.setAttribute('aria-checked', String(!!v)); };
  set(value);
  sw.addEventListener('click', () => { const v = !sw.classList.contains('on'); set(v); audio.unlock(); onChange(v); });
  wrap.appendChild(name); wrap.appendChild(sw);
  return wrap;
}
// A segmented control (mutually exclusive). options = [{ label, value }].
function uiSegmented(label, options, value, onChange) {
  const wrap = document.createElement('div'); wrap.className = 'ui-field';
  if (label) {
    const top = document.createElement('div'); top.className = 'ui-field-top';
    const name = document.createElement('span'); name.className = 'ui-field-label'; name.textContent = label;
    top.appendChild(name); wrap.appendChild(top);
  }
  const seg = document.createElement('div'); seg.className = 'ui-seg';
  options.forEach((o) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ui-seg-btn'; b.textContent = o.label;
    b.classList.toggle('on', o.value === value);
    b.addEventListener('click', () => {
      seg.querySelectorAll('.ui-seg-btn').forEach((x) => x.classList.remove('on'));
      b.classList.add('on'); audio.unlock(); uiSound('nav'); onChange(o.value);
    });
    seg.appendChild(b);
  });
  wrap.appendChild(seg);
  return wrap;
}
// Menu-navigation sound hook — handed to the audio session: it implements
// audio.menu(kind) if/when it wants menu SFX; until then this is a silent no-op
// (we stay out of the audio lane and don't invent sounds here).
function uiSound(kind) { try { if (audio && audio.menu) audio.menu(kind); } catch (e) { /* ignore */ } }
// Graceful modal close shared by every .ui-modal: play the close transition, then
// hide — or hide instantly when Reduced motion is on. One motion language for all
// the menus (pause / settings / …).
function uiHideModal(el) {
  if (!el || el.classList.contains('hidden')) return;
  if (_reducedMotion) { el.classList.remove('ui-closing'); el.classList.add('hidden'); return; }
  el.classList.add('ui-closing');
  let done = false;
  const finish = () => { if (done) return; done = true; el.classList.remove('ui-closing'); el.classList.add('hidden'); };
  el.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 240); // fallback if animationend doesn't fire (e.g. display change)
}

// ===========================================================================
// Pause menu (Phase 2): the single reachable hub for control. Soft-pauses the
// sim (game.paused gates the loop in simStep) and presents Resume / Game
// utilities / How-to-play in a tabbed modal built from the Phase-1 UI kit.
// Reachable any time a game is in progress: the top-right button or Esc / P.
// ===========================================================================
const pauseBtn = document.getElementById('pause-btn');
const pauseMenuEl = document.getElementById('pausemenu');

// Controls reference shown in the How-to-play tab.
const PAUSE_HOWTO_HTML = `
  <dt>Move</dt><dd>Left joystick (touch) or WASD / arrow keys.</dd>
  <dt>Turbo</dt><dd>The TURBO button or hold Shift — a burst of speed; the meter drains and recharges.</dd>
  <dt>Action</dt><dd>The right ACTION button is contextual: SNAP the ball, THROW, JUKE, HURDLE, STIFF-ARM, DIVE, or TACKLE depending on the moment.</dd>
  <dt>Switch (on defense)</dt><dd>Tap ACTION / SWITCH to take control of the defender nearest the ball.</dd>
  <dt>Catch your pass</dt><dd>While your throw is in the air, pick a style — RAC (run after catch), POSSESSION (secure), or AGGRESSIVE (high-point). Desktop: Space / Q / E.</dd>
  <dt>Pitch</dt><dd>Press F to lateral the ball to a trailing teammate.</dd>
  <dt>Pause</dt><dd>This menu — Esc or P, or the ❚❚ button.</dd>
`;

function buildPauseMenu() {
  if (!pauseMenuEl) return;
  pauseMenuEl.innerHTML = '';
  const panel = document.createElement('div'); panel.className = 'ui-panel';

  const head = document.createElement('div'); head.className = 'ui-panel-head';
  const title = document.createElement('div'); title.className = 'ui-panel-title'; title.textContent = 'PAUSED';
  const close = document.createElement('button'); close.className = 'ui-panel-close'; close.setAttribute('aria-label', 'Resume'); close.textContent = '×';
  close.addEventListener('click', () => closePause());
  head.appendChild(title); head.appendChild(close);

  const { bar, panes } = uiTabs([
    { label: 'Resume', build: (p) => {
        const stack = document.createElement('div'); stack.className = 'ui-stack';
        stack.appendChild(uiButton('▶&nbsp; RESUME', 'primary', () => closePause()));
        stack.appendChild(uiButton('⚙&nbsp; SETTINGS', 'ghost', () => openSettings()));
        const note = document.createElement('div'); note.className = 'pm-resume-note';
        note.textContent = 'The game is frozen while this menu is open. Tap outside, press Esc, or hit Resume to get back to the action.';
        stack.appendChild(note);
        p.appendChild(stack);
    } },
    { label: 'Game', build: (p) => {
        const stack = document.createElement('div'); stack.className = 'ui-stack';
        const row = document.createElement('div'); row.className = 'ui-btnrow';
        row.appendChild(uiButton('SKIP QTR&nbsp;⏭', 'ghost', () => { closePause(); skipQuarter(); }));
        row.appendChild(uiButton('SIM GAME&nbsp;⏭⏭', 'ghost', () => { closePause(); simToGameEnd(); }));
        stack.appendChild(row);
        if (fsAvailable) stack.appendChild(uiButton('TOGGLE FULLSCREEN&nbsp;⛶', 'ghost', () => { if (toggleFullscreen) toggleFullscreen(); }));
        stack.appendChild(uiButton('RESTART GAME', 'ghost', () => { closePause(); resetGame(); }));
        stack.appendChild(uiButton('QUIT TO MENU', 'danger', () => quitToMenu()));
        p.appendChild(stack);
    } },
    { label: 'How to Play', build: (p) => {
        const dl = document.createElement('dl'); dl.className = 'pm-how';
        dl.innerHTML = PAUSE_HOWTO_HTML;
        p.appendChild(dl);
    } },
  ]);

  panel.appendChild(head); panel.appendChild(bar); panel.appendChild(panes);
  pauseMenuEl.appendChild(panel);
  // Tap the scrim (outside the panel) to resume.
  pauseMenuEl.addEventListener('pointerdown', (e) => { if (e.target === pauseMenuEl) closePause(); });
}

// Pause is reachable whenever a game is actually in progress (not the start menu,
// the pregame cinematic, or the Contact Lab).
function pauseAllowed() { return gameStarted && !game.lab && !game.cinematic; }
function openPause() {
  if (!pauseMenuEl || game.paused || !pauseAllowed()) return;
  game.paused = true;
  document.body.classList.add('paused');
  pauseMenuEl.classList.remove('ui-closing', 'hidden');
  uiSound('open');
}
function closePause() {
  if (!game.paused) return;
  game.paused = false;
  document.body.classList.remove('paused');
  uiHideModal(pauseMenuEl);
  uiSound('close');
}
function togglePause() { if (game.paused) closePause(); else openPause(); }
// Cleanest reliable return to the matchup screen: reload (the start menu gates the
// kickoff again). The demo holds nothing in memory that needs preserving.
function quitToMenu() {
  closePause();
  if (typeof location !== 'undefined' && location.reload) location.reload();
}
// Show the pause button only while a game is in progress.
function syncPauseBtn() {
  if (!pauseBtn) return;
  const show = pauseAllowed();
  pauseBtn.classList.toggle('hidden', !show);
  if (!show && game.paused) closePause(); // never strand the menu open across a mode change
}
(function wirePause() {
  buildPauseMenu();
  if (!pauseBtn) return;
  const go = (e) => { e.preventDefault(); e.stopPropagation(); audio.unlock(); togglePause(); };
  pauseBtn.addEventListener('touchstart', go, { passive: false });
  pauseBtn.addEventListener('mousedown', go);
})();

// ===========================================================================
// Settings (Phase 4): a standalone tabbed modal reachable from the pause menu
// and the start menu. Every control binds to an EXISTING live knob (TUNE.* read
// each frame, or an apply* call) — no new plumbing — and persists to localStorage
// so a player's setup survives reloads. Audio defers to the audio session's mixer
// (#volpanel) so we stay out of that lane (no edits to src/audio.js).
// ===========================================================================
const settingsMenuEl = document.getElementById('settingsmenu');
const SETTINGS_KEY = 'rfSettings';
let _reducedMotion = false; // gated in ScreenShake (tames the camera shake)
// Player-facing settings and their live state (seeded from the current knobs).
const settings = {
  showFps: false,
  brightness: TUNE.exposure,   // renderer tone-mapping exposure
  shake: TUNE.shakeAmt,        // × screen shake
  camDist: TUNE.camDist,       // × chase distance
  camHeight: TUNE.camHeight,   // × chase height
  quarterLen: TUNE.quarterLen, // seconds per quarter (applies next quarter)
  diff: game.diff,             // rookie / pro / allpro
  textScale: 1.0,              // UI text scale (hooks the fluid-type tokens)
  highContrast: false,
  reducedMotion: false,
};
function applySetting(key) {
  const v = settings[key];
  switch (key) {
    case 'showFps': if (fpsEl) fpsEl.style.display = v ? '' : 'none'; break;
    case 'brightness': TUNE.exposure = v; try { applyLighting(); } catch (e) { /* pre-scene */ } break;
    case 'shake': TUNE.shakeAmt = v; break;
    case 'camDist': TUNE.camDist = v; break;
    case 'camHeight': TUNE.camHeight = v; break;
    case 'quarterLen': TUNE.quarterLen = v; break;
    case 'diff': game.diff = v; break;
    case 'textScale': document.documentElement.style.setProperty('--ui-scale', v); break;
    case 'highContrast': document.body.classList.toggle('high-contrast', !!v); break;
    case 'reducedMotion': _reducedMotion = !!v; document.body.classList.toggle('reduced-motion', !!v); break;
  }
}
function applyAllSettings() { for (const k in settings) applySetting(k); }
function saveSettings() {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
}
function loadSettings() {
  try {
    if (typeof localStorage !== 'undefined') {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      for (const k in settings) if (s[k] !== undefined) settings[k] = s[k];
    }
  } catch (e) { /* ignore corrupt storage */ }
  applyAllSettings();
}
// Set + apply + persist in one shot (the onChange for every control).
function setSetting(key, v) { settings[key] = v; applySetting(key); saveSettings(); }

function buildSettings() {
  if (!settingsMenuEl) return;
  settingsMenuEl.innerHTML = '';
  const panel = document.createElement('div'); panel.className = 'ui-panel';
  const head = document.createElement('div'); head.className = 'ui-panel-head';
  const title = document.createElement('div'); title.className = 'ui-panel-title'; title.textContent = 'SETTINGS';
  const close = document.createElement('button'); close.className = 'ui-panel-close'; close.setAttribute('aria-label', 'Close'); close.textContent = '×';
  close.addEventListener('click', () => closeSettings());
  head.appendChild(title); head.appendChild(close);

  const note = (text) => { const d = document.createElement('div'); d.className = 'ui-section-note'; d.textContent = text; return d; };
  const { bar, panes } = uiTabs([
    { label: 'Audio', build: (p) => {
        p.appendChild(note('Master, music, SFX, and commentary levels live in the audio mixer.'));
        const stack = document.createElement('div'); stack.className = 'ui-stack';
        // Close Settings first so the mixer (the audio session's #volpanel) isn't
        // hidden behind this modal.
        stack.appendChild(uiButton('🔊&nbsp; OPEN AUDIO MIXER', 'primary', () => { closeSettings(); if (typeof toggleVolPanel === 'function') toggleVolPanel(true); }));
        p.appendChild(stack);
    } },
    { label: 'Video', build: (p) => {
        p.appendChild(uiSlider('Brightness', { min: 0.7, max: 2.0, step: 0.05, value: settings.brightness, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => setSetting('brightness', v) }));
        p.appendChild(uiToggle('Show FPS counter', settings.showFps, (v) => setSetting('showFps', v)));
    } },
    { label: 'Gameplay', build: (p) => {
        p.appendChild(uiSegmented('Difficulty', [
          { label: DIFF.rookie.label, value: 'rookie' }, { label: DIFF.pro.label, value: 'pro' }, { label: DIFF.allpro.label, value: 'allpro' },
        ], settings.diff, (v) => { setSetting('diff', v); syncStartDiff(); }));
        p.appendChild(uiSlider('Quarter length', { min: 30, max: 180, step: 15, value: settings.quarterLen, format: (v) => `${v}s`, onInput: (v) => setSetting('quarterLen', v) }));
        p.appendChild(note('Quarter length applies from the next quarter.'));
    } },
    { label: 'Camera', build: (p) => {
        p.appendChild(uiSlider('Chase distance', { min: 0.7, max: 1.5, step: 0.05, value: settings.camDist, format: (v) => `${v.toFixed(2)}×`, onInput: (v) => setSetting('camDist', v) }));
        p.appendChild(uiSlider('Chase height', { min: 0.7, max: 1.5, step: 0.05, value: settings.camHeight, format: (v) => `${v.toFixed(2)}×`, onInput: (v) => setSetting('camHeight', v) }));
        p.appendChild(uiSlider('Screen shake', { min: 0, max: 1.5, step: 0.05, value: settings.shake, format: (v) => v === 0 ? 'off' : `${Math.round(v * 100)}%`, onInput: (v) => setSetting('shake', v) }));
    } },
    { label: 'Access', build: (p) => {
        p.appendChild(uiSlider('Text size', { min: 0.9, max: 1.3, step: 0.05, value: settings.textScale, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => setSetting('textScale', v) }));
        p.appendChild(uiToggle('Reduced motion', settings.reducedMotion, (v) => setSetting('reducedMotion', v)));
        p.appendChild(uiToggle('High contrast', settings.highContrast, (v) => setSetting('highContrast', v)));
        p.appendChild(note('Reduced motion tames the camera shake and big-hit flashes.'));
    } },
  ]);
  panel.appendChild(head); panel.appendChild(bar); panel.appendChild(panes);
  settingsMenuEl.appendChild(panel);
  settingsMenuEl.addEventListener('pointerdown', (e) => { if (e.target === settingsMenuEl) closeSettings(); });
}
function openSettings() { if (!settingsMenuEl) return; buildSettings(); settingsMenuEl.classList.remove('ui-closing', 'hidden'); uiSound('open'); }
function closeSettings() { uiHideModal(settingsMenuEl); uiSound('close'); }
// Keep the start-menu difficulty buttons in step when difficulty is changed here.
function syncStartDiff() {
  if (!startMenuEl) return;
  startMenuEl.querySelectorAll('.sm-diff').forEach((b) => b.classList.toggle('on', b.dataset.diff === game.diff));
}

// PWA: register the service worker and show an "Install" prompt on launch (in a
// browser tab). Uses the native beforeinstallprompt where available, with an
// iOS Share-sheet hint as the fallback. Snoozes for a week when dismissed.
(function pwa() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (nav && nav.serviceWorker) {
    window.addEventListener('load', async () => {
      try {
        const hadController = !!nav.serviceWorker.controller; // was an old SW already controlling?
        const reg = await nav.serviceWorker.register('sw.js');
        reg.update();
        // When an UPDATED worker takes control, reload once so the player gets the
        // fresh code instead of stale cached JS (skip on the first-ever install).
        let reloaded = false;
        nav.serviceWorker.addEventListener('controllerchange', () => {
          if (reloaded || !hadController) return;
          reloaded = true; window.location.reload();
        });
      } catch (e) { /* offline / unsupported */ }
    });
  }
  const pop = document.getElementById('install');
  if (!pop || !nav) return;
  const installBtn = document.getElementById('ip-install');
  const dismissBtn = document.getElementById('ip-dismiss');
  const sub = document.getElementById('ip-sub');
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || nav.standalone === true;
  if (standalone) return; // already installed — never nag
  const snoozed = () => { try { return Date.now() - (+localStorage.getItem('pwaSnooze') || 0) < 6048e5; } catch { return false; } }; // 7 days
  const hide = () => pop.classList.add('hidden');
  const snooze = () => { try { localStorage.setItem('pwaSnooze', Date.now()); } catch (e) { /* ignore */ } hide(); };
  const show = () => { if (!snoozed()) pop.classList.remove('hidden'); };
  let deferred = null;
  dismissBtn.addEventListener('click', snooze);
  installBtn.addEventListener('click', async () => {
    if (!deferred) { hide(); return; }
    deferred.prompt();
    const choice = await deferred.userChoice.catch(() => ({ outcome: 'dismissed' }));
    deferred = null; hide();
    if (choice.outcome !== 'accepted') snooze();
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; show(); });
  window.addEventListener('appinstalled', snooze);
  // iOS Safari has no install event — show Add-to-Home-Screen instructions.
  if (/iphone|ipad|ipod/i.test(nav.userAgent || '')) {
    sub.innerHTML = 'Tap the Share icon, then <b>Add to Home Screen</b>, for fullscreen play.';
    installBtn.style.display = 'none';
    setTimeout(show, 1600);
  }
})();

// --- Play-select screen: called before EVERY snap — an offensive playbook on
// your possessions and a defensive call when the CPU has the ball. ----------
const DEF_PLAYS = [
  { name: 'MAN', sub: 'Tight man-up', tag: 'M', col: '#5a8bff', id: 'man', shell: 'man', pressure: 0 },
  { name: 'ZONE', sub: 'Zones + deep help', tag: 'Z', col: '#3fe08a', id: 'zone', shell: 'two', pressure: 0 },
  { name: 'BLITZ', sub: 'Send the house', tag: '⚡', col: '#ff5a3a', id: 'blitz', shell: 'man', pressure: 1 },
  { name: 'SPY', sub: 'Contain the QB', tag: 'S', col: '#ffd23a', id: 'spy', shell: 'single', pressure: 0 },
];
// Coverage id by call index (matches DEF_PLAYS order) — used by the matchup model.
const COVER_ID = DEF_PLAYS.map((d) => d.id);
const PS_PAGE = 4; // cards shown per page
const playSelectEl = document.getElementById('playselect');
const psTitle = document.getElementById('ps-title');
const psSide = document.getElementById('ps-side');
const psPrev = document.getElementById('ps-prev');
const psNext = document.getElementById('ps-next');
const psDots = document.getElementById('ps-dots');
const playCards = playSelectEl ? [...playSelectEl.querySelectorAll('.ps-card')] : [];
const psCatsEl = document.getElementById('ps-cats');
// Each entry carries its ABSOLUTE play index (so a filtered/paged view still maps
// back to the real PLAYS/DEF_PLAYS index when chosen) + a category for filtering.
const offEntries = PLAYS.map((pl, i) => ({ idx: i, cat: pl.run ? 'run' : 'pass', html: `${makePlayArtSVG(pl)}<i>${i + 1}</i><b>${pl.name}</b><span>${pl.sub}</span>` }));
const defEntries = DEF_PLAYS.map((d, i) => ({ idx: i, cat: 'all', html: `<div class="ps-art ps-defart" style="color:${d.col}">${d.tag}</div><i>${i + 1}</i><b>${d.name}</b><span>${d.sub}</span>` }));
// Offense play-call categories (filter chips). Defense (4 calls) shows no chips.
const PS_CATS = [{ id: 'all', label: 'ALL' }, { id: 'pass', label: 'PASS' }, { id: 'run', label: 'RUN' }];
function psList() {
  if (!game.userOnOffense) return defEntries;
  return game.psCat === 'all' ? offEntries : offEntries.filter((e) => e.cat === game.psCat);
}
function psPageCount() { return Math.max(1, Math.ceil(psList().length / PS_PAGE)); }
// Filter chips: build once, reflect the active category; hidden on defense.
function renderPSCats() {
  if (!psCatsEl) return;
  if (!game.userOnOffense) { psCatsEl.classList.add('hidden'); psCatsEl.innerHTML = ''; return; }
  psCatsEl.classList.remove('hidden');
  psCatsEl.innerHTML = PS_CATS.map((c) => `<button class="ps-cat${c.id === game.psCat ? ' on' : ''}" data-cat="${c.id}">${c.label}</button>`).join('');
  psCatsEl.querySelectorAll('.ps-cat').forEach((b) => {
    const go = (e) => { e.preventDefault(); audio.unlock(); if (game.psCat === b.dataset.cat) return; game.psCat = b.dataset.cat; game.psPage = 0; audio.juke(); renderPSCats(); renderPSPage(); };
    b.addEventListener('touchstart', go, { passive: false });
    b.addEventListener('mousedown', go);
  });
}
// Render the cards for the current page, plus arrows + dot indicators.
function renderPSPage() {
  const off = game.userOnOffense, list = psList(), sel = off ? game.playIndex : game.defCall;
  const pages = psPageCount();
  game.psPage = Math.max(0, Math.min(game.psPage, pages - 1));
  const start = game.psPage * PS_PAGE;
  playSelectEl.classList.toggle('def-call', !off);
  playCards.forEach((c, slot) => {
    const entry = list[start + slot];
    if (entry) {
      c.innerHTML = entry.html; c.dataset.idx = entry.idx;
      c.classList.toggle('chosen', entry.idx === sel);
      c.classList.toggle('last', off && entry.idx === game.lastPlayIndex && entry.idx !== sel);
      c.classList.remove('hidden');
    } else { c.classList.add('hidden'); c.dataset.idx = -1; }
  });
  // Arrows only matter when there's more than one page.
  const multi = pages > 1;
  psPrev.classList.toggle('hidden', !multi);
  psNext.classList.toggle('hidden', !multi);
  psPrev.disabled = game.psPage === 0;
  psNext.disabled = game.psPage === pages - 1;
  psDots.innerHTML = multi
    ? Array.from({ length: pages }, (_, p) => `<span class="ps-dot${p === game.psPage ? ' on' : ''}"></span>`).join('')
    : '';
}
function openPlaySelect() {
  game.choosing = true;
  const off = game.userOnOffense;
  if (psTitle) psTitle.textContent = off ? 'CHOOSE YOUR PLAY' : 'CALL YOUR DEFENSE';
  if (psSide) psSide.textContent = off ? 'OFFENSE' : 'DEFENSE';
  game.psCat = 'all'; // always open on the full list; the chips are an optional filter
  // Open on the page that holds the current selection.
  const sel = off ? game.playIndex : game.defCall;
  game.psPage = Math.floor((sel || 0) / PS_PAGE);
  renderPSCats();
  renderPSPage();
  if (playSelectEl) playSelectEl.classList.remove('hidden');
  updateButtons();
}
function psFlip(dir) {
  const pages = psPageCount();
  const next = Math.max(0, Math.min(game.psPage + dir, pages - 1));
  if (next === game.psPage) return;
  game.psPage = next; audio.juke(); renderPSPage();
}
function choosePlay(i) {
  const len = game.userOnOffense ? PLAYS.length : DEF_PLAYS.length;
  if (i < 0 || i >= len) return;
  if (game.userOnOffense) { game.playIndex = i; setStatus(`${PLAYS[i].name} — tap SNAP`); }
  else { game.defCall = i; setStatus(`${DEF_PLAYS[i].name} — tap to set`); }
  audio.catch();
  game.choosing = false;
  if (playSelectEl) playSelectEl.classList.add('hidden');
  updateButtons();
}
for (const card of playCards) {
  const pick = (e) => { e.preventDefault(); audio.unlock(); const idx = +card.dataset.idx; if (idx >= 0) choosePlay(idx); };
  card.addEventListener('touchstart', pick, { passive: false });
  card.addEventListener('mousedown', pick);
}
if (psPrev && psNext) {
  const arrow = (dir) => (e) => { e.preventDefault(); audio.unlock(); psFlip(dir); };
  psPrev.addEventListener('touchstart', arrow(-1), { passive: false });
  psPrev.addEventListener('mousedown', arrow(-1));
  psNext.addEventListener('touchstart', arrow(1), { passive: false });
  psNext.addEventListener('mousedown', arrow(1));
}

const keys = {};
window.addEventListener('keydown', (e) => {
  audio.unlock();
  if (!keys[e.code]) { // edge (initial press only, not key-repeat)
    // Pause menu: P toggles it, Esc closes it. While paused the sim is frozen, so
    // swallow gameplay keys (so a press doesn't queue an action for the resume).
    if (e.code === 'KeyP' && !dbgCam.on) { togglePause(); keys[e.code] = true; return; }
    if (e.code === 'Escape' && game.paused) { closePause(); keys[e.code] = true; return; }
    if (game.paused) { keys[e.code] = true; return; }
    if (e.code === 'Space') { input.actionEdge = true; input.catchEdge = 'rac'; } // Space = catch in stride during a user pass
    if (e.code === 'KeyQ') { input.spinEdge = true; input.catchEdge = 'poss'; }   // spin / stiff-arm · POSSESSION catch
    if (e.code === 'KeyE') { input.diveEdge = true; input.catchEdge = 'agg'; }    // stiff arm · AGGRESSIVE catch
    if (e.code === 'KeyF') input.pitchEdge = true;  // lateral pitch
    if (e.code === 'BracketRight') skipQuarter();   // ] = skip to next quarter
    if (e.code === 'Backslash') simToGameEnd();      // \ = sim to end of game
    if (e.code === 'KeyI') toggleDbg();              // I = balance telemetry overlay
    if (e.code === 'Backquote') toggleDebugPanel();  // ` = debug knob panel
    if (e.code === 'KeyC') toggleDebugCam();         // C = free debug camera (freeze + orbit)
    if (dbgCam.on) {                                 // while frozen: arrows rewind/advance, P screenshots
      if (e.code === 'ArrowLeft') { setDbgScrub(dbgCam.scrub - 1); return; }
      if (e.code === 'ArrowRight') { setDbgScrub(dbgCam.scrub + 1); return; }
      if (e.code === 'KeyP') { dbgCam.shot = true; return; }
    }
    if (game.choosing) {
      if (/^Digit[1-4]$/.test(e.code)) { const card = playCards[+e.code.slice(5) - 1]; const idx = card ? +card.dataset.idx : -1; if (idx >= 0) choosePlay(idx); } // pick the Nth VISIBLE card (honors the active filter/page)
      else if (e.code === 'ArrowLeft' || e.code === 'KeyA') psFlip(-1);
      else if (e.code === 'ArrowRight' || e.code === 'KeyD') psFlip(1);
    }
  }
  keys[e.code] = true;
  if (e.code === 'Space') input.action = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.turbo = true;
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Space') input.action = false;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.turbo = false;
});
function kbVec() {
  let x = 0, y = 0;
  if (keys['KeyW'] || keys['ArrowUp']) y += 1;
  if (keys['KeyS'] || keys['ArrowDown']) y -= 1;
  if (keys['KeyA'] || keys['ArrowLeft']) x -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) x += 1;
  return { x, y };
}

// ===========================================================================
// HUD
// ===========================================================================
const elScoreOff = document.getElementById('score-off');
const elScoreDef = document.getElementById('score-def');
const elDown = document.getElementById('downinfo');
const elStatus = document.getElementById('status');
const elGameClock = document.getElementById('game-clock');
const elQuarter = document.getElementById('quarter');
const elPlayClock = document.getElementById('playclock');
const elPlayResult = document.getElementById('playresult');
// Top-left play-result readout: +N YD / N YD LOSS / INCOMPLETE / TURNOVER.
function setPlayResult(text, cls = '') {
  if (!elPlayResult) return;
  elPlayResult.textContent = text;
  elPlayResult.className = cls; // '', 'gain', or 'loss' (no 'hidden' => visible)
}
function clearPlayResult() { if (elPlayResult) elPlayResult.className = 'hidden'; }
// Format signed yardage the Blitz way.
function yardResult(gained) {
  const g = Math.round(gained);
  if (g <= 0) return { text: `${Math.abs(g)} YD LOSS`, cls: g < 0 ? 'loss' : '' };
  return { text: `+${g} YD`, cls: 'gain' };
}
// Phase 1 feedback — a one-line "why" for the result from the snap's matchup, so
// the player learns the rock-paper-scissors (announcer VO is an audio-lane hook).
function matchupReason(result, gained) {
  const m = game.matchup; if (!m || !m.off) return '';
  const off = m.off.name, cov = (DEF_PLAYS[m.defIdx] || {}).name || 'coverage', p = game.play || {};
  if (p.sack) return m.cov === 'blitz' ? 'Blitz got home!' : 'Coverage sack!';
  if (result === 'intercept') return m.lev < 0 ? `${cov} jumped it!` : 'Picked off!';
  if (m.lev > 0 && (result === 'TD' || ((result === 'tackle' || result === 'oob') && gained >= 4))) return `${off} beat ${cov}!`;
  if (m.lev < 0 && (result === 'incomplete' || ((result === 'tackle' || result === 'oob') && gained <= 1))) return `${cov} had the answer`;
  if (m.cov === 'zone' && result !== 'TD' && gained <= 2 && m.off.type === 'pass') return 'Zone took it away';
  return '';
}
// Show the reason on the status line + hand it to the audio session (optional VO).
function showReason(reason) {
  if (!reason) return;
  try { if (audio && audio.reason) audio.reason(reason, game.matchup); } catch (e) { /* audio lane */ }
}
const elRateCard = document.getElementById('ratecard');
const RC_LABELS = ['SPD', 'STR', 'STA', 'SKL', 'TKL'];
function updateRateCard() { if (elRateCard) elRateCard.classList.add('hidden'); } // live ratings card removed — see post-play cards

// ---- Post-play player cards: after a play, pop the card(s) of the players who
// made it (e.g. the QB + the receiver on a completion) with their ratings and
// running game stats. Stays up through the dead beat / play-select, gone at snap. ---
const playerCardsEl = document.getElementById('playercards');
function recordStats(result, endZ) {
  const p = game.play; if (!p) return;
  const gain = Number.isFinite(endZ) ? Math.round(game.dir * (endZ - game.los)) : 0;
  const td = result === 'TD';
  if (game.tally && gain >= 20) game.tally.bigPlays++;
  if (p.sack) { if (p.tackler && p.tackler.stats) { p.tackler.stats.tkl++; p.tackler.stats.sack++; if (userMadeTackle(p.tackler)) creditUserStat('tackles', 'SACK'); } return; }
  if (p.completed && p.catcher) {                          // completed pass
    if (p.passer && p.passer.stats) { p.passer.stats.att++; p.passer.stats.cmp++; p.passer.stats.passYds += gain; if (td) p.passer.stats.passTD++; }
    if (p.catcher.stats) { p.catcher.stats.rec++; p.catcher.stats.recYds += gain; if (td) p.catcher.stats.recTD++; }
  } else if (p.viaPass) {                                   // incomplete (a pick is recorded in endReturn)
    if (p.passer && p.passer.stats) p.passer.stats.att++;
  } else if (p.carrier && p.carrier.stats) {               // designed run / scramble
    p.carrier.stats.car++; p.carrier.stats.rushYds += gain; if (td) p.carrier.stats.rushTD++;
  }
  if (p.tackler && p.tackler.stats && !td) { p.tackler.stats.tkl++; if (userMadeTackle(p.tackler)) creditUserStat('tackles', 'TACKLE'); }
}
function postPlayCards(result) {
  const p = game.play; if (!p) return [];
  const td = result === 'TD';
  if (p.sack && p.tackler) return [{ player: p.tackler, kind: 'def' }];
  if (p.completed && p.catcher) {
    const e = []; if (p.passer) e.push({ player: p.passer, kind: 'pass' });
    e.push({ player: p.catcher, kind: 'rec' }); return e;
  }
  if (p.viaPass && p.intBy) { const e = [{ player: p.intBy, kind: 'def' }]; if (p.passer) e.push({ player: p.passer, kind: 'pass' }); return e; }
  if (p.viaPass) return p.passer ? [{ player: p.passer, kind: 'pass' }] : [];
  if (p.carrier) { const e = [{ player: p.carrier, kind: 'rush' }]; if (p.tackler && !td) e.push({ player: p.tackler, kind: 'def' }); return e; }
  return [];
}
function statLine(s, kind) {
  if (kind === 'pass') return `${s.cmp}/${s.att} · ${s.passYds} YDS · ${s.passTD} TD · ${s.intThrown} INT`;
  if (kind === 'rec') return `${s.rec} REC · ${s.recYds} YDS · ${s.recTD} TD`;
  if (kind === 'rush') return `${s.car} CAR · ${s.rushYds} YDS · ${s.rushTD} TD`;
  return `${s.tkl} TKL · ${s.sack} SK · ${s.intCaught} INT`;
}
const KIND_LABEL = { pass: 'PASSING', rec: 'RECEIVING', rush: 'RUSHING', def: 'DEFENSE' };
function playerCardHTML(player, kind) {
  if (!player || !player.rt) return '';
  const vals = RAT_KEYS.map((k) => player.rt[k + 'R']);
  const team = game.teamA && game.teamA.includes(player) ? 'home' : 'away';
  const port = portraitCache[`${team}_${kind}`];
  const img = port ? `<img class="pc-portrait" src="${port}" alt="">` : '';
  return `<div class="pc-card pc-${team}">`
    + `<div class="pc-shine"></div>${img}`
    + `<div class="pc-kind">${KIND_LABEL[kind]}</div>`
    + `<div class="pc-ovr"><b>${ovr(vals)}</b><i>OVR</i></div>`
    + `<div class="pc-body">`
    + `<div class="pc-name">${player.surname || ''}</div>`
    + `<div class="pc-pos">${player.pos || player.role || ''}</div>`
    + `<div class="pc-stat">${statLine(player.stats || blankStats(), kind)}</div>`
    + `</div></div>`;
}
function showPlayerCards(result) {
  if (!playerCardsEl) return;
  const entries = postPlayCards(result);
  if (!entries.length) return hidePlayerCards();
  playerCardsEl.innerHTML = entries.map((e) => playerCardHTML(e.player, e.kind)).join('');
  playerCardsEl.classList.remove('hidden');
}
function hidePlayerCards() { if (playerCardsEl) playerCardsEl.classList.add('hidden'); }
// ---- Card portraits: render each team's model in a football pose (with a ball)
// to a cached image per (team, kind), used as the player-card art. Same model per
// team, so the pose varies by what the player did (throw / catch / carry / tackle).
const portraitCache = {};
function poseCardBone(b, rest, a) { if (b && rest) { _tq.setFromAxisAngle(_xAxisL, a); b.quaternion.copy(rest).multiply(_tq); } }
function poseForCard(ch, kind) {
  poseCardBone(ch.upperArm, ch.upperArmRest, 0); poseCardBone(ch.foreArm, ch.foreArmRest, 0);
  poseCardBone(ch.leftArm, ch.leftArmRest, 0); poseCardBone(ch.leftForeArm, ch.leftForeArmRest, 0);
  poseCardBone(ch.spineBone, ch.spineRest, 0);
  if (kind === 'pass') { poseCardBone(ch.upperArm, ch.upperArmRest, -2.25); poseCardBone(ch.foreArm, ch.foreArmRest, -1.7); poseCardBone(ch.leftArm, ch.leftArmRest, 0.7); poseCardBone(ch.spineBone, ch.spineRest, -0.1); }
  else if (kind === 'rec') { poseCardBone(ch.upperArm, ch.upperArmRest, -1.5); poseCardBone(ch.foreArm, ch.foreArmRest, -0.85); poseCardBone(ch.leftArm, ch.leftArmRest, -1.5); poseCardBone(ch.leftForeArm, ch.leftForeArmRest, -0.85); }
  else if (kind === 'rush') { poseCardBone(ch.leftArm, ch.leftArmRest, -1.35); poseCardBone(ch.leftForeArm, ch.leftForeArmRest, -0.12); poseCardBone(ch.upperArm, ch.upperArmRest, 0.15); poseCardBone(ch.foreArm, ch.foreArmRest, -1.95); poseCardBone(ch.spineBone, ch.spineRest, 0.08); }
  else { poseCardBone(ch.upperArm, ch.upperArmRest, -0.55); poseCardBone(ch.foreArm, ch.foreArmRest, -0.55); poseCardBone(ch.leftArm, ch.leftArmRest, -0.55); poseCardBone(ch.leftForeArm, ch.leftForeArmRest, -0.55); poseCardBone(ch.spineBone, ch.spineRest, 0.28); }
}
function restoreCardPose(ch) {
  poseCardBone(ch.upperArm, ch.upperArmRest, 0); poseCardBone(ch.foreArm, ch.foreArmRest, 0);
  poseCardBone(ch.leftArm, ch.leftArmRest, 0); poseCardBone(ch.leftForeArm, ch.leftForeArmRest, 0);
  poseCardBone(ch.spineBone, ch.spineRest, 0);
}
function buildPortraits() {
  if (!charTemplate || !game.teamA || !game.teamA.length) return;
  try {
    const W = 340, H = 440;
    const rt = new THREE.WebGLRenderTarget(W, H, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const pScene = new THREE.Scene();
    // Dramatic-but-readable studio light: a strong key + a camera-side fill so the
    // dark Reaper armor reads, plus a cool rim for edge separation against any bg.
    pScene.add(new THREE.HemisphereLight(0xffffff, 0x44485a, 2.4));
    pScene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dl = new THREE.DirectionalLight(0xffffff, 3.4); dl.position.set(2.6, 4.2, 3.6); pScene.add(dl);
    const fill = new THREE.DirectionalLight(0xfff2e0, 1.5); fill.position.set(-1.6, 1.6, 4.2); pScene.add(fill); // warm camera-side fill
    const rim = new THREE.DirectionalLight(0x9ec8ff, 1.9); rim.position.set(-3.2, 2.8, -2.6); pScene.add(rim); // cool back rim
    const pCam = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 18, 12), new THREE.MeshStandardMaterial({ color: 0x6f3a18, roughness: 0.65 }));
    ball.scale.set(0.42, 0.42, 0.66);
    const buf = new Uint8Array(W * H * 4);
    const cvs = document.createElement('canvas'); cvs.width = W; cvs.height = H; const cx = cvs.getContext('2d');
    const prevColor = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const _wp = new THREE.Vector3();
    for (const team of ['home', 'away']) {
      const rep = team === 'home' ? game.teamA[0] : game.teamB[0];
      if (!rep) continue;
      const parent = rep.group.parent, sp = rep.group.position.clone(), sq = rep.group.quaternion.clone();
      const tagVis = rep.nameTag ? rep.nameTag.visible : false; if (rep.nameTag) rep.nameTag.visible = false;
      pScene.add(rep.group); rep.group.position.set(0, 0, 0); rep.group.rotation.set(0, 0.55, 0);
      for (const kind of ['pass', 'rec', 'rush', 'def']) {
        poseForCard(rep, kind);
        rep.group.updateMatrixWorld(true);
        if (kind !== 'def' && rep.handBone) { rep.handBone.getWorldPosition(_wp); ball.position.copy(_wp).add(new THREE.Vector3(0, 0, 0.12)); pScene.add(ball); }
        else pScene.remove(ball);
        // Frame the full dynamic figure (helmet → mid-thigh) with headroom so a
        // raised throwing arm / the ball never clips the top of the crop.
        pCam.position.set(0.1, 1.5, 3.7); pCam.lookAt(0, 1.3, 0);
        renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear();
        renderer.render(pScene, pCam);
        renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
        const img = cx.createImageData(W, H);
        for (let y = 0; y < H; y++) img.data.set(buf.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4); // flip Y
        cx.putImageData(img, 0, 0);
        portraitCache[`${team}_${kind}`] = cvs.toDataURL('image/png');
      }
      restoreCardPose(rep);
      parent.add(rep.group); rep.group.position.copy(sp); rep.group.quaternion.copy(sq);
      if (rep.nameTag) rep.nameTag.visible = tagVis;
    }
    renderer.setRenderTarget(null); renderer.setClearColor(prevColor, prevAlpha);
    pScene.remove(ball); rt.dispose();
  } catch (e) { console.warn('portrait render failed', e); }
}
const ordinal = (n) => ['1st', '2nd', '3rd', '4th'][n - 1] || n + 'th';
const QLABEL = ['1ST', '2ND', '3RD', '4TH'];
function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  const m = Math.floor(s / 60), ss = s % 60;
  return `${m}:${ss < 10 ? '0' : ''}${ss}`;
}
function updateHUD() {
  elScoreOff.textContent = game.scoreOff;
  elScoreDef.textContent = game.scoreDef;
  const toGo = reachedGoal(game.firstDown) ? 'Goal' : Math.max(1, Math.ceil(toGoYds()));
  const poss = game.userOnOffense ? 'OFF' : 'DEF';
  elDown.textContent = `${poss} · ${ordinal(game.down)} & ${toGo}`;
  elGameClock.textContent = fmtClock(game.gameClock);
  elQuarter.textContent = game.gameOver ? 'FINAL' : (QLABEL[game.quarter - 1] || game.quarter + 'TH');
  const pc = Math.max(0, Math.ceil(game.snapClock));
  elPlayClock.textContent = `:${pc < 10 ? '0' : ''}${pc}`;
  const showPC = game.state === STATE.PRESNAP && !game.gameOver && !game.choosing && game.userOnOffense;
  elPlayClock.style.visibility = showPC ? 'visible' : 'hidden';
  elPlayClock.classList.toggle('warn', showPC && pc <= 5);
  // Mirror the score to the jumbotron.
  const qlabel = game.gameOver ? 'FINAL' : (QLABEL[game.quarter - 1] || game.quarter + 'TH');
  drawJumbo(qlabel, fmtClock(game.gameClock), `${game.scoreOff} - ${game.scoreDef}`, `${poss} · ${ordinal(game.down)} & ${toGo}`);
}
function setStatus(text) {
  elStatus.textContent = text;
  elStatus.classList.remove('flash'); void elStatus.offsetWidth; elStatus.classList.add('flash');
}
function show(el, label) { el.classList.remove('hidden'); if (label != null) el.textContent = label; }
function hide(el) { el.classList.add('hidden'); }
// The single contextual ACTION button: set its label (+ optional "hot" glow when
// a special move like HURDLE / STIFF ARM is available so it's obvious you can do it).
function setAction(label, hot = false) {
  actionBtn.classList.remove('hidden');
  if (actionLabel) actionLabel.textContent = label; else actionBtn.textContent = label;
  actionBtn.classList.toggle('hot', hot);
}
// Catch-style chooser (Phase 1): three buttons shown while a user pass is in flight.
// They light HOT when the ball is catchable and highlight the style you armed.
const catchRowEl = document.getElementById('catch-row');
const catchBtns = { rac: document.getElementById('catch-rac'), poss: document.getElementById('catch-poss'), agg: document.getElementById('catch-agg') };
function showCatchRow(hot, armedStyle) {
  if (!catchRowEl) return;
  catchRowEl.classList.remove('hidden');
  for (const k in catchBtns) { const b = catchBtns[k]; if (!b) continue; b.classList.toggle('hot', hot); b.classList.toggle('armed', armedStyle === k); }
}
function hideCatchRow() { if (catchRowEl) catchRowEl.classList.add('hidden'); }
function updateButtons() {
  const s = game.state, onO = game.userOnOffense;
  actionBtn.classList.remove('hot');
  // PLAY ART (coach cam): callable pre-snap on either side of the ball.
  if (coachBtn) coachBtn.classList.toggle('hidden', !(s === STATE.PRESNAP && !game.choosing && !game.gameOver));
  if (s === STATE.PRESNAP && game.choosing) { hide(actionBtn); hide(turboBtn); }
  else if (s === STATE.PRESNAP) {
    const goLabel = (game.gauntlet && game.gauntlet.active) ? (game.gauntlet.champion ? 'AGAIN' : (game.scoreOff >= game.scoreDef ? 'NEXT' : 'RETRY')) : 'REMATCH';
    setAction(game.gameOver ? goLabel : (onO ? 'SNAP' : 'SWITCH')); hide(turboBtn);
  }
  else if (s === STATE.LIVE) { setAction(onO ? 'THROW' : 'SWITCH'); show(turboBtn); }
  else if (s === STATE.AIR) { onO ? hide(actionBtn) : setAction('SWITCH'); show(turboBtn); }
  else if (s === STATE.RUN) { onO ? refreshRunAction(game.carrier) : setAction('TACKLE'); show(turboBtn); }
  else if (s === STATE.RETURN) { setAction('TACKLE'); show(turboBtn); }
  else if (s === STATE.LOOSE) { setAction('DIVE'); show(turboBtn); }
  else if (s === STATE.BATTLE) { setAction('MASH!'); hide(turboBtn); }
  else { hide(actionBtn); hide(turboBtn); }
}

// ---- UI state machine (Phase 3): progressive disclosure -------------------
// Map the game state to a coarse UI phase and publish it on <body data-ui>, so
// HUD visibility is DECLARED IN ONE PLACE (the data-ui rules in style.css) rather
// than scattered across .hidden toggles. Each phase reveals only its essentials:
//   live      — scoreboard + the contextual ACTION/TURBO + joystick (nothing else)
//   presnap   — scoreboard + SNAP/SWITCH + coach-cam toggle + the matchup cards
//   choosing  — the play-select deck only; the field stays calm
//   dead      — the post-play result readout + cards
//   replay / cinematic / gameover / menu / lab — handled by their own chrome
let _uiPhase = '';
function uiPhaseFor() {
  if (game.lab) return 'lab';
  if (game.cinematic) return 'cinematic';
  if (!gameStarted) return 'menu';
  const s = game.state;
  if (s === STATE.REPLAY) return 'replay';
  if (game.gameOver) return 'gameover';
  if (s === STATE.PRESNAP) return game.choosing ? 'choosing' : 'presnap';
  if (s === STATE.DEAD || s === STATE.RESET) return 'dead';
  return 'live'; // LIVE / AIR / RUN / RETURN / LOOSE / TACKLE / BATTLE — ball in play
}
function applyUIState() {
  const p = uiPhaseFor();
  if (p !== _uiPhase) { _uiPhase = p; document.body.dataset.ui = p; }
  // Cinematic moments (a touchdown celebration, the end-game finale, or the
  // broadcast cut between plays): clear the gameplay controls so the camera work
  // reads clean. The FX layers already run; we just gate the HUD group.
  const cineMoment = !!(game.celebrating || game.finale || (game.cut && game.cut.phase));
  document.body.classList.toggle('cine-moment', cineMoment);
}
// Decide what the contextual ACTION does for the ball carrier right now, and the
// label to show. Captures the exact defender in the path and gates on cooldown,
// so HURDLE / STIFF ARM only light up when they're actually available.
function carrierContext(c) {
  if (!c) return { label: 'JUKE', hot: false, run: () => {} };
  const ahead = defenderAhead(c, 2.8, 0.48); // a man square in the path
  const fast = c.speed > 7.5;
  if (ahead && fast && c.jukeCd <= 0.6)
    return { label: 'HURDLE', hot: true, run: (x) => doHurdle(x, ahead) };
  if (ahead && c.jukeCd <= 0)
    return { label: 'STIFF ARM', hot: true, run: (x) => stiffArm(x, ahead) };
  // Wide open downfield (nearest defender well back) — showboat for style (risk:
  // a hit while taunting strips the ball; reward: a turbo pop if you survive it).
  const nd = nearestDefenderTo(px(c));
  if (fast && c.tauntCd <= 0 && (!nd || distXZ(px(c), px(nd)) > 9))
    return { label: 'TAUNT', hot: false, run: doTaunt };
  return { label: 'JUKE', hot: false, run: doJuke };
}
// Refresh the action button to the carrier's current context (called per-frame
// during your run so HURDLE / STIFF ARM light up the instant they're available).
function refreshRunAction(c) {
  const ctx = carrierContext(c);
  setAction(ctx.label, ctx.hot);
}

// ===========================================================================
// Juice (ported from Football-Game: ScreenShake.ts + TimeScale.ts)
// ===========================================================================
const moveToward = (v, t, maxD) => (v < t ? Math.min(v + maxD, t) : Math.max(v - maxD, t));
// Procedural-overlay weight ease (in faster than out); hoisted so updateAnimation
// doesn't rebuild a closure per character per frame.
const POSE_IN = 0.09, POSE_OUT = 0.13;
const easeWeight = (cur, on, dt) => moveToward(cur, on ? 1 : 0, dt / (on ? POSE_IN : POSE_OUT));
function turnToward(a, b, maxD) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + THREE.MathUtils.clamp(d, -maxD, maxD);
}

// Trauma-based screen shake + a directional kick: a tackle visibly *shoves*
// the camera the way the runner is driven instead of just rattling it.
class ScreenShake {
  constructor() { this.trauma = 0; this.kickX = 0; this.kickZ = 0; this.offX = 0; this.offY = 0; this.offZ = 0; }
  add(amount) { this.trauma = Math.min(1, this.trauma + amount); }
  kick(dx, dz, amount) {
    const l = Math.hypot(dx, dz) || 1;
    this.kickX += (dx / l) * amount; this.kickZ += (dz / l) * amount;
  }
  update(dt, maxOffset = 0.55) {
    let ox = this.kickX, oz = this.kickZ, oy = 0;
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma; // punchy: offset scales with trauma^2
      ox += (Math.random() * 2 - 1) * maxOffset * s;
      oz += (Math.random() * 2 - 1) * maxOffset * s;
      oy += (Math.random() * 2 - 1) * maxOffset * 0.5 * s;
      this.trauma = Math.max(0, this.trauma - dt * 1.6);
    }
    // Reduced-motion (accessibility): hold the camera steady — no shake/kick.
    if (_reducedMotion) { ox = oz = oy = 0; this.kickX = this.kickZ = 0; }
    this.offX = ox * TUNE.shakeAmt; this.offY = oy * TUNE.shakeAmt; this.offZ = oz * TUNE.shakeAmt;
    const k = Math.max(0, 1 - dt * 11); // snappy lurch-out, recovers in ~0.18s
    this.kickX *= k; this.kickZ *= k;
    if (Math.abs(this.kickX) < 0.01) this.kickX = 0;
    if (Math.abs(this.kickZ) < 0.01) this.kickZ = 0;
  }
}

// Hit-stop (a brief freeze) + bullet-time slow-mo that eases smoothly back to
// full speed. The sim multiplies its dt by `update()`'s return each frame.
class TimeScale {
  constructor() { this.freezeT = 0; this.slowT = 0; this.slowAmt = 1; this.btHold = 0; this.btEase = 0; this.btEaseDur = 1; this.btScale = 1; this.grade = 0; }
  freeze(s) { this.freezeT = Math.max(this.freezeT, s); }
  slow(scale, s) { this.slowAmt = scale; this.slowT = Math.max(this.slowT, s); }
  bulletTime(scale = 0.16, hold = 0.5, ease = 0.8) {
    this.btScale = scale; this.btHold = hold; this.btEase = ease; this.btEaseDur = ease;
  }
  update(realDt) {
    if (this.freezeT > 0) { this.freezeT -= realDt; this.grade = 1; return 0; }
    let v = 1, bt = 1; // bt = bullet-time factor this frame (1 = none)
    if (this.slowT > 0) { this.slowT -= realDt; v = Math.min(v, this.slowAmt); }
    if (this.btHold > 0 || this.btEase > 0) {
      if (this.btHold > 0) { this.btHold -= realDt; bt = this.btScale; }
      else {
        this.btEase -= realDt;
        const k = THREE.MathUtils.clamp(this.btEase / this.btEaseDur, 0, 1);
        const s = k * k * (3 - 2 * k); // smoothstep ramp back to full speed
        bt = this.btScale + (1 - this.btScale) * (1 - s);
      }
      v = Math.min(v, bt);
    }
    // Slow-mo HIT grade (red tint + vignette) tracks the bullet-time depth only —
    // not the score slow() — so it reads as a brutal hit, fading as speed returns.
    this.grade = THREE.MathUtils.clamp((1 - bt) / 0.92, 0, 1);
    return v;
  }
}

const shake = new ScreenShake();
const timeScale = new TimeScale();

const bannerEl = document.getElementById('banner');
// Blitz-style badge callouts: a circular icon (+ optional hit-power number)
// beside the bold italic label. Monochrome SVG glyphs tinted by the callout color.
const ICON_SVG = {
  burst: '<svg viewBox="0 0 24 24"><path d="M12 1 14 8 21 4 16 11 23 12 16 13 21 20 14 16 12 23 10 16 3 20 8 13 1 12 8 11 3 4 10 8Z"/></svg>',
  pinwheel: '<svg viewBox="0 0 24 24"><path d="M12 12 7 3 17 5ZM12 12 21 7 19 17ZM12 12 17 21 7 19ZM12 12 3 17 5 7Z"/></svg>',
  ball: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="10.5" ry="6.2" transform="rotate(-32 12 12)"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 2 15 9 22 9 16.5 14 18.5 22 12 17.3 5.5 22 7.5 14 2 9 9 9Z"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14 11 14 9 22 20 9 13 9Z"/></svg>',
  fire: '<svg viewBox="0 0 24 24"><path d="M12 2C14 6 18 8 17 13 16 17.5 13 19 12 22 11 19 8 17.5 7 13 6 9 9 8 9 5 10.5 7 11 6 12 2Z"/></svg>',
};
const CALLOUT_ICONS = {
  'BIG HIT!': 'burst', 'GANG TACKLE!': 'burst', 'SACK!': 'burst', 'STOPPED!': 'burst',
  'DIRTY HIT!': 'pinwheel', 'BROKE IT!': 'burst', 'BROKE FREE!': 'burst',
  'TOUCHDOWN!': 'ball', 'FUMBLE!!!': 'ball', 'PITCH!': 'ball',
  'PICK SIX!': 'star', 'INTERCEPTED!': 'star', 'PICKED OFF!': 'star', 'TURNOVER!': 'star', 'TURNOVER': 'star',
  'ON FIRE!': 'fire', 'OFF THE WALL!': 'bolt', 'HURDLE!': 'bolt',
};
const dbgLogBuf = [];
function dbgLogPush(msg) {
  const t = (game && game.quarter) ? `Q${game.quarter} ${fmtClock(game.gameClock)} ` : '';
  dbgLogBuf.push(`<span class="lg-t">${t}</span>${msg}`);
  if (dbgLogBuf.length > 16) dbgLogBuf.shift();
  const el = document.getElementById('dbglog'); if (el) el.innerHTML = dbgLogBuf.slice().reverse().join('<br>');
}
function showBanner(text, color = '#ffd23a', opts = {}) {
  dbgLogPush(text); // feed the debug event log
  const icon = opts.icon || CALLOUT_ICONS[text];
  bannerEl.style.color = color;
  if (icon) {
    bannerEl.style.setProperty('--bn', color);
    bannerEl.innerHTML = `<span class="bn-badge"><span class="bn-icon">${ICON_SVG[icon] || ''}</span>${opts.power ? `<span class="bn-num">${opts.power}</span>` : ''}</span><span class="bn-label">${text}</span>`;
    bannerEl.classList.add('has-badge');
  } else {
    bannerEl.textContent = text;
    bannerEl.classList.remove('has-badge');
  }
  bannerEl.classList.remove('pop'); void bannerEl.offsetWidth;
  bannerEl.classList.add('pop');
}
// Blitz hit-power rating (~55-99) from closing speed, the tackler's TKL rating,
// the gang size and turbo — flashed under the badge on a notable hit.
function hitPower(lead, closing, gangSize = 1, big = false) {
  const tkl = lead && lead.rt ? lead.rt.tackle : 0.7;
  const fp = lead ? fatiguePow(lead) : 1; // a gassed tackler hits softer
  const p = 48 + closing * 2.8 + tkl * 18 * fp + (gangSize - 1) * 5 + (big ? 8 : 0) + (lead && lead.turbo ? 4 : 0);
  return THREE.MathUtils.clamp(Math.round(p), 55, 99);
}
const impactEl = document.getElementById('impact');
// Cinematic impact punch: a quick radial vignette flash on a big/dirty hit.
function impactFlash(strong = false) {
  if (!impactEl) return;
  impactEl.classList.toggle('strong', strong);
  impactEl.classList.remove('on'); void impactEl.offsetWidth; impactEl.classList.add('on');
}
const slowmoEl = document.getElementById('slowmo'); // red-tint + vignette grade during slow-mo hits
// Broadcast cut: a quick fade-to-dark then back, with the reset (heads back on,
// ragdolls standing, lineup) run at the dark peak so none of the snap is seen.
const cutEl = document.getElementById('cut');
const CUT_OUT = 0.18, CUT_IN = 0.42;
function startCut(mid) {
  const c = game.cut; if (c.phase) return; // already cutting — the stored mid runs once at the dark peak
  c.phase = 'out'; c.t = 0; c.mid = mid || null;
}
function updateCut(dt) {
  const c = game.cut; if (!c.phase || !cutEl) return;
  c.t += dt;
  if (c.phase === 'out') {
    cutEl.style.opacity = Math.min(1, c.t / CUT_OUT).toFixed(3);
    if (c.t >= CUT_OUT) { if (c.mid) c.mid(); c.mid = null; c.phase = 'in'; c.t = 0; cutEl.style.opacity = '1'; }
  } else {
    cutEl.style.opacity = Math.max(0, 1 - c.t / CUT_IN).toFixed(3);
    if (c.t >= CUT_IN) { c.phase = null; cutEl.style.opacity = '0'; }
  }
}
const flashEl = document.getElementById('flash');
function flashScreen() {
  if (!flashEl) return;
  flashEl.classList.remove('on'); void flashEl.offsetWidth; flashEl.classList.add('on');
}

// ===========================================================================
// Play flow
// ===========================================================================
// Game clock: runs while the ball is live, freezes between plays. Pre-snap a
// delay-of-game play clock counts down and auto-snaps at zero. The quarter only
// rolls over between plays (the current play always finishes).
function tickClock(dt) {
  if (game.gameOver) return;
  // Running game clock: keeps ticking through the dead-ball/reset/play-call. It
  // ONLY pauses after a stoppage (a score, an incomplete pass, or a turnover —
  // game.clockStopped, set in endPlay/endReturn) until the next snap clears it,
  // and during the instant-replay cutaway.
  if (!game.clockStopped && game.state !== STATE.REPLAY) {
    game.gameClock = Math.max(0, game.gameClock - dt);
  }
  // Delay-of-game play clock ticks pre-snap once a play has been called.
  if (game.state === STATE.PRESNAP && !game.choosing) {
    game.snapClock -= dt;
    if (game.snapClock <= 0) { game.snapClock = 0; setStatus('Delay of game — snapped!'); snap(); }
  }
  updateHUD();
}
function advanceQuarter() {
  game.quarter += 1;
  clearBloodStains(); // fresh turf each quarter
  if (game.quarter > 4) { endGame(); return; }
  game.gameClock = TUNE.quarterLen; game.clockStopped = true; // new quarter waits for the snap
  audio.whistle();
  if (game.quarter === 3) showBanner('HALFTIME', '#ffd23a');
  else showBanner(`Q${game.quarter}`, '#ffd23a');
}
function endGame() {
  game.gameOver = true; game.gameClock = 0;
  douseFire();
  audio.whistle();
  showBanner('FINAL', game.scoreOff >= game.scoreDef ? '#3fe08a' : '#ff6a5a');
  try { console.log('[BALANCE]', balanceSummary().text); } catch (e) { /* ignore */ }
}
// ---- Balance telemetry: aggregate team box scores + game tally. Tunable knobs
// are read against these numbers; toggle the live overlay with the 'I' key.
function teamAgg(team) {
  const a = { cmp: 0, att: 0, passYds: 0, recYds: 0, car: 0, rushYds: 0, tkl: 0, sack: 0, intCaught: 0, passTD: 0, rushTD: 0, recTD: 0 };
  for (const ch of team) { const s = ch.stats; if (!s) continue; for (const k in a) a[k] += s[k] || 0; }
  return a;
}
function balanceSummary() {
  const A = game.teamA ? teamAgg(game.teamA) : null, B = game.teamB ? teamAgg(game.teamB) : null;
  const t = game.tally;
  const line = (nm, sc, g) => g ? `${nm} ${sc}  |  ${g.cmp}/${g.att} ${g.passYds}py  ${g.car}car ${g.rushYds}ry  ${g.sack}sk ${g.tkl}tkl ${g.intCaught}int` : `${nm} ${sc}`;
  const text = `${line('RPR', game.scoreOff, A)}\n${line('DMN', game.scoreDef, B)}\nQ${game.quarter} plays:${t.plays} sacks:${t.sacks} fum:${t.fumbles} pick:${t.picks} big:${t.bigPlays}`;
  return { A, B, text };
}
// Rich balance report (real aggregated telemetry + derived rates) for the Stats tab.
function dbgBalanceReport() {
  const A = game.teamA ? teamAgg(game.teamA) : null, B = game.teamB ? teamAgg(game.teamB) : null, t = game.tally;
  const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
  const avg = (n, d) => d ? (n / d).toFixed(1) : '0.0';
  const blk = (nm, sc, g) => !g ? `${nm} ${sc}` :
    `${nm}  ${sc} pts\n  pass ${g.cmp}/${g.att} (${pct(g.cmp, g.att)}%)  ${g.passYds}yd  ${avg(g.passYds, g.att)}/att  ${g.passTD}td\n  rush ${g.car}c  ${g.rushYds}yd  ${avg(g.rushYds, g.car)}/c  ${g.rushTD}td\n  def  ${g.tkl}tkl ${g.sack}sk ${g.intCaught}int`;
  const u = game.userStats;
  return `REAPERS vs DEMONS · Q${game.quarter}\n${blk('RPR', game.scoreOff, A)}\n${blk('DMN', game.scoreDef, B)}\n— plays ${t.plays} · sacks ${t.sacks} · fum ${t.fumbles} · picks ${t.picks} · big ${t.bigPlays}\nYOU (career)  ${u.tackles} tkl · ${u.catches} cat · ${u.ints} int`;
}
function resetGame() {
  endFinale(); // stop the dance party + clear loser/dancer pose flags
  game.cut.phase = null; if (cutEl) cutEl.style.opacity = '0'; // clear any mid-cut
  game.scoreOff = 0; game.scoreDef = 0;
  game.tally = { plays: 0, sacks: 0, fumbles: 0, picks: 0, bigPlays: 0 };
  for (const ch of game.all) ch.stats = blankStats(); // fresh box score for the rematch
  game.quarter = 1; game.gameClock = TUNE.quarterLen; game.gameOver = false; game.clockStopped = true;
  game.userOnOffense = true; game.dir = 1;
  game.los = DRIVE_START; game.down = 1; game.firstDown = game.los + FIRST_DOWN_YDS;
  game.fireCount = 0; douseFire();
  showBanner('KICKOFF', '#ffd23a');
  newPlay();
}

// ---- Gauntlet mode --------------------------------------------------------
function relabelScoreboard() {
  const tagOff = document.querySelector('.tb-team.off .tb-tag'), tagDef = document.querySelector('.tb-team.def .tb-tag');
  if (tagOff) tagOff.textContent = TEAMS.home.abbr;
  if (tagDef) tagDef.textContent = TEAMS.away.abbr;
  // Publish the team colors at the root so the broadcast scoreboard carries team
  // identity (home/away accent bars) instead of the generic OFF/DEF palette.
  const root = document.documentElement.style;
  root.setProperty('--home', TEAMS.home.color);
  root.setProperty('--away', TEAMS.away.color);
}
// Tear down and respawn both teams (used when the opponent's roster changes).
function rebuildTeams() {
  for (const ch of game.all || []) {
    if (ch.ragdoll) { try { ch.ragdoll.dispose(); } catch (e) { /* ignore */ } }
    if (ch.group && ch.group.parent) ch.group.parent.remove(ch.group);
  }
  clearRagdolls();
  spawnTeams();
  if (TUNE.playerSize !== 1) applyPlayerSize();
  try { applyLook(); } catch (e) { /* ignore */ }
  try { buildPortraits(); } catch (e) { /* ignore */ }
}
// Swap in gauntlet opponent `i`: its roster, difficulty, color, scoreboard tag.
function applyGauntletOpponent(i) {
  const opp = GAUNTLET_OPPONENTS[i];
  TEAMS.away = { name: opp.name, abbr: opp.abbr, color: opp.color, logo: TEAMS.away ? TEAMS.away.logo : null, players: opp.players };
  game.diff = opp.diff;
  TUNE.defenseTint = opp.color; // tint the CPU team to its color so each challenger looks distinct
  rebuildTeams();
  relabelScoreboard();
  updateGauntletHud();
}
const gauntletHudEl = (typeof document !== 'undefined') ? document.getElementById('gauntlet-hud') : null;
function updateGauntletHud() {
  if (!gauntletHudEl) return;
  const g = game.gauntlet;
  if (!g || !g.active) { gauntletHudEl.classList.add('hidden'); return; }
  const n = GAUNTLET_OPPONENTS.length;
  const pips = GAUNTLET_OPPONENTS.map((o, i) => `<i class="${i < g.wins ? 'won' : i === g.round ? 'now' : ''}"></i>`).join('');
  gauntletHudEl.innerHTML = `<b>GAUNTLET</b><span>${Math.min(g.round + 1, n)}/${n} · ${TEAMS.away.name}</span><div class="gx-pips">${pips}</div>`;
  gauntletHudEl.classList.remove('hidden');
}
function startGauntlet() {
  if (gameStarted) return;
  game.gauntlet = { active: true, round: 0, wins: 0, champion: false };
  applyGauntletOpponent(0); // round 1 opponent + respawn before kickoff
  startGame();              // pregame cinematic -> play
}
// Pressed when a gauntlet game is over: advance on a win, restart the run on a loss.
function gauntletNext() {
  const g = game.gauntlet;
  if (g.champion) { // continue after winning it all -> a fresh run
    g.champion = false; g.round = 0; g.wins = 0;
    applyGauntletOpponent(0); resetGame();
    showBanner('NEW GAUNTLET', '#ffd23a'); return;
  }
  const won = game.scoreOff >= game.scoreDef;
  if (won) {
    g.wins++; g.round++;
    if (g.round >= GAUNTLET_OPPONENTS.length) { // ran the whole gauntlet
      g.champion = true;
      showBanner('GAUNTLET CHAMPION! 🏆', '#ffd23a');
      setStatus('You ran the gauntlet! Tap to play again');
      updateGauntletHud();
      return; // stay on the finale; next press starts a new run
    }
    applyGauntletOpponent(g.round); resetGame();
    showBanner(`CHALLENGER ${g.round + 1}/${GAUNTLET_OPPONENTS.length} — ${TEAMS.away.name}`, '#3fe08a');
  } else { // lost — start the whole gauntlet over
    g.round = 0; g.wins = 0;
    applyGauntletOpponent(0); resetGame();
    showBanner('GAUNTLET FAILED — START OVER', '#ff5a3a');
  }
  updateGauntletHud();
}

// ---- Skip / simulate the clock ------------------------------------------
// Believable points for a quarter we're fast-forwarding past (most quarters a
// score or two each).
function simQuarterScore() {
  const pts = () => { const r = Math.random(); return r < 0.42 ? 0 : r < 0.55 ? 3 : r < 0.86 ? 7 : 14; };
  game.scoreOff += pts(); game.scoreDef += pts();
}
// Jump to the next quarter (or to the final whistle if it's the 4th): tally some
// scoring for the quarter being skipped, expire the clock, then re-line-up —
// preparePlay advances the period (advanceQuarter / endGame -> dance party).
function skipQuarter() {
  if (game.gameOver) return;
  if (game.state === STATE.REPLAY) endReplay();
  simQuarterScore();
  game.gameClock = 0; game.clockStopped = true;
  clearRagdolls(); douseFire();
  newPlay();
}
// Fast-forward through every remaining quarter to the final whistle. Routes
// through the normal game-over path so the end-of-game celebration fires.
function simToGameEnd() {
  if (game.gameOver) return;
  if (game.state === STATE.REPLAY) endReplay();
  for (let q = game.quarter; q <= 4; q++) simQuarterScore(); // score the quarters we skip
  game.quarter = 4;            // the next prepare advances to 5 = FINAL
  game.gameClock = 0; game.clockStopped = true;
  clearRagdolls(); douseFire();
  newPlay();                   // -> preparePlay -> advanceQuarter(5) -> endGame -> startFinale
}

const WALK_SPEED = 5.2; // jog-back pace during the between-plays reset
// Prepare the next play's roles, formation spots and ball/marker state.
// teleport=true snaps players to formation (kickoff); false lets them walk back.
// --- Popped helmets (a DIRTY HIT knocks the runner's lid off) ---------------
// A lightweight ballistic prop (gravity + bounce + tumble), not a Rapier body.
const flyingHelmets = [];
const _hAxis = new THREE.Vector3(), _hQ = new THREE.Quaternion(), _bloodPos = new THREE.Vector3();
function popHelmet(ch, hx, hz, power) {
  if (!TUNE.gore) return; // gore disabled (debug)
  const h = ch.helmet;
  if (!h || !h.userData.rest || h.userData.flying) return;
  scene.attach(h); // detach from the head bone, keeping its current world transform
  h.userData.flying = true;
  if (h.userData.isHead) { h.visible = true; if (ch.headBone) ch.headBone.scale.setScalar(HEAD_POP_SCALE); } // the HEAD pops: show the prop, shrink the real (skinned) head to a nub
  const l = Math.hypot(hx, hz) || 1, spd = 3 + (power || 70) / 22;
  flyingHelmets.push({
    h,
    vx: (hx / l) * spd + ch.vel.x * 0.3 + (Math.random() - 0.5) * 1.6,
    vy: 5.5 + Math.random() * 2.6,
    vz: (hz / l) * spd + ch.vel.z * 0.3 + (Math.random() - 0.5) * 1.6,
    ax: Math.random() - 0.5, ay: Math.random() - 0.5, az: Math.random() - 0.5,
    spin: 13 + Math.random() * 10, rest: false,
  });
  // Blood geyser out of the neck where the head/helmet was.
  _bloodPos.set(ch.group.position.x, 1.6, ch.group.position.z);
  if (ch.headBone) ch.headBone.getWorldPosition(_bloodPos);
  bloodSpray(_bloodPos.x, _bloodPos.y - 0.15, _bloodPos.z);
  audio.fence(0.3); // chin-strap pop / clatter
  // Log the pop so the instant replay can re-enact it (helmet flies + blood) at
  // the same frame. (Not while a replay is itself re-firing the pop.)
  if (game.state !== STATE.REPLAY) {
    const ev = game.replay.evPool.pop() || {};
    ev.type = 'helmet'; // pooled events can be stale 'tear' — always set the type
    ev.fi = game.replay.frames.length; ev.pIdx = game.all.indexOf(ch);
    ev.hx = hx; ev.hz = hz; ev.power = power || 70; ev.fired = false;
    game.replay.events.push(ev);
  }
}
function updateFlyingHelmets(dt) {
  if (!flyingHelmets.length) return;
  const G = 22, GROUND = 0.28;
  for (const f of flyingHelmets) {
    if (f.rest) continue;
    f.vy -= G * dt;
    const p = f.h.position;
    p.x += f.vx * dt; p.y += f.vy * dt; p.z += f.vz * dt;
    if (p.y <= GROUND) {
      p.y = GROUND;
      if (f.vy < 0) f.vy = -f.vy * 0.42;          // bounce
      f.vx *= 0.7; f.vz *= 0.7; f.spin *= 0.6;    // friction
      if (Math.abs(f.vy) < 1.2 && Math.hypot(f.vx, f.vz) < 0.6) { f.rest = true; f.vy = f.vx = f.vz = 0; }
    }
    p.x = THREE.MathUtils.clamp(p.x, -HALF_W + 0.3, HALF_W - 0.3);
    p.z = THREE.MathUtils.clamp(p.z, -HALF_L + 0.3, HALF_L - 0.3);
    _hAxis.set(f.ax, f.ay, f.az).normalize();
    _hQ.setFromAxisAngle(_hAxis, f.spin * dt);
    f.h.quaternion.premultiply(_hQ);              // tumble
  }
}
function restoreHelmet(ch) {
  const h = ch.helmet;
  if (!h || !h.userData.flying) return;
  const r = h.userData.rest;
  h.userData.flying = false;
  r.parent.add(h); h.position.copy(r.pos); h.quaternion.copy(r.quat); h.scale.copy(r.scale);
  if (h.userData.isHead) { h.visible = false; if (ch.headBone) ch.headBone.scale.setScalar(HEAD_SCALE); } // re-grow the real head, re-hide the prop
  const i = flyingHelmets.findIndex((f) => f.h === h); if (i >= 0) flyingHelmets.splice(i, 1);
}

// --- TORN IN HALF: a rare, brutal big-hit gore hook. The body splits at the
// waist into two halves (top: torso + head + arms + helmet; bottom: pelvis +
// legs), each a full RAGDOLL that flops and settles, blood gushing from the
// split (same spray as the head pop). Each half is a clone of the player whose
// body geometry is sliced at the waist (triangles kept on one side only) so the
// skeleton stays intact — a real ragdoll drives it (no zero-scale bones, which
// would NaN drive()'s worldToLocal). Built once per player, reused.
const tornRagdolls = []; // active half ragdolls to step alongside game.all
function buildHalf(ch, keepTop, bit) {
  // THREE.Object3D.copy() deep-clones userData via JSON; the helmet stores a
  // circular userData.rest (parent bone), which would throw. Blank all userData
  // on the source for the clone, then restore the originals.
  const stash = [];
  ch.model.traverse((o) => { if (o.userData && Object.keys(o.userData).length) { stash.push([o, o.userData]); o.userData = {}; } });
  let piece;
  try { piece = cloneSkeleton(ch.model); } finally { for (const [o, ud] of stash) o.userData = ud; }
  // Slice EVERY skinned mesh at the waist (alt models can have several: body, head,
  // accessories), keeping only the triangles on this half's side. Skinned-mesh
  // geometry shares the bind-pose space, so one waist Y (from the union bounds)
  // applies to them all. Skeleton + skin weights untouched, so a full ragdoll drives it.
  const smeshes = []; let minY = Infinity, maxY = -Infinity;
  piece.traverse((o) => { if (o.isSkinnedMesh && o.geometry.index) { o.geometry.computeBoundingBox(); const bb = o.geometry.boundingBox; if (bb) { minY = Math.min(minY, bb.min.y); maxY = Math.max(maxY, bb.max.y); smeshes.push(o); } } });
  if (smeshes.length && Number.isFinite(minY)) {
    const waist = minY + (maxY - minY) * 0.5;
    for (const o of smeshes) {
      const geo = o.geometry.clone(); o.geometry = geo; // don't touch the shared original
      const pos = geo.attributes.position, src = geo.index.array, keep = [];
      for (let t = 0; t < src.length; t += 3) {
        const a = src[t], b = src[t + 1], c = src[t + 2];
        const my = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
        if ((my >= waist) === keepTop) keep.push(a, b, c);
      }
      geo.setIndex(keep);
    }
  }
  // The helmet is a separate mesh on the head bone — keep it only on the top half.
  if (!keepTop) piece.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) o.visible = false; });
  piece.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; } });
  const bones = []; piece.traverse((o) => { if (o.isBone) bones.push(o); });
  const g = new THREE.Group(); g.add(piece); g.visible = false; scene.add(g);
  const ragdoll = physics ? new TackleRagdoll(physics) : null;
  if (ragdoll) ragdoll.bind(piece);
  return { g, piece, bones, ragdoll, bit, active: false };
}
const _tearHD = new THREE.Vector3(), _tearCV = new THREE.Vector3();
function tearInHalf(ch, hx, hz, power) {
  if (!TUNE.gore) return; // gore disabled (debug)
  if (!ch.model || ch.torn) return;
  if (!ch._torn) ch._torn = { top: buildHalf(ch, true, 0x1000), bottom: buildHalf(ch, false, 0x2000) };
  // The original body is replaced by the two halves — drop its ragdoll.
  if (ch.ragdoll && ch.ragdoll.active) ch.ragdoll.dispose();
  ch.ragdolling = false;
  const T = ch._torn, src = ch.bones;
  const l = Math.hypot(hx, hz) || 1; _tearHD.set(hx / l, 0, hz / l);
  const bvx = ch.vel ? ch.vel.x : 0, bvz = ch.vel ? ch.vel.z : 0;
  for (const half of [T.top, T.bottom]) {
    const dst = half.bones; // pose the clone to the victim's CURRENT pose (full, incl. scale → valid capsules)
    for (let i = 0; i < dst.length && i < src.length; i++) { dst[i].position.copy(src[i].position); dst[i].quaternion.copy(src[i].quaternion); dst[i].scale.copy(src[i].scale); }
    half.g.position.copy(ch.group.position); half.g.quaternion.copy(ch.group.quaternion); half.g.visible = true;
    half.g.updateMatrixWorld(true);
    if (half.ragdoll) {
      // Top half launches up & back; the legs drop and topple. Different collision
      // bits so the two overlapping ragdolls don't shove each other apart.
      const up = half === T.top ? 6.5 : 1.0;
      _tearCV.set(bvx * 0.4, up, bvz * 0.4);
      half.ragdoll.spawn(_tearCV, _tearHD, half === T.top ? 4 + (power || 80) / 24 : 2, half.bit, 'twist');
      half.active = half.ragdoll.active;
      if (half.active && !tornRagdolls.includes(half.ragdoll)) tornRagdolls.push(half.ragdoll);
    }
  }
  ch.model.visible = false; ch.torn = true; // swap the whole body for the two chunks
  // The carrier just got obliterated — pop the ball loose so it doesn't stick to
  // the now-hidden, undriven hand bone. (In a replay the ball follows the record.)
  if (game.state !== STATE.REPLAY && (ball.holder === ch || game.carrier === ch)) {
    ball.mode = 'dead'; ball.holder = null; ball.catcher = null; ball.targetRecv = null; ball.g = 24;
    ball.mesh.position.set(ch.group.position.x, 1.2, ch.group.position.z);
    ball.vx = _tearHD.x * 3 + bvx * 0.4; ball.vz = _tearHD.z * 3 + bvz * 0.4; ball.vy = 4.5;
    ball.spin = 0; ball.spinRate = 12;
  }
  bloodSpray(ch.group.position.x, 1.0, ch.group.position.z, 64); // geyser from the waist
  audio.bigHit();
  // Log the tear so the instant replay can re-enact it (same as helmet pops).
  if (game.state !== STATE.REPLAY) {
    const ev = game.replay.evPool.pop() || {};
    ev.type = 'tear'; ev.fi = game.replay.frames.length; ev.pIdx = game.all.indexOf(ch);
    ev.hx = hx; ev.hz = hz; ev.power = power || 80; ev.fired = false;
    game.replay.events.push(ev);
  }
}
function restoreTear(ch) {
  if (!ch.torn) return;
  ch.torn = false; ch.model.visible = true;
  if (ch._torn) {
    for (const half of [ch._torn.top, ch._torn.bottom]) {
      half.g.visible = false; half.active = false;
      if (half.ragdoll && half.ragdoll.active) half.ragdoll.dispose();
      const i = tornRagdolls.indexOf(half.ragdoll); if (i >= 0) tornRagdolls.splice(i, 1);
    }
  }
}
// Per-play safety check: guarantee every player sits on the ONE correct field
// plane with feet down — no sink / lift / lean / ragdoll residue from the prior
// play carries into the next. Run at every play start (finalizeReset + snap).
function groundPlayers() {
  for (const ch of game.all) {
    if (ch.ragdoll && ch.ragdoll.active) ch.ragdoll.dispose();
    restoreHelmet(ch); // snap a popped-off helmet back onto the head
    restoreTear(ch);   // un-split a torn-in-half body
    restoreRestPose(ch); // clean skeleton each play (no bone-position drift from ragdolls/replay)
    ch.ragdolling = false; ch.grabbing = false; ch.tauntT = 0; ch.diveT = 0;
    // Rest between plays restores only PART of the tank (more with stamina), so a
    // heavily-used player stays worn down over a drive instead of resetting fresh.
    if (ch.fatigue == null) ch.fatigue = 1;
    ch.fatigue = Math.min(1, ch.fatigue + 0.28 + (ch.rt ? ch.rt.stamina : 0.7) * 0.24);
    const p = ch.group.position, h = ch.home || { x: 0, z: 0 };
    if (!Number.isFinite(p.x)) p.x = Number.isFinite(h.x) ? h.x : 0;
    if (!Number.isFinite(p.z)) p.z = Number.isFinite(h.z) ? h.z : 0;
    p.y = 0;                                      // feet attached to the field
    ch.group.rotation.set(0, ch.heading || 0, 0); // upright — clear any lean/tilt
    ch.vel.set(0, 0, 0); ch.speed = 0;
    clampToField(ch);
  }
}
function preparePlay(teleport) {
  // Who's on the ground? They'll pop up with a get-up before walking back (only
  // on the jog-back reset, not a kickoff teleport).
  const downed = teleport ? [] : game.all.filter((ch) => ch.ragdolling || (ch.ragdoll && ch.ragdoll.active));
  clearRagdolls(); // animation clips repose every bone on the next mixer update
  // Never build a formation from a corrupted LOS (would scatter the whole lineup).
  if (!Number.isFinite(game.los)) game.los = THREE.MathUtils.clamp(0, OWN_GOAL_Z + 1, GOAL_Z - 1);
  if (!Number.isFinite(game.firstDown)) game.firstDown = game.los + game.dir * FIRST_DOWN_YDS;
  if (!game.gameOver && game.gameClock <= 0) advanceQuarter();
  battleEl.classList.add('hidden'); game.battle.tackler = null; game.battle.playCount = 0;
  game.drag.active = false; game.drag.grabbers.length = 0;
  for (const ch of game.all) {
    ch.oneShotT = 0; ch.throwAnimT = 0; ch.armPoseT = 0; ch.spinT = 0; ch.recoverT = 0; ch.grabbing = false; ch.holdHeading = false; ch.downKnock = false; ch.catchLeap = false; ch.catchPlant = false; ch.catchExposed = 0;
    ch.throwW = 0; ch.catchW = 0; ch.armW = 0; ch.battleW = 0; ch.grabW = 0; ch.sulkW = 0; ch.blockW = 0; ch.protectW = 0; ch.blocking = false; // clear overlay blends (hidden by the cut)
    restoreHelmet(ch); restoreTear(ch); // be whole BEFORE the walk-back; the dip-cut hides this restore
    // Per-player walk-back variety so they don't trudge home like robots.
    ch.resetSpeed = WALK_SPEED * (0.6 + Math.random() * 0.85); // amble .. brisk jog
    ch.resetDelay = teleport ? 0 : Math.random() * 0.8;        // staggered starts
    ch.resetCurve = (Math.random() - 0.5) * 1.1;               // curved approach path
  }
  setFumbleGlow(false);
  setupPossession();   // assign offense/defense roles for whoever has the ball
  game.replay.dir = game.dir; // freeze this play's attack direction so its replay frames it like live (giveBallTo flips game.dir at the next turnover)
  placeFormation(teleport);
  // Pop the downed players up where they fell (they then jog back during RESET).
  for (const ch of downed) if (ch.actions.getup) { ch.heading = ch.resetHeading || 0; playOneShot(ch, 'getup', 1.5, true); }
  game.controlled = game.qb; game.carrier = null; game.selected = 0;
  game.returnActive = false; game.returner = null; game.fumbleLost = false;
  ball.mode = 'carried'; ball.holder = game.qb; ball.targetRecv = null;
  ball.catcher = null; ball.secureT = 0; ball.intercept = false; ball.fromFence = false;
  selRing.visible = false; ctrlRing.visible = false;
  losLine.position.z = game.los;
  firstDownLine.position.z = THREE.MathUtils.clamp(game.firstDown, -HALF_L + 1, HALF_L - 1);
  firstDownLine.visible = !reachedGoal(game.firstDown);
  updateHUD();
}
// Enter the between-plays RESET: players (walk back to) line up while you call
// the next play over a see-through overlay. teleport=true is the kickoff/reset.
function enterReset(teleport) {
  preparePlay(teleport);
  // Snap the camera heading to the NEW attacking end so it never starts a play
  // (e.g. after a turnover) facing the wrong way.
  const face = game.dir > 0 ? 0 : Math.PI;
  cam.fwdX = Math.sin(face); cam.fwdZ = Math.cos(face);
  if (game.gameOver) {
    game.state = STATE.PRESNAP; game.choosing = false; game.snapClock = TUNE.playClock;
    if (playSelectEl) playSelectEl.classList.add('hidden'); // never strand the play picker over the finale
    if (!game.finale) startFinale(); // kick off the winners' dance party
    updateButtons();
    if (game.gauntlet && game.gauntlet.active && !game.gauntlet.champion) {
      const won = game.scoreOff >= game.scoreDef;
      setStatus(won ? `WON ${game.scoreOff}–${game.scoreDef} — tap NEXT` : `LOST ${game.scoreOff}–${game.scoreDef} — tap RETRY`);
    } else setStatus(`FINAL ${game.scoreOff}–${game.scoreDef} — tap REMATCH`);
    return;
  }
  game.state = STATE.RESET; game.resetTimer = teleport ? 0.1 : 4.0;
  openPlaySelect(); // call a play EVERY down — offense playbook, or a defensive call
  updateButtons();
}
const newPlay = () => enterReset(true);   // kickoff / game reset (snap into place)
const beginReset = () => enterReset(false); // after a play (jog back into place)
// Walk everyone toward their formation spot; once set (and a play is called),
// go to PRESNAP ready for the snap.
function updateReset(dt) {
  let settled = true;
  for (const ch of game.all) {
    if (ch.oneShotT > 0) { ch.vel.set(0, 0, 0); ch.speed = 0; settled = false; continue; } // getting up — stay put until on his feet
    const p = ch.group.position, dx = ch.home.x - p.x, dz = ch.home.z - p.z, dist = Math.hypot(dx, dz);
    if (ch.resetDelay > 0 && dist > 0.6) { // hang back a beat before heading in
      ch.resetDelay -= dt; settled = false;
      ch.vel.x *= 0.85; ch.vel.z *= 0.85; ch.speed = Math.hypot(ch.vel.x, ch.vel.z);
      ch.heading = turnToward(ch.heading, ch.resetHeading || 0, TURN_RATE * dt * 0.5);
      continue;
    }
    if (dist > 0.6) {
      settled = false;
      // Curved approach: a perpendicular bias that eases out as they near home.
      const nx = dx / dist, nz = dz / dist;
      const curve = ch.resetCurve * Math.min(1, dist / 16);
      let tx = nx - nz * curve, tz = nz + nx * curve;
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const sp = Math.min(ch.resetSpeed || WALK_SPEED, dist * 2.2); // ease in as they arrive
      const k = Math.min(1, dt * 5);
      ch.vel.x += (tx * sp - ch.vel.x) * k; ch.vel.z += (tz * sp - ch.vel.z) * k;
      p.x += ch.vel.x * dt; p.z += ch.vel.z * dt; ch.speed = Math.hypot(ch.vel.x, ch.vel.z);
      if (ch.speed > 0.3) ch.heading = turnToward(ch.heading, Math.atan2(ch.vel.x, ch.vel.z), TURN_RATE * dt);
    } else {
      ch.vel.x *= 0.6; ch.vel.z *= 0.6; ch.speed = Math.hypot(ch.vel.x, ch.vel.z);
      ch.heading = turnToward(ch.heading, ch.resetHeading || 0, TURN_RATE * dt);
    }
  }
  game.resetTimer -= dt;
  if ((settled || game.resetTimer <= 0) && !game.choosing) finalizeReset(); // wait for the play call
}
function finalizeReset() {
  for (const ch of game.all) { ch.group.position.set(ch.home.x, 0, ch.home.z); ch.vel.set(0, 0, 0); ch.speed = 0; ch.heading = ch.resetHeading || 0; }
  groundPlayers(); // per-play check: everyone on the field plane, feet down
  game.state = STATE.PRESNAP; game.snapClock = TUNE.playClock;
  if (game.userOnOffense) {
    game.controlled = game.qb; selRing.visible = true; ctrlRing.visible = false;
  } else { game.controlled = nearestToBallDefender(); selRing.visible = false; ctrlRing.visible = true; game.autoSnapT = 1.2 + Math.random() * 0.7; }
  updateButtons();
  setStatus(game.userOnOffense ? `${PLAYS[game.playIndex].name} — tap SNAP` : `${DEF_PLAYS[game.defCall].name} D — move/switch, CPU snaps`);
}

// --- Instant replay -------------------------------------------------------
// While the ball is live we record a lightweight per-frame snapshot (positions,
// headings, current clip + mixer time, ball transform). On a touchdown we play
// it back in slow motion from a cinematic broadcast angle.
const REPLAY_MAX = 1080; // ~18s at 60fps — a full play plus the TD celebration
const replayEl = document.getElementById('replay');
// Tap anywhere on the replay (or the CONTINUE button) to leave the loop — but NOT
// in manual mode, where taps drive the camera/controls (you exit via CONTINUE).
if (replayEl) {
  const cont = (e) => { if (game.replay.manual) return; e.preventDefault(); audio.unlock(); endReplay(); };
  replayEl.addEventListener('touchstart', cont, { passive: false });
  replayEl.addEventListener('mousedown', cont);
}
// ---- Instant-replay controls: an on-demand REPLAY button between plays, plus a
// MANUAL CAM toggle inside the replay (cinematic stays the default). Manual = a
// user-driven orbit camera + a pausable, scrubbable timeline. ------------------
const rpModeBtn = document.getElementById('rp-mode');
const rpPlayBtn = document.getElementById('rp-playpause');
const rpScrub = document.getElementById('rp-scrub');
const rpManualHint = document.getElementById('rp-manualhint');
const replayBtn = document.getElementById('replay-btn');
const rpContinueBtn = document.getElementById('rp-continue');
const rpControlsEl = document.getElementById('rp-controls');
// Taps on the controls must NOT bubble to the overlay's tap-to-exit handler.
if (rpControlsEl) { const stop = (e) => e.stopPropagation(); rpControlsEl.addEventListener('mousedown', stop); rpControlsEl.addEventListener('touchstart', stop, { passive: true }); }
function updateReplayControls() {
  const r = game.replay, manual = r.manual;
  if (replayEl) replayEl.classList.toggle('rp-manual', manual);
  if (rpModeBtn) { rpModeBtn.textContent = manual ? '🎬 CINEMATIC' : '🎥 MANUAL CAM'; rpModeBtn.classList.toggle('on', manual); }
  if (rpPlayBtn) { rpPlayBtn.classList.toggle('rp-hide', !manual); rpPlayBtn.textContent = r.paused ? '▶' : '❚❚'; }
  if (rpScrub) rpScrub.classList.toggle('rp-hide', !manual);
  if (rpManualHint) rpManualHint.classList.toggle('rp-hide', !manual);
}
// Restore/undo gore that's ahead of the scrub position so forward playback re-enacts it.
function rearmReplayGore(i) {
  for (const ev of game.replay.events) {
    if (ev.fired && i < ev.fi) { const ch = game.all[ev.pIdx]; if (ch) { restoreHelmet(ch); restoreTear(ch); } ev.fired = false; }
  }
}
function setReplayManual(on) {
  const r = game.replay;
  r.manual = on;
  if (on) {
    r.paused = false;
    if (rpScrub) { rpScrub.max = String(dbgScrubMax()); rpScrub.value = String(Math.round(r.i)); }
    // Frame the orbit camera on the action and follow it.
    dbgCam.target.copy(ball.mesh.position);
    dbgCam.az = game.dir > 0 ? Math.PI * 0.42 : -Math.PI * 0.58; dbgCam.el = 0.5; dbgCam.dist = 14; dbgCam.follow = true;
    camera.fov = 52; camera.updateProjectionMatrix();
  } else {
    r.snap = true; // re-frame the cinematic shot cleanly
  }
  updateReplayControls();
}
if (rpModeBtn) rpModeBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); audio.unlock(); setReplayManual(!game.replay.manual); });
if (rpPlayBtn) rpPlayBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); game.replay.paused = !game.replay.paused; updateReplayControls(); });
if (rpScrub) {
  const onScrub = (e) => { e.stopPropagation(); const r = game.replay; r.i = THREE.MathUtils.clamp(+e.target.value, 0, dbgScrubMax()); r.paused = true; rearmReplayGore(r.i); applyReplayFrame(r.i); updateReplayControls(); };
  rpScrub.addEventListener('input', onScrub);
  rpScrub.addEventListener('mousedown', (e) => e.stopPropagation());
  rpScrub.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
}
if (rpContinueBtn) rpContinueBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); audio.unlock(); endReplay(); });
if (replayBtn) replayBtn.addEventListener('click', (e) => { e.preventDefault(); audio.unlock(); if (game.replay.frames.length >= 40 && game.state !== STATE.REPLAY) startReplay(false); });
// Show the on-demand REPLAY button between plays whenever there's footage to watch.
function updateReplayButton() {
  if (!replayBtn) return;
  const s = game.state;
  const between = s === STATE.DEAD || s === STATE.RESET || s === STATE.PRESNAP;
  const show = between && !game.choosing && !game.gameOver && game.replay.frames.length >= 40;
  replayBtn.classList.toggle('hidden', !show);
}
// Capture the FINAL pose each frame as raw bone transforms (group + every bone),
// so locomotion, procedural arm poses AND ragdolls all replay exactly. A frame
// is one flat Float32Array: [ball pos3+quat4][per player: group pos3+quat4 + each
// bone pos3+quat4].
function recordFrame() {
  const all = game.all, nb = all[0].bones.length;
  const need = 7 + all.length * (7 + nb * 7);
  const f = game.replay.frames;
  // Reuse a buffer instead of churning a fresh ~10KB Float32Array every frame:
  // pull from the free-list freed by the last play, or recycle the oldest frame
  // once the ring is full (roster size is fixed, so the length matches).
  let buf;
  if (f.length >= REPLAY_MAX) {
    buf = f.shift();
    // The ring dropped frame 0 — shift every pop event's frame index to match.
    const ev = game.replay.events;
    for (let i = ev.length - 1; i >= 0; i--) { if (--ev[i].fi < 0) { game.replay.evPool.push(ev[i]); ev.splice(i, 1); } }
  } else buf = game.replay.pool.pop();
  if (!buf || buf.length !== need) buf = new Float32Array(need);
  let o = 0;
  const b = ball.mesh; const bp = b.position, bq = b.quaternion;
  buf[o++] = bp.x; buf[o++] = bp.y; buf[o++] = bp.z; buf[o++] = bq.x; buf[o++] = bq.y; buf[o++] = bq.z; buf[o++] = bq.w;
  for (const ch of all) {
    const g = ch.group, gp = g.position, gq = g.quaternion;
    buf[o++] = gp.x; buf[o++] = gp.y; buf[o++] = gp.z; buf[o++] = gq.x; buf[o++] = gq.y; buf[o++] = gq.z; buf[o++] = gq.w;
    for (const bo of ch.bones) { const p = bo.position, q = bo.quaternion; buf[o++] = p.x; buf[o++] = p.y; buf[o++] = p.z; buf[o++] = q.x; buf[o++] = q.y; buf[o++] = q.z; buf[o++] = q.w; }
  }
  f.push(buf);
  // Capture the flame state too (so ON FIRE / turbo fx replay on the right body).
  // Recycle the per-frame fx record object the same way.
  const fs = computeFlame();
  const fx = game.replay.fx;
  const rec = fx.length >= REPLAY_MAX ? fx.shift() : (game.replay.fxPool.pop() || {});
  rec.pIdx = fs.player ? game.all.indexOf(fs.player) : -1; rec.pCol = fs.pCol; rec.ballCol = fs.ballCol;
  fx.push(rec);
}
// Broadcast camera presets the replay cycles through, one per loop (azimuth
// around the ball, distance, height, fov, slow orbit speed).
const REPLAY_ANGLES = [
  { name: 'SIDELINE',  az: Math.PI * 0.42,  dist: 13, height: 3.4, fov: 40, orbit: 0.0016 },
  { name: 'SKY CAM',   az: Math.PI * 0.25,  dist: 11, height: 15,  fov: 46, orbit: 0.0012 },
  { name: 'REVERSE',   az: -Math.PI * 0.42, dist: 13, height: 3.4, fov: 40, orbit: -0.0016 },
  { name: 'END ZONE',  az: 0,               dist: 16, height: 4.2, fov: 38, orbit: 0.0009 },
  { name: 'LOW ANGLE', az: Math.PI * 0.7,   dist: 9,  height: 1.7, fov: 50, orbit: 0.0018 },
];
const REPLAY_SEG = 3.2; // seconds on one camera angle before a broadcast cut to the next
const rpFadeEl = document.getElementById('rp-fade');
const rpAngleEl = document.getElementById('rp-angle');
function setReplayLabel() {
  const r = game.replay;
  if (rpAngleEl) rpAngleEl.textContent = `${REPLAY_ANGLES[r.angleIdx].name}${r.loops > 0 ? ` · #${r.loops + 1}` : ''}`;
}
// highlight: bias the first pass to the signature moment — open LOW ANGLE,
// jump near the impact, and run it in slow-mo. Used for big/dirty hits.
function startReplay(highlight = false) {
  if (game.replay.frames.length < 40) return false; // not enough footage — skip
  clearRagdolls(); // physics off; the recorded bone transforms ARE the pose
  const r = game.replay;
  game.state = STATE.REPLAY;
  const last = r.frames.length - 1;
  r.rate = highlight ? 0.45 : 0.85; // slow-mo on the highlight pass
  r.i = highlight ? Math.max(0, Math.floor(last * 0.55)) : 0; // start near the hit
  r.hold = 0; r.fade = 0; r.loops = 0; r.seg = 0; r.phase = 'play'; r.snap = true;
  r.angleIdx = highlight ? 4 /* LOW ANGLE */ : Math.floor(Math.random() * REPLAY_ANGLES.length);
  // The per-frame reticle/name-tag update is skipped during REPLAY, so hide all
  // the on-field chrome now or it strands at the play's end spot through the replay.
  hideFieldChrome();
  for (const ch of game.all) { restoreHelmet(ch); restoreTear(ch); } // reset gore; the replay re-enacts it at the recorded frame
  for (const ev of r.events) ev.fired = false;  // arm the gore events for this replay pass
  if (rpFadeEl) rpFadeEl.style.opacity = '0';
  if (replayEl) replayEl.classList.remove('hidden');
  document.body.classList.add('replay-mode'); // drop the gameplay HUD; only replay chrome shows
  setReplayLabel();
  r.paused = false;
  if (rpScrub) { rpScrub.max = String(Math.max(0, r.frames.length - 1)); rpScrub.value = String(Math.round(r.i)); }
  updateReplayControls();
  if (r.manual) setReplayManual(true); // honor the sticky MANUAL preference
  audio.whistle();
  return true;
}
function applyReplayFrame(fi) {
  const f = game.replay.frames, buf = f[Math.min(f.length - 1, Math.round(fi))];
  let o = 0;
  ball.mesh.position.set(buf[o++], buf[o++], buf[o++]); ball.mesh.quaternion.set(buf[o++], buf[o++], buf[o++], buf[o++]);
  for (const ch of game.all) {
    ch.group.position.set(buf[o++], buf[o++], buf[o++]); ch.group.quaternion.set(buf[o++], buf[o++], buf[o++], buf[o++]);
    for (const bo of ch.bones) { bo.position.set(buf[o++], buf[o++], buf[o++]); bo.quaternion.set(buf[o++], buf[o++], buf[o++], buf[o++]); }
  }
}
// Loops the play forever from a fresh camera angle each pass, with a black fade
// cut between angles. Exits only when the player taps CONTINUE (endReplay).
function updateReplay(dt) {
  const r = game.replay, f = r.frames, last = f.length - 1;
  // MANUAL mode: you drive the camera (orbit/zoom) and the timeline (pause + scrub).
  // No auto-cuts or looping — it advances only while playing and stops at the end.
  if (r.manual) {
    if (!r.paused) {
      r.i += r.rate * game.tsFactor;
      if (r.i >= last) { r.i = last; r.paused = true; updateReplayControls(); }
      if (rpScrub) rpScrub.value = String(Math.round(r.i)); // keep the slider synced during playback
    }
    if (rpFadeEl) rpFadeEl.style.opacity = '0';
    applyReplayFrame(THREE.MathUtils.clamp(r.i, 0, last));
    for (const ev of r.events) { // re-enact gore as the timeline reaches it
      if (ev.fired || r.i < ev.fi) continue;
      ev.fired = true; const ch = game.all[ev.pIdx]; if (!ch) continue;
      if (ev.type === 'tear') tearInHalf(ch, ev.hx, ev.hz, ev.power); else popHelmet(ch, ev.hx, ev.hz, ev.power);
    }
    ensureBallVisible(); // the replay skips simStep, so keep the ball clamped on-screen here too
    driveReplayFlames(dt, r.i);
    return;
  }
  if (r.phase === 'play') {
    r.i += r.rate * game.tsFactor; // playback speed (full-play replays would drag at deep slow-mo; highlight pass is slower)
    r.seg += dt;
    if (r.i >= last) { r.i = last; r.phase = 'hold'; r.hold = 0; }
    else if (r.seg >= REPLAY_SEG) { r.phase = 'cutout'; } // mid-play broadcast cut to a new angle
    applyReplayFrame(Math.min(r.i, last));
  } else if (r.phase === 'cutout') { // quick fade to black while the action keeps running
    r.i += r.rate * game.tsFactor; applyReplayFrame(Math.min(r.i, last));
    r.fade = Math.min(1, r.fade + dt * 3.4);
    if (r.fade >= 1 || r.i >= last) {
      r.angleIdx = (r.angleIdx + 1) % REPLAY_ANGLES.length; r.seg = 0; r.snap = true; setReplayLabel();
      if (r.i >= last) { r.i = last; r.phase = 'hold'; r.hold = 0; } else r.phase = 'cutin';
    }
  } else if (r.phase === 'cutin') { // fade back up from the new angle, action continues
    r.i += r.rate * game.tsFactor; applyReplayFrame(Math.min(r.i, last));
    r.fade = Math.max(0, r.fade - dt * 3.4);
    if (r.i >= last) { r.i = last; r.phase = 'hold'; r.hold = 0; }
    else if (r.fade <= 0) { r.fade = 0; r.phase = 'play'; }
  } else if (r.phase === 'hold') {
    applyReplayFrame(last);
    r.hold += dt;
    if (r.hold > 0.8) r.phase = 'fadeout'; // freeze on the result, then cut
  } else if (r.phase === 'fadeout') {
    applyReplayFrame(last);
    r.fade = Math.min(1, r.fade + dt * 2.6);
    if (r.fade >= 1) { // fully black — switch angle and restart the play from the top
      r.angleIdx = (r.angleIdx + 1) % REPLAY_ANGLES.length; r.loops++;
      r.i = 0; r.seg = 0; r.snap = true; r.phase = 'fadein'; r.rate = 0.85; setReplayLabel(); // later loops run full-speed from the top
      for (const ch of game.all) { restoreHelmet(ch); restoreTear(ch); } // reset gore so it re-enacts this loop
      for (const ev of r.events) ev.fired = false;
    }
  } else { // fadein: replay runs from the start while we fade back up from black
    r.i += r.rate * game.tsFactor; r.seg += dt; applyReplayFrame(Math.min(r.i, last));
    r.fade = Math.max(0, r.fade - dt * 2.6);
    if (r.fade <= 0) { r.fade = 0; r.phase = 'play'; }
  }
  if (rpFadeEl) rpFadeEl.style.opacity = r.fade.toFixed(3);
  // Re-enact each gore event (helmet pop or torn-in-half) as playback reaches
  // it, and drop into slow-mo so the carnage reads (slows the recorded body via
  // game.tsFactor AND the helmet/blood/torn-half physics via the sim dt).
  for (const ev of r.events) {
    if (ev.fired || r.i < ev.fi) continue;
    ev.fired = true; const ch = game.all[ev.pIdx]; if (!ch) continue;
    if (ev.type === 'tear') tearInHalf(ch, ev.hx, ev.hz, ev.power); else popHelmet(ch, ev.hx, ev.hz, ev.power);
    timeScale.bulletTime(0.12, 1.0, 1.3); // slow-mo the gore in the replay
  }
  ensureBallVisible(); // the replay skips simStep, so keep the ball clamped on-screen here too
  driveReplayFlames(dt, r.i); // ON FIRE / turbo flames follow the replayed bodies
}
function endReplay() {
  if (game.state !== STATE.REPLAY) return;
  if (replayEl) { replayEl.classList.add('hidden'); replayEl.classList.remove('rp-manual'); }
  dbgCam.follow = false; game.replay.paused = false; // leave manual state clean (the toggle pref persists)
  if (rpFadeEl) rpFadeEl.style.opacity = '0';
  document.body.classList.remove('replay-mode'); // restore the gameplay HUD
  if (ballFlame) { ballFlame.update(0, 0, 0, 0, null); playerFlame.update(0, 0, 0, 0, null); } // clear replay flames
  recycleReplayBuffers();
  beginReset(); // possession was already set when the play ended
}
// Move this play's recorded buffers onto the free-lists (capped) so the next
// play reuses them instead of allocating, then clear the live arrays.
function recycleReplayBuffers() {
  const r = game.replay;
  for (const b of r.frames) r.pool.push(b);
  for (const x of r.fx) r.fxPool.push(x);
  for (const e of r.events) r.evPool.push(e);
  r.frames.length = 0; r.fx.length = 0; r.events.length = 0;
  if (r.pool.length > REPLAY_MAX) r.pool.length = REPLAY_MAX;
  if (r.fxPool.length > REPLAY_MAX) r.fxPool.length = REPLAY_MAX;
}
// Apply a defensive call to game.defense (on top of the base assignments).
// ---- Play-calling matchup (Phase 1) ---------------------------------------
// Resolve a concept-vs-coverage edge: +1 the offense beat this coverage, -1 it
// loses to it, 0 neutral. From the OFFENSE's perspective (used for both sides).
function matchupLeverage(offPlay, defIdx) {
  const cov = COVER_ID[defIdx];
  if (!offPlay || !cov) return 0;
  if (offPlay.beats && offPlay.beats.includes(cov)) return 1;
  if (offPlay.losesTo && offPlay.losesTo.includes(cov)) return -1;
  return 0;
}
// Lock in the matchup for this snap: who called what, the leverage, and the
// derived coverage cushion/closing factors the defense AI reads.
function setMatchup(offPlay, defIdx) {
  const lev = matchupLeverage(offPlay, defIdx);
  game.matchup = { off: offPlay, defIdx, cov: COVER_ID[defIdx], lev };
  game.coverLev = lev * TUNE.matchupLeverage;
  game.coverClose = 1 - game.coverLev * 0.28; // <1 = beaten DBs close slower (separation)
}
// Situational CPU coverage call (replaces pure-random): keyed on down & distance,
// with a difficulty-scaled read and a dash of unpredictability.
function cpuDefCall() {
  const togo = toGoYds(), down = game.down, r = Math.random();
  const sharp = diff().cpuRead != null ? diff().cpuRead : 0.5; // 0..1 how well it reads (set per difficulty)
  // Occasionally just mix it up so it's never fully predictable.
  if (r < 0.16 * (1 - sharp * 0.6)) return (Math.random() * 4) | 0;
  if (togo <= 3) return r < 0.5 ? 2 : (r < 0.78 ? 0 : 3);          // short: blitz / man / spy
  if (down >= 3 && togo >= 8) return r < 0.62 ? 1 : 0;             // 3rd-and-long: zone shell
  if (togo >= 8) return r < 0.42 ? 1 : (r < 0.82 ? 0 : 2);         // medium: zone-lean mix
  return r < 0.4 ? 0 : (r < 0.7 ? 1 : (r < 0.9 ? 2 : 3));          // default mix
}
// CPU offensive concept pick. (Phase 1: non-repeating random; Phase 2 upgrades
// this to a situational, tendency-aware caller.)
function cpuOffCall() {
  let idx; do { idx = (Math.random() * PLAYS.length) | 0; } while (idx === game.cpuLastPlay && PLAYS.length > 1);
  return idx;
}
// Tendency memory: remember each actor's recent calls so the CPU can adapt and
// the scouting HUD (Phase 6) can surface them.
function recordTendency(offIdx, defIdx) {
  const t = game.tend;
  if (game.userOnOffense) { t.userOff.push(offIdx); t.cpuDef.push(defIdx); }
  else { t.cpuOff.push(offIdx); t.userDef.push(defIdx); }
  for (const k in t) if (Array.isArray(t[k]) && t[k].length > 8) t[k].shift();
}
// The most-frequent value in a short history (the "favorite"), or null if too few.
function modeOf(arr, min = 3) {
  if (!arr || arr.length < min) return null;
  const c = {}; let best = null, bn = 0;
  for (const v of arr) { c[v] = (c[v] || 0) + 1; if (c[v] > bn) { bn = c[v]; best = v; } }
  return bn >= 2 ? +best : null;
}
function applyDefCall(call) {
  const d = game.dir, L = game.los;
  const zone = (p, x, dz) => { p.job = 'zone'; p.zonePoint = new THREE.Vector3(x, 0, L + d * dz); };
  if (call === 1) {            // ZONE: corners drop to deep thirds, LB short middle
    let ci = 0; const thirds = [-15, 15, 0];
    for (const p of game.defense) { if (p.role === 'CB') zone(p, thirds[ci++] ?? 0, 16); else if (p.role === 'LB') zone(p, 0, 8); }
  } else if (call === 2) {     // BLITZ: the linebacker rushes the passer
    for (const p of game.defense) if (p.role === 'LB') p.job = 'rush';
  } else if (call === 3) {     // SPY: the linebacker shadows the QB (contain scrambles)
    for (const p of game.defense) if (p.role === 'LB') p.job = 'spy';
  } // call 0 MAN: keep the base assignments
}
function snap() {
  game.state = STATE.LIVE;
  if (game.userOnOffense) game.lastPlayIndex = game.playIndex; // remember the call we ran (for the "LAST" tag next play-select)
  game.clockStopped = false; // the snap starts the clock running again
  cam.fovKick = 5; // quick zoom punch on the snap
  cam.special = null; // drop the pre-snap hero shot
  groundPlayers(); // per-play check: every player on the field plane, feet attached
  clearPlayResult(); // wipe last play's readout
  recycleReplayBuffers(); game.replay.bigHit = false; // recycle last play's buffers, fresh footage for this play
  game.whistled = false; // the play-ending whistle hasn't blown yet
  if (game.tally) game.tally.plays++;
  game.playClock = 0; game.lastBreak = -10;
  game.play = { passer: null, target: null, catcher: null, carrier: null, tackler: null, viaPass: false, completed: false, intBy: null, sack: false }; // who did what (box score + post-play card)
  hidePlayerCards();
  game.throwCharge = 0; game.throwArmed = false; // ignore the held snap press
  // The CPU drops back then throws; pick its target now (most open at snap).
  game.cpuQBTimer = game.userOnOffense ? 0 : 1.1 + Math.random() * 0.7;
  let play, offIdx;
  if (game.userOnOffense) { offIdx = game.playIndex; play = PLAYS[offIdx] || PLAYS[0]; }
  else { offIdx = cpuOffCall(); game.cpuLastPlay = offIdx; game.cpuOffIdx = offIdx; play = PLAYS[offIdx]; }
  game.receivers.forEach((r, e) => { r.route = play.route(e, r.align.x, game.los); r.wp = 0; r.cutTimer = 0; r.job = 'route'; });
  game.offense.forEach((o) => { if (o.role === 'OL') o.job = 'block'; }); // linemen block
  game.defense.forEach((d) => {
    d.job = d.role === 'DL' ? 'rush' : d.deep ? 'zone' : 'cover'; // DL rush, S deep, rest cover
    if (d.deep) d.zonePoint = new THREE.Vector3(0, 0, game.los + game.dir * 18);
  });
  // Defensive scheme: your call on D; a thinking, situational call on your drives.
  let defIdx;
  if (!game.userOnOffense) {
    defIdx = game.defCall;
    applyDefCall(defIdx);
    if (!game.controlled || !game.defense.includes(game.controlled)) game.controlled = nearestToBallDefender();
    ctrlRing.visible = true; selRing.visible = false;
  } else { defIdx = cpuDefCall(); applyDefCall(defIdx); }
  game.cpuDefIdx = defIdx;
  // Resolve the concept-vs-coverage matchup for this snap (drives the leverage
  // the coverage AI reads + the post-play "why").
  setMatchup(play, defIdx);
  // Real pressure when BLITZ is on: the QB feels it (a hurried throw / sack window).
  if (COVER_ID[defIdx] === 'blitz') {
    if (game.userOnOffense) { /* user must beat it with the call/quick game */ }
    else game.cpuQBTimer = Math.min(game.cpuQBTimer, 0.7 + Math.random() * 0.4); // CPU QB hurried under your blitz
  }
  recordTendency(offIdx, defIdx);
  audio.hike();
  if (play.run) {                          // RUN PLAY: hand it to the back and go
    const rb = game.receivers[3];
    game.offense.forEach((o) => { if (o !== rb && o.role !== 'QB') o.job = 'block'; }); // everyone blocks
    ball.holder = rb; rb.jukeTimer = 0;
    enterRun(rb, 'Handoff — find a lane!');
    return;
  }
  setStatus(game.userOnOffense ? 'Find an open receiver, then THROW' : 'Defense! Stop the throw');
  updateButtons();
}
// The defender nearest to the spot the player should defend (the QB's likely
// target area): nearest to the ball at snap; used to pick who you control.
function nearestToBallDefender() {
  const bp = ball.mesh ? ball.mesh.position : game.qb.group.position;
  let best = null, bestD = Infinity;
  for (const d of game.defense) { if (d.ragdolling) continue; const dd = dist2(px(d), bp); if (dd < bestD) { bestD = dd; best = d; } }
  return best || game.defense[0];
}
// Pre-snap: keep the controlled player on its own side of the LOS (offense can
// roam behind the line but not cross it; the defender stays on the D side).
function clampPreSnap(c) {
  const rel = game.dir * (c.group.position.z - game.los);
  if (game.userOnOffense) { if (rel > -1) c.group.position.z = game.los - game.dir; }
  else { if (rel < 0.5) c.group.position.z = game.los + game.dir * 0.5; }
}
// Pre-snap: cycle which of your players you control (your team).
function switchControlled() {
  const team = game.userOnOffense ? game.offense : game.defense;
  const list = team.filter((p) => !p.ragdolling);
  if (!list.length) return;
  game.controlled = list[(list.indexOf(game.controlled) + 1) % list.length];
  ctrlRing.visible = true;
}
const PASS_G = 10.7;      // gravity, yd/s^2 (~9.8 m/s^2)
const PASS_VMAX = 44;     // arm strength: max launch speed, yd/s (snappier throws)
const BALL_NUDGE = 7;     // in-flight steering (yd/s^2 of redirect) — ON FIRE only, subtle

// Real ballistics: power sets the launch ANGLE (tap = lofted lob, hold = flat
// bullet); the speed is solved to actually reach the receiver, capped by arm
// strength — so deep throws naturally arc higher and bullets need real zip.
function throwBall(power) {
  const p = THREE.MathUtils.clamp(power, 0, 1);
  const recv = game.receivers[game.selected];
  const from = ball.mesh.position.clone();
  const angle = THREE.MathUtils.lerp(0.55, 0.17, p); // ~31° lob -> ~10° bullet (flatter/faster)
  const sin2 = Math.sin(2 * angle);

  // Solve speed/angle for a target distance d, then re-lead by the flight time
  // (a few iterations so the lead converges on where the receiver will be).
  let tx = recv.group.position.x, tz = recv.group.position.z, t = 0.5;
  for (let i = 0; i < 4; i++) {
    const d = Math.max(0.5, Math.hypot(tx - from.x, tz - from.z));
    let th = angle;
    let v = Math.sqrt(PASS_G * d / sin2);          // speed to reach d at this angle
    if (v > PASS_VMAX) {                            // arm maxed: flatten less, arc more
      v = PASS_VMAX;
      const s = THREE.MathUtils.clamp(PASS_G * d / (v * v), 0, 1);
      th = Math.max(angle, 0.5 * Math.asin(s));     // raise the angle until it carries
    }
    const vh = v * Math.cos(th);
    t = d / vh;
    ball._solV = v; ball._solTh = th; ball._solVh = vh;
    // Lead the moving receiver by the flight time.
    tx = recv.group.position.x + recv.vel.x * t;
    tz = recv.group.position.z + recv.vel.z * t;
  }
  // Slight inaccuracy: the QB isn't perfect (bullets are tighter than lobs, and
  // long throws drift more) — but mostly on target so it's catchable.
  // QB SKILL tightens the throw (accurate passers miss by less).
  const acc = 1.3 - (game.qb.rt ? game.qb.rt.skill : 0.8) * 0.75; // ~0.9 (elite) .. ~1.2 (poor)
  const errMag = THREE.MathUtils.lerp(0.9, 0.35, p) * THREE.MathUtils.clamp(t / 1.2, 0.5, 1.4) * acc * (game.qb.cpu ? diff().cpuAcc : 1);
  const ea = Math.random() * Math.PI * 2;
  tx = clampX(tx + Math.cos(ea) * errMag);
  tz = THREE.MathUtils.clamp(tz + Math.sin(ea) * errMag, -HALF_L + 1, HALF_L - 1);
  const d = Math.max(0.5, Math.hypot(tx - from.x, tz - from.z));
  const dirx = (tx - from.x) / d, dirz = (tz - from.z) / d;
  ball.vx = dirx * ball._solVh;
  ball.vz = dirz * ball._solVh;
  ball.vy = ball._solV * Math.sin(ball._solTh);
  ball.g = PASS_G;
  ball.startY = from.y; ball.airTime = 0; ball.flightTime = d / ball._solVh;
  // Spiral tighter/faster with arm strength.
  ball.spin = 0; ball.spinRate = THREE.MathUtils.lerp(20, 52, p);
  ball.to.set(tx, 0, tz); ball.targetRecv = recv; ball.intRolled = false; ball.hitFence = false;
  ball.mode = 'flying';
  // Arm the user catch on your own pass (the human makes the play on his receiver).
  game.userCatch = (TUNE.userCatch && game.userOnOffense && recv && !recv.cpu)
    ? { on: true, open: false, armed: false, armEarly: false, buffered: null, style: 'rac', score: 0, recv }
    : { on: false };
  if (!game.userCatch.on) hideCatchRow();
  if (game.play) { game.play.passer = game.qb; game.play.target = recv; game.play.viaPass = true; } // box score: the throw
  game.state = STATE.AIR; selRing.visible = false;
  // Procedural throwing motion, varied by the throw: face the target and let
  // the over-the-top amount track the launch angle (lob = more loft).
  game.qb.heading = Math.atan2(dirx, dirz);
  game.qb.throwAnimT = THROW_ANIM_DUR;
  game.qb.throwLaunch = ball._solTh;
  audio.throwPass();
  setStatus(p > 0.6 ? 'Bullet!' : 'Pass is up…'); updateButtons();
}
function enterRun(player, msg) {
  game.state = STATE.RUN;
  if (game.play && !game.play.carrier) game.play.carrier = player; // box score: ball carrier (handoff/scramble; catch keeps the catcher credit)
  game.carrier = player; player.route = null; player.holdHeading = false; // a runner faces where he runs
  ball.mode = 'carried';
  // You drive the carrier on your possession; on a CPU run you take over the
  // nearest defender to chase him down.
  game.controlled = game.userOnOffense ? player : nearestDefenderTo(px(player));
  ctrlRing.visible = true; selRing.visible = false;
  setStatus(game.userOnOffense ? msg : 'CPU running — make the tackle!'); updateButtons();
}

// ---- CPU offense (you're on defense) -------------------------------------
// Pick who you control: the defender nearest the ball / carrier.
function switchDefender() {
  const ref = game.carrier ? game.carrier.group.position : (ball.mesh ? ball.mesh.position : game.qb.group.position);
  let best = null, bestD = Infinity;
  for (const d of game.defense) { if (d.ragdolling) continue; const dd = dist2(px(d), ref); if (dd < bestD) { bestD = dd; best = d; } }
  if (best) { game.controlled = best; ctrlRing.visible = true; }
}
// The CPU QB's best option: the most open receiver, biased downfield.
function mostOpenReceiver() {
  let best = null, bestScore = -Infinity;
  for (const wr of game.receivers) {
    if (wr.ragdolling) continue;
    const cov = nearestDefenderTo(px(wr));
    const open = cov ? distXZ(px(wr), px(cov)) : 20;
    const downfield = Math.max(0, game.dir * (wr.group.position.z - game.los));
    const score = open + downfield * 0.12 + (wr.rt ? wr.rt.skill * 3 : 0); // favor open AND skilled hands
    if (score > bestScore) { bestScore = score; best = wr; }
  }
  return best;
}
// CPU quarterback: backpedal a beat, then throw to the most open man (or take
// off scrambling if it's covered too long).
function cpuQB(dt) {
  const qb = game.qb;
  game.cpuQBTimer -= dt;
  const rusher = nearestDefenderTo(px(qb));
  const pressure = rusher ? distXZ(px(rusher), px(qb)) : 99;
  const pressured = pressure < 3.2; // feel the heat earlier so he doesn't just eat sacks
  // Drop back, then hold the pocket; flee sideways if a rusher closes.
  if (game.cpuQBTimer > 0.35 && !pressured) { qb.desired = { x: 0, z: -game.dir }; qb.turbo = false; }
  else qb.desired = { x: 0, z: 0 };
  if (ball.mode !== 'carried') return;
  const target = mostOpenReceiver();
  // Square up to the target (or straight downfield) and HOLD that facing so the
  // backpedal/scramble velocity can't spin him around — no more throwing backwards.
  qb.holdHeading = true;
  const fz = target ? target.group.position : { x: 0, z: qb.group.position.z + game.dir };
  qb.heading = Math.atan2(fz.x - qb.group.position.x, fz.z - qb.group.position.z);
  const cov = target ? nearestDefenderTo(px(target)) : null;
  const sep = (target && cov) ? distXZ(px(target), px(cov)) : 9;
  const ready = game.cpuQBTimer <= 0;   // dropback finished — only then look to throw
  // Under real pressure he'll heave it (even into a tighter window) rather than
  // take the sack; if there's nothing, he scrambles or throws it away.
  const desperate = game.cpuQBTimer < -1.2 || (pressured && pressure < 2.1);
  if (target && ((ready && (sep > 1.8 || pressured)) || desperate)) {
    // Throw to the open man; longer throws get more zip. Accuracy = QB skill.
    ball.targetRecv = target; game.selected = game.receivers.indexOf(target);
    throwBall(THREE.MathUtils.clamp(0.2 + distXZ(px(qb), px(target)) / 50, 0.2, 0.85));
  } else if (pressured && (pastLine(qb) || pressure < 2.4)) {
    enterRun(qb, ''); audio.say('scramble'); // feeling the rush with no throw — take off and scramble
  } else if (pressured) {
    const away = Math.sign(qb.group.position.x - (rusher ? rusher.group.position.x : 0)) || 1;
    qb.desired = { x: away, z: game.dir * 0.3 }; qb.turbo = true; // climb/escape the pocket
  } else if (ready) {
    game.cpuQBTimer = 0.25; // nobody open yet — keep scanning
  }
}
// A CPU ball carrier (after a CPU catch/scramble) seeks the end zone while you
// chase with a defender; your teammates pursue and tackle on contact.
function updateCpuRun(dt, turboOn, actionEdge) {
  const c = game.carrier;
  if (!c) { endPlay('incomplete', game.los); return; }
  // Re-acquire control if our man got knocked down (or was never set).
  if (!game.controlled || game.controlled.ragdolling) switchDefender();
  const o = game.controlled;
  if (o && o.diveCd > 0) o.diveCd -= dt;
  // An airborne dive in progress: carry the leap, then connect or eat the turf.
  if (o && o.diveT > 0) {
    o.diveT -= dt;
    o.group.position.x += o.vel.x * dt; o.group.position.z += o.vel.z * dt; // momentum carries the dive
    o.speed = Math.hypot(o.vel.x, o.vel.z); clampToField(o);
    if (distXZ(px(o), px(c)) <= 1.9) { o.diveT = 0; beginTackle(o); return; } // dive connects
    if (o.diveT <= 0) knockdownDefender(o); // whiffed the dive -> hits the turf, carrier slips away
  } else if (actionEdge && o) {
    const dx = c.group.position.x - o.group.position.x, dz = c.group.position.z - o.group.position.z;
    const l = Math.hypot(dx, dz) || 1; o.heading = Math.atan2(dx, dz);
    if (l <= 2.4) { // in range: an immediate lunge tackle
      const burst = o.baseSpeed * 1.25; o.vel.x = dx / l * burst; o.vel.z = dz / l * burst;
      playOneShot(o, 'tackle', 0.4); beginTackle(o); return;
    }
    if (l <= 4.2 && o.diveCd <= 0) diveTackle(o, dx / l, dz / l); // just out of reach: leave your feet
  }
  // Carrier AI: head for the goal, cut from the nearest defender.
  let steer = seek(px(c), THREE.MathUtils.clamp(c.group.position.x * 0.5, -14, 14), atkGoalZ() + game.dir * 3);
  const chaser = nearestDefenderTo(px(c));
  if (chaser) { const ax = c.group.position.x - chaser.group.position.x, al = Math.abs(ax) || 1; steer = addSteer(steer, { x: ax / al, z: 0 }, 0.5); }
  c.desired = addSteer(steer, separation(c, game.offense, 2.5), 0.2); c.turbo = true;
  if (game.controlled && !game.controlled.ragdolling && game.controlled.diveT <= 0) { const top = game.controlled.baseSpeed * (turboOn ? TUNE.turboMult : 1); controlledMove(game.controlled, dt, top); } // (the dive integrates its own momentum)
  updateOffense(dt); updateDefense();
  for (const ch of game.all) if (ch !== game.controlled && !ch.ragdolling) applySteer(ch, dt);
  aiCarrierMoves(c, game.defense, game.dir, dt); // CPU hurdles / kicks off the fence too
  checkRunOutcome(); // your defenders tackle the carrier on contact
}
// --- Interception runback -------------------------------------------------
// The defender who picked it off carries the ball back toward the offense's
// OWN goal (-Z). YOU take over the nearest offensive player and try to chase
// him down before he scores. Reaching the end zone is a defensive TD (pick
// six); getting tackled is a turnover (offense gets the ball back).
function nearestOffender(point) {
  let best = null, bestD = Infinity;
  for (const o of game.offense) {
    if (o.ragdolling) continue;
    const d = dist2(px(o), point); if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}
function pursuitPoint(chaser, target) {
  const cp = px(chaser), tp = px(target);
  const spd = Math.max(7, chaser.baseSpeed);
  let t = distXZ(tp, cp) / spd;
  for (let i = 0; i < 3; i++) {
    const fx = tp.x + target.vel.x * t, fz = tp.z + target.vel.z * t;
    t = Math.hypot(fx - cp.x, fz - cp.z) / spd;
  }
  t = Math.min(t, 0.7);
  return { x: tp.x + target.vel.x * t, z: tp.z + target.vel.z * t };
}
function beginReturn(returner, kind = 'pick') {
  game.state = STATE.RETURN;
  game.returnActive = true; game.returner = returner;
  game.carrier = returner;          // so the ball follows him + TACKLE settle works
  ball.mode = 'carried'; ball.holder = returner;
  setFumbleGlow(false);
  // A turnover always goes to the DEFENSE; whether the USER controls the returner
  // or a chaser depends on whose drive it was. !userOnOffense => the user's team
  // (on defense) recovered, so the user runs it back; otherwise the user chases.
  const userReturning = !game.userOnOffense;
  if (kind === 'pick' && userReturning) creditUserStat('ints', 'INTERCEPTION'); // the user's defense picked it off
  if (userReturning) {
    game.controlled = returner;
    showBanner(kind === 'fumble' ? 'SCOOP & SCORE!' : 'PICKED OFF!', '#3fe08a'); audio.cheer(0.5);
    setStatus(kind === 'fumble' ? 'Your ball — take it back!' : 'Your pick — run it back!');
  } else {
    game.controlled = nearestOffender(returner.group.position) || game.qb;
    showBanner(kind === 'fumble' ? 'FUMBLE!' : 'INTERCEPTED!', '#ff5a3a');
    setStatus(kind === 'fumble' ? 'They recovered — chase him down!' : 'Intercepted — chase him down!');
  }
  ctrlRing.visible = true; selRing.visible = false;
  updateButtons();
}
function updateReturn(dt, turboOn, fireMul) {
  const r = game.returner;
  if (!r) { game.returnActive = false; endPlay('incomplete', game.los); return; }
  const rp = r.group.position;
  const userReturning = game.controlled === r;
  const retGoalZ = game.dir > 0 ? OWN_GOAL_Z : GOAL_Z; // the returner attacks the offense's OWN end
  // Returner AI heads for that end, cutting back from the nearest chaser (only when
  // the CPU is returning — when the user recovered, the user drives him).
  if (!userReturning) {
    let steer = seek(px(r), THREE.MathUtils.clamp(rp.x * 0.4, -14, 14), retGoalZ + game.dir * 3);
    const chaser = nearestOffender(rp);
    if (chaser) {
      const ax = rp.x - chaser.group.position.x, al = Math.abs(ax) || 1;
      steer = addSteer(steer, { x: ax / al, z: 0 }, 0.55); // juke laterally away
    }
    r.desired = addSteer(steer, separation(r, game.defense, 2.5), 0.2); r.turbo = true;
  }
  // The offense (chasers) pursue with cut-off angles; the player drives the controlled man.
  for (const o of game.offense) {
    if (o === game.controlled || o.ragdolling) continue;
    const ip = pursuitPoint(o, r);
    o.desired = seek(px(o), ip.x, ip.z); o.turbo = dist2(px(o), rp) > 16;
  }
  // The returner's teammates trail to escort (and stay out of the way).
  for (const d of game.defense) {
    if (d === r || d === game.controlled || d.ragdolling) continue;
    d.desired = seek(px(d), rp.x, rp.z + game.dir * 3); d.turbo = false;
  }
  const top = game.controlled.baseSpeed * fireMul * (turboOn ? TUNE.turboMult : 1);
  controlledMove(game.controlled, dt, top);
  for (const ch of game.all) if (ch !== game.controlled && !ch.ragdolling) applySteer(ch, dt);
  if (!userReturning) aiCarrierMoves(r, game.offense, -game.dir, dt); // CPU returner hurdles chasers / kicks off the fence
  // Outcomes: house call (returner reaches the offense's own goal), or run down.
  const scored = game.dir > 0 ? rp.z <= OWN_GOAL_Z : rp.z >= GOAL_Z;
  if (scored) { endReturn('returnTD', rp.z); return; }
  for (const o of game.offense) {
    if (o.ragdolling) continue;
    if (Math.hypot(o.group.position.x - rp.x, o.group.position.z - rp.z) <= TUNE.tackleReach) { tackleReturner(o); return; }
  }
}
function tackleReturner(tackler) {
  const r = game.returner, rp = r.group.position;
  if (!physics) { endReturn('tackle', rp.z); return; }
  const hitX = rp.x - tackler.group.position.x, hitZ = rp.z - tackler.group.position.z;
  const hl = Math.hypot(hitX, hitZ) || 1;
  const hitDir = new THREE.Vector3(hitX / hl, 0, hitZ / hl);
  const closing = Math.hypot(tackler.vel.x - r.vel.x, tackler.vel.z - r.vel.z);
  const big = tackler.turbo || closing > 8;
  spawnRagdoll(r, new THREE.Vector3(r.vel.x, 0, r.vel.z), hitDir,
    THREE.MathUtils.clamp(2 + closing * 0.45, 2.5, 8), 0x0002, pickVariant(big, 1, closing, hitX, hitZ));
  tackler.heading = Math.atan2(hitX, hitZ); playOneShot(tackler, 'tackle', 0.45);
  game.state = STATE.TACKLE; game.tackleTimer = 2.0; game.tackleSpotZ = rp.z; // returnActive still set
  blowWhistle(); // returner is down — whistle immediately, not after the ragdoll settles
  ctrlRing.visible = false; updateButtons();
  shake.kick(hitX, hitZ, big ? 0.8 : 0.4);
  burst(rp.x, 1.0, rp.z, 0xe8d9a0, big ? 16 : 10, big ? 8 : 6);
  if (big) { timeScale.bulletTime(0.09, 0.6, 1.05); hitZoom(1.6, 1.35); shake.add(0.5); audio.bigHit(); impactFlash(true); showBanner('STOPPED!', '#bfffd0', { power: hitPower(tackler, closing, 1, true) }); }
  else { timeScale.bulletTime(0.22, 0.4, 0.7); hitZoom(0.9); shake.add(0.18); audio.hit(0.6); }
  setStatus('Return stopped!');
}
function endReturn(result, spotZ) {
  const userReturned = !game.userOnOffense; // the user's team (on defense) recovered & ran it back
  // Box score + post-play card for the takeaway (the defender who got it, + the QB
  // who threw the pick) — before game.returner is cleared below.
  const returner = game.returner, pl = game.play;
  if (pl && pl.viaPass && pl.intBy) {
    if (pl.passer && pl.passer.stats) { pl.passer.stats.att++; pl.passer.stats.intThrown++; }
    if (pl.intBy.stats) pl.intBy.stats.intCaught++;
  }
  if (playerCardsEl && returner) {
    const cards = [{ player: returner, kind: 'def' }];
    if (pl && pl.viaPass && pl.passer) cards.push({ player: pl.passer, kind: 'pass' });
    playerCardsEl.innerHTML = cards.map((x) => playerCardHTML(x.player, x.kind)).join('');
    playerCardsEl.classList.remove('hidden');
  }
  game.returnActive = false; game.returner = null;
  game.state = STATE.DEAD; game.deadTimer = 1.1;
  game.clockStopped = true; // a return TD or turnover stops the clock
  ball.mode = 'rest';
  selRing.visible = false; ctrlRing.visible = false; updateButtons();
  if (result === 'returnTD') {
    audio.touchdown(); shake.add(0.3); timeScale.slow(0.5, 0.4);
    if (userReturned) {
      game.scoreOff += 7; flashScreen(); confetti(spotZ); benchReact(); game.deadTimer = 2.4;
      showBanner('TOUCHDOWN!', '#3fe08a'); setStatus('Took it to the house!'); audio.say('td', { force: true, swell: 0.8 });
      giveBallTo(false, driveStartForUser(false)); // CPU receives after the score
    } else {
      game.scoreDef += 7; douseFire();
      showBanner('DEFENSIVE TD', '#5a8bff'); setStatus('Returned for a touchdown!'); audio.say('td', { force: true, swell: 0.8 });
      giveBallTo(true, driveStartForUser(true)); // you get the ball back at your 20
    }
  } else {
    blowWhistle();
    if (userReturned) { showBanner('TAKEAWAY!', '#3fe08a'); setStatus('Your ball!'); }
    else { douseFire(); showBanner('TURNOVER', '#ffd23a'); setStatus('CPU ball'); }
    giveBallTo(userReturned, spotZ); // the recovering team keeps it where the return ended
  }
  updateHUD();
}
// The TACKLE button during a runback: a diving lunge — burst at the returner
// and, if close enough, complete the tackle with an extended reach.
function returnDive() {
  const o = game.controlled, r = game.returner;
  if (!o || !r) return;
  const dx = r.group.position.x - o.group.position.x, dz = r.group.position.z - o.group.position.z;
  const l = Math.hypot(dx, dz) || 1;
  const burst = o.baseSpeed * 1.25;
  o.vel.x = dx / l * burst; o.vel.z = dz / l * burst; o.heading = Math.atan2(dx, dz);
  playOneShot(o, 'tackle', 0.4);
  if (l <= 2.4) tackleReturner(o); // diving tackle reaches a touch farther
}
// Route the end of a tackle: an interception runback, a lost fumble, or a
// normal tackle (down & distance).
// Blow the play-dead whistle exactly once per play. Called the instant a player
// is down (at tackle contact) so it doesn't wait for the ragdoll to settle, and
// again as a fallback when the play formally ends (no-op if already blown).
function blowWhistle() {
  if (game.whistled) return;
  game.whistled = true;
  audio.whistle();
}
function resolveTackleEnd() {
  if (game.returnActive) { endReturn('tackle', game.tackleSpotZ); return; }
  if (game.fumbleLost) { game.fumbleLost = false; endPlay('fumble', game.tackleSpotZ); return; }
  endPlay('tackle', game.tackleSpotZ);
}
// Hand the ball to a team at a spot (own-20 on a score, the dead spot on a
// turnover). Sets the new direction-aware down & distance for the next play.
const driveStartForUser = (u) => (u ? 1 : -1) * DRIVE_START; // that team's own 20
function giveBallTo(userBall, losZ) {
  game.userOnOffense = userBall;
  const nd = userBall ? 1 : -1;
  game.dir = nd; // keep dir in sync now so the HUD/camera read it correctly in DEAD
  if (!Number.isFinite(losZ)) losZ = game.los; // never let a bad spot poison the LOS
  game.los = THREE.MathUtils.clamp(losZ, OWN_GOAL_Z + 1, GOAL_Z - 1);
  game.down = 1;
  game.firstDown = game.los + nd * FIRST_DOWN_YDS;
}
function endPlay(result, endZ) {
  game.state = STATE.DEAD; game.deadTimer = 1.1;
  hideFieldChrome(); updateButtons(); // never let a reticle/turbo ring outlive the play
  const userHad = game.userOnOffense;
  recordStats(result, endZ); showPlayerCards(result); // box score + post-play cards (before giveBallTo moves the LOS)
  let tackleGain = 0; // yards on a tackle/oob result — drives the big-play replay
  game.clockStopped = true; // scores / incompletes / turnovers stop the clock; an in-bounds tackle re-starts it below
  if (result === 'TD') {
    audio.touchdown(); timeScale.slow(0.45, 0.5); shake.add(0.3);
    flashScreen(); confetti(endZ); benchReact(); // flash + shower + benches erupt
    if (userHad) {
      game.scoreOff += 7; game.fireCount++;
      const scorer = celebrateTD(); game.deadTimer = 2.6; // let the dance play before the replay
      // Stadium-level celebration: HOME (player's) team only, and only sometimes
      // — randomly a fireworks show or a dark-arena strobe/spotlight light show.
      if (Math.random() < TUNE.celebChance) {
        game.deadTimer = 4.2; // hold the dead-ball beat so the show plays before the replay
        if (Math.random() < 0.5) startFireworksCeleb(endZ, scorer); else startLightShow(endZ);
      }
      if (game.fireCount >= 3 && !game.onFire) { game.onFire = true; setFireVisual(true); audio.fire(); showBanner('ON FIRE!', '#ff7a3a'); setStatus('3 straight TDs — ON FIRE! 🔥'); audio.say('onFire', { force: true }); }
      else { showBanner('TOUCHDOWN!', '#ffd23a'); setStatus('TOUCHDOWN! 🏈'); audio.say('td', { force: true, swell: 0.8 }); }
    } else {
      game.scoreDef += 7; douseFire(); showBanner('CPU TOUCHDOWN', '#5a8bff'); setStatus('CPU scores'); audio.say('td', { force: true, swell: 0.8 }); // away team: no stadium celebration
    }
    setPlayResult('TOUCHDOWN', 'gain');
    giveBallTo(!userHad, driveStartForUser(!userHad)); // other team gets the ball
  } else if (result === 'intercept' || result === 'fumble') {
    if (result !== 'intercept') blowWhistle();
    if (userHad) douseFire(); // the player coughed it up
    showBanner('TURNOVER', '#ffd23a');
    setStatus(result === 'fumble' ? 'Fumble — turnover!' : 'Intercepted!');
    setPlayResult(result === 'fumble' ? 'FUMBLE' : 'INTERCEPTED', 'loss');
    audio.say(result === 'fumble' ? 'fumble' : 'pick', { force: true });
    giveBallTo(!userHad, endZ); // the other team takes over at the spot
  } else {
    blowWhistle();
    // SAFETY: the ball carrier is down in their OWN end zone -> 2 pts to the
    // defense, and the conceding team free-kicks (the other team takes over).
    if (result !== 'incomplete' && game.dir * endZ <= -GOAL_Z) {
      if (userHad) { game.scoreDef += 2; douseFire(); showBanner('SAFETY', '#ff5a3a'); setStatus('Safety — 2 points for the defense'); setPlayResult('SAFETY', 'loss'); }
      else { game.scoreOff += 2; showBanner('SAFETY!', '#3fe08a'); setStatus('Safety — you get 2!'); setPlayResult('SAFETY', 'gain'); }
      audio.say('safety', { force: true });
      giveBallTo(!userHad, driveStartForUser(!userHad)); // conceding team kicks off to the other
    } else {
      const gained = result === 'incomplete' ? 0 : game.dir * (endZ - game.los);
      tackleGain = gained;
      if (result === 'incomplete') setPlayResult('INCOMPLETE');
      else { const yr = yardResult(gained); setPlayResult(yr.text, yr.cls); game.clockStopped = false; } // a tackle/OOB keeps the clock running
      const _base = result === 'incomplete' ? 'Incomplete'
        : result === 'oob' ? `Out of bounds (+${Math.max(0, Math.round(gained))})`
          : `${userHad ? 'Tackled' : 'CPU down'} (+${Math.max(0, Math.round(gained))})`;
      const _reason = matchupReason(result, gained); // the "why" (Phase 1)
      setStatus(_reason ? `${_base} — ${_reason}` : _base);
      showReason(_reason);
      const spot = THREE.MathUtils.clamp(result === 'incomplete' ? game.los : endZ, OWN_GOAL_Z + 1, GOAL_Z - 1);
      const gotFirst = game.dir > 0 ? spot >= game.firstDown : spot <= game.firstDown;
      if (gotFirst) { game.los = spot; game.down = 1; game.firstDown = game.los + game.dir * FIRST_DOWN_YDS; if (userHad) audio.say('firstDown'); }
      else {
        game.los = spot; game.down += 1;
        if (game.down > 4) { if (userHad) douseFire(); setStatus('Turnover on downs'); giveBallTo(!userHad, spot); game.clockStopped = true; } // turnover on downs stops the clock
      }
    }
  }
  updateHUD();
  // Broadcast replay: a big gang-tackle cuts to it immediately; a TD DEFERS it
  // to the end of the dead-ball beat so the celebration plays live first.
  const bigHit = game.replay.bigHit; game.replay.bigHit = false;
  if (result === 'TD') { game.pendingReplay = true; }
  else if (result === 'tackle' || result === 'oob') {
    // Show a replay when it's worth it: a violent/dirty hit (slow-mo highlight),
    // a big gain or a sack (a big play), or — so they show up regularly — an
    // occasional ordinary tackle. Otherwise straight to the next play.
    const bigPlay = Math.abs(tackleGain) >= 16;
    let replayed = false;
    if (bigHit) replayed = startReplay(true);            // low-angle slow-mo highlight
    else if (bigPlay || Math.random() < 0.2) replayed = startReplay(false); // multi-angle from the top
    // No replay this snap? Roll for a cosmetic post-whistle scuffle instead — it
    // needs the live field (a replay would cut away from it).
    if (!replayed && !game.gameOver && Math.random() < TUNE.fightChance)
      startPostPlayFight(game.carrier ? game.carrier.group.position.x : 0, endZ);
  } else if ((result === 'fumble' || result === 'intercept') && Math.random() < 0.5) {
    startReplay(false); // turnovers are highlight-worthy too
  }
}
// Cosmetic POST-PLAY SCUFFLE: after the whistle, a nearby defender and offensive
// player square up — the instigator throws a jab or a flying kick (pack 7) and the
// other is blown back off his feet. No flags, no yardage; pure Blitz attitude. It
// plays out during an extended dead-ball beat (only when no replay is showing, so
// the camera stays live on the field). Tunables live in TUNE (debug panel).
function startPostPlayFight(sx, sz) {
  if (!jabClip && !kickClip) return false;          // pack missing
  const spot = { x: sx, z: sz };
  const pool = (team) => game[team]
    .filter((c) => !c.ragdolling && !c.dancing && !c.sulk && c !== game.controlled)
    .map((c) => [c, distXZ(px(c), spot)])
    .filter((e) => e[1] < 9).sort((a, b) => a[1] - b[1]);
  const defs = pool('defense'), offs = pool('offense');
  if (!defs.length || !offs.length) return false;   // need an opposing pair nearby
  const attacker = defs[0][0], victim = offs[0][0];
  const ap = attacker.group.position, vp = victim.group.position;
  // Square up: attacker faces the victim, victim faces back.
  attacker.heading = Math.atan2(vp.x - ap.x, vp.z - ap.z);
  victim.heading = attacker.heading + Math.PI;
  attacker.vel.set(0, 0, 0); attacker.speed = 0;
  // Throw the swing — a jab or a flying kick — and blow the victim back.
  const move = (kickClip && (!jabClip || Math.random() < 0.5)) ? 'kick' : 'jab';
  playOneShot(attacker, move, 2.2, true);
  if (blownBackClip) playOneShot(victim, 'blownback', 2.4, true);
  const kb = TUNE.fightKnockback; // stagger the victim back along the punch line (the DEAD coast decays it)
  victim.vel.set(Math.sin(attacker.heading) * kb, 0, Math.cos(attacker.heading) * kb); victim.speed = kb;
  game.deadTimer = Math.max(game.deadTimer, 2.6); // hold the beat so the scuffle plays out
  showBanner('SCUFFLE!', '#ff7a3a'); shake.add(0.25); hitZoom(2.2, 1.05);
  return true;
}
// TD celebration: the scorer + the two nearest teammates break into their dance
// (each player's celebrate clip was picked at build for variety).
function celebrateTD() {
  game.celebrating = true;
  const scorer = game.carrier || game.controlled;
  const team = (scorer && (game.offense.includes(scorer) ? game.offense : game.defense)) || game.offense;
  const crew = [scorer, ...team
    .filter((o) => o && o !== scorer && !o.ragdolling)
    .sort((a, b) => (scorer ? dist2(px(a), px(scorer)) - dist2(px(b), px(scorer)) : 0))
    .slice(0, 3)];
  for (const o of crew) if (o && o.actions.celebrate) playOneShot(o, 'celebrate', 2.3, true);
  if (scorer) startSpecialCam('td', scorer, 2.4); // low up-angle flex/standover on the scorer
  return scorer;
}

// ---- End-of-game GRAND FINALE: a phased, cinematic celebration.
//  1) RUN   — the winners sprint joyfully around the field while a barrage of
//             fireworks fills the sky; the losers slump off to the side.
//  2) GATHER — the winners converge on midfield.
//  3) DANCE  — they form a circle and break into a looping dance party.
// Cinematic camera cuts between tracking / wide / sky / orbit shots throughout.
// Runs from FINAL until the player taps REMATCH (resetGame -> endFinale).
const FIN_RUN = 5.5, FIN_GATHER_MAX = 5.0, FIN_RADIUS = 3.8; // phase durations + dance-circle radius
function finWander() {
  return new THREE.Vector3(
    THREE.MathUtils.clamp((Math.random() - 0.5) * (HALF_W - 4) * 2, -HALF_W + 5, HALF_W - 5), 0,
    THREE.MathUtils.clamp((Math.random() - 0.5) * (HALF_L - 14) * 2, -HALF_L + 14, HALF_L - 14));
}
function startFinale() {
  const userWon = game.scoreOff >= game.scoreDef;
  const winners = (userWon ? game.teamA : game.teamB).filter((c) => c && !c.ragdolling);
  const losers = (userWon ? game.teamB : game.teamA).filter((c) => c && !c.ragdolling);
  const center = new THREE.Vector3(0, 0, 0); // midfield: the eventual dance circle
  // The circle slots the winners gather into.
  const slots = winners.map((_, i) => {
    const a = (i / Math.max(1, winners.length)) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a) * FIN_RADIUS, 0, Math.sin(a) * FIN_RADIUS);
  });
  // Winners take off on a joy-run: full speed, no fatigue, a fresh wander target.
  winners.forEach((c) => {
    c.sulk = false; c.dancing = false; c.turbo = true; c.fatigue = 1;
    c.finTarget = finWander(); c.vel.set(0, 0, 0); restoreHelmet(c);
  });
  // Losers slump in a line off to one side, turned away, heads hung.
  losers.forEach((c, i) => {
    c.group.position.set(
      THREE.MathUtils.clamp((i - (losers.length - 1) / 2) * 2.4, -HALF_W + 3, HALF_W - 3),
      0, THREE.MathUtils.clamp(HALF_L - 16, -HALF_L + 3, HALF_L - 3));
    c.heading = Math.atan2(c.group.position.x, c.group.position.z); // facing away from midfield
    c.vel.set(0, 0, 0); c.speed = 0; c.dancing = false; c.sulk = true; c.sulkPh = Math.random() * 6.283;
    if (!c.actions.sulk) setClip(c, 'idle'); // procedural sulk pose layers on idle; real clip drives itself
    restoreHelmet(c);
  });
  cam.special = null; game.celebrating = false;
  game.finale = { active: true, phase: 'run', t: 0, total: 0, winners, losers, center, slots, userWon,
    cam: { i: 0, t: 0, dur: 0, shot: null, target: null, ang: 0, snap: true } };
  const sb = document.getElementById('simbar'); if (sb) sb.classList.add('hidden'); // game's over
  startCelebParty(center.z, true); // GRAND: way more fireworks
  benchReact();
  audio.say(userWon ? 'win' : 'lose', { force: true, swell: 1 });
}
function updateFinale(dt) {
  const f = game.finale; if (!f || !f.active) return;
  f.t += dt; f.total += dt;
  if (f.phase === 'run') {
    for (const c of f.winners) {
      if (c.ragdolling) continue;
      const p = c.group.position, t = c.finTarget;
      const dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz);
      if (d < 2.4) c.finTarget = finWander();          // reached it — pick a new spot
      else { c.desired.x = dx / d; c.desired.z = dz / d; c.turbo = true; applySteer(c, dt); }
    }
    if (f.t >= FIN_RUN) { f.phase = 'gather'; f.t = 0; f.cam.shot = null; }
  } else if (f.phase === 'gather') {
    let allIn = true;
    f.winners.forEach((c, i) => {
      if (c.ragdolling) return;
      const p = c.group.position, t = f.slots[i];
      const dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz);
      if (d > 1.0) { allIn = false; c.desired.x = dx / d; c.desired.z = dz / d; c.turbo = false; applySteer(c, dt); }
      else { c.vel.set(0, 0, 0); c.speed = 0; }
    });
    if (allIn || f.t >= FIN_GATHER_MAX) { // snap into a clean circle and start dancing
      f.phase = 'dance'; f.t = 0; f.cam.shot = null;
      f.winners.forEach((c, i) => {
        const s = f.slots[i];
        c.group.position.set(s.x, 0, s.z);
        c.heading = Math.atan2(f.center.x - s.x, f.center.z - s.z); // face the middle
        c.vel.set(0, 0, 0); c.speed = 0; c.dancing = true;
      });
    }
  } else { // dance
    for (const c of f.winners) {
      c.speed = 0; c.vel.set(0, 0, 0);
      if (!c.actions.dance && c.oneShotT <= 0 && c.actions.celebrate) playOneShot(c, 'celebrate', 1.5 + Math.random() * 0.8, true);
    }
  }
  for (const c of f.losers) { c.speed = 0; c.vel.set(0, 0, 0); }
}
function endFinale() {
  const f = game.finale; if (!f) return;
  for (const c of [...f.winners, ...f.losers]) { c.sulk = false; c.dancing = false; c.turbo = false; }
  game.finale = null; stopCelebParty();
  const sb = document.getElementById('simbar'); if (sb) sb.classList.remove('hidden');
}
// Cinematic finale camera: cuts between shot types every few seconds. The shot
// menu depends on the phase (chase the runners early, orbit the circle late);
// every shot keeps the fireworks-filled sky in play.
function driveFinaleCam(dt) {
  const f = game.finale, c = f.center, cm = f.cam;
  cm.t += dt;
  const menu = f.phase === 'dance' ? ['orbit', 'sky', 'wide']
    : f.phase === 'gather' ? ['wide', 'orbit'] : ['track', 'wide', 'sky'];
  if (cm.shot === null || cm.t >= cm.dur) { // cut to a new shot
    cm.t = 0; cm.dur = 3.0 + Math.random() * 1.6;
    cm.shot = menu[(cm.i++) % menu.length];
    cm.target = f.winners[(Math.random() * f.winners.length) | 0] || f.winners[0];
    cm.ang = Math.random() * Math.PI * 2;
    cm.snap = true;
  }
  let px, py, pz, lx, ly, lz, fov = 50;
  if (cm.shot === 'track' && cm.target) {           // low chase behind a sprinting winner
    const o = cm.target.group.position, h = cm.target.heading;
    px = o.x - Math.sin(h) * 5.5; pz = o.z - Math.cos(h) * 5.5; py = 2.3;
    lx = o.x; ly = 1.7; lz = o.z; fov = 52;
  } else if (cm.shot === 'wide') {                   // high, slow-drifting wide of the whole field + sky
    const a = cm.ang + cm.t * 0.07;
    px = c.x + Math.sin(a) * 24; pz = c.z + Math.cos(a) * 24; py = 13;
    lx = c.x; ly = 4.0; lz = c.z; fov = 46;
  } else if (cm.shot === 'sky') {                    // low, tilted UP so the fireworks fill the frame
    px = c.x + Math.sin(cm.ang) * 7; pz = c.z + Math.cos(cm.ang) * 7; py = 1.5;
    lx = c.x; ly = 17; lz = c.z; fov = 64;
  } else {                                           // orbit the dance circle, low and close
    const a = cm.ang + cm.t * 0.42;
    px = c.x + Math.sin(a) * 10; pz = c.z + Math.cos(a) * 10; py = 3.8;
    lx = c.x; ly = 2.0; lz = c.z; fov = 50;
  }
  _tp.set(px, py, pz); _tl.set(lx, ly, lz);
  if (cm.snap) { cam.pos.copy(_tp); cam.lookCur.copy(_tl); cm.snap = false; }
  else { cam.pos.lerp(_tp, Math.min(1, dt * 2.2)); cam.lookCur.lerp(_tl, Math.min(1, dt * 3)); }
  camera.fov += (fov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix();
  shake.update(dt);
  camera.position.set(cam.pos.x + shake.offX, Math.max(1.0, cam.pos.y + shake.offY), cam.pos.z + shake.offZ);
  camera.lookAt(cam.lookCur);
  sun.position.set(c.x + 40, 70, c.z + 20); sun.target.position.set(c.x, 0, c.z);
}

// ===========================================================================
// Ball + outcomes
// ===========================================================================
const CONTEST_R = 2.7; // catch radii are TUNE.tackleReach / TUNE.catchReach (intended = +1.0)
const THROW_ANIM_DUR = 0.5; // procedural throwing-motion length (s) — matches THROW_CHARGE_MAX so a full-hold bullet doesn't snap back to idle before release
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _d = new THREE.Vector3();
const _bv = new THREE.Vector3(), _ballQ = new THREE.Quaternion(), _spinQ = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);

const _hips = new THREE.Vector3();
// Bounce a live ball off the boundary cage (reflect horizontal velocity, keep
// it in bounds). Returns true on a wall hit.
function cageBounce(p, restitution) {
  let hit = false;
  if (p.x > CAGE_X) { p.x = CAGE_X; ball.vx = -Math.abs(ball.vx) * restitution; hit = true; }
  else if (p.x < -CAGE_X) { p.x = -CAGE_X; ball.vx = Math.abs(ball.vx) * restitution; hit = true; }
  if (p.z > CAGE_Z) { p.z = CAGE_Z; ball.vz = -Math.abs(ball.vz) * restitution; hit = true; }
  else if (p.z < -CAGE_Z) { p.z = -CAGE_Z; ball.vz = Math.abs(ball.vz) * restitution; hit = true; }
  if (hit) {
    // The chain-link soaks up energy: bleed the tangential + vertical speed too,
    // so the ball clearly slows after a carom.
    ball.vx *= 0.88; ball.vz *= 0.88; ball.vy *= 0.85;
    audio.fence(0.4); shake.add(0.06);
  }
  return hit;
}
// Belt-and-braces so the ball can NEVER disappear: always visible, always at a
// finite, on-field position (recovered to the ball-handler if anything NaNs).
function ensureBallVisible() {
  if (!ball.mesh) return;
  ball.mesh.visible = true;
  const p = ball.mesh.position;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
    const h = game.carrier || ball.holder || game.qb;
    const hp = h && h.group ? h.group.position : { x: 0, z: 0 };
    p.set(hp.x, 1.2, hp.z); ball.vx = ball.vy = ball.vz = 0;
  }
  p.x = THREE.MathUtils.clamp(p.x, -CAGE_X - 2, CAGE_X + 2);
  p.z = THREE.MathUtils.clamp(p.z, -CAGE_Z - 2, CAGE_Z + 2);
  p.y = THREE.MathUtils.clamp(p.y, 0.12, 60);
}
function updateBall(dt) {
  if (ball.mesh) ball.mesh.scale.setScalar(TUNE.ballSize); // debug: visual football size
  if (ball.mode !== 'flying') landRing.visible = false; // landing reticle only mid-flight
  if (ball.mode === 'rest') return; // sits where it landed (incomplete pass)
  if (ball.mode === 'dead') { // deflected/incomplete in the air — fall to the turf
    const p = ball.mesh.position;
    ball.vy -= ball.g * dt;
    p.x += ball.vx * dt; p.y += ball.vy * dt; p.z += ball.vz * dt;
    if (p.y <= 0.22) {
      p.y = 0.22;
      if (ball.vy < 0) { ball.vy = -ball.vy * 0.42; if (ball.vy < 1.3) { ball.vy = 0; ball.mode = 'rest'; } }
      ball.vx *= 0.6; ball.vz *= 0.6;
    }
    cageBounce(p, 0.5);
    ball.spin += (ball.spinRate * 0.4 + 9) * dt;
    ball.mesh.rotation.set(ball.spin * 0.5, ball.spin, ball.spin * 0.3); // tumble as it drops
    return;
  }
  if (ball.mode === 'loose') return; // a live fumble — physics handled in updateLoose
  if (ball.mode === 'carried') {
    const h = game.carrier || ball.holder || game.qb;
    if (h.ragdolling && h.ragdoll && h.ragdoll.active) {
      // Tucked with the falling body: track the carrier's physics-driven hips
      // (fall back to his ground position so the ball never snaps to the origin).
      // Ignore a non-finite spike on a violent hit so the ball isn't flung off
      // screen (and that garbage isn't baked into the replay record).
      const hips = h.ragdoll.tryBone('Hips');
      if (hips) {
        hips.getWorldPosition(_hips);
        if (Number.isFinite(_hips.x) && Number.isFinite(_hips.y) && Number.isFinite(_hips.z)) {
          ball.mesh.position.set(_hips.x, Math.max(0.2, _hips.y), _hips.z);
        } else { const gp = h.group.position; ball.mesh.position.set(gp.x, 0.5, gp.z); }
      } else { const gp = h.group.position; ball.mesh.position.set(gp.x, 0.5, gp.z); }
      return;
    }
    // In a chest-to-chest contact (break-tackle battle / wrap-drag), follow the
    // carry HAND bone so the ball stays on his hand (moving with the brace pose),
    // just pulled back toward his body so it isn't buried in the tackler. (The old
    // fixed world offset floated behind him once the contact distances were tuned.)
    const contact = (game.state === STATE.BATTLE && h === game.carrier) || (game.drag.active && h === game.carrier);
    if (contact && h.handBone) {
      h.handBone.updateWorldMatrix(true, false); // fresh after this frame's pose
      h.handBone.getWorldPosition(_hips);
      _f.set(Math.sin(h.heading), 0, Math.cos(h.heading)); // toward the tackler
      ball.mesh.position.set(_hips.x - _f.x * 0.12, Math.max(0.95, _hips.y), _hips.z - _f.z * 0.12);
      ball.mesh.rotation.set(0.3, h.heading, 0.45);
      return;
    }
    if (contact) { // no hand bone — keep the ball on his off-side at chest height
      const p = h.group.position;
      _f.set(Math.sin(h.heading), 0, Math.cos(h.heading));
      _r.set(Math.cos(h.heading), 0, -Math.sin(h.heading));
      ball.mesh.position.set(p.x - _f.x * 0.1 - _r.x * 0.2, 1.35, p.z - _f.z * 0.1 - _r.z * 0.2);
      ball.mesh.rotation.set(0.3, h.heading, 0.45);
      return;
    }
    if (h.handBone) {
      // Tuck the ball into the carrier's hand: follow the hand bone (so it
      // swings with the run cycle), nudged toward the body and chest height.
      h.handBone.updateWorldMatrix(true, false); // fresh after this frame's pose
      h.handBone.getWorldPosition(_hips);
      _f.set(Math.sin(h.heading), 0, Math.cos(h.heading));   // facing
      _r.set(Math.cos(h.heading), 0, -Math.sin(h.heading));  // right of facing
      ball.mesh.position.set(
        _hips.x - _r.x * 0.08 + _f.x * 0.04,
        Math.max(0.9, _hips.y + 0.02),
        _hips.z - _r.z * 0.08 + _f.z * 0.04);
      ball.mesh.rotation.set(0, h.heading, 0.35); // long axis cradled along the arm
      return;
    }
    const p = h.group.position;
    _f.set(Math.sin(h.heading), 0, Math.cos(h.heading));
    ball.mesh.position.set(p.x + _f.x * 0.4, 1.25, p.z + _f.z * 0.4);
    ball.mesh.rotation.y = h.heading;
  } else if (ball.mode === 'flying') {
    // Real projectile: integrate horizontal velocity + gravity on the vertical.
    ball.airTime += dt;
    const p = ball.mesh.position;
    // User nudge: only while ON FIRE can the left stick gently steer the ball in
    // flight (camera-relative) — a subtle guide toward the receiver, not control.
    if (game.onFire) {
      const kb = kbVec();
      const ix = THREE.MathUtils.clamp(input.x + kb.x, -1, 1);
      const iy = THREE.MathUtils.clamp(input.y + kb.y, -1, 1);
      if (Math.hypot(ix, iy) > 0.12) {
        camera.getWorldDirection(_f); _f.y = 0; _f.normalize();
        _r.crossVectors(_f, THREE.Object3D.DEFAULT_UP).normalize();
        ball.vx += (_f.x * iy + _r.x * ix) * BALL_NUDGE * dt;
        ball.vz += (_f.z * iy + _r.z * ix) * BALL_NUDGE * dt;
      }
    }
    p.x += ball.vx * dt;
    p.z += ball.vz * dt;
    ball.vy -= ball.g * dt;
    p.y += ball.vy * dt;
    if (cageBounce(p, 0.55)) ball.hitFence = true; // off the fence -> stays LIVE (never incomplete)
    // Keep the receiver's homing target on the ball's projected landing spot.
    const tRem = Math.max(0.05, ball.flightTime - ball.airTime);
    ball.to.set(p.x + ball.vx * tRem, 0, p.z + ball.vz * tRem);
    // Landing reticle on the turf where it'll come down (pulses), so you can read the play.
    landRing.visible = true;
    landRing.position.set(THREE.MathUtils.clamp(ball.to.x, -CAGE_X, CAGE_X), 0.06, THREE.MathUtils.clamp(ball.to.z, -CAGE_Z, CAGE_Z));
    const pulse = 1 + Math.sin(performance.now() * 0.012) * 0.12;
    landRing.scale.set(pulse, pulse, pulse);
    // Nose the long axis (local +Z) along the 3D velocity (the arc tangent) so
    // it tilts up then down, and spiral it about that axis.
    ball.spin += ball.spinRate * dt;
    _bv.set(ball.vx, ball.vy, ball.vz);
    if (_bv.lengthSq() > 1e-5) {
      _bv.normalize();
      _ballQ.setFromUnitVectors(_zAxis, _bv);
      _spinQ.setFromAxisAngle(_zAxis, ball.spin);
      ball.mesh.quaternion.copy(_ballQ).multiply(_spinQ);
    }
    // BATTLE FOR THE BALL: as it drops in, both the targeted receiver AND the
    // nearest defender throw their hands up and play it — they face the ball and
    // reach for the high point (the catch then resolves by ratings in
    // tryReception, so the contest you see matches the odds).
    if (ball.vy < 0 && p.y < 5.5) {
      const _rcv = ball.targetRecv;
      if (_rcv && !_rcv.ragdolling) {
        const rd = Math.hypot(_rcv.group.position.x - p.x, _rcv.group.position.z - p.z);
        if (rd < 4.5 && _rcv.armPoseT <= 0.12) { _rcv.heading = Math.atan2(p.x - _rcv.group.position.x, p.z - _rcv.group.position.z); _rcv.holdHeading = true; commitCatchReach(_rcv, p); }
      }
      let cd = null, cdD = Infinity; // the contesting defender
      for (const db of game.defense) { if (db.ragdolling) continue; const d = Math.hypot(db.group.position.x - p.x, db.group.position.z - p.z); if (d < cdD) { cdD = d; cd = db; } }
      if (cd && cdD < 4.5 && cd.armPoseT <= 0.12) { cd.heading = Math.atan2(p.x - cd.group.position.x, p.z - cd.group.position.z); cd.holdHeading = true; commitCatchReach(cd, p); }
    }
    // Catchable the instant it descends into someone's 3D reach volume (so a real
    // high-point leap fires at the apex, not only below a fixed height). catchGap
    // inside tryReception gates it — most of the descent it simply returns false.
    // The turf/timeout fallback below still resolves an overthrow that nobody reaches.
    if (ball.vy < 0 && p.y < 6.5 && tryReception()) return;
    if (p.y <= 0.16 || ball.airTime > ball.flightTime + 3) {
      if (tryReception()) return;
      if (ball.hitFence) { ballLooseFromAir(); return; } // a wall carom is a live loose ball, never incomplete
      ball.mode = 'rest'; endPlay('incomplete', game.los);
    }
  } else if (ball.mode === 'secured') {
    // Glide the ball INTO the catcher's hands over a short beat so you see it get
    // tucked away — eased from where it was when the catch committed to the (moving)
    // hand, on a smoothstep keyed to elapsed time (NOT a per-frame fraction), so it
    // arrives smoothly instead of snapping even on long frames / a leaping catch.
    const c = ball.catcher;
    let tx, ty, tz;
    if (c && c.handBone) {
      c.handBone.updateWorldMatrix(true, false);
      c.handBone.getWorldPosition(_hips);
      tx = _hips.x; ty = Math.max(0.9, _hips.y); tz = _hips.z;
    } else { const gp = c.group.position; tx = gp.x; ty = 1.2; tz = gp.z; }
    ball.secureT -= dt;
    const prog = THREE.MathUtils.clamp(1 - ball.secureT / Math.max(0.0001, ball.secureFull), 0, 1);
    const e = prog * prog * (3 - 2 * prog); // smoothstep ease-in/out
    const p = ball.mesh.position;
    p.x = THREE.MathUtils.lerp(ball.secureFrom.x, tx, e);
    p.y = THREE.MathUtils.lerp(ball.secureFrom.y, ty, e);
    p.z = THREE.MathUtils.lerp(ball.secureFrom.z, tz, e);
    ball.spin += ball.spinRate * 0.5 * dt;
    ball.mesh.rotation.set(0, c ? c.heading : 0, 0.35); // settle into a tuck
    if (ball.secureT <= 0) {
      p.set(tx, ty, tz);
      if (c) {
        c.oneShotT = 0; c.catchLeap = false; c.catchPlant = false; // end the leap clip; transition to the run/return
        // Flow into the run: a planted leap/dive lands nearly stopped, so give him a
        // downfield push so he doesn't dead-stop; an in-stride catch keeps its own
        // momentum untouched.
        if (Math.hypot(c.vel.x, c.vel.z) < 2) { const fwd = game.dir > 0 ? 0 : Math.PI, sp = c.baseSpeed * 0.5; c.vel.set(Math.sin(fwd) * sp, 0, Math.cos(fwd) * sp); }
      }
      if (ball.intercept) {
        if (game.userCatch) game.userCatch.on = false; hideCatchRow(); // clear the user-catch cue on a pick
        ball.mode = 'carried'; ball.holder = c;
        if (game.play) game.play.intBy = c; // box score: the pick
        if (game.tally) game.tally.picks++;
        beginReturn(c, 'pick'); // live runback either way: CPU returns + you chase, or you return it
      } else {
        ball.mode = 'carried'; if (game.play) { game.play.catcher = c; game.play.completed = true; }
        if (game.userOnOffense) creditUserStat('catches', 'CATCH');
        // RAC (Phase 1): a catch-in-stride bursts downfield instead of dead-stopping
        // (possession/aggressive intentionally kill momentum — they planted/secured).
        const uc = game.userCatch;
        if (uc && uc.on && uc.armed && uc.style === 'rac' && c === uc.recv) { const h = c.heading, sp = c.baseSpeed * TUNE.racBoost; c.vel.set(Math.sin(h) * sp, 0, Math.cos(h) * sp); c.speed = sp; }
        if (uc) uc.on = false;
        hideCatchRow();
        enterRun(c, 'Caught it! Run!');
      }
    }
  }
}
// Begin the secure phase: the ball homes into the catcher's hands before it
// resolves to a catch (or interception).
function startSecure(player, isInt) {
  if (!player.catchLeap) player.heading = Math.atan2(ball.vx, ball.vz); // turn to the ball (a committed leap already faces it)
  ball.mode = 'secured'; ball.catcher = player; ball.secureT = Math.max(0.05, TUNE.catchSecure); ball.intercept = isInt;
  ball.secureFull = ball.secureT; ball.secureFrom.copy(ball.mesh.position); // anchor the eased glide-in
  const p = ball.mesh.position;
  if (TUNE.catchLog) {
    const g3 = catchGap(player, p, player === ball.targetRecv);
    dbgLogPush(`<b>${isInt ? 'INT' : 'SECURE'}</b> ${player.role || ''} · gap ${g3.toFixed(2)} · ${player.catchLeap ? 'leaping' : 'standing'} · secureT ${ball.secureT.toFixed(2)}s`);
  }
  if (isInt) {
    showBanner('PICKED OFF!', '#ff5a3a'); shake.add(0.3); audio.groan();
    burst(p.x, p.y, p.z, 0x8fbaff, 8, 5);
    // Phase 3 defender high-point: a DB who picks a high/extended ball and isn't
    // already leaping gets a genuine high-point grab clip (not just a flat snag).
    if (!player.catchLeap) {
      const reach = Math.hypot(player.group.position.x - p.x, player.group.position.z - p.z);
      const high = p.y > player.group.position.y + 1.8;
      if (player.actions.divecatch && (reach > 1.7 || high)) { playOneShot(player, 'divecatch', 0.6, true); player.catchLeap = true; player.catchPlant = true; }
    }
  } else {
    audio.catch(); audio.cheer(0.35);
    // Phase 2 — weight the big ones: a contested / aggressive / leaping grab gets
    // deeper slow-mo + more shake than a flat checkdown.
    let nd = Infinity;
    for (const d of game.defense) { if (d.ragdolling) continue; const dx = d.group.position.x - player.group.position.x, dz = d.group.position.z - player.group.position.z; const dist = Math.hypot(dx, dz); if (dist < nd) nd = dist; }
    let drama = nd < CONTEST_R ? THREE.MathUtils.clamp(1 - nd / CONTEST_R, 0, 1) : 0;
    if (player.catchLeap) drama = Math.max(drama, 0.4); // a leaping/extended grab is dramatic
    const _uc = game.userCatch;
    if (_uc && _uc.on && _uc.armed && player === _uc.recv && _uc.style === 'agg') drama = Math.max(drama, 0.6);
    timeScale.slow(0.7 - drama * 0.35, 0.18 + drama * 0.32); // 0.7/0.18 flat .. 0.35/0.50 on a big contested grab
    if (drama > 0.05) shake.add(0.06 + drama * 0.18);
    burst(p.x, p.y, p.z, 0xffffff, 8, 5);
    // Leaping reception: if the body is ALREADY in an anticipatory leap (fired during
    // the descent, see updateBall), don't restart a clip — the hands track the ball
    // over it. Otherwise, a genuine late high grab / far extension that wasn't
    // anticipated still gets a (shorter) leap so it doesn't look flat-footed.
    if (!player.catchLeap) {
      const reach = Math.hypot(player.group.position.x - p.x, player.group.position.z - p.z);
      const high = p.y > player.group.position.y + 1.9;
      if (player.actions.divecatch && (reach > 1.9 || high)) { playOneShot(player, 'divecatch', 0.6, true); player.catchLeap = true; player.catchPlant = true; }
    }
  }
}
function passBrokenUp(msg, color, swatter, swatType) {
  // Knock the ball DOWN so it falls to the turf instead of freezing mid-air.
  ball.mode = 'dead'; ball.g = 24;
  ball.vy = -3 - Math.random() * 3;
  const sc = swatType === 'swat' ? 7 : 3; // a DB bats it away; a drop just falls
  ball.vx = ball.vx * 0.2 + (Math.random() - 0.5) * sc;
  ball.vz = ball.vz * 0.2 + (Math.random() - 0.5) * sc;
  ball.spinRate = 18;
  showBanner(msg, color);
  const p = ball.mesh.position;
  // Procedural reaction on the player who made the play on the ball: a defender
  // bats it down (swat), a receiver lunges and can't hang on (reach).
  if (swatter) { swatter.catchLeap = false; swatter.catchPlant = false; swatter.heading = Math.atan2(p.x - swatter.group.position.x, p.z - swatter.group.position.z); triggerArmAction(swatter, swatType || 'swat', 0.4, p); }
  burst(p.x, Math.max(0.3, p.y), p.z, 0xdfe7ff, 9, 6); // swat
  shake.add(0.12);
  if (game.userCatch) game.userCatch.on = false; // clear the user-catch cue on an incompletion
  selRing.visible = false; selRing.scale.set(1, 1, 1); hideCatchRow();
  endPlay('incomplete', game.los); // endPlay blows the whistle
}

// Resolve a ball in flight against nearby players. Most throws into coverage
// are CONTESTED — only a clear window is a clean catch; tight coverage is
// usually an incompletion / breakup, with rare picks on blanketed throws.
// Vertical catch reach (yd): standing + arms (~2.5) plus a leap from athleticism
// (speed/hands), scaled by player size. Drives the jump-ball contest + the viz.
function vReach(ch) {
  const r = ch.rt; const ath = r ? (r.speed * 0.5 + r.skill * 0.3) : 0.4;
  return (2.5 + (0.2 + ath) * 1.7) * TUNE.playerSize * TUNE.catchHeight; // bigger players reach higher (× height knob)
}
// 3D reach gap: how far the ball is OUT of a player's reachable volume — a
// vertical capsule from his shins up to his max vertical reach (vReach), radius =
// his horizontal arm reach. 0 = the ball is inside grabbing range; larger = how
// far out of reach (yd). Replaces the old flat horizontal-radius test so a ball
// sailing high over a receiver's head no longer counts as "in range".
function catchGap(ch, ballPos, intended) {
  const g = ch.group.position;
  const rH = intended ? (TUNE.catchReach + 1.0) : TUNE.catchReach;   // horizontal arm reach
  const topY = g.y + vReach(ch);                                     // highest he can reach (leap)
  const lowY = g.y + 0.1;                                            // can't pluck it off his shoetops out of the air
  const dH = Math.max(0, Math.hypot(ballPos.x - g.x, ballPos.z - g.z) - rH);
  const dV = ballPos.y > topY ? ballPos.y - topY : (ballPos.y < lowY ? lowY - ballPos.y : 0);
  return Math.hypot(dH, dV);
}
// Phase 1 (3 catch styles) + Phase 2 cue: while a pass is in the air to the USER's
// receiver, a timing window opens as the ball drops into reach. Choose how to attack
// it — RAC (catch in stride, keep momentum, biggest YAC) / POSSESSION (secure,
// safest, no YAC) / AGGRESSIVE (high-point leap, wins contests, riskier). The armed
// style overrides commitCatchReach and layers modifiers onto tryReception; CPU
// receivers and your non-targeted WRs are untouched (they auto-resolve as before).
function updateUserCatch(catchEdge) {
  const uc = game.userCatch; if (!uc || !uc.on) return;
  const recv = uc.recv;
  if (!recv || recv.ragdolling || ball.mode !== 'flying') { selRing.visible = false; hideCatchRow(); return; }
  const p = ball.mesh.position;
  const gap = catchGap(recv, p, true);
  const descending = ball.vy < 0;
  const open = descending && gap < TUNE.catchWindow; // catchable now
  if (catchEdge) { // press: arm a style; timing credit scales with how close the ball is
    uc.armed = true; uc.style = catchEdge;
    uc.armEarly = !open || gap > (TUNE.catchGrab + TUNE.catchWindow) * 0.55; // committed before/early in the window (aggressive needs this)
    const q = 1 - THREE.MathUtils.clamp((gap - TUNE.catchGrab) / Math.max(0.1, TUNE.catchWindow - TUNE.catchGrab), 0, 1);
    uc.score = Math.max(uc.score, descending ? q : 0);
    if (!descending) uc.buffered = uc.style; // tapped early -> honor it the instant the window opens
  }
  if (open && uc.buffered) { uc.armed = true; uc.style = uc.buffered; uc.armEarly = true; uc.score = Math.max(uc.score, 0.6); uc.buffered = null; }
  uc.open = open;
  // Cue: light the style buttons hot + pulse the receiver's ring when catchable.
  showCatchRow(open, uc.armed ? uc.style : null);
  if (open || uc.armed) {
    selRing.visible = true;
    selRing.position.set(recv.group.position.x, 0.03, recv.group.position.z);
    const pulse = 1 + Math.sin(performance.now() * 0.02) * 0.18;
    selRing.scale.set(pulse, pulse, pulse);
  } else { selRing.visible = false; }
}
// Anticipatory catch reach (Phase 3) + catch-style selection (Phase 4): as the
// ball drops toward a player, commit the catch ANIMATION BEFORE the grab resolves
// so the body is already up/extended/scooping when the ball arrives (instead of
// reacting after). The STYLE is read from the geometry:
//   leap   — high or far ball: jump/extend (divecatch clip), planted (jumps in place)
//   scoop  — low ball on the run: a low running pickup (scoop clip), IN STRIDE
//   overshoulder / standing — procedural two-hand reach, IN STRIDE (keeps running)
// catchLeap = a catch clip is playing and the arm overlay should track the ball.
// catchPlant = freeze his steering (only the aerial leap jumps in place); in-stride
// styles keep their route momentum so the catch flows into the run.
function commitCatchReach(ch, ballPos) {
  if (ch.catchLeap) return; // already committed this play
  const imminent = catchGap(ch, ballPos, ch === ball.targetRecv) < 1.4; // arrival is close
  if (!imminent) { if (ch.armPoseT <= 0.12) triggerArmAction(ch, 'reach', 0.5, ballPos); return; }
  const g = ch.group.position;
  const horiz = Math.hypot(ballPos.x - g.x, ballPos.z - g.z);
  const high = ballPos.y > g.y + 1.9;            // must go up for it
  const far = horiz > 1.7;                        // full extension
  const low = ballPos.y < g.y + 0.95;            // around the knees/shins
  const running = ch.speed > 4.5;
  ch.catchPlant = false;
  // Phase 1 style override on the user's targeted receiver: RAC/POSSESSION catch in
  // stride (procedural reach, no planted leap — keep momentum); AGGRESSIVE forces the
  // high-point leap (max vertical reach) even on a catchable ball.
  const uc = game.userCatch;
  const armed = (uc && uc.on && uc.armed && ch === uc.recv) ? uc.style : null;
  const inStride = armed === 'rac' || armed === 'poss';
  const forceLeap = armed === 'agg';
  if (forceLeap && ch.actions.divecatch && ch.oneShotT <= 0) {
    playOneShot(ch, 'divecatch', 0.7, true); ch.catchLeap = true; ch.catchPlant = true; ch.catchStyle = 'leap';
  } else if (!inStride && (high || far) && ch.actions.divecatch && ch.oneShotT <= 0) {
    playOneShot(ch, 'divecatch', 0.7, true); ch.catchLeap = true; ch.catchPlant = true; ch.catchStyle = 'leap';
  } else if (!inStride && low && running && ch.actions.scoop && ch.oneShotT <= 0) {
    playOneShot(ch, 'scoop', 0.55, true); ch.catchLeap = true; ch.catchStyle = 'scoop'; // low pickup on the run — no plant
  } else {
    ch.catchStyle = (running && ballPos.y > g.y + 1.45) ? 'overshoulder' : 'standing';
    triggerArmAction(ch, 'reach', 0.5, ballPos); // procedural reach, keeps running
  }
}
function tryReception() {
  const p = ball.mesh.position;
  const ballY = p.y;
  const high = THREE.MathUtils.clamp((ballY - 1.6) / 2.0, 0, 1); // 0 = low/chest ball, 1 = high jump ball
  const near = (ch) => Math.hypot(ch.group.position.x - p.x, ch.group.position.z - p.z);
  // The intended receiver gets a bigger window (the throw was aimed at him); any
  // other receiver needs the ball right on him. The grab fires only once the ball
  // is within a player's 3D reach volume (catchGap ~0), with a little slack.
  let bestR = null, dR = Infinity;
  for (const wr of game.receivers) {
    const g = catchGap(wr, p, wr === ball.targetRecv);
    if (g <= TUNE.catchGrab && g < dR) { dR = g; bestR = wr; }
  }
  let bestDef = null, dD = Infinity;
  for (const db of game.defense) { if (db.ragdolling) continue; const d = near(db); if (d < dD) { dD = d; bestDef = db; } }
  // How well the covering defender can actually PLAY the ball in 3D (1 = right at
  // it, →0 = it's out of his reach — over his head / past his dive). A DB draped on
  // the WR but a step short of the ball can't contest it like one who's there.
  const defGap = bestDef ? catchGap(bestDef, p, false) : Infinity;
  const reachF = THREE.MathUtils.clamp(1 - defGap / Math.max(0.6, TUNE.catchReach), 0, 1);

  const dbBall = bestDef && bestDef.rt ? bestDef.rt.skill : 0.55; // DB ball skills (hands/timing)
  // No receiver in catching range — keep it flying. Defenders never pick it out
  // of the air: an interception only happens when an overthrow caroms off the
  // FENCE and a defender recovers the live loose ball (see ballLooseFromAir).
  if (!bestR) return false;
  if (TUNE.catchLog) dbgLogPush(`<b>CATCH?</b> gap ${dR.toFixed(2)} · ballY ${ballY.toFixed(1)} · reach ${vReach(bestR).toFixed(1)} · ${bestDef && dD <= CONTEST_R ? 'contested ' + dD.toFixed(1) + ' (reach ' + reachF.toFixed(2) + ')' : 'open'}`);

  // A receiver is in reach. Uncontested = a clean grab; great hands rarely drop.
  const rxSkill = bestR.rt ? bestR.rt.skill : 0.8;
  const rxReach = vReach(bestR); // vertical reach (standing + leap)
  const cpuAdj = bestR.cpu ? diff().cpuCatch : 0; // difficulty: nudge CPU catch odds
  // User catch (Phase 1): a well-timed press on YOUR receiver layers a style-based
  // bonus on top of the AI odds. No press = baseline (nothing regresses); CPU = 0.
  //   userBonus  — added to both clean and contested catch odds
  //   userContest— added to CONTESTED odds only (aggressive high-point edge)
  let userBonus = 0, userContest = 0;
  const _uc = game.userCatch;
  if (_uc && _uc.on && _uc.armed && bestR === _uc.recv) {
    if (_uc.style === 'poss') {
      // POSSESSION — widest timing leniency (timing matters least) + flat secure bonus.
      userBonus = Math.max(_uc.score, 0.7) * TUNE.userCatchBonus + TUNE.possCatch;
    } else if (_uc.style === 'agg' && _uc.armEarly) {
      // AGGRESSIVE only pays off as a COMMITTED early high-point; armed late it's just a contested grab.
      userBonus = _uc.score * TUNE.userCatchBonus - TUNE.aggSecurity; userContest = TUNE.aggContest;
    } else { // RAC (neutral catch + YAC), or aggressive armed too late (no high-point edge)
      userBonus = _uc.score * TUNE.userCatchBonus;
    }
    if (_uc.score <= 0.01) userBonus -= TUNE.catchMissPenalty; // a clearly mistimed mash is worse than a clean AI grab
  }
  const contested = bestDef && dD <= CONTEST_R;
  if (!contested) {
    let base = 0.84 + rxSkill * 0.14 + cpuAdj + userBonus;
    if (ballY > rxReach) base -= (ballY - rxReach) * 0.7 * TUNE.jumpReach; // thrown over his head
    if (Math.random() < base) { startSecure(bestR, false); return true; }
    passBrokenUp('DROPPED!', '#dfe7ff', bestR, 'reach'); return true; // receiver lunges, drops it
  }

  // Contested: catch odds fall as coverage tightens, lifted by the receiver's
  // hands and lowered by the defender's coverage skill; picks scale with the DB.
  // Tightness is gated by the defender's 3D reach (reachF) — a man who can't get to
  // the ball barely contests it, so a WR who out-leaps a short DB just takes it.
  const tight = (1 - THREE.MathUtils.clamp(dD / CONTEST_R, 0, 1)) * (0.35 + 0.65 * reachF); // 0 loose .. 1 glued+reaching
  let pCatch = THREE.MathUtils.lerp(0.80, 0.25, tight) + (rxSkill - 0.8) * 0.6 - (dbBall - 0.6) * 0.3 + cpuAdj;
  // Vertical contest: on a HIGH ball, the player who out-reaches the other wins it
  // (a tall/leaping WR beats a short DB on a jump ball, and vice-versa). Neutral on
  // low balls (high≈0). Gated/scaled by the jump-reach debug knob.
  const dbReachV = bestDef ? vReach(bestDef) : 0;
  pCatch += high * THREE.MathUtils.clamp(rxReach - dbReachV, -1.5, 1.5) * 0.35 * TUNE.jumpReach;
  if (ballY > rxReach) pCatch -= (ballY - rxReach) * 0.7 * TUNE.jumpReach; // over the receiver's reach
  if (game.onFire) pCatch += 0.12;
  pCatch += TUNE.catchBias + userBonus + userContest; // global nudge + user-catch timing/style bonus (+ aggressive contest edge)
  pCatch = THREE.MathUtils.clamp(pCatch, 0.05, 0.95);
  if (Math.random() < pCatch) {
    // Possession-vs-hit (Phase 3): a contested catch leaves the receiver exposed to a
    // jarring hit; the risk scales with the user's chosen style (POSSESSION most
    // exposed — he planted and secured; RAC least — caught in stride).
    if (TUNE.contestPhysics && _uc && _uc.on && _uc.armed && bestR === _uc.recv) {
      bestR.catchExposed = TUNE.catchExposeTime;
      bestR.catchExposeRisk = _uc.style === 'poss' ? 1.0 : _uc.style === 'agg' ? 0.7 : 0.35;
    }
    startSecure(bestR, false); return true; // contested grab
  }

  // The receiver couldn't bring it in. In TIGHT coverage the DB can make a play
  // on the ball himself — a real interception — scaled by his ball skills and how
  // glued he is, plus a vertical edge if he out-leaps the WR on a high ball. A pick
  // requires him to actually BE at the ball (reachF, no floor), so a man a step
  // short bats it away at best instead of magically picking it. Otherwise: swat.
  const tightPick = (1 - THREE.MathUtils.clamp(dD / CONTEST_R, 0, 1)) * reachF;
  let pInt = (0.08 + (dbBall - 0.5) * 0.45) * tightPick;                   // base: skill × glued-and-reaching
  pInt += high * THREE.MathUtils.clamp(dbReachV - rxReach, -1.5, 1.5) * 0.18 * TUNE.jumpReach * reachF; // out-jumps the WR
  pInt *= TUNE.intChance;                                                  // global pick-odds knob
  pInt = THREE.MathUtils.clamp(pInt, 0, 0.6);
  if (Math.random() < pInt) { startSecure(bestDef, true); return true; }   // picked off in coverage
  // Phase 3: the swat can TIP it live (ball as a physics object) instead of always a
  // scripted incompletion — a tipped ball is then up for grabs by either team.
  if (TUNE.contestPhysics && Math.random() < TUNE.tipChance) { ballTippedLoose(bestDef); return true; }
  passBrokenUp('BROKEN UP!', '#9fd0ff', bestDef, 'swat'); return true;     // DB bats it away
}
const LUNGE_R = 2.7; // a pursuer who's closed within this DIVES to make the tackle
function checkRunOutcome() {
  if (!game.carrier) return; // a botched pitch/fumble can clear the carrier mid-frame
  const c = game.carrier.group.position;
  if (reachedGoal(c.z)) { endPlay('TD', c.z); return; }
  // No out of bounds — the cage keeps the carrier in (clampToField).
  let lunger = null, lungeD = Infinity;
  for (const db of game.defense) {
    if (db.ragdolling) continue;
    const d = Math.hypot(db.group.position.x - c.x, db.group.position.z - c.z);
    if (d <= TUNE.tackleReach) { beginTackle(db); return; }       // hard contact
    if (db.pursuit && d <= LUNGE_R && d < lungeD) { lungeD = d; lunger = db; } // chaser within dive range
  }
  // Shoestring/diving tackle: a pursuer who caught up but can't get fully even
  // lunges the last yard or two so an open-field run from behind can be brought
  // down (instead of the defender hanging just out of reach forever).
  if (lunger) {
    const dx = c.x - lunger.group.position.x, dz = c.z - lunger.group.position.z, l = Math.hypot(dx, dz) || 1;
    lunger.heading = Math.atan2(dx, dz);
    lunger.vel.x += dx / l * 6; lunger.vel.z += dz / l * 6; // lunge into the carrier
    playOneShot(lunger, lunger.actions.divecatch ? 'divecatch' : 'tackle', 0.45, true);
    beginTackle(lunger);
  }
}
// SACK: a rusher (or your driven defender) who reaches the QB in the pocket
// before the throw drops him for a loss — committed tackle, ragdoll, can strip.
function checkSack() {
  const qp = game.qb.group.position;
  for (const d of game.defense) {
    if (d.ragdolling) continue;
    if (Math.hypot(d.group.position.x - qp.x, d.group.position.z - qp.z) <= TUNE.tackleReach) {
      game.carrier = game.qb; if (game.play) game.play.sack = true; if (game.tally) game.tally.sacks++; beginTackle(d, true);
      showBanner('SACK!', '#ff5a3a'); setStatus('SACK!'); audio.bigHit(); audio.say('sack', { force: true });
      game.replay.bigHit = true; // a sack is always a highlight
      return;
    }
  }
}

// ===========================================================================
// Ragdoll tackles (tackle resolution ported from Football-Game/TackleEngine)
// ===========================================================================
// Gang-tackle swarm radius is a debug knob (TUNE.swarmRadius).
const GANG_MAX = 4;    // max bodies that latch on (wrap + drag)
const RAGDOLL_MAX = 3; // carrier + 2 tacklers ragdoll on collapse; the rest just wrap

function spawnRagdoll(ch, carryVel, hitDir, hitSpeed, bit, variant) {
  if (!physics) return false;
  if (!ch.ragdoll) { ch.ragdoll = new TackleRagdoll(physics); ch.ragdoll.bind(ch.model); }
  ch.group.updateWorldMatrix(true, true); // snapshot the CURRENT animated pose
  ch.ragdoll.spawn(carryVel, hitDir, hitSpeed, bit, variant);
  ch.ragdolling = ch.ragdoll.active;
  return ch.ragdolling;
}

// Mid-play knockdowns (whiffs / broken tackles): each gets its own collision
// bit from a rotating pool so simultaneous bodies never explode each other.
let midplayBit = 0;
const MIDPLAY_BITS = [0x0040, 0x0080, 0x0100, 0x0200, 0x0400, 0x0800];
function knockdownDefender(d) {
  if (!TUNE.ragdolls) return; // ragdolls disabled (debug)
  const c = game.carrier ? game.carrier.group.position : d.group.position;
  const dx = d.group.position.x - c.x, dz = d.group.position.z - c.z;
  const l = Math.hypot(dx, dz) || 1;
  const away = new THREE.Vector3(dx / l, 0, dz / l); // bounced off the runner
  spawnRagdoll(d, new THREE.Vector3(d.vel.x, 0, d.vel.z), away, 3.5,
    MIDPLAY_BITS[midplayBit++ % MIDPLAY_BITS.length], 'highKnock');
  d.downKnock = true; d.downT = 0; // recoverable mid-play knockdown (gets back up — see updateKnockdownRecovery)
}
// A knocked-down DEFENDER isn't out of the play: once his ragdoll settles (and
// TUNE.knockdownRecover seconds have passed) he pops back up where he fell and
// rejoins the pursuit. Set the knob to 0 to leave them down (old behavior).
function updateKnockdownRecovery(dt) {
  if (!TUNE.knockdownRecover) return;
  for (const d of game.defense) {
    if (!d.downKnock || !d.ragdolling) { if (!d.ragdolling) d.downKnock = false; continue; }
    d.downT = (d.downT || 0) + dt;
    if (d.downT < TUNE.knockdownRecover) continue;
    if (d.ragdoll && d.ragdoll.active && !d.ragdoll.settled() && d.downT < TUNE.knockdownRecover + 2) continue; // let it come to rest (cap the wait)
    const p = d.ragdoll && d.ragdoll.active ? d.ragdoll.rootXZ() : null;
    if (d.ragdoll) d.ragdoll.dispose();
    d.ragdolling = false; d.downKnock = false;
    restoreRestPose(d); if (d.mixer) d.mixer.setTime(0);
    if (p) { d.group.position.x = p.x; d.group.position.z = p.z; }
    d.group.position.y = 0; d.vel.set(0, 0, 0); d.speed = 0;
    if (game.carrier) d.heading = Math.atan2(game.carrier.group.position.x - d.group.position.x, game.carrier.group.position.z - d.group.position.z); // face the ball
    if (d.actions.getup) playOneShot(d, 'getup', 1.5, true); // play the full get-up clip (fit to 1.5s), held during it, then pursue
  }
}

// Strength + momentum break check vs the whole pile (from TackleEngine.tryBreak).
// A fast, turbo, or ON FIRE back slips a lone defender often; a gang rarely.
function tryBreak(carrier, pile) {
  if (game.playClock - game.lastBreak < 0.55) return false;
  const speed = Math.hypot(carrier.vel.x, carrier.vel.z);
  let p = (input.turbo ? 0.52 : 0.34) * diff().userBreak; // difficulty: your break-tackle assist
  const power = carrier.strength * carrier.fatigue * (1 + speed / 16) * (input.turbo ? 1.2 : 1) * (game.onFire ? 1.4 : 1); // a gassed runner trucks fewer tacklers
  let gangStr = 0;
  for (const t of pile) gangStr += (0.5 + (t.rt ? t.rt.tackle : 0.6)) * fatiguePow(t); // wrap-up scales with TACKLING + freshness
  p *= THREE.MathUtils.clamp(power / (gangStr * 0.95), 0.3, 1.25);
  if (pile.length >= 2) p *= 0.45; // a gang is hard to slip
  if (pile.length >= 3) p *= 0.5;
  if (Math.random() >= p) return false;
  game.lastBreak = game.playClock;
  return true;
}

// --- 1-on-1 break-tackle battle (mash to break free) -----------------------
const BATTLE_TIME = 2.6;     // seconds before it resolves on whoever leads
const BATTLE_SOLO_R = 2.6;   // a hit is a 1-on-1 (battle) if no other defender is this close
const BATTLE_TAP = 0.095;    // meter toward break per mash
const BATTLE_CPU = 0.27;     // meter drift/s toward the tackle
const BATTLE_RAMP = 0.22;    // each repeat battle in one play is this much harder (drag ×, start ↓)
const battleEl = document.getElementById('battle');
const battleFill = document.getElementById('battle-fill');
const battleDiv = document.getElementById('battle-div');
const battlePrompt = document.getElementById('battle-prompt');
// Tapping anywhere on the battle overlay also counts as a mash.
battleEl.addEventListener('touchstart', (e) => { e.preventDefault(); input.battleMash++; }, { passive: false });
battleEl.addEventListener('mousedown', () => { input.battleMash++; });

function startBattle(tackler, hard = false) {
  const b = game.battle;
  // Each successive battle in the SAME play is harder: you start further behind.
  b.playCount++;
  const ramp = (b.playCount - 1) * BATTLE_RAMP; // 0 on the first battle of the play
  // A big committed hit starts you further behind (harder to break out of), and
  // every repeat in the play shaves a bit more off your starting meter.
  b.val = Math.max(0.2, (hard ? 0.36 : 0.48) - ramp * 0.07); b.timer = BATTLE_TIME; b.tackler = tackler; b.flash = 0;
  game.state = STATE.BATTLE;
  // The carrier drives DOWNFIELD; the tackler meets him head-on, so they're
  // squared up face-to-face (the tackler is placed in front in updateBattle).
  const c = game.carrier;
  const ang = game.dir > 0 ? 0 : Math.PI;              // carrier's attacking direction
  c.vel.set(0, 0, 0); c.speed = 0; c.heading = ang;
  tackler.vel.set(0, 0, 0); tackler.speed = 0; tackler.heading = ang + Math.PI; // faces the carrier
  b.baseX = c.group.position.x; b.baseZ = c.group.position.z; // anchor: carrier drives off this
  ctrlRing.visible = false;
  hitZoom(BATTLE_TIME + 0.4);  // punch the camera in on the duel
  battlePrompt.textContent = 'BREAK THE TACKLE!';
  battleEl.classList.remove('hidden');
  setStatus('Mash to break free!');
  updateButtons();
}

function endBattle(carrierWon) {
  const b = game.battle;
  const tackler = b.tackler;
  b.tackler = null; b.cd = 1.2; // brief cooldown so battles don't instantly chain
  battleEl.classList.add('hidden');
  if (carrierWon) {
    game.carrier.jukeTimer = 0.5; // brief immunity so he actually escapes
    const burst = game.carrier.baseSpeed * 0.95;
    game.carrier.vel.set(Math.sin(game.carrier.heading) * burst, 0, Math.cos(game.carrier.heading) * burst);
    knockdownDefender(tackler);
    shake.add(0.3);
    showBanner('BROKE FREE!', '#bfffd0');
    game.state = STATE.RUN; ctrlRing.visible = true;
    setStatus('Broke free — go!');
  } else {
    showBanner('STUFFED!', '#ffd23a');
    game.state = STATE.RUN;        // beginTackle expects a live carrier
    beginTackle(tackler, true);    // committed tackle — no escape (ragdoll fall)
  }
  updateButtons();
}

function updateBattle(dt) {
  const b = game.battle;
  if (!b.tackler) { game.state = STATE.RUN; return; }
  b.timer -= dt;
  b.flash = Math.max(0, b.flash - dt * 4);

  // Each ACTION press is a mash; the CPU steadily drags it toward the tackle,
  // harder when the tackler is the stronger man.
  if (input.battleMash > 0) { b.val += input.battleMash * BATTLE_TAP; b.flash = 1; input.battleMash = 0; }
  // A strong TACKLER drags the meter down faster; a strong carrier resists. Fatigue
  // cuts both — a gassed man loses the wrestle — and the struggle itself tires them.
  const tklPow = (0.4 + (b.tackler.rt ? b.tackler.rt.tackle : 0.6)) * fatiguePow(b.tackler);
  const carPow = (0.4 + (game.carrier.rt ? game.carrier.rt.strength : 0.7)) * fatiguePow(game.carrier);
  const ramp = 1 + Math.max(0, b.playCount - 1) * BATTLE_RAMP; // repeat battles in a play drag harder
  b.val -= (BATTLE_CPU * ramp / TUNE.breakTackleEase) * dt * THREE.MathUtils.clamp(tklPow / carPow, 0.6, 1.8); // ease>1 = easier to break
  drainFatigue(b.tackler, 0.07 * dt); drainFatigue(game.carrier, 0.07 * dt);
  b.val = THREE.MathUtils.clamp(b.val, 0, 1);

  // Locked in contact: the carrier DRIVES off the anchor toward the tackler as
  // he wins the meter (and gets shoved back as he loses); the tackler stays a
  // shoulder-width in front. A small wobble keeps the wrestle alive.
  const wob = Math.sin(game.playClock * 22) * 0.03;
  const ang = game.carrier.heading, sa = Math.sin(ang), ca = Math.cos(ang);
  const drive = (b.val - 0.5) * 2.2;             // yards the carrier pushes the pile
  const c = game.carrier.group.position;
  c.x = b.baseX + sa * drive; c.z = b.baseZ + ca * drive;
  // Locked CHEST TO CHEST: the tackler is driven right up onto the carrier (a real
  // wrap-up, not a stand-off at arm's length) — see applyBattleArms / applyBattleLean.
  const half = Math.max(0.08, TUNE.gapBattle + wob); // floored so a closed gap never flips the tackler in front/behind
  const tk = b.tackler.group.position;
  const rx = Math.cos(ang), rz = -Math.sin(ang); // right of facing, for the lateral offset
  tk.x = c.x + sa * half + rx * TUNE.latBattle; tk.z = c.z + ca * half + rz * TUNE.latBattle;

  battleFill.style.width = `${Math.round(b.val * 100)}%`;
  battleDiv.style.left = `${Math.round(b.val * 100)}%`;

  if (b.val >= 1 || (b.timer <= 0 && b.val >= 0.5)) { endBattle(true); return; }
  if (b.val <= 0 || b.timer <= 0) { endBattle(false); return; }
}

function beginTackle(lead, force = false) {
  const carrier = game.carrier;
  const cp = carrier.group.position;
  if (carrier.catchExposed > 0) force = true; // Phase 3: a hit right after a contested catch is a committed, jarring shot (no juke/battle out of it)
  if (game.play && game.defense.includes(lead)) game.play.tackler = lead; // box score: credit the tackle
  if (!physics || !TUNE.ragdolls) { endPlay('tackle', cp.z); return; } // no physics / ragdolls off: instant whistle

  // Gather the swarm: the lead plus the nearest defenders crashing the carrier.
  const pile = [lead, ...game.defense
    .filter((d) => d !== lead && distXZ(px(d), cp) <= TUNE.swarmRadius)
    .sort((a, b) => distXZ(px(a), cp) - distXZ(px(b), cp))].slice(0, GANG_MAX);
  const gangSize = pile.length;

  const hitX = cp.x - lead.group.position.x;
  const hitZ = cp.z - lead.group.position.z;
  const hl = Math.hypot(hitX, hitZ) || 1;
  const hitDir = new THREE.Vector3(hitX / hl, 0, hitZ / hl);
  const closing = Math.hypot(lead.vel.x - carrier.vel.x, lead.vel.z - carrier.vel.z);
  let big = lead.turbo || closing > 8; // Blitz: most square hits are violent (Phase 3 may force it on an exposed catch)
  const gang = gangSize >= 3;
  if (gang && Math.random() < 0.35) game.replay.bigHit = true; // occasional gang-tackle highlight

  // A committed tackle (a lost battle) skips every escape — straight down.
  // Blitz: a well-timed JUKE makes the first man whiff right past — and down.
  if (!force && carrier.jukeTimer > 0) {
    carrier.jukeTimer = 0;
    knockdownDefender(lead);
    shake.add(0.15);
    setStatus('WHIFF!');
    return;
  }

  // 1-on-1 break-tackle BATTLE: a lone tackler on the ball carrier kicks off a
  // mash duel — your chance to break free. (Only when YOU carry the ball; on
  // defense your tackle just sticks.) It's a true 1-on-1 if no OTHER defender is
  // right on top of you (within BATTLE_SOLO_R) — decoupled from the wide swarm
  // radius so a hit in space starts a battle even with help a few yards out. A
  // genuine swarm (someone already in your lap) can't be broken this way.
  const helpers = game.defense.reduce((n, d) =>
    n + (d !== lead && !d.ragdolling && distXZ(px(d), cp) <= BATTLE_SOLO_R ? 1 : 0), 0);
  if (!force && game.userOnOffense && helpers === 0 && game.battle.cd <= 0 && Math.random() < TUNE.battleChance) {
    startBattle(lead, big);
    return;
  }

  // Otherwise (a gang, or while the battle is on cooldown): a small strength +
  // momentum chance to bust through anyway (TackleEngine.tryBreak) — your run only.
  if (!force && game.userOnOffense && tryBreak(carrier, pile)) {
    knockdownDefender(lead);
    carrier.vel.x *= 0.8; carrier.vel.z *= 0.8;
    if (carrier.actions.hitreact && carrier.oneShotT <= 0) playOneShot(carrier, 'hitreact', TUNE.staggerDur, true); // rocked, but powers through
    shake.add(0.2);
    shake.kick(carrier.vel.x, carrier.vel.z, 0.4);
    showBanner('BROKE IT!', '#bfffd0');
    return;
  }

  // Committed to bringing him down: close the gap so the pile makes real CONTACT
  // instead of forming a yard short of the carrier. Snap each tackler onto him
  // along his own approach line (carrier is the anchor). Runs before every
  // takedown path (fumble / strip / drag / ragdoll) so they all start tight.
  const CONTACT = 0.65;
  for (const t of pile) {
    const tp = t.group.position;
    const dx = cp.x - tp.x, dz = cp.z - tp.z, dd = Math.hypot(dx, dz);
    if (dd > CONTACT) { tp.x = cp.x - dx / dd * CONTACT; tp.z = cp.z - dz / dd * CONTACT; }
    drainFatigue(t, big ? 0.16 : 0.1); // making the tackle is tiring (more on a big hit)
  }
  drainFatigue(carrier, big ? 0.2 : 0.13); // taking the hit / fighting the pile wears the carrier most

  // Random FUMBLE: a jarring hit can knock the ball loose. Bigger hits and gang
  // tackles pop it more often — and a hit while TAUNTING strips it every time
  // (that's the risk of showboating). The carrier goes down and the ball pops
  // free for a live scramble (see startFumble) instead of the play ending.
  // A receiver hit RIGHT after a contested catch (Phase 3) is jarring + exposed: the
  // ball pops loose far more often, scaled by the catch style he chose.
  let fProb = ((big ? 0.12 : 0.035) + (gang ? 0.05 : 0)) * TUNE.fumbleChance;
  if (carrier.catchExposed > 0) { fProb += TUNE.catchHitRisk * (carrier.catchExposeRisk || 0.5); big = true; carrier.catchExposed = 0; }
  if (carrier.tauntT > 0 || Math.random() < fProb) {
    const variant = pickVariant(big, gangSize, closing, hitX, hitZ);
    const hitSpeed = THREE.MathUtils.clamp(2 + closing * 0.45, 2.5, 8);
    spawnRagdoll(carrier, new THREE.Vector3(carrier.vel.x, 0, carrier.vel.z), hitDir, hitSpeed, 0x0002, variant);
    lead.heading = Math.atan2(hitX, hitZ); playOneShot(lead, 'tackle', 0.45);
    startFumble(carrier, hitX, hitZ);
    return;
  }

  // Rare clean STRIP going down: a big or gang hit occasionally jars the ball
  // loose and the defense falls on it as the carrier hits the turf — no
  // scramble, just a turnover at the spot (resolveTackleEnd routes the settle to
  // a fumble). Distinct from the bouncing live-ball scramble above.
  if ((big || gang) && Math.random() < 0.08) game.fumbleLost = true;

  // Tackle kinematics: a violent SQUARE hit (committed, or a fast/turbo collision
  // ~60% of the time) drops him on the spot — an instant ragdoll. Otherwise it's
  // a WRAP & DRAG-DOWN: the tacklers latch on and bring him down over a beat,
  // longer for a lone man and quicker as the gang piles on.
  if (!(force || (big && Math.random() < 0.6))) {
    beginDrag(carrier, pile, big, hitDir, closing);
    return;
  }

  // Pile momentum: mass-weighted COM velocity of carrier + tacklers, bled by
  // wrap-up friction as the pile grows, plus a shove off the lead tackler.
  let mx = carrier.vel.x * 1.15, mz = carrier.vel.z * 1.15, mass = 1.15;
  for (const t of pile) { mx += t.vel.x; mz += t.vel.z; mass += 1; }
  const kappa = THREE.MathUtils.clamp(0.12 + 0.06 * (gangSize - 1), 0.12, 0.3);
  const shove = big ? 3.4 : 1.4;
  const pvx = (mx / mass) * (1 - kappa) + (hitX / hl) * shove;
  const pvz = (mz / mass) * (1 - kappa) + (hitZ / hl) * shove;
  const beat = THREE.MathUtils.clamp(0.2 + gangSize * 0.035 + (big ? 0.08 : 0), 0.2, 0.42);

  // Carrier ragdolls with the contact-picked reaction; the closest tacklers
  // recoil the other way (varied so a pile isn't a mirror image).
  const variant = pickVariant(big, gangSize, closing, hitX, hitZ);
  const hitSpeed = THREE.MathUtils.clamp(2 + closing * 0.45, 2.5, 8);
  spawnRagdoll(carrier, new THREE.Vector3(carrier.vel.x, 0, carrier.vel.z), hitDir, hitSpeed, 0x0002, variant);
  const back = hitDir.clone().negate();
  // Lead tackler makes the hit with a head-down lunge (no roll) instead of
  // ragdolling, then pops back to his feet (idle); extra gang members
  // ragdoll-recoil so a pile still tumbles.
  lead.heading = Math.atan2(hitX, hitZ); // square up on the ball carrier
  playOneShot(lead, 'tackle', 0.45);
  const bits = [0x0004, 0x0008];
  for (let i = 1; i < Math.min(pile.length, RAGDOLL_MAX); i++) {
    const t = pile[i];
    spawnRagdoll(t, new THREE.Vector3(t.vel.x, 0, t.vel.z), back, hitSpeed * 0.55, bits[i - 1] ?? 0x0004, 'sideSwipe');
  }

  // Hold the play while physics plays the fall; the pile slides with its momentum.
  game.state = STATE.TACKLE;
  game.tackleTimer = 2.0;
  game.tackleSpotZ = cp.z + pvz * beat * 0.6;
  blowWhistle(); // carrier is down — whistle on contact, before the fall plays out
  ctrlRing.visible = false;
  updateButtons();

  // Impact juice (tiering from TackleEngine.impactFx): the camera gets SHOVED
  // the way the runner is driven, big hits freeze then play out in slow-mo
  // with a tight close-up, and the callout pops center-screen.
  // Smooth, deep slow-mo (no freeze frame): ease down into bullet-time and ramp
  // back up, with the camera zooming in for the whole beat.
  shake.kick(hitX, hitZ, big ? 0.9 : gang ? 0.7 : 0.35);
  burst(cp.x, 1.0, cp.z, 0xe8d9a0, big || gang ? 18 : 11, big || gang ? 9 : 6); // dust/impact
  if (big || gang) {
    const power = hitPower(lead, closing, gangSize, big);
    // The most violent square hits (turbo + huge closing) read as a DIRTY HIT.
    const dirty = big && lead.turbo && closing > 10.5;
    if (dirty) { timeScale.bulletTime(0.05, 0.95, 1.45); hitZoom(2.2, 1.7); shake.add(0.85); impactFlash(true); }      // deepest slow-mo, tightest punch-in
    else if (gang) { timeScale.bulletTime(0.07, 0.85, 1.25); hitZoom(2.0, 1.45); shake.add(0.72); impactFlash(true); }
    else { timeScale.bulletTime(0.09, 0.75, 1.15); hitZoom(1.7, 1.35); shake.add(0.5); impactFlash(false); }
    audio.bigHit();
    // Gore: most often the helmet pops off; rarely the whole body is RIPPED IN
    // HALF at the waist (head stays with the top). The two are mutually exclusive.
    const tear = (big || gang) && Math.random() < 0.4;
    if (tear) tearInHalf(carrier, hitX, hitZ, power);
    else if (big || gang || dirty) popHelmet(carrier, hitX, hitZ, power);
    if (dirty && lead.actions.celebrate && !lead.ragdolling) { lead.heading = Math.atan2(hitX, hitZ); playOneShot(lead, 'celebrate', 1.3, true); }
    if (tear) showBanner('RIPPED IN HALF!', '#ff2a2a', { power });
    else if (dirty) showBanner('DIRTY HIT!', '#37d0e0', { power });
    else showBanner(gang ? 'GANG TACKLE!' : 'BIG HIT!', gang ? '#ff9a3a' : '#ff5a3a', { power });
    setStatus(tear ? 'RIPPED IN HALF!' : dirty ? 'DIRTY HIT!' : gang ? 'GANG TACKLE!' : 'BIG HIT!');
    audio.say(dirty ? 'dirtyHit' : gang ? 'gang' : 'bigHit');
    game.replay.bigHit = true; // a violent instant hit (big/dirty/gang) always earns the slow-mo highlight
  } else {
    timeScale.bulletTime(0.22, 0.4, 0.7);
    hitZoom(0.9);
    shake.add(0.18);
    audio.hit(0.6);
    setStatus('Tackled!');
  }
}

// WRAP & DRAG-DOWN: the tacklers latch onto the still-upright runner and drive
// him down over a short struggle (more/stronger tacklers => quicker), then the
// whole pile collapses into ragdolls (collapseDrag). This is the non-instant
// path so tackles read as real contact, not a snap to the turf.
function beginDrag(carrier, pile, big, hitDir, closing) {
  const d = game.drag;
  game.state = STATE.TACKLE;
  d.active = true; d.t = 0; d.hx = hitDir.x; d.hz = hitDir.z; d.grabbers = pile.slice();
  d.big = big; d.closing = closing; d.gangShown = pile.length;
  carrier.oneShotT = 0; // cancel a leftover move so it can't keep the body lifted/floating during the drag
  d.dur = dragTakedownTime(pile, carrier);
  // Latch each man into a slot fanned around the carrier's back/sides.
  const baseAng = Math.atan2(-hitDir.x, -hitDir.z);
  d.baseAng = baseAng;
  pile.forEach((t, i) => latchGrabber(t, baseAng, i));
  const cp = carrier.group.position;
  shake.kick(hitDir.x, hitDir.z, big ? 0.6 : 0.4);
  burst(cp.x, 1.0, cp.z, 0xe8d9a0, pile.length >= 2 ? 13 : 9, 6);
  audio.hit(0.55);
  timeScale.bulletTime(0.55, 0.18, 0.3); // a beat of slow-mo on contact
  const gang = pile.length >= 3;
  if (gang) { showBanner('GANG TACKLE!', '#ff9a3a', { power: hitPower(pile[0], closing, pile.length, big) }); audio.say('gang'); }
  else showBanner(pile.length >= 2 ? 'WRAPPED UP!' : 'TACKLE!', '#ffd23a', { icon: 'burst', power: hitPower(pile[0], closing, pile.length, big) });
  setStatus(pile.length >= 2 ? `${pile.length}-man gang tackle!` : 'Wrapped up — bringing him down!');
  ctrlRing.visible = false; updateButtons();
}
// Takedown time: wrap-up power (count + TACKLING) vs the carrier's strength/speed.
// More bodies and stronger tacklers bring him down faster.
function dragTakedownTime(pile, carrier) {
  let wrap = 0; for (const t of pile) wrap += 0.5 + (t.rt ? t.rt.tackle : 0.6);
  const car = 0.6 + (carrier.rt ? carrier.rt.strength : 0.7) + Math.hypot(carrier.vel.x, carrier.vel.z) / 22;
  return THREE.MathUtils.clamp(1.05 - (pile.length - 1) * 0.2 - (wrap - car) * 0.22, 0.32, 1.15);
}
// Latch a tackler into a fanned slot around the carrier's back/sides.
function latchGrabber(t, baseAng, i) {
  t.grabbing = true;
  t.grabSlot = baseAng + (i === 0 ? 0 : (i % 2 ? 1 : -1) * (0.55 + 0.22 * i));
  t.vel.set(0, 0, 0); t.oneShotT = 0; // no leftover one-shot fighting the wrap pose
}
function updateDrag(dt) {
  const d = game.drag, carrier = game.carrier;
  if (!carrier) { d.active = false; return; }
  d.t += dt;
  const cp = carrier.group.position;
  // Late pile-on: nearby defenders crash the wrap, swelling the gang and
  // speeding the takedown (each new wrap shortens what's left + jolts the pile).
  if (d.grabbers.length < GANG_MAX) {
    for (const dfn of game.defense) {
      if (d.grabbers.length >= GANG_MAX) break;
      if (dfn.ragdolling || dfn.grabbing || d.grabbers.includes(dfn)) continue;
      if (distXZ(px(dfn), cp) > TUNE.swarmRadius * 0.85) continue;
      latchGrabber(dfn, d.baseAng, d.grabbers.length);
      d.grabbers.push(dfn);
      d.dur = Math.max(d.t + 0.16, dragTakedownTime(d.grabbers, carrier)); // recompute with the bigger pile
      shake.add(0.12); burst(cp.x, 0.9, cp.z, 0xe8d9a0, 6, 5); audio.hit(0.32);
      if (d.grabbers.length > d.gangShown && d.grabbers.length >= 3) { // swelled into a gang — upgrade the callout
        d.gangShown = d.grabbers.length;
        showBanner('GANG TACKLE!', '#ff9a3a', { power: hitPower(d.grabbers[0], d.closing, d.grabbers.length, d.big) });
        setStatus(`${d.grabbers.length}-man gang tackle!`);
      }
    }
  }
  // The runner is dragged: hard deceleration, then a stat-driven pile drive — a
  // big gang stuffs him and even drives him BACK; a lone wrap just stalls him.
  carrier.vel.x *= Math.pow(0.03, dt); carrier.vel.z *= Math.pow(0.03, dt);
  carrier.group.position.x += carrier.vel.x * dt; carrier.group.position.z += carrier.vel.z * dt;
  let wrapPow = 0; for (const t of d.grabbers) wrapPow += 0.5 + (t.rt ? t.rt.tackle : 0.6);
  const carPow = 0.9 + (carrier.rt ? carrier.rt.strength : 0.7);
  const drive = THREE.MathUtils.clamp((carPow - wrapPow) * 0.7, -2.4, 0.5); // + sneaks forward, - driven back
  cp.z += game.dir * drive * dt;
  carrier.speed = Math.max(4.5, Math.hypot(carrier.vel.x, carrier.vel.z)); // churn the legs — he's fighting it
  clampToField(carrier);
  // Forward progress can still carry him across the goal while being dragged.
  if (reachedGoal(cp.z)) { d.active = false; for (const t of d.grabbers) t.grabbing = false; endPlay('TD', cp.z); return; }
  // Latch grabbers around him, easing into their slot and churning to drive him.
  for (const t of d.grabbers) {
    if (t.ragdolling) continue;
    const grad = Math.max(0.12, TUNE.gapGrab); // floored so grabbers don't collapse onto the carrier's point
    const tx = cp.x + Math.sin(t.grabSlot) * grad, tz = cp.z + Math.cos(t.grabSlot) * grad;
    const k = Math.min(1, dt * 12);
    t.group.position.x += (tx - t.group.position.x) * k;
    t.group.position.z += (tz - t.group.position.z) * k;
    t.heading = Math.atan2(cp.x - t.group.position.x, cp.z - t.group.position.z);
    clampToField(t); // a grab near the wall must not shove the grabber out of the cage
    t.speed = 8; // churn the legs (driving him back) — see updateAnimation grab pose
  }
  for (const ch of game.all) if (!ch.ragdolling && ch !== carrier && !d.grabbers.includes(ch)) { ch.speed = 0; ch.vel.set(0, 0, 0); }
  if (d.t >= d.dur) collapseDrag();
}
function collapseDrag() {
  const d = game.drag, carrier = game.carrier;
  if (!carrier) { d.active = false; for (const t of d.grabbers) t.grabbing = false; return; }
  d.active = false;
  const cp = carrier.group.position;
  const hitDir = new THREE.Vector3(d.hx, 0, d.hz);
  // The pile gives way: carrier + the nearest grabbers ragdoll and tumble down.
  spawnRagdoll(carrier, new THREE.Vector3(carrier.vel.x, 0, carrier.vel.z), hitDir, 3.4, 0x0002,
    pickVariant(false, d.grabbers.length, 6, d.hx, d.hz));
  popHelmet(carrier, d.hx, d.hz, hitPower(d.grabbers[0], d.closing, d.grabbers.length, d.big)); // TESTING: lid off on the pile collapse too
  const bits = [0x0004, 0x0008, 0x0010];
  const size = d.grabbers.length, heavy = size >= 3;
  // Cap how many bodies actually ragdoll (carrier + up to 2 tacklers) so a crowded
  // pile can't shove bodies through the turf; extra grabbers just release.
  const ragMax = RAGDOLL_MAX - 1;
  let ragged = 0;
  for (const t of d.grabbers) {
    t.grabbing = false;
    if (ragged < ragMax && !t.ragdolling) {
      const toC = new THREE.Vector3(cp.x - t.group.position.x, 0, cp.z - t.group.position.z);
      if (toC.lengthSq() < 1e-4) toC.copy(hitDir); else toC.normalize();
      spawnRagdoll(t, new THREE.Vector3(t.vel.x, 0, t.vel.z), toC, 3.0, bits[ragged] ?? 0x0004, 'sideSwipe');
      ragged++;
    }
  }
  game.tackleTimer = 2.0; game.tackleSpotZ = cp.z;
  blowWhistle();
  shake.add(heavy ? 0.5 : 0.34); shake.kick(d.hx, d.hz, heavy ? 0.72 : 0.5);
  burst(cp.x, 0.8, cp.z, 0xe8d9a0, 14 + size * 4, 7 + size);
  audio.hit(heavy ? 0.85 : 0.7);
  if (heavy) { timeScale.bulletTime(0.12, 0.6, 1.0); hitZoom(1.3); impactFlash(true); } // dramatic gang pile-collapse
}
// Grabber pose during the drag: lean into the carrier and wrap him up (reuses the
// tackler grapple arms), legs churning from the artificial drive speed above.
function applyGrabLean(ch, w = 1) {
  w *= TUNE.animGrab;
  const lean = 0.4 + Math.sin(performance.now() * 0.014) * 0.06;
  blendLean(ch, lean, 0, w);
}

// --- Live fumble: the ball pops loose, glows, bounces, and both teams dive ---
function nearestTeamToBall(team) {
  const bp = ball.mesh.position; let best = null, bestD = Infinity;
  for (const p of team) { if (p.ragdolling) continue; const d = dist2(px(p), bp); if (d < bestD) { bestD = d; best = p; } }
  return best || team[0];
}
function setFumbleGlow(on) {
  setBallEmissive(on ? 0xffcc33 : 0x000000, on ? 0.9 : 0);
  if (ball.flame) { ball.flame.color.setHex(on ? 0xffd23a : 0xff6622); ball.flame.intensity = on ? 3.5 : (game.onFire ? 2 : 0); ball.flame.distance = on ? 10 : 7; }
}
// A pass that caromed off the fence drops in as a LIVE loose ball (scramble),
// keeping its current bounced velocity — never an incompletion.
function ballLooseFromAir() {
  game.state = STATE.LOOSE; game.looseTimer = 5.0;
  ball.mode = 'loose'; ball.holder = null; ball.catcher = null; ball.targetRecv = null; ball.g = 24;
  ball.fromFence = true; // a defense recovery of THIS loose ball is an interception
  ball.grabCd = 0.55;    // let it bounce before anyone can fall on it
  setFumbleGlow(true); landRing.visible = false;
  game.controlled = nearestTeamToBall(game.teamA);
  ctrlRing.visible = true; selRing.visible = false;
  showBanner('OFF THE FENCE!', '#7fe0ff'); audio.fence(0.6); shake.add(0.15);
  setStatus('Loose ball — recover it!'); updateButtons();
}
// Phase 3: a defender's swat doesn't always kill the play — it can TIP the ball,
// popping it live off the deflection point so either team can scramble for it (a
// defense recovery counts as the interception, like a fence carom).
function ballTippedLoose(deflector) {
  const p = ball.mesh.position;
  game.state = STATE.LOOSE; game.looseTimer = 5.0;
  ball.mode = 'loose'; ball.holder = null; ball.catcher = null; ball.targetRecv = null;
  ball.fromFence = true; ball.g = 24; ball.grabCd = 0.45; game.looseCrowdT = 0; // defense recovery = INT; let it bounce first
  const ang = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 5; // small random pop off the tip
  ball.vx = Math.sin(ang) * sp; ball.vz = Math.cos(ang) * sp; ball.vy = 4 + Math.random() * 3;
  ball.spin = 0; ball.spinRate = 16;
  setFumbleGlow(true); landRing.visible = false;
  if (deflector) { deflector.catchLeap = false; deflector.catchPlant = false; deflector.heading = Math.atan2(p.x - deflector.group.position.x, p.z - deflector.group.position.z); triggerArmAction(deflector, 'swat', 0.4, p); }
  burst(p.x, Math.max(0.5, p.y), p.z, 0xdfe7ff, 12, 7); shake.add(0.18);
  if (game.userCatch) game.userCatch.on = false;
  selRing.visible = false; selRing.scale.set(1, 1, 1); hideCatchRow();
  game.controlled = nearestTeamToBall(game.teamA); ctrlRing.visible = true;
  showBanner('TIPPED!', '#9fd0ff'); audio.fence(0.45);
  setStatus('Tipped — it\'s live!'); updateButtons();
}
function startFumble(carrier, hitX, hitZ) {
  if (game.tally) game.tally.fumbles++;
  game.state = STATE.LOOSE; game.looseTimer = 5.0;
  const cp = carrier.group.position;
  ball.mode = 'loose'; ball.holder = null; ball.catcher = null; ball.targetRecv = null; ball.fromFence = false; ball.grabCd = 0.55; // let it bounce before anyone can fall on it
  ball.mesh.position.set(cp.x, 1.2, cp.z);
  const ang = Math.atan2(hitX, hitZ) + (Math.random() - 0.5) * 1.4, sp = 10 + Math.random() * 9; // bounces well clear of the pile
  ball.vx = Math.sin(ang) * sp; ball.vz = Math.cos(ang) * sp; ball.vy = 6 + Math.random() * 4;
  ball.g = 24; ball.spin = 0; ball.spinRate = 10; game.looseCrowdT = 0;
  setFumbleGlow(true);
  game.controlled = nearestTeamToBall(game.teamA); // scramble with your team
  ctrlRing.visible = true; selRing.visible = false;
  showBanner('FUMBLE!!!', '#ff3a2a'); audio.bigHit(); audio.groan(); audio.say('fumble', { force: true, swell: 0.6 });
  shake.add(0.6); timeScale.bulletTime(0.2, 0.4, 0.8); hitZoom(1.0);
  burst(cp.x, 1.1, cp.z, 0xffd23a, 20, 9);
  setStatus('FUMBLE — recover it!'); updateButtons();
}
function updateLoose(dt, turboOn, actionEdge) {
  const p = ball.mesh.position;
  if (ball.grabCd > 0) ball.grabCd -= dt;
  // Bouncing, glowing loose ball — lively and unpredictable.
  ball.vy -= ball.g * dt;
  p.x += ball.vx * dt; p.y += ball.vy * dt; p.z += ball.vz * dt;
  const gy = 0.22;
  if (p.y <= gy) {
    p.y = gy;
    if (ball.vy < 0) { ball.vy = -ball.vy * 0.6; if (ball.vy < 1.0) ball.vy = 0; } // bouncier
    ball.vx *= 0.86; ball.vz *= 0.86;
    // Erratic squirt off the point of the ball — a fumble hops, but not so wildly
    // that it can't be corralled.
    if (Math.abs(ball.vy) > 0.8 || Math.hypot(ball.vx, ball.vz) > 1.2) {
      const a = Math.random() * Math.PI * 2, k = 0.8 + Math.random() * 2.0;
      ball.vx += Math.cos(a) * k; ball.vz += Math.sin(a) * k;
      if (ball.vy < 1.2) ball.vy += Math.random() * 1.8; // occasional small pop up
    }
  }
  ball.vx *= (1 - dt * 0.6); ball.vz *= (1 - dt * 0.6); // settles fairly quickly so it can be recovered
  ball.spin += (ball.spinRate + Math.hypot(ball.vx, ball.vz) * 1.2) * dt;
  ball.mesh.rotation.set(ball.spin * 0.6, ball.spin, ball.spin * 0.35); // chaotic tumble
  if (ball.flame) ball.flame.intensity = 2.6 + Math.sin(performance.now() * 0.02) * 1.4; // pulse
  cageBounce(p, 0.6); // a loose ball ricochets off the cage and stays live
  // Only the nearest few from each team chase the ball (no 14-man pile), and they
  // spread around it via separation; everyone else holds. Keeps it from being mayhem.
  const byBall = (a, b) => dist2(px(a), p) - dist2(px(b), p);
  const nearA = game.teamA.filter((c) => !c.ragdolling).sort(byBall).slice(0, 3);
  const nearB = game.teamB.filter((c) => !c.ragdolling).sort(byBall).slice(0, 3);
  const chasers = new Set([...nearA, ...nearB]);
  const ballLow = p.y < 1.3;
  for (const ch of game.all) {
    if (ch.recoverT > 0) ch.recoverT -= dt;
    if (ch.scoopDiveCd > 0) ch.scoopDiveCd -= dt;
    if (ch.ragdolling || ch === game.controlled) continue;
    if (chasers.has(ch)) {
      const d = Math.hypot(ch.group.position.x - p.x, ch.group.position.z - p.z);
      // Players DIVE on the loose ball when they get close — lunge + scoop, which
      // extends their reach/odds for a beat (same as the user's dive).
      if (ballLow && d < 2.7 && ch.recoverT <= 0 && (ch.scoopDiveCd || 0) <= 0) {
        const dx = p.x - ch.group.position.x, dz = p.z - ch.group.position.z, l = Math.hypot(dx, dz) || 1;
        ch.vel.x = dx / l * ch.baseSpeed * 1.3; ch.vel.z = dz / l * ch.baseSpeed * 1.3; ch.heading = Math.atan2(dx, dz);
        ch.recoverT = 0.5; ch.scoopDiveCd = 1.1;
        if (ch.actions.scoop) playOneShot(ch, 'scoop', 0.6, true); else triggerArmAction(ch, 'pick', 0.45, p);
      } else { ch.desired = addSteer(seek(px(ch), p.x, p.z), separation(ch, game.all, 2.2), 0.5); ch.turbo = true; }
    } else { ch.desired = { x: 0, z: 0 }; ch.turbo = false; } // the rest hold, don't pile on
  }
  if (game.controlled) {
    const top = game.controlled.baseSpeed * (turboOn ? TUNE.turboMult : 1);
    controlledMove(game.controlled, dt, top);
    if (actionEdge) { // dive on the ball — extends your reach + recovery odds for a beat
      const o = game.controlled, dx = p.x - o.group.position.x, dz = p.z - o.group.position.z, l = Math.hypot(dx, dz) || 1;
      o.vel.x = dx / l * o.baseSpeed * 1.4; o.vel.z = dz / l * o.baseSpeed * 1.4; o.heading = Math.atan2(dx, dz);
      o.recoverT = 0.6;
      if (o.actions.scoop) playOneShot(o, 'scoop', 0.6, true); // diving scoop animation
      else triggerArmAction(o, 'pick', 0.45, p);          // procedural dive-reach fallback
    }
  }
  for (const ch of game.all) if (ch !== game.controlled && !ch.ragdolling) applySteer(ch, dt);
  // Recovery: only a LOW, settling ball can be fallen on — and even then it can be
  // BOBBLED loose again (random). A hot, squirting ball can't be corralled at all.
  const hsp = Math.hypot(ball.vx, ball.vz);
  if (ball.grabCd <= 0 && p.y < 1.3 && hsp < 7.5) {
    let rec = null, recD = Infinity;
    for (const ch of game.all) {
      if (ch.ragdolling) continue;
      const reach = ch.recoverT > 0 ? 2.6 : 1.4; // a dive reaches much farther; standing is generous too
      const d = Math.hypot(ch.group.position.x - p.x, ch.group.position.z - p.z);
      if (d <= reach && d < recD) { recD = d; rec = ch; }
    }
    if (rec) {
      const settle = THREE.MathUtils.clamp(1 - hsp / 7.5, 0, 1); // 0 hot .. 1 dead
      const pGet = 0.4 + settle * 0.5 + (rec.recoverT > 0 ? 0.35 : 0); // diving on a settling ball = near-sure
      if (Math.random() < pGet) { recoverFumble(rec); return; }
      // MUFFED — kick it loose again with a smaller squirt; brief grab cooldown.
      const a = Math.random() * Math.PI * 2, k = 2 + Math.random() * 2.5;
      ball.vx += Math.cos(a) * k; ball.vz += Math.sin(a) * k; ball.vy = 1.8 + Math.random() * 2.2;
      ball.grabCd = 0.35; rec.recoverT = 0; shake.add(0.12);
    }
  }
  // Pile-up scrum: if 3+ players crowd a settled ball and nobody's fallen on it,
  // a mash duel decides possession.
  if (game.scrum.cd <= 0 && ball.grabCd <= 0 && p.y < 1.0 && hsp < 4) {
    let near = 0;
    for (const ch of game.all) if (!ch.ragdolling && Math.hypot(ch.group.position.x - p.x, ch.group.position.z - p.z) < 2.6) near++;
    game.looseCrowdT = near >= 3 ? game.looseCrowdT + dt : 0;
    if (game.looseCrowdT > 0.8) { startScrum(p); return; }
  } else game.looseCrowdT = 0;
  game.looseTimer -= dt;
  if (game.looseTimer <= 0) recoverDead(p.z);
}
const SCRUM_TIME = 2.6, SCRUM_TAP = 0.085, SCRUM_CPU = 0.26;
// A pile fighting for a loose ball: mash to drag possession to YOUR team (teamA).
function startScrum(p) {
  const s = game.scrum;
  game.state = STATE.BATTLE; s.active = true; s.val = 0.5; s.timer = SCRUM_TIME; s.x = p.x; s.z = p.z; s.flash = 0;
  s.crew = game.all.filter((c) => !c.ragdolling && Math.hypot(c.group.position.x - p.x, c.group.position.z - p.z) < 4.5).slice(0, 8);
  for (const c of s.crew) { c.vel.set(0, 0, 0); c.speed = 0; }
  ball.vx = ball.vy = ball.vz = 0; ball.mesh.position.set(p.x, 0.4, p.z); // pinned in the pile
  ctrlRing.visible = false; hitZoom(SCRUM_TIME + 0.4);
  battlePrompt.textContent = 'FIGHT FOR THE BALL!';
  battleEl.classList.remove('hidden');
  setStatus('Mash to win the loose ball!'); updateButtons();
  audio.bigHit(); shake.add(0.2);
}
function updateScrum(dt) {
  const s = game.scrum;
  s.timer -= dt;
  if (input.battleMash > 0) { s.val += input.battleMash * SCRUM_TAP; input.battleMash = 0; }
  s.val = THREE.MathUtils.clamp(s.val - SCRUM_CPU * dt, 0, 1); // CPU drags toward its team
  // Jostle the pile in a tight ring around the ball; a small heave with the meter.
  const heave = (s.val - 0.5) * 1.4, t = performance.now() * 0.018;
  s.crew.forEach((c, i) => {
    if (c.ragdolling) return;
    const a = (i / Math.max(1, s.crew.length)) * Math.PI * 2;
    const r = 0.9 + Math.sin(t + i) * 0.12;
    c.group.position.x = s.x + Math.cos(a) * r; c.group.position.z = s.z + Math.sin(a) * r;
    c.heading = Math.atan2(s.x - c.group.position.x, s.z - c.group.position.z); c.speed = 4; // churn
  });
  ball.mesh.position.set(s.x, 0.4 + Math.abs(Math.sin(t * 1.7)) * 0.12, s.z + heave * 0.1);
  if (ball.flame) ball.flame.intensity = 2.6 + Math.sin(performance.now() * 0.02) * 1.4;
  battleFill.style.width = `${Math.round(s.val * 100)}%`;
  battleDiv.style.left = `${Math.round(s.val * 100)}%`;
  if (s.val >= 1) return endScrum(true);
  if (s.val <= 0) return endScrum(false);
  if (s.timer <= 0) endScrum(s.val >= 0.5);
}
function endScrum(userWon) {
  const s = game.scrum; s.active = false; s.cd = 2.0; game.looseCrowdT = 0;
  battleEl.classList.add('hidden');
  const team = userWon ? game.teamA : game.teamB;
  let rec = null, rd = Infinity;
  for (const c of team) { if (c.ragdolling) continue; const d = dist2(px(c), { x: s.x, z: s.z }); if (d < rd) { rd = d; rec = c; } }
  ball.mode = 'loose'; recoverFumble(rec || team[0]); // winner falls on it
}
function recoverFumble(ch) {
  setFumbleGlow(false);
  ball.mode = 'carried'; ball.holder = ch; game.carrier = ch; ball.targetRecv = null; // ball follows the recoverer
  ball.mesh.visible = true; ball.mesh.position.set(ch.group.position.x, 1.0, ch.group.position.z); // snap it onto him — never leave it on the turf
  ball.vx = ball.vy = ball.vz = 0;
  triggerArmAction(ch, 'pick', 0.5, ball.mesh.position); // procedural dive-on-the-ball
  audio.catch(); shake.add(0.25);
  if (game.offense.includes(ch)) {
    // Your own recovery is LIVE — scoop and score (advance it) instead of dead at the spot.
    if (game.play) game.play.recovered = true;
    showBanner('SCOOP & GO!', '#bfffd0');
    enterRun(ch, 'Recovered — take it to the house!');
  } else if (ball.fromFence) beginReturn(ch, 'pick');     // overthrow caromed off the fence = pick; live runback
  else beginReturn(ch, 'fumble');                          // defense scooped a live fumble = returnable runback
}
function recoverDead(spotZ) {
  setFumbleGlow(false); ball.mode = 'rest';
  showBanner('BALL IS DEAD', '#ffd23a');
  endPlay('tackle', THREE.MathUtils.clamp(spotZ, OWN_GOAL_Z + 1, GOAL_Z - 1)); // offense keeps it
}

function anyRagdollActive() {
  for (const ch of game.all) if (ch.ragdolling && ch.ragdoll && ch.ragdoll.active) return true;
  return false;
}

// Snap a player's bones back to their rest transforms. CRITICAL: clips are
// rotation-only (the mixer writes quaternions + Hips.Y, never other bone
// POSITIONS), so anything that moves bone positions — the ragdoll drive AND the
// instant replay (applyReplayFrame overwrites every bone position with recorded,
// sometimes ragdoll-collapsed, frames) — leaves them permanently displaced
// unless we restore them here. Without it: legs under the turf, worsening each
// replay. Must run for ALL players, not just the ones flagged ragdolling.
function restoreRestPose(ch) {
  if (!ch.restPose) return;
  for (const [bone, pos, quat] of ch.restPose) { bone.position.copy(pos); bone.quaternion.copy(quat); }
}
function clearRagdolls() {
  for (const ch of game.all) {
    const wasRagdoll = ch.ragdolling || (ch.ragdoll && ch.ragdoll.active);
    if (ch.ragdoll) ch.ragdoll.dispose();
    ch.ragdolling = false;
    restoreRestPose(ch);
    if (wasRagdoll && ch.mixer) ch.mixer.setTime(0); // re-evaluate the current clip onto the clean pose
  }
}

// ===========================================================================
// Controlled movement + animation
// ===========================================================================
// Movement feel ported from Football-Game/Player.step: integrate toward the
// desired velocity at a real acceleration, braking HARDER than accelerating
// (hardest with no input at all) so stops and cuts are crisp; rate-limit the
// heading so the player carves through turns instead of teleport-turning.
const ACCEL = 55;        // yd/s^2 (controlled player gets a 1.6x responsiveness boost)
const TURN_RATE = 9;     // rad/s heading carve
function brakeAmt(v, tv, baseA, moving) {
  const braking = Math.abs(tv) < Math.abs(v) || v * tv < 0;
  return baseA * (braking ? (moving ? 1.35 : 2.0) : 1);
}
function controlledMove(ch, dt, topSpeed) {
  topSpeed *= fatigueSpeed(ch); // tired players can't hit top speed
  const kb = kbVec();
  let ix = THREE.MathUtils.clamp(input.x + kb.x, -1, 1);
  let iy = THREE.MathUtils.clamp(input.y + kb.y, -1, 1);
  const mag = Math.min(1, Math.hypot(ix, iy));
  const moving = mag > 0.06;
  let dvx = 0, dvz = 0;
  if (moving) {
    camera.getWorldDirection(_f); _f.y = 0; _f.normalize();
    _r.crossVectors(_f, THREE.Object3D.DEFAULT_UP).normalize();
    _d.set(0, 0, 0).addScaledVector(_f, iy).addScaledVector(_r, ix).normalize();
    dvx = _d.x * topSpeed * mag; dvz = _d.z * topSpeed * mag;
  }
  const baseA = ACCEL * 1.6 * dt;
  ch.vel.x = moveToward(ch.vel.x, dvx, brakeAmt(ch.vel.x, dvx, baseA, moving));
  ch.vel.z = moveToward(ch.vel.z, dvz, brakeAmt(ch.vel.z, dvz, baseA, moving));
  ch.group.position.x += ch.vel.x * dt;
  ch.group.position.z += ch.vel.z * dt;
  ch.speed = Math.hypot(ch.vel.x, ch.vel.z);
  if (ch.speed > 0.5) ch.heading = turnToward(ch.heading, Math.atan2(ch.vel.x, ch.vel.z), TURN_RATE * dt);
  clampToField(ch);
}
function playOneShot(ch, name, hold, fit = false) {
  const a = ch.actions[name];
  if (!a) return;
  ch.oneShotT = hold; setClip(ch, name);
  // fit: speed the clip so it finishes (lands) within the hold instead of being
  // cut off mid-air — only ever speeds up, never slows a short clip down.
  if (fit) a.setEffectiveTimeScale(Math.max(1, a.getClip().duration / hold));
}

// Target the receiver the LEFT STICK is pointing at (camera-relative), like
// aiming the throw. Holds the last target when the stick is centered.
function aimReceiver() {
  const kb = kbVec();
  const ix = THREE.MathUtils.clamp(input.x + kb.x, -1, 1);
  const iy = THREE.MathUtils.clamp(input.y + kb.y, -1, 1);
  if (Math.hypot(ix, iy) < 0.35) return; // no clear aim -> keep current target
  camera.getWorldDirection(_f); _f.y = 0; _f.normalize();
  _r.crossVectors(_f, THREE.Object3D.DEFAULT_UP).normalize();
  _d.set(0, 0, 0).addScaledVector(_f, iy).addScaledVector(_r, ix).normalize(); // aim dir (world)
  const qp = game.qb.group.position;
  let best = 0.2, bestI = game.selected; // require a reasonable alignment
  for (let i = 0; i < game.receivers.length; i++) {
    const rp = game.receivers[i].group.position;
    const dx = rp.x - qp.x, dz = rp.z - qp.z, l = Math.hypot(dx, dz) || 1;
    const dot = (dx / l) * _d.x + (dz / l) * _d.z;
    if (dot > best) { best = dot; bestI = i; }
  }
  game.selected = bestI;
}
const _tq = new THREE.Quaternion(), _xAxisL = new THREE.Vector3(1, 0, 0);
const _poseTarget = new THREE.Quaternion();
// Weighted bone pose: instead of hard-setting a bone to (rest * rotation), SLERP
// from its current mixer-driven orientation toward that posed target by `w`. At
// w=1 it's the old hard set; as w eases 0<->1 the procedural pose blends in/out
// over the locomotion clip with no one-frame snap. Rotation is about _xAxisL.
function blendBone(bone, restQ, angle, w) {
  if (!bone || !restQ) return;
  _tq.setFromAxisAngle(_xAxisL, angle);
  _poseTarget.copy(restQ).multiply(_tq);
  bone.quaternion.slerp(_poseTarget, w);
  bone.updateMatrixWorld(true);
}
// Weighted root lean: blend the group toward a (heading+sway, forward-lean) pose
// by `w`, so a battle/grab/throw/sulk lean fades in and out over the plain stance.
function blendLean(ch, lean, sway, w) {
  _qLeanY.setFromAxisAngle(_UP, ch.heading + sway);
  _qLeanX.setFromAxisAngle(_XAX, lean);
  _poseTarget.copy(_qLeanY).multiply(_qLeanX);
  ch.group.quaternion.slerp(_poseTarget, w);
}
// Locomotion "life": the base root orientation gets a banking roll INTO turns (a
// runner leans like a sprinter carving), a forward pitch that grows with speed
// (and a touch more on turbo), and — when nearly still — a gentle breathing/weight
// shift so an idle player isn't a frozen statue. Builds yaw*pitch*roll into the
// group quaternion; the procedural leans (battle/throw/...) blend on top of this.
const _qYaw = new THREE.Quaternion(), _qPitch = new THREE.Quaternion(), _qRoll = new THREE.Quaternion();
const _ZAX = new THREE.Vector3(0, 0, 1), _YAX = new THREE.Vector3(0, 1, 0);
function applyLocoLife(ch, dt, spin) {
  let dH = ch.heading - ch.prevHeading;
  while (dH > Math.PI) dH -= Math.PI * 2; while (dH < -Math.PI) dH += Math.PI * 2;
  ch.prevHeading = ch.heading;
  const angVel = dt > 1e-4 ? dH / dt : 0;
  const spd = Math.min(ch.speed, 14);
  const wantBank = THREE.MathUtils.clamp(-angVel * 0.05 * (spd / 14), -0.4, 0.4) * TUNE.animBank; // carve into the turn
  ch.bank += (wantBank - ch.bank) * Math.min(1, dt * 8);
  const wantPitch = THREE.MathUtils.clamp((spd * 0.010 + (ch.turbo ? 0.05 : 0)) * TUNE.runLean, 0, 0.28); // subtle lean with speed (× knob)
  ch.lean += (wantPitch - ch.lean) * Math.min(1, dt * 6);
  let pitch = ch.lean, roll = ch.bank;
  if (ch.speed < 0.6) { // breathing + slow weight shift while standing
    const t = performance.now() * 0.001;
    pitch += Math.sin(t * 1.6 + ch.breathPh) * 0.012 * TUNE.animBreath;
    roll += Math.sin(t * 0.7 + ch.breathPh) * 0.02 * TUNE.animBreath;
  }
  _qYaw.setFromAxisAngle(_UP, ch.heading + spin);
  _qPitch.setFromAxisAngle(_XAX, pitch);
  _qRoll.setFromAxisAngle(_ZAX, roll);
  ch.group.quaternion.copy(_qYaw).multiply(_qPitch).multiply(_qRoll);
}
// Head-on-a-swivel: ease the head bone to look toward a world target (the nearest
// receiver / the ball) within a natural range, so a backpedaling DB tracks his man
// instead of staring straight back. Yaw about the head's local up axis.
// Advance a character's animation, then retarget its head onto this model's bind
// (no-op for the default/defense rigs). Every live mixer.update goes through here
// so alt-model heads stay level no matter which pose branch ran.
function stepMixer(ch, dt) {
  ch.mixer.update(dt);
  if (ch.headFix && ch.headBone) ch.headBone.quaternion.multiply(ch.headFix);
}
function applyHeadTrack(ch, targetPos, w, dt) {
  w *= TUNE.animHead;
  if (!ch.headBone) return;
  const dx = targetPos.x - ch.group.position.x, dz = targetPos.z - ch.group.position.z;
  let rel = Math.atan2(dx, dz) - ch.heading;
  while (rel > Math.PI) rel -= Math.PI * 2; while (rel < -Math.PI) rel += Math.PI * 2;
  const want = THREE.MathUtils.clamp(rel, -1.1, 1.1) * w; // clamp to a believable neck range
  ch.headYaw += (want - ch.headYaw) * Math.min(1, dt * 10);
  _tq.setFromAxisAngle(_YAX, ch.headYaw);
  ch.headBone.quaternion.multiply(_tq);
  ch.headBone.updateMatrixWorld(true);
}
// Smoothstep interpolation across [t,value] keyframes (t ascending in 0..1).
function keyAngle(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t <= b[0]) { const k = (t - a[0]) / Math.max(1e-4, b[0] - a[0]); return a[1] + (b[1] - a[1]) * (k * k * (3 - 2 * k)); }
  }
  return keys[keys.length - 1][1];
}
// Procedural THROW: a real over-the-top QB motion — a fast forward WHIP (the
// shoulder snaps over the top as the elbow extends), then a follow-through down
// and across, easing back to rest. The torso leans into it and the off arm comes
// up for balance. Asymmetric timing (quick whip, trailing follow-through) so it
// reads as a throw, not a symmetric wave. The over-the-top amount tracks the
// launch angle (a lob lofts more than a bullet). Rig-agnostic (arm bones + a
// small torso lean); left arm mirrors with positive angles (see applyCatchPose).
function applyThrowPose(ch, dt, w = 1) {
  w *= TUNE.animThrow;
  ch.throwAnimT -= dt;
  if (!ch.upperArm || !ch.upperArmRest) return;
  const t = THREE.MathUtils.clamp(1 - ch.throwAnimT / THROW_ANIM_DUR, 0, 1);
  const over = THREE.MathUtils.lerp(1.7, 2.3, THREE.MathUtils.clamp(ch.throwLaunch / 0.6, 0, 1)); // higher = more loft
  // Right (throwing) arm: a touch back, then snap over the top, follow through.
  blendBone(ch.upperArm, ch.upperArmRest, keyAngle([[0, 0.25], [0.16, -over], [0.42, -0.85], [1, 0]], t), w);
  // elbow: cocked/flexed, EXTENDS through the release, slight re-flex on follow-through
  blendBone(ch.foreArm, ch.foreArmRest, keyAngle([[0, -0.6], [0.1, -1.75], [0.26, -0.15], [0.6, -0.7], [1, 0]], t), w);
  // Off (left) arm: rises forward for balance during the whip, then tucks back.
  blendBone(ch.leftArm, ch.leftArmRest, keyAngle([[0, 0.2], [0.16, 1.15], [0.55, 0.35], [1, 0]], t), w);
  blendBone(ch.leftForeArm, ch.leftForeArmRest, keyAngle([[0, 0.3], [0.2, 1.0], [0.6, 0.5], [1, 0]], t), w);
  // Torso drives into the throw: a brief forward lean that peaks at the whip, plus
  // a hip/shoulder TWIST — wind back, then rotate through the release (the kinetic
  // chain) — so the throw uncoils from the core instead of being all arm.
  const lean = keyAngle([[0, 0], [0.16, 0.22], [0.5, 0.08], [1, 0]], t);
  const twist = keyAngle([[0, 0], [0.12, 0.2], [0.42, -0.14], [1, 0]], t);
  if ((Math.abs(lean) + Math.abs(twist)) * w > 0.001) blendLean(ch, lean, twist, w);
}
// Procedural CATCH: reach BOTH arms toward the ball, the raise scaled by how
// high the ball is relative to the catcher's chest (high ball -> arms up, low
// ball -> arms down) so it varies with the ball/player positions.
// Phase 4 — Hand IK to the ball. A light two-bone CCD solver (aim the shoulder so
// the hand points at the ball, then bend the elbow to reach it) run AFTER the
// procedural catch pose, so the hands actually converge on the ball instead of just
// approximating by angle. World-space, so it's robust to the rig's bone roll.
const _ikBp = new THREE.Vector3(), _ikHp = new THREE.Vector3(), _ikCur = new THREE.Vector3(), _ikDes = new THREE.Vector3();
const _ikQw = new THREE.Quaternion(), _ikQb = new THREE.Quaternion(), _ikBw = new THREE.Quaternion(), _ikPar = new THREE.Quaternion();
function ik2(arm, fore, hand, target, w) {
  if (!arm || !fore || !hand || w <= 0.01) return;
  for (let pass = 0; pass < 2; pass++) {            // pass 0 = shoulder aim, pass 1 = elbow reach
    const bone = pass === 0 ? arm : fore;
    _ikBp.setFromMatrixPosition(bone.matrixWorld);
    _ikHp.setFromMatrixPosition(hand.matrixWorld);
    const cl = _ikCur.subVectors(_ikHp, _ikBp).length(); if (cl < 1e-4) continue; _ikCur.multiplyScalar(1 / cl);
    const dl = _ikDes.subVectors(target, _ikBp).length(); if (dl < 1e-4) continue; _ikDes.multiplyScalar(1 / dl);
    _ikQw.setFromUnitVectors(_ikCur, _ikDes);        // world rotation that aims the hand at the ball
    _ikQb.identity().slerp(_ikQw, w);                // blend in by weight
    bone.getWorldQuaternion(_ikBw); _ikBw.premultiply(_ikQb);
    const par = bone.parent;
    if (par) { par.getWorldQuaternion(_ikPar); bone.quaternion.copy(_ikPar.invert().multiply(_ikBw)); }
    else bone.quaternion.copy(_ikBw);
    bone.updateMatrixWorld(true);                    // refresh the subtree for the next pass
  }
}
function ikHandsToBall(ch, target, twoHand, w) {
  if (!target || w <= 0.01 || !TUNE.catchIK || !ch.upperArm || !ch.handBone) return;
  w = Math.min(1, w * TUNE.catchIK);
  ch.group.updateWorldMatrix(true, true);            // fresh world matrices for the posed arm chain
  const dx = target.x - ch.group.position.x, dz = target.z - ch.group.position.z;
  const side = dx * Math.cos(ch.heading) - dz * Math.sin(ch.heading); // ball to his right (>0) or left
  const right = side >= 0;
  const pa = right ? ch.upperArm : ch.leftArm, pf = right ? ch.foreArm : ch.leftForeArm, ph = right ? ch.handBone : ch.leftHandBone;
  ik2(pa, pf, ph, target, w);
  if (twoHand) ik2(right ? ch.leftArm : ch.upperArm, right ? ch.leftForeArm : ch.foreArm, right ? ch.leftHandBone : ch.handBone, target, w * 0.9);
}
// The live ball target for a hand reach: only while this player is actually playing
// the ball in the air (or securing it). Null otherwise (no IK on idle arms).
function catchBallTarget(ch) {
  if ((ball.mode === 'flying' || ball.mode === 'secured') && (ch === ball.catcher || ch === ball.targetRecv)) return ball.mesh.position;
  return null;
}
function applyCatchPose(ch, ballPos, dt, w = 1) {
  w *= TUNE.animCatch;
  if (!ch.upperArm || !ch.upperArmRest) return;
  const chestY = ch.group.position.y + 1.15;
  // Ease the reach height toward the ball each frame (instead of snapping), so a
  // fast-moving ball is tracked smoothly and the hands settle as it's secured.
  const want = THREE.MathUtils.clamp(1.0 + (ballPos.y - chestY) * 1.1, 0.15, 2.4);
  ch.catchRaise += (want - ch.catchRaise) * Math.min(1, dt * 14);
  let raise = ch.catchRaise;
  // Over-the-shoulder deep ball: hands stay high and reaching, with a slight
  // backward arch and the head turned up to find it — the signature deep-ball look.
  if (ch.catchStyle === 'overshoulder') {
    raise = Math.max(raise, 1.85);
    blendLean(ch, -0.12, 0, w);          // gentle backward arch
    applyHeadTrack(ch, ballPos, 0.8, dt); // eyes up on the ball
  }
  // Two-hand vs one-hand: how far the ball is off to a side (in the catcher's own
  // frame) decides whether both hands meet it (centered) or he stabs with the near
  // arm while the off arm trails (a wide reach). side > 0 = ball to his right.
  const dx = ballPos.x - ch.group.position.x, dz = ballPos.z - ch.group.position.z;
  const side = dx * Math.cos(ch.heading) - dz * Math.sin(ch.heading); // local lateral offset
  const oneH = THREE.MathUtils.clamp((Math.abs(side) - 0.7) / 1.3, 0, 1); // 0 two-hand .. 1 one-hand
  const rightReach = side >= 0 ? raise : raise * (1 - oneH * 0.85); // right arm = ch.upperArm
  const leftReach = side < 0 ? raise : raise * (1 - oneH * 0.85);
  blendBone(ch.upperArm, ch.upperArmRest, -rightReach, w);
  blendBone(ch.foreArm, ch.foreArmRest, -0.55 * (side >= 0 ? 1 : 1 - oneH * 0.7), w);
  blendBone(ch.leftArm, ch.leftArmRest, leftReach, w);
  blendBone(ch.leftForeArm, ch.leftForeArmRest, 0.55 * (side < 0 ? 1 : 1 - oneH * 0.7), w);
  // Phase 4: refine the posed arms so the hand(s) actually land on the ball.
  ikHandsToBall(ch, ballPos, oneH < 0.5, w);
}
// Procedural ARM ACTIONS (swat a pass, dive at a pick). Like the throw/catch
// poses these run AFTER the mixer and are rig-agnostic (arm bones only), easing
// up then back, and shaped by the target's position so every one varies.
// Triggered by triggerArmAction with a world-space target point.
const _armTmp = new THREE.Vector3();
function triggerArmAction(ch, type, dur, targetPos) {
  ch.armPose = type; ch.armPoseDur = dur; ch.armPoseT = dur;
  ch.armPoseTarget = targetPos ? targetPos.clone() : null;
}
function applyArmAction(ch, dt, bw = 1) {
  bw *= TUNE.animArm;
  ch.armPoseT -= dt;
  if (!ch.upperArm || !ch.upperArmRest) return;
  const dur = ch.armPoseDur || 0.4;
  const t = THREE.MathUtils.clamp(1 - ch.armPoseT / dur, 0, 1);
  const w = Math.sin(Math.PI * t); // 0 -> peak -> 0 (wind, strike, return)
  const tgt = ch.armPoseTarget;
  const chestY = ch.group.position.y + 1.2;
  const reach = tgt ? THREE.MathUtils.clamp(1.2 + (tgt.y - chestY) * 1.0, 0.4, 2.6) : 1.6;
  if (ch.armPose === 'taunt') {
    // Thrust the ball arm overhead and HOLD it there — showboating with the ball
    // aloft while still running (the carried ball follows the hand up).
    const e = Math.min(1, t * 4);
    blendBone(ch.upperArm, ch.upperArmRest, -2.6 * e, bw);
    blendBone(ch.foreArm, ch.foreArmRest, -0.2 * e, bw);
  } else if (ch.armPose === 'stiffarm') {
    // The off-arm punches straight out to ward off / truck — extends fast and
    // HOLDS for the move (not a quick wind-and-return), so it reads as a stiff-arm.
    const e = Math.min(1, t * 5);
    blendBone(ch.upperArm, ch.upperArmRest, -1.45 * e, bw);
    blendBone(ch.foreArm, ch.foreArmRest, -0.12 * e, bw); // arm held straight
  } else if (ch.armPose === 'swat') {
    // One arm slashes up across the ball to bat it down.
    blendBone(ch.upperArm, ch.upperArmRest, -reach * w, bw);
    blendBone(ch.foreArm, ch.foreArmRest, -0.4 * w, bw);
  } else { // 'pick' / 'reach' — both hands stab toward the ball
    blendBone(ch.upperArm, ch.upperArmRest, -reach * w, bw);
    blendBone(ch.foreArm, ch.foreArmRest, -0.5 * w, bw);
    blendBone(ch.leftArm, ch.leftArmRest, reach * w, bw);
    blendBone(ch.leftForeArm, ch.leftForeArmRest, 0.5 * w, bw);
    // Phase 4: IK the in-stride reach onto the LIVE ball so the hands meet it.
    const ikT = catchBallTarget(ch);
    if (ikT) ikHandsToBall(ch, ikT, true, bw * w);
  }
}
// Ball-security threat: how imminent is contact on the ball carrier (0 none .. 1
// about to be hit)? Rises as the nearest pursuer closes inside ~5yd, boosted by his
// closing speed. Drives the off-arm protect pose (applyCarryProtect).
function carrierThreat(ch) {
  if (ch !== game.carrier) return 0;
  if (game.state !== STATE.RUN && game.state !== STATE.RETURN) return 0;
  const cp = ch.group.position;
  const foes = ch.team === 'off' ? game.defense : game.offense; // whoever is chasing him
  let best = Infinity, closing = 0;
  for (const d of foes) {
    if (d.ragdolling) continue;
    const dx = d.group.position.x - cp.x, dz = d.group.position.z - cp.z;
    const dist = Math.hypot(dx, dz);
    if (dist < best) {
      best = dist;
      const rl = dist || 1;
      closing = -(((d.vel.x - ch.vel.x) * dx + (d.vel.z - ch.vel.z) * dz) / rl); // + = closing in
    }
  }
  if (!Number.isFinite(best)) return 0;
  const prox = THREE.MathUtils.clamp((5.0 - best) / 4.0, 0, 1);  // 0 at 5yd -> 1 at 1yd
  const clos = THREE.MathUtils.clamp(closing / 8, 0, 1);         // a hard closing angle adds urgency
  return THREE.MathUtils.clamp(prox * (0.55 + 0.7 * clos), 0, 1);
}
// Ball-security pose: the OFF (left) arm folds up across the front to shield the
// ball while the carry (right) arm tucks it high & tight, with a slight protective
// curl into the oncoming hit. Layered over the run cycle; weight = threat, so it
// eases on as a tackler bears down and off again in the clear.
function applyCarryProtect(ch, w = 1) {
  w *= TUNE.animProtect;
  if (w < 0.001 || !ch.upperArm || !ch.upperArmRest) return;
  blendBone(ch.leftArm, ch.leftArmRest, -1.05, w);       // off arm wraps across the body...
  blendBone(ch.leftForeArm, ch.leftForeArmRest, -1.85, w); // ...hand up over the ball
  blendBone(ch.upperArm, ch.upperArmRest, -0.55, w);     // carry arm pulls in...
  blendBone(ch.foreArm, ch.foreArmRest, -1.5, w);        // ...ball high & tight to the chest
  blendLean(ch, 0.16, 0, w * 0.5);                       // slight curl into the contact
  if (ch.headBone) { _tq.setFromAxisAngle(_xAxisL, 0.18 * w); ch.headBone.quaternion.multiply(_tq); ch.headBone.updateMatrixWorld(true); } // chin down
}
// Break-tackle BATTLE pose: the two lean into each other and churn — the
// tackler wraps up (both arms forward, head down), the carrier drives through
// (stiff-arm out, ball cradled). Procedural so it reads as real contact.
const _qLeanY = new THREE.Quaternion(), _qLeanX = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0), _XAX = new THREE.Vector3(1, 0, 0);
function applyBattleLean(ch, isTackler, w = 1) {
  w *= TUNE.animBattle;
  const now = performance.now();
  const v = game.battle.val; // carrier's break meter (high = carrier winning)
  // A modest whole-body lean only — the dramatic fold is the WAIST bend in
  // applyBattleArms (spine), so the legs stay planted instead of the body toppling.
  // The tackler buries in harder as he wins; the carrier drives through the hit.
  const push = isTackler ? (0.3 + (1 - v) * 0.12) : (0.2 + v * 0.14);
  const lean = push + Math.sin(now * 0.013 + (isTackler ? 0 : 1.5)) * 0.05;
  const sway = Math.sin(now * 0.009 + (isTackler ? 1 : 0)) * 0.05;
  blendLean(ch, lean, sway, w);
}
function applyBattleArms(ch, isTackler, w = 1) {
  w *= TUNE.animBattle;
  if (!ch.upperArm || !ch.upperArmRest) return;
  const t = performance.now() * 0.001;
  const pump = Math.sin(t * 9);
  if (isTackler) {
    // WRAP UP: fold hard at the WAIST so the shoulder/head bury into the carrier's
    // midsection (the signature of a real form tackle); upper arms come forward at
    // chest level with the forearms curled in to clamp around his back; head ducks
    // down and turns to the side. The pump churns it so it reads as a live drive.
    blendBone(ch.spineBone, ch.spineRest, 0.8 + pump * 0.06, w); // bend at the waist, driving in
    blendBone(ch.upperArm, ch.upperArmRest, -(1.15 + pump * 0.1), w);
    blendBone(ch.foreArm, ch.foreArmRest, -(1.4 + pump * 0.15), w);   // curl to wrap
    blendBone(ch.leftArm, ch.leftArmRest, -(1.15 - pump * 0.1), w);
    blendBone(ch.leftForeArm, ch.leftForeArmRest, -(1.4 - pump * 0.15), w);
    if (ch.headBone) {
      _tq.setFromAxisAngle(_xAxisL, 0.55 * w); ch.headBone.quaternion.multiply(_tq); // head down into the hit
      _tq.setFromAxisAngle(_YAX, 0.5 * w); ch.headBone.quaternion.multiply(_tq);      // turned to the side
      ch.headBone.updateMatrixWorld(true);
    }
  } else {
    // Carrier lowers his shoulder and braces THROUGH the hit: bends into it at the
    // waist, free arm punches into the tackler, off arm cradles the ball low and
    // tight, head/chin tucked down.
    blendBone(ch.spineBone, ch.spineRest, 0.42 + pump * 0.05, w); // drive low into contact
    blendBone(ch.upperArm, ch.upperArmRest, -(1.05 + pump * 0.12), w);
    blendBone(ch.foreArm, ch.foreArmRest, -(0.6 + pump * 0.1), w);   // brace/push
    blendBone(ch.leftArm, ch.leftArmRest, -0.5, w);
    blendBone(ch.leftForeArm, ch.leftForeArmRest, -1.75, w);          // tuck/cradle the ball
    if (ch.headBone) { _tq.setFromAxisAngle(_xAxisL, 0.28 * w); ch.headBone.quaternion.multiply(_tq); } // shoulder/head down, driving in
  }
}
// Engaged BLOCK pose: locked hand-to-hand. Both arms extend forward at chest level
// so the hands meet/lock with the opponent's (the two are pressed chest to chest by
// updateBlocks), and he leans into the shove, with a churning pump so it reads as a
// sustained, live block (legs come from the run clip underneath).
function applyBlockPose(ch, w = 1) {
  w *= TUNE.animBlock;
  if (!ch.upperArm || !ch.upperArmRest) return;
  const pump = Math.sin(performance.now() * 0.012);
  blendBone(ch.upperArm, ch.upperArmRest, -(1.3 + pump * 0.12), w);     // upper arms forward at chest height, reaching to the opponent
  blendBone(ch.foreArm, ch.foreArmRest, -(0.5 + pump * 0.12), w);       // forearms angled in -> hands punch into his chest plate
  blendBone(ch.leftArm, ch.leftArmRest, -(1.3 - pump * 0.12), w);
  blendBone(ch.leftForeArm, ch.leftForeArmRest, -(0.5 - pump * 0.12), w);
  blendLean(ch, 0.42 + pump * 0.04, 0, w);                              // drive hard into the block
}
// Dejected loser pose for the end-game finale: head hung to the chest, shoulders
// slumped, with a slow forlorn sway. Layered over the idle clip (after the mixer).
function applySulkPose(ch, w = 1) {
  w *= TUNE.animSulk;
  const t = performance.now() * 0.001;
  if (ch.headBone) { _tq.setFromAxisAngle(_xAxisL, 0.7 * w); ch.headBone.quaternion.multiply(_tq); }
  blendBone(ch.upperArm, ch.upperArmRest, 0.2, w); blendBone(ch.foreArm, ch.foreArmRest, 0.5, w);
  blendBone(ch.leftArm, ch.leftArmRest, 0.2, w); blendBone(ch.leftForeArm, ch.leftForeArmRest, 0.5, w);
  const lean = 0.18 + Math.sin(t * 0.8 + (ch.sulkPh || 0)) * 0.05; // slow forward slump + sway
  blendLean(ch, lean, 0, w);
}
// Our clips are rotation-only (positions stripped to avoid root-motion drift),
// which freezes the pelvis at standing height. Fine for locomotion, but dynamic
// one-shots (the parkour vault/roll, diving catch, loose-ball scoop, celebration
// jumps) swing the body far from vertical and would clip half through the turf.
// Fix: measure the lowest bone for the current pose and raise the whole root so
// nothing dips below the field — the body sits on the ground / arcs up cleanly.
function groundClamp(ch) {
  ch.group.position.y = 0;             // measure from the baseline
  ch.group.updateMatrixWorld(true);   // refresh bone world matrices for this pose
  let lo = Infinity;
  for (const b of ch.bones) { const y = b.matrixWorld.elements[13]; if (Number.isFinite(y) && y < lo) lo = y; }
  const TARGET = 0.04;                 // keep the lowest joint just above the turf
  // Lift only, and CAP it: a legit ground pose never needs more than ~0.8yd, so a
  // wild bone can't float the player up "in a plane above the field".
  if (Number.isFinite(lo) && lo < TARGET) ch.group.position.y = Math.min(TARGET - lo, 0.8);
}
function updateAnimation(ch, dt) {
  if (ch.ragdolling) return; // bones are physics-driven — the mixer must not fight them
  // End-of-game finale: winners loop a real dance, losers loop an anger/tantrum
  // clip. (Falls through to idle + the procedural sulk pose if the clips are missing.)
  if (ch.dancing && ch.actions.dance) { setClip(ch, 'dance'); ch.group.rotation.set(0, ch.heading, 0); stepMixer(ch, dt); groundClamp(ch); return; }
  if (ch.sulk && ch.actions.sulk) { setClip(ch, 'sulk'); ch.group.rotation.set(0, ch.heading, 0); stepMixer(ch, dt); groundClamp(ch); return; }
  const inBattle = game.state === STATE.BATTLE && (ch === game.carrier || ch === game.battle.tackler);
  // The break-tackle (1-on-1) DEFENDER drives in with the push clip; the carrier
  // keeps the procedural brace/wrap. (Falls back to the run+battle pose if no pack.)
  const battleTackler = inBattle && ch === game.battle.tackler && !!ch.actions.block;
  if (ch.oneShotT > 0 && !inBattle) {     // hold a one-shot (juke / vault / dive / celebration)
    ch.oneShotT -= dt;
    ch.group.rotation.y = ch.heading;
    stepMixer(ch, dt);
    // Anticipatory CATCH leap: overlay the ball-tracking reach ON TOP of the leap
    // clip so the hands actually meet the ball (the clip sells the jump/extension,
    // the overlay locks the arms to the ball) while it's still in the air / homing.
    if (ch.catchLeap && (ball.mode === 'flying' || ball.mode === 'secured') && ch === (ball.catcher || ball.targetRecv)) {
      applyCatchPose(ch, ball.mesh.position, dt, 0.85);
    }
    groundClamp(ch); // dynamic clips (rolls/dives/jumps) carry big vertical body
    return;          // motion; lift the root so no joint sinks through the turf
  }
  let want = 'idle';
  // Backpedal: when moving backward relative to where he's facing (QB drop-back,
  // a DB dropping into coverage). Pick the left/right drift by lateral velocity.
  const along = ch.vel.x * Math.sin(ch.heading) + ch.vel.z * Math.cos(ch.heading); // + forward / - backward
  if (inBattle) want = battleTackler ? 'block' : 'run'; // tackler drives with the push clip; carrier churns
  else {
    // Backpedal is ONLY for a DB dropping into coverage or the QB on his drop-back
    // (facing one way while moving the other). It must be the pass phase and the
    // defender must NOT be pursuing a ball carrier — once someone's running (a QB
    // out of the pocket), defenders chase him, they don't backpedal.
    const passPhase = game.state === STATE.LIVE || game.state === STATE.AIR;
    const coverDrop = passPhase && !ch.pursuit && (ch.job === 'cover' || ch.job === 'zone' || ch.deep);
    const qbDrop = ch.role === 'QB' && game.state === STATE.LIVE && !pastLine(ch);
    // Hysteresis so a hard cut doesn't flicker run<->backpedal: drop into the
    // backpedal below -0.6, but hold it until he's clearly moving forward again.
    ch.backped = (coverDrop || qbDrop) && ch.speed > 0.7 && along < (ch.backped ? -0.3 : -0.6);
    if (ch.backped) want = (ch.vel.x * Math.cos(ch.heading) - ch.vel.z * Math.sin(ch.heading)) >= 0 ? 'backR' : 'backL';
    else if (ch.speed > 11) want = 'sprint'; // turbo / RunFast
    else if (ch.speed > 6) want = 'run';
    else if (ch.speed > 0.5) want = 'walk';
  }
  // Engaged block: a clip-driven PUSH (push-clip slice) overrides locomotion while
  // locked up — the blocker and the rusher he's engaged with both play it (their own
  // random version/tempo). Procedural shove pose is the fallback.
  // Line blocking: churn the legs in place (the drive) while the procedural
  // engaged-block pose punches the arms into the opponent's chest (a squared-up
  // 1-on-1 hand-fight). The break-tackle DRIVE still uses the push clip (battle).
  if (ch.blocking) want = 'run';
  const grabbing = ch.grabbing && game.drag.active && !ch.ragdolling; // latched onto the runner
  setClip(ch, want);
  if (want === 'block') ch.active.setEffectiveTimeScale((ch.blockTS || 1) * TUNE.blockTempo); // per-player block tempo (× debug knob)
  // Foot-skating fix: drive the gait at the speed it was authored for, so a
  // planted foot stays put while the body travels (instead of sliding). The
  // run band churns a touch faster in the BATTLE so it reads as a struggle.
  if (!inBattle && (want === 'walk' || want === 'run' || want === 'sprint' || want === 'backL' || want === 'backR')) {
    const ref = ch.active.getClip().userData && ch.active.getClip().userData.refSpeed;
    if (ref > 0) ch.active.setEffectiveTimeScale(THREE.MathUtils.clamp(ch.speed / ref, 0.55, 2.6));
  }
  // Base root orientation: heading + any active 360 spin, plus locomotion "life"
  // (bank into turns, lean with speed, idle breathing). Procedural leans below
  // blend on top of this with their own eased weights.
  const spin = (!inBattle && !grabbing && ch.spinT > 0) ? (1 - ch.spinT / SPIN_DUR) * Math.PI * 2 : 0;
  applyLocoLife(ch, dt, spin);
  stepMixer(ch, dt);
  // Procedural overlays blend in/out via per-character weights, so a pose fades
  // smoothly over the locomotion clip instead of snapping on/off in one frame.
  // Pick the single active overlay (priority order); its weight eases toward 1
  // while every other eases toward 0 — giving automatic crossfades between poses.
  let active = null;
  if (inBattle) active = battleTackler ? null : 'battle'; // tackler = pure push clip (no procedural battle overlay)
  else if (grabbing) active = 'grab';
  else if (ball.mode === 'secured' && ch === ball.catcher) active = 'catch';
  else if (ch.throwAnimT > 0) active = 'throw';
  else if (ch.armPoseT > 0) active = 'arm';
  else if (ch.blocking) active = 'block'; // squared-up hand-fight (procedural arms + lean)
  else if (ch.sulk) active = 'sulk';
  ch.battleW = easeWeight(ch.battleW, active === 'battle', dt);
  ch.grabW = easeWeight(ch.grabW, active === 'grab', dt);
  ch.catchW = easeWeight(ch.catchW, active === 'catch', dt);
  ch.throwW = easeWeight(ch.throwW, active === 'throw', dt);
  ch.armW = easeWeight(ch.armW, active === 'arm', dt);
  ch.blockW = easeWeight(ch.blockW, active === 'block', dt);
  ch.sulkW = easeWeight(ch.sulkW, active === 'sulk', dt);
  // Leans first (orient the root), then arm poses, applied lowest -> highest
  // priority so the dominant overlay wins the bones it shares with a fading one.
  if (ch.sulkW > 0.001) applySulkPose(ch, ch.sulkW); // end-game loser: head hung, shoulders slumped
  if (ch.blockW > 0.001) applyBlockPose(ch, ch.blockW);
  if (ch.grabW > 0.001) applyGrabLean(ch, ch.grabW);
  if (ch.battleW > 0.001) applyBattleLean(ch, ch === game.battle.tackler, ch.battleW);
  if (ch.armW > 0.001) applyArmAction(ch, dt, ch.armW);
  if (ch.throwW > 0.001) applyThrowPose(ch, dt, ch.throwW);
  if (ch.catchW > 0.001) applyCatchPose(ch, ball.mesh.position, dt, ch.catchW);
  if (ch.grabW > 0.001) applyBattleArms(ch, true, ch.grabW); // wrap him up like a tackler
  if (ch.battleW > 0.001) applyBattleArms(ch, ch === game.battle.tackler, ch.battleW);
  // Ball security: the carrier shields the ball with his off arm, ramping with the
  // threat of contact — only in open-field carrying (no battle/grab/stiff-arm/etc.
  // overlay, which pose the arms themselves).
  const protectTarget = (!active && ch === game.carrier) ? carrierThreat(ch) : 0;
  ch.protectW += (protectTarget - ch.protectW) * Math.min(1, dt * 8);
  if (ch.protectW > 0.01) applyCarryProtect(ch, ch.protectW);
  // Head-on-a-swivel: a backpedaling player (a DB dropping into coverage, the QB
  // on his drop) tracks the ball in flight or the nearest receiver instead of
  // staring straight back. Eased, and eased back to center once he's done.
  if (!active && ch.backped) {
    let tp = null;
    if (ball.mode === 'flying') tp = ball.mesh.position;
    else if (game.receivers) { let bd = Infinity; for (const r of game.receivers) { const d = distXZ(px(r), px(ch)); if (d < bd) { bd = d; tp = r.group.position; } } }
    if (tp) applyHeadTrack(ch, tp, 1, dt);
    else if (Math.abs(ch.headYaw) > 0.001) applyHeadTrack(ch, px(ch), 0, dt);
  } else if (Math.abs(ch.headYaw) > 0.001) {
    applyHeadTrack(ch, px(ch), 0, dt); // ease the look back to center
  }
  // Idle variety now comes from real per-player idle clips (see makeCharacter),
  // so no procedural stance offset is layered on top.
  // Keep dynamic poses out of the turf: one-shots clamp in their own branch
  // above, and the leaning gang-tackle grab clamps here. Plain locomotion just
  // sits at the calibrated height — clear any leftover lift from a finished move.
  const draggedCarrier = game.drag.active && ch === game.carrier && !ch.ragdolling; // the man being wrapped/dragged
  const clipBlocking = battleTackler; // only the break-tackle push clip steps the feet -> clamp to the turf
  if (grabbing || draggedCarrier || clipBlocking) groundClamp(ch);
  else if (!inBattle) ch.group.position.y = 0;
}
// Blitz JUKE: a hard lateral burst toward the stick side; if a tackler makes
// contact during the juke window he whiffs right past (see beginTackle).
function doJuke(ch) {
  if (ch.jukeCd > 0) return;
  ch.jukeCd = 0.9; ch.jukeTimer = 0.38;
  const kb = kbVec();
  const side = (input.x + kb.x) < 0 ? -1 : 1;
  const rx = Math.cos(ch.heading), rz = -Math.sin(ch.heading); // right of heading
  ch.vel.x += rx * side * 7; ch.vel.z += rz * side * 7;
  shake.kick(rx * side, rz * side, 0.25);
  playOneShot(ch, 'juke', 0.45); // dodge-roll animation
  audio.juke();
}
// Blitz TAUNT: thrust the ball aloft and showboat mid-stride in the open field.
// Risk/reward — a hit while the window is open strips the ball (see beginTackle);
// survive it and you get a turbo pop (see the RUN timer block).
function doTaunt(ch) {
  if (ch.tauntCd > 0) return;
  ch.tauntCd = 2.2; ch.tauntT = 1.0;            // cooldown + the vulnerable showboat window
  triggerArmAction(ch, 'taunt', 1.0, null);     // ball arm raised overhead, overlaid on the run
  showBanner('TAUNT!', '#ffd23a', { icon: 'star' });
  audio.cheer(0.5); shake.kick(0, 0, 0.05);
}
// Blitz DIVING TACKLE (defense): leave your feet to extend the reach when the
// carrier is just out of lunge range. (nx,nz) is the unit dir to the carrier;
// the airborne window resolves to a hit or a whiff in updateCpuRun.
function diveTackle(o, nx, nz) {
  o.diveCd = 1.4; o.diveT = 0.42;                 // cooldown + airborne window
  const burst = o.baseSpeed * 1.75;
  o.vel.x = nx * burst; o.vel.z = nz * burst;     // launch toward the carrier
  playOneShot(o, o.actions.divecatch ? 'divecatch' : 'tackle', 0.5, true); // airborne dive pose
  shake.kick(nx, nz, 0.1);
}

// A non-ragdolling defender roughly in front of the carrier (within `dist`,
// aligned with his heading) — the target for a stiff-arm truck.
function defenderAhead(ch, dist, dotMin, list = game.defense) {
  const hx = Math.sin(ch.heading), hz = Math.cos(ch.heading);
  let best = null, bestD = dist * dist;
  for (const d of list) {
    if (d.ragdolling) continue;
    const dx = d.group.position.x - ch.group.position.x, dz = d.group.position.z - ch.group.position.z;
    const l = Math.hypot(dx, dz) || 1;
    if ((dx / l) * hx + (dz / l) * hz < dotMin) continue; // not ahead
    const dd = dx * dx + dz * dz;
    if (dd < bestD) { bestD = dd; best = d; }
  }
  return best;
}
// SPIN — a 360 that keeps you moving and slips a lone tackler (immunity
// window). If a defender is right in front, it becomes a STIFF-ARM truck.
const SPIN_DUR = 0.5; // spin-move length (s): drives both the immunity window and the 360 visual
function doSpin(ch) {
  if (ch.jukeCd > 0) return;
  const ahead = defenderAhead(ch, 2.8, 0.45);
  if (ahead) { stiffArm(ch, ahead); return; }
  ch.jukeCd = 0.9; ch.jukeTimer = 0.5; ch.spinT = SPIN_DUR; // immunity + visual spin
  shake.kick(ch.vel.x, ch.vel.z, 0.18);
  audio.juke();
  showBanner('SPIN!', '#bfffd0');
}
function stiffArm(ch, def) {
  ch.jukeCd = 1.0; ch.jukeTimer = 0.25; // brief immunity as you barrel through
  triggerArmAction(ch, 'stiffarm', 0.45, def.group.position); // procedural arm thrust into him
  knockdownDefender(def);               // truck him to the turf (ragdoll)
  ch.vel.x *= 0.82; ch.vel.z *= 0.82;   // small speed cost
  shake.add(0.22); shake.kick(Math.sin(ch.heading), Math.cos(ch.heading), 0.5);
  burst(def.group.position.x, 1.0, def.group.position.z, 0xe8d9a0, 12, 7);
  audio.hit(0.7);
  showBanner('STIFF ARM!', '#ffd23a');
}
// STIFF ARM — thrust the off-arm out (procedural pose). If a defender is in front
// he gets trucked to the turf; otherwise it's just the arm-out warding stance
// with a beat of immunity. (Replaces the old committed DIVE.)
function doStiffArm(ch) {
  if (ch.jukeCd > 0) return;
  const ahead = defenderAhead(ch, 3.0, 0.4); // a bit wider/looser than the truck
  if (ahead) { stiffArm(ch, ahead); return; }
  ch.jukeCd = 0.8; ch.jukeTimer = 0.3; // arm out, ward off — short immunity
  triggerArmAction(ch, 'stiffarm', 0.45, null);
  audio.juke();
  showBanner('STIFF ARM!', '#ffd23a');
}
// HURDLE — leap over a low/diving defender and land still running. The jukeTimer
// immunity makes the man he's vaulting whiff (see beginTackle).
function doHurdle(ch, def) {
  ch.jukeCd = 0.95; ch.jukeTimer = 0.55; // immunity across the vault
  const fx = Math.sin(ch.heading), fz = Math.cos(ch.heading);
  const b = ch.baseSpeed * 1.25;
  ch.vel.x = fx * b; ch.vel.z = fz * b; // leap forward over him
  playOneShot(ch, ch.actions.vault ? 'vault' : 'juke', 0.6, true);
  burst(def.group.position.x, 1.3, def.group.position.z, 0xe8d9a0, 9, 6);
  audio.juke(); shake.kick(fx, fz, 0.22);
  showBanner('HURDLE!', '#bfffd0');
}
// JUMP OFF THE CAGE — a ball carrier driven into the fence at speed kicks off it,
// redirecting back inbound (and downfield) with a burst + a beat of immunity,
// instead of getting pinned to the wall. Parkour vault-with-roll animation.
function tryCageJump(c, downDir = game.dir) {
  if (c.cageJumpCd > 0) return false;
  if (Math.hypot(c.vel.x, c.vel.z) < 6) return false; // need real pace into the wall
  const p = c.group.position, mx = CAGE_X - 1.8, mz = CAGE_Z - 1.8;
  const intoX = (p.x > mx && c.vel.x > 0) || (p.x < -mx && c.vel.x < 0);
  const intoZ = (p.z > mz && c.vel.z > 0) || (p.z < -mz && c.vel.z < 0);
  if (!intoX && !intoZ) return false;
  c.cageJumpCd = 1.7; c.jukeTimer = 0.5; // immunity off the wall
  const inwardX = p.x > 0 ? -1 : 1; // back toward midfield, still downfield (downDir)
  const b = c.baseSpeed * 1.35;
  c.vel.x = inwardX * b * (intoX ? 0.8 : 0.4);
  c.vel.z = downDir * b * (intoZ ? 0.5 : 0.95);
  c.heading = Math.atan2(c.vel.x, c.vel.z);
  playOneShot(c, c.actions.cagevault ? 'cagevault' : 'juke', 0.85, true);
  burst(p.x, 1.6, p.z, 0x7fe0ff, 12, 7);
  audio.juke(); shake.kick(inwardX, downDir, 0.3);
  showBanner('OFF THE WALL!', '#7fe0ff');
  return true;
}
// CPU ball-carrier instincts: kick off the fence when driven into it, and
// occasionally HURDLE a defender square in his path. `opp` = the chasing team,
// `downDir` = the carrier's downfield direction. Mirrors the player's moves.
function aiCarrierMoves(c, opp, downDir, dt) {
  if (c.cageJumpCd > 0) c.cageJumpCd -= dt;
  if (c.jukeCd > 0) c.jukeCd -= dt;
  if (c.jukeTimer > 0) c.jukeTimer -= dt;
  if (tryCageJump(c, downDir)) return;
  if (c.jukeCd <= 0 && c.speed > 7 && c.actions.vault) {
    const ahead = defenderAhead(c, 2.2, 0.6, opp);
    if (ahead && Math.random() < 0.1) doHurdle(c, ahead); // ~once per close approach
  }
}
// LATERAL/PITCH — flick the ball to a trailing teammate (behind the carrier).
// A bad pitch near coverage can be fumbled (a live ball the defense may grab).
function trailingTeammate(ch) {
  let best = null, bestD = 12 * 12;
  for (const o of game.offense) {
    if (o === ch || o.ragdolling) continue;
    if (o.group.position.z > ch.group.position.z - 1) continue; // must be BEHIND (smaller +Z)
    const dd = dist2(px(o), px(ch));
    if (dd < bestD) { bestD = dd; best = o; }
  }
  return best;
}
function doPitch(ch) {
  const mate = trailingTeammate(ch);
  if (!mate) { setStatus('No one to pitch to!'); return; }
  audio.throwPass();
  const cover = nearestDefenderTo(px(mate));
  const risky = cover && distXZ(px(cover), px(mate)) < 3.0;
  if (risky && Math.random() < 0.5) {
    // Botched pitch: a live, bouncing ball — scramble to recover it.
    showBanner('BOBBLED PITCH!', '#ff6a4a'); audio.groan();
    startFumble(ch, mate.group.position.x - ch.group.position.x, mate.group.position.z - ch.group.position.z);
    return;
  }
  mate.jukeTimer = 0.4; // a step of immunity as he gathers it
  ball.holder = mate;
  enterRun(mate, 'Pitch! Keep running!');
  showBanner('PITCH!', '#bfffd0');
}
const turboFillEl = document.getElementById('turbo-fill');

// ===========================================================================
// Main per-frame
// ===========================================================================
function updatePlay(dt) {
  const actionEdge = input.actionEdge; input.actionEdge = false;
  const catchEdge = input.catchEdge; input.catchEdge = null; // user-catch style press (rac/poss/agg)
  const spinEdge = input.spinEdge; input.spinEdge = false;
  const diveEdge = input.diveEdge; input.diveEdge = false;
  const pitchEdge = input.pitchEdge; input.pitchEdge = false;
  if (game.state === STATE.REPLAY) { if (actionEdge) endReplay(); else { updateReplay(dt); updateParticles(dt); } return; } // particles run so the replayed blood geyser animates
  tickClock(dt); // game clock / play clock (may auto-snap on delay of game)

  if (game.state === STATE.PRESNAP) {
    if (game.gameOver) { updateFinale(dt); if (actionEdge) { if (game.gauntlet && game.gauntlet.active) gauntletNext(); else resetGame(); } }
    else if (!game.choosing) {
      if (game.userOnOffense) {
        if (actionEdge) snap();             // QB holds his spot — just snap it
      } else {
        if (actionEdge) switchControlled();  // pick your defender
        const c = game.controlled;           // roam your side of the line pre-snap
        if (c) { controlledMove(c, dt, c.baseSpeed * 0.85); clampPreSnap(c); }
        game.autoSnapT -= dt; if (game.autoSnapT <= 0) snap(); // CPU snaps on its own
      }
    }
  } else if (game.state === STATE.LIVE && game.userOnOffense) {
    aimReceiver();
    // A throw only arms on a FRESH press in LIVE — so the held snap press never
    // bleeds into an instant throw. Tap = lob, hold = bullet.
    if (actionEdge) game.throwArmed = true;
    if (game.throwArmed) {
      if (input.action) {
        game.throwCharge = Math.min(THROW_CHARGE_MAX, game.throwCharge + dt);
      } else {
        throwBall(game.throwCharge / THROW_CHARGE_MAX); // released (instant tap charge 0 = lob)
        game.throwCharge = 0; game.throwArmed = false;
      }
    }
  } else {
    game.throwCharge = 0; game.throwArmed = false; // not live: never carry a stale charge
    // On defense, the action button switches you to the defender nearest the ball.
    if (actionEdge && !game.userOnOffense && (game.state === STATE.LIVE || game.state === STATE.AIR)) switchDefender();
    // On your own pass in flight, the action button is the CATCH (Phase 1 RAC).
    else if (game.userOnOffense && game.state === STATE.AIR && game.userCatch && game.userCatch.on) updateUserCatch(catchEdge);
  }

  // Blitz turbo meter: drains while held, refills when released; ON FIRE =
  // unlimited turbo + a hotter whole offense.
  const liveBall = game.state === STATE.LIVE || game.state === STATE.AIR || game.state === STATE.RUN || game.state === STATE.RETURN || game.state === STATE.LOOSE;
  const turboOn = input.turbo && !game.turboLock && (game.onFire || game.turboMeter > 0);
  if (liveBall) game.playClock += dt;
  // STAMINA of the player you're driving sets how long turbo lasts / recovers.
  const stam = (game.controlled && game.controlled.rt) ? game.controlled.rt.stamina : 0.8;
  if (liveBall && turboOn && !game.onFire) {
    game.turboMeter = Math.max(0, game.turboMeter - dt / (2.0 + stam * 2.2)); // 2.0s (gassed) .. 4.2s (iron)
    if (game.turboMeter <= 0) game.turboLock = true; // flat: wait for a recharge
  } else {
    game.turboMeter = Math.min(1, game.turboMeter + dt / (5.5 - stam * 2.5)); // refills faster with stamina
    if (game.turboLock && game.turboMeter > 0.25) game.turboLock = false;
  }
  turboFillEl.style.height = `${Math.round(game.turboMeter * 100)}%`;
  const fireMul = game.onFire ? TUNE.onFireBoost : 1;

  if (game.state === STATE.LIVE || game.state === STATE.AIR) {
    if (game.userOnOffense) {
      // Pre-throw the QB scrambles with the stick; once the ball's in the air
      // the stick steers the BALL instead (updateBall), so the QB holds.
      if (game.state === STATE.LIVE) {
        if (game.throwArmed) {
          // Winding up: plant in the pocket and square up to the targeted WR so
          // the throw always comes out facing the receiver (not the scramble dir).
          game.qb.vel.set(0, 0, 0); game.qb.speed = 0;
          const tgt = game.receivers[game.selected];
          if (tgt) game.qb.heading = turnToward(game.qb.heading,
            Math.atan2(tgt.group.position.x - game.qb.group.position.x, tgt.group.position.z - game.qb.group.position.z),
            TURN_RATE * dt * 3);
        } else {
          const top = game.qb.baseSpeed * fireMul * (turboOn ? TUNE.turboMult : 1);
          controlledMove(game.qb, dt, top);
          if (pastLine(game.qb)) { enterRun(game.qb, 'Scramble! Run for it!'); audio.say('scramble'); }
        }
      } else { game.qb.speed = 0; game.qb.vel.set(0, 0, 0); }
      updateOffense(dt); updateDefense();
    } else {
      // CPU has the ball: it drops back and throws; you drive a defender.
      updateOffense(dt); updateDefense();
      if (game.state === STATE.LIVE) cpuQB(dt); else { game.qb.speed = 0; game.qb.vel.set(0, 0, 0); }
      if (game.controlled) {
        const top = game.controlled.baseSpeed * (turboOn ? TUNE.turboMult : 1);
        controlledMove(game.controlled, dt, top);
      }
    }
    for (const ch of game.all) if (ch !== game.controlled && !ch.ragdolling) applySteer(ch, dt);
    if (game.state === STATE.LIVE) checkSack(); // a rusher at the QB = sack
  } else if (game.state === STATE.RUN && !game.userOnOffense) {
    updateCpuRun(dt, turboOn, actionEdge); // CPU carrier; you tackle on defense
  } else if (game.state === STATE.RUN) {
    // The single ACTION button picks the right move for the moment (HURDLE /
    // STIFF ARM / JUKE — see carrierContext). Desktop Q/E/F stay as explicit
    // spin / stiff-arm / pitch shortcuts for power users.
    if (actionEdge) carrierContext(game.carrier).run(game.carrier);
    if (spinEdge) doSpin(game.carrier);
    if (diveEdge) doStiffArm(game.carrier);
    if (pitchEdge) doPitch(game.carrier);
    if (game.state === STATE.RUN) refreshRunAction(game.carrier); // keep the label live
    if (game.state === STATE.RUN) { // a botched pitch can have ended the play
      const c = game.carrier;       // (re-fetch: a clean pitch changed the carrier)
      if (c.jukeTimer > 0) c.jukeTimer -= dt;
      if (c.jukeCd > 0) c.jukeCd -= dt;
      if (c.spinT > 0) c.spinT -= dt;
      if (c.catchExposed > 0) c.catchExposed -= dt; // exposure after a contested catch fades fast
      if (c.cageJumpCd > 0) c.cageJumpCd -= dt;
      if (c.tauntCd > 0) c.tauntCd -= dt;
      if (c.tauntT > 0) { c.tauntT -= dt; if (c.tauntT <= 0) game.turboMeter = Math.min(1, game.turboMeter + 0.25); } // survived the showboat -> turbo pop
      tryCageJump(c); // driven into the fence at speed -> kick off it, stay in play
      const top = c.baseSpeed * fireMul * (turboOn ? TUNE.turboMult : 1);
      controlledMove(c, dt, top);
      updateOffense(dt); updateDefense();
      for (const ch of game.all) if (ch !== game.controlled && !ch.ragdolling) applySteer(ch, dt);
      checkRunOutcome();
    }
  } else if (game.state === STATE.RETURN) {
    if (game.controlled === game.returner) {
      // You're running it back: the action/Q/E buttons are ball-carrier moves.
      if (actionEdge) carrierContext(game.returner).run(game.returner);
      if (spinEdge) doSpin(game.returner);
      if (diveEdge) doStiffArm(game.returner);
      if (game.state === STATE.RETURN) refreshRunAction(game.returner);
    } else if (actionEdge) returnDive(); // chasing: dive to bring the returner down
    if (game.state === STATE.RETURN) updateReturn(dt, turboOn, fireMul);
  } else if (game.state === STATE.LOOSE) {
    updateLoose(dt, turboOn, actionEdge); // scramble for the bouncing ball
  } else if (game.state === STATE.BATTLE) {
    if (actionEdge) input.battleMash++;
    if (game.scrum.active) {
      for (const ch of game.all) if (!ch.ragdolling && !game.scrum.crew.includes(ch)) { ch.speed = 0; ch.vel.set(0, 0, 0); }
      updateScrum(dt);
    } else {
      for (const ch of game.all) if (!ch.ragdolling && ch !== game.carrier && ch !== game.battle.tackler) { ch.speed = 0; ch.vel.set(0, 0, 0); }
      updateBattle(dt);
    }
  } else if (game.state === STATE.TACKLE && game.drag.active) {
    updateDrag(dt); // wrap-and-drag-down struggle before the pile collapses
  } else if (game.state === STATE.TACKLE) {
    // The ragdolls own the moment: hold everyone else, let physics finish the
    // fall, then spot the ball where the pile slid to.
    for (const ch of game.all) if (!ch.ragdolling) { ch.speed = 0; ch.vel.set(0, 0, 0); }
    game.tackleTimer -= dt;
    const settled = game.carrier && game.carrier.ragdoll &&
      game.carrier.ragdoll.active && game.tackleTimer < 1.2 && game.carrier.ragdoll.settled();
    if (game.tackleTimer <= 0 || settled) resolveTackleEnd();
  }

  // Safety net: no upright player may ever be outside the cage, whatever state
  // moved them (ragdolls are hard-clamped in the physics step instead). Also
  // sanitize any non-finite position/velocity (a stray NaN here would otherwise
  // spread into the tackle spot -> game.los -> every formation, corrupting the
  // lineups for the rest of the session — the "teleport/wrong side" bug).
  for (const ch of game.all) if (!ch.ragdolling) {
    const p = ch.group.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z) ||
        !Number.isFinite(ch.vel.x) || !Number.isFinite(ch.vel.z)) {
      const h = ch.home || { x: 0, z: 0 };
      p.set(Number.isFinite(h.x) ? h.x : 0, 0, Number.isFinite(h.z) ? h.z : 0);
      ch.vel.set(0, 0, 0); ch.speed = 0;
    }
    // Also self-heal the scalar state the sweep used to miss: a NaN heading (e.g.
    // atan2 of a transient NaN velocity) is never written by the mixer, so it
    // would persist and spread NaN through every sin/cos -> erratic movement.
    if (!Number.isFinite(ch.heading)) ch.heading = 0;
    if (!Number.isFinite(ch.speed)) ch.speed = 0;
    if (ch.desired && (!Number.isFinite(ch.desired.x) || !Number.isFinite(ch.desired.z))) { ch.desired.x = 0; ch.desired.z = 0; }
    clampToField(ch);
    if (liveBall) updateFatigue(ch, dt); // tire with exertion while the ball's live
  }
  // Block lock-ups: hold engaged blocker/defender pairs together in the shove and
  // run the shed duel (must come before body-separation, which skips locked pairs).
  if (game.state === STATE.LIVE || game.state === STATE.AIR || game.state === STATE.RUN || game.state === STATE.RETURN) { updateBlocks(dt); updateKnockdownRecovery(dt); }
  else clearEngagements();
  // Bodies can't pass through each other in open play (the locked pile/battle keep
  // their intentional overlaps). Run after clamping so a push can't shove anyone
  // out of the cage, then re-clamp the two who could have been nudged to the edge.
  if (game.state === STATE.PRESNAP || game.state === STATE.LIVE || game.state === STATE.AIR ||
      game.state === STATE.RUN || game.state === STATE.RETURN || game.state === STATE.LOOSE) {
    resolveBodies();
    for (const ch of game.all) if (!ch.ragdolling) clampToField(ch);
  }
  for (const ch of game.all) updateAnimation(ch, dt);
  updateBall(dt); // after the pose updates so the ball follows the hand bone
  ensureBallVisible(); // the ball must never vanish — keep it shown + at a sane spot
  updateTrail(ball.mode === 'flying'); // glowing comet trail while in the air
  // Record footage while the ball is live (for the touchdown replay).
  // Record the whole play AND the dead-ball beat after it (so a TD celebration
  // is part of the replay). Only PRESNAP / RESET / REPLAY itself are skipped.
  if (game.state !== STATE.PRESNAP && game.state !== STATE.RESET && game.state !== STATE.REPLAY) recordFrame();

  updateReticles(); // single authority for all on-field rings (visibility + position)
  updateNameTags();
  updateCoachArt(); // pre-snap play-art overlay (PLAY ART button)
  updateUserStatsHUD(); // your tackles / catches / interceptions badge
  updateReplayButton(); // on-demand REPLAY button between plays
  // Target arrow bobs over the selected receiver while you're picking a throw.
  const showArrow = game.userOnOffense && (game.state === STATE.PRESNAP || game.state === STATE.LIVE) && game.receivers[game.selected];
  targetArrow.visible = showArrow;
  if (showArrow) {
    const p = game.receivers[game.selected].group.position;
    targetArrow.position.set(p.x, 2.9 + Math.sin(performance.now() * 0.006) * 0.18, p.z);
    targetArrow.rotation.y += dt * 2;
  }
  updateParticles(dt);
  updateFlames(dt);
  tickJumbo(dt); // rotate jumbotron between the scoreboard and ads
  if (game.battle.cd > 0) game.battle.cd -= dt;
  if (game.scrum.cd > 0) game.scrum.cd -= dt;
  if (game.state === STATE.DEAD) {
    // Whistle beat: everyone still up brakes to a stop (run -> walk -> idle),
    // then they jog back into formation (RESET) for the next play.
    for (const ch of game.all) if (!ch.ragdolling) {
      ch.vel.x *= Math.max(0, 1 - dt * 4); ch.vel.z *= Math.max(0, 1 - dt * 4);
      ch.group.position.x += ch.vel.x * dt; ch.group.position.z += ch.vel.z * dt;
      ch.speed = Math.hypot(ch.vel.x, ch.vel.z);
      clampToField(ch); // keep the dead-ball coast inside the cage too
    }
    game.deadTimer -= dt;
    if (game.deadTimer <= 0) {
      game.celebrating = false;
      // Cut to the broadcast replay now (after the live celebration); if there
      // wasn't enough footage, dip-cut to the next play (hides the reset snap).
      if (game.pendingReplay) { game.pendingReplay = false; if (!startReplay()) startCut(beginReset); }
      else startCut(beginReset);
    }
  } else if (game.state === STATE.RESET) {
    updateReset(dt);
  }
}

// Keep each player's helmet glued to the head — it's parented to the Head bone
// so it tracks automatically (head turns + ragdoll); no per-frame work needed.

// ===========================================================================
// Camera (feel ported from Football-Game/Scene3D: eased "superstar" chase cam
// that pans toward what you're aiming at, plus a cinematic hit push-in)
// ===========================================================================
const cam = {
  fwdX: 0, fwdZ: 1,                       // eased behind-cam heading (pans, never jumps)
  pos: new THREE.Vector3(0, 7, -12),
  lookCur: new THREE.Vector3(0, 1.3, 0),
  cine: 0, cineHold: 0, cineZoom: 1,      // contact-hit close-up amount / hold / depth (bigger = tighter)
  back: 11, hgt: 6.8, aheadL: 11, lookH: 1.5, fovKick: 0, // eased framing + snap zoom punch
  special: null,                          // cinematic override: pre-snap hero / post-TD flex
};
const _tp = new THREE.Vector3(), _tl = new THREE.Vector3(), _fp = new THREE.Vector3();
const _cinePos = new THREE.Vector3(), _cineLook = new THREE.Vector3();

/** Punch the camera in tight on the action for `hold` seconds (a hit close-up). */
function hitZoom(hold = 0.5, zoom = 1) { cam.cineHold = Math.max(cam.cineHold, hold); cam.cineZoom = Math.max(cam.cineZoom, 1 + (zoom - 1) * TUNE.hitZoomAmt); }
// Cinematic camera override: 'hero' (low slow orbit on the star pre-snap) or
// 'td' (low up-angle flex/standover on the scorer). Cleared when it expires or
// the play state moves on (see updateCamera).
function startSpecialCam(kind, target, dur) {
  cam.special = { kind, target, t: 0, dur, baseAz: game.dir > 0 ? 0 : Math.PI };
}
function driveSpecialCam(sp, dt) {
  const o = sp.target.group.position;
  if (sp.kind === 'hero') {
    const a = sp.baseAz + sp.t * 0.45;                 // slow orbit in front of the QB
    _tp.set(o.x + Math.sin(a) * 6.2, 2.4, o.z + Math.cos(a) * 6.2);
    _tl.set(o.x, 1.7, o.z);
  } else if (sp.kind === 'fireworks') {                // low, tilted UP so the sky + bursts fill frame above the celebrating scorer
    const a = sp.baseAz + sp.t * 0.32;
    _tp.set(o.x + Math.sin(a) * 7, 1.5, o.z + Math.cos(a) * 7);
    _tl.set(o.x, 7.5, o.z);
  } else {                                             // 'td' — low, looking UP at the raised arms
    const a = sp.baseAz + sp.t * 0.6;
    _tp.set(o.x + Math.sin(a) * 4.6, 1.15, o.z + Math.cos(a) * 4.6);
    _tl.set(o.x, 2.5, o.z);
  }
  if (sp.t < 0.001) { cam.pos.copy(_tp); cam.lookCur.copy(_tl); }
  else { cam.pos.lerp(_tp, Math.min(1, dt * 3)); cam.lookCur.lerp(_tl, Math.min(1, dt * 4)); }
  const wantFov = sp.kind === 'td' ? 42 : sp.kind === 'fireworks' ? 60 : 48;
  camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix();
  shake.update(dt);
  camera.position.set(cam.pos.x + shake.offX, Math.max(0.8, cam.pos.y + shake.offY), cam.pos.z + shake.offZ);
  camera.lookAt(cam.lookCur);
  sun.position.set(o.x + 40, 70, o.z + 20); sun.target.position.set(o.x, 0, o.z);
}

// ===========================================================================
// Pre-game cinematic: the cheerleader chorus line dances at midfield while the
// camera makes a few broadcast moves. Skippable. Plays once when the game starts,
// then hands off to the normal kickoff (newPlay) behind a fade.
// ===========================================================================
const CINE_LERP = THREE.MathUtils.lerp;
const _cse = (u) => u * u * (3 - 2 * u); // smoothstep ease
// Each shot: a duration + fn(u)->{ p:[x,y,z] camera, l:[x,y,z] look, fov }. The
// dancers stand in a line on z=0 (x ~ ±11), facing -Z (the home sideline), so the
// "front" shots come from negative Z. 25s total across four moves with hard cuts.
const CINE_SHOTS = [
  { dur: 7, fn: (u) => ({ p: [CINE_LERP(-19, 19, u), 2.2, -13], l: [CINE_LERP(-6, 6, u), 1.6, 0], fov: 50 }) },                 // low tracking dolly across the line
  { dur: 6, fn: (u) => { const a = Math.PI * 0.18 + u * Math.PI * 0.64; return { p: [Math.sin(a) * 17, 4.6, -Math.cos(a) * 17], l: [0, 1.7, 0], fov: 46 }; } }, // slow orbit
  { dur: 6, fn: (u) => ({ p: [CINE_LERP(7, 1.5, _cse(u)), CINE_LERP(2.2, 13, _cse(u)), CINE_LERP(-12, -23, _cse(u))], l: [0, 1.5, 0], fov: 52 }) }, // crane up + pull back
  { dur: 6, fn: (u) => ({ p: [CINE_LERP(2.5, 0.4, _cse(u)), 1.5, CINE_LERP(-19, -8.5, _cse(u))], l: [0, 1.7, 0], fov: CINE_LERP(54, 40, _cse(u)) }) }, // hero push-in
];
const CINE_DUR = CINE_SHOTS.reduce((s, x) => s + x.dur, 0);
const CINE_SPOT_COLS = [0xfff2e0, 0xffd9a0, 0xbcd2ff]; // stage spotlight tints (warm key + amber/cool)
const _cineLookV = new THREE.Vector3();
const CINE_HIDE_HUD = ['hud', 'joystick', 'action-btn', 'turbo-btn', 'replay-btn', 'playresult', 'sim-q', 'gauntlet-hud']; // gameplay UI hidden during the cinematic
let _cineSkipEl = null, _cineSkipFn = null;
function setGroups(list, v) { if (!list) return; for (const ch of list) if (ch.group) ch.group.visible = v; }
function setCineHud(hidden) { for (const id of CINE_HIDE_HUD) { const el = document.getElementById(id); if (el) el.style.visibility = hidden ? 'hidden' : ''; } }
function showCineSkip() {
  if (!_cineSkipEl) {
    _cineSkipEl = document.createElement('div');
    _cineSkipEl.id = 'cineSkip'; _cineSkipEl.textContent = 'SKIP ▸';
    Object.assign(_cineSkipEl.style, {
      position: 'fixed', right: '22px', bottom: '20px', zIndex: 70, padding: '9px 18px',
      font: '700 13px/1 system-ui,Segoe UI,sans-serif', letterSpacing: '.14em', color: '#fff',
      background: 'rgba(0,0,0,.42)', border: '1px solid rgba(255,255,255,.55)', borderRadius: '999px',
      cursor: 'pointer', userSelect: 'none', backdropFilter: 'blur(2px)',
    });
    document.body.appendChild(_cineSkipEl);
  }
  _cineSkipEl.style.display = 'block';
  _cineSkipFn = () => endCinematic();
  _cineSkipEl.addEventListener('click', _cineSkipFn);
  // Defer the window-wide skip listeners a beat so the KICK OFF tap/key that
  // launched the cinematic doesn't instantly dismiss it.
  setTimeout(() => {
    if (!game.cinematic) return;
    // Capture phase so a tap anywhere skips even though the field's input handlers
    // stop propagation of pointer events.
    window.addEventListener('keydown', _cineSkipFn, true);
    window.addEventListener('pointerdown', _cineSkipFn, true);
  }, 250);
}
function hideCineSkip() {
  if (_cineSkipEl) _cineSkipEl.style.display = 'none';
  if (_cineSkipFn) {
    window.removeEventListener('keydown', _cineSkipFn, true);
    window.removeEventListener('pointerdown', _cineSkipFn, true);
    if (_cineSkipEl) _cineSkipEl.removeEventListener('click', _cineSkipFn);
    _cineSkipFn = null;
  }
}
function startCinematic() {
  game.cinematic = { t: 0 };
  setGroups(game.all, false); setGroups(game.bench, false); // clear the field — dancers only
  if (ball.mesh) ball.mesh.visible = false;
  if (losLine) losLine.visible = false; if (firstDownLine) firstDownLine.visible = false;
  setGroups(game.cheer, true);                               // bring on the chorus line
  setCineHud(true);                                          // clean broadcast frame (no gameplay HUD)
  // Dramatic staging: crush the arena to near-black and pool stage spotlights on
  // the line (reuses the prewarmed celebration spotlights, so no shader stall).
  setCelebLights(true);
  setCheerEmissive(0.38);                                    // dim self-glow so the spotlights sculpt them
  if (strobe) strobe.intensity = 0;                          // no red strobe — just the spots
  applyArenaDim(0.9);
  for (let i = 0; i < sweepLights.length; i++) {
    const L = sweepLights[i];
    const bx = (i - (sweepLights.length - 1) / 2) * 9;       // spread the beams across the line
    L.position.set(bx * 0.6, 33, -7); L.angle = Math.PI / 8; L.penumbra = 0.6; L.distance = 160; L.decay = 1.0;
    L.color.setHex(CINE_SPOT_COLS[i % CINE_SPOT_COLS.length]); L.intensity = 46;
    L.target.position.set(bx, 1, 0); L.target.updateMatrixWorld();
  }
  sun.position.set(40, 70, 20); sun.target.position.set(0, 0, 0); sun.target.updateMatrixWorld();
  driveCineCam(0);                                           // frame shot 1 before the first render
  showCineSkip();
}
function driveCineLights(t) { // gentle stage sweep + pulse on the spotlights
  for (let i = 0; i < sweepLights.length; i++) {
    const L = sweepLights[i];
    const bx = (i - (sweepLights.length - 1) / 2) * 9;
    L.target.position.set(bx + Math.sin(t * 0.9 + i * 2.1) * 3.5, 1, 0); L.target.updateMatrixWorld();
    L.intensity = 44 + Math.sin(t * 3 + i) * 6;
  }
}
function driveCineCam(t) {
  let acc = 0, shot = CINE_SHOTS[CINE_SHOTS.length - 1], u = 1;
  for (const s of CINE_SHOTS) { if (t < acc + s.dur) { shot = s; u = (t - acc) / s.dur; break; } acc += s.dur; }
  const o = shot.fn(THREE.MathUtils.clamp(u, 0, 1));
  camera.position.set(o.p[0], o.p[1], o.p[2]);
  _cineLookV.set(o.l[0], o.l[1], o.l[2]); camera.lookAt(_cineLookV);
  if (o.fov) { camera.fov = o.fov; camera.updateProjectionMatrix(); }
}
function updateCinematic(dt) {
  const c = game.cinematic; if (!c) return;
  c.t += dt;
  updateCheer(dt);
  driveCineCam(c.t);
  driveCineLights(c.t);
  if (c.t >= CINE_DUR) endCinematic();
}
function endCinematic() {
  if (!game.cinematic) return;
  game.cinematic = null;
  hideCineSkip();
  if (cutEl) cutEl.style.opacity = '1';                      // hard black hides the swap to gameplay
  placeCheerSideline();                                     // squad posts up on the sideline (two staggered lines)
  setGroups(game.all, true); setGroups(game.bench, true);
  setCineHud(false);                                        // restore the gameplay HUD
  applyLighting();                                          // un-dim the arena (back to night baseline)
  for (const L of sweepLights) L.intensity = 0; setCelebLights(false); // drop the stage spots
  if (ball.mesh) ball.mesh.visible = true;
  camera.fov = 55; camera.updateProjectionMatrix();
  newPlay();                                                // kick off the real game
  game.cut.phase = 'in'; game.cut.t = 0; game.cut.mid = null; // fade back in (driven by updateCut in simStep)
}

// Hide a perimeter WALL whenever the camera is on its OUTSIDE (the far side from
// the field), so a wall can never block the view of the players. The chain-link
// FENCE/cage is never hidden — we always see it. This runs every frame (live and
// replay): only the wall the camera has crossed behind disappears; the rest stay.
function updateWallVisibility() {
  const cp = camera.position;
  // Gameplay chase cam: pre-hide a wall as it nears it (1.5yd inside) so it never
  // clips through the shot. Cinematic cameras (replay orbit / finale) instead only
  // cull a wall the camera is genuinely BEYOND, so a wide broadcast shot keeps the
  // background walls it's merely close to (the old margin hid walls it shouldn't).
  const cine = game.state === STATE.REPLAY || (game.finale && game.finale.active);
  const m = cine ? -0.5 : 1.5; // outside = camera past (at - m)
  for (const o of camOccluders) {
    if (o.userData.cage) { o.visible = true; continue; } // the fence always shows
    const s = o.userData.cullSide, at = o.userData.cullAt;
    const outside = (s === 'px' && cp.x > at - m) || (s === 'nx' && cp.x < -at + m) ||
                    (s === 'pz' && cp.z > at - m) || (s === 'nz' && cp.z < -at + m);
    o.visible = !outside;
  }
}

function updateCamera(dt) {
  updateWallVisibility(); // hide only the wall the camera has moved outside of (fence stays)
  if (game.state === STATE.REPLAY) {
    // Manual replay: a user-driven orbit camera that FOLLOWS the action (drag to
    // rotate, pinch/scroll to zoom — see freecamControls). Reuses the debug orbit.
    if (game.replay.manual) {
      const b = ball.mesh.position;
      applyDebugCam(); // dbgCam.follow keeps it centered on the carrier/ball
      sun.position.set(b.x + 40, 70, b.z + 20); sun.target.position.set(b.x, 0, b.z);
      return;
    }
    // Cinematic broadcast shot: the current preset angle, slowly orbiting the
    // ball. On an angle cut (r.snap, set while the screen is black) we jump the
    // camera so the new shot is already framed when we fade back up.
    const r = game.replay, ang = REPLAY_ANGLES[r.angleIdx];
    const b = ball.mesh.position;
    // Orient by the recorded play's direction so the replay isn't mirrored vs the
    // live view (the live chase-cam faces game.dir; a -Z play would otherwise show
    // the teams on swapped sides). Rotate the preset 180° for a -Z play.
    const a = ang.az + (r.dir < 0 ? Math.PI : 0) + r.i * ang.orbit;
    _tp.set(b.x + Math.sin(a) * ang.dist, ang.height, b.z + Math.cos(a) * ang.dist);
    if (r.snap) { cam.pos.copy(_tp); cam.lookCur.copy(b); r.snap = false; }
    else { cam.pos.lerp(_tp, Math.min(1, dt * 3)); cam.lookCur.lerp(b, Math.min(1, dt * 5)); }
    if (Math.abs(camera.fov - ang.fov) > 0.01) { camera.fov = ang.fov; camera.updateProjectionMatrix(); }
    camera.position.copy(cam.pos); camera.lookAt(cam.lookCur);
    sun.position.set(b.x + 40, 70, b.z + 20); sun.target.position.set(b.x, 0, b.z);
    return;
  }
  if (game.finale && game.finale.active) { driveFinaleCam(dt); return; } // end-game dance party
  // Cinematic override (pre-snap hero / post-TD flex). Yields back to live framing
  // when it expires or the play state moves past its moment.
  if (cam.special) {
    const sp = cam.special; sp.t += dt;
    const live = sp.target && sp.target.group && !sp.target.ragdolling && (sp.kind === 'hero'
      ? (game.state === STATE.PRESNAP || game.state === STATE.RESET)
      : (game.state === STATE.DEAD || game.celebrating));
    if (sp.t >= sp.dur || !live) cam.special = null;
    else { driveSpecialCam(sp, dt); return; }
  }
  const t = game.controlled || game.qb;
  const ret = game.state === STATE.RETURN || game.returnActive;
  const air = ball.mode === 'flying';                       // the ball is in the air
  const loose = game.state === STATE.LOOSE;
  const chase = game.state === STATE.RUN || ret;            // behind a ball carrier
  // A pass play is a wide, high broadcast shot so the whole field reads.
  const passPlay = game.state === STATE.PRESNAP || game.state === STATE.LIVE || game.state === STATE.RESET || air;

  // Focus the BALL / the PLAY — never a single player. Follow the ball in flight
  // or loose; the carrier's body while it's tucked; the landing spot when dead.
  // (On defense this means the camera tracks the action, not your defender.)
  if (air || loose || ball.mode === 'rest' || ball.mode === 'dead' || ball.mode === 'secured') _fp.copy(ball.mesh.position);
  else if (ball.mode === 'carried') _fp.copy((game.carrier || ball.holder || game.qb).group.position);
  else _fp.copy((game.controlled || game.qb).group.position);

  // Heading: behind the ball carrier's travel on a run; toward the returner on a
  // runback; otherwise a steady shot facing the attacking end (the whole play
  // stays in frame instead of yawing around with the ball).
  const headObj = game.carrier || game.controlled || game.qb;
  let wantYaw;
  if (ret) { const rb = game.returner || game.carrier, rp = rb ? rb.group.position : _fp; wantYaw = Math.atan2(rp.x - _fp.x, rp.z - _fp.z); }
  else if (chase || game.state === STATE.TACKLE || game.state === STATE.BATTLE) wantYaw = headObj.heading;
  else wantYaw = game.dir > 0 ? 0 : Math.PI; // face the attacking end
  while (wantYaw > Math.PI) wantYaw -= Math.PI * 2;
  while (wantYaw < -Math.PI) wantYaw += Math.PI * 2;
  // Keep framed on the attacking end (game.dir), or the opposite end on a runback.
  const center = ret ? Math.PI : (game.dir > 0 ? 0 : Math.PI);
  let rel = wantYaw - center;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  wantYaw = center + THREE.MathUtils.clamp(rel, -1.15, 1.15); // ~±66° off downfield
  const k = Math.min(1, dt * (chase ? 4 : 3));
  cam.fwdX += (Math.sin(wantYaw) - cam.fwdX) * k;
  cam.fwdZ += (Math.cos(wantYaw) - cam.fwdZ) * k;
  const m = Math.hypot(cam.fwdX, cam.fwdZ) || 1;
  cam.fwdX /= m; cam.fwdZ /= m;

  // Framing: wide & high for pass plays (see the QB, the arc and the routes);
  // tighter & lower behind a ball carrier. Eased so a catch / incompletion
  // glides instead of snapping.
  let back = (passPlay ? 11 : chase ? 7 : loose ? 9.5 : 8.5) * TUNE.camDist;
  let hgt = (air ? Math.max(6.8, _fp.y + 3) : passPlay ? 6.8 : chase ? 4.3 : 5.6) * TUNE.camHeight;
  let aheadL = passPlay ? 11 : chase ? 7.5 : loose ? 6 : 6.5;
  let lookH = air ? (_fp.y * 0.5 + 1.0) : 1.5;
  // Coach cam: while the PLAY ART overlay is up pre-snap, pull the shot OUT and UP
  // and look further downfield so the whole formation + the art read at a glance.
  if (game.coachCam && game.state === STATE.PRESNAP) { back *= 1.7; hgt *= 2.05; aheadL = 22; lookH = 1.0; }
  const fe = Math.min(1, dt * 4); // framing ease
  cam.back += (back - cam.back) * fe;
  cam.hgt += (hgt - cam.hgt) * fe;
  cam.aheadL += (aheadL - cam.aheadL) * fe;
  cam.lookH += (lookH - cam.lookH) * fe;
  _tp.set(_fp.x - cam.fwdX * cam.back, cam.hgt, _fp.z - cam.fwdZ * cam.back);
  _tl.set(_fp.x + cam.fwdX * cam.aheadL, cam.lookH, _fp.z + cam.fwdZ * cam.aheadL);

  // Cinematic hit push-in: a tight 3/4 close-up on the pile that eases in and
  // out on REAL time (so it's smooth no matter how slow the sim runs), plus a
  // real FOV zoom for a clear, smooth zoom-in on the hit.
  const wantCine = cam.cineHold > 0 ? 1 : 0;
  if (cam.cineHold > 0) cam.cineHold -= dt;
  else if (cam.cine < 0.01) cam.cineZoom = 1; // back to default depth once the close-up has fully released
  // Symmetric, gentle ease both ways → no snap/jerk into or out of the zoom.
  cam.cine = moveToward(cam.cine, wantCine, dt / (wantCine > cam.cine ? 0.28 : 0.6));
  const e = cam.cine * cam.cine * (3 - 2 * cam.cine); // smoothstep
  const z = cam.cineZoom; // close-up depth (bigger hits punch in tighter)
  if (cam.cine > 0.001) {
    const f = (game.carrier || t).group.position;
    _cinePos.set(f.x + 3.4 / z, 2.6 + 1.0 / z, f.z - 3.0 / z); // tighter offset + lower for a bigger zoom
    _cineLook.set(f.x, 1.0, f.z);
    _tp.lerp(_cinePos, e); _tl.lerp(_cineLook, e);
  }
  // FOV: a touch wider on pass plays so more of the field fits; the hit close-up
  // zooms in from there (down to ~34°, tighter on the biggest hits).
  const baseFov = (passPlay ? 60 : 55) * TUNE.camFov;
  cam.fovKick = Math.max(0, cam.fovKick - dt * 22); // snap zoom-punch, eases out
  const minFov = THREE.MathUtils.clamp(34 - (z - 1) * 17, 18, 34);
  const wantFov = baseFov - (baseFov - minFov) * e - cam.fovKick;
  if (Math.abs(camera.fov - wantFov) > 0.01) { camera.fov = wantFov; camera.updateProjectionMatrix(); }

  // Eased follow — gentle while tracking the ball so the broadcast shot glides
  // (no jitter), snappier into the cinematic hit close-up.
  const lt = Math.min(1, dt * (air ? 8 : 6 + cam.cine * 6));
  cam.pos.lerp(_tp, lt);
  cam.lookCur.lerp(_tl, Math.min(1, lt * 1.2));

  // Shake on top; never let the camera dip into the turf.
  shake.update(dt);
  const cy = Math.max(1.3, cam.pos.y + shake.offY);
  camera.position.set(cam.pos.x + shake.offX, cy, cam.pos.z + shake.offZ);
  camera.lookAt(cam.lookCur);

  sun.position.set(_fp.x + 40, 70, _fp.z + 20); sun.target.position.set(_fp.x, 0, _fp.z);
}

// ===========================================================================
// Loop
// ===========================================================================
// Living stadium: scroll the LED ads and pop random crowd camera flashes.
function updateAmbience(dt) {
  if (adBoardTex) adBoardTex.offset.x = (adBoardTex.offset.x + dt * 0.06) % 1;
  if (crowdFlashes.length) {
    if (Math.random() < 0.5) {
      const s = crowdFlashes[(Math.random() * crowdFlashes.length) | 0];
      const th = Math.random() * Math.PI * 2, r = 84;
      s.position.set(Math.cos(th) * r, 14 + Math.random() * 16, Math.sin(th) * r);
      s.userData.f = 1;
    }
    for (const s of crowdFlashes) if (s.userData.f > 0) { s.userData.f -= dt * 3.5; s.material.opacity = Math.max(0, s.userData.f); }
  }
}
const clock = new THREE.Clock();
const fpsEl = document.getElementById('fps');
let _fpsT = (typeof performance !== 'undefined' ? performance.now() : 0), _fpsN = 0;
function updateFps() {
  if (!fpsEl) return;
  _fpsN++;
  const now = performance.now(), el = now - _fpsT;
  if (el >= 500) { fpsEl.textContent = Math.round(_fpsN * 1000 / el) + ' FPS'; _fpsT = now; _fpsN = 0; }
}
const dbgEl = document.getElementById('dbg');
let dbgOn = false;
function toggleDbg() { dbgOn = !dbgOn; if (dbgEl) dbgEl.classList.toggle('hidden', !dbgOn); }
function updateDbg() { if (dbgOn && dbgEl) { try { dbgEl.textContent = balanceSummary().text; } catch (e) { /* ignore */ } } }

// ---- DEBUG MODE panel: live-tune the gameplay knobs (TUNE) + fire test triggers.
// Open by tapping the version badge or pressing the ` key. ------------------------
const L = () => applyLighting();
const DBG_KNOBS = [
  // --- Gameplay ---
  { tab: 'Gameplay', key: 'fightChance', label: 'Scuffle chance', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
  { tab: 'Gameplay', key: 'fightKnockback', label: 'Scuffle knockback', min: 0, max: 8, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'Gameplay', key: 'blockTempo', label: 'Block tempo ×', min: 0.3, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Gameplay', key: 'staggerDur', label: 'Break stagger (s)', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Gameplay', key: 'fumbleChance', label: 'Fumble odds ×', min: 0, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'Gameplay', key: 'breakTackleEase', label: 'Break-tackle ease ×', min: 0.3, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'Gameplay', key: 'battleChance', label: 'Battle trigger odds', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { tab: 'Gameplay', key: 'celebChance', label: 'TD celebration odds', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Gameplay', key: 'quarterLen', label: 'Quarter length (s)', min: 30, max: 180, step: 5, fmt: (v) => String(v | 0) },
  { tab: 'Gameplay', key: 'turboMult', label: 'Turbo power ×', min: 1, max: 1.8, step: 0.02, fmt: (v) => v.toFixed(2) },
  { tab: 'Gameplay', key: 'onFireBoost', label: 'On-fire speed ×', min: 1, max: 1.5, step: 0.02, fmt: (v) => v.toFixed(2) },
  { tab: 'Gameplay', key: 'catchBias', label: 'Catch odds +/-', min: -0.3, max: 0.3, step: 0.02, fmt: (v) => (v >= 0 ? '+' : '') + v.toFixed(2) },
  { tab: 'Gameplay', key: 'intChance', label: 'Interception odds ×', min: 0, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'Gameplay', key: 'userCatch', label: 'User catch', min: 0, max: 1, step: 1, type: 'bool', fmt: (v) => (v ? 'on' : 'off') },
  { tab: 'Gameplay', key: 'catchWindow', label: 'Catch window (yd)', min: 0.6, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'Gameplay', key: 'userCatchBonus', label: 'User catch bonus', min: 0, max: 0.5, step: 0.02, fmt: (v) => '+' + v.toFixed(2) },
  { tab: 'Gameplay', key: 'racBoost', label: 'RAC burst ×', min: 1, max: 1.6, step: 0.02, fmt: (v) => v.toFixed(2) },
  { tab: 'Gameplay', key: 'catchMissPenalty', label: 'Mistimed catch −', min: 0, max: 0.3, step: 0.02, fmt: (v) => '−' + v.toFixed(2) },
  { tab: 'Gameplay', key: 'possCatch', label: 'Possession bonus', min: 0, max: 0.4, step: 0.02, fmt: (v) => '+' + v.toFixed(2) },
  { tab: 'Gameplay', key: 'aggContest', label: 'Aggressive contest+', min: 0, max: 0.5, step: 0.02, fmt: (v) => '+' + v.toFixed(2) },
  { tab: 'Gameplay', key: 'aggSecurity', label: 'Aggressive risk−', min: 0, max: 0.4, step: 0.02, fmt: (v) => '−' + v.toFixed(2) },
  { tab: 'Gameplay', key: 'contestPhysics', label: 'Contest physics', min: 0, max: 1, step: 1, type: 'bool', fmt: (v) => (v ? 'on' : 'off') },
  { tab: 'Gameplay', key: 'tipChance', label: 'Tipped-ball chance', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Gameplay', key: 'catchHitRisk', label: 'Contest-catch fumble', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Gameplay', key: 'fatigueDrain', label: 'Fatigue drain ×', min: 0, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'Gameplay', key: 'knockdownRecover', label: 'Knockdown recover (s)', min: 0, max: 6, step: 0.2, fmt: (v) => (v ? v.toFixed(1) : 'off') },
  { tab: 'Gameplay', key: 'playClock', label: 'Play clock (s)', min: 5, max: 30, step: 1, fmt: (v) => String(v | 0) },
  { tab: 'Gameplay', key: 'swarmRadius', label: 'Gang-tackle radius', min: 1.5, max: 7, step: 0.5, fmt: (v) => v.toFixed(1) },
  { tab: 'Gameplay', key: 'jamYards', label: 'Coverage jam (yd)', min: 0, max: 15, step: 1, fmt: (v) => v.toFixed(0) },
  // --- Contact spacing (also editable visually in the Contact Lab) ---
  { tab: 'Contact', key: 'gapBattle', label: 'Battle gap (yd)', min: 0.05, max: 1.5, step: 0.02, fmt: (v) => v.toFixed(2) },
  { tab: 'Contact', key: 'latBattle', label: 'Battle lateral (yd)', min: -1, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
  { tab: 'Contact', key: 'gapBlock', label: 'Block gap (yd)', min: 0.05, max: 1.5, step: 0.02, fmt: (v) => v.toFixed(2) },
  { tab: 'Contact', key: 'latBlock', label: 'Block lateral (yd)', min: -1, max: 1, step: 0.02, fmt: (v) => v.toFixed(2) },
  { tab: 'Contact', key: 'gapGrab', label: 'Wrap/drag radius (yd)', min: 0.12, max: 1.5, step: 0.02, fmt: (v) => v.toFixed(2) },
  { tab: 'Gameplay', key: 'cpuSpdMul', label: 'CPU speed ×', min: 0.7, max: 1.4, step: 0.02, fmt: (v) => v.toFixed(2) },
  { tab: 'Gameplay', key: 'cpuCatchAdd', label: 'CPU catch +/-', min: -0.3, max: 0.3, step: 0.02, fmt: (v) => (v >= 0 ? '+' : '') + v.toFixed(2) },
  { tab: 'Gameplay', key: 'cpuAccMul', label: 'CPU accuracy ×', min: 0.5, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Gameplay', key: 'userBreakMul', label: 'Your break-tackle ×', min: 0.5, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  // --- Colliders + sizes ---
  { tab: 'Colliders', key: 'tackleReach', label: 'Tackle reach (yd)', min: 0.6, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'Colliders', key: 'catchReach', label: 'Catch reach (yd)', min: 0.6, max: 4, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'Colliders', key: 'catchGrab', label: 'Catch grab slack (yd)', min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Colliders', key: 'catchSecure', label: 'Secure time (s)', min: 0.05, max: 0.6, step: 0.01, fmt: (v) => v.toFixed(2) },
  { tab: 'Colliders', key: 'catchLog', label: 'Catch log', min: 0, max: 1, step: 1, type: 'bool', fmt: (v) => (v ? 'on' : 'off') },
  { tab: 'Colliders', key: 'jumpReach', label: 'Jump-ball weight', min: 0, max: 2, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'Colliders', key: 'catchHeight', label: 'Catch height ×', min: 0.4, max: 2.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Colliders', key: 'catchIK', label: 'Hand IK', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Colliders', key: 'engageReach', label: 'Block engage (yd)', min: 0.6, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'Colliders', key: 'bodyFit', label: 'Body collider × (model)', min: 0.3, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Colliders', key: 'playerSize', label: 'Player size ×', min: 0.5, max: 2, step: 0.05, fmt: (v) => v.toFixed(2), onChange: () => applyPlayerSize() },
  { tab: 'Colliders', key: 'ballSize', label: 'Ball size ×', min: 0.3, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) },
  // --- Look / materials ---
  { tab: 'Look', key: 'altModel', label: 'Your-team model', min: 0, max: ALT_MODEL_DEFS.length, step: 1, fmt: (v) => { const i = v | 0; return (PLAYER_MODELS[i] && PLAYER_MODELS[i].name) || (i === 0 ? 'DEFAULT' : '#' + i); }, onChange: () => applyModelChoice() },
  { tab: 'Look', key: 'offenseTint', label: 'Offense tint', type: 'color', onChange: () => applyLook() },
  { tab: 'Look', key: 'defenseTint', label: 'Defense tint', type: 'color', onChange: () => applyLook() },
  { tab: 'Look', key: 'skinRough', label: 'Skin roughness', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2), onChange: () => applyLook() },
  { tab: 'Look', key: 'skinMetal', label: 'Skin metalness', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2), onChange: () => applyLook() },
  { tab: 'Look', key: 'turfTint', label: 'Turf tint', type: 'color', onChange: () => applyLook() },
  { tab: 'Look', key: 'runLean', label: 'Run lean ×', min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  // --- Anim: procedural pose intensities (× each eased overlay) ---
  { tab: 'Anim', key: 'animBank', label: 'Turn lean ×', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Anim', key: 'animBreath', label: 'Idle breathing ×', min: 0, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'Anim', key: 'animBlock', label: 'Block pose ×', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Anim', key: 'animBattle', label: 'Tackle/battle ×', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Anim', key: 'animArm', label: 'Arm moves ×', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Anim', key: 'animCatch', label: 'Catch reach ×', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Anim', key: 'animThrow', label: 'Throw pose ×', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Anim', key: 'animGrab', label: 'Grab/wrap ×', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Anim', key: 'animSulk', label: 'Sulk slump ×', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Anim', key: 'animHead', label: 'Head swivel ×', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Anim', key: 'animProtect', label: 'Ball protect ×', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  // --- Lighting (intensity + color per source) ---
  { tab: 'Lighting', key: 'exposure', label: 'Exposure', min: 0.3, max: 2.5, step: 0.05, fmt: (v) => v.toFixed(2), onChange: L },
  { tab: 'Lighting', key: 'lightAmbient', label: 'Ambient', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2), onChange: L },
  { tab: 'Lighting', key: 'lightAmbientSky', label: 'Ambient · sky', type: 'color', onChange: L },
  { tab: 'Lighting', key: 'lightAmbientGround', label: 'Ambient · ground', type: 'color', onChange: L },
  { tab: 'Lighting', key: 'lightKey', label: 'Key / sun', min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2), onChange: L },
  { tab: 'Lighting', key: 'lightKeyColor', label: 'Key / sun color', type: 'color', onChange: L },
  { tab: 'Lighting', key: 'lightRim', label: 'Rim', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2), onChange: L },
  { tab: 'Lighting', key: 'lightRimColor', label: 'Rim color', type: 'color', onChange: L },
  { tab: 'Lighting', key: 'lightFloods', label: 'Floodlights ×', min: 0, max: 3, step: 0.1, fmt: (v) => v.toFixed(1), onChange: L },
  { tab: 'Lighting', key: 'lightFloodColor', label: 'Floodlight color', type: 'color', onChange: L },
  { tab: 'Lighting', key: 'playerGlow', label: 'Player glow', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2), onChange: () => applyPlayerGlow() },
  // --- Camera framing (the Camera tab also holds the free-cam / rewind controls) ---
  { tab: 'Camera', key: 'camFov', label: 'FOV ×', min: 0.6, max: 1.6, step: 0.02, fmt: (v) => v.toFixed(2) },
  { tab: 'Camera', key: 'camDist', label: 'Cam distance ×', min: 0.4, max: 2.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { tab: 'Camera', key: 'camHeight', label: 'Cam height ×', min: 0.4, max: 2.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  // --- FX / juice ---
  { tab: 'FX', key: 'ragdolls', label: 'Ragdolls', min: 0, max: 1, step: 1, fmt: (v) => (v >= 0.5 ? 'on' : 'off') },
  { tab: 'FX', key: 'gore', label: 'Gore', min: 0, max: 1, step: 1, fmt: (v) => (v >= 0.5 ? 'on' : 'off') },
  { tab: 'FX', key: 'shakeAmt', label: 'Screen shake ×', min: 0, max: 2, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'FX', key: 'hitZoomAmt', label: 'Hit zoom ×', min: 0, max: 2, step: 0.1, fmt: (v) => v.toFixed(1) },
  // --- World + audio ---
  { tab: 'World', key: 'fogColor', label: 'Fog color', type: 'color', onChange: () => applyFog() },
  { tab: 'World', key: 'fogNear', label: 'Fog near', min: 0, max: 300, step: 10, fmt: (v) => String(v | 0), onChange: () => applyFog() },
  { tab: 'World', key: 'fogFar', label: 'Fog far', min: 50, max: 600, step: 10, fmt: (v) => String(v | 0), onChange: () => applyFog() },
  { tab: 'World', key: 'masterVolume', label: 'Volume', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2), onChange: () => applyAudio() },
  { tab: 'World', key: 'musicVolume', label: 'Music vol', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2), onChange: () => applyAudio() },
  { tab: 'World', key: 'sfxVolume', label: 'SFX vol', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2), onChange: () => applyAudio() },
  { tab: 'World', key: 'voiceVolume', label: 'Voice vol', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2), onChange: () => applyAudio() },
  // --- Viz: AI / hitbox debug overlays ---
  { tab: 'Viz', key: 'vizColliders', label: 'Collider rings', min: 0, max: 1, step: 1, fmt: (v) => (v >= 0.5 ? 'on' : 'off') },
  { tab: 'Viz', key: 'vizVectors', label: 'Velocity + assignments', min: 0, max: 1, step: 1, fmt: (v) => (v >= 0.5 ? 'on' : 'off') },
  { tab: 'Viz', key: 'vizLabels', label: 'State labels', min: 0, max: 1, step: 1, fmt: (v) => (v >= 0.5 ? 'on' : 'off') },
  { tab: 'Viz', key: 'vizLog', label: 'Event log', min: 0, max: 1, step: 1, fmt: (v) => (v >= 0.5 ? 'on' : 'off') },
];
const dbgPanelEl = document.getElementById('debugpanel');
let dbgPanelOn = false;
const dbgValEls = {};
function buildKnobRow(k, pane) {
  const row = document.createElement('div'); row.className = 'dbg-row';
  if (k.type === 'color') {
    row.classList.add('dbg-rowcolor');
    const lab = document.createElement('label'); const name = document.createElement('span'); name.textContent = k.label; lab.append(name);
    const inp = document.createElement('input'); inp.type = 'color'; inp.value = TUNE[k.key];
    inp.addEventListener('input', () => { TUNE[k.key] = inp.value; if (k.onChange) k.onChange(); updateDbgExport(); });
    dbgValEls[k.key] = { sl: inp, set: (v) => { inp.value = v; } };
    row.append(lab, inp);
  } else {
    const lab = document.createElement('label');
    const name = document.createElement('span'); name.textContent = k.label;
    const val = document.createElement('span'); val.className = 'dbg-val'; val.textContent = k.fmt(TUNE[k.key]);
    lab.append(name, val);
    const slline = document.createElement('div'); slline.className = 'dbg-sl';
    const sl = document.createElement('input');
    sl.type = 'range'; sl.min = k.min; sl.max = k.max; sl.step = k.step; sl.value = TUNE[k.key];
    const commit = () => { val.textContent = k.fmt(TUNE[k.key]); if (k.onChange) k.onChange(); updateDbgExport(); };
    sl.addEventListener('input', () => { TUNE[k.key] = parseFloat(sl.value); commit(); });
    const step = (dir) => { const v = THREE.MathUtils.clamp(parseFloat((TUNE[k.key] + dir * k.step).toFixed(4)), k.min, k.max); TUNE[k.key] = v; sl.value = v; commit(); };
    const bMinus = document.createElement('button'); bMinus.textContent = '−'; bMinus.addEventListener('click', () => step(-1));
    const bPlus = document.createElement('button'); bPlus.textContent = '+'; bPlus.addEventListener('click', () => step(1));
    slline.append(bMinus, sl, bPlus);
    dbgValEls[k.key] = { val, sl, fmt: k.fmt, set: (v) => { sl.value = v; val.textContent = k.fmt(v); } };
    row.append(lab, slline);
  }
  pane.appendChild(row);
}
function buildDebugPanel() {
  if (!dbgPanelEl) return;
  const rowsWrap = dbgPanelEl.querySelector('.dbg-rows'); const tabsBar = dbgPanelEl.querySelector('.dbg-tabs');
  rowsWrap.innerHTML = ''; tabsBar.innerHTML = '';
  // Tabs: one per knob group, plus a Camera tab holding the cam/rewind controls.
  const tabs = []; for (const k of DBG_KNOBS) if (!tabs.includes(k.tab)) tabs.push(k.tab);
  if (!tabs.includes('Camera')) tabs.push('Camera');
  const panes = {};
  for (const t of tabs) { const p = document.createElement('div'); p.className = 'dbg-pane'; panes[t] = p; rowsWrap.appendChild(p); }
  for (const k of DBG_KNOBS) buildKnobRow(k, panes[k.tab]);
  const camSec = dbgPanelEl.querySelector('.dbg-cam'); if (camSec) panes['Camera'].appendChild(camSec);
  if (!tabs.includes('Presets')) { tabs.push('Presets'); const p = document.createElement('div'); p.className = 'dbg-pane'; panes['Presets'] = p; rowsWrap.appendChild(p); }
  const presetsSec = dbgPanelEl.querySelector('.dbg-presets'); if (presetsSec) panes['Presets'].appendChild(presetsSec);
  if (!tabs.includes('Scenario')) { tabs.push('Scenario'); const p = document.createElement('div'); p.className = 'dbg-pane'; panes['Scenario'] = p; rowsWrap.appendChild(p); }
  const scSec = dbgPanelEl.querySelector('.dbg-scenario'); if (scSec) panes['Scenario'].appendChild(scSec);
  if (!tabs.includes('Stats')) { tabs.push('Stats'); const p = document.createElement('div'); p.className = 'dbg-pane'; panes['Stats'] = p; rowsWrap.appendChild(p); }
  const statSec = dbgPanelEl.querySelector('.dbg-stats'); if (statSec) panes['Stats'].appendChild(statSec);
  const showTab = (t) => { for (const tt of tabs) panes[tt].classList.toggle('on', tt === t); tabsBar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t)); };
  for (const t of tabs) { const b = document.createElement('button'); b.textContent = t; b.dataset.tab = t; b.addEventListener('click', () => showTab(t)); tabsBar.appendChild(b); }
  showTab(tabs[0]);
  const refreshSliders = () => { for (const k of DBG_KNOBS) { dbgValEls[k.key].set(TUNE[k.key]); if (k.onChange) k.onChange(); } updateDbgExport(); };
  dbgPanelEl.querySelector('#dbg-close').addEventListener('click', () => toggleDebugPanel(false));
  dbgPanelEl.querySelector('#dbg-scuffle').addEventListener('click', forceScuffle);
  { const tb = dbgPanelEl.querySelector('#dbg-throw'); if (tb) tb.addEventListener('click', dbgThrowToWR); }
  { const lb = dbgPanelEl.querySelector('#dbg-lab'); if (lb) lb.addEventListener('click', () => { toggleDebugPanel(false); enterLab(); }); }
  // Save: persist the current knobs to localStorage so they survive a reload.
  const saveBtn = dbgPanelEl.querySelector('#dbg-save');
  saveBtn.addEventListener('click', () => {
    try { localStorage.setItem(TUNE_STORE_KEY, dbgTuneJSON()); saveBtn.textContent = '✓ Saved'; }
    catch (e) { saveBtn.textContent = 'Save failed'; }
    setTimeout(() => { saveBtn.textContent = 'Save'; }, 1200);
  });
  // Copy: put the JSON on the clipboard so it can be pasted in to become the defaults.
  const copyBtn = dbgPanelEl.querySelector('#dbg-copy');
  copyBtn.addEventListener('click', async () => {
    const json = dbgTuneJSON();
    try { await navigator.clipboard.writeText(json); copyBtn.textContent = '✓ Copied'; }
    catch (e) { copyBtn.textContent = 'Copy failed'; }
    setTimeout(() => { copyBtn.textContent = 'Copy values'; }, 1200);
  });
  // Reset: back to code defaults AND clear the saved override.
  dbgPanelEl.querySelector('#dbg-reset').addEventListener('click', () => {
    Object.assign(TUNE, TUNE_DEFAULTS);
    try { localStorage.removeItem(TUNE_STORE_KEY); } catch (e) { /* ignore */ }
    refreshSliders();
  });
  const diffBtn = dbgPanelEl.querySelector('#dbg-diff');
  diffBtn.addEventListener('click', () => {
    const order = ['rookie', 'pro', 'allpro'];
    game.diff = order[(order.indexOf(game.diff) + 1) % order.length];
    diffBtn.textContent = 'Difficulty: ' + DIFF[game.diff].label;
  });
  diffBtn.textContent = 'Difficulty: ' + (DIFF[game.diff] || DIFF.pro).label;
  // Free camera + rewind + screenshot
  dbgPanelEl.querySelector('#dbg-freecam').addEventListener('click', () => toggleDebugCam());
  dbgPanelEl.querySelector('#dbg-rew').addEventListener('click', () => { if (dbgCam.on) setDbgScrub(dbgCam.scrub - 5); });
  dbgPanelEl.querySelector('#dbg-fwd').addEventListener('click', () => { if (dbgCam.on) setDbgScrub(dbgCam.scrub + 5); });
  dbgPanelEl.querySelector('#dbg-shot').addEventListener('click', () => { dbgCam.shot = true; });
  dbgPanelEl.querySelector('#dbg-step').addEventListener('click', () => { if (dbgCam.on) { dbgCam.scrub = -1; dbgCam.step = true; } }); // advance one sim tick while frozen
  // Scenario: set LOS / down / to-go and re-line-up the play.
  const scBind = (id, vid) => { const el = dbgPanelEl.querySelector(id), v = dbgPanelEl.querySelector(vid); if (el && v) el.addEventListener('input', () => { v.textContent = el.value; }); };
  scBind('#dbg-sc-los', '#dbg-sc-losv'); scBind('#dbg-sc-down', '#dbg-sc-downv'); scBind('#dbg-sc-togo', '#dbg-sc-togov');
  dbgPanelEl.querySelector('#dbg-sc-apply').addEventListener('click', () => {
    if (dbgCam.on) toggleDebugCam(false); // unfreeze so the new play runs
    game.los = +dbgPanelEl.querySelector('#dbg-sc-los').value;
    game.down = +dbgPanelEl.querySelector('#dbg-sc-down').value;
    game.firstDown = game.los + game.dir * (+dbgPanelEl.querySelector('#dbg-sc-togo').value);
    newPlay();
  });
  const arBtn = dbgPanelEl.querySelector('#dbg-autorot'); arBtn.addEventListener('click', () => { dbgCam.autoRotate = !dbgCam.autoRotate; arBtn.textContent = 'Auto-rotate: ' + (dbgCam.autoRotate ? 'on' : 'off'); });
  const flBtn = dbgPanelEl.querySelector('#dbg-follow'); flBtn.addEventListener('click', () => { dbgCam.follow = !dbgCam.follow; flBtn.textContent = 'Follow ball: ' + (dbgCam.follow ? 'on' : 'off'); });
  dbgPanelEl.querySelector('#dbg-scrub').addEventListener('input', (e) => { if (dbgCam.on) dbgCam.scrub = THREE.MathUtils.clamp(Math.round(+e.target.value), 0, dbgScrubMax()); });
  // Presets (named localStorage slots) + in-memory A/B compare.
  const PRESETS_KEY = 'rfPresets';
  const getPresets = () => { try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}'); } catch (e) { return {}; } };
  const putPresets = (o) => { try { localStorage.setItem(PRESETS_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ } };
  const sel = dbgPanelEl.querySelector('#dbg-preset-list');
  const refreshPresets = () => { const o = getPresets(); sel.innerHTML = Object.keys(o).map((nm) => `<option>${nm}</option>`).join(''); };
  const applyTune = (json) => { try { const o = JSON.parse(json); for (const k in TUNE_DEFAULTS) if (o[k] !== undefined && typeof o[k] === typeof TUNE_DEFAULTS[k]) TUNE[k] = o[k]; refreshSliders(); } catch (e) { /* ignore */ } };
  refreshPresets();
  dbgPanelEl.querySelector('#dbg-preset-save').addEventListener('click', () => {
    const nm = (dbgPanelEl.querySelector('#dbg-preset-name').value || '').trim(); if (!nm) return;
    const o = getPresets(); o[nm] = dbgTuneJSON(); putPresets(o); refreshPresets();
  });
  dbgPanelEl.querySelector('#dbg-preset-load').addEventListener('click', () => { const nm = sel.value; const o = getPresets(); if (o[nm]) applyTune(o[nm]); });
  dbgPanelEl.querySelector('#dbg-preset-del').addEventListener('click', () => { const nm = sel.value; const o = getPresets(); if (o[nm]) { delete o[nm]; putPresets(o); refreshPresets(); } });
  let abA = null, abB = null;
  dbgPanelEl.querySelector('#dbg-setA').addEventListener('click', () => { abA = dbgTuneJSON(); });
  dbgPanelEl.querySelector('#dbg-setB').addEventListener('click', () => { abB = dbgTuneJSON(); });
  dbgPanelEl.querySelector('#dbg-toA').addEventListener('click', () => { if (abA) applyTune(abA); });
  dbgPanelEl.querySelector('#dbg-toB').addEventListener('click', () => { if (abB) applyTune(abB); });
  // Stats / balance report
  dbgPanelEl.querySelector('#dbg-stat-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(dbgBalanceReport()); } catch (e) { /* ignore */ } });
  dbgPanelEl.querySelector('#dbg-stat-reset').addEventListener('click', () => { game.tally = { plays: 0, sacks: 0, fumbles: 0, picks: 0, bigPlays: 0 }; for (const ch of game.all) ch.stats = blankStats(); game.userStats.tackles = game.userStats.catches = game.userStats.ints = 0; saveUserStats(); });
  updateDbgExport();
}
// Pretty one-line JSON of the current knobs (rounded), for Save / Copy / display.
function dbgTuneJSON() {
  const o = {}; for (const k in TUNE_DEFAULTS) { const v = TUNE[k]; o[k] = typeof v === 'number' ? Math.round(v * 1000) / 1000 : v; }
  return JSON.stringify(o);
}
function updateDbgExport() {
  if (!dbgPanelEl) return;
  const ex = dbgPanelEl.querySelector('.dbg-export');
  if (ex) { const saved = (() => { try { return localStorage.getItem(TUNE_STORE_KEY); } catch (e) { return null; } })(); ex.textContent = (saved ? '★ saved · ' : '') + dbgTuneJSON(); }
}
function toggleDebugPanel(on) {
  dbgPanelOn = on === undefined ? !dbgPanelOn : on;
  if (dbgPanelEl) dbgPanelEl.classList.toggle('hidden', !dbgPanelOn);
}
// Trigger a post-play scuffle on demand near the ball so the knobs can be eyeballed.
// Catch test rig: stage a real throw to a receiver on demand so catches can be
// iterated without running a whole play. Snaps first if we're pre-snap, then
// throws a medium lob to the controlled receiver (or the selected one) — exercising
// the exact catch path. Turn on TUNE.catchLog to read the per-catch telemetry.
function dbgThrowToWR() {
  if (!game.userOnOffense) { setStatus('Throw test: offense only'); return; }
  const fire = () => {
    if (!game.receivers || !game.receivers.length) { setStatus('Throw test: no receivers'); return; }
    // Aim at whoever you're controlling if it's a receiver, else the open WR.
    let i = game.receivers.indexOf(game.controlled);
    if (i < 0) i = game.selected || 0;
    game.selected = THREE.MathUtils.clamp(i, 0, game.receivers.length - 1);
    throwBall(0.45);
  };
  if (game.state === STATE.PRESNAP) { snap(); setTimeout(fire, 600); } // let the route develop a beat
  else if (game.state === STATE.LIVE) fire();
  else setStatus('Throw test: snap a play first');
}
function forceScuffle() {
  const c = game.carrier || game.qb || ball.holder;
  const x = c ? c.group.position.x : 0;
  const z = c ? c.group.position.z : (ball.mesh ? ball.mesh.position.z : game.los);
  const ok = startPostPlayFight(x, z);
  if (!ok) setStatus('No opposing pair nearby to scuffle');
}
// ============================================================================
// CONTACT LAB — a standalone editor for the two-player CONTACT poses. Loads just a
// red carrier (A) + a blue defender (B), cycles every collision/contact pose
// (battle / block / wrap-drag / ball-protect), and lets you orbit the camera and
// tune the SPACING knobs (gap/lateral) that feed the live game. Save persists to
// localStorage (the published game reads it on load); Copy exports the JSON to bake
// into the code defaults. Enter via ?lab or the debug panel's Contact Lab button.
// ============================================================================
const LAB = { on: false, idx: 0, A: null, B: null, wasInGame: false };
const _labMid = new THREE.Vector3();
function labPose(ch, want, dt) {
  setClip(ch, ch.actions[want] ? want : 'run');
  ch.group.rotation.set(0, ch.heading, 0);
  stepMixer(ch, dt);
}
const LAB_CONTACTS = [
  { name: 'BREAK-TACKLE BATTLE', keys: ['gapBattle', 'latBattle'],
    place(A, B) { const ang = A.heading, sa = Math.sin(ang), ca = Math.cos(ang), rx = Math.cos(ang), rz = -Math.sin(ang);
      B.group.position.set(sa * TUNE.gapBattle + rx * TUNE.latBattle, 0, ca * TUNE.gapBattle + rz * TUNE.latBattle); B.heading = ang + Math.PI; },
    apply(A, B, dt) { labPose(A, 'run', dt); labPose(B, B.actions.block ? 'block' : 'run', dt);
      applyBattleLean(A, false, 1); applyBattleArms(A, false, 1); applyBattleLean(B, true, 1); applyBattleArms(B, true, 1); } },
  { name: 'ENGAGED BLOCK', keys: ['gapBlock', 'latBlock'],
    place(A, B) { const ang = A.heading, sa = Math.sin(ang), ca = Math.cos(ang), px = ca, pz = -sa;
      B.group.position.set(sa * TUNE.gapBlock * 2 + px * TUNE.latBlock, 0, ca * TUNE.gapBlock * 2 + pz * TUNE.latBlock); B.heading = ang + Math.PI; },
    apply(A, B, dt) { labPose(A, 'run', dt); labPose(B, 'run', dt); applyBlockPose(A, 1); applyBlockPose(B, 1); } },
  { name: 'WRAP / GANG DRAG', keys: ['gapGrab'],
    place(A, B) { const ang = A.heading, sa = Math.sin(ang), ca = Math.cos(ang);
      B.group.position.set(sa * TUNE.gapGrab, 0, ca * TUNE.gapGrab); B.heading = ang + Math.PI; },
    apply(A, B, dt) { labPose(A, 'run', dt); labPose(B, 'run', dt); applyGrabLean(A, 1); applyBattleArms(B, true, 1); } },
  { name: 'BALL PROTECT (carry)', keys: [],
    place(A, B) { const ang = A.heading, sa = Math.sin(ang), ca = Math.cos(ang);
      B.group.position.set(sa * 0.5, 0, ca * 0.5); B.heading = ang + Math.PI; },
    apply(A, B, dt) { labPose(A, 'run', dt); labPose(B, 'run', dt); A.catchStyle = ''; applyCarryProtect(A, 1); } },
];
const labPanelEl = document.getElementById('lab-panel');
const labKnob = (key) => DBG_KNOBS.find((k) => k.key === key) || { min: -1, max: 1, step: 0.02, fmt: (v) => v.toFixed(2), label: key };
function buildLabPanel() {
  if (!labPanelEl) return;
  const c = LAB_CONTACTS[LAB.idx];
  const sliders = c.keys.map((key) => { const k = labKnob(key);
    return `<label class="lab-row"><span>${k.label}</span><input type="range" data-key="${key}" min="${k.min}" max="${k.max}" step="${k.step}" value="${TUNE[key]}"><b id="labv-${key}">${k.fmt(TUNE[key])}</b></label>`;
  }).join('') || '<div class="lab-none">— no spacing knobs for this pose —</div>';
  labPanelEl.innerHTML = `
    <div class="lab-head"><span>🥋 CONTACT LAB</span><button id="lab-exit" aria-label="exit">✕</button></div>
    <div class="lab-sel"><button id="lab-prev">◀</button><span id="lab-name">${LAB.idx + 1}/${LAB_CONTACTS.length} · ${c.name}</span><button id="lab-next">▶</button></div>
    <div class="lab-sliders">${sliders}</div>
    <div class="lab-actrow"><button id="lab-save">Save</button><button id="lab-copy">Copy values</button><button id="lab-reset">Reset</button></div>
    <div class="lab-hint">drag rotate · pinch / scroll zoom</div>`;
  labPanelEl.classList.remove('hidden');
  labPanelEl.querySelector('#lab-prev').onclick = () => { LAB.idx = (LAB.idx + LAB_CONTACTS.length - 1) % LAB_CONTACTS.length; buildLabPanel(); };
  labPanelEl.querySelector('#lab-next').onclick = () => { LAB.idx = (LAB.idx + 1) % LAB_CONTACTS.length; buildLabPanel(); };
  labPanelEl.querySelector('#lab-exit').onclick = exitLab;
  labPanelEl.querySelectorAll('input[type=range]').forEach((inp) => inp.addEventListener('input', () => {
    const key = inp.dataset.key; TUNE[key] = parseFloat(inp.value);
    const v = labPanelEl.querySelector('#labv-' + key); if (v) v.textContent = labKnob(key).fmt(TUNE[key]);
  }));
  const saveBtn = labPanelEl.querySelector('#lab-save');
  saveBtn.onclick = () => { try { localStorage.setItem(TUNE_STORE_KEY, dbgTuneJSON()); saveBtn.textContent = '✓ Saved'; } catch (e) { saveBtn.textContent = 'failed'; } setTimeout(() => { saveBtn.textContent = 'Save'; }, 1200); };
  const copyBtn = labPanelEl.querySelector('#lab-copy');
  copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(dbgTuneJSON()); copyBtn.textContent = '✓ Copied'; } catch (e) { copyBtn.textContent = 'failed'; } setTimeout(() => { copyBtn.textContent = 'Copy values'; }, 1200); };
  labPanelEl.querySelector('#lab-reset').onclick = () => { for (const key of c.keys) TUNE[key] = TUNE_DEFAULTS[key]; buildLabPanel(); };
}
function enterLab() {
  if (!game.all.length || LAB.on) return;
  LAB.on = true; game.lab = true; LAB.wasInGame = gameStarted;
  LAB.A = game.teamA[6] || game.teamA[0]; // a red carrier
  LAB.B = game.teamB[6] || game.teamB[0]; // a blue defender
  clearRagdolls();
  for (const ch of game.all) { ch.ragdolling = false; ch.group.visible = (ch === LAB.A || ch === LAB.B); if (ch.nameTag) ch.nameTag.visible = false; ch.vel.set(0, 0, 0); ch.speed = 0; ch.oneShotT = 0; }
  LAB.A.heading = 0; LAB.A.group.position.set(0, 0, 0);
  game.battle.val = 0.5;
  document.body.classList.add('lab-mode');
  if (startMenuEl) startMenuEl.classList.add('hidden');
  hideFieldChrome();
  dbgCam.target.set(0, 1.2, 0.3); dbgCam.az = 0.7; dbgCam.el = 0.22; dbgCam.dist = 4.8; dbgCam.follow = false;
  camera.fov = 40; camera.updateProjectionMatrix();
  buildLabPanel();
  startLoop(); // ensure the render loop is running (entered from the menu)
}
function exitLab() {
  if (!LAB.on) return;
  LAB.on = false; game.lab = false;
  if (labPanelEl) labPanelEl.classList.add('hidden');
  document.body.classList.remove('lab-mode');
  for (const ch of game.all) { ch.group.visible = true; if (ch.nameTag) ch.nameTag.visible = true; }
  if (LAB.wasInGame) { enterReset(true); } // resume the game (re-line-up)
  else { startGame(); }                     // came from the start menu — kick off a real game
}
function updateLab(dt) {
  const c = LAB_CONTACTS[LAB.idx], A = LAB.A, B = LAB.B;
  if (!A || !B) return;
  game.battle.val = 0.5;
  A.group.position.set(0, 0, 0); A.heading = 0;
  c.place(A, B);
  c.apply(A, B, dt);
  groundClamp(A); groundClamp(B);
  if (ball.mesh && A.handBone) { A.handBone.updateWorldMatrix(true, false); A.handBone.getWorldPosition(_hips); ball.mesh.position.set(_hips.x, Math.max(0.9, _hips.y), _hips.z); ball.mesh.rotation.set(0, A.heading, 0.35); ball.mesh.visible = true; }
  _labMid.set((A.group.position.x + B.group.position.x) / 2, 1.1, (A.group.position.z + B.group.position.z) / 2);
  dbgCam.target.lerp(_labMid, Math.min(1, dt * 4));
}
// Debug: rescale every player's visual model and re-seat it on the turf. Called when
// the Player size knob changes (the collider radii are separate TUNE knobs).
function applyPlayerSize() {
  const m = TUNE.playerSize;
  for (const ch of game.all) {
    if (!ch.model) continue;
    const isDef = ch.team === 'def';
    const base = Number.isFinite(ch.mScale) ? ch.mScale : (isDef ? DEF_SCALE : SCALE);
    const gy = Number.isFinite(ch.mGroundY) ? ch.mGroundY : (isDef ? DEF_GROUND_Y : GROUND_Y);
    ch.model.scale.setScalar(base * m);
    ch.model.position.y = gy * m; // keep the feet on the ground
  }
}
// Swap the player team's model to/from the alternate (TUNE.altModel). Same rig, so
// it's a full rebuild of both teams (cheap) preserving score/clock/possession; the
// shared animation clips drive the new mesh by bone name. Idempotent — only rebuilds
// when the choice actually changed (so opening the panel doesn't respawn everyone).
let _appliedModelIdx = 0;
async function applyModelChoice() {
  const idx = () => THREE.MathUtils.clamp(TUNE.altModel | 0, 0, Math.max(0, PLAYER_MODELS.length - 1));
  const want = idx();
  if (want === _appliedModelIdx) return; // no change
  await ensurePlayerModel(want);          // lazy-download the model the first time it's picked
  if (idx() !== want) return;             // selection changed again during the load
  _appliedModelIdx = want;
  if (!game.all || !game.all.length) return; // not spawned yet (initial spawn already honors the flag)
  // Tear down the current player models (field AND bench) so the sideline swaps too.
  for (const ch of game.all) {
    if (ch.ragdoll) { try { ch.ragdoll.dispose(); } catch (e) { /* ignore */ } }
    if (ch.group && ch.group.parent) ch.group.parent.remove(ch.group);
  }
  for (const ch of (game.bench || [])) { if (ch.group && ch.group.parent) ch.group.parent.remove(ch.group); }
  clearRagdolls();
  spawnTeams();              // rebuilds game.teamA/teamB/all + setupPossession (uses the new flag)
  spawnBench();              // rebuild the sideline with the new model too
  if (TUNE.playerSize !== 1) applyPlayerSize();
  try { applyLook(); } catch (e) { /* ignore */ }
  try { buildPortraits(); } catch (e) { /* ignore */ } // refresh the post-play card art
  enterReset(true);          // place everyone on the field, lined up
}
function updateDebugPanel() {
  if (!dbgPanelOn || !dbgPanelEl) return;
  const tele = dbgPanelEl.querySelector('.dbg-tele');
  try { tele.textContent = balanceSummary().text + `\nstate:${game.state}`; } catch (e) { /* ignore */ }
  const rep = dbgPanelEl.querySelector('#dbg-statrep'); // live balance report (Stats tab)
  if (rep && rep.offsetParent !== null) { try { rep.textContent = dbgBalanceReport(); } catch (e) { /* ignore */ } }
}
buildDebugPanel(); // wire the sliders/buttons (panel starts hidden)
{ const bb = document.getElementById('build-badge'); if (bb) bb.addEventListener('click', () => toggleDebugPanel()); }
// Mobile/touch entry to debug mode: add ?debug to the URL and a tappable gear
// button appears (there's no keyboard for the ` shortcut on a phone). Hidden for
// normal players. The version-badge tap + ` key still work too.
{
  const loc = typeof location !== 'undefined' ? location : null;
  if (loc && /\bdebug\b/.test(loc.search + ' ' + loc.hash)) {
    const fab = document.getElementById('dbg-fab');
    if (fab) { fab.classList.remove('hidden'); fab.addEventListener('click', () => toggleDebugPanel()); }
  }
}
// ---- Debug AI / hitbox overlay: collider rings, velocity + assignment vectors,
// and projected state labels. Drawn from the TUNE.viz* toggles (Viz tab). ----------
let dbgVizLines = null; let _vizPos = null, _vizCol = null; const _vizLabelDivs = [];
const VIZ_MAX = 7000; const _vizV = new THREE.Vector3();
function ensureViz() {
  if (dbgVizLines) return;
  const g = new THREE.BufferGeometry();
  _vizPos = new Float32Array(VIZ_MAX * 3); _vizCol = new Float32Array(VIZ_MAX * 3);
  g.setAttribute('position', new THREE.BufferAttribute(_vizPos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(_vizCol, 3));
  const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false });
  dbgVizLines = new THREE.LineSegments(g, m); dbgVizLines.frustumCulled = false; dbgVizLines.renderOrder = 999;
  scene.add(dbgVizLines);
}
function updateDbgViz() {
  const logEl = document.getElementById('dbglog'); if (logEl) logEl.classList.toggle('hidden', !TUNE.vizLog && !TUNE.catchLog); // event-log visibility (event log OR catch log)
  const drawL = TUNE.vizColliders || TUNE.vizVectors, lbl = TUNE.vizLabels;
  ensureViz();
  const labelsEl = document.getElementById('dbgviz-labels');
  if (!drawL && !lbl) { dbgVizLines.visible = false; if (labelsEl) labelsEl.style.display = 'none'; return; }
  dbgVizLines.visible = !!drawL;
  let n = 0; const P = _vizPos, C = _vizCol;
  const seg = (x1, y1, z1, x2, y2, z2, r, g, b) => { if (n + 2 > VIZ_MAX) return; let i = n * 3; P[i] = x1; P[i + 1] = y1; P[i + 2] = z1; C[i] = r; C[i + 1] = g; C[i + 2] = b; n++; i = n * 3; P[i] = x2; P[i + 1] = y2; P[i + 2] = z2; C[i] = r; C[i + 1] = g; C[i + 2] = b; n++; };
  const circ = (cx, cz, rad, y, r, g, b) => { const S = 22; for (let i = 0; i < S; i++) { const a0 = i / S * 6.2832, a1 = (i + 1) / S * 6.2832; seg(cx + Math.cos(a0) * rad, y, cz + Math.sin(a0) * rad, cx + Math.cos(a1) * rad, y, cz + Math.sin(a1) * rad, r, g, b); } };
  const cyl = (cx, cz, rad, h, r, g, b) => { circ(cx, cz, rad, 0.06, r, g, b); circ(cx, cz, rad, h, r, g, b); for (let i = 0; i < 4; i++) { const a = i / 4 * 6.2832; seg(cx + Math.cos(a) * rad, 0.06, cz + Math.sin(a) * rad, cx + Math.cos(a) * rad, h, cz + Math.sin(a) * rad, r, g, b); } }; // wireframe cylinder (3D collider)
  if (drawL) for (const ch of game.all) {
    if (ch.ragdolling) continue; const p = ch.group.position; const def = ch.team === 'def';
    if (TUNE.vizColliders) {
      cyl(p.x, p.z, colliderR(), colliderH(), 0.6, 0.6, 0.6);                   // body capsule (auto-fit to model)
      if (ch === game.carrier) circ(p.x, p.z, colliderR() + 0.12, 0.07, 1, 0.9, 0.2); // carrier highlight
      if (def) circ(p.x, p.z, TUNE.tackleReach, 0.05, 1, 0.25, 0.25);           // tackle reach (ground, red)
      else if (ch.role === 'WR' || ch.role === 'RB' || ch.role === 'TE') cyl(p.x, p.z, TUNE.catchReach, vReach(ch), 0.3, 0.8, 1); // catch volume (3D cylinder up to vertical reach, cyan)
    }
    if (TUNE.vizVectors) {
      if (ch.speed > 0.2) seg(p.x, 0.1, p.z, p.x + ch.vel.x * 0.28, 0.1, p.z + ch.vel.z * 0.28, 0.3, 1, 0.4); // velocity (green)
      let t = null, col = null;
      if (ch.engaging) { t = ch.engaging.group.position; col = [1, 0.6, 0.1]; }
      else if (ch.blockTarget) { t = ch.blockTarget.group.position; col = [1, 0.85, 0.2]; }
      else if (def && ch.covers >= 0 && game.receivers && game.receivers[ch.covers]) { t = game.receivers[ch.covers].group.position; col = [1, 0.3, 0.3]; }
      if (t) seg(p.x, 0.12, p.z, t.x, 0.12, t.z, col[0], col[1], col[2]);
    }
  }
  const gg = dbgVizLines.geometry; gg.setDrawRange(0, n); gg.attributes.position.needsUpdate = true; gg.attributes.color.needsUpdate = true; gg.boundingSphere = null;
  if (!labelsEl) return;
  if (!lbl) { labelsEl.style.display = 'none'; return; }
  labelsEl.style.display = 'block';
  const W = window.innerWidth, H = window.innerHeight; let li = 0;
  for (const ch of game.all) {
    if (ch.ragdolling) continue;
    let div = _vizLabelDivs[li]; if (!div) { div = document.createElement('div'); div.className = 'vl'; labelsEl.appendChild(div); _vizLabelDivs[li] = div; }
    _vizV.set(ch.group.position.x, ch.group.position.y + 2.2, ch.group.position.z); _vizV.project(camera);
    if (_vizV.z > 1 || _vizV.z < -1) { div.style.display = 'none'; }
    else { div.style.display = 'block'; div.style.left = ((_vizV.x * 0.5 + 0.5) * W) + 'px'; div.style.top = ((-_vizV.y * 0.5 + 0.5) * H) + 'px'; div.textContent = (ch === game.carrier ? '★' : '') + (ch.role || '?') + '·' + (ch.job || '-'); div.style.color = ch.team === 'def' ? '#9ec0ff' : '#ffb0b0'; }
    li++;
  }
  for (; li < _vizLabelDivs.length; li++) _vizLabelDivs[li].style.display = 'none';
}
function animate() {
  updateFps(); // true frame rate (independent of the sim dt cap)
  updateDbg(); // balance telemetry overlay (toggle with I)
  updateDebugPanel(); // live debug-knob panel (toggle with ` or the version badge)
  syncPauseBtn(); // show the pause/menu button only while a game is in progress
  applyUIState(); // publish the UI phase for progressive-disclosure HUD rules
  const realDt = Math.min(clock.getDelta(), 0.05);
  // Contact Lab: only the two posed players + an orbit camera; no sim, no gameplay.
  if (game.lab) {
    updateLab(realDt);
    applyDebugCam();
    renderer.render(scene, camera);
    if (dbgCam.shot) { dbgCam.shot = false; saveCanvasPNG(); }
    requestAnimationFrame(animate);
    return;
  }
  // Free debug camera: the sim is frozen; just scrub the replay buffer (rewind) and
  // drive the orbit camera, then render. Nothing in the game advances.
  if (dbgCam.on) {
    if (dbgCam.step) { simStep(1 / 60); dbgCam.step = false; } // frame-step one tick
    else if (dbgCam.scrub >= 0 && game.replay.frames.length) applyReplayFrame(Math.min(dbgCam.scrub, dbgScrubMax()));
    applyDebugCam();
    updateDbgViz();
    renderer.render(scene, camera);
    if (dbgCam.shot) { dbgCam.shot = false; saveCanvasPNG(); }
    requestAnimationFrame(animate);
    return;
  }
  // Pre-game cinematic: dancers + broadcast camera, no sim. Skippable.
  if (game.cinematic) {
    updateCinematic(realDt);
    renderer.render(scene, camera);
    if (dbgCam.shot) { dbgCam.shot = false; saveCanvasPNG(); }
    requestAnimationFrame(animate);
    return;
  }
  simStep(realDt);
  updateCamera(realDt);
  updateDbgViz();
  renderer.render(scene, camera);
  if (dbgCam.shot) { dbgCam.shot = false; saveCanvasPNG(); } // debug screenshot (clean 3D, no HUD)
  requestAnimationFrame(animate);
}
function simStep(realDt) {
  if (!bodyMeasured && game.all.length) measureBody(); // fit colliders to the posed model (once)
  // Bullet-time scales the SIM (movement, animation, ragdolls — the slow-mo
  // tackles) while the camera/shake run on real time and stay snappy.
  const tsf = timeScale.update(realDt); game.tsFactor = tsf; // expose the slow-mo factor (used by replay playback)
  const dt = realDt * tsf;
  if (slowmoEl) slowmoEl.style.opacity = timeScale.grade.toFixed(3); // red-tint/vignette tracks the slow-mo depth
  if (game.paused) return; // soft-pause: sim frozen; animate() still renders the held frame under the menu
  updateCut(realDt); // broadcast dip between plays (runs the reset at the dark peak)
  updatePlay(dt);
  updateFlyingHelmets(dt); // popped helmets tumble every frame (slows with bullet-time)
  updateFenceBlood(realDt); // blood runs down the fence (real-time, ignores slow-mo)
  updateBench(realDt);     // sideline reserves pace + emote (real-time, ignores slow-mo)
  updateCheer(realDt);     // sideline cheer squad dances through the game (real-time)
  updateCelebFx(realDt);   // touchdown fireworks + sweeping spotlights
  driveTowerGlows(clock.elapsedTime); // floodlight bloom shimmer
  updateCageGates(realDt); // cage gates swing open between plays

  // Advance ragdoll physics by THIS frame's (slow-mo-scaled) dt — substepped,
  // every frame — so the bodies move smoothly in slow motion instead of in
  // visible 1/60 chunks. Then the rigid bodies drive the skinned bones.
  if (physics && (anyRagdollActive() || tornRagdolls.length)) {
    physics.step(Math.min(dt, 1 / 30), (subDt) => {
      for (const ch of game.all)
        if (ch.ragdolling && ch.ragdoll && ch.ragdoll.active) ch.ragdoll.applyLimits(subDt);
      for (const rd of tornRagdolls) if (rd.active) rd.applyLimits(subDt); // torn-in-half body halves
    });
    for (const ch of game.all)
      if (ch.ragdolling && ch.ragdoll && ch.ragdoll.active) ch.ragdoll.drive();
    for (const rd of tornRagdolls) if (rd.active) rd.drive();
  }

  updateAmbience(realDt);
}
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- Start menu: the matchup + both rosters, gates the kickoff ----------------
const startMenuEl = document.getElementById('startmenu');
// One team's side of the VS screen: big italic name, team OVR, top-3 stars, a giant
// faded logo watermark. side = 'home' | 'away'.
function teamSideHTML(side) {
  const t = TEAMS[side];
  const ranked = [...t.players].sort((a, b) => ovr(b.r) - ovr(a.r));
  const tovr = Math.round(t.players.reduce((s, p) => s + ovr(p.r), 0) / t.players.length);
  const stars = ranked.slice(0, 3).map((p) =>
    `<li><b>${p.pos}</b><span>${p.name}</span><i>${ovr(p.r)}</i></li>`).join('');
  const logo = t.logo ? `<img class="sm-logo" src="${t.logo}" alt="" />` : '';
  return `<div class="sm-side sm-${side}" style="--tc:${t.color}">
    ${logo}
    <div class="sm-sideinner">
      <div class="sm-tag">${side === 'home' ? '◤ HOME' : 'AWAY ◢'}</div>
      <div class="sm-tname">${t.name}</div>
      <div class="sm-ovr"><span>OVR</span><b>${tovr}</b></div>
      <ul class="sm-stars">${stars}</ul>
    </div>
  </div>`;
}
function buildStartMenu() {
  if (!startMenuEl) return;
  startMenuEl.style.setProperty('--home', TEAMS.home.color);
  startMenuEl.style.setProperty('--away', TEAMS.away.color);
  const diffBtns = ['rookie', 'pro', 'allpro'].map((k) =>
    `<button class="sm-diff${game.diff === k ? ' on' : ''}" data-diff="${k}">${DIFF[k].label}</button>`).join('');
  startMenuEl.innerHTML = `
    <div class="sm-bg"></div>
    <div class="sm-seam"></div>
    <div class="sm-grit"></div>
    <div class="sm-content">
      <div class="sm-head">
        <div class="sm-kicker">▰&nbsp; 7-ON-7 ARCADE FOOTBALL &nbsp;▰</div>
        <h1 class="sm-title">REAPERS <span>FOOTBALL</span></h1>
      </div>
      <div class="sm-versus">
        ${teamSideHTML('home')}
        <div class="sm-vsbadge"><span>VS</span></div>
        ${teamSideHTML('away')}
      </div>
      <div class="sm-foot">
        <div class="sm-diffwrap">
          <div class="sm-difflabel">DIFFICULTY</div>
          <div class="sm-diffs">${diffBtns}</div>
        </div>
        <button id="sm-vol" class="sm-vol" aria-label="Audio settings">🔊</button>
        <button id="sm-settings" class="sm-iconbtn" aria-label="Settings">⚙</button>
        <div class="sm-startwrap">
          <button id="sm-start" class="sm-start"><span>KICK&nbsp;OFF</span><span class="sm-sub">Exhibition · one game</span><span class="sm-arrow">▸</span></button>
          <button id="sm-gauntlet" class="sm-start sm-gauntlet"><span>GAUNTLET</span><span class="sm-sub">3 teams · win or restart</span></button>
        </div>
      </div>
    </div>`;
  startMenuEl.querySelectorAll('.sm-diff').forEach((el) => el.addEventListener('click', () => {
    setSetting('diff', el.dataset.diff); // persists; game.diff is kept in step
    startMenuEl.querySelectorAll('.sm-diff').forEach((b) => b.classList.toggle('on', b === el));
  }));
  const smVol = document.getElementById('sm-vol');
  if (smVol) smVol.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleVolPanel(); });
  const smSettings = document.getElementById('sm-settings');
  if (smSettings) smSettings.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openSettings(); });
  syncVolUI();
  const btn = document.getElementById('sm-start');
  if (btn) btn.addEventListener('click', startGame, { once: true });
  const gbtn = document.getElementById('sm-gauntlet');
  if (gbtn) gbtn.addEventListener('click', startGauntlet, { once: true });
}
let gameStarted = false;
let _loopStarted = false;
function startLoop() { if (_loopStarted) return; _loopStarted = true; animate(); } // single rAF owner

// Background music: full on the title menu, ducked under live play. Browsers
// block audio until a gesture, so the bed kicks in on the first tap/key and we
// ride the gain down at kickoff rather than restarting the track.
const MUSIC_URL = 'assets/music/fourth_down_riot.mp3';
const MENU_MUSIC_GAIN = 0.4;
const GAME_MUSIC_GAIN = 0.12;
let _musicPrimed = false;
function primeMusic() {
  if (_musicPrimed) return; _musicPrimed = true;
  audio.unlock();
  // If a game is already underway (e.g. ?lab / instant start) go straight to the quiet bed.
  audio.playMusic(MUSIC_URL, { gain: gameStarted ? GAME_MUSIC_GAIN : MENU_MUSIC_GAIN });
}
['pointerdown', 'touchstart', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, primeMusic, { once: true, capture: true }));

function startGame() {
  if (gameStarted) return; gameStarted = true;
  audio.unlock();
  // Bring the music bed down to the gameplay level (or start it there if no
  // gesture has primed it yet, e.g. an instant start with no menu).
  if (_musicPrimed) audio.setMusicGain(GAME_MUSIC_GAIN);
  else { _musicPrimed = true; audio.playMusic(MUSIC_URL, { gain: GAME_MUSIC_GAIN }); }
  if (startMenuEl) startMenuEl.classList.add('hidden');
  relabelScoreboard(); // label the scoreboard with the two clubs (teamA/REAPERS = the user = scoreOff)
  updateGauntletHud();
  startCinematic(); // pregame dancer cinematic; hands off to newPlay() when it ends/skips
  startLoop();
}
loadAssets().then(async () => {
  // If a non-default player model was saved, download it before the first spawn so
  // teams come up wearing it (otherwise the default loads instantly and it'd swap in late).
  const savedIdx = THREE.MathUtils.clamp(TUNE.altModel | 0, 0, Math.max(0, PLAYER_MODELS.length - 1));
  if (savedIdx > 0) { try { await ensurePlayerModel(savedIdx); } catch (e) { /* fall back to default */ } }
  spawnTeams(); spawnBench(); spawnCheer(); makeBall();
  _appliedModelIdx = savedIdx; // initial spawn honored the saved index
  ballFlame = new FlameEmitter(48); playerFlame = new FlameEmitter(48); // ON FIRE / turbo flames
  game.firstDown = game.los + FIRST_DOWN_YDS;
  buildPortraits(); // pre-render the posed card art for both teams
  if (TUNE.playerSize !== 1) applyPlayerSize(); // honor a saved player-size override
  applyLighting(); applyLook(); applyFog(); applyAudio(); // honor saved Look/Lighting/World/Audio knobs
  prewarmCelebShaders(); // compile celebration shaders now (avoids the first-celebration FPS dip)
  loadingEl.classList.add('hidden');
  setupVolumeUI();
  loadSettings(); // player-facing settings (Phase 4) — apply before the first render
  buildStartMenu();
  // Boot straight into the Contact Lab with ?lab; otherwise the matchup menu gates the kickoff.
  const wantLab = (typeof location !== 'undefined') && /\blab\b/.test(location.search + ' ' + location.hash);
  if (wantLab) { enterLab(); }
  else if (startMenuEl) startMenuEl.classList.remove('hidden'); else startGame();
}).catch((err) => { console.error(err); loadingText.textContent = 'Failed to load assets. Check the console.'; });






























