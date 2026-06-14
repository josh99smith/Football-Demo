// Strip a Meshy "withSkin" / merged GLB down to ANIMATION-ONLY: keep the node
// (bone) hierarchy + scenes + every animation, drop the skinned mesh, images,
// textures, materials and skins, and rebuild the BIN so it holds only the
// keyframe accessors. The result drives our identically-rigged character by
// bone name and is a tiny fraction of the original size.
//
//   node tools/strip-anim.mjs <in.glb> <out.glb>
import fs from 'node:fs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error('usage: strip-anim.mjs <in.glb> <out.glb>'); process.exit(1); }

const b = fs.readFileSync(inPath);
if (b.toString('ascii', 0, 4) !== 'glTF') { console.error('not a GLB'); process.exit(1); }
const jsonLen = b.readUInt32LE(12);
const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen));
// BIN chunk follows the JSON chunk.
let off = 20 + jsonLen;
const binLen = b.readUInt32LE(off);
const bin = b.subarray(off + 8, off + 8 + binLen);

// 1. Accessors referenced by animation samplers (input = time, output = values).
const usedAcc = new Set();
for (const a of json.animations || []) for (const s of a.samplers) { usedAcc.add(s.input); usedAcc.add(s.output); }

// 2. Remap used accessors -> compact array; collect their bufferViews.
const accMap = new Map();
const newAccessors = [];
const usedBV = new Set();
for (const oldI of [...usedAcc].sort((x, y) => x - y)) {
  const a = json.accessors[oldI];
  accMap.set(oldI, newAccessors.length);
  newAccessors.push(a);
  if (a.bufferView != null) usedBV.add(a.bufferView);
}

// 3. Rebuild BIN from the used bufferViews (4-byte aligned), remap indices.
const bvMap = new Map();
const newBufferViews = [];
const parts = [];
let cursor = 0;
for (const oldI of [...usedBV].sort((x, y) => x - y)) {
  const bv = json.bufferViews[oldI];
  const start = bv.byteOffset || 0;
  const slice = bin.subarray(start, start + bv.byteLength);
  bvMap.set(oldI, newBufferViews.length);
  const nbv = { buffer: 0, byteOffset: cursor, byteLength: bv.byteLength };
  if (bv.byteStride != null) nbv.byteStride = bv.byteStride;
  newBufferViews.push(nbv);
  parts.push(slice);
  cursor += bv.byteLength;
  const pad = (4 - (cursor % 4)) % 4; // keep each bufferView 4-byte aligned
  if (pad) { parts.push(Buffer.alloc(pad)); cursor += pad; }
}
for (const a of newAccessors) if (a.bufferView != null) a.bufferView = bvMap.get(a.bufferView);

// 4. Remap animation samplers to the compact accessor indices.
const newAnims = (json.animations || []).map((a) => ({
  name: a.name,
  channels: a.channels,
  samplers: a.samplers.map((s) => ({ input: accMap.get(s.input), output: accMap.get(s.output), interpolation: s.interpolation })),
}));

// 5. Clean nodes (drop mesh/skin refs) and assemble the slimmed glTF JSON.
const nodes = (json.nodes || []).map((n) => { const c = { ...n }; delete c.mesh; delete c.skin; return c; });
const out = {
  asset: json.asset || { version: '2.0' },
  scene: json.scene || 0,
  scenes: json.scenes || [{ nodes: nodes.map((_, i) => i) }],
  nodes,
  animations: newAnims,
  accessors: newAccessors,
  bufferViews: newBufferViews,
  buffers: [{ byteLength: cursor }],
};

// 6. Re-serialize as a GLB (JSON chunk padded with spaces, BIN with zeros).
const newBin = Buffer.concat(parts);
let jsonBuf = Buffer.from(JSON.stringify(out), 'utf8');
let jpad = (4 - (jsonBuf.length % 4)) % 4;
if (jpad) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' '.repeat(jpad))]);
const total = 12 + 8 + jsonBuf.length + 8 + newBin.length;
const head = Buffer.alloc(12);
head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
const jHead = Buffer.alloc(8); jHead.writeUInt32LE(jsonBuf.length, 0); jHead.write('JSON', 4, 'ascii');
const bHead = Buffer.alloc(8); bHead.writeUInt32LE(newBin.length, 0); bHead.write('BIN\0', 4, 'ascii');
fs.writeFileSync(outPath, Buffer.concat([head, jHead, jsonBuf, bHead, newBin]));
console.log(`${outPath}: ${(total / 1024 / 1024).toFixed(2)}MB  (${newAnims.length} clips, ${nodes.length} nodes, was ${(b.length / 1024 / 1024).toFixed(1)}MB)`);
