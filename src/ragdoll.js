import * as THREE from 'three';
import RAPIER from '../vendor/rapier/rapier.es.js';

// ===========================================================================
// Physics world (ported from Football-Game/PhysicsWorld.ts)
// Thin wrapper over Rapier3D: fixed 60 Hz step with substepping for joint
// stability, and a flat ground. Units here are yards (~metres), kg, seconds.
// ===========================================================================
export class PhysicsWorld {
  substeps = 4;
  #baseSubsteps = 4;
  #highRefs = 0;

  constructor(world) {
    this.world = world;
    this.rapier = RAPIER;
    world.timestep = 1 / 60;
  }

  static async create(gravityY = -9.81) {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: gravityY, z: 0 });
    const pw = new PhysicsWorld(world);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(250, 0.5, 250).setTranslation(0, -0.5, 0).setFriction(1.4),
      body);
    return pw;
  }

  // Ragdolls need tighter joints (8 substeps). Refcounted so overlapping
  // tackle piles don't clobber the shared baseline.
  acquireHighSubsteps() { this.#highRefs++; this.substeps = 8; }
  releaseHighSubsteps() {
    this.#highRefs = Math.max(0, this.#highRefs - 1);
    if (this.#highRefs === 0) this.substeps = this.#baseSubsteps;
  }

  /** Advance one 1/60 frame. `preSubstep(dt)` runs before every internal substep. */
  step(preSubstep) {
    const sub = Math.max(1, this.substeps | 0);
    const dt = 1 / 60 / sub;
    this.world.timestep = dt;
    for (let i = 0; i < sub; i++) { if (preSubstep) preSubstep(dt); this.world.step(); }
    this.world.timestep = 1 / 60;
  }
}

// ===========================================================================
// TackleRagdoll (ported from Football-Game/TackleRagdoll.ts; bone names
// adapted from the mixamo rig to this Meshy rig).
//
// A passive (limp) ragdoll built to MATCH the live skeleton: on a tackle we
// snapshot the current animated pose, spawn capsule bodies at it with the
// player's momentum + the tackle impulse, let physics play the fall, and
// drive the skinned mesh's bones from the rigid bodies — every tackle is
// unique and reactive. Soft anatomical cone+twist limits keep the body from
// folding or candy-wrappering into impossible shapes.
// ===========================================================================

// Major segments, parents before children. sw = soft swing (cone) limit,
// tw = soft twist limit about the bone axis, fixed = welded (wrists/ankles).
const SEGS = [
  { name: 'pelvis', top: 'Hips', bot: 'Spine01', drives: 'Hips', parent: null, r: 0.15, m: 12 },
  { name: 'torso', top: 'Spine01', bot: 'neck', drives: 'Spine01', parent: 'pelvis', r: 0.16, m: 16, sw: 0.5, tw: 0.32 },
  { name: 'head', top: 'neck', bot: 'head_end', drives: 'neck', parent: 'torso', r: 0.11, m: 4.5, sw: 0.6, tw: 0.45 },
  { name: 'thighL', top: 'LeftUpLeg', bot: 'LeftLeg', drives: 'LeftUpLeg', parent: 'pelvis', r: 0.085, m: 7, sw: 1.15, tw: 0.28 },
  { name: 'shinL', top: 'LeftLeg', bot: 'LeftFoot', drives: 'LeftLeg', parent: 'thighL', r: 0.06, m: 4, sw: 1.0, tw: 0.1 },
  { name: 'footL', top: 'LeftFoot', bot: 'LeftToeBase', drives: 'LeftFoot', parent: 'shinL', r: 0.05, m: 1, fixed: true },
  { name: 'thighR', top: 'RightUpLeg', bot: 'RightLeg', drives: 'RightUpLeg', parent: 'pelvis', r: 0.085, m: 7, sw: 1.15, tw: 0.28 },
  { name: 'shinR', top: 'RightLeg', bot: 'RightFoot', drives: 'RightLeg', parent: 'thighR', r: 0.06, m: 4, sw: 1.0, tw: 0.1 },
  { name: 'footR', top: 'RightFoot', bot: 'RightToeBase', drives: 'RightFoot', parent: 'shinR', r: 0.05, m: 1, fixed: true },
  { name: 'uarmL', top: 'LeftArm', bot: 'LeftForeArm', drives: 'LeftArm', parent: 'torso', r: 0.05, m: 2.5, sw: 1.45, tw: 0.5 },
  { name: 'farmL', top: 'LeftForeArm', bot: 'LeftHand', drives: 'LeftForeArm', parent: 'uarmL', r: 0.045, m: 1.5, sw: 1.3, tw: 0.18 },
  { name: 'uarmR', top: 'RightArm', bot: 'RightForeArm', drives: 'RightArm', parent: 'torso', r: 0.05, m: 2.5, sw: 1.45, tw: 0.5 },
  { name: 'farmR', top: 'RightForeArm', bot: 'RightHand', drives: 'RightForeArm', parent: 'uarmR', r: 0.045, m: 1.5, sw: 1.3, tw: 0.18 },
  // Hands have no finger bones on this rig: their far end is synthesized by
  // extending past the wrist (see spawn).
  { name: 'handL', top: 'LeftHand', bot: 'LeftHand', drives: 'LeftHand', parent: 'farmL', r: 0.04, m: 0.5, fixed: true },
  { name: 'handR', top: 'RightHand', bot: 'RightHand', drives: 'RightHand', parent: 'farmR', r: 0.04, m: 0.5, fixed: true },
];

// Endpoint fallbacks for missing bones — a skipped segment beats a crash.
const BONE_FALLBACKS = {
  Spine01: ['Spine02', 'Hips'],
  neck: ['Spine'],
  head_end: ['Head'],
  LeftToeBase: ['LeftFoot'],
  RightToeBase: ['RightFoot'],
};

const LOWER = new Set(['thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR']);
const MAX_SPIN = 10; // rad/s — a body can never spin up into a contorted blur

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _dir = new THREE.Vector3();
const _c = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _pq = new THREE.Quaternion(), _wp = new THREE.Vector3(), _wp2 = new THREE.Vector3();
const _upVel = new THREE.Vector3(), _midVel = new THREE.Vector3();
const _sideDir = new THREE.Vector3(), _sideVel = new THREE.Vector3();
const _angVel = new THREE.Vector3(), _twistVel = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _lpQ = new THREE.Quaternion(), _lcQ = new THREE.Quaternion(), _ltmp = new THREE.Quaternion();
const _lrel = new THREE.Quaternion(), _ldev = new THREE.Quaternion(), _ltwistInv = new THREE.Quaternion();
const _lswing = new THREE.Quaternion(), _lrest = new THREE.Quaternion(), _ltorque = new THREE.Vector3();

export class TackleRagdoll {
  constructor(physics) {
    this.physics = physics;
    this.active = false;
    this.segs = [];
    this.bones = new Map(); // short name -> [bone instances]
    this.highSub = false;
    this.age = 0;
    this.groups = 0x00020003;
  }

  /** Collect every bone instance, grouped by name. */
  bind(root) {
    root.traverse((o) => {
      if (o.isBone) {
        const list = this.bones.get(o.name);
        if (list) list.push(o); else this.bones.set(o.name, [o]);
      }
    });
  }

  tryBone(name) {
    const direct = this.bones.get(name);
    if (direct && direct.length) return direct[0];
    for (const fb of BONE_FALLBACKS[name] ?? []) {
      const b = this.bones.get(fb);
      if (b && b.length) return b[0];
    }
    return null;
  }
  tryBoneList(name) {
    const direct = this.bones.get(name);
    if (direct && direct.length) return direct;
    for (const fb of BONE_FALLBACKS[name] ?? []) {
      const b = this.bones.get(fb);
      if (b && b.length) return b;
    }
    return null;
  }

  /**
   * Spawn at the skeleton's current world pose and knock it down. `carryVel`
   * is the player's running momentum; the hit is `hitDir` (unit) at
   * `hitSpeed`, applied to one tier of the body (per `variant`) while the
   * rest lags, so the body topples around the hit.
   */
  spawn(carryVel, hitDir, hitSpeed, collisionBit = 0x0002, variant = 'highKnock') {
    if (this.active) this.dispose();
    try {
      this.#spawnInner(carryVel, hitDir, hitSpeed, collisionBit, variant);
    } catch (e) {
      // A failed spawn must never take down the sim tick OR leak.
      console.warn('[TackleRagdoll] spawn failed', e);
      for (const seg of this.segs) this.physics.world.removeRigidBody(seg.body);
      this.segs = [];
      this.active = false;
      if (this.highSub) { this.physics.releaseHighSubsteps(); this.highSub = false; }
    }
  }

  #spawnInner(carryVel, hitDir, hitSpeed, collisionBit, variant) {
    // Membership = this ragdoll's bit; collides with the ground (0x0001) and
    // its OWN bit (self-collision) but NOT other ragdolls' bits, so a tackle
    // pile stays stable instead of exploding.
    this.groups = ((collisionBit & 0xffff) << 16) | (0x0001 | (collisionBit & 0xffff));
    const world = this.physics.world;
    const R = this.physics.rapier;
    const byName = new Map();
    this.age = 0;
    this.physics.acquireHighSubsteps();
    this.highSub = true;

    const hitVel = _upVel.copy(hitDir).multiplyScalar(hitSpeed).add(carryVel);
    const midVel = _midVel.copy(hitDir).multiplyScalar(hitSpeed * 0.45).add(carryVel);
    _sideDir.set(-hitDir.z, 0, hitDir.x);
    if (_sideDir.lengthSq() > 1e-6) _sideDir.normalize();
    const sideVel = _sideVel.copy(_sideDir).multiplyScalar(hitSpeed * 0.6).add(carryVel);
    const angVel = _angVel.copy(hitDir).multiplyScalar(hitSpeed * 0.8).addScaledVector(_sideDir, hitSpeed * 0.35).add(carryVel);
    const twistVel = _twistVel.copy(carryVel).addScaledVector(_sideDir, hitSpeed * 0.5);

    for (const def of SEGS) {
      const top = this.tryBone(def.top);
      const bot = this.tryBone(def.bot);
      const driveBoneList = this.tryBoneList(def.drives);
      if (!top || !bot || !driveBoneList) continue;
      top.getWorldPosition(_a);
      bot.getWorldPosition(_b);
      if (_a.distanceToSquared(_b) < 0.0009) {
        // Endpoint collapsed onto the top joint (the hands): synthesize the
        // far end by extending past the joint along its parent's direction.
        top.parent.getWorldPosition(_wp2);
        _dir.subVectors(_a, _wp2);
        if (_dir.lengthSq() < 1e-8) _dir.set(0, -1, 0);
        _b.copy(_a).addScaledVector(_dir.normalize(), Math.max(0.08, def.r * 1.6));
      }
      _c.addVectors(_a, _b).multiplyScalar(0.5);
      _dir.subVectors(_b, _a);
      const len = Math.max(0.04, _dir.length());
      _dir.divideScalar(len);
      _q.setFromUnitVectors(_UP, _dir);

      // Velocity tiers per variant: pelvis gets the attenuated drive; the
      // rest split upper-vs-legs so each variant topples differently.
      const isLeg = LOWER.has(def.name);
      const isPelvis = def.name === 'pelvis';
      let v;
      switch (variant) {
        case 'lowCut': v = isPelvis ? midVel : (isLeg ? hitVel : carryVel); break;
        case 'sideSwipe': v = isPelvis ? midVel : (isLeg ? carryVel : sideVel); break;
        case 'angledBack': v = isPelvis ? midVel : (isLeg ? carryVel : angVel); break;
        case 'twist': v = isPelvis ? midVel : (isLeg ? twistVel : hitVel); break;
        default: v = isPelvis ? midVel : (isLeg ? carryVel : hitVel); break; // highKnock
      }
      const segR = Math.min(def.r, Math.max(0.03, len / 2 - 0.01));
      const body = world.createRigidBody(R.RigidBodyDesc.dynamic()
        .setTranslation(_c.x, _c.y, _c.z)
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
        .setLinvel(v.x, v.y, v.z)
        .setAngularDamping(7.5)
        .setLinearDamping(0.4)
        .setCanSleep(true));
      const half = Math.max(0.02, len / 2 - segR);
      world.createCollider(R.ColliderDesc.capsule(half, segR)
        .setDensity(0).setMass(def.m)
        .setFriction(0.8).setRestitution(0)
        .setCollisionGroups(this.groups), body);

      const driveBone = driveBoneList[0];
      driveBone.getWorldQuaternion(_q2);
      const qOffset = _pq.copy(_q).invert().multiply(_q2).clone();
      driveBone.getWorldPosition(_wp);
      const posOffset = _b.copy(_wp).sub(_c).applyQuaternion(_q.clone().invert()).clone();

      const seg = {
        ...def, r: segR, body, center: _c.clone(), qOffset, posOffset,
        driveBone, driveBones: driveBoneList, parentSeg: null,
        qRelRest: new THREE.Quaternion(),
      };
      this.segs.push(seg);
      byName.set(def.name, seg);
    }
    if (!byName.has('pelvis')) throw new Error('rig has no resolvable pelvis segment');

    // Link segments with spherical joints (wrists/ankles welded); soft
    // cone+twist limits are enforced per-substep in applyLimits.
    for (const seg of this.segs) {
      if (!seg.parent) continue;
      let parentName = seg.parent, parent;
      while (parentName && !(parent = byName.get(parentName))) {
        parentName = SEGS.find((d) => d.name === parentName)?.parent ?? null;
      }
      if (!parent) continue;
      seg.parentSeg = parent;
      seg.qRelRest.copy(quatOf(parent.body)).invert().multiply(quatOf(seg.body));
      this.tryBone(seg.top).getWorldPosition(_a);
      const aChild = _b.copy(_a).sub(seg.center).applyQuaternion(_q.copy(quatOf(seg.body)).invert());
      const aParent = _c.copy(_a).sub(parent.center).applyQuaternion(_q2.copy(quatOf(parent.body)).invert());
      const data = seg.fixed
        ? RAPIER.JointData.fixed(
          { x: aParent.x, y: aParent.y, z: aParent.z }, { x: _q2.x, y: _q2.y, z: _q2.z, w: _q2.w },
          { x: aChild.x, y: aChild.y, z: aChild.z }, { x: _q.x, y: _q.y, z: _q.z, w: _q.w })
        : RAPIER.JointData.spherical(
          { x: aParent.x, y: aParent.y, z: aParent.z },
          { x: aChild.x, y: aChild.y, z: aChild.z });
      const joint = this.physics.world.createImpulseJoint(data, parent.body, seg.body, true);
      joint.setContactsEnabled?.(false); // jointed segments overlap — no contacts
    }
    this.active = true;
  }

  /**
   * Soft cone+twist joint limits, run once per physics substep. Within range
   * the ragdoll is limp; beyond it a spring pushes back. TWIST stops the
   * candy-wrapper; SWING stops the body folding in half.
   */
  applyLimits(dt) {
    if (!this.active) return;
    // Safety floor: never let a body sink under the turf.
    for (const seg of this.segs) {
      const t = seg.body.translation();
      const minY = seg.r * 0.85;
      if (t.y < minY) {
        seg.body.setTranslation({ x: t.x, y: minY, z: t.z }, true);
        const v = seg.body.linvel();
        if (v.y < 0) seg.body.setLinvel({ x: v.x, y: 0, z: v.z }, true);
      }
    }
    this.age += dt;
    const swingFade = this.age < 0.8 ? 1 : Math.max(0.5, 1 - (this.age - 0.8) * 0.45);
    const kSwing = 8 * swingFade, kTwist = 9, kDamp = 5.0, dead = 0.05, maxT = 12;
    for (const seg of this.segs) {
      const parent = seg.parentSeg;
      if (!parent || seg.sw === undefined) continue;
      const wc = seg.body.angvel(), wpv = parent.body.angvel();
      const relx = wc.x - wpv.x, rely = wc.y - wpv.y, relz = wc.z - wpv.z;
      const calm = relx * relx + rely * rely + relz * relz < 0.04;

      const pr = parent.body.rotation(); _lpQ.set(pr.x, pr.y, pr.z, pr.w);
      const cr = seg.body.rotation(); _lcQ.set(cr.x, cr.y, cr.z, cr.w);
      _ltmp.copy(_lpQ).invert();
      _lrel.copy(_ltmp).multiply(_lcQ);
      _ldev.copy(seg.qRelRest).invert().multiply(_lrel);
      if (_ldev.w < 0) { _ldev.x *= -1; _ldev.y *= -1; _ldev.z *= -1; _ldev.w *= -1; }
      const twistAngle = 2 * Math.atan2(_ldev.y, _ldev.w);
      const s = Math.sin(twistAngle / 2), cw = Math.cos(twistAngle / 2);
      _ltwistInv.set(0, -s, 0, cw);
      _lswing.copy(_ldev).multiply(_ltwistInv);
      if (_lswing.w < 0) { _lswing.x *= -1; _lswing.y *= -1; _lswing.z *= -1; _lswing.w *= -1; }
      const swingAngle = 2 * Math.acos(Math.min(1, _lswing.w));

      const overSwing = swingAngle > seg.sw + dead;
      const tl = seg.tw ?? 0.4;
      const overTwist = twistAngle > tl + dead || twistAngle < -tl - dead;
      if (calm && !overSwing && !overTwist) continue;

      _ltorque.set(0, 0, 0);
      if (overSwing) {
        const len = Math.hypot(_lswing.x, _lswing.y, _lswing.z) || 1;
        const k = (-kSwing * (swingAngle - seg.sw)) / len;
        _ltorque.set(_lswing.x * k, _lswing.y * k, _lswing.z * k);
      }
      if (twistAngle > tl) _ltorque.y += -kTwist * (twistAngle - tl);
      else if (twistAngle < -tl) _ltorque.y += -kTwist * (twistAngle + tl);
      _lrest.copy(_lpQ).multiply(seg.qRelRest);
      _ltorque.applyQuaternion(_lrest);
      const rlen = Math.hypot(relx, rely, relz);
      const rs = rlen > 8 ? 8 / rlen : 1;
      _ltorque.x -= kDamp * relx * rs;
      _ltorque.y -= kDamp * rely * rs;
      _ltorque.z -= kDamp * relz * rs;
      const tlen = _ltorque.length();
      if (!Number.isFinite(tlen)) continue;
      if (tlen > maxT) _ltorque.multiplyScalar(maxT / tlen);
      seg.body.applyTorqueImpulse({ x: _ltorque.x * dt, y: _ltorque.y * dt, z: _ltorque.z * dt }, true);
    }
  }

  /** Each frame after stepping physics: clamp spin, then drive the bones. */
  drive() {
    if (!this.active) return;
    for (const seg of this.segs) {
      const w = seg.body.angvel();
      const m2 = w.x * w.x + w.y * w.y + w.z * w.z;
      if (m2 > MAX_SPIN * MAX_SPIN) {
        const s = MAX_SPIN / Math.sqrt(m2);
        seg.body.setAngvel({ x: w.x * s, y: w.y * s, z: w.z * s }, true);
      }
      const t = seg.body.translation();
      const r = seg.body.rotation();
      _q.set(r.x, r.y, r.z, r.w);
      _q2.copy(_q).multiply(seg.qOffset);
      _wp.set(t.x, t.y, t.z).add(_dir.copy(seg.posOffset).applyQuaternion(_q));
      for (const bone of seg.driveBones) {
        const parent = bone.parent;
        parent.getWorldQuaternion(_pq);
        bone.quaternion.copy(_pq.invert().multiply(_q2));
        _wp2.copy(_wp);
        parent.worldToLocal(_wp2);
        bone.position.copy(_wp2);
        bone.updateWorldMatrix(false, false);
      }
    }
  }

  /** Roughly at rest? (all bodies nearly stopped) */
  settled() {
    if (!this.active) return false;
    for (const seg of this.segs) {
      const v = seg.body.linvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z > 0.02) return false;
    }
    return true;
  }

  dispose() {
    for (const seg of this.segs) this.physics.world.removeRigidBody(seg.body);
    this.segs = [];
    this.active = false;
    if (this.highSub) { this.physics.releaseHighSubsteps(); this.highSub = false; }
  }
}

/** Choose the carrier's fall reaction from the contact (from TackleEngine.ts). */
export function pickVariant(big, gangSize, closing, hitX, hitZ) {
  if (big && gangSize >= 2) return 'twist';                                  // gang swarm twists him down
  if (closing > 10 && Math.abs(hitX) > Math.abs(hitZ) * 1.2) return 'sideSwipe'; // fast side-on hit
  const r = Math.random();
  return r < 0.4 ? 'highKnock' : r < 0.72 ? 'lowCut' : 'sideSwipe';
}

function quatOf(b) {
  const r = b.rotation();
  return new THREE.Quaternion(r.x, r.y, r.z, r.w);
}
