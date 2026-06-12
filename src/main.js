import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

/* ============================================================
   Gridiron Demo
   A third-person football-field playground built on three.js.
   Run around the field, sprint, and trigger catch / dive moves.
   ============================================================ */

// ---- Tunable constants -------------------------------------
const FIELD_LENGTH = 110;   // world units along the long axis (incl. end zones)
const FIELD_WIDTH  = 49;    // world units across
const END_ZONE     = 9.1;   // depth of each end zone
const PLAYER_HEIGHT = 1.8;  // target on-screen height (world units)
const WALK_SPEED   = 2.6;
const RUN_SPEED    = 6.8;
const ACCEL        = 22;     // how quickly we reach target speed
const TURN_SPEED   = 12;     // how quickly the model swivels to face travel
const IDLE_POSE_TIME = 1.188; // a neutral, feet-together frame of the walk cycle
                              // (the model has no standing idle clip — its only
                              // "idle" is a lie-down relax animation)
const MODEL_FACING_FIX = -Math.PI / 2; // the mesh faces -X by default; rotate to +Z
// The FBX's `move_run` clip is unusable (the character runs nearly horizontal,
// like he's flying). So sprinting reuses the upright walk cycle, sped up and
// with a forward lean, which reads as a believable run.
const WALK_ANIM_RATE   = 1.15;
const SPRINT_ANIM_RATE = 2.0;
const SPRINT_LEAN      = 0.22;  // radians (~13°) of forward torso lean at a sprint
const CAM_FOLLOW       = 4.0;   // how fast the chase cam swings behind the player

// ---- Renderer / scene --------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b9e8);
scene.fog = new THREE.Fog(0x87b9e8, 90, 230);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 600);

// ---- Lighting ----------------------------------------------
const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x2c4a32, 0.95);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff4e0, 2.0);
sun.position.set(40, 70, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.near = 1; sc.far = 220;
sc.left = -80; sc.right = 80; sc.top = 80; sc.bottom = -80;
sun.shadow.bias = -0.0004;
scene.add(sun);

// ---- Field --------------------------------------------------
buildField();
buildStands();

function buildField() {
  // Procedural turf texture drawn on a 2D canvas.
  const tex = makeFieldTexture();
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.SRGBColorSpace;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(FIELD_LENGTH, FIELD_WIDTH),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // A larger surrounding apron of plain grass so the world feels open.
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(FIELD_LENGTH + 120, FIELD_WIDTH + 120),
    new THREE.MeshStandardMaterial({ color: 0x2f6b3d, roughness: 1 })
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.02;
  apron.receiveShadow = true;
  scene.add(apron);

  // Goal posts at each end.
  goalPost(-FIELD_LENGTH / 2 + 0.4);
  goalPost(FIELD_LENGTH / 2 - 0.4);
}

function makeFieldTexture() {
  const W = 2048, H = Math.round(2048 * (FIELD_WIDTH / FIELD_LENGTH));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  const ezPx = (END_ZONE / FIELD_LENGTH) * W;          // end-zone width in px
  const playW = W - ezPx * 2;                           // playing field px
  const yardPx = playW / 100;                           // 1 yard in px

  // Mowing stripes across the field of play.
  for (let i = 0; i < 100; i += 5) {
    g.fillStyle = ((i / 5) % 2 === 0) ? '#2f7d43' : '#287039';
    g.fillRect(ezPx + i * yardPx, 0, 5 * yardPx, H);
  }
  // End zones.
  g.fillStyle = '#1f5f87'; g.fillRect(0, 0, ezPx, H);
  g.fillStyle = '#8a2734'; g.fillRect(W - ezPx, 0, ezPx, H);

  // Yard lines every 5 yards.
  g.strokeStyle = 'rgba(255,255,255,0.92)';
  g.lineWidth = Math.max(2, W / 600);
  for (let i = 0; i <= 100; i += 5) {
    const x = ezPx + i * yardPx;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  // Goal lines + sidelines, slightly bolder.
  g.lineWidth = Math.max(3, W / 380);
  g.strokeRect(ezPx, 0, playW, H);

  // Hash marks each yard.
  g.lineWidth = Math.max(2, W / 700);
  const hashTop = H * 0.34, hashBot = H * 0.66, hl = H * 0.018;
  for (let i = 1; i < 100; i++) {
    if (i % 5 === 0) continue;
    const x = ezPx + i * yardPx;
    for (const y of [hashTop, hashBot]) {
      g.beginPath(); g.moveTo(x, y - hl); g.lineTo(x, y + hl); g.stroke();
    }
  }

  // Yard numbers (10..50..10).
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.font = `700 ${Math.round(H * 0.13)}px Arial`;
  g.textAlign = 'center';
  const labels = [10, 20, 30, 40, 50, 40, 30, 20, 10];
  labels.forEach((n, idx) => {
    const yard = 10 + idx * 10;
    const x = ezPx + yard * yardPx;
    g.save();
    g.fillText(String(n), x, H * 0.22);
    g.translate(x, H * 0.84); g.fillText(String(n), 0, 0);
    g.restore();
  });

  // End-zone wordmarks.
  drawVertWord(g, 'GRIDIRON', ezPx / 2, H / 2, H * 0.085, '#cfe9ff');
  drawVertWord(g, 'DEMO', W - ezPx / 2, H / 2, H * 0.085, '#ffd6dc');

  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function drawVertWord(g, text, x, y, size, color) {
  g.save();
  g.translate(x, y);
  g.rotate(-Math.PI / 2);
  g.fillStyle = color;
  g.font = `800 ${Math.round(size)}px Arial`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 0, 0);
  g.restore();
}

function goalPost(x) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffd23f, metalness: 0.4, roughness: 0.4 });
  const group = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 3, 12), mat);
  base.position.y = 1.5;
  const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 5.6, 12), mat);
  cross.rotation.x = Math.PI / 2;
  cross.position.y = 3;
  const dir = x < 0 ? 1 : -1;
  for (const z of [-2.8, 2.8]) {
    const up = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4.2, 12), mat);
    up.position.set(0, 5.1, z);
    group.add(up);
  }
  group.add(base, cross);
  group.position.set(x, 0, 0);
  group.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(group);
}

