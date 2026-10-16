# Third-party notices

MR Scan Viewer is MIT-licensed (see `LICENSE`). It uses the following third-party software.

## Bundled in this repository

| Files | Project | License |
|---|---|---|
| `public/libs/basis/basis_transcoder.js`, `basis_transcoder.wasm` | [Basis Universal](https://github.com/BinomialLLC/basis_universal) by Binomial LLC, as distributed with three.js r168 | Apache-2.0 |

## Loaded from a CDN by the browser app

| Package | License |
|---|---|
| [three.js](https://github.com/mrdoob/three.js) 0.168.0 | MIT |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) 0.7.8 | MIT |

## npm dependencies (installed, not bundled)

| Package | Used by | License |
|---|---|---|
| [@gltf-transform/core, extensions, functions](https://github.com/donmccurdy/glTF-Transform) | converter | MIT |
| [meshoptimizer](https://github.com/zeux/meshoptimizer) | converter | MIT |
| [ktx2-encoder](https://github.com/gz65555/ktx2-encoder) | converter | MIT |
| [obj2gltf](https://github.com/CesiumGS/obj2gltf) | converter | Apache-2.0 |
| [sharp](https://github.com/lovell/sharp) | converter | Apache-2.0 |
| [express](https://github.com/expressjs/express), [cors](https://github.com/expressjs/cors) | server | MIT |
