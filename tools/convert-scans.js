/**
 * Converts 3D scans into up to four detail levels per scan
 * (lod0.glb … lod3.glb, see LEVELS); levels identical to the one above are skipped.
 * Textures → KTX2 (ETC1S), geometry → meshopt compression.
 *
 * Configuration: scans.config.json in the repo root (see scans.config.example.json),
 * or a path in $SCANS_CONFIG.
 *
 * Sources (see discoverExtraScans), all under config.sourceRoot:
 *   <scannerAppFolder>/<timestamp>/ — textured_output.obj > export_refined.obj > export.obj > points.ply
 *   every other folder — scan subfolders, loose .ply/.obj (point clouds or meshes)
 *   and .zip exports; ids are prefixed with the folder name.
 *
 * Usage:
 *   node tools/convert-scans.js                  # everything (same as --batch=all)
 *   node tools/convert-scans.js --batch=id1,id2  # specific scans
 *   node tools/convert-scans.js --batch=extra    # everything outside the 3D Scanner App folder
 *   node tools/convert-scans.js --force          # re-convert existing
 */

import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, writeFileSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, extname, join, relative } from 'path';
import { fileURLToPath } from 'url';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { cloneDocument, dedup, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { ktx2 } from 'ktx2-encoder/gltf-transform';
import { BufferAttribute, BufferGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const obj2gltf = require('obj2gltf');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONFIG_PATH = process.env.SCANS_CONFIG ?? join(ROOT, 'scans.config.json');
if (!existsSync(CONFIG_PATH)) {
  console.error(`No config at ${CONFIG_PATH} — copy scans.config.example.json to scans.config.json and set sourceRoot.`);
  process.exit(1);
}
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const SRC_ROOT = CONFIG.sourceRoot;
const SCANS_SRC = join(SRC_ROOT, CONFIG.scannerAppFolder ?? '3D Scanner App');
const OUT_DIR = join(ROOT, 'scans', 'converted');

// Detail levels, lowest first. The client picks one by how large the scan
// appears. `error` is the simplifier's max deviation as a fraction of the mesh
// extent; `bake` allows the vertex-colour fallback when UV seams block simplification.
// ktx2-encoder caps at ~12 Mpx, so KTX2 levels stop at 2048²; the top level keeps the source texture.
const LEVELS = [
  { level: 0, triangles: 3_000,    points: 5_000,     texture: 512,  error: 0.05, bake: true },
  { level: 1, triangles: 25_000,   points: 40_000,    texture: 1024, error: 0.02, bake: true },
  { level: 2, triangles: 120_000,  points: 250_000,   texture: 2048, error: 0.01, bake: false },
  // Top level: everything, with the source texture untouched (no resize, no KTX2)
  { level: 3, triangles: Infinity, points: Infinity, texture: Infinity },
];


const args = process.argv.slice(2);
const force = args.includes('--force');
const metaOnly = args.includes('--meta-only'); // only refresh meta.json fields derived from the source
const batchArg = args.find(a => a.startsWith('--batch='));
const batchValue = batchArg?.replace('--batch=', '');

mkdirSync(OUT_DIR, { recursive: true });

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

// ─── helpers ─────────────────────────────────────────────────────────────────

function readInfo(srcDir) {
  try { return JSON.parse(readFileSync(join(srcDir, 'info.json'), 'utf8')); } catch { return {}; }
}

function displayTitle(folderName, info) {
  const t = info.title?.trim();
  if (t && t !== 'Untitled Scan') return t;
  const m = folderName.match(/^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : folderName;
}

function parseFolderDate(name) {
  const m = name.match(/^(\d{4})_(\d{2})_(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const fileSize = p => (existsSync(p) ? statSync(p).size : 0);
const mb = n => `${(n / 1e6).toFixed(1)} MB`;

async function decodeImage(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

const KTX2_OPTIONS = {
  imageDecoder: decodeImage,
  isUASTC: false,
  qualityLevel: 160,
  compressionLevel: 2,
  generateMipmap: true,
  isPerceptual: true,
  isSetKTX2SRGBTransferFunc: true,
  isKTX2File: true,
};

/** Vertices, triangles (0 for points) and bounds in the scan's own units. */
function docStats(doc) {
  let vertices = 0, triangles = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      vertices += pos.getCount();
      if (prim.getMode() === 4) triangles += (prim.getIndices()?.getCount() ?? pos.getCount()) / 3;
      const lo = pos.getMin([]), hi = pos.getMax([]);
      for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], lo[i]); max[i] = Math.max(max[i], hi[i]); }
    }
  }
  return { vertices, triangles: Math.round(triangles), min, max };
}

// The Basis encoder prints per-slice logs from WASM; keep the converter output readable
async function quietly(fn) {
  const log = console.log;
  console.log = (...a) => { if (!/^(Slice|Total slices|Mode:|basis_compressor)/.test(String(a[0]))) log(...a); };
  try { return await fn(); } finally { console.log = log; }
}

// Above this the top level is downscaled anyway: an 11k² texture alone would need ~680 MB of GPU memory
const MAX_ORIGINAL_TEXTURE = 8192;

async function textures(doc, size) {
  const list = doc.getRoot().listTextures();
  if (!list.length) return;
  if (!Number.isFinite(size)) {
    // Top level: keep source bytes untouched unless they exceed what the headset can hold
    if (list.some(t => Math.max(...(t.getSize() ?? [0])) > MAX_ORIGINAL_TEXTURE)) {
      await doc.transform(textureCompress({
        encoder: sharp, resize: [MAX_ORIGINAL_TEXTURE, MAX_ORIGINAL_TEXTURE], targetFormat: 'jpeg', quality: 95,
      }));
    }
    return;
  }
  await doc.transform(textureCompress({ encoder: sharp, resize: [size, size], targetFormat: 'jpeg', quality: 92 }));
  await quietly(() => doc.transform(ktx2(KTX2_OPTIONS)));
}

const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * Bake the base-colour texture into COLOR_0 and merge vertices by position.
 * Needed when every triangle has its own UVs (no shared vertices), which
 * leaves the simplifier nothing to collapse.
 */
async function bakeTextureToVertexColors(doc) {
  const buffer = doc.getRoot().listBuffers()[0];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const uv = prim.getAttribute('TEXCOORD_0');
      const material = prim.getMaterial();
      const texture = material?.getBaseColorTexture();
      if (!uv || !texture) continue;

      const { data, info } = await sharp(Buffer.from(texture.getImage()))
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const pos = prim.getAttribute('POSITION');
      const nrm = prim.getAttribute('NORMAL');
      const count = pos.getCount();
      const oldIndices = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: count }, (_, i) => i);

      const remap = new Uint32Array(count);
      const keyToIndex = new Map();
      const positions = [], colorSum = [], normalSum = [], hits = [];
      const p = [], n = [], t = [];

      for (let v = 0; v < count; v++) {
        pos.getElement(v, p);
        const key = `${p[0]},${p[1]},${p[2]}`;
        let idx = keyToIndex.get(key);
        if (idx === undefined) {
          idx = hits.length;
          keyToIndex.set(key, idx);
          positions.push(p[0], p[1], p[2]);
          colorSum.push(0, 0, 0);
          normalSum.push(0, 0, 0);
          hits.push(0);
        }
        remap[v] = idx;

        uv.getElement(v, t);
        const x = Math.min(info.width - 1, Math.max(0, Math.floor(t[0] * info.width)));
        const y = Math.min(info.height - 1, Math.max(0, Math.floor(t[1] * info.height)));
        const o = (y * info.width + x) * 3;
        for (let c = 0; c < 3; c++) colorSum[idx * 3 + c] += srgbToLinear(data[o + c] / 255);
        if (nrm) {
          nrm.getElement(v, n);
          for (let c = 0; c < 3; c++) normalSum[idx * 3 + c] += n[c];
        }
        hits[idx]++;
      }

      const merged = hits.length;
      const colors = new Float32Array(merged * 3);
      const normals = new Float32Array(merged * 3);
      for (let i = 0; i < merged; i++) {
        const len = Math.hypot(normalSum[i * 3], normalSum[i * 3 + 1], normalSum[i * 3 + 2]) || 1;
        for (let c = 0; c < 3; c++) {
          colors[i * 3 + c] = colorSum[i * 3 + c] / hits[i];
          normals[i * 3 + c] = normalSum[i * 3 + c] / len;
        }
      }

      const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
      for (const semantic of prim.listSemantics()) prim.setAttribute(semantic, null);
      prim.setAttribute('POSITION', accessor('VEC3', new Float32Array(positions)));
      if (nrm) prim.setAttribute('NORMAL', accessor('VEC3', normals));
      prim.setAttribute('COLOR_0', accessor('VEC3', colors));
      prim.setIndices(accessor('SCALAR', Uint32Array.from(oldIndices, i => remap[i])));
      material.setBaseColorTexture(null);
    }
  }
  await doc.transform(prune());
}

