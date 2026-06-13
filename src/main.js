import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { PhysicsWorld, TackleRagdoll, pickVariant } from './ragdoll.js';

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

// ===========================================================================
// Assets + character factory
// ===========================================================================
const loader = new GLTFLoader();
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const loadGLB = (u) => new Promise((res, rej) => loader.load(u, res, undefined, rej));

let charTemplate, idleClip, walkClip, runClip;
let SCALE = 1, GROUND_Y = 0;
// Team uniforms: home offense in vivid blue, away defense in a distinct
// purple so the two squads never read alike on the field.
const TEAM_TINT = { off: new THREE.Color(0x3f7bff), def: new THREE.Color(0x8e3bff) };

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
  loadingText.textContent = 'Loading animations…';
  const animGltf = await loadGLB('assets/animations.glb');
  loadingText.textContent = 'Starting physics…';
  try { physics = await PhysicsWorld.create(); }
  catch (e) { console.warn('Physics unavailable — tackles will be instant', e); }
  charTemplate = charGltf.scene;
  idleClip = charGltf.animations[0];
  const byName = {};
  for (const c of animGltf.animations) byName[c.name] = c;
  walkClip = byName['Walking']; runClip = byName['Running'];
  const raw = measureBoneSpan(charTemplate);
  SCALE = 1.8 / raw.span;
  GROUND_Y = -(raw.lo * SCALE - 0.05);
}

function makeCharacter(team) {
  const model = cloneSkeleton(charTemplate);
  model.scale.multiplyScalar(SCALE);
  model.position.y = GROUND_Y;
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.frustumCulled = false;
      o.material = o.material.clone();
      o.material.color = o.material.color.clone().multiply(TEAM_TINT[team]);
    }
  });
  const group = new THREE.Group();
  group.add(model);
  scene.add(group);
  const mixer = new THREE.AnimationMixer(model);
  const mk = (clip) => {
    const a = mixer.clipAction(clip);
    a.setLoop(THREE.LoopRepeat, Infinity); a.enabled = true;
    a.setEffectiveWeight(0); a.play(); return a;
  };
  const actions = { idle: mk(idleClip), walk: mk(walkClip), run: mk(runClip) };
  actions.idle.setEffectiveWeight(1);
  return {
    group, model, mixer, actions, current: 'idle', active: actions.idle,
    team, role: 'WR', job: 'idle', heading: 0,
    vel: new THREE.Vector3(), speed: 0, baseSpeed: 8.4, turbo: false,
    home: new THREE.Vector3(), desired: { x: 0, z: 0 },
    route: null, wp: 0, cutTimer: 0, jukeTimer: 0, jukeCd: 0,
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
const STATE = { PRESNAP: 'presnap', LIVE: 'live', AIR: 'air', RUN: 'run', TACKLE: 'tackle', BATTLE: 'battle', DEAD: 'dead' };
const DIR = 1; // offense attacks +Z
// NFL Blitz rules: 30 yards for a first down, drives start on your own 20.
const DRIVE_START = -30, FIRST_DOWN_YDS = 30;
const game = {
  state: STATE.PRESNAP,
  offense: [], defense: [], all: [],
  qb: null, controlled: null, carrier: null,
  selected: 5, receivers: [],
  los: DRIVE_START, firstDown: 0, down: 1,
  scoreOff: 0, scoreDef: 0,
  deadTimer: 0,
  tackleTimer: 0, tackleSpotZ: 0, // ragdoll tackle: hold while physics plays the fall
  // Blitz systems: draining turbo meter, ON FIRE after 3 straight TDs.
  turboMeter: 1, turboLock: false, onFire: false, fireCount: 0,
  playClock: 0, lastBreak: -10,
  battle: { val: 0.5, timer: 0, tackler: null, cd: 0, flash: 0 },
};

const ball = {
  mesh: null, mode: 'carried', // 'carried' | 'flying'
  t: 0, dur: 1, from: new THREE.Vector3(), to: new THREE.Vector3(), arc: 4, targetRecv: null,
};
function makeBall() {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x6e3b1f, roughness: 0.8 }));
  m.scale.z = 1.7; m.castShadow = true; scene.add(m); ball.mesh = m;
  const flame = new THREE.PointLight(0xff6622, 0, 6); // lit while ON FIRE
  m.add(flame); ball.flame = flame;
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

