#!/usr/bin/env node
/**
 * Reproducible asset preparation.
 *
 *   npm run prepare-assets                      # uses assets-src/origami1829-final-vision.blend
 *   npm run prepare-assets -- --blend path/to/file.blend
 *   BLENDER=/path/to/blender npm run prepare-assets
 *
 * 1. Records the SHA-256 of the source .blend (it is opened read-only and never saved).
 * 2. Runs tools/blender/export_canonical.py in background Blender to write public/assets/.
 * 3. Copies the Blender rebuild script into public/downloads/ for the in-browser package.
 * 4. Confirms the source file hash is unchanged.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const blendArg = args.indexOf('--blend');
const blend = resolve(blendArg >= 0 ? args[blendArg + 1] : join(root, 'assets-src', 'origami1829-final-vision.blend'));

function findBlender() {
  const candidates = [
    process.env.BLENDER,
    '/Applications/Blender.app/Contents/MacOS/Blender',
    'C:\\Program Files\\Blender Foundation\\Blender 5.0\\blender.exe',
    'blender',
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  throw new Error('Blender not found. Install Blender 4.2+ or set BLENDER=/path/to/blender.');
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

if (!existsSync(blend)) throw new Error(`Source .blend not found: ${blend}`);
const before = sha(blend);
const blender = findBlender();
console.log(`Blender: ${blender}`);
console.log(`Source:  ${blend}\nSHA-256: ${before}`);

const run = spawnSync(
  blender,
  ['-b', '--factory-startup', blend, '--python-exit-code', '1', '-P', join(root, 'tools/blender/export_canonical.py'), '--', '--root', root],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const line = (run.stdout || '').split('\n').find((l) => l.startsWith('EXPORT OK'));
if (run.status !== 0 || !line) {
  process.stderr.write(run.stdout + run.stderr);
  throw new Error('Asset export failed');
}
console.log(line);

mkdirSync(join(root, 'public/downloads'), { recursive: true });
copyFileSync(join(root, 'tools/blender/rebuild_design.py'), join(root, 'public/downloads/rebuild_design.py'));

const after = sha(blend);
if (after !== before) throw new Error('The source .blend changed during export!');
console.log('Source file unchanged. Assets written to public/assets/.');