function buildStands() {
  // Simple ringed grandstands for atmosphere.
  const colors = [0x37474f, 0x455a64, 0x546e7a];
  const mat = new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 1 });
  for (const side of [-1, 1]) {
    const stand = new THREE.Mesh(new THREE.BoxGeometry(FIELD_LENGTH + 20, 8, 14), mat.clone());
    stand.material.color.setHex(colors[(side + 1) % colors.length]);
    stand.position.set(0, 4, side * (FIELD_WIDTH / 2 + 14));
    stand.castShadow = true; stand.receiveShadow = true;
    scene.add(stand);
    // speckle of "crowd"
    addCrowd(0, side * (FIELD_WIDTH / 2 + 9), FIELD_LENGTH + 16, side);
  }
}

function addCrowd(cx, cz, span, side) {
  const N = 600;
  const geo = new THREE.SphereGeometry(0.35, 6, 5);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 1 }), N);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const x = cx + (Math.random() - 0.5) * span;
    const row = Math.floor(Math.random() * 5);
    const z = cz + side * row * 2.4;
    const y = 3 + row * 1.2;
    dummy.position.set(x, y, z);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    col.setHSL(Math.random(), 0.55, 0.55);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
}

// ---- Football (held in hand) -------------------------------
function makeFootball() {
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 20, 16),
    new THREE.MeshStandardMaterial({ color: 0x6a3414, roughness: 0.6 })
  );
  ball.scale.set(1.7, 1, 1);          // prolate spheroid
  ball.castShadow = true;
  // lace stripe
  const stripe = new THREE.Mesh(
    new THREE.TorusGeometry(0.13, 0.012, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xf5f0e6 })
  );
  stripe.rotation.y = Math.PI / 2;
  ball.add(stripe);
  return ball;
}

// ---- Player / animation state ------------------------------
const player = new THREE.Object3D();    // logical position holder
scene.add(player);

const playerYaw = { value: 0 };         // facing angle (radians)
const velocity = new THREE.Vector3();   // current planar velocity
let mixer = null;
let model = null;
const actions = {};                     // name -> AnimationAction
let current = null;                     // current locomotion action name
let oneShot = null;                     // active catch/dive action
let football = null;
let ballVisible = true;

