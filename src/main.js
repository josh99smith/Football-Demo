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
const TEAM_TINT = { off: new THREE.Color(0x6fa8ff), def: new THREE.Color(0xff6b6b) };

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
    route: null, wp: 0, cutTimer: 0,
    covers: -1, deep: false, assignment: null, zonePoint: null, blockTarget: null,
    ragdoll: null, ragdolling: false,
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
const STATE = { PRESNAP: 'presnap', LIVE: 'live', AIR: 'air', RUN: 'run', TACKLE: 'tackle', DEAD: 'dead' };
const DIR = 1; // offense attacks +Z
const game = {
  state: STATE.PRESNAP,
  offense: [], defense: [], all: [],
  qb: null, controlled: null, carrier: null,
  selected: 5, receivers: [],
  los: -10, firstDown: 0, down: 1,
  scoreOff: 0, scoreDef: 0,
  deadTimer: 0,
  tackleTimer: 0, tackleSpotZ: 0, // ragdoll tackle: hold while physics plays the fall
};

const ball = {
  mesh: null, mode: 'carried', // 'carried' | 'flying'
  t: 0, dur: 1, from: new THREE.Vector3(), to: new THREE.Vector3(), arc: 4, targetRecv: null,
};
function makeBall() {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x6e3b1f, roughness: 0.8 }));
  m.scale.z = 1.7; m.castShadow = true; scene.add(m); ball.mesh = m;
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
  game.qb = makeCharacter('off'); game.qb.role = 'QB'; game.qb.job = 'qb'; game.qb.baseSpeed = 9.0;
  game.offense = [game.qb]; game.receivers = [];
  for (const x of WR_X) {
    const wr = makeCharacter('off'); wr.role = 'WR'; wr.baseSpeed = 8.7;
    game.offense.push(wr); game.receivers.push(wr);
  }
  game.defense = [];
  for (let i = 0; i < 6; i++) {
    const db = makeCharacter('def'); db.role = 'DB'; db.covers = i; db.baseSpeed = 8.4;
    game.defense.push(db);
  }
  const safety = makeCharacter('def'); safety.role = 'S'; safety.deep = true; safety.baseSpeed = 8.2;
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
  for (const d of game.defense) { const dd = dist2(px(d), point); if (dd < bestD) { bestD = dd; best = d; } }
  return best;
}
function assignBlocks(blockForCarrier) {
  const protect = game.carrier || game.qb;
  const blockers = game.offense.filter((o) => o.job === 'block' || (blockForCarrier && o.job !== 'qb' && o !== game.carrier));
  for (const b of blockers) b.blockTarget = null;
  if (!protect) return;
  const pp = px(protect);
  const threats = [...game.defense].sort((a, b) => dist2(px(a), pp) - dist2(px(b), pp));
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
    if (o === game.controlled || o === carrier) continue;
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
  const speed = ch.turbo ? ch.baseSpeed * 1.2 : ch.baseSpeed;
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
const input = { x: 0, y: 0, action: false, turbo: false, actionEdge: false, switchEdge: false };

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
  else if (s === STATE.RUN) { hide(actionBtn); hide(switchBtn); show(turboBtn); }
  else { hide(actionBtn); hide(switchBtn); hide(turboBtn); }
}