/** Keep every k-th point so the miniature has at most `max` points. */
function decimatePoints(doc, max) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const count = prim.getAttribute('POSITION').getCount();
      if (count <= max) continue;
      const step = count / max;
      for (const semantic of prim.listSemantics()) {
        const acc = prim.getAttribute(semantic);
        const size = acc.getElementSize();
        const src = acc.getArray();
        const dst = new src.constructor(max * size);
        for (let i = 0; i < max; i++) {
          const j = Math.floor(i * step);
          for (let c = 0; c < size; c++) dst[i * size + c] = src[j * size + c];
        }
        acc.setArray(dst);
      }
    }
  }
}

// ─── source → glTF Document ──────────────────────────────────────────────────

/** Indexed geometry becomes a vertex-coloured triangle mesh, the rest a point cloud. */
function geometryToDocument(geometry) {
  const isMesh = !!geometry.index;
  if (isMesh && !geometry.attributes.normal) geometry.computeVertexNormals();

  const doc = new Document();
  const buffer = doc.createBuffer();
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const prim = doc.createPrimitive().setMode(isMesh ? 4 : 0); // TRIANGLES : POINTS
  prim.setAttribute('POSITION', accessor('VEC3', new Float32Array(geometry.attributes.position.array)));
  if (geometry.attributes.color) prim.setAttribute('COLOR_0', accessor('VEC3', new Float32Array(geometry.attributes.color.array)));
  if (isMesh) {
    prim.setAttribute('NORMAL', accessor('VEC3', new Float32Array(geometry.attributes.normal.array)));
    prim.setIndices(accessor('SCALAR', new Uint32Array(geometry.index.array)));
  }
  const name = isMesh ? 'mesh' : 'pointcloud';
  prim.setMaterial(doc.createMaterial(name));
  const node = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim));
  doc.getRoot().setDefaultScene(doc.createScene('scene').addChild(node));
  return { doc, type: isMesh ? 'mesh' : 'pointcloud' };
}

