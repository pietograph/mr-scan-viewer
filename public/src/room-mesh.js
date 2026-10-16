/**
 * RoomMesh — turns WebXR mesh detection (Quest 3 Space Setup) into a BVH
 * so miniatures stop at, and slide along, real walls and furniture.
 * Without mesh-detection, clampMove() is a no-op.
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { frameFromMesh } from './room-frame.js';

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _ray = new THREE.Ray();
const _delta = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _n = new THREE.Vector3();
const _rest = new THREE.Vector3();

/** Cheap fingerprint of the mesh set: sizes plus a few sampled coordinates. */
function meshSignature(meshes) {
  const parts = [];
  for (const m of meshes) {
    const v = m.vertices;
    const count = v.length / 3;
    const samples = [];
    for (let k = 0; k < 8 && count; k++) {
      const i = Math.floor((k / 8) * count) * 3; // whole vertices, so x, y and z are all covered
      samples.push(`${v[i].toFixed(4)},${v[i + 1].toFixed(4)},${v[i + 2].toFixed(4)}`);
    }
    parts.push(`${v.length}/${m.indices.length}/${samples.join(',')}`);
  }
  return parts.sort().join('|');
}

export class RoomMesh {
  constructor(scene, { debug = false } = {}) {
    this.scene = scene;
    this.debug = debug;
    this.bvh = null;
    this.mesh = null;
    this.rebuilds = 0;
    this._signature = null;
    this._lastCheck = -Infinity;
  }

  get hasMesh() { return this.bvh !== null; }

  update(frame, refSpace) {
    const meshes = frame.detectedMeshes;
    if (!meshes || !meshes.size) return;

    // Quest bumps lastChangedTime on its Space Setup mesh constantly even though
    // the geometry doesn't change, so compare the geometry itself — and only
    // every few seconds once a BVH exists, since reading vertices isn't free.
    const now = performance.now();
    if (this.bvh && now - this._lastCheck < 3000) return;
    this._lastCheck = now;

    const signature = meshSignature(meshes);
    if (signature === this._signature) return;
    if (this._rebuild(frame, refSpace, meshes)) this._signature = signature;
  }

  _rebuild(frame, refSpace, meshes) {
    const positions = [];
    const indices = [];
    let base = 0;

    for (const xrMesh of meshes) {
      const pose = frame.getPose(xrMesh.meshSpace, refSpace);
      if (!pose) return false; // retry next frame
      _m.fromArray(pose.transform.matrix);

      const verts = xrMesh.vertices;
      for (let i = 0; i < verts.length; i += 3) {
        _v.set(verts[i], verts[i + 1], verts[i + 2]).applyMatrix4(_m);
        positions.push(_v.x, _v.y, _v.z);
      }
      for (const idx of xrMesh.indices) indices.push(idx + base);
      base += verts.length / 3;
    }
    if (!indices.length) return false;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    this.bvh = new MeshBVH(geo);
    this.rebuilds++;

    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x00ff88, wireframe: true, transparent: true, opacity: 0.25,
    }));
    this.mesh.visible = this.debug;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    console.log(`[room-mesh] ${meshes.size} meshes, ${indices.length / 3} triangles`);
    return true;
  }

  /** Room frame from the mesh, or null if the mesh doesn't look like a whole room. */
  computeFrame() {
    return this.mesh ? frameFromMesh(this.mesh.geometry.attributes.position.array) : null;
  }

  /** True if `point` is within `clearance` of any room surface (wall, furniture). */
  isNearSurface(point, clearance) {
    if (!this.bvh) return false;
    return this.bvh.closestPointToPoint(point, {}, 0, clearance) !== null;
  }

  /**
   * Move a sphere of `radius` from `from` toward `to` (world space), stopping at
   * room surfaces and sliding along them. Returns the allowed position.
   */
  clampMove(from, to, radius) {
    if (!this.bvh) return to;

    _delta.subVectors(to, from);
    const len = _delta.length();
    if (len < 1e-5) return to;
    _dir.copy(_delta).divideScalar(len);

    const hit = this._hit(from, _dir, len + radius);
    if (!hit) return to;

    // Keep `radius` clearance perpendicular to the surface, not along the ray
    _n.copy(hit.face?.normal ?? _dir.clone().negate());
    if (_n.dot(_dir) > 0) _n.negate();
    const cos = Math.max(0.2, -_n.dot(_dir));
    const allowed = THREE.MathUtils.clamp(hit.distance - radius / cos, 0, len);
    const stop = from.clone().addScaledVector(_dir, allowed);
    if (allowed >= len) return to;

    // Slide: drop the motion component that points into the surface
    _rest.copy(_delta).addScaledVector(_dir, -allowed);
    _rest.addScaledVector(_n, -_rest.dot(_n));
    const restLen = _rest.length();
    if (restLen < 1e-5) return stop;

    _rest.divideScalar(restLen);
    const hit2 = this._hit(stop, _rest, restLen + radius);
    const slide = hit2 ? Math.max(0, hit2.distance - radius) : restLen;
    return stop.addScaledVector(_rest, slide);
  }

  _hit(origin, dir, far) {
    _ray.origin.copy(origin);
    _ray.direction.copy(dir);
    const hit = this.bvh.raycastFirst(_ray, THREE.DoubleSide);
    return hit && hit.distance <= far ? hit : null;
  }
}
