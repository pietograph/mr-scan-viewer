import * as THREE from 'three';

// Minimal canvas stub so InfoLabel / SortPanel can draw in Node
const ctx = new Proxy({}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}), set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
let T = 1000;
globalThis.performance.now = () => T;

const { Gallery } = await import('../public/src/gallery.js');
const { Interaction } = await import('../public/src/interaction.js');
const { SortPanel } = await import('../public/src/sort-panel.js');

let fails = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) fails++; };

const scene = new THREE.Scene();
const manifest = ['a', 'b', 'c'].map((id, i) => ({
  id, date: `2024-01-0${i + 1}`, type: 'pointcloud',
  bounds: { min: [0, 0, 0], max: [2, 1, 1] }, lods: [{ level: 0, url: 'x' }],
}));
const gallery = new Gallery(scene, manifest);
for (const s of gallery.scans) {
  s._setup();
  const pts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)), new THREE.PointsMaterial());
  s._models.set(0, s._prepare(new THREE.Group().add(pts)));
  s._show(0);
  s.loaded = true;
}
gallery.placeIn({ center: new THREE.Vector3(0, 0, -2), yaw: 0, width: 3, depth: 3, ceiling: 2.4 });
scene.updateMatrixWorld(true);

const session = { inputSources: [], addEventListener() {}, removeEventListener() {} };
const renderer = { xr: { getSession: () => session, getReferenceSpace: () => ({}) } };
const sortPanel = new SortPanel(scene, gallery);
const ix = new Interaction(renderer, scene, gallery, { clampMove: (a, b) => b }, sortPanel);

const source = { handedness: 'right' };
const st = ix._state(source);
const touch = scan => {
  const p = scan.group.getWorldPosition(new THREE.Vector3());
  st.point.copy(p);
  st.grip.makeTranslation(p.x, p.y, p.z);
  st.hasPose = true;
};
const select = () => { st.hasPose = true; ix._onSelectStart({ inputSource: source }); ix._onSelectEnd({ inputSource: source }); };
const tick = ms => { T += ms; ix.update({}, ms / 1000, new THREE.Vector3(0, 1.6, 0)); };
const [a, b, c] = gallery.scans;
const home = scan => scan.slot.clone().applyMatrix4(gallery.anchor.matrixWorld);

// Contact only
st.point.copy(a.group.getWorldPosition(new THREE.Vector3())).add(new THREE.Vector3(0, 0, 0.3));
st.hasPose = true;
ix._onSelectStart({ inputSource: source });
check('no grab without contact', st.grabbed === null);
ix._onSelectEnd({ inputSource: source });

// Single select grabs (and detaches from the grid)
touch(a);
ix._onSelectStart({ inputSource: source });
check('single select grabs on contact', st.grabbed === a && !a.inGallery);
ix._onSelectEnd({ inputSource: source });
T += 1000;

// Double select → 1:1, but only after the triple window has passed
touch(b);
select(); T += 150; select();
tick(100);
check('double select waits for a possible third', !b.fullScale);
tick(400);
check('double select toggles 1:1', b.fullScale && gallery.focus === b);
check('everything else hidden in 1:1', !a.group.visible && !c.group.visible && b.group.visible);
check('hidden scans are not touchable', gallery.nearest(a.group.getWorldPosition(new THREE.Vector3()), 0.05) === null);

// Another scan to 1:1 → the first leaves 1:1 (only one at a time)
T += 1000;
ix._toggleFullScale(c);
check('only one scan at 1:1', c.fullScale && !b.fullScale && gallery.focus === c);

// Triple select on the 1:1 scan (you're inside it) → straight back to its grid cell
T += 1000;
for (let i = 0; i < 100; i++) c.update(0.016);  // let the 1:1 animation finish
scene.updateMatrixWorld(true);
st.point.copy(c.group.getWorldPosition(new THREE.Vector3())).add(new THREE.Vector3(0.2, 0, 0.2));
st.grip.makeTranslation(st.point.x, st.point.y, st.point.z);
st.hasPose = true;
check('1:1 scan touchable from inside', ix._contact(st) === c);
select(); T += 120; select(); T += 120; select();
tick(500);
check('triple select leaves 1:1 without toggling', !c.fullScale && gallery.focus === null);
check('all scans visible again', gallery.scans.every(s => s.group.visible));
for (let i = 0; i < 200; i++) gallery.update(0.016);
scene.updateMatrixWorld(true);
check('triple select returns to the grid cell', c.inGallery && c.group.getWorldPosition(new THREE.Vector3()).distanceTo(home(c)) < 0.005,
  `Δ=${(c.group.getWorldPosition(new THREE.Vector3()).distanceTo(home(c)) * 1000).toFixed(1)}mm`);
check('back to miniature size', Math.abs(c.group.scale.x - 1) < 0.01, `scale=${c.group.scale.x.toFixed(3)}`);

// Triple select on a placed (not 1:1) scan returns it too; others keep their cells
T += 1000;
touch(a);
const bHomeBefore = b.slot.clone();
select(); T += 120; select(); T += 120; select();
for (let i = 0; i < 200; i++) gallery.update(0.016);
scene.updateMatrixWorld(true);
check('placed scan returns home', a.inGallery && a.group.getWorldPosition(new THREE.Vector3()).distanceTo(home(a)) < 0.005);
check('other scans keep their home cell', b.slot.equals(bHomeBefore));

// Spinning in the grid
const q0 = a.group.quaternion.clone();
for (let i = 0; i < 30; i++) gallery.update(0.016);
check('grid scans spin slowly', a.group.quaternion.angleTo(q0) > 0.05 && a.group.quaternion.angleTo(q0) < 0.3,
  `${THREE.MathUtils.radToDeg(a.group.quaternion.angleTo(q0)).toFixed(1)}° in 0.5 s`);

// Round points
const pm = a._models.get(0).children[0].material;
const shader = { fragmentShader: 'uniform vec3 diffuse;\nvoid main() {\n\tvec4 diffuseColor = vec4( diffuse, opacity );\n}' };
pm.onBeforeCompile(shader);
check('points shader discards outside a disc', shader.fragmentShader.includes('discard') && pm.customProgramCacheKey() === 'round-points');

// Sort panel by touch
sortPanel.show(new THREE.Vector3(0, 1.4, -0.5), new THREE.Vector3(0, 1.4, 0));
const at = x => sortPanel.mesh.localToWorld(new THREE.Vector3(x, 0, 0.005));
check('touching middle button selects size', sortPanel.touch(at(0)) === 'size');
check('touching right button selects vertices', sortPanel.touch(at(0.4 / 3)) === 'vertices');
check('touching 5 cm in front is no press', sortPanel.touch(sortPanel.mesh.localToWorld(new THREE.Vector3(0, 0, 0.05))) === null);

console.log(fails ? `\n${fails} failing` : '\nall passing');
process.exit(fails ? 1 : 0);
