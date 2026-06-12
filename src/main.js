import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fc7ff);
scene.fog = new THREE.Fog(0x8fc7ff, 80, 260);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 6, 10);

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x3a6b3a, 0.9));

const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(40, 70, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 250;
const s = 80;
sun.shadow.camera.left = -s;
sun.shadow.camera.right = s;
sun.shadow.camera.top = s;
sun.shadow.camera.bottom = -s;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);

// ---------------------------------------------------------------------------
// Football field
//   American field: 120 yards (incl. end zones) x 53.3 yards.
//   1 unit = 1 yard. Field centered at origin, long axis = Z.
// ---------------------------------------------------------------------------
const FIELD_W = 53.3;   // sideline to sideline (X)
const FIELD_L = 120;    // back of end zone to back of end zone (Z)
const HALF_W = FIELD_W / 2;
const HALF_L = FIELD_L / 2;

function buildField() {
  const field = new THREE.Group();

  // Grass surround
  const surround = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x2e7d32 })
  );
  surround.rotation.x = -Math.PI / 2;
  surround.position.y = -0.02;
  surround.receiveShadow = true;
  field.add(surround);

  // Playing surface with mowed stripes (alternating shades along Z)
  const stripeCount = 12;
  const stripeLen = FIELD_L / stripeCount;
  for (let i = 0; i < stripeCount; i++) {
    const shade = i % 2 === 0 ? 0x357a38 : 0x2f6f33;
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_W, stripeLen),
      new THREE.MeshStandardMaterial({ color: shade })
    );
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(0, 0, -HALF_L + stripeLen * (i + 0.5));
    stripe.receiveShadow = true;
    field.add(stripe);
  }

  // End zones (tinted)
  for (const dir of [-1, 1]) {
    const ez = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_W, 10),
      new THREE.MeshStandardMaterial({ color: dir < 0 ? 0x1f5fa8 : 0xa83232 })
    );
    ez.rotation.x = -Math.PI / 2;
    ez.position.set(0, 0.01, dir * (HALF_L - 5));
    ez.receiveShadow = true;
    field.add(ez);
  }

  // Line material
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const addLine = (w, l, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.02, z);
    field.add(m);
  };

  // Sidelines
  addLine(0.4, FIELD_L, -HALF_W, 0);
  addLine(0.4, FIELD_L, HALF_W, 0);
  // End lines + goal lines
  const playHalf = HALF_L - 10; // goal line is 10yd in from each back line
  addLine(FIELD_W, 0.4, 0, -HALF_L);
  addLine(FIELD_W, 0.4, 0, HALF_L);
  addLine(FIELD_W, 0.5, 0, -playHalf);
  addLine(FIELD_W, 0.5, 0, playHalf);

  // Yard lines every 5 yards across the 100yd field
  for (let y = -playHalf + 5; y < playHalf; y += 5) {
    if (Math.abs(y) < 0.001) continue; // midfield handled below
    addLine(FIELD_W, 0.3, 0, y);
  }
  // Midfield line emphasized
  addLine(FIELD_W, 0.5, 0, 0);

  // Hash marks (short ticks) along each yard line
  const hashInset = 6; // yards from center
  for (let y = -playHalf + 1; y < playHalf; y += 1) {
    for (const hx of [-hashInset, hashInset]) {
      addLine(0.9, 0.18, hx, y);
    }
  }

  // Goal posts
  field.add(buildGoalPost(-playHalf - 0.2, -1));
  field.add(buildGoalPost(playHalf + 0.2, 1));

  return field;
}

function buildGoalPost(z, dir) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffd54a, metalness: 0.4, roughness: 0.4 });
  const tube = (len, rx, ry, rz) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, len, 12), mat);
    m.castShadow = true;
    m.position.set(rx, ry, rz);
    return m;
  };
  const base = tube(3, 0, 1.5, 0); g.add(base);
  const cross = tube(6.1, 0, 3, 0); cross.rotation.z = Math.PI / 2; g.add(cross);
  const upL = tube(6, -3, 6, 0); g.add(upL);
  const upR = tube(6, 3, 6, 0); g.add(upR);
  g.position.set(0, 0, z);
  return g;
}