// ===========================================================================
// Play flow
// ===========================================================================
function newPlay() {
  clearRagdolls(); // animation clips repose every bone on the next mixer update
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
  const dur = Math.max(0.5, dist / 24);
  const to = flat.add(recv.vel.clone().multiplyScalar(dur * 0.9));
  to.x = clampX(to.x); to.z = THREE.MathUtils.clamp(to.z, -HALF_L + 1, HALF_L - 1); to.y = 1.2;
  ball.mode = 'flying'; ball.t = 0; ball.dur = dur;
  ball.from.copy(from); ball.to.copy(to);
  ball.arc = Math.min(7, dist * 0.18 + 1.5); ball.targetRecv = recv;
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
    game.los = -10; game.down = 1; game.firstDown = game.los + 10;
  } else {
    const gained = result === 'incomplete' ? 0 : endZ - game.los;
    setStatus(result === 'incomplete' ? 'Incomplete'
      : result === 'intercept' ? 'Intercepted!'
        : result === 'oob' ? `Out of bounds (+${Math.max(0, Math.round(gained))})`
          : `Tackled (+${Math.max(0, Math.round(gained))})`);
    if (result === 'intercept') { game.los = -10; game.down = 1; game.firstDown = game.los + 10; }
    else {
      const spot = THREE.MathUtils.clamp(result === 'incomplete' ? game.los : endZ, OWN_GOAL_Z + 5, GOAL_Z - 1);
      if (spot >= game.firstDown) { game.los = spot; game.down = 1; game.firstDown = Math.min(GOAL_Z, game.los + 10); }
      else { game.los = spot; game.down += 1; if (game.down > 4) { game.los = -10; game.down = 1; game.firstDown = game.los + 10; setStatus('Turnover on downs'); } }
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
  for (const db of game.defense) { const d = near(db); if (d < bestDD) bestDD = d; }
  if (bestRD <= CATCH_R && bestRD <= bestDD + 0.3) { ball.mode = 'carried'; enterRun(bestR, 'Caught it! Run!'); return; }
  if (bestDD <= INTERCEPT_R) { ball.mode = 'carried'; endPlay('intercept', game.los); return; }
  ball.mode = 'carried'; endPlay('incomplete', game.los);
}
function checkRunOutcome() {
  const c = game.carrier.group.position;
  if (c.z >= GOAL_Z) { endPlay('TD', c.z); return; }
  if (Math.abs(c.x) > HALF_W || c.z < -HALF_L) { endPlay('oob', c.z); return; }
  for (const db of game.defense)
    if (Math.hypot(db.group.position.x - c.x, db.group.position.z - c.z) <= TACKLE_R) { beginTackle(db); return; }
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

function beginTackle(lead) {
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
  const big = lead.turbo || closing > 9.5;

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
  setStatus(gangSize >= 3 ? 'GANG TACKLE!' : big ? 'BIG HIT!' : 'Tackled!');
  updateButtons();
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
function controlledMove(ch, dt, topSpeed) {
  const kb = kbVec();
  let ix = THREE.MathUtils.clamp(input.x + kb.x, -1, 1);
  let iy = THREE.MathUtils.clamp(input.y + kb.y, -1, 1);
  const mag = Math.min(1, Math.hypot(ix, iy));
  if (mag > 0.06) {
    camera.getWorldDirection(_f); _f.y = 0; _f.normalize();
    _r.crossVectors(_f, THREE.Object3D.DEFAULT_UP).normalize();
    _d.set(0, 0, 0).addScaledVector(_f, iy).addScaledVector(_r, ix).normalize();
    const speed = topSpeed * mag;
    ch.group.position.addScaledVector(_d, speed * dt);
    ch.vel.set(_d.x * speed, 0, _d.z * speed);
    ch.heading = Math.atan2(_d.x, _d.z); ch.speed = speed;
  } else { ch.vel.set(0, 0, 0); ch.speed = 0; }
  clampToField(ch);
}
function updateAnimation(ch, dt) {
  if (ch.ragdolling) return; // bones are physics-driven — the mixer must not fight them
  const want = ch.speed > 0.5 ? (ch.speed > 6 ? 'run' : 'walk') : 'idle';
  setClip(ch, want);
  ch.group.rotation.y = ch.heading;
  ch.mixer.update(dt);
}

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

  if (game.state === STATE.LIVE || game.state === STATE.AIR) {
    const top = game.qb.baseSpeed * (input.turbo ? 1.2 : 1);
    controlledMove(game.qb, dt, top);
    updateOffense(dt); updateDefense();
    for (const ch of game.all) if (ch !== game.controlled) applySteer(ch, dt);
    if (game.state === STATE.LIVE && pastLine(game.qb)) enterRun(game.qb, 'Scramble! Run for it!');
  } else if (game.state === STATE.RUN) {
    const top = game.carrier.baseSpeed * (input.turbo ? 1.22 : 1);
    controlledMove(game.carrier, dt, top);
    updateOffense(dt); updateDefense();
    for (const ch of game.all) if (ch !== game.controlled) applySteer(ch, dt);
    checkRunOutcome();
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
  if (game.state === STATE.DEAD) { game.deadTimer -= dt; if (game.deadTimer <= 0) newPlay(); }
}

// ===========================================================================
// Camera
// ===========================================================================
const camDesired = new THREE.Vector3();
function updateCamera(dt) {
  const t = game.controlled || game.qb;
  const p = t.group.position;
  const yaw = (game.state === STATE.RUN || game.state === STATE.TACKLE) ? t.heading : 0;
  _f.set(Math.sin(yaw), 0, Math.cos(yaw));
  camDesired.set(p.x - _f.x * 11, 6.5, p.z - _f.z * 11);
  camera.position.lerp(camDesired, 1 - Math.pow(0.0016, dt));
  camera.lookAt(p.x, p.y + 1.4, p.z);
  sun.position.set(p.x + 40, 70, p.z + 20); sun.target.position.set(p.x, 0, p.z);
}

// ===========================================================================
// Loop
// ===========================================================================
const clock = new THREE.Clock();
let phAcc = 0; // fixed-step physics accumulator (60 Hz, max 3 steps/frame)
function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  updatePlay(dt);

  // Step ragdoll physics at a fixed 60 Hz; soft joint limits run per-substep,
  // then the rigid bodies drive the skinned bones.
  if (physics && anyRagdollActive()) {
    phAcc = Math.min(phAcc + dt, 3 / 60);
    while (phAcc >= 1 / 60) {
      physics.step((subDt) => {
        for (const ch of game.all)
          if (ch.ragdolling && ch.ragdoll && ch.ragdoll.active) ch.ragdoll.applyLimits(subDt);
      });
      phAcc -= 1 / 60;
    }
    for (const ch of game.all)
      if (ch.ragdolling && ch.ragdoll && ch.ragdoll.active) ch.ragdoll.drive();
  }

  updateCamera(dt);
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
  game.firstDown = game.los + 10;
  newPlay();
  loadingEl.classList.add('hidden');
  animate();
}).catch((err) => { console.error(err); loadingText.textContent = 'Failed to load assets. Check the console.'; });