// ---- Loading -----------------------------------------------
const loaderEl = document.getElementById('loader');
const barFill = document.getElementById('bar-fill');
const statusEl = document.getElementById('loader-status');
const hud = document.getElementById('hud');

const manager = new THREE.LoadingManager();
manager.onProgress = (url, loaded, total) => {
  const pct = total ? Math.round((loaded / total) * 100) : 50;
  barFill.style.width = pct + '%';
};

const fbx = new FBXLoader(manager);
fbx.load('assets/player.fbx', onModelLoaded, (e) => {
  if (e.lengthComputable) {
    barFill.style.width = Math.round((e.loaded / e.total) * 100) + '%';
  }
  statusEl.textContent = 'Loading player... ' + (e.total ? Math.round(e.loaded / e.total * 100) + '%' : '');
}, (err) => {
  statusEl.textContent = 'Failed to load model. Serve this folder over HTTP (see README).';
  console.error(err);
});

// Map the FBX clip list onto friendly action names by keyword.
// Note: the FBX's only "idle"-ish clip is `relax`, which is a 17s lie-down
// animation. We expose it as an optional move and synthesize a standing idle
// from a neutral frame of the walk cycle instead (see onModelLoaded).
const CLIP_KEYS = {
  relax: /relax/i,
  walk:  /walk_normal/i,
  run:   /move_run/i,
  catch: /Football Catch/i,
  dive:  /swan-dive|parkour/i,
};

let relaxing = false;       // is the player doing the lie-down relax?
let locoLabel = 'idle';     // last locomotion label shown on the HUD badge
let isMoving = false;       // is the player currently moving (for the chase cam)?

function onModelLoaded(obj) {
  model = obj;

  // Normalize scale so the character is PLAYER_HEIGHT tall, feet on the ground.
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3(); box.getSize(size);
  const scale = PLAYER_HEIGHT / size.y;
  model.scale.setScalar(scale);

  const box2 = new THREE.Box3().setFromObject(model);
  model.position.y -= box2.min.y;     // drop feet to y=0
  model.position.x -= (box2.min.x + box2.max.x) / 2;
  model.position.z -= (box2.min.z + box2.max.z) / 2;

  model.traverse(o => {
    if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; }
  });

  // The mesh's built-in forward axis points along -X (90° off), so correct it
  // here: after this, the holder's yaw = the player's actual heading.
  model.rotation.y = MODEL_FACING_FIX;

  // The model holder lets us yaw the character independently of root pose.
  // YXZ order so the sprint lean (rotation.x) tilts forward relative to facing.
  const holder = new THREE.Group();
  holder.rotation.order = 'YXZ';
  holder.add(model);
  player.add(holder);
  player.userData.holder = holder;

  // Animations.
  mixer = new THREE.AnimationMixer(model);
  for (const clip of obj.animations) {
    for (const [key, re] of Object.entries(CLIP_KEYS)) {
      if (actions[key]) continue;
      if (re.test(clip.name)) {
        const action = mixer.clipAction(clip);
        actions[key] = action;
      }
    }
  }
  // Synthesize a standing idle by freezing a neutral frame of the walk clip.
  // (Cloning the clip gives an action independent of the live `walk` action.)
  if (actions.walk) {
    const standClip = actions.walk.getClip().clone();
    standClip.name = 'stand_idle';
    actions.idle = mixer.clipAction(standClip);
  }

  // Configure one-shot actions.
  ['catch', 'dive'].forEach(k => {
    if (actions[k]) {
      actions[k].setLoop(THREE.LoopOnce, 1);
      actions[k].clampWhenFinished = true;
    }
  });

  // Attach a football to the right hand.
  const hand = model.getObjectByName('R_Hand');
  if (hand) {
    football = makeFootball();
    // Counter-scale so the ball keeps real-world size inside the scaled rig.
    const s = 1 / scale;
    football.scale.multiplyScalar(s);
    football.position.set(0, 0.6 * s, 0.4 * s);
    hand.add(football);
  }

  mixer.addEventListener('finished', onActionFinished);

  // Start in the standing idle pose.
  if (actions.idle) {
    actions.idle.play();
    actions.idle.paused = true;
    actions.idle.time = IDLE_POSE_TIME;
    current = 'idle';
  }
  updateLocomotionBadge('idle');

  // Re-ground on the *posed* mesh. The feet-on-floor offset was computed from
  // the bind (T) pose, but the displayed idle is a walk frame whose feet sit
  // lower, which sinks the player into the turf. Pose the skeleton and drop the
  // true lowest vertex to y = 0.
  mixer.update(0);
  groundToCurrentPose(model);

  // Reveal.
  loaderEl.classList.add('gone');
  setTimeout(() => loaderEl.remove(), 700);
  hud.classList.remove('hidden');
  statusEl.textContent = 'Ready';
}