function plyToDocument(plyPath) {
  const buf = readFileSync(plyPath);
  const geometry = new PLYLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { ...geometryToDocument(geometry), up: constantNormalAxis(geometry.attributes.normal) };
}

// ─── orientation ─────────────────────────────────────────────────────────────

const AXES = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };

// 3D Scanner App PLY exports store one constant "up" vector as every point's normal:
// +Y in the app's own scan folders, +Z in exports made with its Z-up setting.
// Files without that signal (meshes) take their folder's export convention from the config.
const FOLDER_UP = Object.fromEntries(Object.entries(CONFIG.folderUp ?? {}).map(([k, v]) => [k.normalize('NFC'), v]));

/** Axis that ≥95 % of the normals point along (within ~20°), or null for real surface normals. */
function constantNormalAxis(normal) {
  if (!normal) return null;
  const n = normal.array;
  const count = n.length / 3;
  const step = Math.max(1, Math.floor(count / 50000));
  for (const [name, a] of Object.entries(AXES)) {
    let hits = 0, seen = 0;
    for (let i = 0; i < count; i += step, seen++) {
      if (n[i * 3] * a[0] + n[i * 3 + 1] * a[1] + n[i * 3 + 2] * a[2] > 0.94) hits++;
    }
    if (hits / seen >= 0.95) return name;
  }
  return null;
}

/**
 * Rotate positions and normals in place so `up` becomes +Y. (gltf-transform's
 * transformMesh adds an index buffer to point clouds, which defeats decimation.)
 */
