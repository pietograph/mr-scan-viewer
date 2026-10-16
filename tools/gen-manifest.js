/**
 * Reads per-scan meta.json files from scans/converted/ and assembles
 * scans/manifest.json — the single file the WebXR app fetches on load.
 *
 * Usage: node tools/gen-manifest.js
 */

import { readdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONVERTED_DIR = join(ROOT, 'scans', 'converted');
const OUT = join(ROOT, 'scans', 'manifest.json');

const entries = [];

for (const id of readdirSync(CONVERTED_DIR)) {
  const metaPath = join(CONVERTED_DIR, id, 'meta.json');
  if (!existsSync(metaPath)) continue;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta.lods?.length) entries.push(meta);
    else console.warn(`  ⚠ ${id}: old format (no detail levels) — reconvert with --force`);
  } catch (err) {
    console.warn(`  ⚠ Could not read ${metaPath}: ${err.message}`);
  }
}

// Default sort: newest first
entries.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

writeFileSync(OUT, JSON.stringify(entries, null, 2));
console.log(`✅ manifest.json — ${entries.length} scans written to ${OUT}`);
const startupBytes = entries.reduce((sum, e) => sum + e.lods[0].bytes, 0);
const startupTris = entries.reduce((sum, e) => sum + (e.lods[0].triangles ?? 0), 0);
const startupPts = entries.reduce((sum, e) => sum + (e.lods[0].points ?? 0), 0);
for (const e of entries) {
  const bb = e.boundingBox;
  const diag = bb ? Math.sqrt(bb.x ** 2 + bb.y ** 2 + bb.z ** 2).toFixed(1) : '?';
  const levels = e.lods.map(l => `L${l.level} ${((l.triangles ?? l.points) / 1000).toFixed(0)}k`).join(' ');
  console.log(`   ${e.date}  ${e.type.padEnd(14)}  ${diag.padStart(5)} m  ${levels.padEnd(32)}  "${e.title}"`);
}
console.log(`\n   Startup (lowest levels): ${(startupBytes / 1e6).toFixed(1)} MB, ${(startupTris / 1000).toFixed(0)}k triangles + ${(startupPts / 1000).toFixed(0)}k points`);
