import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

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
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 250;
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

  const surround = new THREE.Mesh(
    new THREE.PlaneGeometry(420, 420),
    new THREE.MeshStandardMaterial({ color: 0x2e7d32 }));
  surround.rotation.x = -Math.PI / 2; surround.position.y = -0.02;
  surround.receiveShadow = true; field.add(surround);

  const stripes = 12, sl = FIELD_L / stripes;
  for (let i = 0; i < stripes; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_W, sl),
      new THREE.MeshStandardMaterial({ color: i % 2 ? 0x2f6f33 : 0x357a38 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, 0, -HALF_L + sl * (i + 0.5));
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

// Marker rings under players
function makeRing(color) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(0.7, 0.95, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.03; m.visible = false;
  scene.add(m); return m;
}
const selRing = makeRing(0xffd54a);   // targeted receiver
const ctrlRing = makeRing(0xffffff);  // player-controlled

// ===========================================================================
// Assets + character factory
// ===========================================================================
const loader = new GLTFLoader();
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const loadGLB = (u) => new Promise((res, rej) => loader.load(u, res, undefined, rej));

let charTemplate, idleClip, walkClip, runClip;
let SCALE = 1, GROUND_Y = 0;

const TEAM_TINT = {
  off: new THREE.Color(0x6fa8ff),
  def: new THREE.Color(0xff6b6b),
};

function measureBoneSpan(root) {
  root.updateWorldMatrix(true, true);
  const wp = new THREE.Vector3();
  let lo = Infinity, hi = -Infinity;
  root.traverse((o) => {
    if (o.isBone) { o.getWorldPosition(wp); lo = Math.min(lo, wp.y); hi = Math.max(hi, wp.y); }
  });
  return { lo, hi, span: hi - lo };
}

async function loadAssets() {
  loadingText.textContent = 'Loading character…';
  const charGltf = await loadGLB('assets/character.glb');
  loadingText.textContent = 'Loading animations…';
  const animGltf = await loadGLB('assets/animations.glb');

  charTemplate = charGltf.scene;
  idleClip = charGltf.animations[0];
  const byName = {};
  for (const c of animGltf.animations) byName[c.name] = c;
  walkClip = byName['Walking'];
  runClip = byName['Running'];

  // Skinned-mesh-safe scaling (Box3 mis-measures these skinned bounds).
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
      o.castShadow = true;
      o.frustumCulled = false;
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
    group, mixer, actions, current: 'idle', active: actions.idle,
    team, role: 'WR', heading: 0,
    vel: new THREE.Vector3(), speed: 0,
    route: null, wp: 0, covers: -1, deep: false,
  };
}

function setClip(ch, name) {
  if (ch.current === name) return;
  const next = ch.actions[name];
  next.reset(); next.enabled = true;
  next.setEffectiveTimeScale(1); next.setEffectiveWeight(1);
  next.crossFadeFrom(ch.active, 0.2, false); next.play();
  ch.active = next; ch.current = name;
}

// ===========================================================================
// Game state
// ===========================================================================
const STATE = { PRESNAP: 'presnap', LIVE: 'live', AIR: 'air', RUN: 'run', DEAD: 'dead' };
const game = {
  state: STATE.PRESNAP,
  offense: [], defense: [], all: [],
  qb: null, controlled: null, carrier: null,
  selected: 0,           // index into receivers (skill players, not QB)
  receivers: [],
  los: -10, firstDown: 0, down: 1,
  scoreOff: 0, scoreDef: 0,
  deadTimer: 0, deadResult: '',
};

const ball = {
  mesh: null, mode: 'carried', // 'carried' | 'flying' | 'loose'
  t: 0, dur: 1, from: new THREE.Vector3(), to: new THREE.Vector3(), arc: 4,
  targetRecv: null,
};

function makeBall() {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x6e3b1f, roughness: 0.8 }));
  m.scale.z = 1.7; m.castShadow = true; scene.add(m);
  ball.mesh = m;
}

// --- Formation & routes -----------------------------------------------------
const WR_X = [-24, -16, -8, 8, 16, 24];

function clampX(x) { return THREE.MathUtils.clamp(x, -HALF_W + 1.5, HALF_W - 1.5); }