function makeUpright(doc, up) {
  const q = new Quaternion().setFromUnitVectors(new Vector3(...AXES[up]), new Vector3(0, 1, 0));
  const m = new Matrix4().makeRotationFromQuaternion(q);
  const v = new Vector3();
  const done = new Set();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const semantic of ['POSITION', 'NORMAL']) {
        const acc = prim.getAttribute(semantic);
        if (!acc || done.has(acc)) continue;
        done.add(acc);
        const a = acc.getArray();
        for (let i = 0; i < a.length; i += 3) {
          v.set(a[i], a[i + 1], a[i + 2]).applyMatrix4(m);
          a[i] = v.x; a[i + 1] = v.y; a[i + 2] = v.z;
        }
        acc.setArray(a);
      }
    }
  }
}

/** OBJ with per-vertex colours (`v x y z r g b`), which obj2gltf would drop. */
function vertexColorObjToDocument(objPath) {
  const positions = [], colors = [], indices = [];
  const resolve = t => { const i = parseInt(t, 10); return i < 0 ? positions.length / 3 + i : i - 1; };
  for (const line of readFileSync(objPath, 'utf8').split('\n')) {
    if (line.startsWith('v ')) {
      const n = line.slice(2).trim().split(/\s+/).map(Number);
      positions.push(n[0], n[1], n[2]);
      const c = n.length >= 6 ? n.slice(3, 6) : [1, 1, 1];
      for (const v of c) colors.push(srgbToLinear(v));
    } else if (line.startsWith('f ')) {
      const f = line.slice(2).trim().split(/\s+/).map(t => resolve(t.split('/')[0]));
      for (let i = 1; i < f.length - 1; i++) indices.push(f[0], f[i], f[i + 1]);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  return geometryToDocument(geometry);
}

// ─── source discovery ────────────────────────────────────────────────────────

const OBJ_PRIORITY = ['textured_output.obj', 'export_refined.obj', 'export.obj'];

/** 3D Scanner App folder → source description (unchanged naming and priority). */
function scannerAppSource(folderName) {
  const srcDir = join(SCANS_SRC, folderName);
  if (!existsSync(srcDir)) return null;
  const info = readInfo(srcDir);
  const plySrc = join(srcDir, 'points.ply');
  return {
    id: folderName,
    title: displayTitle(folderName, info),
    date: parseFolderDate(folderName),
    obj: OBJ_PRIORITY.map(f => join(srcDir, f)).find(existsSync),
    ply: existsSync(plySrc) ? plySrc : null,
    thumb: join(srcDir, 'thumb_00000.jpg'),
    info,
  };
}

function readHead(path, bytes = 4096) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString('latin1');
  } finally { closeSync(fd); }
}

/** Vertex and face counts from a PLY header, or null if it isn't one. */
function plyHeader(path) {
  const head = readHead(path);
  if (!head.startsWith('ply') || !head.includes('end_header')) return null;
  const count = name => Number(head.match(new RegExp(`element\\s+${name}\\s+(\\d+)`))?.[1] ?? 0);
  return { vertices: count('vertex'), faces: count('face') };
}

const hasVertexColors = objPath => /^v(\s+-?[\d.eE+-]+){6}\s*$/m.test(readHead(objPath, 65536));

const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mtimeDate = p => isoDate(statSync(p).mtime);

/** Title and date for a loose file or folder named `stem` inside `folder`. */
function looseNaming(folder, stem, geometryPath) {
  const unix = stem.match(/^(\d{10})(\.\d+)?$/);
  if (unix) {
    const d = new Date(Number(stem) * 1000);
    return { title: `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`, date: isoDate(d) };
  }
  const time = stem.match(/^Untitled_Scan_(\d\d)_(\d\d)_(\d\d)$/);
  const label = time ? `${time[1]}:${time[2]}:${time[3]}` : stem;
  return { title: `${folder} ${label}`, date: mtimeDate(geometryPath) };
}

const skipped = [];
function skip(where, reason) {
  skipped.push(where);
  console.log(`·  ${where}  skipped: ${reason}`);
}

/**
 * Every folder under SRC_ROOT except 3D Scanner App. One scan per subfolder
 * with an OBJ/points.ply, per .zip holding an OBJ, and per loose file stem
 * (PLY preferred over an OBJ of the same name — it keeps the vertex colours).
 */
