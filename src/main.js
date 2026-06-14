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
// Richer, punchier color/contrast (cinematic tone mapping).
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x12203f, 130, 330); // night haze blends distance into the sky

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 7, -12);

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
function makeAdTexture() {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#070b12'; g.fillRect(0, 0, 1024, 64);
  const ads = [['REAPER ENERGY', '#ff4a2a'], ['BLITZ COLA', '#ffd23a'], ['TURF KING', '#3fe08a'], ['NIGHT OWL TIRES', '#5a8bff'], ['GRIDIRON BANK', '#ff8af0'], ['MESHY MOTORS', '#7fe0ff']];
  g.font = 'bold 36px Arial Black, sans-serif'; g.textBaseline = 'middle';
  let x = 10, i = 0;
  while (x < 1024) { const [t, col] = ads[i++ % ads.length]; g.fillStyle = col; g.fillText(t, x, 34); x += g.measureText(t).width + 70; }
  const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(7, 1); tex.colorSpace = THREE.SRGBColorSpace; return tex;
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
  // Crowd: a noisy speckle texture wrapped on a slightly flared bowl wall.
  const cc = document.createElement('canvas'); cc.width = 256; cc.height = 128;
  const cg = cc.getContext('2d'); cg.fillStyle = '#0b1420'; cg.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 3000; i++) { cg.fillStyle = `hsl(${Math.random() * 360},${25 + Math.random() * 45}%,${28 + Math.random() * 48}%)`; cg.fillRect(Math.random() * 256, Math.random() * 128, 2, 2); }
  const crowdTex = new THREE.CanvasTexture(cc); crowdTex.wrapS = crowdTex.wrapT = THREE.RepeatWrapping; crowdTex.repeat.set(26, 3); crowdTex.colorSpace = THREE.SRGBColorSpace;
  const stands = new THREE.Mesh(new THREE.CylinderGeometry(96, 80, 34, 56, 1, true),
    new THREE.MeshStandardMaterial({ map: crowdTex, side: THREE.BackSide, roughness: 1 }));
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
  // Animated LED advertising ring just inside the field-level wall.
  const adRing = new THREE.Mesh(new THREE.CylinderGeometry(71, 71, 2.6, 64, 1, true),
    new THREE.MeshBasicMaterial({ map: makeAdTexture(), side: THREE.BackSide }));
  adRing.position.y = 1.5; scene.add(adRing); adBoardTex = adRing.material.map;
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
    scene.add(g);
    // Each tower actually lights the field (constant cone, no falloff).
    const spot = new THREE.SpotLight(0xfff4d6, 1.6, 0, 0.66, 0.55, 0);
    spot.position.set(g.position.x, 31, g.position.z);
    spot.target.position.set(g.position.x * 0.12, 0, g.position.z * 0.12);
    scene.add(spot, spot.target);
  }
  // The moon: a soft additive glow high in the sky.
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeGlowTexture(), color: 0xcfe0ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  moon.scale.set(34, 34, 1); moon.position.set(-130, 170, 120); scene.add(moon);
}

scene.add(new THREE.HemisphereLight(0x44588f, 0x0c1208, 0.6)); // cool night ambient
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
const CAGE_X = HALF_W, CAGE_Z = HALF_L; // boundary walls right on the out-of-bounds lines

const turfMats = []; // {mat, rx, ry} — get the grass map once it loads
function buildField() {
  const field = new THREE.Group();
  const surroundMat = new THREE.MeshStandardMaterial({ color: 0x3c6e34, roughness: 1 });
  turfMats.push({ mat: surroundMat, rx: 60, ry: 60 });
  const surround = new THREE.Mesh(new THREE.PlaneGeometry(420, 420), surroundMat);
  surround.rotation.x = -Math.PI / 2; surround.position.y = -0.02;
  surround.receiveShadow = true; field.add(surround);

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
  field.add(goalPost(HALF_L - 0.6), goalPost(-(HALF_L - 0.6)));
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
  // Midfield logo: a ringed crest with a bold "R".
  const logoTex = canvasTex(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.lineWidth = 12; g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.beginPath(); g.arc(128, 128, 110, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(210,40,40,0.92)'; g.beginPath(); g.arc(128, 128, 96, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = 'bold 150px Arial Black, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('R', 128, 138);
  });
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(15, 15),
    new THREE.MeshBasicMaterial({ map: logoTex, transparent: true, depthWrite: false }));
  logo.rotation.x = -Math.PI / 2; logo.position.set(0, 0.04, 0); logo.userData.proc = true; fieldGroup.add(logo);
  // End-zone wordmarks.
  const word = (text, color) => canvasTex(1024, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.fillStyle = color; g.font = 'bold 170px Arial Black, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.strokeText(text, w / 2, h / 2 + 6); g.fillText(text, w / 2, h / 2 + 6);
  });
  for (const dir of [-1, 1]) {
    const ezTex = word('REAPERS', dir > 0 ? '#ffe2e2' : '#e2ecff');
    const ez = new THREE.Mesh(new THREE.PlaneGeometry(40, 10),
      new THREE.MeshBasicMaterial({ map: ezTex, transparent: true, depthWrite: false }));
    ez.rotation.x = -Math.PI / 2; ez.rotation.z = dir > 0 ? 0 : Math.PI; // read toward each goal
    ez.position.set(0, 0.04, dir * (HALF_L - 5)); ez.userData.proc = true; fieldGroup.add(ez);
  }
}

// --- Jumbotron: a hanging screen behind the blue end showing live score ---
let jumboCtx = null, jumboTex = null, jumboLast = '';
{
  const c = document.createElement('canvas'); c.width = 512; c.height = 256; jumboCtx = c.getContext('2d');
  jumboTex = new THREE.CanvasTexture(c); jumboTex.colorSpace = THREE.SRGBColorSpace;
  jumboTex.wrapS = THREE.RepeatWrapping; jumboTex.repeat.x = -1; jumboTex.offset.x = 1; // un-mirror after the 180° flip
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x10151c, roughness: 0.7, metalness: 0.3 });
  const jt = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(26, 13, 1.2), frameMat); jt.add(frame);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(24, 11), new THREE.MeshBasicMaterial({ map: jumboTex }));
  screen.position.z = 0.65; jt.add(screen);
  for (const sx of [-1, 1]) { const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 22, 8), frameMat); pole.position.set(sx * 9, -17, 0); jt.add(pole); }
  jt.position.set(0, 26, HALF_L + 6); jt.rotation.y = Math.PI; scene.add(jt); // behind the +Z end, screen faces the field
}

