/**
 * GPU meshes for the thickened outer (black) and inner (blue) shells.
 * Geometry is rebuilt in place from the derived shell vertices whenever the pose changes.
 */

import * as THREE from 'three';
import type { Sculpture } from '../core/sculpture';
import { FLOATS_PER_SHELL, writeThickShell } from '../core/solidify';

export class ShellMesh {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private readonly uv: Float32Array;

  constructor(
    private readonly sculpture: Sculpture,
    private readonly spec: { thickness: number; offset: 1 | -1 },
    material: THREE.Material,
    private readonly grainTileMm: number,
  ) {
    const n = sculpture.count * FLOATS_PER_SHELL;
    this.pos = new Float32Array(n);
    this.nor = new Float32Array(n);
    this.uv = new Float32Array((n / 3) * 2);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  /** Rebuild from shell vertices (Blender vertex order, 12 floats per piece). */
  update(verts: Float64Array): void {
    const { sculpture, spec, pos, nor, uv } = this;
    for (let i = 0; i < sculpture.count; i++) {
      writeThickShell(verts, i * 12, sculpture.faces, i * 9, spec, pos, nor, i * FLOATS_PER_SHELL);
    }
    // Box-projected UVs in board space keep the paper grain steady while tips move.
    const inv = 1 / this.grainTileMm;
    for (let v = 0, u = 0; v < pos.length; v += 3, u += 2) {
      const ax = Math.abs(nor[v]), ay = Math.abs(nor[v + 1]), az = Math.abs(nor[v + 2]);
      if (az >= ax && az >= ay) {
        uv[u] = pos[v] * inv;
        uv[u + 1] = pos[v + 1] * inv;
      } else if (ax >= ay) {
        uv[u] = pos[v + 1] * inv;
        uv[u + 1] = pos[v + 2] * inv;
      } else {
        uv[u] = pos[v] * inv;
        uv[u + 1] = pos[v + 2] * inv;
      }
    }
    const g = this.geometry;
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.uv as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Current GPU-side positions (for export/viewport consistency checks). */
  positions(): Float32Array {
    return this.pos;
  }
}