function buildRoute(sx, los) {
  const toMid = Math.sign(-sx) || 1;
  const toSide = Math.sign(sx) || 1;
  const P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + dz);
  // pick a route by lane
  const lane = WR_X.indexOf(sx);
  switch (lane) {
    case 0: return [P(sx, 12), P(sx + toSide * 8, 26)];        // corner
    case 1: return [P(sx, 12), P(sx + toMid * 10, 30)];        // post
    case 2: return [P(sx + toMid * 7, 9)];                     // slant
    case 3: return [P(sx, 14), P(sx, 11)];                     // curl
    case 4: return [P(sx, 9), P(sx + toSide * 9, 10)];         // out
    default: return [P(sx, 40)];                               // go
  }
}

function spawnTeams() {
  game.qb = makeCharacter('off'); game.qb.role = 'QB';
  game.offense = [game.qb];
  game.receivers = [];
  for (const x of WR_X) {
    const wr = makeCharacter('off'); wr.role = 'WR';
    game.offense.push(wr); game.receivers.push(wr);
  }
  game.defense = [];
  for (let i = 0; i < 6; i++) {
    const db = makeCharacter('def'); db.role = 'DB'; db.covers = i;
    game.defense.push(db);
  }
  const safety = makeCharacter('def'); safety.role = 'S'; safety.deep = true;
  safety.covers = 1; // help on the post
  game.defense.push(safety);

  game.all = [...game.offense, ...game.defense];
}

function placeFormation() {
  const L = game.los;
  setPos(game.qb, 0, L - 6); game.qb.heading = 0;
  game.receivers.forEach((wr, i) => {
    setPos(wr, WR_X[i], L - 0.5); wr.heading = 0; wr.route = null; wr.wp = 0;
  });
  game.defense.forEach((db, i) => {
    if (db.deep) setPos(db, 0, L + 16);
    else setPos(db, WR_X[i] * 0.85, L + 4);
    db.heading = Math.PI;
  });
}

function setPos(ch, x, z) {
  ch.group.position.set(x, 0, z);
  ch.vel.set(0, 0, 0); ch.speed = 0;
}

// ===========================================================================
// Input
// ===========================================================================
const input = { x: 0, y: 0, action: false, actionEdge: false, switchEdge: false };

