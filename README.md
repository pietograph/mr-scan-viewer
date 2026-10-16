# MR Scan Viewer

> **Alpha.** Works on the author's Meta Quest 3 with scans from the iPhone 3D Scanner App; expect rough edges elsewhere.

Browse your collection of 3D scans as miniatures in **Meta Quest 3 mixed reality**, right in the browser. The scans fill your real room as a walk-through grid. Grab one, scale and turn it, put it down anywhere, or step inside it at 1:1.

- **Room-aware**: the grid is fitted to your room from Space Setup, aligned with the walls and kept out of furniture; miniatures stop at real walls and tables.
- **Mixed collections**: textured meshes, untextured meshes and coloured point clouds (OBJ, PLY, zipped OBJ exports).
- **Hands or controllers**: everything works by touch, with no laser pointers.
- **Four detail levels per scan**, chosen by how large it appears to you, from a 3k-triangle miniature up to the untouched original at 1:1.

It's a plain WebXR app (three.js, no build step), a small HTTPS server and a converter that turns your scan folders into compressed glTF.

## Requirements

- Meta Quest 3 (Quest 3S should work too) with **Space Setup** done, on the same Wi-Fi as your computer
- Node.js 20+
- [mkcert](https://github.com/FiloSottile/mkcert) for the local HTTPS certificate (macOS: `brew install mkcert`)
- Your scans in a folder: for example exports from [3D Scanner App](https://3dscannerapp.com/) (iPhone/iPad Pro LiDAR)

## Getting started

```bash
npm install
cp scans.config.example.json scans.config.json   # then set "sourceRoot" to your scans folder
npm run convert                                  # converts every scan (≈30 s per textured scan)
npm run manifest                                 # builds scans/manifest.json
npm run cert                                     # HTTPS certificate for this machine's LAN address
npm start
```

Open the **Network** URL the server prints (e.g. `https://192.168.1.20:3443`) in the Quest browser. Accept the certificate warning once (*Advanced → Proceed*), then tap **Enter Mixed Reality** and allow the room-scan permission.

Your scans and everything converted from them stay local: `scans/`, `scans.config.json` and the certificate are gitignored.

## Your scans

`scans.config.json`:

```json
{
  "sourceRoot": "/absolute/path/to/your/3D scans",
  "scannerAppFolder": "3D Scanner App",
  "folderUp": { "Some exported folder": "+Z" }
}
```

- **`scannerAppFolder`**: a folder of 3D Scanner App scan folders (one per scan, `<timestamp>/` with `textured_output.obj`, `export.obj` or `points.ply`, plus `info.json` and a thumbnail).
- **Every other folder** under `sourceRoot`: each scan subfolder, loose `.ply` / `.obj` file and `.zip` OBJ export becomes one scan. IDs are prefixed with the folder name.
- **`folderUp`**: the up axis for folders whose files don't say it themselves (see *Orientation* below).

```bash
npm run convert -- --batch=id1,id2   # specific scans
npm run convert -- --batch=extra     # everything outside the 3D Scanner App folder
npm run convert -- --force           # re-convert existing ones
npm run convert -- --meta-only       # only refresh metadata (e.g. source file names)
npm run manifest                     # always regenerate the manifest afterwards
```

## Controls

Selection is by **contact**: touch a scan with the controller tip or your pinch point. A small dot shows that point and turns blue on contact. Touching a scan shows an info card with its title, date, type, source file, size and the detail level currently shown.

| Action | Controller | Hand |
|---|---|---|
| Grab, move, turn | Touch + hold trigger, move the controller | Pinch while touching, move your hand |
| Scale | Thumbstick up/down while holding, or grab with both controllers | Pinch with both hands, pull apart / twist |
| Turn (yaw) | Thumbstick left/right while holding | — |
| 1:1 on / off | Double-click trigger, or B / Y | Double-pinch |
| Back to its grid spot | Triple-click trigger | Triple-pinch |
| Sort panel (date / size / detail) | Grip, then touch a button | — |

Released scans stay where you put them. Only one scan is shown at 1:1, with everything else hidden. You're usually standing inside it, so double- or triple-pinching anywhere acts on it. Miniatures resting in the grid spin slowly. Collision with the room only applies to miniatures; at 1:1, scans pass through walls.

## How it works

### Conversion

Each scan becomes up to four detail levels in `scans/converted/<id>/`. A level identical to the one above it is skipped.

| File | Triangles | Points | Texture | Shown when the scan appears… |
|---|---|---|---|---|
| `lod0.glb` | 3k | 5k | 512² | small / far away (loaded at startup) |
| `lod1.glb` | 25k | 40k | 1024² | close, or in your hand |
| `lod2.glb` | 120k | 250k | 2048² | scaled up toward room size |
| `lod3.glb` | full | all | original, ≤ 8192² | at or near 1:1 |

"Appears" means world size ÷ distance (thresholds in `LEVEL_UP`, `public/src/scan-object.js`), with a margin so levels don't flicker. Higher levels load two at a time and are freed 10 s after their last use. Geometry uses meshopt compression and textures KTX2 (ETC1S); the top level keeps the source texture untouched.

Many room scans give every triangle its own UVs, which blocks simplification with the texture intact. Their lower levels get the texture baked into vertex colours instead: slightly blurrier, much lighter.

**Orientation**: the viewer expects Y-up. 3D Scanner App PLY exports store one constant "up" vector as every point's normal, and the converter reads it: `+Y` in the app's own scan folders, `+Z` in exports made with its Z-up setting. Files without that signal (meshes) follow `folderUp`. Anything not +Y is rotated upright; `meta.json` records the original axis as `up`.

### The grid

On entering MR the app waits up to 4 s for the room data. The room outline comes from Space Setup's planes (floor outline, walls, ceiling). The room mesh is used as a fallback only if it plausibly contains walls, since on some rooms it holds just the furniture. Without either, the grid fills a 3 × 3 m area in front of you.

The grid is aligned with the walls: 45 cm from them, layers at 0.8 / 1.25 / 1.7 m, the widest column spacing that fits every scan, skipping spots within 15 cm of furniture. If space runs out it adds a 2.1 m layer, then tightens the spacing down to 25 cm. It never stacks scans out of reach.

### Rendering

Rendering defaults to no MSAA at 1.3× resolution. MSAA edges composite over passthrough with a dark 1 px rim; supersampling doesn't.

## Debugging

A readout below your view shows fps (green ≥ 68, yellow ≥ 50, red below), triangles per frame for both eyes, and per-frame timings: `cpu` (app logic), `draw` (CPU cost of submitting the frame), `gpu` (where the browser supports timer queries) and `worst` (longest frame in the last half second). The budget at 72 Hz is 13.9 ms. The last line shows the room size the grid was fitted to and where it came from.

URL switches, combinable (`?debugRoom&nohud`):

| Switch | Effect |
|---|---|
| `?debugRoom` | show the detected room mesh as a green wireframe |
| `?nomesh` | no room-mesh detection (no collision or furniture avoidance) |
| `?aa` | turn MSAA back on |
| `?scale=1` | render resolution factor (default 1.3) |
| `?nohud` | hide the readout |
| `?empty` | load no scans |

`npm test` runs headless tests for geometry, collision, room fitting, the grid, detail levels and interaction.

## Project structure

```
├── public/              the WebXR app (served as is, no build step)
│   ├── index.html
│   ├── libs/basis/      KTX2 transcoder
│   └── src/
│       ├── main.js         bootstrap, model preload
│       ├── xr-session.js   session, frame loop, grid placement
│       ├── gallery.js      room-filling grid, sorting, 1:1 focus
│       ├── scan-object.js  one scan: detail levels, 1:1 toggle
│       ├── interaction.js  contact selection, grab / scale, multi-select
│       ├── room-mesh.js    collision with the room mesh
│       ├── room-frame.js   room outline from planes / mesh
│       ├── info-label.js   info card
│       ├── sort-panel.js   sort buttons
│       └── hud.js          performance readout
├── server/              HTTPS server + certificate script
├── tools/               converter (convert-scans.js) and manifest builder
├── tests/               headless tests (npm test)
└── scans.config.example.json
```

## Known limitations (alpha)

- Tested only on Meta Quest 3 with the Meta Quest Browser.
- Orientation detection relies on 3D Scanner App's PLY convention; other apps' meshes may need a `folderUp` entry.
- Collision tests only the scan's centre against the room mesh, so corners can poke slightly into walls.
- USDZ, Record3D captures and videos are skipped by the converter.
- With 100+ scans in a small room the grid gets tight.

## License

MIT, see [LICENSE](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
