import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const { ScanObject, LEVEL_UP } = await import('../public/src/scan-object.js');
const { Gallery } = await import('../public/src/gallery.js');
const { RoomMesh } = await import('../public/src/room-mesh.js');
const { frameFromPlanes } = await import('../public/src/room-frame.js');

let fails = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) fails++; };

// ─── a 4.2 × 3.1 m room, 2.5 m high, rotated 30°, centred at (1, 0, -2), with a table ───
const W = 4.2, D = 3.1, H = 2.5, YAW = THREE.MathUtils.degToRad(30), CENTER = new THREE.Vector3(1, 0, -2);
const parts = [
  new THREE.PlaneGeometry(W, D, 20, 15).rotateX(-Math.PI / 2),                              // floor
  new THREE.PlaneGeometry(W, H, 20, 12).translate(0, H / 2, -D / 2),                         // walls
  new THREE.PlaneGeometry(W, H, 20, 12).rotateY(Math.PI).translate(0, H / 2, D / 2),
  new THREE.PlaneGeometry(D, H, 15, 12).rotateY(Math.PI / 2).translate(-W / 2, H / 2, 0),
  new THREE.PlaneGeometry(D, H, 15, 12).rotateY(-Math.PI / 2).translate(W / 2, H / 2, 0),
  new THREE.BoxGeometry(1.2, 0.75, 0.8, 4, 4, 4).translate(0.6, 0.375, 0.3),                 // table
];
const room = mergeGeometries(parts.map(g => { g.deleteAttribute('normal'); g.deleteAttribute('uv'); return g; }));
room.rotateY(YAW).translate(CENTER.x, CENTER.y, CENTER.z);
const xrMesh = { meshSpace: {}, lastChangedTime: 1, vertices: new Float32Array(room.attributes.position.array), indices: new Uint32Array(room.index.array) };
const frame = { detectedMeshes: new Set([xrMesh]), getPose: () => ({ transform: { matrix: new THREE.Matrix4().toArray() } }) };

const scene = new THREE.Scene();
const roomMesh = new RoomMesh(scene);
roomMesh.update(frame, {});
const rf = roomMesh.computeFrame();

// Yaw is only defined modulo 90° (width/depth may swap)
const yawErr = Math.abs(((THREE.MathUtils.radToDeg(rf.yaw - YAW) % 90) + 135) % 90 - 45);
const dims = [rf.width, rf.depth].sort((a, b) => a - b);
check('room orientation found', yawErr <= 2, `yaw=${THREE.MathUtils.radToDeg(rf.yaw).toFixed(0)}°`);
check('room size found', Math.abs(dims[0] - D) < 0.2 && Math.abs(dims[1] - W) < 0.2, `${rf.width.toFixed(2)} × ${rf.depth.toFixed(2)} m`);
check('room centre found', rf.center.distanceTo(CENTER) < 0.15, rf.center.toArray().map(v => v.toFixed(2)).join(','));
check('ceiling found', Math.abs(rf.ceiling - H) < 0.15, `${rf.ceiling.toFixed(2)} m`);

// ─── 61 scans placed into that room ───
const manifest = Array.from({ length: 61 }, (_, i) => ({
  id: `s${i}`, date: `2024-01-${String(i + 1).padStart(2, '0')}`,
  bounds: { min: [0, 0, 0], max: [1, 1, 1] }, lods: [{ level: 0, url: 'x' }],
}));
const gallery = new Gallery(scene, manifest);
gallery.placeIn(rf, roomMesh);
scene.updateMatrixWorld(true);

const toRoom = p => p.clone().sub(CENTER).applyAxisAngle(new THREE.Vector3(0, 1, 0), -YAW);
const positions = gallery.scans.map(s => s.slot.clone().applyMatrix4(gallery.anchor.matrixWorld));
const inside = positions.every(p => { const r = toRoom(p); return Math.abs(r.x) < W / 2 - 0.3 && Math.abs(r.z) < D / 2 - 0.3; });
const tableBox = new THREE.Box3(new THREE.Vector3(0, 0, -0.1), new THREE.Vector3(1.2, 0.75, 0.7)).expandByScalar(0.1);
const inTable = positions.filter(p => { const r = toRoom(p); return tableBox.containsPoint(r.clone().add(new THREE.Vector3(0, 0, 0)).setX(r.x)); });
let minDist = Infinity;
for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) minDist = Math.min(minDist, positions[i].distanceTo(positions[j]));
const heights = [...new Set(positions.map(p => p.y.toFixed(2)))].sort();

check('every scan has a cell', gallery.scans.every(s => s.slot), `${gallery.cells.length} cells`);
check('all cells inside the walls (≥0.3 m margin)', inside);
check('no cell inside the table', inTable.length === 0, `${inTable.length} inside`);
check('cells ≥ 0.4 m apart', minDist >= 0.4 - 1e-6, `min=${minDist.toFixed(2)} m`);
check('reachable heights', heights.every(h => h >= 0.7 && h <= 2.2), heights.join(', '));

gallery.setSort('vertices');
check('sorting reuses the same cells', gallery.scans.every(s => gallery.cells.includes(s.slot)));

// ─── detail level selection ───
const lodMeta = { id: 'l', bounds: { min: [0, 0, 0], max: [4, 2, 3] },
  lods: [{ level: 0, url: 'a' }, { level: 1, url: 'b' }, { level: 3, url: 'c' }] };
const lodScan = new ScanObject(lodMeta);
lodScan._setup();
const requested = [];
lodScan._request = i => requested.push(i);
for (const i of [0]) lodScan._models.set(i, new THREE.Group());
lodScan._show(0);
lodScan.loaded = true;
scene.add(lodScan.group);
const cam = d => new THREE.Vector3(0, 0, d);

