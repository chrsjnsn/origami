import * as THREE from 'three';
import './styles.css';
import { Sculpture, type CanonicalSculpture } from './core/sculpture';
import { StudioModel } from './core/studio';
import type { Presentation } from './render/presentation';
import { Viewer } from './render/viewer';
import { App } from './ui/app';

async function boot(): Promise<void> {
  const base = import.meta.env.BASE_URL;
  const [data, presentation, grain] = await Promise.all([
    fetch(`${base}assets/sculpture.json`).then((r) => {
      if (!r.ok) throw new Error(`sculpture.json: ${r.status}`);
      return r.json() as Promise<CanonicalSculpture>;
    }),
    fetch(`${base}assets/presentation.json`).then((r) => {
      if (!r.ok) throw new Error(`presentation.json: ${r.status}`);
      return r.json() as Promise<Presentation>;
    }),
    new THREE.TextureLoader().loadAsync(`${base}assets/textures/paper-grain.png`),
  ]);

  const sculpture = new Sculpture(data);
  const model = new StudioModel(sculpture);
  const viewer = new Viewer(document.getElementById('viewer')!, sculpture, presentation, grain);
  viewer.setBoard(model.snap.board);
  const pose = model.getPose();
  viewer.setShells(pose.outer, pose.inner);
  const app = new App(model, viewer);

  const reveal = () => document.getElementById('loading')?.classList.add('done');
  requestAnimationFrame(reveal);
  setTimeout(reveal, 400); // background tabs throttle animation frames

  // Verification and debugging hooks (used by the documented browser checks).
  Object.assign(window, { __origami: { model, viewer, app, sculpture, THREE } });

  if (new URLSearchParams(location.search).has('perf')) {
    const out = document.getElementById('perf-readout')!;
    setInterval(() => {
      const s = viewer.stats;
      out.textContent = `render ${s.renderMs.toFixed(1)} ms · frame ${s.frameMs.toFixed(1)} ms · check ${app.validation ? app.validation.ms.toFixed(1) : '–'} ms`;
    }, 1000);
  }
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) {
    el.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = /webgl/i.test(String(err))
      ? 'This browser could not start 3-D graphics (WebGL 2 is required).'
      : `The sculpture could not be loaded: ${(err as Error).message}`;
    el.append(p);
  }
});