function discoverExtraScans() {
  const sources = [];
  for (const folder of readdirSync(SRC_ROOT).sort()) {
    const folderPath = join(SRC_ROOT, folder);
    if (folder.startsWith('.') || folder === basename(SCANS_SRC) || !statSync(folderPath).isDirectory()) continue;
    const prefix = slug(folder).toLowerCase();
    const stems = new Map();

    for (const entry of readdirSync(folderPath).filter(e => !e.startsWith('.')).sort()) {
      const path = join(folderPath, entry);
      const where = `${folder}/${entry}`;
      try {
        if (statSync(path).isDirectory()) {
          const obj = OBJ_PRIORITY.map(f => join(path, f)).find(existsSync);
          const ply = join(path, 'points.ply');
          if (!obj && !existsSync(ply)) { skip(where, `no OBJ or points.ply (${readdirSync(path).join(', ') || 'empty'})`); continue; }
          sources.push({ id: `${prefix}_${slug(entry)}`, ...looseNaming(folder, entry, obj ?? ply), obj, ply: obj ? null : ply });
          continue;
        }
        const ext = extname(entry).toLowerCase();
        const stem = entry.slice(0, -ext.length);
        if (ext === '.zip') {
          const obj = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).split('\n')
            .filter(e => e.toLowerCase().endsWith('.obj') && !e.startsWith('__MACOSX'))
            .sort((a, b) => OBJ_PRIORITY.indexOf(basename(b)) - OBJ_PRIORITY.indexOf(basename(a)))[0];
          if (!obj) { skip(where, 'zip without OBJ'); continue; }
          sources.push({ id: `${prefix}_${slug(stem)}`, ...looseNaming(folder, stem, path), zip: path, zipObj: obj });
        } else if (ext === '.ply') {
          const header = plyHeader(path);
          if (!header) { skip(where, 'not a PLY file'); continue; }
          if (!header.vertices) { skip(where, `empty PLY stub (${fileSize(path)} bytes, 0 vertices)`); continue; }
          (stems.get(stem) ?? stems.set(stem, {}).get(stem)).ply = path;
        } else if (ext === '.obj') {
          (stems.get(stem) ?? stems.set(stem, {}).get(stem)).obj = path;
        } else {
          skip(where, `unsupported format (${ext || 'no extension'})`);
        }
      } catch (err) {
        skip(where, err.message);
      }
    }

    for (const [stem, { ply, obj }] of stems) {
      if (ply && obj) skip(`${folder}/${basename(obj)}`, 'PLY of the same scan used instead');
      sources.push({ id: `${prefix}_${slug(stem)}`, ...looseNaming(folder, stem, ply ?? obj), ply: ply ?? null, obj: ply ? null : obj });
    }
  }
  return sources;
}

// ─── per scan ────────────────────────────────────────────────────────────────

/** Source file relative to SRC_ROOT, shown in the headset's info label. */
const sourceLabel = src => (src.zip
  ? `${relative(SRC_ROOT, src.zip)} › ${src.zipObj}`
  : relative(SRC_ROOT, src.obj ?? src.ply ?? ''));

const countOf = (s, type) => (type === 'pointcloud' ? s.vertices : s.triangles);

async function simplifyTo(doc, spec) {
  const ratio = spec.triangles / docStats(doc).triangles;
  if (ratio < 1) await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error: spec.error }), prune());
}