check('L0 when small/far', lodScan.levelFor(0.2) === 0);
check('up to L1 above threshold', lodScan.levelFor(LEVEL_UP[0] + 0.01) === 1);
check('hysteresis keeps L1 just below threshold', lodScan.levelFor(LEVEL_UP[0] * 0.9) === 1);
check('drops to L0 well below', lodScan.levelFor(LEVEL_UP[0] * 0.7) === 0);
check('missing level 2 maps to the next one up', lodScan.indexForLevel(2) === 2);
check('level 1 maps to index 1', lodScan.indexForLevel(1) === 1);

lodScan.group.scale.setScalar(8);           // 1.2 m wide
lodScan.updateDetail(cam(1.0));             // angle ≈ 1.2 → level 2 → index 2
check('requests higher level when large', requested.includes(2), `requested=${requested}`);
check('keeps showing lowest until it loads', lodScan.shownLod === 0);
lodScan._models.set(2, new THREE.Group());
lodScan.updateDetail(cam(1.0));
check('switches once loaded', lodScan.shownLod === 2);

lodScan.group.scale.setScalar(1);
lodScan._models.set(1, new THREE.Group());
lodScan._lastUsed.set(2, performance.now() / 1000 - 60);
lodScan.updateDetail(cam(5.0));
check('far away → back to L0', lodScan.shownLod === 0);
check('unused higher level freed', !lodScan._models.has(2) && lodScan._models.has(0));


// ─── the reported bug: a room mesh that holds only furniture ───
const furniture = mergeGeometries([
  new THREE.BoxGeometry(1.2, 0.75, 0.8, 4, 4, 4).translate(0.6, 0.375, 0.3),   // table
  new THREE.BoxGeometry(2.0, 0.9, 0.9, 4, 4, 4).translate(-0.8, 0.45, -1.0),  // sofa
].map(g => { g.deleteAttribute('normal'); g.deleteAttribute('uv'); return g; })).rotateY(YAW).translate(CENTER.x, 0, CENTER.z);
const furnScene = new THREE.Scene();
const furnMesh = new RoomMesh(furnScene);
furnMesh.update({ detectedMeshes: new Set([{ meshSpace: {}, lastChangedTime: 1,
  vertices: new Float32Array(furniture.attributes.position.array), indices: new Uint32Array(furniture.index.array) }]),
  getPose: frame.getPose }, {});
check('furniture-only mesh is not taken for the room', furnMesh.computeFrame() === null);

// Space Setup planes: floor outline + ceiling, rotated like the room
const planePose = (pos, rotX = 0) => new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, YAW, 0)), new THREE.Vector3(1, 1, 1));
const rectPoly = (w, d) => [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => ({ x, y: 0, z }));
const planes = new Set([
  { planeSpace: 'floor', polygon: rectPoly(W, D), orientation: 'horizontal', semanticLabel: 'floor' },
  { planeSpace: 'ceiling', polygon: rectPoly(W, D), orientation: 'horizontal', semanticLabel: 'ceiling' },
]);
const poses = { floor: planePose(CENTER.clone()), ceiling: planePose(CENTER.clone().setY(2.6)) };
const pf = frameFromPlanes({ detectedPlanes: planes, getPose: s => ({ transform: { matrix: poses[s].toArray() } }) }, {});
const pfDims = [pf.width, pf.depth].sort((a, b) => a - b);
check('room from floor plane', pf.source === 'floor plane' && Math.abs(pfDims[0] - D) < 0.05 && Math.abs(pfDims[1] - W) < 0.05,
  `${pf.width.toFixed(2)} × ${pf.depth.toFixed(2)} m`);
check('floor plane centre + ceiling', pf.center.distanceTo(CENTER) < 0.05 && Math.abs(pf.ceiling - 2.6) < 0.01, `ceiling ${pf.ceiling.toFixed(2)}`);

const g2 = new Gallery(furnScene, Array.from({ length: 114 }, (_, i) => ({ id: `t${i}`, date: '2024-01-01',
  bounds: { min: [0, 0, 0], max: [1, 1, 1] }, lods: [{ level: 0, url: 'x' }] })));
g2.placeIn(pf, furnMesh);
furnScene.updateMatrixWorld(true);
const p2 = g2.scans.map(s => s.slot.clone().applyMatrix4(g2.anchor.matrixWorld));
const maxY = Math.max(...p2.map(p => p.y));
const inside2 = p2.every(p => { const r = toRoom(p); return Math.abs(r.x) < W / 2 - 0.3 && Math.abs(r.z) < D / 2 - 0.3; });
const nearFurniture = p2.filter(p => furnMesh.isNearSurface(p, 0.1)).length;
const footprint = new Set(p2.map(p => `${p.x.toFixed(2)},${p.z.toFixed(2)}`)).size;
check('114 scans fill the room, nothing above reach', maxY <= 2.15, `max height ${maxY.toFixed(2)} m`);
check('spread over the floor, not a column', footprint >= 25, `${footprint} floor positions`);
check('114 scans stay inside the walls', inside2);
check('none inside the furniture', nearFurniture === 0, `${nearFurniture} near furniture`);

// A tiny room still never stacks out of reach
const tiny = new Gallery(new THREE.Scene(), g2.scans.map(s => s.meta));
tiny.placeIn({ center: new THREE.Vector3(), yaw: 0, width: 1.8, depth: 1.6, ceiling: 2.4 });
check('tiny room: still within reach', Math.max(...tiny.cells.map(c => c.y)) <= 2.15, `max ${Math.max(...tiny.cells.map(c => c.y)).toFixed(2)} m`);

console.log(fails ? `\n${fails} failing` : '\nall passing');
process.exit(fails ? 1 : 0);