const WR_X = [-24, -16, -8, 8, 16, 24];
const clampX = (x) => THREE.MathUtils.clamp(x, -HALF_W + 1.5, HALF_W - 1.5);

function buildRoute(sx, los) {
  const toMid = Math.sign(-sx) || 1, toSide = Math.sign(sx) || 1;
  const P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + dz);
  switch (WR_X.indexOf(sx)) {
    case 0: return [P(sx, 12), P(sx + toSide * 8, 26)];   // corner
    case 1: return [P(sx, 12), P(sx + toMid * 10, 30)];   // post
    case 2: return [P(sx + toMid * 7, 9)];                // slant
    case 3: return [P(sx, 14), P(sx, 11)];                // curl
    case 4: return [P(sx, 9), P(sx + toSide * 9, 10)];    // out
    default: return [P(sx, 40)];                          // go
  }
}

function spawnTeams() {
  game.qb = makeCharacter('off'); game.qb.role = 'QB'; game.qb.job = 'qb'; game.qb.baseSpeed = 9.6; game.qb.strength = 0.95;
  game.offense = [game.qb]; game.receivers = [];
  for (const x of WR_X) {
    const wr = makeCharacter('off'); wr.role = 'WR'; wr.baseSpeed = 9.3; wr.strength = 0.92;
    game.offense.push(wr); game.receivers.push(wr);
  }
  game.defense = [];
  for (let i = 0; i < 6; i++) {
    const db = makeCharacter('def'); db.role = 'DB'; db.covers = i; db.baseSpeed = 9.0; db.strength = 0.95;
    game.defense.push(db);
  }
  const safety = makeCharacter('def'); safety.role = 'S'; safety.deep = true; safety.baseSpeed = 8.8; safety.strength = 1.05;
  game.defense.push(safety);
  game.all = [...game.offense, ...game.defense];
}

