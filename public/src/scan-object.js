/**
 * ScanObject — one 3D scan as a manipulable miniature.
 *
 * group  — the user-controlled transform (position / rotation / scale)
 * pivot  — scales the model so it fits MINI_SIZE; model inside is centred on the pivot
 *
 * Effective model scale = group.scale × miniScale. Full-scale mode sets group.scale
 * to 1 / miniScale so the scan appears at its real-world size.
 *
 * Detail levels (meta.lods, lowest first): the lowest is always loaded; higher
 * ones are fetched as the scan appears larger and freed when no longer needed.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export const MINI_SIZE = 0.15;     // metres — longest side of a miniature
const POINT_SIZE = 0.023;          // point size in metres at 1:1 (round points cover ~79% of the square)
const MIN_POINT_SIZE = 0.002;
const TOGGLE_DURATION = 0.6;       // seconds

// Apparent size = world diameter / distance. Above LEVEL_UP[i] → level i+1.
// Dropping back needs the size to fall HYSTERESIS below, so levels don't flicker.
export const LEVEL_UP = [0.35, 1.0, 2.5];
const HYSTERESIS = 0.8;
const UNLOAD_AFTER = 10;           // seconds a level may sit unused before it's freed
const MAX_CONCURRENT_LOADS = 2;

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
let _renderer = null;

/** KTX2 needs the renderer to pick a GPU format; call once before loading. */
export function initLoaders(renderer) {
  _renderer = renderer;
  loader.setKTX2Loader(new KTX2Loader().setTranscoderPath('/libs/basis/').detectSupport(renderer));
}

// Shared queue so walking through the grid doesn't fire dozens of downloads at once
let activeLoads = 0;
const pending = [];
function queuedLoad(url) {
  return new Promise((resolve, reject) => {
    pending.push({ url, resolve, reject });
    pumpQueue();
  });
}
function pumpQueue() {
  while (activeLoads < MAX_CONCURRENT_LOADS && pending.length) {
    const job = pending.shift();
    activeLoads++;
    loader.loadAsync(job.url).then(job.resolve, job.reject).finally(() => {
      activeLoads--;
      pumpQueue();
    });
  }
}

/** Turn square GL points into discs. The discard costs little at these point sizes. */
function makeRound(material) {
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'void main() {\n\tvec2 pc = gl_PointCoord - 0.5;\n\tif ( dot( pc, pc ) > 0.25 ) discard;',
    );
  };
  material.customProgramCacheKey = () => 'round-points';
}

function materialsOf(obj) {
  return (Array.isArray(obj.material) ? obj.material : [obj.material]).filter(Boolean);
}

export function texturesOf(root) {
  const textures = new Set();
  root.traverse(obj => {
    for (const mat of materialsOf(obj)) {
      for (const value of Object.values(mat)) if (value?.isTexture) textures.add(value);
    }
  });
  return [...textures];
}

function disposeModel(root) {
  for (const tex of texturesOf(root)) tex.dispose();
  root.traverse(obj => {
    obj.geometry?.dispose();
    for (const mat of materialsOf(obj)) mat.dispose();
  });
}