// Drop the model so the lowest vertex of its *current* (posed) skinned mesh
// rests on y = 0. Run once at load after the idle pose is applied.
function groundToCurrentPose(root) {
  let sk = null;
  root.traverse(o => { if (o.isSkinnedMesh && !sk) sk = o; });
  if (!sk) return;
  root.updateMatrixWorld(true);
  sk.skeleton.update();
  const pos = sk.geometry.attributes.position;
  const v = new THREE.Vector3();
  let minY = Infinity;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    sk.applyBoneTransform(i, v);     // bind -> posed (local)
    v.applyMatrix4(sk.matrixWorld);  // -> world
    if (v.y < minY) minY = v.y;
  }
  if (Number.isFinite(minY)) {
    root.position.y -= minY;
    root.updateMatrixWorld(true);
  }
}

function onActionFinished(e) {
  if (oneShot && e.action === actions[oneShot]) {
    const finished = oneShot;
    oneShot = null;
    // Fade back into whatever locomotion is appropriate.
    fadeTo(current, 0.25);
    actions[finished].fadeOut(0.25);
    locoLabel = '';   // force the HUD badge to refresh off the action label
  }
}

// Crossfade locomotion (idle/walk/run) to a target.
function fadeTo(name, dur = 0.2) {
  if (!actions[name]) return;
  const next = actions[name];
  if (current && actions[current] && actions[current] !== next) {
    actions[current].fadeOut(dur);
  }
  next.reset().fadeIn(dur).play();
  // The idle action is a single held frame, not a looping clip.
  if (name === 'idle') { next.paused = true; next.time = IDLE_POSE_TIME; }
  current = name;
}

function triggerOneShot(name) {
  if (!actions[name] || oneShot) return;
  oneShot = name;
  const a = actions[name];
  // Fade out current locomotion under the action.
  if (current && actions[current]) actions[current].fadeOut(0.15);
  a.reset().fadeIn(0.15).play();
  setBadge(name === 'catch' ? 'CATCH!' : 'DIVING CATCH!');
  // A dive lunges forward a little.
  if (name === 'dive') {
    const f = new THREE.Vector3(Math.sin(playerYaw.value), 0, Math.cos(playerYaw.value));
    velocity.addScaledVector(f, 6);
  }
}

// ---- Input --------------------------------------------------
const keys = {};
const held = { sprint: false };
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (k === ' ') { e.preventDefault(); triggerOneShot('catch'); }
  if (k === 'f') triggerOneShot('dive');
  if (k === 'b') toggleBall();
  if (k === 'g') toggleRelax();
  if (k === 'r') resetPlayer();
  if (k === 'h') togglePanel();
});
addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

function isDown(...names) { return names.some(n => keys[n]); }

// Touch action buttons (right-hand cluster).
document.querySelectorAll('#touch-actions .act-btn').forEach(btn => {
  const act = btn.dataset.act;
  if (act === 'sprint') {
    const press = e => { e.preventDefault(); held.sprint = true; btn.classList.add('held'); };
    const release = () => { held.sprint = false; btn.classList.remove('held'); };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  } else {
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (act === 'relax') toggleRelax();
      else triggerOneShot(act);
    });
  }
});

// ---- On-screen movement joystick (left) --------------------
const joystick = document.getElementById('joystick');
const joyThumb = document.getElementById('joy-thumb');
const JOY_RADIUS = 50;                 // px of travel for full deflection
let joyId = null, joyCenter = null;

joystick.addEventListener('pointerdown', e => {
  e.preventDefault();
  joyId = e.pointerId;
  const r = joystick.getBoundingClientRect();
  joyCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  joystick.setPointerCapture(e.pointerId);
  updateJoystick(e);
});
joystick.addEventListener('pointermove', e => { if (e.pointerId === joyId) updateJoystick(e); });
function endJoystick(e) {
  if (e.pointerId !== joyId) return;
  joyId = null; moveVec.x = 0; moveVec.y = 0;
  joyThumb.style.transform = 'translate(0px, 0px)';
}
joystick.addEventListener('pointerup', endJoystick);
joystick.addEventListener('pointercancel', endJoystick);

