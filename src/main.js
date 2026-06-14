import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { PhysicsWorld, TackleRagdoll, pickVariant } from './ragdoll.js';
import { BUILD } from './build.js';
import { AudioManager } from './audio.js';

const audio = new AudioManager();

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

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fc7ff);
scene.fog = new THREE.Fog(0x8fc7ff, 90, 280);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 7, -12);

scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x3a6b3a, 0.95));
const sun = new THREE.DirectionalLight(0xffffff, 2.1);
sun.position.set(40, 70, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 250;
const sh = 70;
sun.shadow.camera.left = -sh; sun.shadow.camera.right = sh;
sun.shadow.camera.top = sh; sun.shadow.camera.bottom = -sh;
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

// ===========================================================================
// Field  (1 unit = 1 yard, long axis = Z; offense attacks +Z)
// ===========================================================================
const FIELD_W = 53.3, HALF_W = FIELD_W / 2;
const FIELD_L = 120, HALF_L = FIELD_L / 2;
const GOAL_Z = HALF_L - 10;          // +50: offense's target goal line
const OWN_GOAL_Z = -(HALF_L - 10);   // -50

function buildField() {
  const field = new THREE.Group();
  const surround = new THREE.Mesh(new THREE.PlaneGeometry(420, 420),
    new THREE.MeshStandardMaterial({ color: 0x2e7d32 }));
  surround.rotation.x = -Math.PI / 2; surround.position.y = -0.02;
  surround.receiveShadow = true; field.add(surround);

  const stripes = 12, sl = FIELD_L / stripes;
  for (let i = 0; i < stripes; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_W, sl),
      new THREE.MeshStandardMaterial({ color: i % 2 ? 0x2f6f33 : 0x357a38 }));
    m.rotation.x = -Math.PI / 2; m.position.set(0, 0, -HALF_L + sl * (i + 0.5));
    m.receiveShadow = true; field.add(m);
  }
  for (const dir of [-1, 1]) {
    const ez = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_W, 10),
      new THREE.MeshStandardMaterial({ color: dir < 0 ? 0x1f5fa8 : 0xa83232 }));
    ez.rotation.x = -Math.PI / 2; ez.position.set(0, 0.01, dir * (HALF_L - 5));
    ez.receiveShadow = true; field.add(ez);
  }
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const line = (w, l, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat);
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.02, z); field.add(m);
  };
  line(0.4, FIELD_L, -HALF_W, 0); line(0.4, FIELD_L, HALF_W, 0);
  line(FIELD_W, 0.4, 0, -HALF_L); line(FIELD_W, 0.4, 0, HALF_L);
  line(FIELD_W, 0.5, 0, -GOAL_Z); line(FIELD_W, 0.5, 0, GOAL_Z);
  for (let y = -GOAL_Z + 5; y < GOAL_Z; y += 5) line(FIELD_W, 0.3, 0, y);
  line(FIELD_W, 0.5, 0, 0);
  for (let y = -GOAL_Z + 1; y < GOAL_Z; y += 1)
    for (const hx of [-6, 6]) line(0.9, 0.18, hx, y);
  field.add(goalPost(GOAL_Z + 0.2), goalPost(-GOAL_Z - 0.2));
  return field;
}
function goalPost(z) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffd54a, metalness: 0.4, roughness: 0.4 });
  const tube = (len, x, y) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, len, 12), mat);
    m.castShadow = true; m.position.set(x, y, 0); return m;
  };
  const cross = tube(6.1, 0, 3); cross.rotation.z = Math.PI / 2;
  g.add(tube(3, 0, 1.5), cross, tube(6, -3, 6), tube(6, 3, 6));
  g.position.z = z; return g;
}
scene.add(buildField());

function makeRing(color) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.95, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.03; m.visible = false;
  scene.add(m); return m;
}
const selRing = makeRing(0xffd54a);
const ctrlRing = makeRing(0xffffff);

// Broadcast lines: line of scrimmage (blue) + first-down (yellow). Each is a
// bright stripe across the field flanked by tall sideline posts (down markers)
// so it reads clearly from the chase cam.
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
const losLine = makeFieldLine(0x2f6bff);
const firstDownLine = makeFieldLine(0xffe14a);

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
  for (let i = 0; i < 40; i++) {
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

// ===========================================================================
// Assets + character factory
// ===========================================================================
const loader = new GLTFLoader();
const HEAD_SCALE = 1.6; // Blitz-style oversized heads (applied to both teams)
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const loadGLB = (u) => new Promise((res, rej) => loader.load(u, res, undefined, rej));

let charTemplate, defTemplate, helmetOffTemplate, helmetDefTemplate;
let idleClip, walkClip, runClip, sprintClip, jukeClip, catchClip, tackleClip;
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
  try { physics = await PhysicsWorld.create(); }
  catch (e) { console.warn('Physics unavailable — tackles will be instant', e); }
  charTemplate = charGltf.scene;
  defTemplate = defGltf ? defGltf.scene : null;
  // Team helmets (static meshes attached to each head).
  try { helmetOffTemplate = (await loadGLB('assets/helmet_off.glb')).scene; } catch (e) { console.warn('off helmet missing', e); }
  try { helmetDefTemplate = (await loadGLB('assets/helmet_def.glb')).scene; } catch (e) { console.warn('def helmet missing', e); }
  const byName = {};
  for (const c of animGltf.animations) byName[c.name] = c;
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
  // All clips are authored on THIS rig, so they pose cleanly (no retargeting).
  idleClip = inPlace(byName['Idle_11'] || charGltf.animations[0]); // breathing idle
  walkClip = inPlace(byName['Walking']); runClip = inPlace(byName['Running']);
  sprintClip = inPlace(byName['RunFast'] || byName['Running']);    // turbo sprint
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
  const raw = measureBoneSpan(charTemplate);
  SCALE = 1.8 / raw.span;
  GROUND_Y = -(raw.lo * SCALE - 0.05);
  if (defTemplate) {
    const dr = measureBoneSpan(defTemplate);
    DEF_SCALE = 1.8 / dr.span;
    DEF_GROUND_Y = -(dr.lo * DEF_SCALE - 0.05);
  } else { DEF_SCALE = SCALE; DEF_GROUND_Y = GROUND_Y; }
}