scene.add(buildField());

// ---------------------------------------------------------------------------
// Player + animations
// ---------------------------------------------------------------------------
const player = new THREE.Group();
scene.add(player);

let mixer = null;
const actions = {};
let activeAction = null;
const playerHeading = new THREE.Vector3(0, 0, 1); // facing +Z initially

const loader = new GLTFLoader();
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');

function loadGLB(url) {
  return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
}

async function setupPlayer() {
  loadingText.textContent = 'Loading character…';
  const charGltf = await loadGLB('assets/character.glb');
  loadingText.textContent = 'Loading animations…';
  const animGltf = await loadGLB('assets/animations.glb');

  const model = charGltf.scene;

  // Normalize: scale so the character is ~1.9 yards tall and feet sit at y=0.
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const targetHeight = 1.9;
  const scale = targetHeight / size.y;
  model.scale.setScalar(scale);

  // Re-measure after scaling to drop feet onto the turf.
  const box2 = new THREE.Box3().setFromObject(model);
  model.position.y = -box2.min.y;

  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.frustumCulled = false; // skinned bounds can be unreliable
    }
  });

  player.add(model);

  // Mixer drives the character's skeleton with clips from both files.
  mixer = new THREE.AnimationMixer(model);

  const byName = {};
  for (const clip of [...charGltf.animations, ...animGltf.animations]) {
    byName[clip.name] = clip;
  }

  const idleClip = charGltf.animations[0]; // static idle pose
  actions.idle = mixer.clipAction(idleClip);
  actions.walk = mixer.clipAction(byName['Walking']);
  actions.run = mixer.clipAction(byName['Running']);

  for (const a of Object.values(actions)) {
    a.enabled = true;
    a.setEffectiveWeight(0);
    a.play();
  }
  activeAction = actions.idle;
  activeAction.setEffectiveWeight(1);

  loadingEl.classList.add('hidden');
}

// Cross-fade locomotion based on speed.
function setLocomotion(name) {
  const next = actions[name];
  if (!next || next === activeAction) return;
  const prev = activeAction;
  next.enabled = true;
  next.setEffectiveTimeScale(1);
  next.crossFadeFrom(prev, 0.25, true);
  next.play();
  activeAction = next;
}

// ---------------------------------------------------------------------------
// Input — virtual joystick (touch + mouse), keyboard, sprint button
// ---------------------------------------------------------------------------
const input = { x: 0, y: 0, sprint: false }; // x,y in [-1,1], y forward = +1

(function setupJoystick() {
  const base = document.getElementById('joystick');
  const knob = document.getElementById('joystick-knob');
  const maxR = 48;
  let id = null;
  let cx = 0, cy = 0;

  const start = (e) => {
    const t = e.changedTouches ? e.changedTouches[0] : e;
    const r = base.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    id = e.changedTouches ? t.identifier : 'mouse';
    move(e);
  };
  const move = (e) => {
    if (id === null) return;
    let t;
    if (e.changedTouches) {
      t = [...e.changedTouches].find((c) => c.identifier === id);
      if (!t) return;
    } else t = e;
    let dx = t.clientX - cx;
    let dy = t.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > maxR) { dx = (dx / dist) * maxR; dy = (dy / dist) * maxR; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    input.x = dx / maxR;
    input.y = -dy / maxR; // screen-down is forward-away
  };
  const end = () => {
    id = null;
    input.x = 0; input.y = 0;
    knob.style.transform = 'translate(0,0)';
  };

  base.addEventListener('touchstart', (e) => { e.preventDefault(); start(e); }, { passive: false });
  base.addEventListener('touchmove', (e) => { e.preventDefault(); move(e); }, { passive: false });
  base.addEventListener('touchend', (e) => { e.preventDefault(); end(e); }, { passive: false });
  base.addEventListener('touchcancel', end);
  base.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
})();