function updateJoystick(e) {
  let dx = e.clientX - joyCenter.x, dy = e.clientY - joyCenter.y;
  const dist = Math.hypot(dx, dy);
  if (dist > JOY_RADIUS) { dx *= JOY_RADIUS / dist; dy *= JOY_RADIUS / dist; }
  joyThumb.style.transform = `translate(${dx}px, ${dy}px)`;
  moveVec.x = dx / JOY_RADIUS;          // +x = right
  moveVec.y = dy / JOY_RADIUS;          // +y = down (consumed as -forward)
}

// ---- Camera orbit (mouse / touch drag on empty screen area) ----
// The joystick and buttons capture their own pointers, so any drag that
// fully automatic — it always trails behind the player. No manual orbit.
const orbit = { yaw: 0, pitch: 0.32, dist: 8 };  // yaw 0 = camera behind the player
const moveVec = { x: 0, y: 0 };       // joystick / keyboard movement vector

// Mouse wheel still zooms (desktop only); there is no manual rotation.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.dist = Math.max(4, Math.min(16, orbit.dist + e.deltaY * 0.01));
}, { passive: false });

// ---- HUD helpers -------------------------------------------
const badge = document.getElementById('action-badge');
const speedVal = document.getElementById('speed-val');
let badgeTimer = 0;
function setBadge(text, sticky = false) {
  badge.textContent = text;
  if (!sticky) badgeTimer = 1.1;
}
function togglePanel() {
  document.getElementById('controls-panel').classList.toggle('collapsed');
}
document.getElementById('cp-toggle').addEventListener('click', togglePanel);

function toggleBall() {
  if (!football) return;
  ballVisible = !ballVisible;
  football.visible = ballVisible;
}
function toggleRelax() {
  if (!actions.relax) return;
  relaxing = !relaxing;          // takes effect next idle frame in updateMovement
}
function resetPlayer() {
  player.position.set(0, 0, 0);
  velocity.set(0, 0, 0);
  playerYaw.value = 0;
  orbit.yaw = 0;          // camera behind the player
  setBadge('RESET');
}

// ---- Resize -------------------------------------------------
addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- Main loop ---------------------------------------------
const clock = new THREE.Clock();
const tmpForward = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const desiredVel = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  updateMovement(dt);
  updateCamera(dt);

  if (mixer) mixer.update(dt);

  // Badge auto-revert.
  if (badgeTimer > 0) {
    badgeTimer -= dt;
    if (badgeTimer <= 0 && !oneShot) updateLocomotionBadge();
  }

  renderer.render(scene, camera);
}

