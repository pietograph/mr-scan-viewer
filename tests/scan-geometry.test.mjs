import * as THREE from 'three';


const { ScanObject, MINI_SIZE } = await import('../public/src/scan-object.js');
const { Gallery } = await import('../public/src/gallery.js');
const { RoomMesh } = await import('../public/src/room-mesh.js');
const { frameAroundViewer } = await import('../public/src/room-frame.js');

let fails = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) fails++; };

// A 6m-wide model whose geometry sits 20m from its origin (like ARKit coordinates)
const geo = new THREE.BoxGeometry(6, 3, 4).translate(20, 5, -12);
const model = new THREE.Group().add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));

const scene = new THREE.Scene();
const meta = { id: 'a', date: '2024-01-01', bounds: { min: [17, 3.5, -14], max: [23, 6.5, -10] }, lods: [{ level: 0, url: 'x' }] };
const gallery = new Gallery(scene, [meta]);
const scan = gallery.scans[0];
scan._setup(); scan._models.set(0, scan._prepare(model)); scan._show(0); scan.loaded = true;
gallery.placeIn(frameAroundViewer({ position: { x: 0, y: 1.6, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }));
scene.updateMatrixWorld(true);

const wb = new THREE.Box3().setFromObject(scan.pivot);
const c = wb.getCenter(new THREE.Vector3());
const groupPos = scan.group.getWorldPosition(new THREE.Vector3());
check('geometry centred on its group', c.distanceTo(groupPos) < 1e-6, `offset=${c.distanceTo(groupPos).toFixed(4)}m`);
check('miniature fits MINI_SIZE', Math.abs(wb.getSize(new THREE.Vector3()).x - MINI_SIZE) < 1e-6);
check('fallback grid in front of viewer', groupPos.z < -1 && groupPos.y > 0.7 && groupPos.y < 1.8, groupPos.toArray().map(v => v.toFixed(2)).join(','));

check('touch beside miniature is no contact', gallery.nearest(groupPos.clone().add(new THREE.Vector3(0.3, 0, 0)), 0.02) === null);
check('hand touching bounds = near grab', gallery.nearest(groupPos.clone().add(new THREE.Vector3(0, 0, 0.05 + 0.03)), 0.05) === scan);

gallery.detach(scan);
check('detach keeps world position', scan.group.position.distanceTo(groupPos) < 1e-6);
scan.toggleFullScale();
for (let i = 0; i < 100; i++) scan.update(0.016);
scene.updateMatrixWorld(true);
const full = new THREE.Box3().setFromObject(scan.pivot);
check('1:1 restores real size', Math.abs(full.getSize(new THREE.Vector3()).x - 6) < 1e-4, `w=${full.getSize(new THREE.Vector3()).x.toFixed(3)}`);
check('1:1 sits on floor', Math.abs(full.min.y) < 1e-4, `minY=${full.min.y.toFixed(4)}`);
scan.toggleFullScale();
for (let i = 0; i < 100; i++) scan.update(0.016);
check('toggle back restores miniature', Math.abs(scan.group.scale.x - 1) < 1e-6 && scan.group.position.distanceTo(groupPos) < 1e-6);

// Room: a wall plane at z = -1.0 facing the user
const room = new RoomMesh(scene);
const wallGeo = new THREE.PlaneGeometry(10, 10).translate(0, 1, -1.0);
const posArr = wallGeo.attributes.position.array;
const fakeMesh = { meshSpace: {}, lastChangedTime: 1, vertices: new Float32Array(posArr), indices: new Uint32Array(wallGeo.index.array) };
const frame = { detectedMeshes: new Set([fakeMesh]), getPose: () => ({ transform: { matrix: new THREE.Matrix4().toArray() } }) };
room.update(frame, {});
check('room mesh built', room.hasMesh);
const from = new THREE.Vector3(0, 1.45, -0.7);
const stopped = room.clampMove(from, new THREE.Vector3(0, 1.45, -1.5), 0.075);
check('stops at wall minus radius', Math.abs(stopped.z - (-1.0 + 0.075)) < 1e-4, `z=${stopped.z.toFixed(4)}`);
const slid = room.clampMove(from, new THREE.Vector3(0.5, 1.45, -1.5), 0.075);
check('slides along wall', Math.abs(slid.z - (-1.0 + 0.075)) < 1e-4 && slid.x > 0.4, `x=${slid.x.toFixed(3)} z=${slid.z.toFixed(4)}`);
const free = room.clampMove(from, new THREE.Vector3(0.2, 1.6, -0.5), 0.075);
check('free move away from wall', free.distanceTo(new THREE.Vector3(0.2, 1.6, -0.5)) < 1e-6);

// Quest behaviour: lastChangedTime keeps changing, geometry doesn't
for (let i = 2; i < 10; i++) {
  fakeMesh.lastChangedTime = i;
  room._lastCheck = -Infinity; // skip the 3 s check interval
  room.update(frame, {});
}
check('timestamp-only changes do not rebuild', room.rebuilds === 1, `rebuilds=${room.rebuilds}`);

// A genuinely different mesh (wall moved to z = -2) must rebuild
const moved = new THREE.PlaneGeometry(10, 10).translate(0, 1, -2.0);
fakeMesh.vertices = new Float32Array(moved.attributes.position.array);
room._lastCheck = -Infinity;
room.update(frame, {});
check('real geometry change rebuilds', room.rebuilds === 2, `rebuilds=${room.rebuilds}`);
const far = room.clampMove(from, new THREE.Vector3(0, 1.45, -1.5), 0.075);
check('collision uses the new mesh', far.distanceTo(new THREE.Vector3(0, 1.45, -1.5)) < 1e-6);

// Within the check interval nothing is re-read
const before = room.rebuilds;
fakeMesh.vertices = new Float32Array(posArr);
room.update(frame, {});
check('no re-check inside the 3 s interval', room.rebuilds === before);

console.log(fails ? `\n${fails} failing` : '\nall passing');
process.exit(fails ? 1 : 0);