(function joystick() {
  const base = document.getElementById('joystick');
  const knob = document.getElementById('joystick-knob');
  const maxR = 48; let id = null, cx = 0, cy = 0;
  const start = (e) => {
    const t = e.changedTouches ? e.changedTouches[0] : e;
    const r = base.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    id = e.changedTouches ? t.identifier : 'mouse'; move(e);
  };
  const move = (e) => {
    if (id === null) return;
    let t;
    if (e.changedTouches) { t = [...e.changedTouches].find((c) => c.identifier === id); if (!t) return; }
    else t = e;
    let dx = t.clientX - cx, dy = t.clientY - cy;
    const d = Math.hypot(dx, dy);
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
(function buttons() {
  const down = (el, fn) => {
    const on = (e) => { e.preventDefault(); el.classList.add('active'); fn(); };
    el.addEventListener('touchstart', on, { passive: false });
    el.addEventListener('mousedown', on);
  };
  const up = (el) => {
    const off = (e) => { if (e) e.preventDefault(); el.classList.remove('active'); };
    el.addEventListener('touchend', off, { passive: false });
    el.addEventListener('touchcancel', off);
    window.addEventListener('mouseup', off);
  };
  down(actionBtn, () => { input.action = true; input.actionEdge = true; });
  up(actionBtn);
  actionBtn.addEventListener('touchend', () => { input.action = false; });
  actionBtn.addEventListener('mouseup', () => { input.action = false; });
  window.addEventListener('mouseup', () => { input.action = false; });
  down(switchBtn, () => { input.switchEdge = true; });
  up(switchBtn);
})();

// keyboard (desktop)
const keys = {};
window.addEventListener('keydown', (e) => {
  if (!keys[e.code]) {
    if (e.code === 'Space') input.actionEdge = true;
    if (e.code === 'KeyE' || e.code === 'Tab') { input.switchEdge = true; e.preventDefault(); }
  }
  keys[e.code] = true;
  if (e.code === 'Space') input.action = true;
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; if (e.code === 'Space') input.action = false; });
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

function ordinal(n) { return ['1st', '2nd', '3rd', '4th'][n - 1] || n + 'th'; }
function updateHUD() {
  elScoreOff.textContent = game.scoreOff;
  elScoreDef.textContent = game.scoreDef;
  const toGo = GOAL_Z - game.los <= (game.firstDown - game.los)
    ? 'Goal' : Math.max(1, Math.ceil(game.firstDown - game.los));
  elDown.textContent = `${ordinal(game.down)} & ${toGo}`;
}
function setStatus(text) {
  elStatus.textContent = text;
  elStatus.classList.remove('flash'); void elStatus.offsetWidth;
  elStatus.classList.add('flash');
}
function updateButtons() {
  const s = game.state;
  if (s === STATE.PRESNAP) { show(actionBtn, 'SNAP'); show(switchBtn, 'RECEIVER ▸'); }
  else if (s === STATE.LIVE) { show(actionBtn, 'THROW'); show(switchBtn, 'RECEIVER ▸'); }
  else if (s === STATE.RUN) { show(actionBtn, 'SPRINT'); hide(switchBtn); }
  else { hide(actionBtn); hide(switchBtn); }
}
function show(el, label) { el.classList.remove('hidden'); if (label) el.textContent = label; }
function hide(el) { el.classList.add('hidden'); }

// ===========================================================================
// Play flow
// ===========================================================================
function newPlay() {
  placeFormation();
  game.state = STATE.PRESNAP;
  game.controlled = game.qb;
  game.carrier = null;
  game.selected = 5; // default to the deep "go" receiver
  ball.mode = 'carried';
  ball.targetRecv = null;
  selRing.visible = true; ctrlRing.visible = false;
  updateButtons(); updateHUD();
  setStatus(`${ordinal(game.down)} down — tap SNAP`);
}

function snap() {
  game.state = STATE.LIVE;
  for (const wr of game.receivers) { wr.route = buildRoute(WR_X[game.receivers.indexOf(wr)], game.los); wr.wp = 0; }
  setStatus('Find an open receiver, then THROW');
  updateButtons();
}

function throwBall() {
  const recv = game.receivers[game.selected];
  const speed = 24;
  const from = ball.mesh.position.clone();
  // lead the receiver
  const flat = recv.group.position.clone(); flat.y = 0;
  const dist = from.clone().setY(0).distanceTo(flat);
  const dur = Math.max(0.5, dist / speed);
  const lead = recv.vel.clone().multiplyScalar(dur * 0.9);
  const to = flat.add(lead);
  to.x = clampX(to.x); to.z = THREE.MathUtils.clamp(to.z, -HALF_L + 1, HALF_L - 1);
  to.y = 1.2;
  ball.mode = 'flying'; ball.t = 0; ball.dur = dur;
  ball.from.copy(from); ball.to.copy(to);
  ball.arc = Math.min(7, dist * 0.18 + 1.5);
  ball.targetRecv = recv;
  game.state = STATE.AIR;
  selRing.visible = false;
  setStatus('Pass is up…');
  updateButtons();
}

function completeCatch(recv) {
  game.state = STATE.RUN;
  game.carrier = recv; game.controlled = recv;
  recv.route = null;
  ball.mode = 'carried';
  ctrlRing.visible = true;
  setStatus('Caught it! Run for the end zone!');
  updateButtons();
}

function endPlay(result, endZ) {
  game.state = STATE.DEAD;
  game.deadTimer = 1.4; game.deadResult = result;
  selRing.visible = false; ctrlRing.visible = false;
  updateButtons();

  if (result === 'TD') {
    game.scoreOff += 7;
    setStatus('TOUCHDOWN! 🏈');
    game.los = -10; game.down = 1; game.firstDown = game.los + 10;
  } else {
    const gained = (result === 'incomplete') ? 0 : endZ - game.los;
    setStatus(result === 'incomplete' ? 'Incomplete'
      : result === 'intercept' ? 'Intercepted!'
        : result === 'oob' ? `Out of bounds (+${Math.max(0, Math.round(gained))})`
          : `Tackled (+${Math.max(0, Math.round(gained))})`);
    const newSpot = THREE.MathUtils.clamp(
      result === 'incomplete' ? game.los : endZ, OWN_GOAL_Z + 5, GOAL_Z - 1);
    if (result === 'intercept') {
      game.los = -10; game.down = 1; game.firstDown = game.los + 10;
    } else if (newSpot >= game.firstDown) {
      game.los = newSpot; game.down = 1; game.firstDown = Math.min(GOAL_Z, game.los + 10);
    } else {
      game.los = newSpot; game.down += 1;
      if (game.down > 4) { game.los = -10; game.down = 1; game.firstDown = game.los + 10; setStatus('Turnover on downs'); }
    }
  }
  updateHUD();
}

// ===========================================================================
// Per-frame update
// ===========================================================================
const PLAYER_RUN = 9.2, PLAYER_WALK = 4.6;
const WR_SPEED = 8.8, DB_SPEED = 8.0, PURSUIT = 8.5;
const TACKLE_R = 1.5, CATCH_R = 3.0, INTERCEPT_R = 1.7;

const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _d = new THREE.Vector3();

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
    ch.heading = Math.atan2(_d.x, _d.z);
    ch.speed = speed;
  } else ch.speed = 0;
}

function steerTo(ch, tx, tz, speed, dt) {
  _d.set(tx - ch.group.position.x, 0, tz - ch.group.position.z);
  const dist = _d.length();
  if (dist > 0.05) {
    _d.normalize();
    const step = Math.min(speed * dt, dist);
    ch.group.position.addScaledVector(_d, step);
    ch.heading = Math.atan2(_d.x, _d.z);
    ch.speed = speed;
  } else ch.speed = 0;
  return dist;
}

function updateReceiver(wr, dt) {
  if (!wr.route) { wr.speed = 0; return; }
  const before = wr.group.position.clone();
  let target;
  if (game.state === STATE.AIR && ball.targetRecv === wr) {
    target = ball.to;                      // come back to the ball
  } else if (wr.wp < wr.route.length) {
    target = wr.route[wr.wp];
    if (steerTo(wr, target.x, target.z, WR_SPEED, dt) < 1.4) wr.wp++;
    wr.vel.copy(wr.group.position).sub(before).divideScalar(dt || 1);
    return;
  } else {
    target = new THREE.Vector3(wr.group.position.x, 0, GOAL_Z); // streak to end zone
  }
  steerTo(wr, target.x, target.z, WR_SPEED, dt);
  wr.vel.copy(wr.group.position).sub(before).divideScalar(dt || 1);
}

function updateDefender(db, dt) {
  let tx, tz, speed;
  if (game.state === STATE.RUN && game.carrier) {
    const c = game.carrier.group.position;
    tx = c.x; tz = c.z; speed = PURSUIT;
  } else if (game.state === STATE.AIR && (ball.targetRecv === game.receivers[db.covers] || db.deep)) {
    tx = ball.to.x; tz = ball.to.z; speed = DB_SPEED + 0.6;
  } else {
    const man = game.receivers[db.covers];
    const m = man.group.position;
    // trail slightly toward the QB side so receivers can separate on breaks
    tx = m.x; tz = m.z - 0.6;
    speed = db.deep ? DB_SPEED * 0.96 : DB_SPEED;
  }
  steerTo(db, tx, tz, speed, dt);
}

function updateBall(dt) {
  if (ball.mode === 'carried') {
    const holder = game.carrier || game.qb;
    const p = holder.group.position;
    _f.set(Math.sin(holder.heading), 0, Math.cos(holder.heading));
    ball.mesh.position.set(p.x + _f.x * 0.4, 1.25, p.z + _f.z * 0.4);
    ball.mesh.rotation.y = holder.heading;
  } else if (ball.mode === 'flying') {
    ball.t += dt / ball.dur;
    const t = Math.min(1, ball.t);
    ball.mesh.position.lerpVectors(ball.from, ball.to, t);
    ball.mesh.position.y = THREE.MathUtils.lerp(ball.from.y, ball.to.y, t) + ball.arc * Math.sin(Math.PI * t);
    ball.mesh.rotation.x += dt * 8;
    if (ball.t >= 1) resolvePass();
  }
}

function resolvePass() {
  const p = ball.to;
  const near = (ch) => Math.hypot(ch.group.position.x - p.x, ch.group.position.z - p.z);
  // closest receiver / defender to the ball
  let bestR = null, bestRD = Infinity;
  for (const wr of game.receivers) { const d = near(wr); if (d < bestRD) { bestRD = d; bestR = wr; } }
  let bestD = null, bestDD = Infinity;
  for (const db of game.defense) { const d = near(db); if (d < bestDD) { bestDD = d; bestD = db; } }

  if (bestRD <= CATCH_R && bestRD <= bestDD + 0.3) { completeCatch(bestR); return; }
  if (bestDD <= INTERCEPT_R) { ball.mode = 'carried'; endPlay('intercept', game.los); return; }
  ball.mode = 'carried'; endPlay('incomplete', game.los);
}

function updateAnimation(ch, dt) {
  const want = ch.speed > 0.4 ? (ch.speed > 6 ? 'run' : 'walk') : 'idle';
  setClip(ch, want);
  ch.group.rotation.y = ch.heading;
  ch.mixer.update(dt);
}

function updatePlay(dt) {
  // consume edges
  const actionEdge = input.actionEdge; input.actionEdge = false;
  const switchEdge = input.switchEdge; input.switchEdge = false;

  if (game.state === STATE.PRESNAP) {
    if (switchEdge) { game.selected = (game.selected + 1) % game.receivers.length; }
    if (actionEdge) snap();
  } else if (game.state === STATE.LIVE) {
    if (switchEdge) { game.selected = (game.selected + 1) % game.receivers.length; }
    if (actionEdge) throwBall();
  }

  // movement
  if (game.state === STATE.PRESNAP) {
    // everyone idles in formation
  } else if (game.state === STATE.LIVE || game.state === STATE.AIR) {
    controlledMove(game.qb, dt, input.action && game.state === STATE.LIVE ? PLAYER_RUN : PLAYER_RUN);
    for (const wr of game.receivers) updateReceiver(wr, dt);
    for (const db of game.defense) updateDefender(db, dt);
    keepInBounds(game.qb, false);
  } else if (game.state === STATE.RUN) {
    const top = input.action ? PLAYER_RUN * 1.18 : PLAYER_RUN;
    controlledMove(game.carrier, dt, top);
    for (const wr of game.receivers) if (wr !== game.carrier) updateReceiver(wr, dt);
    for (const db of game.defense) updateDefender(db, dt);
    checkRunOutcome();
  }

  updateBall(dt);

  // animations for everyone
  for (const ch of game.all) {
    if (ch === game.controlled) updateAnimation(ch, dt);
    else updateAnimation(ch, dt);
  }

  // rings
  if (selRing.visible && game.receivers[game.selected]) {
    const p = game.receivers[game.selected].group.position;
    selRing.position.set(p.x, 0.03, p.z);
  }
  if (ctrlRing.visible && game.controlled) {
    const p = game.controlled.group.position;
    ctrlRing.position.set(p.x, 0.03, p.z);
  }

  if (game.state === STATE.DEAD) {
    game.deadTimer -= dt;
    if (game.deadTimer <= 0) newPlay();
  }
}

function keepInBounds(ch, isCarrier) {
  const p = ch.group.position;
  p.x = THREE.MathUtils.clamp(p.x, -HALF_W + 0.5, HALF_W - 0.5);
  p.z = THREE.MathUtils.clamp(p.z, -HALF_L + 0.5, HALF_L - 0.5);
}

function checkRunOutcome() {
  const c = game.carrier.group.position;
  if (c.z >= GOAL_Z) { endPlay('TD', c.z); return; }
  if (Math.abs(c.x) > HALF_W || c.z < -HALF_L) { keepInBounds(game.carrier, true); endPlay('oob', c.z); return; }
  for (const db of game.defense) {
    if (Math.hypot(db.group.position.x - c.x, db.group.position.z - c.z) <= TACKLE_R) {
      endPlay('tackle', c.z); return;
    }
  }
}

// ===========================================================================
// Camera
// ===========================================================================
const camDesired = new THREE.Vector3();
function updateCamera(dt) {
  const t = game.controlled || game.qb;
  const p = t.group.position;
  const yaw = (game.state === STATE.PRESNAP || game.state === STATE.LIVE || game.state === STATE.AIR)
    ? 0 : t.heading; // behind, looking downfield pre-throw; behind runner after
  _f.set(Math.sin(yaw), 0, Math.cos(yaw));
  camDesired.set(p.x - _f.x * 11, 6.5, p.z - _f.z * 11);
  const k = 1 - Math.pow(0.0016, dt);
  camera.position.lerp(camDesired, k);
  camera.lookAt(p.x, p.y + 1.4, p.z);
  sun.position.set(p.x + 40, 70, p.z + 20);
  sun.target.position.set(p.x, 0, p.z);
}

// ===========================================================================
// Loop
// ===========================================================================
const clock = new THREE.Clock();
function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  updatePlay(dt);
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
  spawnTeams();
  makeBall();
  game.firstDown = game.los + 10;
  newPlay();
  loadingEl.classList.add('hidden');
  animate();
}).catch((err) => {
  console.error(err);
  loadingText.textContent = 'Failed to load assets. Check the console.';
});