function placeFormation() {
  const L = game.los;
  setPos(game.qb, 0, L - 6); game.qb.heading = 0; game.qb.home.set(0, 0, L - 6);
  game.receivers.forEach((wr, i) => {
    setPos(wr, WR_X[i], L - 0.5); wr.heading = 0; wr.route = null; wr.wp = 0; wr.cutTimer = 0;
    wr.job = 'idle'; wr.home.set(WR_X[i], 0, L - 0.5);
  });
  game.defense.forEach((db, i) => {
    if (db.deep) { setPos(db, 0, L + 16); db.home.set(0, 0, L + 16); }
    else { setPos(db, WR_X[i] * 0.85, L + 4); db.home.set(WR_X[i] * 0.85, 0, L + 4); }
    db.heading = Math.PI; db.assignment = null; db.zonePoint = null; db.blockTarget = null;
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
const pastLine = (p) => px(p).z > game.los + 1;

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
  const downSpeed = Math.max(0, carrier.vel.z);       // gaining ground toward +Z
  const lead = Math.min(4, downSpeed * 0.45);          // cut-off leverage
  return { x: predX, z: Math.max(predZ, cp.z + lead) };
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
function updateDefense() {
  const carrier = game.carrier;
  const carrierIsRunning = !!carrier && (carrier.role !== 'QB' || pastLine(carrier));
  const inAir = ball.mode === 'flying';
  for (const d of game.defense) {
    if (d.ragdolling) continue; // knocked down mid-play (whiff / broken tackle)
    const dp = px(d);
    let steer = { x: 0, z: 0 };
    if (carrierIsRunning && carrier) {
      const ip = interceptPoint(d, carrier);
      steer = seek(dp, ip.x, ip.z);
      d.turbo = dist2(dp, px(carrier)) > 4 * 4;
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
        const cushion = seek(dp, ap.x, ap.z + DIR * 1.4); // goal-side leverage
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
  const backEdge = Math.abs(HALF_L - p.z); // back of attacking end zone (+Z)
  if (backEdge < BACK_MARGIN) o.desired.z -= (1 - backEdge / BACK_MARGIN) * 1.8;
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
      if (o.route && o.wp < o.route.length) {
        const wp = o.route[o.wp];
        const d = distXZ(p, wp);
        steer = seek(p, wp.x, wp.z);
        o.turbo = d > 2 || o.cutTimer > 0;
        if (d < ROUTE_REACH) { o.wp++; o.cutTimer = coverD < 3 ? 0.55 : 0.4; }
      } else if (cover && coverD < 6) {
        const away = Math.sign(p.x - px(cover).x) || 1;
        steer = { x: away, z: DIR * 0.55 }; o.turbo = true;
        if (coverD < 2.6) o.cutTimer = 0.3;
      } else { steer = { x: 0, z: DIR * 0.7 }; o.turbo = false; }
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
const input = { x: 0, y: 0, action: false, turbo: false, actionEdge: false, switchEdge: false, battleMash: 0 };

(function joystick() {
  const base = document.getElementById('joystick');
  const knob = document.getElementById('joystick-knob');
  const maxR = 48; let id = null, cx = 0, cy = 0;
  const start = (e) => {
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
const switchBtn = document.getElementById('switch-btn');
const turboBtn = document.getElementById('turbo-btn');
(function buttons() {
  const press = (el, on, off) => {
    const d = (e) => { e.preventDefault(); el.classList.add('active'); on(); };
    const u = (e) => { if (e) e.preventDefault(); el.classList.remove('active'); off && off(); };
    el.addEventListener('touchstart', d, { passive: false });
    el.addEventListener('touchend', u, { passive: false });
    el.addEventListener('touchcancel', u);
    el.addEventListener('mousedown', d);
    window.addEventListener('mouseup', u);
  };
  press(actionBtn, () => { input.action = true; input.actionEdge = true; }, () => { input.action = false; });
  press(turboBtn, () => { input.turbo = true; }, () => { input.turbo = false; });
  press(switchBtn, () => { input.switchEdge = true; });
})();

const keys = {};
window.addEventListener('keydown', (e) => {
  if (!keys[e.code]) {
    if (e.code === 'Space') input.actionEdge = true;
    if (e.code === 'KeyE' || e.code === 'Tab') { input.switchEdge = true; e.preventDefault(); }
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
const ordinal = (n) => ['1st', '2nd', '3rd', '4th'][n - 1] || n + 'th';
function updateHUD() {
  elScoreOff.textContent = game.scoreOff;
  elScoreDef.textContent = game.scoreDef;
  const toGo = game.firstDown >= GOAL_Z ? 'Goal' : Math.max(1, Math.ceil(game.firstDown - game.los));
  elDown.textContent = `${ordinal(game.down)} & ${toGo}`;
}
function setStatus(text) {
  elStatus.textContent = text;
  elStatus.classList.remove('flash'); void elStatus.offsetWidth; elStatus.classList.add('flash');
}
function show(el, label) { el.classList.remove('hidden'); if (label) el.textContent = label; }
function hide(el) { el.classList.add('hidden'); }
function updateButtons() {
  const s = game.state;
  if (s === STATE.PRESNAP) { show(actionBtn, 'SNAP'); show(switchBtn, 'RECEIVER ▸'); hide(turboBtn); }
  else if (s === STATE.LIVE) { show(actionBtn, 'THROW'); show(switchBtn, 'RECEIVER ▸'); show(turboBtn); }
  else if (s === STATE.AIR) { hide(actionBtn); hide(switchBtn); show(turboBtn); }
  else if (s === STATE.RUN) { show(actionBtn, 'JUKE'); hide(switchBtn); show(turboBtn); }
  else if (s === STATE.BATTLE) { show(actionBtn, 'MASH!'); hide(switchBtn); hide(turboBtn); }
  else { hide(actionBtn); hide(switchBtn); hide(turboBtn); }
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
function newPlay() {
  clearRagdolls(); // animation clips repose every bone on the next mixer update
  battleEl.classList.add('hidden'); game.battle.tackler = null;
  placeFormation();
  game.state = STATE.PRESNAP;
  game.controlled = game.qb; game.carrier = null; game.selected = 5;
  ball.mode = 'carried'; ball.targetRecv = null;
  selRing.visible = true; ctrlRing.visible = false;
  updateButtons(); updateHUD();
  setStatus(`${ordinal(game.down)} down — tap SNAP`);
}
function snap() {
  game.state = STATE.LIVE;
  game.playClock = 0; game.lastBreak = -10;
  game.receivers.forEach((wr, i) => { wr.route = buildRoute(WR_X[i], game.los); wr.wp = 0; wr.cutTimer = 0; wr.job = 'route'; });
  game.defense.forEach((db) => { db.job = db.deep ? 'zone' : 'cover'; if (db.deep) db.zonePoint = new THREE.Vector3(0, 0, game.los + 18); });
  setStatus('Find an open receiver, then THROW');
  updateButtons();
}
function throwBall() {
  const recv = game.receivers[game.selected];
  const from = ball.mesh.position.clone();
  const flat = recv.group.position.clone(); flat.y = 0;
  const dist = from.clone().setY(0).distanceTo(flat);
  const dur = Math.max(0.4, dist / 32); // Blitz bullet passes
  const to = flat.add(recv.vel.clone().multiplyScalar(dur * 0.9));
  to.x = clampX(to.x); to.z = THREE.MathUtils.clamp(to.z, -HALF_L + 1, HALF_L - 1); to.y = 1.2;
  ball.mode = 'flying'; ball.t = 0; ball.dur = dur;
  ball.from.copy(from); ball.to.copy(to);
  ball.arc = Math.min(4.5, dist * 0.10 + 1.2); ball.targetRecv = recv;
  game.state = STATE.AIR; selRing.visible = false;
  setStatus('Pass is up…'); updateButtons();
}
function enterRun(player, msg) {
  game.state = STATE.RUN;
  game.carrier = player; game.controlled = player;
  player.route = null;
  ball.mode = 'carried';
  ctrlRing.visible = true; selRing.visible = false;
  setStatus(msg); updateButtons();
}
function endPlay(result, endZ) {
  game.state = STATE.DEAD; game.deadTimer = 1.4;
  selRing.visible = false; ctrlRing.visible = false; updateButtons();
  if (result === 'TD') {
    game.scoreOff += 7; setStatus('TOUCHDOWN! 🏈');
    game.fireCount++;
    if (game.fireCount >= 3 && !game.onFire) {
      game.onFire = true; setFireVisual(true);
      showBanner('ON FIRE!', '#ff7a3a');
      setStatus('3 straight TDs — your team is ON FIRE! 🔥');
    } else showBanner('TOUCHDOWN!', '#ffd23a');
    timeScale.slow(0.45, 0.5);
    shake.add(0.3);
    game.los = DRIVE_START; game.down = 1; game.firstDown = game.los + FIRST_DOWN_YDS;
  } else {
    const gained = result === 'incomplete' ? 0 : endZ - game.los;
    setStatus(result === 'incomplete' ? 'Incomplete'
      : result === 'intercept' ? 'Intercepted!'
        : result === 'oob' ? `Out of bounds (+${Math.max(0, Math.round(gained))})`
          : `Tackled (+${Math.max(0, Math.round(gained))})`);
    if (result === 'intercept') { douseFire(); game.los = DRIVE_START; game.down = 1; game.firstDown = game.los + FIRST_DOWN_YDS; }
    else {
      const spot = THREE.MathUtils.clamp(result === 'incomplete' ? game.los : endZ, OWN_GOAL_Z + 5, GOAL_Z - 1);
      if (spot >= game.firstDown) { game.los = spot; game.down = 1; game.firstDown = Math.min(GOAL_Z, game.los + FIRST_DOWN_YDS); }
      else { game.los = spot; game.down += 1; if (game.down > 4) { douseFire(); game.los = DRIVE_START; game.down = 1; game.firstDown = game.los + FIRST_DOWN_YDS; setStatus('Turnover on downs'); } }
    }
  }
  updateHUD();
}

// ===========================================================================
// Ball + outcomes
// ===========================================================================
const TACKLE_R = 1.5, CATCH_R = 3.0, INTERCEPT_R = 1.7;
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _d = new THREE.Vector3();

const _hips = new THREE.Vector3();
function updateBall(dt) {
  if (ball.mode === 'carried') {
    const h = game.carrier || game.qb;
    if (h.ragdolling && h.ragdoll && h.ragdoll.active) {
      // Tucked with the falling body: track the carrier's physics-driven hips.
      const hips = h.ragdoll.tryBone('Hips');
      if (hips) { hips.getWorldPosition(_hips); ball.mesh.position.set(_hips.x, Math.max(0.2, _hips.y), _hips.z); return; }
    }
    const p = h.group.position;
    _f.set(Math.sin(h.heading), 0, Math.cos(h.heading));
    ball.mesh.position.set(p.x + _f.x * 0.4, 1.25, p.z + _f.z * 0.4);
    ball.mesh.rotation.y = h.heading;
  } else if (ball.mode === 'flying') {
    ball.t += dt / ball.dur; const t = Math.min(1, ball.t);
    ball.mesh.position.lerpVectors(ball.from, ball.to, t);
    ball.mesh.position.y = THREE.MathUtils.lerp(ball.from.y, ball.to.y, t) + ball.arc * Math.sin(Math.PI * t);
    ball.mesh.rotation.x += dt * 8;
    if (ball.t >= 1) resolvePass();
  }
}
function resolvePass() {
  const p = ball.to;
  const near = (ch) => Math.hypot(ch.group.position.x - p.x, ch.group.position.z - p.z);
  let bestR = null, bestRD = Infinity;
  for (const wr of game.receivers) { const d = near(wr); if (d < bestRD) { bestRD = d; bestR = wr; } }
  let bestDD = Infinity;
  for (const db of game.defense) { if (db.ragdolling) continue; const d = near(db); if (d < bestDD) bestDD = d; }
  if (bestRD <= CATCH_R && bestRD <= bestDD + 0.3) {
    ball.mode = 'carried';
    timeScale.slow(0.7, 0.14); // a beat on the catch so the takeover reads
    enterRun(bestR, 'Caught it! Run!');
    return;
  }
  if (bestDD <= INTERCEPT_R) {
    ball.mode = 'carried';
    showBanner('PICKED OFF!', '#ff5a3a');
    shake.add(0.3);
    endPlay('intercept', game.los);
    return;
  }
  ball.mode = 'carried'; endPlay('incomplete', game.los);
}
function checkRunOutcome() {
  const c = game.carrier.group.position;
  if (c.z >= GOAL_Z) { endPlay('TD', c.z); return; }
  if (Math.abs(c.x) > HALF_W || c.z < -HALF_L) { endPlay('oob', c.z); return; }
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
const BATTLE_CHANCE = 0.34;  // a lone clean hit kicks off a duel this often
const BATTLE_TIME = 2.6;     // seconds before it resolves on whoever leads
const BATTLE_TAP = 0.085;    // meter toward break per mash
const BATTLE_CPU = 0.24;     // meter drift/s toward the tackle
const battleEl = document.getElementById('battle');
const battleFill = document.getElementById('battle-fill');
const battleDiv = document.getElementById('battle-div');
const battlePrompt = document.getElementById('battle-prompt');
// Tapping anywhere on the battle overlay also counts as a mash.
battleEl.addEventListener('touchstart', (e) => { e.preventDefault(); input.battleMash++; }, { passive: false });
battleEl.addEventListener('mousedown', () => { input.battleMash++; });

function startBattle(tackler) {
  const b = game.battle;
  b.val = 0.5; b.timer = BATTLE_TIME; b.tackler = tackler; b.flash = 0;
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
  b.tackler = null; b.cd = 3.0;
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

  // A committed tackle (a lost battle) skips every escape — straight down.
  // Blitz: a well-timed JUKE makes the first man whiff right past — and down.
  if (!force && carrier.jukeTimer > 0) {
    carrier.jukeTimer = 0;
    knockdownDefender(lead);
    shake.add(0.15);
    setStatus('WHIFF!');
    return;
  }

  // Tecmo-style 1-on-1 BATTLE: a clean, lone hit can kick off a mash duel
  // (ported from TackleEngine.struggle). Big committed hits go straight down.
  if (!force && !big && gangSize === 1 && game.battle.cd <= 0 && Math.random() < BATTLE_CHANCE) {
    startBattle(lead);
    return;
  }

  // Broken tackle: strength + momentum vs the pile (TackleEngine.tryBreak).
  if (!force && !big && tryBreak(carrier, pile)) {
    knockdownDefender(lead);
    carrier.vel.x *= 0.8; carrier.vel.z *= 0.8;
    shake.add(0.2);
    shake.kick(carrier.vel.x, carrier.vel.z, 0.4);
    showBanner('BROKE IT!', '#bfffd0');
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
  const bits = [0x0004, 0x0008];
  for (let i = 0; i < Math.min(pile.length, RAGDOLL_MAX - 1); i++) {
    const t = pile[i];
    spawnRagdoll(t, new THREE.Vector3(t.vel.x, 0, t.vel.z), back, hitSpeed * 0.55, bits[i] ?? 0x0004,
      i === 0 ? 'highKnock' : 'sideSwipe');
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
  const gang = gangSize >= 3;
  shake.kick(hitX, hitZ, big ? 0.9 : gang ? 0.7 : 0.35);
  if (big || gang) {
    if (gang) { timeScale.bulletTime(0.1, 0.7, 1.1); hitZoom(1.5); }
    else { timeScale.bulletTime(0.14, 0.55, 0.95); hitZoom(1.2); }
    shake.add(gang ? 0.72 : 0.5);
    showBanner(gang ? 'GANG TACKLE!' : 'BIG HIT!', gang ? '#ff9a3a' : '#ff5a3a');
  } else {
    timeScale.bulletTime(0.22, 0.4, 0.7);
    hitZoom(0.9);
    shake.add(0.18);
  }
  setStatus(gang ? 'GANG TACKLE!' : big ? 'BIG HIT!' : 'Tackled!');
}

function anyRagdollActive() {
  for (const ch of game.all) if (ch.ragdolling && ch.ragdoll && ch.ragdoll.active) return true;
  return false;
}

function clearRagdolls() {
  for (const ch of game.all) {
    if (ch.ragdoll) ch.ragdoll.dispose();
    ch.ragdolling = false;
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
function updateAnimation(ch, dt) {
  if (ch.ragdolling) return; // bones are physics-driven — the mixer must not fight them
  const want = ch.speed > 0.5 ? (ch.speed > 6 ? 'run' : 'walk') : 'idle';
  setClip(ch, want);
  ch.group.rotation.y = ch.heading;
  ch.mixer.update(dt);
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
}
const turboFillEl = document.getElementById('turbo-fill');

// ===========================================================================
// Main per-frame
// ===========================================================================
function updatePlay(dt) {
  const actionEdge = input.actionEdge; input.actionEdge = false;
  const switchEdge = input.switchEdge; input.switchEdge = false;

  if (game.state === STATE.PRESNAP) {
    if (switchEdge) game.selected = (game.selected + 1) % game.receivers.length;
    if (actionEdge) snap();
  } else if (game.state === STATE.LIVE) {
    if (switchEdge) game.selected = (game.selected + 1) % game.receivers.length;
    if (actionEdge) throwBall();
  }

  // Blitz turbo meter: drains while held, refills when released; ON FIRE =
  // unlimited turbo + a hotter whole offense.
  const liveBall = game.state === STATE.LIVE || game.state === STATE.AIR || game.state === STATE.RUN;
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
    const top = game.qb.baseSpeed * fireMul * (turboOn ? TURBO_MULT : 1);
    controlledMove(game.qb, dt, top);
    updateOffense(dt); updateDefense();
    for (const ch of game.all) if (ch !== game.controlled && !ch.ragdolling) applySteer(ch, dt);
    if (game.state === STATE.LIVE && pastLine(game.qb)) enterRun(game.qb, 'Scramble! Run for it!');
  } else if (game.state === STATE.RUN) {
    if (actionEdge) doJuke(game.carrier);
    if (game.carrier.jukeTimer > 0) game.carrier.jukeTimer -= dt;
    if (game.carrier.jukeCd > 0) game.carrier.jukeCd -= dt;
    const top = game.carrier.baseSpeed * fireMul * (turboOn ? TURBO_MULT : 1);
    controlledMove(game.carrier, dt, top);
    updateOffense(dt); updateDefense();
    for (const ch of game.all) if (ch !== game.controlled && !ch.ragdolling) applySteer(ch, dt);
    checkRunOutcome();
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
    if (game.tackleTimer <= 0 || settled) endPlay('tackle', game.tackleSpotZ);
  }

  updateBall(dt);
  for (const ch of game.all) updateAnimation(ch, dt);

  if (selRing.visible && game.receivers[game.selected]) {
    const p = game.receivers[game.selected].group.position; selRing.position.set(p.x, 0.03, p.z);
  }
  if (ctrlRing.visible && game.controlled) {
    const p = game.controlled.group.position; ctrlRing.position.set(p.x, 0.03, p.z);
  }
  if (game.battle.cd > 0) game.battle.cd -= dt;
  if (game.state === STATE.DEAD) { game.deadTimer -= dt; if (game.deadTimer <= 0) newPlay(); }
}

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

  // Eased heading: behind the runner once he takes off; otherwise locked
  // straight downfield. Only changes when the player actually turns — the cam
  // no longer pans sideways toward receivers, so it stays steady.
  const wantYaw = (game.state === STATE.RUN || game.state === STATE.TACKLE || game.state === STATE.BATTLE)
    ? t.heading : 0;
  const k = Math.min(1, dt * 3);
  cam.fwdX += (Math.sin(wantYaw) - cam.fwdX) * k;
  cam.fwdZ += (Math.cos(wantYaw) - cam.fwdZ) * k;
  const m = Math.hypot(cam.fwdX, cam.fwdZ) || 1;
  cam.fwdX /= m; cam.fwdZ /= m;

  // Steady chase: look straight ahead of the player along the cam heading.
  const lx = p.x + cam.fwdX * 9, lz = p.z + cam.fwdZ * 9;
  const run = game.state === STATE.RUN;
  _tp.set(p.x - cam.fwdX * (run ? 9 : 10.5), run ? 5.2 : 6.3, p.z - cam.fwdZ * (run ? 9 : 10.5));
  _tl.set(lx, 1.3, lz);

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

  // Tight follow. A constant real-time smoothing keeps the close-up gliding
  // rather than the variable boost that made it lurch in.
  const lt = Math.min(1, dt * (8 + cam.cine * 6));
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