/** Geometry for every level, highest first; textures are handled afterwards. */
async function buildLevelGeometry(full, type) {
  const docs = new Map([[3, full]]);
  const baked = new Set();

  if (type === 'pointcloud') {
    for (const spec of LEVELS) {
      const d = spec.level === 3 ? full : cloneDocument(full);
      decimatePoints(d, spec.points);
      docs.set(spec.level, d);
    }
    return { docs, baked };
  }

  let prev = full;
  let uvBlocked = false;
  let bakedFull = null;
  for (const spec of [...LEVELS].reverse().slice(1)) {
    let d;
    if (docStats(prev).triangles <= spec.triangles) {
      d = cloneDocument(prev);
      if (baked.has(prev)) baked.add(d);
    } else {
      if (!uvBlocked) {
        d = cloneDocument(prev);
        await simplifyTo(d, spec);
        uvBlocked = type === 'textured-mesh' && docStats(d).triangles > spec.triangles * 1.5;
        if (uvBlocked) console.log('  · UV seams block simplification — baking texture into vertex colours for low levels');
      }
      if (uvBlocked) {
        // Keep the textured mesh only if it's within 2× the level's budget; otherwise
        // trade texture sharpness for a vertex-coloured mesh that's actually light
        const keepTextured = !spec.bake && docStats(prev).triangles <= spec.triangles * 2;
        if (keepTextured) {
          d = cloneDocument(prev);
        } else {
          if (!bakedFull) { bakedFull = cloneDocument(full); await bakeTextureToVertexColors(bakedFull); }
          d = cloneDocument(baked.has(prev) ? prev : bakedFull);
          await simplifyTo(d, spec);
          baked.add(d);
        }
      }
    }
    docs.set(spec.level, d);
    prev = d;
  }
  return { docs, baked };
}

async function convertScan(src) {
  const folderName = src.id;
  const outDir = join(OUT_DIR, folderName);
  const metaPath = join(outDir, 'meta.json');

  if (!force && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta.lods) {
      console.log(`  ↩  ${folderName} already done (--force to redo)`);
      return meta;
    }
  }

  const info = src.info ?? {};
  const title = src.title;

  // Zipped exports are unpacked to a temp folder — obj2gltf needs the MTL and texture beside the OBJ
  let unzipDir = null;
  let objSrc = src.obj;
  if (src.zip) {
    unzipDir = mkdtempSync(join(tmpdir(), 'convert-scans-'));
    execFileSync('unzip', ['-q', '-o', src.zip, '-d', unzipDir]);
    objSrc = join(unzipDir, src.zipObj);
  }
  const plySrc = src.ply;

  let type, full, detectedUp = null;
  try {
    if (objSrc && hasVertexColors(objSrc)) {
      console.log(`\n▶  ${folderName}  "${title}"  vertex-coloured OBJ ${mb(fileSize(objSrc))}`);
      ({ doc: full, type } = vertexColorObjToDocument(objSrc));
    } else if (objSrc) {
      type = basename(objSrc) === 'textured_output.obj' ? 'textured-mesh' : 'mesh';
      console.log(`\n▶  ${folderName}  "${title}"  ${type} OBJ ${mb(fileSize(objSrc))}`);
      full = await io.readBinary(new Uint8Array(await obj2gltf(objSrc, { binary: true })));
    } else if (plySrc) {
      const header = plyHeader(plySrc);
      const kind = header?.faces ? `mesh (${header.faces.toLocaleString()} faces)` : 'point cloud';
      console.log(`\n▶  ${folderName}  "${title}"  ${kind} PLY ${mb(fileSize(plySrc))}`);
      ({ doc: full, type, up: detectedUp } = plyToDocument(plySrc));
    } else {
      console.log(`\n·  ${folderName}  no usable geometry, skipped`);
      return null;
    }
  } finally {
    if (unzipDir) rmSync(unzipDir, { recursive: true, force: true });
  }
  if (!docStats(full).vertices) {
    console.log(`·  ${folderName}  no vertices, skipped`);
    return null;
  }
  mkdirSync(outDir, { recursive: true });

  // macOS stores 'ü' decomposed; normalise so the folder name matches FOLDER_UP's keys
  const up = detectedUp ?? FOLDER_UP[sourceLabel(src).split('/')[0].normalize('NFC')] ?? '+Y';
  if (up !== '+Y') {
    console.log(`  · ${up} is up${detectedUp ? ' (from the stored normals)' : ' (folder convention)'} — rotating upright`);
    makeUpright(full, up);
  }

  // obj2gltf emits one vertex per face corner — merge shared corners first
  await full.transform(dedup(), weld(), prune());
  const stats = docStats(full);
  const srcTexture = full.getRoot().listTextures()[0]?.getSize() ?? null;
  const { docs, baked } = await buildLevelGeometry(full, type);

  // Drop levels identical to the next one up; the survivor takes the lower level number
  const lods = [];
  for (const spec of [...LEVELS].reverse()) {
    const doc = docs.get(spec.level);
    const isBaked = baked.has(doc);
    const tex = srcTexture && !isBaked ? Math.min(spec.texture, MAX_ORIGINAL_TEXTURE, Math.max(...srcTexture)) : null;
    const count = countOf(docStats(doc), type);
    // Original and KTX2-encoded textures of the same size are not interchangeable
    const signature = `${count}/${tex}/${Number.isFinite(spec.texture)}/${isBaked}`;
    const above = lods[0];
    if (above?.signature === signature) {
      above.level = spec.level;
      above.spec = spec;
      continue;
    }
    lods.unshift({ level: spec.level, spec, doc, signature, count, texture: tex });
  }

  for (const f of ['model.glb', 'mini.glb', 'full.glb', 'lod0.glb', 'lod1.glb', 'lod2.glb', 'lod3.glb']) {
    rmSync(join(outDir, f), { force: true });
  }

  const label = type === 'pointcloud' ? 'pts' : 'tris';
  for (const lod of lods) {
    await textures(lod.doc, lod.spec.texture);
    await lod.doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const file = `lod${lod.level}.glb`;
    await io.write(join(outDir, file), lod.doc);
    lod.url = `scans/converted/${folderName}/${file}`;
    lod.bytes = fileSize(join(outDir, file));
    console.log(`  ✓ L${lod.level}  ${lod.count.toLocaleString().padStart(9)} ${label}  ${lod.texture ? `${lod.texture}²` : '  -  '}  ${mb(lod.bytes)}`);
  }

  const thumbSrc = src.thumb;
  const thumbDst = join(outDir, 'thumb.jpg');
  if (thumbSrc && existsSync(thumbSrc)) await sharp(thumbSrc).resize(256, 256, { fit: 'inside' }).jpeg({ quality: 80 }).toFile(thumbDst);

  const meta = {
    id: folderName,
    title,
    date: src.date,
    type,
    source: sourceLabel(src),
    up,
    lods: lods.map(l => ({
      level: l.level,
      url: l.url,
      [type === 'pointcloud' ? 'points' : 'triangles']: l.count,
      texture: l.texture,
      bytes: l.bytes,
    })),
    thumb: existsSync(thumbDst) ? `scans/converted/${folderName}/thumb.jpg` : null,
    vertexCount: stats.vertices,
    triangleCount: stats.triangles,
    bounds: { min: stats.min, max: stats.max },
    boundingBox: {
      x: stats.max[0] - stats.min[0],
      y: stats.max[1] - stats.min[1],
      z: stats.max[2] - stats.min[2],
    },
    gps: info.gpsLatitude
      ? { lat: info.gpsLatitude, lng: info.gpsLongitude, alt: info.gpsAltitude }
      : null,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return meta;
}