const _inv = new THREE.Matrix4();
const _ray = new THREE.Ray();
const _p = new THREE.Vector3();
const _w = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class ScanObject {
  constructor(meta) {
    this.meta = meta;
    this.lods = [...(meta.lods ?? [])].sort((a, b) => a.level - b.level);
    this.group = new THREE.Group();
    this.pivot = new THREE.Group();
    this.group.add(this.pivot);

    this.localBox = new THREE.Box3();  // model bounds in group space
    this.miniScale = 1;
    this.naturalHalfHeight = 0;

    this.loaded = false;
    this.failed = false;
    this.fullScale = false;
    this.inGallery = true;
    this.slot = null;                  // target position in the gallery grid

    this.helper = null;
    this.shownLod = -1;                // index into this.lods
    this._points = [];
    this._anim = null;
    this._restore = null;

    this._center = new THREE.Vector3();  // model-space centre shared by all levels
    this._models = new Map();            // lod index → prepared model
    this._loading = new Set();
    this._failedLods = new Set();
    this._lastUsed = new Map();
    this._desiredLevel = 0;
  }

  async load() {
    try {
      if (!this.lods.length) throw new Error('no detail levels in manifest');
      const gltf = await loader.loadAsync(this.lods[0].url);
      this._setup();
      this._models.set(0, this._prepare(gltf.scene));
      this._show(0);
      this.loaded = true;
    } catch (err) {
      this.failed = true;
      this.group.visible = false;
      throw err;
    }
  }

  _setup() {
    const b = this.meta.bounds;
    const box = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
    const size = box.getSize(new THREE.Vector3());
    box.getCenter(this._center);

    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    this.miniScale = MINI_SIZE / maxDim;
    this.pivot.scale.setScalar(this.miniScale);
    this.naturalHalfHeight = size.y / 2;
    this.localBox.setFromCenterAndSize(new THREE.Vector3(), size.multiplyScalar(this.miniScale));

    this.helper = new THREE.Box3Helper(this.localBox, 0xffffff);
    this.helper.material.transparent = true;
    this.helper.material.opacity = 0.5;
    this.helper.visible = false;
    this.group.add(this.helper);
  }

  /** Centre a loaded model on the pivot and swap in unlit / point materials. */
  _prepare(model) {
    // Centre in the model's own (unscaled) units; the pivot does the scaling
    model.position.sub(this._center);
    model.traverse(obj => {
      if (obj.isPoints) {
        obj.material.vertexColors = !!obj.geometry.attributes.color;
        obj.material.sizeAttenuation = true;
        makeRound(obj.material);
        obj.material.needsUpdate = true;
      } else if (obj.isMesh && !Array.isArray(obj.material)) {
        // Scans have baked lighting — render textured ones unlit
        const old = obj.material;
        const hasColors = !!obj.geometry.attributes.color;
        if (old.map || hasColors) {
          obj.material = new THREE.MeshBasicMaterial({ map: old.map, vertexColors: hasColors && !old.map, side: THREE.DoubleSide });
          old.dispose();
        } else {
          old.side = THREE.DoubleSide;
        }
      }
    });
    // Sharper textures on surfaces seen at a glancing angle (floors, walls at 1:1)
    const anisotropy = Math.min(8, _renderer?.capabilities.getMaxAnisotropy() ?? 1);
    for (const tex of texturesOf(model)) tex.anisotropy = anisotropy;
    return model;
  }

  _show(index) {
    const prev = this._models.get(this.shownLod);
    if (prev) this.pivot.remove(prev);
    const model = this._models.get(index);
    this.pivot.add(model);
    this.shownLod = index;
    this._points = [];
    model.traverse(obj => { if (obj.isPoints) this._points.push(obj); });
  }

  _request(index) {
    if (this._models.has(index) || this._loading.has(index) || this._failedLods.has(index)) return;
    this._loading.add(index);
    queuedLoad(this.lods[index].url)
      .then(gltf => {
        const model = this._prepare(gltf.scene);
        // Upload now rather than on the first frame it's visible, which would stall that frame
        for (const tex of texturesOf(model)) _renderer?.initTexture(tex);
        this._models.set(index, model);
        this._lastUsed.set(index, performance.now() / 1000);
      })
      .catch(err => {
        this._failedLods.add(index);
        console.error(`Failed to load ${this.lods[index].url}:`, err);
      })
      .finally(() => this._loading.delete(index));
  }

  /** Detail level the scan should use when it appears `angle` large (diameter / distance). */
  levelFor(angle) {
    let d = this._desiredLevel;
    while (d < LEVEL_UP.length && angle > LEVEL_UP[d]) d++;
    while (d > 0 && angle < LEVEL_UP[d - 1] * HYSTERESIS) d--;
    this._desiredLevel = d;
    return d;
  }

  /** Lowest available lod index whose level is ≥ `level` (else the highest). */
  indexForLevel(level) {
    const i = this.lods.findIndex(l => l.level >= level);
    return i === -1 ? this.lods.length - 1 : i;
  }

  updateDetail(cameraPos) {
    if (!this.loaded) return;
    const now = performance.now() / 1000;

    let target;
    if (!this.group.visible) {
      target = 0; // hidden while another scan is at 1:1 — don't fetch detail
    } else if (this.fullScale) {
      target = this.lods.length - 1;
    } else {
      this.group.getWorldPosition(_w);
      const scale = this.group.getWorldScale(_p).x;
      const angle = (2 * this.radiusAt(scale)) / Math.max(0.05, _w.distanceTo(cameraPos));
      target = this.indexForLevel(this.levelFor(angle));
    }
    this._request(target);
    this._lastUsed.set(target, now);

    // Show the target if ready, otherwise the best loaded level below it
    let show = target;
    while (show > 0 && !this._models.has(show)) show--;
    if (show !== this.shownLod) this._show(show);
    this._lastUsed.set(show, now);

    for (const [index, model] of this._models) {
      if (index === 0 || index === show || index === target) continue;
      if (now - (this._lastUsed.get(index) ?? 0) > UNLOAD_AFTER) {
        disposeModel(model);
        this._models.delete(index);
      }
    }
  }

  // ─── queries ─────────────────────────────────────────────────────────────────

  get collisionEnabled() { return !this.fullScale; }

  /** Collision radius in world units for a given group scale. */
  radiusAt(scale) {
    const half = this.localBox.max;
    return Math.max(half.x, half.y, half.z) * scale;
  }

  clampScale(scale) {
    return THREE.MathUtils.clamp(scale, 0.3, 2 / this.miniScale);
  }

  /** World distance along `ray` to this scan's bounds, or null. */
  raycast(ray) {
    if (!this.loaded) return null;
    this.group.updateWorldMatrix(true, false);
    _inv.copy(this.group.matrixWorld).invert();
    _ray.copy(ray).applyMatrix4(_inv);
    if (!_ray.intersectBox(this.localBox, _p)) return null;
    return _p.applyMatrix4(this.group.matrixWorld).distanceTo(ray.origin);
  }

  /** World distance from `point` to this scan's bounds (0 if inside). */
  distanceTo(point) {
    if (!this.loaded) return Infinity;
    this.group.updateWorldMatrix(true, false);
    _inv.copy(this.group.matrixWorld).invert();
    _p.copy(point).applyMatrix4(_inv);
    return this.localBox.distanceToPoint(_p) * this.group.getWorldScale(_p).x;
  }

  setHighlight(mode) {
    if (!this.helper) return;
    this.helper.visible = mode !== 'none' && !this.fullScale;
    this.helper.material.color.setHex(mode === 'grab' ? 0x66ccff : 0xffffff);
  }

  // ─── 1:1 toggle (group must be parented to the scene) ────────────────────────

  toggleFullScale() {
    const from = {
      pos: this.group.position.clone(),
      quat: this.group.quaternion.clone(),
      scale: this.group.scale.x,
    };

    if (!this.fullScale) {
      this._restore = from;
      const yaw = new THREE.Euler().setFromQuaternion(from.quat, 'YXZ').y;
      this._anim = {
        from, t: 0,
        to: {
          // Upright, real size, bottom resting on the floor (local-floor y = 0)
          pos: new THREE.Vector3(from.pos.x, this.naturalHalfHeight, from.pos.z),
          quat: new THREE.Quaternion().setFromAxisAngle(_up, yaw),
          scale: 1 / this.miniScale,
        },
      };
      this.fullScale = true;
    } else {
      this._anim = { from, t: 0, to: this._restore ?? { ...from, scale: 1 } };
      this.fullScale = false;
    }
    this.setHighlight('none');
  }

  cancelAnimation() { this._anim = null; }

  /** Drop 1:1 state without animating (the gallery takes over the transform). */
  leaveFullScale() {
    this.fullScale = false;
    this._anim = null;
    this._restore = null;
  }

  // ─── per frame ───────────────────────────────────────────────────────────────

  update(dt, cameraPos) {
    const a = this._anim;
    if (a) {
      a.t = Math.min(1, a.t + dt / TOGGLE_DURATION);
      const k = a.t * a.t * (3 - 2 * a.t);
      this.group.position.lerpVectors(a.from.pos, a.to.pos, k);
      this.group.quaternion.slerpQuaternions(a.from.quat, a.to.quat, k);
      // Interpolate scale geometrically — the ratio can be 100×
      this.group.scale.setScalar(a.from.scale * Math.pow(a.to.scale / a.from.scale, k));
      if (a.t >= 1) this._anim = null;
    }

    if (cameraPos) this.updateDetail(cameraPos);

    if (this._points.length) {
      const size = Math.max(MIN_POINT_SIZE, POINT_SIZE * this.miniScale * this.group.scale.x);
      for (const p of this._points) p.material.size = size;
    }
  }
}
