/**
 * Room frame — the floor rectangle the gallery fills:
 * { center (on the floor), yaw, width, depth, ceiling, source }.
 *
 * Preferred source is Space Setup's planes (floor outline, walls, ceiling).
 * The room mesh is a fallback only when it plausibly contains the walls —
 * on some rooms it holds just the furniture, which would shrink the grid to
 * a table's footprint.
 */

import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const DEFAULT_CEILING = 2.4;

/**
 * Tightest yaw-aligned rectangle around (xs[i], zs[i]), searching 0–88° in 2° steps.
 * `trim` ignores that fraction of points on each side (robust to stray geometry).
 */
export function fitRectangle(xs, zs, trim = 0) {
  const n = xs.length;
  if (n < 3) return null;
  const u = new Float32Array(n), v = new Float32Array(n);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))))];

  let best = null;
  for (let deg = 0; deg < 90; deg += 2) {
    const a = THREE.MathUtils.degToRad(deg);
    const c = Math.cos(a), s = Math.sin(a);
    for (let i = 0; i < n; i++) {
      u[i] = xs[i] * c - zs[i] * s;
      v[i] = xs[i] * s + zs[i] * c;
    }
    u.sort(); v.sort();
    const u0 = pct(u, trim), u1 = pct(u, 1 - trim), v0 = pct(v, trim), v1 = pct(v, 1 - trim);
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, a, u0, u1, v0, v1 };
  }

  const cu = (best.u0 + best.u1) / 2, cv = (best.v0 + best.v1) / 2;
  const c = Math.cos(best.a), s = Math.sin(best.a);
  return {
    center: new THREE.Vector3(cu * c + cv * s, 0, -cu * s + cv * c),
    yaw: best.a,
    width: best.u1 - best.u0,
    depth: best.v1 - best.v0,
  };
}

const shoelace = pts => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
};

/** Room frame from WebXR plane detection, or null if there are no usable planes yet. */
export function frameFromPlanes(frame, refSpace) {
  const planes = frame.detectedPlanes;
  if (!planes?.size) return null;

  let floor = null, floorArea = 0, ceilingY = null, wallTop = 0;
  const wallPts = [];
  for (const plane of planes) {
    const pose = frame.getPose(plane.planeSpace, refSpace);
    if (!pose) continue;
    _m.fromArray(pose.transform.matrix);
    const pts = plane.polygon.map(p => new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(_m));
    if (!pts.length) continue;
    const meanY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const label = plane.semanticLabel;

    if (label === 'floor' || (!label && plane.orientation === 'horizontal' && meanY < 0.3)) {
      const area = shoelace(pts);
      if (area > floorArea) { floor = pts; floorArea = area; }
    } else if (label === 'ceiling' || (!label && plane.orientation === 'horizontal' && meanY > 1.9)) {
      ceilingY = Math.max(ceilingY ?? 0, meanY);
    } else if (label === 'wall' || (!label && plane.orientation === 'vertical')) {
      wallPts.push(...pts);
      wallTop = Math.max(wallTop, ...pts.map(p => p.y));
    }
  }

  const outline = floor ?? (wallPts.length >= 3 ? wallPts : null);
  if (!outline) return null;
  const rect = fitRectangle(outline.map(p => p.x), outline.map(p => p.z));
  if (!rect) return null;
  return {
    ...rect,
    ceiling: ceilingY ?? (wallTop > 1.8 ? wallTop : DEFAULT_CEILING),
    source: floor ? 'floor plane' : 'wall planes',
  };
}

/**
 * Room frame from the room-mesh vertices, or null if it doesn't look like a
 * room (no walls / ceiling reached, or too small to be one).
 */
export function frameFromMesh(positions) {
  const total = positions.length / 3;
  const step = Math.max(1, Math.floor(total / 20000));
  const xs = [], zs = [], ys = [];
  for (let i = 0; i < total; i += step) {
    xs.push(positions[i * 3]); ys.push(positions[i * 3 + 1]); zs.push(positions[i * 3 + 2]);
  }
  const rect = fitRectangle(xs, zs, 0.02);
  if (!rect) return null;
  ys.sort((a, b) => a - b);
  const ceiling = ys[Math.floor(0.98 * (ys.length - 1))];
  if (ceiling < 1.9 || rect.width < 1.5 || rect.depth < 1.5) return null;
  return { ...rect, ceiling, source: 'room mesh' };
}

/** A 3 × 3 m area starting a step in front of the viewer (`transform`: XRRigidTransform). */
export function frameAroundViewer(transform) {
  const p = transform.position;
  const o = transform.orientation;
  const forward = _v.set(0, 0, -1).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
  forward.y = 0;
  if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
  forward.normalize();
  return {
    center: new THREE.Vector3(p.x, 0, p.z).addScaledVector(forward, 2),
    yaw: Math.atan2(-forward.x, -forward.z),
    width: 3,
    depth: 3,
    ceiling: DEFAULT_CEILING,
    source: 'around you',
  };
}