// ─── run ─────────────────────────────────────────────────────────────────────

const scannerAppIds = () => (existsSync(SCANS_SRC) ? readdirSync(SCANS_SRC).filter(d => !d.startsWith('.')).sort() : []);
const extra = batchValue && /^\d{4}(_\d\d){5}(,\d{4}(_\d\d){5})*$/.test(batchValue) ? [] : discoverExtraScans();
const extraById = new Map(extra.map(s => [s.id, s]));
const batch = !batchValue || batchValue === 'all' ? [...scannerAppIds(), ...extraById.keys()]
  : batchValue === 'extra' ? [...extraById.keys()]
  : batchValue.split(',');

console.log(`\nConverting ${batch.length} scans → ${OUT_DIR}\n`);
let ok = 0;
for (const id of batch) {
  try {
    const src = extraById.get(id) ?? scannerAppSource(id);
    if (!src) { console.error(`  ✗ Source not found: ${id}`); continue; }
    if (metaOnly) {
      const metaPath = join(OUT_DIR, id, 'meta.json');
      if (!existsSync(metaPath)) continue;
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      meta.source = sourceLabel(src);
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      ok++;
      continue;
    }
    if (await convertScan(src)) ok++;
  } catch (err) {
    console.error(`  ✗ ${id}: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
  }
}
console.log(`\n✅ ${ok}/${batch.length} scans converted${skipped.length ? `, ${skipped.length} source files skipped` : ''}.\n`);