function updateMovement(dt) {
  // Build input vector relative to the camera's yaw.
  let ix = 0, iz = 0;
  if (isDown('w', 'arrowup')) iz += 1;
  if (isDown('s', 'arrowdown')) iz -= 1;
  if (isDown('a', 'arrowleft')) ix -= 1;
  if (isDown('d', 'arrowright')) ix += 1;
  // Touch joystick.
  ix += moveVec.x; iz -= moveVec.y;
  const inputMag = Math.min(1, Math.hypot(ix, iz));

  const sprint = isDown('shift') || held.sprint;
  const targetSpeed = inputMag > 0.05 ? (sprint ? RUN_SPEED : WALK_SPEED) * inputMag : 0;

  // Camera-forward (flattened) and right vectors.
  tmpForward.set(Math.sin(orbit.yaw), 0, Math.cos(orbit.yaw)).normalize();
  tmpRight.set(-tmpForward.z, 0, tmpForward.x);   // screen/player right

  desiredVel.set(0, 0, 0);
  if (inputMag > 0.05) {
    desiredVel.addScaledVector(tmpForward, iz);
    desiredVel.addScaledVector(tmpRight, ix);
    desiredVel.normalize().multiplyScalar(targetSpeed);
  }

  // Smoothly approach desired velocity (one-shot dive keeps its momentum).
  const lerp = 1 - Math.exp(-ACCEL * dt);
  velocity.x += (desiredVel.x - velocity.x) * (oneShot === 'dive' ? 0.04 : lerp);
  velocity.z += (desiredVel.z - velocity.z) * (oneShot === 'dive' ? 0.04 : lerp);

  // Integrate position, clamp to a generous play area.
  player.position.x += velocity.x * dt;
  player.position.z += velocity.z * dt;
  const limX = FIELD_LENGTH / 2 + 6, limZ = FIELD_WIDTH / 2 + 6;
  player.position.x = Math.max(-limX, Math.min(limX, player.position.x));
  player.position.z = Math.max(-limZ, Math.min(limZ, player.position.z));

  // Face the direction of travel.
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed > 0.3 && inputMag > 0.05) {
    const targetYaw = Math.atan2(velocity.x, velocity.z);
    playerYaw.value = lerpAngle(playerYaw.value, targetYaw, 1 - Math.exp(-TURN_SPEED * dt));
  }
  // Any movement input cancels the lie-down relax.
  const moving = inputMag > 0.05;
  isMoving = moving;
  if (moving) relaxing = false;
  const sprinting = moving && sprint && !oneShot;

  const holder = player.userData.holder;
  if (holder) {
    holder.rotation.y = playerYaw.value;
    // Subtle breathing bob while standing idle, so it doesn't look frozen.
    const breathing = (!oneShot && current === 'idle');
    const targetBob = breathing ? Math.sin(clock.elapsedTime * 1.7) * 0.012 : 0;
    holder.position.y += (targetBob - holder.position.y) * (1 - Math.exp(-8 * dt));
    // Lean forward into a sprint; stay upright otherwise.
    const targetLean = sprinting ? SPRINT_LEAN : 0;
    holder.rotation.x += (targetLean - holder.rotation.x) * (1 - Math.exp(-9 * dt));
  }

  // Locomotion animation selection (skip while a one-shot plays).
  // Walk and sprint share the walk clip; sprint just runs it faster.
  if (!oneShot) {
    const want = moving ? 'walk' : (relaxing ? 'relax' : 'idle');
    if (want !== current) fadeTo(want, 0.25);
    if (moving && actions.walk) actions.walk.timeScale = sprint ? SPRINT_ANIM_RATE : WALK_ANIM_RATE;
    // Badge tracks walk vs sprint even though both use the same clip.
    const label = moving ? (sprint ? 'run' : 'walk') : (relaxing ? 'relax' : 'idle');
    if (label !== locoLabel) { locoLabel = label; updateLocomotionBadge(label); }
  }

  speedVal.textContent = speed.toFixed(1);
}

function updateLocomotionBadge(name = locoLabel) {
  if (oneShot) return;
  const map = { idle: 'READY', walk: 'JOGGING', run: 'SPRINTING', relax: 'RELAXING' };
  setBadge(map[name] || 'READY', true);
}

function updateCamera(dt) {
  // Chase cam: swing around behind the player's heading while they move.
  // Weight the follow by how far behind we already are (cos), so it eases in
  // when the player turns but does NOT chase a full 180° reversal (which would
  // spin endlessly) — running "back" toward the camera just shows the front.
  if (isMoving) {
    let diff = (playerYaw.value - orbit.yaw) % (Math.PI * 2);
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    const align = 0.5 + 0.5 * Math.cos(diff);     // 1 = already behind, 0 = opposite
    orbit.yaw = lerpAngle(orbit.yaw, playerYaw.value, 1 - Math.exp(-CAM_FOLLOW * align * dt));
  }

  // Target a point around the player's upper body.
  camTarget.copy(player.position); camTarget.y += 1.2;

  const cp = Math.cos(orbit.pitch);
  camPos.set(
    player.position.x - Math.sin(orbit.yaw) * orbit.dist * cp,
    player.position.y + 1.2 + Math.sin(orbit.pitch) * orbit.dist,
    player.position.z - Math.cos(orbit.yaw) * orbit.dist * cp
  );
  // Keep the camera above the turf.
  camPos.y = Math.max(camPos.y, 0.6);

  const k = 1 - Math.exp(-10 * dt);
  camera.position.lerp(camPos, k);
  camera.lookAt(camTarget);
}

function lerpAngle(a, b, t) {
  let diff = (b - a) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

animate();