// --- Cage: tall, grungy chain-link boundary the ball bounces off (no OOB) ---
{
  // Weathered chain-link: dark steel diamonds with rust speckle and grime.
  const linkTex = canvasTex(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let pass = 0; pass < 2; pass++) {
      g.lineWidth = pass ? 4 : 2.4;
      g.strokeStyle = pass ? 'rgba(28,34,40,0.55)' : 'rgba(150,165,180,0.55)'; // shadow + steel
      for (let i = -h; i < w; i += 14) {
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke();
        g.beginPath(); g.moveTo(i, h); g.lineTo(i + h, 0); g.stroke();
      }
    }
    for (let i = 0; i < 240; i++) { // rust + grime speckle
      g.fillStyle = `rgba(${120 + Math.random() * 80},${50 + Math.random() * 40},${20 + Math.random() * 30},${0.1 + Math.random() * 0.4})`;
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(10,14,18,${0.06 + Math.random() * 0.12})`; g.fillRect(Math.random() * w, Math.random() * h, 30 + Math.random() * 40, 30 + Math.random() * 40); }
  });
  linkTex.wrapS = linkTex.wrapT = THREE.RepeatWrapping;
  const H = 7.5;
  const railMat = new THREE.MeshStandardMaterial({ color: 0x2b3138, metalness: 0.65, roughness: 0.5 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.7, roughness: 0.35, emissive: 0x20262c, emissiveIntensity: 0.4 });
  const wallMesh = (len, x, z, ry) => {
    const t = linkTex.clone(); t.needsUpdate = true; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(Math.round(len / 3), 3);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, H),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.82 }));
    m.position.set(x, H / 2, z); m.rotation.y = ry; scene.add(m);
    // Top edge trim (bright rail) + bottom rail + a kick plate.
    const top = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, 0.3), trimMat); top.position.set(x, H, z); top.rotation.y = ry; scene.add(top);
    const bot = new THREE.Mesh(new THREE.BoxGeometry(len, 0.22, 0.22), railMat); bot.position.set(x, 0.15, z); bot.rotation.y = ry; scene.add(bot);
    const kick = new THREE.Mesh(new THREE.BoxGeometry(len, 0.7, 0.12), railMat); kick.position.set(x, 0.45, z); kick.rotation.y = ry; scene.add(kick);
    // Posts along the run.
    const n = Math.max(2, Math.round(len / 10));
    for (let i = 0; i <= n; i++) {
      const along = -len / 2 + (len / n) * i;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, H, 8), railMat);
      post.position.set(x + Math.cos(ry) * along, H / 2, z - Math.sin(ry) * along); scene.add(post);
    }
  };
  wallMesh(FIELD_L + 3, CAGE_X, 0, Math.PI / 2); wallMesh(FIELD_L + 3, -CAGE_X, 0, Math.PI / 2); // sidelines
  wallMesh(FIELD_W + 3, 0, CAGE_Z, 0); wallMesh(FIELD_W + 3, 0, -CAGE_Z, 0);                     // end lines
  // Pylons at the four corners of each end zone.
  const pylMat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff5a00, emissiveIntensity: 0.8 });
  for (const zz of [GOAL_Z, HALF_L, OWN_GOAL_Z, -HALF_L]) for (const xx of [-HALF_W + 0.3, HALF_W - 0.3]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.1, 8), pylMat);
    p.position.set(xx, 0.55, zz); scene.add(p);
  }
}
function drawJumbo(quarter, clock, scoreLine, downLine) {
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

function makeRing(color) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.95, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.03; m.visible = false;
  scene.add(m); return m;
}
const selRing = makeRing(0xffd54a);
const ctrlRing = makeRing(0xffffff);
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
// Touchdown confetti: a full-pool, multi-color shower that rains down.
function confetti(z) {
  const x = game.carrier ? game.carrier.group.position.x : 0;
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

// ===========================================================================
// Assets + character factory
// ===========================================================================
const loader = new GLTFLoader();
const HEAD_SCALE = 1.6; // Blitz-style oversized heads (applied to both teams)
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const loadGLB = (u) => new Promise((res, rej) => loader.load(u, res, undefined, rej));

let charTemplate, defTemplate, helmetOffTemplate, helmetDefTemplate, footballTemplate;
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
  try { physics = await PhysicsWorld.create(); physics.addCageWalls(CAGE_X, CAGE_Z, 7.5); } // ragdolls bounce off the fence
  catch (e) { console.warn('Physics unavailable — tackles will be instant', e); }
  charTemplate = charGltf.scene;
  defTemplate = defGltf ? defGltf.scene : null;
  // Team helmets (static meshes attached to each head).
  try { helmetOffTemplate = (await loadGLB('assets/helmet_off.glb')).scene; } catch (e) { console.warn('off helmet missing', e); }
  try { helmetDefTemplate = (await loadGLB('assets/helmet_def.glb')).scene; } catch (e) { console.warn('def helmet missing', e); }
  try { footballTemplate = (await loadGLB('assets/football.glb')).scene; } catch (e) { console.warn('football model missing', e); }
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

// Distinct idle stances (X-axis arm rotations + head tilt) so a lineup of
// players reads as individuals instead of clones. Each: ua/fa = right upper/fore
// arm, la/lfa = left upper/fore arm, head = side tilt. Picked at random per
// player, then jittered slightly so even two with the same preset differ.
const STANCES = [
  { ua: 0.10, fa: 0.20, la: 0.10, lfa: 0.20, head: 0.05 },   // relaxed neutral
  { ua: 0.18, fa: 1.30, la: 0.18, lfa: 1.30, head: 0.00 },   // arms folded high
  { ua: 0.05, fa: 0.10, la: 0.40, lfa: 0.55, head: -0.12 },  // one hand on hip (left)
  { ua: 0.40, fa: 0.55, la: 0.05, lfa: 0.10, head: 0.12 },   // one hand on hip (right)
  { ua: 0.30, fa: 0.80, la: 0.30, lfa: 0.80, head: 0.00 },   // hands-on-knees ready
  { ua: -0.22, fa: 0.15, la: -0.22, lfa: 0.15, head: 0.08 }, // loose arms back
  { ua: 0.12, fa: 0.35, la: 0.55, lfa: 0.95, head: -0.06 },  // left arm tucked
  { ua: 0.08, fa: 0.25, la: 0.08, lfa: 0.25, head: 0.18 },   // big head-cock
];

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
  mixer.setTime(Math.random() * 4); // desync the gait so players aren't in lockstep
  actions.idle.timeScale = 0.82 + Math.random() * 0.5; // vary breathing speed per player
  // Per-player idle stance: a random preset + small jitter so the team reads as
  // individuals (some arms-folded, hands-on-hip, head-cocked, etc.).
  const base = STANCES[(Math.random() * STANCES.length) | 0];
  const jit = () => (Math.random() - 0.5) * 0.18;
  const stance = {
    ua: base.ua + jit(), fa: base.fa + jit(), la: base.la + jit(), lfa: base.lfa + jit(),
    head: base.head + (Math.random() - 0.5) * 0.12,
  };

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
    headBone, headEnd, helmet, stance, bones: restPose.map((e) => e[0]), // stance variety + bone list for replay
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
const STATE = { PRESNAP: 'presnap', LIVE: 'live', AIR: 'air', RUN: 'run', RETURN: 'return', TACKLE: 'tackle', BATTLE: 'battle', LOOSE: 'loose', DEAD: 'dead', RESET: 'reset', REPLAY: 'replay' };
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
  resetTimer: 0,                        // between-plays walk-back countdown
  replay: { frames: [], i: 0, hold: 0, angle: 0, bigHit: false }, // instant-replay buffer + cam
  playIndex: 0, defCall: 0, choosing: false, psPage: 0, cpuLastPlay: -1, autoSnapT: 0, // offense play / def call / select / page / CPU last call / CPU snap timer
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
  spin: 0, spinRate: 0, hitFence: false,
  // Catch: ball homes into the catcher's hands before the play resolves.
  catcher: null, secureT: 0, intercept: false, holder: null, intRolled: false,
  trail: [], trailHist: [], mats: [], // glowing comet trail (sprite pool) + ball materials
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
  {
    name: 'DIVE', sub: 'HB up the gut', run: true,
    route(e, sx, los) {
      const P = (x, dz) => new THREE.Vector3(clampX(x), 0, los + game.dir * dz);
      if (e === 3) return [P(sx + 4, 2), P(1, 9), P(0, 22)];      // RB cuts inside, upfield
      return [P(sx, 4)];                                          // WRs stalk-block
    },
  },
  {
    name: 'SWEEP', sub: 'HB bounce outside', run: true,
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
  const base = RATINGS[p.role] || RATINGS.WR;
  const r = {};
  for (let i = 0; i < RAT_KEYS.length; i++) {
    const v = THREE.MathUtils.clamp(base[i] + (p.jitter ? p.jitter[i] : 0), 1, 99);
    r[RAT_KEYS[i]] = v / 99;     // normalized 0..1
    r[RAT_KEYS[i] + 'R'] = Math.round(v); // displayable 1..99
  }
  p.rt = r;
  p.baseSpeed = 7.3 + r.speed * 3.1;        // 7.3 .. 10.4 yd/s
  p.strength = 0.62 + r.strength * 0.76;    // 0.62 .. 1.38 (break/tackle power)
}

// Two fixed 7-man rosters: teamA = the player's red team, teamB = the CPU's
// blue team. Each play, setupPossession() assigns offense/defense ROLES to
// whichever team has the ball, so the same AI drives either side.
function spawnTeams() {
  game.teamA = []; game.teamB = [];
  for (let i = 0; i < 7; i++) {
    const jit = () => Array.from({ length: 5 }, () => Math.round((Math.random() - 0.5) * 10)); // ±5 per attr
    const a = makeCharacter('off'); a.jitter = jit();
    const b = makeCharacter('def'); b.jitter = jit();
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
    if (d.ragdolling || d === game.controlled) continue; // knocked down, or the player drives him
    d.engaged = false;
    const dp = px(d);
    let steer = { x: 0, z: 0 };
    if (carrierIsRunning && carrier) {
      const ip = interceptPoint(d, carrier);
      steer = seek(dp, ip.x, ip.z);
      d.turbo = dist2(dp, px(carrier)) > 4 * 4;
      // A blocker in the way screens this pursuer (slows him — opens a lane).
      const blk = nearestBlockerTo(dp);
      d.engaged = !!blk && distXZ(px(blk), dp) < 1.6;
    } else if (d.job === 'rush') {
      // Pass rush: bear down on the QB; an OL right in front walls you off.
      const qp = px(game.qb);
      steer = seek(dp, qp.x, qp.z);
      const blk = nearestBlockerTo(dp);
      d.engaged = !!blk && distXZ(px(blk), dp) < 1.6 && !(carrier && carrier === game.qb);
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
  // The cage is a hard wall: clamp inside it AND bounce the player off it (they
  // can never pass through). Restitution gives a real carom off the fence.
  const p = ch.group.position, bx = CAGE_X - 0.4, bz = CAGE_Z - 0.4, R = 0.45;
  if (p.x > bx) { p.x = bx; if (ch.vel.x > 0) ch.vel.x = -ch.vel.x * R; }
  else if (p.x < -bx) { p.x = -bx; if (ch.vel.x < 0) ch.vel.x = -ch.vel.x * R; }
  if (p.z > bz) { p.z = bz; if (ch.vel.z > 0) ch.vel.z = -ch.vel.z * R; }
  else if (p.z < -bz) { p.z = -bz; if (ch.vel.z < 0) ch.vel.z = -ch.vel.z * R; }
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

// --- Play-select screen: called before EVERY snap — an offensive playbook on
// your possessions and a defensive call when the CPU has the ball. ----------
const DEF_PLAYS = [
  { name: 'MAN', sub: 'Tight man-up', tag: 'M', col: '#5a8bff' },
  { name: 'ZONE', sub: 'Zones + deep help', tag: 'Z', col: '#3fe08a' },
  { name: 'BLITZ', sub: 'Send the house', tag: '⚡', col: '#ff5a3a' },
  { name: 'SPY', sub: 'Contain the QB', tag: 'S', col: '#ffd23a' },
];
const PS_PAGE = 4; // cards shown per page
const playSelectEl = document.getElementById('playselect');
const psTitle = document.getElementById('ps-title');
const psSide = document.getElementById('ps-side');
const psPrev = document.getElementById('ps-prev');
const psNext = document.getElementById('ps-next');
const psDots = document.getElementById('ps-dots');
const playCards = playSelectEl ? [...playSelectEl.querySelectorAll('.ps-card')] : [];
// Precompute card bodies once: offense = route art, defense = a scheme tag.
const offCardHTML = PLAYS.map((pl, i) => `${makePlayArtSVG(pl)}<i>${i + 1}</i><b>${pl.name}</b><span>${pl.sub}</span>`);
const defCardHTML = DEF_PLAYS.map((d, i) => `<div class="ps-art ps-defart" style="color:${d.col}">${d.tag}</div><i>${i + 1}</i><b>${d.name}</b><span>${d.sub}</span>`);
function psList() { return game.userOnOffense ? offCardHTML : defCardHTML; }
function psPageCount() { return Math.max(1, Math.ceil(psList().length / PS_PAGE)); }
// Render the cards for the current page, plus arrows + dot indicators.
function renderPSPage() {
  const off = game.userOnOffense, html = psList(), sel = off ? game.playIndex : game.defCall;
  const pages = psPageCount();
  game.psPage = Math.max(0, Math.min(game.psPage, pages - 1));
  const start = game.psPage * PS_PAGE;
  playSelectEl.classList.toggle('def-call', !off);
  playCards.forEach((c, slot) => {
    const idx = start + slot;
    if (idx < html.length) {
      c.innerHTML = html[idx]; c.dataset.idx = idx;
      c.classList.toggle('chosen', idx === sel); c.classList.remove('hidden');
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
  // Open on the page that holds the current selection.
  const sel = off ? game.playIndex : game.defCall;
  game.psPage = Math.floor((sel || 0) / PS_PAGE);
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
    if (e.code === 'Space') input.actionEdge = true;
    if (e.code === 'KeyQ') input.spinEdge = true;   // spin / stiff-arm
    if (e.code === 'KeyE') input.diveEdge = true;   // dive
    if (e.code === 'KeyF') input.pitchEdge = true;  // lateral pitch
    if (game.choosing) {
      if (/^Digit[1-4]$/.test(e.code)) choosePlay(game.psPage * PS_PAGE + (+e.code.slice(5) - 1));
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
const elRateCard = document.getElementById('ratecard');
const RC_LABELS = ['SPD', 'STR', 'STA', 'SKL', 'TKL'];
let rcLast = '';
function updateRateCard() {
  const c = game.controlled;
  if (!c || !c.rt) { if (elRateCard) elRateCard.classList.add('hidden'); rcLast = ''; return; }
  const vals = RAT_KEYS.map((k) => c.rt[k + 'R']);
  const key = c.role + vals.join(',');
  if (key === rcLast) return; rcLast = key;
  let rows = '';
  for (let i = 0; i < RAT_KEYS.length; i++) rows += `<div class="rc-row"><span>${RC_LABELS[i]}</span><div class="rc-bar"><i style="width:${vals[i]}%"></i></div><b>${vals[i]}</b></div>`;
  elRateCard.innerHTML = `<div class="rc-role">${c.role}</div>${rows}`;
  elRateCard.classList.remove('hidden');
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
function show(el, label) { el.classList.remove('hidden'); if (label) el.textContent = label; }
function hide(el) { el.classList.add('hidden'); }
function updateButtons() {
  const s = game.state, onO = game.userOnOffense;
  // Ball-carrier move buttons (spin/dive/pitch) only show on YOUR run.
  const showMoves = s === STATE.RUN && onO;
  for (const b of [spinBtn, diveBtn, pitchBtn]) if (b) b.classList.toggle('hidden', !showMoves);
  if (s === STATE.PRESNAP && game.choosing) { hide(actionBtn); hide(turboBtn); }
  else if (s === STATE.PRESNAP) { show(actionBtn, game.gameOver ? 'REMATCH' : (onO ? 'SNAP' : 'SWITCH')); hide(turboBtn); }
  else if (s === STATE.LIVE) { onO ? show(actionBtn, 'THROW') : show(actionBtn, 'SWITCH'); show(turboBtn); }
  else if (s === STATE.AIR) { onO ? hide(actionBtn) : show(actionBtn, 'SWITCH'); show(turboBtn); }
  else if (s === STATE.RUN) { show(actionBtn, onO ? 'JUKE' : 'TACKLE'); show(turboBtn); }
  else if (s === STATE.RETURN) { show(actionBtn, 'TACKLE'); show(turboBtn); }
  else if (s === STATE.LOOSE) { show(actionBtn, 'DIVE'); show(turboBtn); }
  else if (s === STATE.BATTLE) { show(actionBtn, 'MASH!'); hide(turboBtn); }
  else { hide(actionBtn); hide(turboBtn); }
  updateRateCard(); // reflect whoever you're now controlling
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
  if (game.gameOver || game.choosing) return; // clock waits while you pick a play
  if (game.state === STATE.PRESNAP) {
    game.snapClock -= dt;
    if (game.snapClock <= 0) { game.snapClock = 0; setStatus('Delay of game — snapped!'); snap(); }
  } else if (game.state !== STATE.DEAD && game.state !== STATE.RESET) {
    game.gameClock = Math.max(0, game.gameClock - dt); // clock stops between plays
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

const WALK_SPEED = 5.2; // jog-back pace during the between-plays reset
// Prepare the next play's roles, formation spots and ball/marker state.
// teleport=true snaps players to formation (kickoff); false lets them walk back.
function preparePlay(teleport) {
  clearRagdolls(); // animation clips repose every bone on the next mixer update
  if (!game.gameOver && game.gameClock <= 0) advanceQuarter();
  battleEl.classList.add('hidden'); game.battle.tackler = null;
  for (const ch of game.all) {
    ch.oneShotT = 0; ch.throwAnimT = 0; ch.armPoseT = 0; ch.spinT = 0; ch.diveT = 0; ch.recoverT = 0;
    // Per-player walk-back variety so they don't trudge home like robots.
    ch.resetSpeed = WALK_SPEED * (0.6 + Math.random() * 0.85); // amble .. brisk jog
    ch.resetDelay = teleport ? 0 : Math.random() * 0.8;        // staggered starts
    ch.resetCurve = (Math.random() - 0.5) * 1.1;               // curved approach path
  }
  setFumbleGlow(false);
  setupPossession();   // assign offense/defense roles for whoever has the ball
  placeFormation(teleport);
  game.controlled = game.qb; game.carrier = null; game.selected = 0;
  game.returnActive = false; game.returner = null; game.fumbleLost = false;
  ball.mode = 'carried'; ball.holder = game.qb; ball.targetRecv = null;
  ball.catcher = null; ball.secureT = 0; ball.intercept = false;
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
    game.state = STATE.PRESNAP; game.choosing = false; game.snapClock = PLAY_CLOCK;
    updateButtons(); setStatus(`FINAL ${game.scoreOff}–${game.scoreDef} — tap REMATCH`);
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
  game.state = STATE.PRESNAP; game.snapClock = PLAY_CLOCK;
  if (game.userOnOffense) { game.controlled = game.qb; selRing.visible = true; ctrlRing.visible = false; }
  else { game.controlled = nearestToBallDefender(); selRing.visible = false; ctrlRing.visible = true; game.autoSnapT = 1.2 + Math.random() * 0.7; }
  updateButtons();
  setStatus(game.userOnOffense ? `${PLAYS[game.playIndex].name} — tap SNAP` : `${DEF_PLAYS[game.defCall].name} D — move/switch, CPU snaps`);
}

// --- Instant replay -------------------------------------------------------
// While the ball is live we record a lightweight per-frame snapshot (positions,
// headings, current clip + mixer time, ball transform). On a touchdown we play
// it back in slow motion from a cinematic broadcast angle.
const REPLAY_MAX = 320; // ~5s at 60fps
const replayEl = document.getElementById('replay');
// Capture the FINAL pose each frame as raw bone transforms (group + every bone),
// so locomotion, procedural arm poses AND ragdolls all replay exactly. A frame
// is one flat Float32Array: [ball pos3+quat4][per player: group pos3+quat4 + each
// bone pos3+quat4].
function recordFrame() {
  const all = game.all, nb = all[0].bones.length;
  const buf = new Float32Array(7 + all.length * (7 + nb * 7));
  let o = 0;
  const b = ball.mesh; const bp = b.position, bq = b.quaternion;
  buf[o++] = bp.x; buf[o++] = bp.y; buf[o++] = bp.z; buf[o++] = bq.x; buf[o++] = bq.y; buf[o++] = bq.z; buf[o++] = bq.w;
  for (const ch of all) {
    const g = ch.group, gp = g.position, gq = g.quaternion;
    buf[o++] = gp.x; buf[o++] = gp.y; buf[o++] = gp.z; buf[o++] = gq.x; buf[o++] = gq.y; buf[o++] = gq.z; buf[o++] = gq.w;
    for (const bo of ch.bones) { const p = bo.position, q = bo.quaternion; buf[o++] = p.x; buf[o++] = p.y; buf[o++] = p.z; buf[o++] = q.x; buf[o++] = q.y; buf[o++] = q.z; buf[o++] = q.w; }
  }
  const f = game.replay.frames; f.push(buf); if (f.length > REPLAY_MAX) f.shift();
}
function startReplay() {
  if (game.replay.frames.length < 40) return false; // not enough footage — skip
  clearRagdolls(); // physics off; the recorded bone transforms ARE the pose
  game.state = STATE.REPLAY; game.replay.i = 0; game.replay.hold = 0;
  game.replay.angle = (Math.random() < 0.5 ? 1 : -1) * (Math.PI * 0.42); // low ~3/4 sideline angle
  if (replayEl) replayEl.classList.remove('hidden');
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
function updateReplay(dt) {
  const f = game.replay.frames;
  game.replay.i += 0.6; // ~0.6x slow-mo playback
  if (game.replay.i >= f.length - 1) {
    applyReplayFrame(f.length - 1);
    game.replay.hold += dt;
    if (game.replay.hold > 1.3) endReplay();
    return;
  }
  applyReplayFrame(game.replay.i);
}
function endReplay() {
  if (replayEl) replayEl.classList.add('hidden');
  game.replay.frames = [];
  beginReset(); // possession was already set when the play ended
}
// Apply a defensive call to game.defense (on top of the base assignments).
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
  cam.fovKick = 5; // quick zoom punch on the snap
  game.replay.frames.length = 0; game.replay.bigHit = false; // fresh footage for this play
  game.playClock = 0; game.lastBreak = -10;
  game.throwCharge = 0; game.throwArmed = false; // ignore the held snap press
  // The CPU drops back then throws; pick its target now (most open at snap).
  game.cpuQBTimer = game.userOnOffense ? 0 : 1.1 + Math.random() * 0.7;
  let play;
  if (game.userOnOffense) play = PLAYS[game.playIndex] || PLAYS[0];
  else { // CPU: mix it up — never run the same concept twice in a row
    let idx; do { idx = (Math.random() * PLAYS.length) | 0; } while (idx === game.cpuLastPlay && PLAYS.length > 1);
    game.cpuLastPlay = idx; play = PLAYS[idx];
  }
  game.receivers.forEach((r, e) => { r.route = play.route(e, r.align.x, game.los); r.wp = 0; r.cutTimer = 0; r.job = 'route'; });
  game.offense.forEach((o) => { if (o.role === 'OL') o.job = 'block'; }); // linemen block
  game.defense.forEach((d) => {
    d.job = d.role === 'DL' ? 'rush' : d.deep ? 'zone' : 'cover'; // DL rush, S deep, rest cover
    if (d.deep) d.zonePoint = new THREE.Vector3(0, 0, game.los + game.dir * 18);
  });
  // Defensive scheme: your call on D; the CPU mixes coverages on your drives.
  if (!game.userOnOffense) {
    applyDefCall(game.defCall);
    if (!game.controlled || !game.defense.includes(game.controlled)) game.controlled = nearestToBallDefender();
    ctrlRing.visible = true; selRing.visible = false;
  } else { applyDefCall((Math.random() * 4) | 0); }
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
  // QB SKILL tightens the throw (accurate passers miss by less).
  const acc = 1.3 - (game.qb.rt ? game.qb.rt.skill : 0.8) * 0.75; // ~0.9 (elite) .. ~1.2 (poor)
  const errMag = THREE.MathUtils.lerp(0.9, 0.35, p) * THREE.MathUtils.clamp(t / 1.2, 0.5, 1.4) * acc;
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
  const pressured = pressure < 2.4;
  // Drop back, then hold the pocket; flee sideways if a rusher closes.
  if (game.cpuQBTimer > 0.35 && !pressured) { qb.desired = { x: 0, z: -game.dir }; qb.turbo = false; }
  else qb.desired = { x: 0, z: 0 };
  if (ball.mode !== 'carried') return;
  const target = mostOpenReceiver();
  const cov = target ? nearestDefenderTo(px(target)) : null;
  const sep = (target && cov) ? distXZ(px(target), px(cov)) : 9;
  const ready = game.cpuQBTimer <= 0;   // dropback finished — only then look to throw
  const desperate = game.cpuQBTimer < -1.4 || (pressured && pressure < 1.2);
  if (target && ((ready && (sep > 2.0 || pressured)) || desperate)) {
    // Throw to the open man; longer throws get more zip. Accuracy = QB skill.
    ball.targetRecv = target; game.selected = game.receivers.indexOf(target);
    throwBall(THREE.MathUtils.clamp(0.2 + distXZ(px(qb), px(target)) / 50, 0.2, 0.85));
  } else if (pressured && pastLine(qb)) {
    enterRun(qb, ''); // take off — he crossed the line
  } else if (pressured) {
    const away = Math.sign(qb.group.position.x - (rusher ? rusher.group.position.x : 0)) || 1;
    qb.desired = { x: away, z: game.dir * 0.25 }; qb.turbo = true; // climb/escape the pocket
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
  if (rp.z <= OWN_GOAL_Z) { endReturn('defTD', rp.z); return; } // returner reaches the house (cage keeps him inbounds otherwise)
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
    flashScreen(); confetti(endZ); // celebratory flash + shower in the end zone
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
  // Broadcast replay on scores and on big gang-tackle highlights.
  if (result === 'TD' || (result === 'tackle' && game.replay.bigHit)) startReplay();
  game.replay.bigHit = false;
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
function updateBall(dt) {
  if (ball.mode !== 'flying') landRing.visible = false; // landing reticle only mid-flight
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
    // Catchable once it has descended into reach. Resolve only when it actually
    // hits the turf (so an overthrow flies to the back/side wall and bounces),
    // with a safety timeout if it caroms around forever.
    if (ball.vy < 0 && p.y < 2.6 && tryReception()) return;
    if (p.y <= 0.16 || ball.airTime > ball.flightTime + 3) {
      if (tryReception()) return;
      if (ball.hitFence) { ballLooseFromAir(); return; } // a wall carom is a live loose ball, never incomplete
      ball.mode = 'rest'; endPlay('incomplete', game.los);
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

  const dbBall = bestDef && bestDef.rt ? bestDef.rt.skill : 0.55; // DB ball skills (hands/timing)
  // No receiver in catching range yet — but a defender right on the ball can
  // still jump it (skilled DBs more often). Otherwise keep flying.
  if (!bestR) {
    if (bestDef && dD <= INTERCEPT_R && !ball.intRolled) {
      ball.intRolled = true; // one roll per throw, not per frame
      if (Math.random() < 0.18 + dbBall * 0.32) { startSecure(bestDef, true); return true; }
    }
    return false;
  }

  // A receiver is in reach. Uncontested = a clean grab; great hands rarely drop.
  const rxSkill = bestR.rt ? bestR.rt.skill : 0.8;
  const contested = bestDef && dD <= CONTEST_R;
  if (!contested) {
    if (Math.random() < 0.84 + rxSkill * 0.14) { startSecure(bestR, false); return true; }
    passBrokenUp('DROPPED!', '#dfe7ff', bestR, 'reach'); return true; // receiver lunges, drops it
  }

  // Contested: catch odds fall as coverage tightens, lifted by the receiver's
  // hands and lowered by the defender's coverage skill; picks scale with the DB.
  const tight = 1 - THREE.MathUtils.clamp(dD / CONTEST_R, 0, 1); // 0 loose .. 1 glued
  let pCatch = THREE.MathUtils.lerp(0.80, 0.25, tight) + (rxSkill - 0.8) * 0.6 - (dbBall - 0.6) * 0.3;
  if (game.onFire) pCatch += 0.12;
  pCatch = THREE.MathUtils.clamp(pCatch, 0.05, 0.95);
  if (Math.random() < pCatch) { startSecure(bestR, false); return true; } // contested grab
  if (dD <= INTERCEPT_R && Math.random() < 0.16 + dbBall * 0.32) { startSecure(bestDef, true); return true; } // pick
  passBrokenUp('BROKEN UP!', '#9fd0ff', bestDef, 'swat'); return true; // DB bats it away
}
function checkRunOutcome() {
  const c = game.carrier.group.position;
  if (reachedGoal(c.z)) { endPlay('TD', c.z); return; }
  // No out of bounds — the cage keeps the carrier in (clampToField).
  for (const db of game.defense) {
    if (db.ragdolling) continue;
    if (Math.hypot(db.group.position.x - c.x, db.group.position.z - c.z) <= TACKLE_R) { beginTackle(db); return; }
  }
}
// SACK: a rusher (or your driven defender) who reaches the QB in the pocket
// before the throw drops him for a loss — committed tackle, ragdoll, can strip.
function checkSack() {
  const qp = game.qb.group.position;
  for (const d of game.defense) {
    if (d.ragdolling) continue;
    if (Math.hypot(d.group.position.x - qp.x, d.group.position.z - qp.z) <= TACKLE_R) {
      game.carrier = game.qb; beginTackle(d, true);
      showBanner('SACK!', '#ff5a3a'); setStatus('SACK!'); audio.bigHit();
      return;
    }
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
  for (const t of pile) gangStr += 0.5 + (t.rt ? t.rt.tackle : 0.6); // wrap-up scales with TACKLING
  p *= THREE.MathUtils.clamp(power / (gangStr * 0.95), 0.3, 1.25);
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
  // A strong TACKLER drags the meter down faster; a strong carrier resists.
  const tklPow = 0.4 + (b.tackler.rt ? b.tackler.rt.tackle : 0.6), carPow = 0.4 + (game.carrier.rt ? game.carrier.rt.strength : 0.7);
  b.val -= BATTLE_CPU * dt * THREE.MathUtils.clamp(tklPow / carPow, 0.6, 1.8);
  b.val = THREE.MathUtils.clamp(b.val, 0, 1);

  // Locked in contact: the carrier DRIVES off the anchor toward the tackler as
  // he wins the meter (and gets shoved back as he loses); the tackler stays a
  // shoulder-width in front. A small wobble keeps the wrestle alive.
  const wob = Math.sin(game.playClock * 22) * 0.08;
  const ang = game.carrier.heading, sa = Math.sin(ang), ca = Math.cos(ang);
  const drive = (b.val - 0.5) * 2.2;             // yards the carrier pushes the pile
  const c = game.carrier.group.position;
  c.x = b.baseX + sa * drive; c.z = b.baseZ + ca * drive;
  const half = 0.88 + wob;
  const tk = b.tackler.group.position;
  tk.x = c.x + sa * half; tk.z = c.z + ca * half;

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
  setBallEmissive(on ? 0xffcc33 : 0x000000, on ? 0.9 : 0);
  if (ball.flame) { ball.flame.color.setHex(on ? 0xffd23a : 0xff6622); ball.flame.intensity = on ? 3.5 : (game.onFire ? 2 : 0); ball.flame.distance = on ? 10 : 7; }
}
// A pass that caromed off the fence drops in as a LIVE loose ball (scramble),
// keeping its current bounced velocity — never an incompletion.
function ballLooseFromAir() {
  game.state = STATE.LOOSE; game.looseTimer = 5.0;
  ball.mode = 'loose'; ball.holder = null; ball.catcher = null; ball.targetRecv = null; ball.g = 24;
  setFumbleGlow(true); landRing.visible = false;
  game.controlled = nearestTeamToBall(game.teamA);
  ctrlRing.visible = true; selRing.visible = false;
  showBanner('OFF THE FENCE!', '#7fe0ff'); audio.fence(0.6); shake.add(0.15);
  setStatus('Loose ball — recover it!'); updateButtons();
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
  cageBounce(p, 0.5); // a loose ball ricochets off the cage (and loses pace) and stays live
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
const _tq = new THREE.Quaternion(), _xAxisL = new THREE.Vector3(1, 0, 0), _zAxisL = new THREE.Vector3(0, 0, 1);
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
// Break-tackle BATTLE pose: the two lean into each other and churn — the
// tackler wraps up (both arms forward, head down), the carrier drives through
// (stiff-arm out, ball cradled). Procedural so it reads as real contact.
const _qLeanY = new THREE.Quaternion(), _qLeanX = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0), _XAX = new THREE.Vector3(1, 0, 0);
function applyBattleLean(ch, isTackler) {
  const lean = (isTackler ? 0.42 : 0.34) + Math.sin(performance.now() * 0.012) * 0.05; // forward tilt + strain
  _qLeanY.setFromAxisAngle(_UP, ch.heading);
  _qLeanX.setFromAxisAngle(_XAX, lean);
  ch.group.quaternion.copy(_qLeanY).multiply(_qLeanX);
}
function applyBattleArms(ch, isTackler) {
  if (!ch.upperArm || !ch.upperArmRest) return;
  const t = performance.now() * 0.001;
  const set = (bone, rest, a) => { if (bone && rest) { _tq.setFromAxisAngle(_xAxisL, a); bone.quaternion.copy(rest).multiply(_tq); bone.updateMatrixWorld(true); } };
  if (isTackler) { // both arms reach in to wrap, pumping with the struggle
    const a = 1.55 + Math.sin(t * 9) * 0.12;
    set(ch.upperArm, ch.upperArmRest, -a); set(ch.foreArm, ch.foreArmRest, -0.85);
    set(ch.leftArm, ch.leftArmRest, -a); set(ch.leftForeArm, ch.leftForeArmRest, -0.85);
  } else {        // carrier: right arm stiff-arms out, left cradles the ball
    const a = 1.35 + Math.sin(t * 9 + 1) * 0.18;
    set(ch.upperArm, ch.upperArmRest, -a); set(ch.foreArm, ch.foreArmRest, -0.15); // straight stiff-arm
    set(ch.leftArm, ch.leftArmRest, -0.5); set(ch.leftForeArm, ch.leftForeArmRest, -1.5); // tuck/cradle
  }
}
function updateAnimation(ch, dt) {
  if (ch.ragdolling) return; // bones are physics-driven — the mixer must not fight them
  const inBattle = game.state === STATE.BATTLE && (ch === game.carrier || ch === game.battle.tackler);
  if (ch.oneShotT > 0 && !inBattle) {     // hold a one-shot (juke roll)
    ch.oneShotT -= dt;
    ch.group.rotation.y = ch.heading;
    ch.mixer.update(dt);
    return;
  }
  let want = 'idle';
  if (inBattle) want = 'run';                // churning legs in the wrestle
  else if (ch.speed > 11) want = 'sprint';   // turbo / RunFast
  else if (ch.speed > 6) want = 'run';
  else if (ch.speed > 0.5) want = 'walk';
  setClip(ch, want);
  if (inBattle) applyBattleLean(ch, ch === game.battle.tackler);
  else {
    ch.group.rotation.set(0, ch.heading, 0);
    if (ch.spinT > 0) ch.group.rotation.y += (1 - ch.spinT / 0.5) * Math.PI * 2; // 360 spin move
  }
  ch.mixer.update(dt);
  // Procedural arm overrides (after the mixer), in priority order: the battle
  // grapple, securing a catch, throwing, then a one-off arm action.
  if (inBattle) applyBattleArms(ch, ch === game.battle.tackler);
  else if (ball.mode === 'secured' && ch === ball.catcher) applyCatchPose(ch, ball.mesh.position);
  else if (ch.throwAnimT > 0) applyThrowPose(ch, dt);
  else if (ch.armPoseT > 0) applyArmAction(ch, dt);
  else if (want === 'idle') applyIdleStance(ch); // per-player stance variety
}
// A small, static per-player tweak to the idle pose (arm hang + head tilt) so
// the team doesn't stand in identical stances.
function applyIdleStance(ch) {
  const s = ch.stance; if (!s || !ch.upperArm) return;
  _tq.setFromAxisAngle(_xAxisL, s.ua); ch.upperArm.quaternion.multiply(_tq); ch.upperArm.updateMatrixWorld(true);
  if (ch.foreArm) { _tq.setFromAxisAngle(_xAxisL, -s.fa); ch.foreArm.quaternion.multiply(_tq); }
  if (ch.leftArm) { _tq.setFromAxisAngle(_xAxisL, s.la); ch.leftArm.quaternion.multiply(_tq); ch.leftArm.updateMatrixWorld(true); }
  if (ch.leftForeArm) { _tq.setFromAxisAngle(_xAxisL, -s.lfa); ch.leftForeArm.quaternion.multiply(_tq); }
  if (ch.headBone && s.head) { _tq.setFromAxisAngle(_zAxisL, s.head); ch.headBone.quaternion.multiply(_tq); }
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
  if (game.state === STATE.REPLAY) { if (actionEdge) endReplay(); else updateReplay(dt); return; }
  tickClock(dt); // game clock / play clock (may auto-snap on delay of game)

  if (game.state === STATE.PRESNAP) {
    if (game.gameOver) { if (actionEdge) resetGame(); }
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
    if (game.state === STATE.LIVE) checkSack(); // a rusher at the QB = sack
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
  // Record footage while the ball is live (for the touchdown replay).
  if (game.state !== STATE.PRESNAP && game.state !== STATE.DEAD && game.state !== STATE.RESET) recordFrame();

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
  if (game.state === STATE.DEAD) {
    // Whistle beat: everyone still up brakes to a stop (run -> walk -> idle),
    // then they jog back into formation (RESET) for the next play.
    for (const ch of game.all) if (!ch.ragdolling) {
      ch.vel.x *= Math.max(0, 1 - dt * 4); ch.vel.z *= Math.max(0, 1 - dt * 4);
      ch.group.position.x += ch.vel.x * dt; ch.group.position.z += ch.vel.z * dt;
      ch.speed = Math.hypot(ch.vel.x, ch.vel.z);
    }
    game.deadTimer -= dt; if (game.deadTimer <= 0) beginReset();
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
  cine: 0, cineHold: 0,                   // contact-hit close-up amount / hold
  back: 11, hgt: 6.8, aheadL: 11, lookH: 1.5, fovKick: 0, // eased framing + snap zoom punch
};
const _tp = new THREE.Vector3(), _tl = new THREE.Vector3(), _fp = new THREE.Vector3();
const _cinePos = new THREE.Vector3(), _cineLook = new THREE.Vector3();

/** Punch the camera in tight on the action for `hold` seconds (a hit close-up). */
function hitZoom(hold = 0.5) { cam.cineHold = Math.max(cam.cineHold, hold); }

function updateCamera(dt) {
  if (game.state === STATE.REPLAY) {
    // Cinematic broadcast shot: a low, tight angle that slowly orbits the ball.
    const b = ball.mesh.position;
    const a = game.replay.angle + game.replay.i * 0.0016; // gentle dolly/orbit
    _tp.set(b.x + Math.sin(a) * 13, 3.4, b.z + Math.cos(a) * 13);
    cam.pos.lerp(_tp, Math.min(1, dt * 3));
    cam.lookCur.lerp(b, Math.min(1, dt * 5));
    const wantFov = 40; if (Math.abs(camera.fov - wantFov) > 0.01) { camera.fov = wantFov; camera.updateProjectionMatrix(); }
    camera.position.copy(cam.pos); camera.lookAt(cam.lookCur);
    sun.position.set(b.x + 40, 70, b.z + 20); sun.target.position.set(b.x, 0, b.z);
    return;
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
  if (air || loose || ball.mode === 'rest' || ball.mode === 'secured') _fp.copy(ball.mesh.position);
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
  const back = passPlay ? 11 : chase ? 7 : loose ? 9.5 : 8.5;
  const hgt = air ? Math.max(6.8, _fp.y + 3) : passPlay ? 6.8 : chase ? 4.3 : 5.6;
  const aheadL = passPlay ? 11 : chase ? 7.5 : loose ? 6 : 6.5;
  const lookH = air ? (_fp.y * 0.5 + 1.0) : 1.5;
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
  // Symmetric, gentle ease both ways → no snap/jerk into or out of the zoom.
  cam.cine = moveToward(cam.cine, wantCine, dt / (wantCine > cam.cine ? 0.28 : 0.6));
  const e = cam.cine * cam.cine * (3 - 2 * cam.cine); // smoothstep
  if (cam.cine > 0.001) {
    const f = (game.carrier || t).group.position;
    _cinePos.set(f.x + 3.4, 3.6, f.z - 3.0);
    _cineLook.set(f.x, 1.0, f.z);
    _tp.lerp(_cinePos, e); _tl.lerp(_cineLook, e);
  }
  // FOV: a touch wider on pass plays so more of the field fits; the hit close-up
  // zooms in from there (down to ~34°).
  const baseFov = passPlay ? 60 : 55;
  cam.fovKick = Math.max(0, cam.fovKick - dt * 22); // snap zoom-punch, eases out
  const wantFov = baseFov - (baseFov - 34) * e - cam.fovKick;
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

  updateAmbience(realDt);
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



