function makeCharacter(team) {
  // Offense = original character; defense = its own blue rigged character (or a
  // blue-tinted fallback if that model didn't load). Each keeps its own skin.
  const isDef = team === 'def';
  // Both teams render from the proven offense model (its head + helmet attach
  // reliably); the defense is strongly tinted blue. The separate blue GLB looked
  // headless at runtime (its cloned Head bone wasn't picked up), so we don't use it.
  const model = cloneSkeleton(charTemplate);
  model.scale.multiplyScalar(SCALE);
  model.position.y = GROUND_Y;
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.frustumCulled = false;
      o.material = o.material.clone();
      if (isDef) { // away "uniform": clear blue body
        o.material.color.setHex(0x5f8dff);
        o.material.emissive = new THREE.Color(0x1a3a8c);
        o.material.emissiveIntensity = 0.6;
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
  let handBone = null, upperArm = null, foreArm = null, leftArm = null, leftForeArm = null;
  let headBone = null, headEnd = null;
  const restPose = [];
  model.traverse((o) => {
    if (o.isBone) {
      if (o.name === 'RightHand') handBone = o;
      if (o.name === 'RightArm') upperArm = o;
      if (o.name === 'RightForeArm') foreArm = o;
      if (o.name === 'LeftArm') leftArm = o;
      if (o.name === 'LeftForeArm') leftForeArm = o;
      if (o.name === 'Head') headBone = o;
      if (o.name === 'head_end') headEnd = o;
      restPose.push([o, o.position.clone(), o.quaternion.clone()]);
    }
  });
  const upperArmRest = upperArm ? upperArm.quaternion.clone() : null;
  const foreArmRest = foreArm ? foreArm.quaternion.clone() : null;
  const leftArmRest = leftArm ? leftArm.quaternion.clone() : null;
  const leftForeArmRest = leftForeArm ? leftForeArm.quaternion.clone() : null;
  const mixer = new THREE.AnimationMixer(model);
  const mk = (clip) => {
    const a = mixer.clipAction(clip);
    a.setLoop(THREE.LoopRepeat, Infinity); a.enabled = true;
    a.setEffectiveWeight(0); a.play(); return a;
  };
  const actions = { idle: mk(idleClip), walk: mk(walkClip), run: mk(runClip), sprint: mk(sprintClip) };
  const oneShot = (clip) => {
    const a = mixer.clipAction(clip);
    a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true;
    a.enabled = true; a.setEffectiveWeight(0); return a;
  };
  if (jukeClip) actions.juke = oneShot(jukeClip);
  if (catchClip) actions.catch = oneShot(catchClip);
  if (tackleClip) actions.tackle = oneShot(tackleClip);
  actions.idle.setEffectiveWeight(1);

  // Helmet: a scaled clone of the team helmet PARENTED to the Head bone, so it
  // is rigidly attached (can't detach, follows head turns + ragdoll tumbles).
  // Local transform compensates for the bone's tiny world scale.
  let helmet = null;
  // Both teams wear the red helmet head model (helmetOffTemplate); the blue
  // helmet is kept only as a fallback if the red one fails to load.
  const helmetScene = helmetOffTemplate || helmetDefTemplate;
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
  }

  return {
    group, model, mixer, actions, handBone, restPose, current: 'idle', active: actions.idle,
    upperArm, foreArm, upperArmRest, foreArmRest,
    leftArm, leftForeArm, leftArmRest, leftForeArmRest, throwAnimT: 0, throwLaunch: 0.3,
    armPose: null, armPoseT: 0, armPoseDur: 0, armPoseTarget: null,
    headBone, headEnd, helmet,
    team, role: 'WR', job: 'idle', heading: 0,
    vel: new THREE.Vector3(), speed: 0, baseSpeed: 8.4, turbo: false,
    home: new THREE.Vector3(), desired: { x: 0, z: 0 },
    route: null, wp: 0, cutTimer: 0, jukeTimer: 0, jukeCd: 0, oneShotT: 0, spinT: 0, diveT: 0, recoverT: 0, engaged: false,
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
const STATE = { PRESNAP: 'presnap', LIVE: 'live', AIR: 'air', RUN: 'run', RETURN: 'return', TACKLE: 'tackle', BATTLE: 'battle', LOOSE: 'loose', DEAD: 'dead' };
// NFL Blitz rules: 30 yards for a first down, drives start on your own 20,
// four downs (no punts/FGs), short running quarters and a delay-of-game clock.
const DRIVE_START = -30, FIRST_DOWN_YDS = 30;
const QUARTER_LEN = 90;  // seconds of game clock per quarter (arcade-fast)
const PLAY_CLOCK = 15;   // delay-of-game countdown before the snap
const game = {
  state: STATE.PRESNAP,
  offense: [], defense: [], all: [],
  qb: null, controlled: null, carrier: null,
  selected: 5, receivers: [],
  los: DRIVE_START, firstDown: 0, down: 1,
  scoreOff: 0, scoreDef: 0,
  quarter: 1, gameClock: QUARTER_LEN, snapClock: PLAY_CLOCK, gameOver: false,
  deadTimer: 0,
  tackleTimer: 0, tackleSpotZ: 0, // ragdoll tackle: hold while physics plays the fall
  returnActive: false, returner: null, // interception runback (defense carries)
  fumbleLost: false,                    // a hit popped the ball loose to the defense
  looseTimer: 0,                        // live-fumble scramble countdown
  playIndex: 0, choosing: false,        // selected play / play-select screen open
  // Possession: the player (red team) attacks +Z; the CPU (blue) attacks -Z.
  // dir = the current offense's attacking direction. When the CPU has the ball
  // you play DEFENSE (control the nearest defender).
  userOnOffense: true, dir: 1, cpuQBTimer: 0,
  // Blitz systems: draining turbo meter, ON FIRE after 3 straight TDs.
  turboMeter: 1, turboLock: false, onFire: false, fireCount: 0,
  playClock: 0, lastBreak: -10,
  battle: { val: 0.5, timer: 0, tackler: null, cd: 0, flash: 0 },
  throwCharge: 0, // hold the THROW button to charge tap=lob -> hold=bullet
  throwArmed: false, // a throw only arms on a fresh press in LIVE (not the snap press)
};
const THROW_CHARGE_MAX = 0.5; // seconds to a full bullet pass

const ball = {
  mesh: null, mode: 'carried', // 'carried' | 'flying' | 'secured' | 'rest'
  to: new THREE.Vector3(), targetRecv: null,
  // Projectile state while flying.
  vx: 0, vy: 0, vz: 0, g: 0, airTime: 0, flightTime: 1, startY: 1.2,
  spin: 0, spinRate: 0,
  // Catch: ball homes into the catcher's hands before the play resolves.
  catcher: null, secureT: 0, intercept: false, holder: null, intRolled: false,
  trail: [], trailHist: [], // glowing comet trail (sprite pool)
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
function makeBall() {
  // A bigger stretched ellipsoid (long axis = local +Z) so it noses along its arc.
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0x7a3b16, roughness: 0.7, metalness: 0.05 }));
  m.scale.z = 1.8; m.castShadow = true; scene.add(m); ball.mesh = m;
  // White stripe + laces so the spiral reads.
  const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.225, 0.022, 8, 20),
    new THREE.MeshStandardMaterial({ color: 0xf2ead6, roughness: 0.6 }));
  stripe.rotation.y = Math.PI / 2; stripe.position.z = 0.16; m.add(stripe);
  const lace = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.26),
    new THREE.MeshStandardMaterial({ color: 0xf2ead6, roughness: 0.6 }));
  lace.position.set(0, 0.2, 0); m.add(lace);
  const flame = new THREE.PointLight(0xff6622, 0, 7); // lit while ON FIRE
  m.add(flame); ball.flame = flame;
  // Glowing comet trail: a pool of additive sprites laid along recent positions.
  const tex = makeGlowTexture();
  for (let i = 0; i < 16; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: 0xffd27a, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0 }));
    s.visible = false; scene.add(s); ball.trail.push(s);
  }
}
function updateTrail(airborne) {
  if (!airborne) {
    if (ball.trailHist.length) { ball.trailHist.length = 0; for (const s of ball.trail) s.visible = false; }
    return;
  }
  ball.trailHist.unshift(ball.mesh.position.clone());
  if (ball.trailHist.length > ball.trail.length) ball.trailHist.pop();
  const col = game.onFire ? 0xff5522 : 0xffd27a;
  for (let i = 0; i < ball.trail.length; i++) {
    const s = ball.trail[i], h = ball.trailHist[i];
    if (!h) { s.visible = false; continue; }
    s.visible = true; s.position.copy(h);
    const f = 1 - i / ball.trail.length; // brightest/biggest near the ball
    s.material.opacity = f * 0.6;
    s.material.color.setHex(col);
    const sc = 0.45 + f * 0.85;
    s.scale.set(sc, sc, sc);
  }
}
function setFireVisual(on) {
  ball.flame.intensity = on ? 3 : 0;
  ball.mesh.material.emissive.setHex(on ? 0xff5500 : 0x000000);
  ball.mesh.material.emissiveIntensity = on ? 0.9 : 1;
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
    name: 'BOMBS', sub: 'Shots + RB check',
    route(e, sx, los) {
      const toMid = Math.sign(-sx) || 1, P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + game.dir * dz);
      if (e === 3) return [P(sx - 8, 1), P(sx - 13, 3)];          // RB swing/check
      if (e === 1) return [P(sx, 14), P(sx + toMid * 12, 34)];    // slot post
      return [P(sx, 16), P(sx, 42)];                              // outside go
    },
  },
  {
    name: 'SLANTS', sub: 'Quick slants + flat',
    route(e, sx, los) {
      const toMid = Math.sign(-sx) || 1, P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + game.dir * dz);
      if (e === 3) return [P(sx - 6, 0.5), P(sx - 14, 3)];        // RB flat
      return [P(sx + toMid * 6, 8), P(sx + toMid * 13, 15)];      // slants
    },
  },
  {
    name: 'MESH', sub: 'Crossers + swing',
    route(e, sx, los) {
      const toMid = Math.sign(-sx) || 1, P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + game.dir * dz);
      if (e === 3) return [P(sx - 8, 1), P(sx - 14, 4)];          // RB swing
      if (e === 1) return [P(sx, 12), P(sx, 9)];                  // slot sit/drag
      return [P(sx, 6), P(sx + toMid * 22, 11)];                  // crossers
    },
  },
  {
    name: 'FLOOD', sub: 'Sidelines + flat',
    route(e, sx, los) {
      const toSide = Math.sign(sx) || 1, toMid = Math.sign(-sx) || 1, P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + game.dir * dz);
      if (e === 3) return [P(sx - 6, 0.5), P(sx - 13, 3)];        // RB flat
      if (e === 0) return [P(sx, 14), P(sx + toSide * 8, 28)];    // corner
      if (e === 2) return [P(sx, 11), P(sx, 8)];                  // comeback
      return [P(sx + toMid * 4, 10), P(sx, 8)];                   // slot out/sit
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

// Two fixed 7-man rosters: teamA = the player's red team, teamB = the CPU's
// blue team. Each play, setupPossession() assigns offense/defense ROLES to
// whichever team has the ball, so the same AI drives either side.
function spawnTeams() {
  game.teamA = []; game.teamB = [];
  // Per-slot base speed/strength so positions feel distinct (OL/DL slower &
  // stronger; skill players faster). Slots line up with OFF_FORM/DEF_FORM.
  const SPD = [9.6, 7.8, 7.8, 9.5, 9.5, 9.4, 9.3];   // QB, OL, OL, WR, WR, WR, RB
  const STR = [0.9, 1.15, 1.15, 0.85, 0.85, 0.85, 0.95];
  for (let i = 0; i < 7; i++) {
    const a = makeCharacter('off'); a.baseSpeed = SPD[i]; a.strength = STR[i];
    const b = makeCharacter('def'); b.baseSpeed = SPD[i]; b.strength = STR[i] + 0.03;
    game.teamA.push(a); game.teamB.push(b);
  }
  game.all = [...game.teamA, ...game.teamB];
  setupPossession();
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
    if (f.elig >= 0) game.receivers[f.elig] = p;
  });
  cover.forEach((p, i) => {
    const f = DEF_FORM[i];
    p.role = f.role; p.job = f.job; p.align = f; p.deep = f.deep; p.covers = f.covers;
  });
  game.all = [...game.offense, ...game.defense];
}
// Direction-aware field references (the current offense attacks game.dir * +Z).
const atkGoalZ = () => (game.dir > 0 ? GOAL_Z : OWN_GOAL_Z);   // offense's target
const driveStartZ = () => game.dir * DRIVE_START;              // offense's own 20
const toGoYds = () => game.dir * (game.firstDown - game.los);  // yards to the sticks
const reachedGoal = (z) => (game.dir > 0 ? z >= GOAL_Z : z <= OWN_GOAL_Z);

function placeFormation() {
  const L = game.los, d = game.dir;
  const fwd = d > 0 ? 0 : Math.PI;   // offense faces its attacking end
  game.offense.forEach((p) => {
    const a = p.align; setPos(p, a.x, L + d * a.dz); p.heading = fwd;
    p.home.set(a.x, 0, L + d * a.dz); p.route = null; p.wp = 0; p.cutTimer = 0;
  });
  game.defense.forEach((p) => {
    const a = p.align; setPos(p, a.x, L + d * a.dz); p.heading = fwd + Math.PI;
    p.home.set(a.x, 0, L + d * a.dz); p.assignment = null; p.zonePoint = null; p.blockTarget = null;
  });
}
function setPos(ch, x, z) { ch.group.position.set(x, 0, z); ch.vel.set(0, 0, 0); ch.speed = 0; }

// ===========================================================================
// Steering primitives (ported from Football-Game/Steering.ts; x,z plane)
// ===========================================================================
const TURBO_MULT = 1.4; // full NFL Blitz turbo
const px = (p) => p.group ? p.group.position : p;
function seek(from, tx, tz) {
  const dx = tx - from.x, dz = tz - from.z, d = Math.hypot(dx, dz) || 1;
  return { x: dx / d, z: dz / d };
}
function pursueP(fromPos, target, predict = 0.18) {
  return seek(fromPos, px(target).x + target.vel.x * predict, px(target).z + target.vel.z * predict);
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
    if (o.role !== 'OL' || o.ragdolling) continue;
    const d = dist2(px(o), point); if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}