(function setupSprint() {
  const btn = document.getElementById('sprint-btn');
  const on = (e) => { e.preventDefault(); input.sprint = true; btn.classList.add('active'); };
  const off = (e) => { if (e) e.preventDefault(); input.sprint = false; btn.classList.remove('active'); };
  btn.addEventListener('touchstart', on, { passive: false });
  btn.addEventListener('touchend', off, { passive: false });
  btn.addEventListener('touchcancel', off);
  btn.addEventListener('mousedown', on);
  window.addEventListener('mouseup', off);
})();

// Keyboard for desktop testing
const keys = {};
window.addEventListener('keydown', (e) => { keys[e.code] = true; });
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
function keyboardVector() {
  let x = 0, y = 0;
  if (keys['KeyW'] || keys['ArrowUp']) y += 1;
  if (keys['KeyS'] || keys['ArrowDown']) y -= 1;
  if (keys['KeyA'] || keys['ArrowLeft']) x -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) x += 1;
  return { x, y, sprint: keys['ShiftLeft'] || keys['ShiftRight'] };
}

// ---------------------------------------------------------------------------
// Chase camera + movement
// ---------------------------------------------------------------------------
const WALK_SPEED = 4.5;   // yards / s
const RUN_SPEED = 11;
const camOffset = new THREE.Vector3(0, 4.2, -8.5); // behind player (-heading)
const tmpCamPos = new THREE.Vector3();
const tmpForward = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const moveDir = new THREE.Vector3();
const desiredCamPos = new THREE.Vector3();

let hintHidden = false;
const hintEl = document.getElementById('hint');

function update(dt) {
  // Combine joystick + keyboard
  const kb = keyboardVector();
  let ix = input.x + kb.x;
  let iy = input.y + kb.y;
  const sprint = input.sprint || kb.sprint;
  const mag = Math.min(1, Math.hypot(ix, iy));

  if (mag > 0.05) {
    // Camera-relative movement: forward = camera look dir flattened.
    camera.getWorldDirection(tmpForward);
    tmpForward.y = 0; tmpForward.normalize();
    tmpRight.crossVectors(tmpForward, THREE.Object3D.DEFAULT_UP).normalize();

    moveDir.set(0, 0, 0)
      .addScaledVector(tmpForward, iy)
      .addScaledVector(tmpRight, ix);
    if (moveDir.lengthSq() > 0) moveDir.normalize();

    const top = sprint ? RUN_SPEED : WALK_SPEED;
    const speed = top * mag;
    player.position.addScaledVector(moveDir, speed * dt);

    // Keep player on the field surround.
    player.position.x = THREE.MathUtils.clamp(player.position.x, -190, 190);
    player.position.z = THREE.MathUtils.clamp(player.position.z, -190, 190);

    // Smoothly turn to face travel direction.
    playerHeading.lerp(moveDir, 1 - Math.pow(0.001, dt)).normalize();
    player.rotation.y = Math.atan2(playerHeading.x, playerHeading.z);

    // Choose locomotion clip by effective speed.
    const fast = sprint || mag > 0.7;
    setLocomotion(fast ? 'run' : 'walk');

    if (!hintHidden) { hintHidden = true; hintEl.classList.add('hidden'); }
  } else {
    setLocomotion('idle');
  }

  // Chase camera follows behind the heading.
  tmpForward.copy(playerHeading);
  tmpRight.crossVectors(THREE.Object3D.DEFAULT_UP, tmpForward).normalize();
  desiredCamPos.copy(player.position)
    .addScaledVector(tmpForward, camOffset.z)
    .add(new THREE.Vector3(0, camOffset.y, 0));
  camera.position.lerp(desiredCamPos, 1 - Math.pow(0.0015, dt));
  camera.lookAt(player.position.x, player.position.y + 1.4, player.position.z);

  // Keep the sun shadow frustum centered on the player.
  sun.position.set(player.position.x + 40, 70, player.position.z + 20);
  sun.target.position.copy(player.position);

  if (mixer) mixer.update(dt);
}

// ---------------------------------------------------------------------------
// Loop / resize
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

setupPlayer()
  .then(() => animate())
  .catch((err) => {
    console.error(err);
    loadingText.textContent = 'Failed to load assets. Check the console.';
  });