function updateDefense() {
  const carrier = game.carrier;
  const carrierIsRunning = !!carrier && (carrier.role !== 'QB' || pastLine(carrier));
  const inAir = ball.mode === 'flying';
  for (const d of game.defense) {
    if (d.ragdolling || d === game.controlled) continue; // knocked down, or the player drives him
    d.engaged = false;
    const dp = px(d);
    let steer = { x: 0, z: 0 };
    if (carrierIsRunning && carrier) {
      const ip = interceptPoint(d, carrier);
      steer = seek(dp, ip.x, ip.z);
      d.turbo = dist2(dp, px(carrier)) > 4 * 4;
    } else if (d.job === 'rush') {
      // Pass rush: bear down on the QB; an OL right in front walls you off.
      const qp = px(game.qb);
      steer = seek(dp, qp.x, qp.z);
      const blk = nearestBlockerTo(dp);
      d.engaged = !!blk && distXZ(px(blk), dp) < 1.6 && !(carrier && carrier === game.qb);
      d.turbo = !d.engaged && dist2(dp, qp) > 9;
    } else if (d.job === 'zone' || d.deep) {
      if (inAir) { steer = seek(dp, ball.to.x, ball.to.z); d.turbo = true; }
      else {
        const anchor = d.zonePoint || d.home;
        const threat = nearestOffenseTo(anchor, 9);
        steer = threat ? seek(dp, px(threat).x, px(threat).z) : seek(dp, anchor.x, anchor.z);
        d.turbo = threat != null && dist2(dp, px(threat)) > 5 * 5;
      }
    } else { // man cover
      if (inAir && (ball.targetRecv === game.receivers[d.covers])) {
        steer = seek(dp, ball.to.x, ball.to.z); d.turbo = true;
      } else if (inAir) {
        const a = game.receivers[d.covers]; steer = pursueP(dp, a, 0.2); d.turbo = true;
      } else {
        const a = game.receivers[d.covers];
        const ap = px(a);
        const lead = pursueP(dp, a, 0.2);
        const cushion = seek(dp, ap.x, ap.z + game.dir * 1.4); // goal-side leverage
        steer = addSteer(lead, cushion, 0.6);
        d.turbo = dist2(dp, ap) > 4.5 * 4.5; // glued unless beaten
      }
    }
    const sep = separation(d, game.defense, 3.0);
    d.desired = addSteer(steer, sep, carrierIsRunning ? 0.18 : 0.5);
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
    const job = blockForCarrier && o.job !== 'qb' ? 'block' : o.job;
    let steer = { x: 0, z: 0 };
    if (job === 'block') {
      const protect = carrier || game.qb;
      const threat = (o.blockTarget) || nearestDefenderTo(p);
      if (threat && protect) {
        const tp = px(threat), pp = px(protect);
        const bx = tp.x + Math.sign(pp.x - tp.x) * 1.2;
        const bz = tp.z + Math.sign(pp.z - tp.z) * 1.2;
        steer = seek(p, bx, bz);
        o.turbo = distXZ(p, tp) > 3.4;
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
  const dx = ch.desired.x, dz = ch.desired.z, len = Math.hypot(dx, dz);
  let speed = ch.turbo ? ch.baseSpeed * TURBO_MULT : ch.baseSpeed;
  if (game.onFire && ch.team === 'off') speed *= 1.12; // ON FIRE: the whole offense burns
  if (ch.engaged) speed *= 0.4; // a pass rusher walled off by a blocker is slowed
  let tvx = 0, tvz = 0;
  if (len > 1e-3) { tvx = dx / len * speed; tvz = dz / len * speed; }
  const k = 1 - Math.pow(0.0009, dt); // acceleration smoothing
  ch.vel.x += (tvx - ch.vel.x) * k;
  ch.vel.z += (tvz - ch.vel.z) * k;
  ch.group.position.x += ch.vel.x * dt;
  ch.group.position.z += ch.vel.z * dt;
  ch.speed = Math.hypot(ch.vel.x, ch.vel.z);
  if (ch.speed > 0.3) ch.heading = Math.atan2(ch.vel.x, ch.vel.z);
  clampToField(ch);
}
function clampToField(ch) {
  const p = ch.group.position;
  p.x = THREE.MathUtils.clamp(p.x, -HALF_W - 3, HALF_W + 3);
  p.z = THREE.MathUtils.clamp(p.z, -HALF_L + 0.5, HALF_L - 0.5);
}

// ===========================================================================
// Input
// ===========================================================================
const input = { x: 0, y: 0, action: false, turbo: false, actionEdge: false, battleMash: 0, spinEdge: false, diveEdge: false, pitchEdge: false };

(function joystick() {
  const base = document.getElementById('joystick');
  const knob = document.getElementById('joystick-knob');
  const maxR = 48; let id = null, cx = 0, cy = 0;
  const start = (e) => {
    audio.unlock();
    const t = e.changedTouches ? e.changedTouches[0] : e;
    const r = base.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    id = e.changedTouches ? t.identifier : 'mouse'; move(e);
  };
  const move = (e) => {
    if (id === null) return;
    let t;
    if (e.changedTouches) { t = [...e.changedTouches].find((c) => c.identifier === id); if (!t) return; }
    else t = e;
    let dx = t.clientX - cx, dy = t.clientY - cy; const d = Math.hypot(dx, dy);
    if (d > maxR) { dx = dx / d * maxR; dy = dy / d * maxR; }
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    input.x = dx / maxR; input.y = -dy / maxR;
  };
  const end = () => { id = null; input.x = 0; input.y = 0; knob.style.transform = 'translate(0,0)'; };
  base.addEventListener('touchstart', (e) => { e.preventDefault(); start(e); }, { passive: false });
  base.addEventListener('touchmove', (e) => { e.preventDefault(); move(e); }, { passive: false });
  base.addEventListener('touchend', (e) => { e.preventDefault(); end(e); }, { passive: false });
  base.addEventListener('touchcancel', end);
  base.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
})();

const actionBtn = document.getElementById('action-btn');
const turboBtn = document.getElementById('turbo-btn');
const spinBtn = document.getElementById('spin-btn');
const diveBtn = document.getElementById('dive-btn');
const pitchBtn = document.getElementById('pitch-btn');
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
  if (spinBtn) press(spinBtn, () => { input.spinEdge = true; });
  if (diveBtn) press(diveBtn, () => { input.diveEdge = true; });
  if (pitchBtn) press(pitchBtn, () => { input.pitchEdge = true; });
})();

// --- Play-select screen: pick one of four plays before each snap -----------
const playSelectEl = document.getElementById('playselect');
const playCards = playSelectEl ? [...playSelectEl.querySelectorAll('.ps-card')] : [];
function openPlaySelect() {
  game.choosing = true;
  playCards.forEach((c, i) => c.classList.toggle('chosen', i === game.playIndex));
  if (playSelectEl) playSelectEl.classList.remove('hidden');
  updateButtons();
}
function choosePlay(i) {
  if (i < 0 || i >= PLAYS.length) return;
  game.playIndex = i; game.choosing = false;
  if (playSelectEl) playSelectEl.classList.add('hidden');
  setStatus(`${PLAYS[i].name} — tap SNAP`);
  updateButtons();
}
for (const card of playCards) {
  const idx = +card.dataset.play, play = PLAYS[idx];
  if (play) {
    card.insertAdjacentHTML('afterbegin', makePlayArtSVG(play)); // route diagram
    const b = card.querySelector('b'), s = card.querySelector('span');
    if (b) b.textContent = play.name; if (s) s.textContent = play.sub; // keep labels in sync
  }
  const pick = (e) => { e.preventDefault(); audio.unlock(); choosePlay(idx); };
  card.addEventListener('touchstart', pick, { passive: false });
  card.addEventListener('mousedown', pick);
}

const keys = {};
window.addEventListener('keydown', (e) => {
  audio.unlock();
  if (!keys[e.code]) { // edge (initial press only, not key-repeat)
    if (e.code === 'Space') input.actionEdge = true;
    if (e.code === 'KeyQ') input.spinEdge = true;   // spin / stiff-arm
    if (e.code === 'KeyE') input.diveEdge = true;   // dive
    if (e.code === 'KeyF') input.pitchEdge = true;  // lateral pitch
    if (game.choosing && /^Digit[1-4]$/.test(e.code)) choosePlay(+e.code.slice(5) - 1);
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
  const showPC = game.state === STATE.PRESNAP && !game.gameOver && !game.choosing;
  elPlayClock.style.visibility = showPC ? 'visible' : 'hidden';
  elPlayClock.classList.toggle('warn', showPC && pc <= 5);
}
function setStatus(text) {
  elStatus.textContent = text;
  elStatus.classList.remove('flash'); void elStatus.offsetWidth; elStatus.classList.add('flash');
}
function show(el, label) { el.classList.remove('hidden'); if (label) el.textContent = label; }
function hide(el) { el.classList.add('hidden'); }
function updateButtons() {
  const s = game.state, onO = game.userOnOffense;
  // Ball-carrier move buttons (spin/dive/pitch) only show on YOUR run.
  const showMoves = s === STATE.RUN && onO;
  for (const b of [spinBtn, diveBtn, pitchBtn]) if (b) b.classList.toggle('hidden', !showMoves);
  if (s === STATE.PRESNAP && game.choosing) { hide(actionBtn); hide(turboBtn); }
  else if (s === STATE.PRESNAP) { show(actionBtn, game.gameOver ? 'REMATCH' : 'SNAP'); hide(turboBtn); }
  else if (s === STATE.LIVE) { onO ? show(actionBtn, 'THROW') : show(actionBtn, 'SWITCH'); show(turboBtn); }
  else if (s === STATE.AIR) { onO ? hide(actionBtn) : show(actionBtn, 'SWITCH'); show(turboBtn); }
  else if (s === STATE.RUN) { show(actionBtn, onO ? 'JUKE' : 'TACKLE'); show(turboBtn); }
  else if (s === STATE.RETURN) { show(actionBtn, 'TACKLE'); show(turboBtn); }
  else if (s === STATE.LOOSE) { show(actionBtn, 'DIVE'); show(turboBtn); }
  else if (s === STATE.BATTLE) { show(actionBtn, 'MASH!'); hide(turboBtn); }
  else { hide(actionBtn); hide(turboBtn); }
}

// ===========================================================================
// Juice (ported from Football-Game: ScreenShake.ts + TimeScale.ts)
// ===========================================================================
const moveToward = (v, t, maxD) => (v < t ? Math.min(v + maxD, t) : Math.max(v - maxD, t));
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
    this.offX = ox; this.offY = oy; this.offZ = oz;
    const k = Math.max(0, 1 - dt * 11); // snappy lurch-out, recovers in ~0.18s
    this.kickX *= k; this.kickZ *= k;
    if (Math.abs(this.kickX) < 0.01) this.kickX = 0;
    if (Math.abs(this.kickZ) < 0.01) this.kickZ = 0;
  }
}

// Hit-stop (a brief freeze) + bullet-time slow-mo that eases smoothly back to
// full speed. The sim multiplies its dt by `update()`'s return each frame.
class TimeScale {
  constructor() { this.freezeT = 0; this.slowT = 0; this.slowAmt = 1; this.btHold = 0; this.btEase = 0; this.btEaseDur = 1; this.btScale = 1; }
  freeze(s) { this.freezeT = Math.max(this.freezeT, s); }
  slow(scale, s) { this.slowAmt = scale; this.slowT = Math.max(this.slowT, s); }
  bulletTime(scale = 0.16, hold = 0.5, ease = 0.8) {
    this.btScale = scale; this.btHold = hold; this.btEase = ease; this.btEaseDur = ease;
  }
  update(realDt) {
    if (this.freezeT > 0) { this.freezeT -= realDt; return 0; }
    let v = 1;
    if (this.slowT > 0) { this.slowT -= realDt; v = Math.min(v, this.slowAmt); }
    if (this.btHold > 0 || this.btEase > 0) {
      let bt;
      if (this.btHold > 0) { this.btHold -= realDt; bt = this.btScale; }
      else {
        this.btEase -= realDt;
        const k = THREE.MathUtils.clamp(this.btEase / this.btEaseDur, 0, 1);
        const s = k * k * (3 - 2 * k); // smoothstep ramp back to full speed
        bt = this.btScale + (1 - this.btScale) * (1 - s);
      }
      v = Math.min(v, bt);
    }
    return v;
  }
}

const shake = new ScreenShake();
const timeScale = new TimeScale();

const bannerEl = document.getElementById('banner');
function showBanner(text, color = '#ffd23a') {
  bannerEl.textContent = text;
  bannerEl.style.color = color;
  bannerEl.classList.remove('pop'); void bannerEl.offsetWidth;
  bannerEl.classList.add('pop');
}

// ===========================================================================
// Play flow
// ===========================================================================
// Game clock: runs while the ball is live, freezes between plays. Pre-snap a
// delay-of-game play clock counts down and auto-snaps at zero. The quarter only
// rolls over between plays (the current play always finishes).
function tickClock(dt) {
  if (game.gameOver || game.choosing) return; // clock waits while you pick a play
  if (game.state === STATE.PRESNAP) {
    game.snapClock -= dt;
    if (game.snapClock <= 0) { game.snapClock = 0; setStatus('Delay of game — snapped!'); snap(); }
  } else if (game.state !== STATE.DEAD) {
    game.gameClock = Math.max(0, game.gameClock - dt);
  }
  updateHUD();
}
function advanceQuarter() {
  game.quarter += 1;
  if (game.quarter > 4) { endGame(); return; }
  game.gameClock = QUARTER_LEN;
  audio.whistle();
  if (game.quarter === 3) showBanner('HALFTIME', '#ffd23a');
  else showBanner(`Q${game.quarter}`, '#ffd23a');
}
function endGame() {
  game.gameOver = true; game.gameClock = 0;
  douseFire();
  audio.whistle();
  showBanner('FINAL', game.scoreOff >= game.scoreDef ? '#3fe08a' : '#ff6a5a');
}
function resetGame() {
  game.scoreOff = 0; game.scoreDef = 0;
  game.quarter = 1; game.gameClock = QUARTER_LEN; game.gameOver = false;
  game.userOnOffense = true; game.dir = 1;
  game.los = DRIVE_START; game.down = 1; game.firstDown = game.los + FIRST_DOWN_YDS;
  game.fireCount = 0; douseFire();
  showBanner('KICKOFF', '#ffd23a');
  newPlay();
}

function newPlay() {
  clearRagdolls(); // animation clips repose every bone on the next mixer update
  // Roll the quarter (or end the game) if the clock ran out on the last play.
  if (!game.gameOver && game.gameClock <= 0) advanceQuarter();
  battleEl.classList.add('hidden'); game.battle.tackler = null;
  for (const ch of game.all) { ch.oneShotT = 0; ch.throwAnimT = 0; ch.armPoseT = 0; ch.spinT = 0; ch.diveT = 0; ch.recoverT = 0; }
  setFumbleGlow(false); // make sure a recovered fumble's glow is cleared
  setupPossession();   // assign offense/defense roles for whoever has the ball
  placeFormation();
  game.state = STATE.PRESNAP;
  game.controlled = game.qb; game.carrier = null; game.selected = 0;
  game.returnActive = false; game.returner = null; game.fumbleLost = false;
  game.snapClock = PLAY_CLOCK;
  ball.mode = 'carried'; ball.targetRecv = null;
  ball.holder = null; ball.catcher = null; ball.secureT = 0; ball.intercept = false;
  selRing.visible = game.userOnOffense; ctrlRing.visible = false;
  losLine.position.z = game.los;
  firstDownLine.position.z = THREE.MathUtils.clamp(game.firstDown, -HALF_L + 1, HALF_L - 1);
  firstDownLine.visible = !reachedGoal(game.firstDown);
  updateButtons(); updateHUD();
  if (game.gameOver) setStatus(`FINAL ${game.scoreOff}–${game.scoreDef} — tap REMATCH`);
  else if (!game.userOnOffense) { game.choosing = false; setStatus('CPU ball — play DEFENSE'); } // no play-call on D
  else { setStatus('Choose your play'); openPlaySelect(); } // pick a play, then SNAP
}
function snap() {
  game.state = STATE.LIVE;
  game.playClock = 0; game.lastBreak = -10;
  game.throwCharge = 0; game.throwArmed = false; // ignore the held snap press
  // The CPU drops back then throws; pick its target now (most open at snap).
  game.cpuQBTimer = game.userOnOffense ? 0 : 1.1 + Math.random() * 0.7;
  const play = game.userOnOffense ? (PLAYS[game.playIndex] || PLAYS[0]) : PLAYS[Math.floor(Math.random() * PLAYS.length)];
  game.receivers.forEach((r, e) => { r.route = play.route(e, r.align.x, game.los); r.wp = 0; r.cutTimer = 0; r.job = 'route'; });
  game.offense.forEach((o) => { if (o.role === 'OL') o.job = 'block'; }); // linemen pass-protect
  game.defense.forEach((d) => {
    d.job = d.role === 'DL' ? 'rush' : d.deep ? 'zone' : 'cover'; // DL rush, S deep, rest cover
    if (d.deep) d.zonePoint = new THREE.Vector3(0, 0, game.los + game.dir * 18);
  });
  // On a CPU possession you play defense: take over the nearest defender.
  if (!game.userOnOffense) { game.controlled = nearestToBallDefender(); ctrlRing.visible = true; selRing.visible = false; }
  audio.hike();
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
const PASS_G = 10.7;      // gravity, yd/s^2 (~9.8 m/s^2)
const PASS_VMAX = 37;     // arm strength: max launch speed, yd/s (snappier throws)
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
  const errMag = THREE.MathUtils.lerp(0.9, 0.35, p) * THREE.MathUtils.clamp(t / 1.2, 0.5, 1.4);
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
  ball.to.set(tx, 0, tz); ball.targetRecv = recv; ball.intRolled = false;
  ball.mode = 'flying';
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
  game.carrier = player; player.route = null;
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
    const score = open + downfield * 0.12;
    if (score > bestScore) { bestScore = score; best = wr; }
  }
  return best;
}
// CPU quarterback: backpedal a beat, then throw to the most open man (or take
// off scrambling if it's covered too long).
function cpuQB(dt) {
  const qb = game.qb;
  game.cpuQBTimer -= dt;
  if (game.cpuQBTimer > 0.35) { qb.desired = { x: 0, z: -game.dir }; qb.turbo = false; } // drop back
  else qb.desired = { x: 0, z: 0 };
  const pressured = !!nearestDefenderTo(px(qb)) && distXZ(px(nearestDefenderTo(px(qb))), px(qb)) < 2.2;
  if (ball.mode === 'carried' && (game.cpuQBTimer <= 0 || pressured)) {
    const target = mostOpenReceiver();
    if (target) { ball.targetRecv = target; game.selected = game.receivers.indexOf(target); throwBall(0.25 + Math.random() * 0.5); }
    else if (pastLine(qb)) { enterRun(qb, ''); } // nobody open and past the line — scramble
    else game.cpuQBTimer = 0.3; // hold a touch longer
  }
}
// A CPU ball carrier (after a CPU catch/scramble) seeks the end zone while you
// chase with a defender; your teammates pursue and tackle on contact.
function updateCpuRun(dt, turboOn, actionEdge) {
  const c = game.carrier;
  if (!c) { endPlay('incomplete', game.los); return; }
  // Re-acquire control if our man got knocked down (or was never set).
  if (!game.controlled || game.controlled.ragdolling) switchDefender();
  if (actionEdge && game.controlled) { // dive/lunge tackle with the controlled defender
    const o = game.controlled, dx = c.group.position.x - o.group.position.x, dz = c.group.position.z - o.group.position.z;
    const l = Math.hypot(dx, dz) || 1; const burst = o.baseSpeed * 1.25;
    o.vel.x = dx / l * burst; o.vel.z = dz / l * burst; o.heading = Math.atan2(dx, dz);
    playOneShot(o, 'tackle', 0.4);
    if (l <= 2.4) { beginTackle(o); return; }
  }
  // Carrier AI: head for the goal, cut from the nearest defender.
  let steer = seek(px(c), THREE.MathUtils.clamp(c.group.position.x * 0.5, -14, 14), atkGoalZ() + game.dir * 3);
  const chaser = nearestDefenderTo(px(c));
  if (chaser) { const ax = c.group.position.x - chaser.group.position.x, al = Math.abs(ax) || 1; steer = addSteer(steer, { x: ax / al, z: 0 }, 0.5); }
  c.desired = addSteer(steer, separation(c, game.offense, 2.5), 0.2); c.turbo = true;
  if (game.controlled) { const top = game.controlled.baseSpeed * (turboOn ? TURBO_MULT : 1); controlledMove(game.controlled, dt, top); }
  updateOffense(dt); updateDefense();
  for (const ch of game.all) if (ch !== game.controlled && !ch.ragdolling) applySteer(ch, dt);
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
function beginReturn(interceptor) {
  game.state = STATE.RETURN;
  game.returnActive = true; game.returner = interceptor;
  game.carrier = interceptor;          // so the ball follows him + TACKLE settle works
  ball.mode = 'carried'; ball.holder = interceptor;
  game.controlled = nearestOffender(interceptor.group.position) || game.qb;
  ctrlRing.visible = true; selRing.visible = false;
  showBanner('INTERCEPTED!', '#ff5a3a');
  setStatus('Intercepted — chase him down!');
  updateButtons();
}
function updateReturn(dt, turboOn, fireMul) {
  const r = game.returner;
  if (!r) { game.returnActive = false; endPlay('incomplete', game.los); return; }
  const rp = r.group.position;
  // Returner heads for his end zone (-Z), cutting back from the nearest chaser.
  let steer = seek(px(r), THREE.MathUtils.clamp(rp.x * 0.4, -14, 14), OWN_GOAL_Z - 3);
  const chaser = nearestOffender(rp);
  if (chaser) {
    const ax = rp.x - chaser.group.position.x, al = Math.abs(ax) || 1;
    steer = addSteer(steer, { x: ax / al, z: 0 }, 0.55); // juke laterally away
  }
  r.desired = addSteer(steer, separation(r, game.defense, 2.5), 0.2); r.turbo = true;
  // The offense pursues with cut-off angles; the player drives the controlled man.
  for (const o of game.offense) {
    if (o === game.controlled || o.ragdolling) continue;
    const ip = pursuitPoint(o, r);
    o.desired = seek(px(o), ip.x, ip.z); o.turbo = dist2(px(o), rp) > 16;
  }
  // The returner's teammates trail to escort (and stay out of the way).
  for (const d of game.defense) {
    if (d === r || d.ragdolling) continue;
    d.desired = seek(px(d), rp.x, rp.z + 3); d.turbo = false;
  }
  const top = game.controlled.baseSpeed * fireMul * (turboOn ? TURBO_MULT : 1);
  controlledMove(game.controlled, dt, top);
  for (const ch of game.all) if (ch !== game.controlled && !ch.ragdolling) applySteer(ch, dt);
  // Outcomes: house call, out of bounds, or run down.
  if (rp.z <= OWN_GOAL_Z) { endReturn('defTD', rp.z); return; }
  if (Math.abs(rp.x) > HALF_W) { endReturn('tackle', rp.z); return; }
  for (const o of game.offense) {
    if (o.ragdolling) continue;
    if (Math.hypot(o.group.position.x - rp.x, o.group.position.z - rp.z) <= TACKLE_R) { tackleReturner(o); return; }
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
  ctrlRing.visible = false; updateButtons();
  shake.kick(hitX, hitZ, big ? 0.8 : 0.4);
  burst(rp.x, 1.0, rp.z, 0xe8d9a0, big ? 16 : 10, big ? 8 : 6);
  if (big) { timeScale.bulletTime(0.16, 0.5, 0.9); hitZoom(1.2); shake.add(0.5); audio.bigHit(); showBanner('STOPPED!', '#bfffd0'); }
  else { timeScale.bulletTime(0.22, 0.4, 0.7); hitZoom(0.9); shake.add(0.18); audio.hit(0.6); }
  setStatus('Return stopped!');
}
function endReturn(result, spotZ) {
  game.returnActive = false; game.returner = null;
  game.state = STATE.DEAD; game.deadTimer = 1.1;
  ball.mode = 'rest';
  selRing.visible = false; ctrlRing.visible = false; updateButtons();
  douseFire(); // the player threw the pick — fire out
  // A live return only happens on a USER possession (the CPU defense picks it
  // off and runs it back; you chase). So the interceptor here is the CPU.
  if (result === 'defTD') {
    game.scoreDef += 7; audio.touchdown();
    showBanner('PICK SIX!', '#5a8bff'); setStatus('Returned for a touchdown!');
    shake.add(0.3); timeScale.slow(0.5, 0.4);
    giveBallTo(true, driveStartForUser(true)); // you get the ball back at your 20
  } else {
    audio.whistle(); showBanner('TURNOVER', '#ffd23a'); setStatus('Picked off — CPU ball');
    giveBallTo(false, spotZ); // the CPU keeps it where the return ended
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
  game.los = THREE.MathUtils.clamp(losZ, OWN_GOAL_Z + 1, GOAL_Z - 1);
  game.down = 1;
  game.firstDown = game.los + nd * FIRST_DOWN_YDS;
}
function endPlay(result, endZ) {
  game.state = STATE.DEAD; game.deadTimer = 1.1;
  selRing.visible = false; ctrlRing.visible = false; updateButtons();
  const userHad = game.userOnOffense;
  if (result === 'TD') {
    audio.touchdown(); timeScale.slow(0.45, 0.5); shake.add(0.3);
    if (userHad) {
      game.scoreOff += 7; game.fireCount++;
      if (game.fireCount >= 3 && !game.onFire) { game.onFire = true; setFireVisual(true); audio.fire(); showBanner('ON FIRE!', '#ff7a3a'); setStatus('3 straight TDs — ON FIRE! 🔥'); }
      else { showBanner('TOUCHDOWN!', '#ffd23a'); setStatus('TOUCHDOWN! 🏈'); }
    } else {
      game.scoreDef += 7; douseFire(); showBanner('CPU TOUCHDOWN', '#5a8bff'); setStatus('CPU scores');
    }
    giveBallTo(!userHad, driveStartForUser(!userHad)); // other team gets the ball
  } else if (result === 'intercept' || result === 'fumble') {
    if (result !== 'intercept') audio.whistle();
    if (userHad) douseFire(); // the player coughed it up
    showBanner('TURNOVER', '#ffd23a');
    setStatus(result === 'fumble' ? 'Fumble — turnover!' : 'Intercepted!');
    giveBallTo(!userHad, endZ); // the other team takes over at the spot
  } else {
    audio.whistle();
    const gained = result === 'incomplete' ? 0 : game.dir * (endZ - game.los);
    setStatus(result === 'incomplete' ? 'Incomplete'
      : result === 'oob' ? `Out of bounds (+${Math.max(0, Math.round(gained))})`
        : `${userHad ? 'Tackled' : 'CPU down'} (+${Math.max(0, Math.round(gained))})`);
    const spot = THREE.MathUtils.clamp(result === 'incomplete' ? game.los : endZ, OWN_GOAL_Z + 1, GOAL_Z - 1);
    const gotFirst = game.dir > 0 ? spot >= game.firstDown : spot <= game.firstDown;
    if (gotFirst) { game.los = spot; game.down = 1; game.firstDown = game.los + game.dir * FIRST_DOWN_YDS; }
    else {
      game.los = spot; game.down += 1;
      if (game.down > 4) { if (userHad) douseFire(); setStatus('Turnover on downs'); giveBallTo(!userHad, spot); }
    }
  }
  updateHUD();
}

// ===========================================================================
// Ball + outcomes
// ===========================================================================
const TACKLE_R = 1.5, CATCH_R = 1.6, CATCH_R_INTENDED = 2.6, CONTEST_R = 2.7, INTERCEPT_R = 1.3;
const THROW_ANIM_DUR = 0.45; // procedural throwing-motion length (s)
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _d = new THREE.Vector3();
const _bv = new THREE.Vector3(), _ballQ = new THREE.Quaternion(), _spinQ = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);

const _hips = new THREE.Vector3();
function updateBall(dt) {
  if (ball.mode === 'rest') return; // sits where it landed (incomplete pass)
  if (ball.mode === 'loose') return; // a live fumble — physics handled in updateLoose
  if (ball.mode === 'carried') {
    const h = game.carrier || ball.holder || game.qb;
    if (h.ragdolling && h.ragdoll && h.ragdoll.active) {
      // Tucked with the falling body: track the carrier's physics-driven hips.
      const hips = h.ragdoll.tryBone('Hips');
      if (hips) { hips.getWorldPosition(_hips); ball.mesh.position.set(_hips.x, Math.max(0.2, _hips.y), _hips.z); return; }
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
    // Keep the receiver's homing target on the ball's projected landing spot.
    const tRem = Math.max(0.05, ball.flightTime - ball.airTime);
    ball.to.set(p.x + ball.vx * tRem, 0, p.z + ball.vz * tRem);
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
    // Catchable once it has descended into reach; resolve at the target time
    // or when it hits the turf.
    if (ball.vy < 0 && p.y < 2.6 && tryReception()) return;
    if (ball.airTime >= ball.flightTime || p.y <= 0.16) {
      if (!tryReception()) { ball.mode = 'rest'; endPlay('incomplete', game.los); }
    }
  } else if (ball.mode === 'secured') {
    // Home the ball INTO the catcher's hands over a short beat so you see it
    // get tucked away, then resolve the catch / interception.
    const c = ball.catcher;
    let tx, ty, tz;
    if (c && c.handBone) {
      c.handBone.updateWorldMatrix(true, false);
      c.handBone.getWorldPosition(_hips);
      tx = _hips.x; ty = Math.max(0.9, _hips.y); tz = _hips.z;
    } else { const gp = c.group.position; tx = gp.x; ty = 1.2; tz = gp.z; }
    const k = THREE.MathUtils.clamp(dt / Math.max(0.0001, ball.secureT), 0, 1);
    const p = ball.mesh.position;
    p.x += (tx - p.x) * k; p.y += (ty - p.y) * k; p.z += (tz - p.z) * k;
    ball.spin += ball.spinRate * 0.5 * dt;
    ball.mesh.rotation.set(0, c ? c.heading : 0, 0.35); // settle into a tuck
    ball.secureT -= dt;
    if (ball.secureT <= 0) {
      p.set(tx, ty, tz);
      if (ball.intercept) {
        ball.mode = 'carried'; ball.holder = c;
        // On YOUR drive the CPU picks it and runs it back (you chase). On a CPU
        // drive your pick is a clean takeaway — you get the ball next snap.
        if (game.userOnOffense) beginReturn(c);
        else endPlay('intercept', c.group.position.z);
      } else { ball.mode = 'carried'; enterRun(c, 'Caught it! Run!'); }
    }
  }
}
// Begin the secure phase: the ball homes into the catcher's hands before it
// resolves to a catch (or interception).
function startSecure(player, isInt) {
  player.heading = Math.atan2(ball.vx, ball.vz); // turn to the ball
  ball.mode = 'secured'; ball.catcher = player; ball.secureT = 0.24; ball.intercept = isInt;
  const p = ball.mesh.position;
  if (isInt) {
    showBanner('PICKED OFF!', '#ff5a3a'); shake.add(0.3); audio.groan();
    burst(p.x, p.y, p.z, 0x8fbaff, 8, 5);
  } else {
    audio.catch(); audio.cheer(0.35); timeScale.slow(0.7, 0.18);
    burst(p.x, p.y, p.z, 0xffffff, 8, 5);
  }
}
function passBrokenUp(msg, color, swatter, swatType) {
  ball.mode = 'rest';
  showBanner(msg, color);
  const p = ball.mesh.position;
  // Procedural reaction on the player who made the play on the ball: a defender
  // bats it down (swat), a receiver lunges and can't hang on (reach).
  if (swatter) { swatter.heading = Math.atan2(p.x - swatter.group.position.x, p.z - swatter.group.position.z); triggerArmAction(swatter, swatType || 'swat', 0.4, p); }
  burst(p.x, Math.max(0.3, p.y), p.z, 0xdfe7ff, 9, 6); // swat
  shake.add(0.12);
  endPlay('incomplete', game.los); // endPlay blows the whistle
}

// Resolve a ball in flight against nearby players. Most throws into coverage
// are CONTESTED — only a clear window is a clean catch; tight coverage is
// usually an incompletion / breakup, with rare picks on blanketed throws.
function tryReception() {
  const p = ball.mesh.position;
  const near = (ch) => Math.hypot(ch.group.position.x - p.x, ch.group.position.z - p.z);
  // The intended receiver gets a bigger window (the throw was aimed at him);
  // any other receiver needs the ball right on him.
  let bestR = null, dR = Infinity;
  for (const wr of game.receivers) {
    const reach = wr === ball.targetRecv ? CATCH_R_INTENDED : CATCH_R;
    const d = near(wr);
    if (d <= reach && d < dR) { dR = d; bestR = wr; }
  }
  let bestDef = null, dD = Infinity;
  for (const db of game.defense) { if (db.ragdolling) continue; const d = near(db); if (d < dD) { dD = d; bestDef = db; } }

  // No receiver in catching range yet — but a defender right on the ball can
  // still jump it. Otherwise keep flying (resolves incomplete at the end).
  if (!bestR) {
    if (bestDef && dD <= INTERCEPT_R && !ball.intRolled) {
      ball.intRolled = true; // one roll per throw, not per frame
      if (Math.random() < 0.45) { startSecure(bestDef, true); return true; }
    }
    return false;
  }

  // A receiver is in reach. Uncontested = a clean grab (rare drop).
  const contested = bestDef && dD <= CONTEST_R;
  if (!contested) {
    if (Math.random() < 0.94) { startSecure(bestR, false); return true; }
    passBrokenUp('DROPPED!', '#dfe7ff', bestR, 'reach'); return true; // receiver lunges, drops it
  }

  // Contested: catch odds fall as the coverage tightens; misses are mostly
  // breakups, with a pick only when a defender is right there.
  const tight = 1 - THREE.MathUtils.clamp(dD / CONTEST_R, 0, 1); // 0 loose .. 1 glued
  let pCatch = THREE.MathUtils.lerp(0.80, 0.25, tight);
  if (game.onFire) pCatch += 0.12;
  if (Math.random() < pCatch) { startSecure(bestR, false); return true; } // contested grab
  if (dD <= INTERCEPT_R && Math.random() < 0.4) { startSecure(bestDef, true); return true; } // pick
  passBrokenUp('BROKEN UP!', '#9fd0ff', bestDef, 'swat'); return true; // DB bats it away
}
function checkRunOutcome() {
  const c = game.carrier.group.position;
  if (reachedGoal(c.z)) { endPlay('TD', c.z); return; }
  if (Math.abs(c.x) > HALF_W || Math.abs(c.z) > HALF_L) { endPlay('oob', c.z); return; }
  for (const db of game.defense) {
    if (db.ragdolling) continue;
    if (Math.hypot(db.group.position.x - c.x, db.group.position.z - c.z) <= TACKLE_R) { beginTackle(db); return; }
  }
}

// ===========================================================================
// Ragdoll tackles (tackle resolution ported from Football-Game/TackleEngine)
// ===========================================================================
const SWARM_R = 3.5;   // defenders within this of the carrier join the pile
const GANG_MAX = 3;    // max bodies in the pile
const RAGDOLL_MAX = 3; // carrier + 2 tacklers ragdoll; the rest just wrap

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
  const c = game.carrier ? game.carrier.group.position : d.group.position;
  const dx = d.group.position.x - c.x, dz = d.group.position.z - c.z;
  const l = Math.hypot(dx, dz) || 1;
  const away = new THREE.Vector3(dx / l, 0, dz / l); // bounced off the runner
  spawnRagdoll(d, new THREE.Vector3(d.vel.x, 0, d.vel.z), away, 3.5,
    MIDPLAY_BITS[midplayBit++ % MIDPLAY_BITS.length], 'highKnock');
}

// Strength + momentum break check vs the whole pile (from TackleEngine.tryBreak).
// A fast, turbo, or ON FIRE back slips a lone defender often; a gang rarely.
function tryBreak(carrier, pile) {
  if (game.playClock - game.lastBreak < 0.55) return false;
  const speed = Math.hypot(carrier.vel.x, carrier.vel.z);
  let p = input.turbo ? 0.52 : 0.34;
  const power = carrier.strength * (1 + speed / 16) * (input.turbo ? 1.2 : 1) * (game.onFire ? 1.4 : 1);
  let gangStr = 0;
  for (const t of pile) gangStr += t.strength;
  p *= THREE.MathUtils.clamp(power / (gangStr * 0.9), 0.3, 1.25);
  if (pile.length >= 2) p *= 0.45; // a gang is hard to slip
  if (pile.length >= 3) p *= 0.5;
  if (Math.random() >= p) return false;
  game.lastBreak = game.playClock;
  return true;
}

// --- 1-on-1 break-tackle battle (mash to break free) -----------------------
const BATTLE_TIME = 2.6;     // seconds before it resolves on whoever leads
const BATTLE_TAP = 0.095;    // meter toward break per mash
const BATTLE_CPU = 0.24;     // meter drift/s toward the tackle
const battleEl = document.getElementById('battle');
const battleFill = document.getElementById('battle-fill');
const battleDiv = document.getElementById('battle-div');
const battlePrompt = document.getElementById('battle-prompt');
// Tapping anywhere on the battle overlay also counts as a mash.
battleEl.addEventListener('touchstart', (e) => { e.preventDefault(); input.battleMash++; }, { passive: false });
battleEl.addEventListener('mousedown', () => { input.battleMash++; });

function startBattle(tackler, hard = false) {
  const b = game.battle;
  // A big committed hit starts you further behind (harder to break out of).
  b.val = hard ? 0.4 : 0.52; b.timer = BATTLE_TIME; b.tackler = tackler; b.flash = 0;
  game.state = STATE.BATTLE;
  // Face the two off, stopped, chest to chest.
  const c = game.carrier;
  const ang = Math.atan2(tackler.group.position.x - c.group.position.x, tackler.group.position.z - c.group.position.z);
  c.vel.set(0, 0, 0); c.speed = 0; c.heading = ang;
  tackler.vel.set(0, 0, 0); tackler.speed = 0; tackler.heading = ang + Math.PI;
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
  const cpuStr = b.tackler.strength, humanStr = game.carrier.strength;
  b.val -= BATTLE_CPU * dt * THREE.MathUtils.clamp(cpuStr / humanStr, 0.6, 1.7);
  b.val = THREE.MathUtils.clamp(b.val, 0, 1);

  // Wrestle wobble: a bounded shove so the two never drift apart.
  const wob = Math.sin(game.playClock * 26) * 0.12;
  const c = game.carrier.group.position, ang = game.carrier.heading;
  const half = 1.1 + wob;
  const tk = b.tackler.group.position;
  tk.x = c.x + Math.sin(ang) * half; tk.z = c.z + Math.cos(ang) * half;

  battleFill.style.width = `${Math.round(b.val * 100)}%`;
  battleDiv.style.left = `${Math.round(b.val * 100)}%`;

  if (b.val >= 1 || (b.timer <= 0 && b.val >= 0.5)) { endBattle(true); return; }
  if (b.val <= 0 || b.timer <= 0) { endBattle(false); return; }
}

function beginTackle(lead, force = false) {
  const carrier = game.carrier;
  const cp = carrier.group.position;
  if (!physics) { endPlay('tackle', cp.z); return; } // no physics: instant whistle

  // Gather the swarm: the lead plus the nearest defenders crashing the carrier.
  const pile = [lead, ...game.defense
    .filter((d) => d !== lead && distXZ(px(d), cp) <= SWARM_R)
    .sort((a, b) => distXZ(px(a), cp) - distXZ(px(b), cp))].slice(0, GANG_MAX);
  const gangSize = pile.length;

  const hitX = cp.x - lead.group.position.x;
  const hitZ = cp.z - lead.group.position.z;
  const hl = Math.hypot(hitX, hitZ) || 1;
  const hitDir = new THREE.Vector3(hitX / hl, 0, hitZ / hl);
  const closing = Math.hypot(lead.vel.x - carrier.vel.x, lead.vel.z - carrier.vel.z);
  const big = lead.turbo || closing > 8; // Blitz: most square hits are violent
  const gang = gangSize >= 3;

  // A committed tackle (a lost battle) skips every escape — straight down.
  // Blitz: a well-timed JUKE makes the first man whiff right past — and down.
  if (!force && carrier.jukeTimer > 0) {
    carrier.jukeTimer = 0;
    knockdownDefender(lead);
    shake.add(0.15);
    setStatus('WHIFF!');
    return;
  }

  // 1-on-1 break-tackle BATTLE: any LONE tackler on the ball carrier kicks off
  // a mash duel — your chance to break the tackle. (Only when YOU carry the
  // ball; on defense your tackle just sticks.) A swarm can't be broken this way.
  if (!force && game.userOnOffense && gangSize === 1 && game.battle.cd <= 0) {
    startBattle(lead, big);
    return;
  }

  // Otherwise (a gang, or while the battle is on cooldown): a small strength +
  // momentum chance to bust through anyway (TackleEngine.tryBreak) — your run only.
  if (!force && game.userOnOffense && tryBreak(carrier, pile)) {
    knockdownDefender(lead);
    carrier.vel.x *= 0.8; carrier.vel.z *= 0.8;
    shake.add(0.2);
    shake.kick(carrier.vel.x, carrier.vel.z, 0.4);
    showBanner('BROKE IT!', '#bfffd0');
    return;
  }

  // Random FUMBLE: a jarring hit can knock the ball loose. Bigger hits and gang
  // tackles pop it more often. The carrier goes down and the ball pops free for
  // a live scramble (see startFumble) instead of the play ending.
  if (Math.random() < (big ? 0.13 : 0.05) + (gang ? 0.06 : 0)) {
    const variant = pickVariant(big, gangSize, closing, hitX, hitZ);
    const hitSpeed = THREE.MathUtils.clamp(2 + closing * 0.45, 2.5, 8);
    spawnRagdoll(carrier, new THREE.Vector3(carrier.vel.x, 0, carrier.vel.z), hitDir, hitSpeed, 0x0002, variant);
    lead.heading = Math.atan2(hitX, hitZ); playOneShot(lead, 'tackle', 0.45);
    startFumble(carrier, hitX, hitZ);
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
    if (gang) { timeScale.bulletTime(0.1, 0.7, 1.1); hitZoom(1.5); }
    else { timeScale.bulletTime(0.14, 0.55, 0.95); hitZoom(1.2); }
    shake.add(gang ? 0.72 : 0.5);
    audio.bigHit();
    showBanner(gang ? 'GANG TACKLE!' : 'BIG HIT!', gang ? '#ff9a3a' : '#ff5a3a');
  } else {
    timeScale.bulletTime(0.22, 0.4, 0.7);
    hitZoom(0.9);
    shake.add(0.18);
    audio.hit(0.6);
  }
  setStatus(gang ? 'GANG TACKLE!' : big ? 'BIG HIT!' : 'Tackled!');
}

// --- Live fumble: the ball pops loose, glows, bounces, and both teams dive ---
function nearestTeamToBall(team) {
  const bp = ball.mesh.position; let best = null, bestD = Infinity;
  for (const p of team) { if (p.ragdolling) continue; const d = dist2(px(p), bp); if (d < bestD) { bestD = d; best = p; } }
  return best || team[0];
}
function setFumbleGlow(on) {
  const m = ball.mesh.material;
  if (m) { m.emissive.setHex(on ? 0xffcc33 : 0x000000); m.emissiveIntensity = on ? 0.9 : 0; m.needsUpdate = true; }
  if (ball.flame) { ball.flame.color.setHex(on ? 0xffd23a : 0xff6622); ball.flame.intensity = on ? 3.5 : (game.onFire ? 2 : 0); ball.flame.distance = on ? 10 : 7; }
}
function startFumble(carrier, hitX, hitZ) {
  game.state = STATE.LOOSE; game.looseTimer = 5.0;
  const cp = carrier.group.position;
  ball.mode = 'loose'; ball.holder = null; ball.catcher = null; ball.targetRecv = null;
  ball.mesh.position.set(cp.x, 1.2, cp.z);
  const ang = Math.atan2(hitX, hitZ) + (Math.random() - 0.5) * 1.2, sp = 5 + Math.random() * 5;
  ball.vx = Math.sin(ang) * sp; ball.vz = Math.cos(ang) * sp; ball.vy = 5.5 + Math.random() * 3.5;
  ball.g = 24; ball.spin = 0; ball.spinRate = 10;
  setFumbleGlow(true);
  game.controlled = nearestTeamToBall(game.teamA); // scramble with your team
  ctrlRing.visible = true; selRing.visible = false;
  showBanner('FUMBLE!!!', '#ff3a2a'); audio.bigHit(); audio.groan();
  shake.add(0.6); timeScale.bulletTime(0.2, 0.4, 0.8); hitZoom(1.0);
  burst(cp.x, 1.1, cp.z, 0xffd23a, 20, 9);
  setStatus('FUMBLE — recover it!'); updateButtons();
}
function updateLoose(dt, turboOn, actionEdge) {
  const p = ball.mesh.position;
  // Bouncing, glowing loose ball.
  ball.vy -= ball.g * dt;
  p.x += ball.vx * dt; p.y += ball.vy * dt; p.z += ball.vz * dt;
  const gy = 0.22;
  if (p.y <= gy) { p.y = gy; if (ball.vy < 0) { ball.vy = -ball.vy * 0.45; if (ball.vy < 1.4) ball.vy = 0; } ball.vx *= 0.62; ball.vz *= 0.62; }
  ball.vx *= (1 - dt * 0.85); ball.vz *= (1 - dt * 0.85);
  ball.spin += (ball.spinRate + Math.hypot(ball.vx, ball.vz) * 1.2) * dt;
  ball.mesh.rotation.set(ball.spin * 0.6, ball.spin, ball.spin * 0.35); // chaotic tumble
  if (ball.flame) ball.flame.intensity = 2.6 + Math.sin(performance.now() * 0.02) * 1.4; // pulse
  if (Math.abs(p.x) > HALF_W || Math.abs(p.z) > HALF_L) { recoverDead(p.z); return; } // out of bounds
  // Everyone scrambles to the ball; you drive your nearest man.
  for (const ch of game.all) {
    if (ch.recoverT > 0) ch.recoverT -= dt;
    if (ch.ragdolling || ch === game.controlled) continue;
    ch.desired = seek(px(ch), p.x, p.z); ch.turbo = true;
  }
  if (game.controlled) {
    const top = game.controlled.baseSpeed * (turboOn ? TURBO_MULT : 1);
    controlledMove(game.controlled, dt, top);
    if (actionEdge) { // dive on the ball — extends your reach for a beat
      const o = game.controlled, dx = p.x - o.group.position.x, dz = p.z - o.group.position.z, l = Math.hypot(dx, dz) || 1;
      o.vel.x = dx / l * o.baseSpeed * 1.35; o.vel.z = dz / l * o.baseSpeed * 1.35; o.heading = Math.atan2(dx, dz);
      o.recoverT = 0.45; triggerArmAction(o, 'pick', 0.45, p); // procedural dive-reach
    }
  }
  for (const ch of game.all) if (ch !== game.controlled && !ch.ragdolling) applySteer(ch, dt);
  // Recovery: a player on the low ball falls on it (a dive reaches farther).
  if (p.y < 1.3) {
    let rec = null, recD = Infinity;
    for (const ch of game.all) {
      if (ch.ragdolling) continue;
      const reach = ch.recoverT > 0 ? 2.3 : 1.3;
      const d = Math.hypot(ch.group.position.x - p.x, ch.group.position.z - p.z);
      if (d <= reach && d < recD) { recD = d; rec = ch; }
    }
    if (rec) { recoverFumble(rec); return; }
  }
  game.looseTimer -= dt;
  if (game.looseTimer <= 0) recoverDead(p.z);
}
function recoverFumble(ch) {
  setFumbleGlow(false);
  ball.mode = 'carried'; ball.holder = ch; game.carrier = ch; // ball follows the recoverer, not the downed runner
  triggerArmAction(ch, 'pick', 0.5, ball.mesh.position); // procedural dive-on-the-ball
  audio.catch(); shake.add(0.25);
  const spotZ = ch.group.position.z;
  if (game.offense.includes(ch)) { showBanner('RECOVERED!', '#bfffd0'); endPlay('tackle', spotZ); } // offense keeps it
  else { showBanner('TURNOVER!', '#5a8bff'); audio.cheer(0.5); endPlay('fumble', spotZ); }          // defense takes it
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

function clearRagdolls() {
  for (const ch of game.all) {
    const wasRagdoll = ch.ragdolling || (ch.ragdoll && ch.ragdoll.active);
    if (ch.ragdoll) ch.ragdoll.dispose();
    ch.ragdolling = false;
    // Snap every bone back to its rest pose so the mixer (rotation-only) starts
    // from a clean skeleton — fixes lower-body-under-the-field after a tackle.
    if (wasRagdoll && ch.restPose) {
      for (const [bone, pos, quat] of ch.restPose) { bone.position.copy(pos); bone.quaternion.copy(quat); }
      ch.mixer.setTime(0); // re-evaluate the current clip onto the clean pose
    }
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
function playOneShot(ch, name, hold) {
  if (!ch.actions[name]) return;
  ch.oneShotT = hold; setClip(ch, name);
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
// Procedural THROW: snap the right arm up-and-over for a beat, then ease back.
// The over-the-top amount tracks the launch angle (a lob lofts more than a
// bullet), so it varies with the throw. Rig-agnostic (just the arm bones).
function applyThrowPose(ch, dt) {
  ch.throwAnimT -= dt;
  if (!ch.upperArm || !ch.upperArmRest) return;
  const t = THREE.MathUtils.clamp(1 - ch.throwAnimT / THROW_ANIM_DUR, 0, 1);
  const w = Math.sin(Math.PI * t); // 0 -> peak -> 0 (cock, release, return)
  const over = THREE.MathUtils.lerp(1.5, 2.2, THREE.MathUtils.clamp(ch.throwLaunch / 0.6, 0, 1));
  _tq.setFromAxisAngle(_xAxisL, -over * w);
  ch.upperArm.quaternion.copy(ch.upperArmRest).multiply(_tq);
  if (ch.foreArm && ch.foreArmRest) {
    _tq.setFromAxisAngle(_xAxisL, -1.2 * w);
    ch.foreArm.quaternion.copy(ch.foreArmRest).multiply(_tq);
  }
  ch.upperArm.updateMatrixWorld(true);
}
// Procedural CATCH: reach BOTH arms toward the ball, the raise scaled by how
// high the ball is relative to the catcher's chest (high ball -> arms up, low
// ball -> arms down) so it varies with the ball/player positions.
function applyCatchPose(ch, ballPos) {
  if (!ch.upperArm || !ch.upperArmRest) return;
  const chestY = ch.group.position.y + 1.15;
  const raise = THREE.MathUtils.clamp(1.0 + (ballPos.y - chestY) * 1.1, 0.15, 2.4);
  _tq.setFromAxisAngle(_xAxisL, -raise);
  ch.upperArm.quaternion.copy(ch.upperArmRest).multiply(_tq); ch.upperArm.updateMatrixWorld(true);
  if (ch.foreArm && ch.foreArmRest) { _tq.setFromAxisAngle(_xAxisL, -0.55); ch.foreArm.quaternion.copy(ch.foreArmRest).multiply(_tq); }
  if (ch.leftArm && ch.leftArmRest) { _tq.setFromAxisAngle(_xAxisL, raise); ch.leftArm.quaternion.copy(ch.leftArmRest).multiply(_tq); ch.leftArm.updateMatrixWorld(true); }
  if (ch.leftForeArm && ch.leftForeArmRest) { _tq.setFromAxisAngle(_xAxisL, 0.55); ch.leftForeArm.quaternion.copy(ch.leftForeArmRest).multiply(_tq); }
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
function applyArmAction(ch, dt) {
  ch.armPoseT -= dt;
  if (!ch.upperArm || !ch.upperArmRest) return;
  const dur = ch.armPoseDur || 0.4;
  const t = THREE.MathUtils.clamp(1 - ch.armPoseT / dur, 0, 1);
  const w = Math.sin(Math.PI * t); // 0 -> peak -> 0 (wind, strike, return)
  const tgt = ch.armPoseTarget;
  const chestY = ch.group.position.y + 1.2;
  const reach = tgt ? THREE.MathUtils.clamp(1.2 + (tgt.y - chestY) * 1.0, 0.4, 2.6) : 1.6;
  if (ch.armPose === 'swat') {
    // One arm slashes up across the ball to bat it down.
    _tq.setFromAxisAngle(_xAxisL, -reach * w);
    ch.upperArm.quaternion.copy(ch.upperArmRest).multiply(_tq);
    if (ch.foreArm && ch.foreArmRest) { _tq.setFromAxisAngle(_xAxisL, -0.4 * w); ch.foreArm.quaternion.copy(ch.foreArmRest).multiply(_tq); }
    ch.upperArm.updateMatrixWorld(true);
  } else { // 'pick' / 'reach' — both hands stab toward the ball
    _tq.setFromAxisAngle(_xAxisL, -reach * w);
    ch.upperArm.quaternion.copy(ch.upperArmRest).multiply(_tq); ch.upperArm.updateMatrixWorld(true);
    if (ch.foreArm && ch.foreArmRest) { _tq.setFromAxisAngle(_xAxisL, -0.5 * w); ch.foreArm.quaternion.copy(ch.foreArmRest).multiply(_tq); }
    if (ch.leftArm && ch.leftArmRest) { _tq.setFromAxisAngle(_xAxisL, reach * w); ch.leftArm.quaternion.copy(ch.leftArmRest).multiply(_tq); ch.leftArm.updateMatrixWorld(true); }
    if (ch.leftForeArm && ch.leftForeArmRest) { _tq.setFromAxisAngle(_xAxisL, 0.5 * w); ch.leftForeArm.quaternion.copy(ch.leftForeArmRest).multiply(_tq); }
  }
}
function updateAnimation(ch, dt) {
  if (ch.ragdolling) return; // bones are physics-driven — the mixer must not fight them
  if (ch.oneShotT > 0) {     // hold a one-shot (juke roll)
    ch.oneShotT -= dt;
    ch.group.rotation.y = ch.heading;
    ch.mixer.update(dt);
    return;
  }
  let want = 'idle';
  if (ch.speed > 11) want = 'sprint';        // turbo / RunFast
  else if (ch.speed > 6) want = 'run';
  else if (ch.speed > 0.5) want = 'walk';
  setClip(ch, want);
  ch.group.rotation.y = ch.heading;
  if (ch.spinT > 0) ch.group.rotation.y += (1 - ch.spinT / 0.5) * Math.PI * 2; // 360 spin move
  ch.mixer.update(dt);
  // Procedural arm overrides (after the mixer), in priority order: securing a
  // catch, throwing, then a one-off arm action (swat a pass / reach at a ball).
  if (ball.mode === 'secured' && ch === ball.catcher) applyCatchPose(ch, ball.mesh.position);
  else if (ch.throwAnimT > 0) applyThrowPose(ch, dt);
  else if (ch.armPoseT > 0) applyArmAction(ch, dt);
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

// A non-ragdolling defender roughly in front of the carrier (within `dist`,
// aligned with his heading) — the target for a stiff-arm truck.
function defenderAhead(ch, dist, dotMin) {
  const hx = Math.sin(ch.heading), hz = Math.cos(ch.heading);
  let best = null, bestD = dist * dist;
  for (const d of game.defense) {
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
function doSpin(ch) {
  if (ch.jukeCd > 0) return;
  const ahead = defenderAhead(ch, 2.8, 0.45);
  if (ahead) { stiffArm(ch, ahead); return; }
  ch.jukeCd = 0.9; ch.jukeTimer = 0.5; ch.spinT = 0.5; // immunity + visual spin
  shake.kick(ch.vel.x, ch.vel.z, 0.18);
  audio.juke();
  showBanner('SPIN!', '#bfffd0');
}
function stiffArm(ch, def) {
  ch.jukeCd = 1.0; ch.jukeTimer = 0.25; // brief immunity as you barrel through
  knockdownDefender(def);               // truck him to the turf (ragdoll)
  ch.vel.x *= 0.82; ch.vel.z *= 0.82;   // small speed cost
  shake.add(0.22); shake.kick(Math.sin(ch.heading), Math.cos(ch.heading), 0.5);
  burst(def.group.position.x, 1.0, def.group.position.z, 0xe8d9a0, 12, 7);
  audio.hit(0.7);
  showBanner('STIFF ARM!', '#ffd23a');
}
// DIVE — a committed forward lunge (hurdles a lone tackler), then you're DOWN.
// Great to reach the sticks or the pylon; risky if you go too early.
function doDive(ch) {
  if (ch.diveT > 0 || ch.jukeCd > 0.6) return;
  const fx = Math.sin(ch.heading), fz = Math.cos(ch.heading);
  const burstSpd = ch.baseSpeed * 1.35;
  ch.vel.x = fx * burstSpd; ch.vel.z = fz * burstSpd;
  ch.diveT = 0.45; ch.jukeTimer = 0.32; // hurdle window
  playOneShot(ch, 'juke', 0.45);
  audio.juke();
  showBanner('DIVE!', '#bfffd0');
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
  const spinEdge = input.spinEdge; input.spinEdge = false;
  const diveEdge = input.diveEdge; input.diveEdge = false;
  const pitchEdge = input.pitchEdge; input.pitchEdge = false;
  tickClock(dt); // game clock / play clock (may auto-snap on delay of game)

  if (game.state === STATE.PRESNAP) {
    if (!game.choosing && game.userOnOffense) aimReceiver();
    if (actionEdge && !game.choosing) { if (game.gameOver) resetGame(); else snap(); }
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
  }

  // Blitz turbo meter: drains while held, refills when released; ON FIRE =
  // unlimited turbo + a hotter whole offense.
  const liveBall = game.state === STATE.LIVE || game.state === STATE.AIR || game.state === STATE.RUN || game.state === STATE.RETURN || game.state === STATE.LOOSE;
  const turboOn = input.turbo && !game.turboLock && (game.onFire || game.turboMeter > 0);
  if (liveBall) game.playClock += dt;
  if (liveBall && turboOn && !game.onFire) {
    game.turboMeter = Math.max(0, game.turboMeter - dt / 2.8);
    if (game.turboMeter <= 0) game.turboLock = true; // flat: wait for a recharge
  } else {
    // Refills whenever it isn't burning — including between plays.
    game.turboMeter = Math.min(1, game.turboMeter + dt / 4);
    if (game.turboLock && game.turboMeter > 0.25) game.turboLock = false;
  }
  turboFillEl.style.height = `${Math.round(game.turboMeter * 100)}%`;
  const fireMul = game.onFire ? 1.12 : 1;

  if (game.state === STATE.LIVE || game.state === STATE.AIR) {
    if (game.userOnOffense) {
      // Pre-throw the QB scrambles with the stick; once the ball's in the air
      // the stick steers the BALL instead (updateBall), so the QB holds.
      if (game.state === STATE.LIVE) {
        const top = game.qb.baseSpeed * fireMul * (turboOn ? TURBO_MULT : 1);
        controlledMove(game.qb, dt, top);
        if (pastLine(game.qb)) enterRun(game.qb, 'Scramble! Run for it!');
      } else { game.qb.speed = 0; game.qb.vel.set(0, 0, 0); }
      updateOffense(dt); updateDefense();
    } else {
      // CPU has the ball: it drops back and throws; you drive a defender.
      updateOffense(dt); updateDefense();
      if (game.state === STATE.LIVE) cpuQB(dt); else { game.qb.speed = 0; game.qb.vel.set(0, 0, 0); }
      if (game.controlled) {
        const top = game.controlled.baseSpeed * (turboOn ? TURBO_MULT : 1);
        controlledMove(game.controlled, dt, top);
      }
    }
    for (const ch of game.all) if (ch !== game.controlled && !ch.ragdolling) applySteer(ch, dt);
  } else if (game.state === STATE.RUN && !game.userOnOffense) {
    updateCpuRun(dt, turboOn, actionEdge); // CPU carrier; you tackle on defense
  } else if (game.state === STATE.RUN) {
    // Move inputs act on the current carrier; a pitch may hand off to a teammate.
    if (actionEdge) doJuke(game.carrier);
    if (spinEdge) doSpin(game.carrier);
    if (diveEdge) doDive(game.carrier);
    if (pitchEdge) doPitch(game.carrier);
    if (game.state === STATE.RUN) { // a botched pitch can have ended the play
      const c = game.carrier;       // (re-fetch: a clean pitch changed the carrier)
      if (c.jukeTimer > 0) c.jukeTimer -= dt;
      if (c.jukeCd > 0) c.jukeCd -= dt;
      if (c.spinT > 0) c.spinT -= dt;
      if (c.diveT > 0) {
        // Locked into the dive: coast forward, then go down at the end of it.
        c.diveT -= dt;
        c.group.position.x += c.vel.x * dt; c.group.position.z += c.vel.z * dt;
        c.vel.x *= 0.95; c.vel.z *= 0.95; c.speed = Math.hypot(c.vel.x, c.vel.z);
        clampToField(c);
        updateOffense(dt); updateDefense();
        for (const ch of game.all) if (ch !== c && !ch.ragdolling) applySteer(ch, dt);
        checkRunOutcome(); // can still score / be gang-tackled mid-dive
        if (game.state === STATE.RUN && c.diveT <= 0) endPlay('tackle', c.group.position.z);
      } else {
        const top = c.baseSpeed * fireMul * (turboOn ? TURBO_MULT : 1);
        controlledMove(c, dt, top);
        updateOffense(dt); updateDefense();
        for (const ch of game.all) if (ch !== game.controlled && !ch.ragdolling) applySteer(ch, dt);
        checkRunOutcome();
      }
    }
  } else if (game.state === STATE.RETURN) {
    if (actionEdge) returnDive();
    if (game.state === STATE.RETURN) updateReturn(dt, turboOn, fireMul);
  } else if (game.state === STATE.LOOSE) {
    updateLoose(dt, turboOn, actionEdge); // scramble for the bouncing ball
  } else if (game.state === STATE.BATTLE) {
    if (actionEdge) input.battleMash++;
    for (const ch of game.all) if (!ch.ragdolling && ch !== game.carrier && ch !== game.battle.tackler) { ch.speed = 0; ch.vel.set(0, 0, 0); }
    updateBattle(dt);
  } else if (game.state === STATE.TACKLE) {
    // The ragdolls own the moment: hold everyone else, let physics finish the
    // fall, then spot the ball where the pile slid to.
    for (const ch of game.all) if (!ch.ragdolling) { ch.speed = 0; ch.vel.set(0, 0, 0); }
    game.tackleTimer -= dt;
    const settled = game.carrier && game.carrier.ragdoll &&
      game.carrier.ragdoll.active && game.tackleTimer < 1.2 && game.carrier.ragdoll.settled();
    if (game.tackleTimer <= 0 || settled) resolveTackleEnd();
  }

  for (const ch of game.all) updateAnimation(ch, dt);
  updateBall(dt); // after the pose updates so the ball follows the hand bone
  updateTrail(ball.mode === 'flying'); // glowing comet trail while in the air

  if (selRing.visible && game.receivers[game.selected]) {
    const p = game.receivers[game.selected].group.position; selRing.position.set(p.x, 0.03, p.z);
  }
  if (ctrlRing.visible && game.controlled) {
    const p = game.controlled.group.position; ctrlRing.position.set(p.x, 0.03, p.z);
  }
  // Target arrow bobs over the selected receiver while you're picking a throw.
  const showArrow = game.userOnOffense && (game.state === STATE.PRESNAP || game.state === STATE.LIVE) && game.receivers[game.selected];
  targetArrow.visible = showArrow;
  if (showArrow) {
    const p = game.receivers[game.selected].group.position;
    targetArrow.position.set(p.x, 2.9 + Math.sin(performance.now() * 0.006) * 0.18, p.z);
    targetArrow.rotation.y += dt * 2;
  }
  updateParticles(dt);
  if (game.battle.cd > 0) game.battle.cd -= dt;
  if (game.state === STATE.DEAD) { game.deadTimer -= dt; if (game.deadTimer <= 0) newPlay(); }
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
  cine: 0, cineHold: 0,                   // contact-hit close-up amount / hold
};
const _tp = new THREE.Vector3(), _tl = new THREE.Vector3();
const _cinePos = new THREE.Vector3(), _cineLook = new THREE.Vector3();

/** Punch the camera in tight on the action for `hold` seconds (a hit close-up). */
function hitZoom(hold = 0.5) { cam.cineHold = Math.max(cam.cineHold, hold); }

function updateCamera(dt) {
  const t = game.controlled || game.qb;
  const p = t.group.position;
  // On a throw, FOLLOW THE BALL: focus the live ball and trail its flight so
  // you watch the pass travel to the receiver; otherwise focus the player.
  const air = (game.state === STATE.AIR || (game.state === STATE.DEAD && ball.mode === 'flying'));
  const loose = game.state === STATE.LOOSE;
  // An interception runback is a legit reason to look the OTHER way (-Z).
  const ret = game.state === STATE.RETURN || game.returnActive;
  const fp = (air || loose) ? ball.mesh.position : p; // a loose ball is the star

  // Eased heading: trail the ball's travel in the air, behind the runner once
  // he takes off, otherwise locked straight downfield. Eases so it stays smooth.
  let wantYaw;
  if (air) wantYaw = Math.atan2(ball.vx, ball.vz);
  else if (ret) {
    const rb = game.returner || game.carrier;
    const rp = rb ? rb.group.position : p;
    wantYaw = Math.atan2(rp.x - p.x, rp.z - p.z); // chaser looks toward the returner
  } else if (game.state === STATE.RUN || game.state === STATE.TACKLE || game.state === STATE.BATTLE) {
    wantYaw = t.heading;
  } else wantYaw = game.dir > 0 ? 0 : Math.PI; // face the attacking end
  while (wantYaw > Math.PI) wantYaw -= Math.PI * 2;
  while (wantYaw < -Math.PI) wantYaw += Math.PI * 2;
  // Keep the camera framed on the attacking end (game.dir): +Z on your drive,
  // -Z on a CPU drive, and the opposite end during an interception runback.
  const center = ret ? Math.PI : (game.dir > 0 ? 0 : Math.PI);
  let rel = wantYaw - center;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  wantYaw = center + THREE.MathUtils.clamp(rel, -1.15, 1.15); // ~±66° off downfield
  const k = Math.min(1, dt * (air ? 5 : 3));
  cam.fwdX += (Math.sin(wantYaw) - cam.fwdX) * k;
  cam.fwdZ += (Math.cos(wantYaw) - cam.fwdZ) * k;
  const m = Math.hypot(cam.fwdX, cam.fwdZ) || 1;
  cam.fwdX /= m; cam.fwdZ /= m;

  const run = game.state === STATE.RUN || game.state === STATE.RETURN;
  // Pulled in closer so players read clearly (was too far to see the heads).
  const back = air ? 8 : (run ? 6.8 : 7.6);
  const hgt = air ? Math.max(4.6, fp.y + 2.6) : (run ? 4.0 : 4.6);
  const aheadL = air ? 4.5 : 7.5;             // look ahead toward the receiver in flight
  const lookH = air ? (fp.y * 0.55 + 0.8) : 1.5;
  _tp.set(fp.x - cam.fwdX * back, hgt, fp.z - cam.fwdZ * back);
  _tl.set(fp.x + cam.fwdX * aheadL, lookH, fp.z + cam.fwdZ * aheadL);

  // Cinematic hit push-in: a tight 3/4 close-up on the pile that eases in and
  // out on REAL time (so it's smooth no matter how slow the sim runs), plus a
  // real FOV zoom for a clear, smooth zoom-in on the hit.
  const wantCine = cam.cineHold > 0 ? 1 : 0;
  if (cam.cineHold > 0) cam.cineHold -= dt;
  // Symmetric, gentle ease both ways → no snap/jerk into or out of the zoom.
  cam.cine = moveToward(cam.cine, wantCine, dt / (wantCine > cam.cine ? 0.28 : 0.6));
  const e = cam.cine * cam.cine * (3 - 2 * cam.cine); // smoothstep
  if (cam.cine > 0.001) {
    const f = (game.carrier || t).group.position;
    _cinePos.set(f.x + 3.4, 3.6, f.z - 3.0);
    _cineLook.set(f.x, 1.0, f.z);
    _tp.lerp(_cinePos, e); _tl.lerp(_cineLook, e);
  }
  // FOV zoom: 55° -> 34° at full push-in.
  const wantFov = 55 - 21 * e;
  if (Math.abs(camera.fov - wantFov) > 0.01) { camera.fov = wantFov; camera.updateProjectionMatrix(); }

  // Tight follow. Snappier while tracking a thrown ball so the camera stays
  // glued to the fast, short flight instead of lagging behind the QB.
  const lt = Math.min(1, dt * (air ? 16 : 8 + cam.cine * 6));
  cam.pos.lerp(_tp, lt);
  cam.lookCur.lerp(_tl, Math.min(1, lt * 1.2));

  // Shake on top; never let the camera dip into the turf.
  shake.update(dt);
  const cy = Math.max(1.3, cam.pos.y + shake.offY);
  camera.position.set(cam.pos.x + shake.offX, cy, cam.pos.z + shake.offZ);
  camera.lookAt(cam.lookCur);

  sun.position.set(p.x + 40, 70, p.z + 20); sun.target.position.set(p.x, 0, p.z);
}

// ===========================================================================
// Loop
// ===========================================================================
const clock = new THREE.Clock();
function animate() {
  const realDt = Math.min(clock.getDelta(), 0.05);
  // Bullet-time scales the SIM (movement, animation, ragdolls — the slow-mo
  // tackles) while the camera/shake run on real time and stay snappy.
  const dt = realDt * timeScale.update(realDt);
  updatePlay(dt);

  // Advance ragdoll physics by THIS frame's (slow-mo-scaled) dt — substepped,
  // every frame — so the bodies move smoothly in slow motion instead of in
  // visible 1/60 chunks. Then the rigid bodies drive the skinned bones.
  if (physics && anyRagdollActive()) {
    physics.step(Math.min(dt, 1 / 30), (subDt) => {
      for (const ch of game.all)
        if (ch.ragdolling && ch.ragdoll && ch.ragdoll.active) ch.ragdoll.applyLimits(subDt);
    });
    for (const ch of game.all)
      if (ch.ragdolling && ch.ragdoll && ch.ragdoll.active) ch.ragdoll.drive();
  }

  updateCamera(realDt);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

loadAssets().then(() => {
  spawnTeams(); makeBall();
  game.firstDown = game.los + FIRST_DOWN_YDS;
  newPlay();
  loadingEl.classList.add('hidden');
  animate();
}).catch((err) => { console.error(err); loadingText.textContent = 'Failed to load assets. Check the console.'; });



















