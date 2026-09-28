/**
 * Customization overlays drawn on the board plane (z = 0) on top of the sculpture:
 * wave guides, source handles, the brush footprint, issue markers and board guides.
 * All positions are board coordinates, so directions stay correct when the camera rotates.
 */

import * as THREE from 'three';
import type { BoardSettings, BorderReport, Envelope } from '../core/board';
import type { BrushKind, SmoothAxis } from '../core/brushes';
import type { Sculpture } from '../core/sculpture';
import type { Severity } from '../core/validation';
import { sourcePhase, type WaveSource } from '../core/waves';
import type { Viewer } from './viewer';

const MAX_SOURCES = 8;
const HANDLE_PX = 34;
const DIR_HANDLE_PX = 22;
export const DIRECTION_ARM_MM = 170;

export interface BrushCursor {
  x: number;
  y: number;
  radius: number;
  kind: BrushKind;
  sign: 1 | -1;
  axis: SmoothAxis;
  active: boolean;
}

export interface HandleHit {
  id: string;
  part: 'center' | 'direction';
}

export class Overlays {
  readonly root = new THREE.Group();
  private readonly waveMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly brushMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly glyph: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly glyphCache = new Map<string, THREE.CanvasTexture>();
  private readonly handles = new Map<string, { center: THREE.Sprite; dir: THREE.Sprite; arm: THREE.Line; key: string }>();
  private readonly handleTextures = new Map<string, THREE.CanvasTexture>();
  private readonly flags: THREE.Points;
  private readonly flagLines: THREE.LineSegments;
  private readonly boardLines: THREE.Group;
  private sources: WaveSource[] = [];
  guidesVisible = true;
  handlesVisible = true;

  constructor(private readonly viewer: Viewer, private readonly sculpture: Sculpture) {
    this.root.renderOrder = 10;
    viewer.overlayScene.add(this.root);

    // Wave guides: one quad over the board, analytic crest lines in the fragment shader.
    const b = sculpture.data.board;
    const w = b.widthMm + 1200, h = b.heightMm + 1200;
    this.waveMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uCount: { value: 0 },
          uA: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4()) },
          uB: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4()) },
          uC: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4()) },
          uBoard: { value: new THREE.Vector4() },
        },
        vertexShader: /* glsl */ `
          varying vec2 vPos;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vPos = wp.xy;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          #define MAX ${MAX_SOURCES}
          #define TAU 6.283185307179586
          uniform int uCount;
          uniform vec4 uA[MAX]; // x, y, spacing, reach (<0 = whole board)
          uniform vec4 uB[MAX]; // kind (0 ripple, 1 travel), dirX, dirY, local phase
          uniform vec4 uC[MAX]; // active, selected, enabled, 0
          uniform vec4 uBoard;  // minX, minY, maxX, maxY
          varying vec2 vPos;
          float smoother(float t) { t = clamp(t, 0.0, 1.0); return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
          float lineAA(float d, float widthPx) {
            float aa = fwidth(d);
            return 1.0 - smoothstep(aa * widthPx * 0.5, aa * (widthPx * 0.5 + 1.0), abs(d));
          }
          void main() {
            float alpha = 0.0;
            vec3 color = vec3(1.0);
            float inBoard = step(uBoard.x, vPos.x) * step(vPos.x, uBoard.z) * step(uBoard.y, vPos.y) * step(vPos.y, uBoard.w);
            for (int i = 0; i < MAX; i++) {
              if (i >= uCount) break;
              vec2 d = vPos - uA[i].xy;
              float r = length(d);
              float reach = uA[i].w;
              float E = reach < 0.0 ? 1.0 : smoother(1.0 - r / reach);
              float lambda = uA[i].z;
              float s = uB[i].x < 0.5 ? TAU * r / lambda - uB[i].w : TAU * dot(d, uB[i].yz) / lambda - uB[i].w;
              // Signed distance (mm) to the nearest crest, where sin(s) = 1.
              float u = (s - 1.5707963) / TAU;
              float dc = (fract(u + 0.5) - 0.5) * lambda;
              float weight = uC[i].z < 0.5 ? 0.12 : (uC[i].x > 0.5 ? 0.62 : 0.3);
              weight *= uC[i].y > 0.5 ? 1.0 : 0.55;
              float crest = lineAA(dc, 1.6) * E * inBoard;
              alpha = max(alpha, crest * weight);
              if (reach > 0.0) {
                float ang = atan(d.y, d.x);
                float dash = step(0.5, fract(ang * reach / 40.0));
                float ring = lineAA(r - reach, 1.5) * dash;
                alpha = max(alpha, ring * (uC[i].y > 0.5 ? 0.7 : 0.35));
              }
            }
            gl_FragColor = vec4(color, alpha);
          }`,
      }),
    );
    this.waveMesh.renderOrder = 1;
    this.root.add(this.waveMesh);

    // Brush footprint: soft falloff fill plus a crisp rim.
    this.brushMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uActive: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; uniform float uActive; varying vec2 vUv;
          float smoother(float t) { t = clamp(t, 0.0, 1.0); return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
          void main() {
            float r = length(vUv);
            float aa = fwidth(r);
            float fill = smoother(1.0 - r) * (0.16 + 0.12 * uActive);
            float rim = 1.0 - smoothstep(aa * 0.8, aa * 2.2, abs(r - 1.0));
            float innerRing = (1.0 - smoothstep(aa * 0.5, aa * 1.5, abs(r - 0.5))) * step(0.5, fract(atan(vUv.y, vUv.x) * 6.0));
            float a = max(fill, max(rim * 0.95, innerRing * 0.35));
            if (r > 1.0 + aa * 3.0) discard;
            gl_FragColor = vec4(uColor, a);
          }`,
      }),
    );
    this.brushMesh.renderOrder = 3;
    this.brushMesh.visible = false;
    this.root.add(this.brushMesh);
    this.glyph = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }),
    );
    this.glyph.renderOrder = 4;
    this.glyph.visible = false;
    this.root.add(this.glyph);

    // Issue markers at the tips of flagged pieces, plus their outer edges.
    const dot = makeDotTexture();
    this.flags = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 15, sizeAttenuation: false, map: dot, vertexColors: true, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.flags.renderOrder = 5;
    this.flags.frustumCulled = false;
    this.flagLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }),
    );
    this.flagLines.renderOrder = 5;
    this.flagLines.frustumCulled = false;
    this.root.add(this.flags, this.flagLines);

    this.boardLines = new THREE.Group();
    this.root.add(this.boardLines);
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
    this.viewer.requestRender();
  }

  /* ---------------------------------------------------------------- wave guides & handles */

  setSources(sources: WaveSource[], selectedId: string | null, phase: number, board: BoardSettings): void {
    this.sources = sources;
    const u = this.waveMesh.material.uniforms;
    const list = sources.slice(0, MAX_SOURCES);
    u.uCount.value = list.length;
    list.forEach((s, i) => {
      const a = (s.direction * Math.PI) / 180;
      (u.uA.value[i] as THREE.Vector4).set(s.x, s.y, s.spacing, Number.isFinite(s.reach) ? s.reach : -1);
      (u.uB.value[i] as THREE.Vector4).set(s.kind === 'ripple' ? 0 : 1, Math.cos(a), Math.sin(a), sourcePhase(s, phase));
      (u.uC.value[i] as THREE.Vector4).set(s.height !== 0 || s.lean !== 0 ? 1 : 0, s.id === selectedId ? 1 : 0, s.enabled ? 1 : 0, 0);
    });
    (u.uBoard.value as THREE.Vector4).set(
      board.centerX - board.width / 2, board.centerY - board.height / 2,
      board.centerX + board.width / 2, board.centerY + board.height / 2,
    );
    this.waveMesh.position.set(board.centerX, board.centerY, 0);
    this.waveMesh.visible = this.guidesVisible && list.length > 0;

    // Handles.
    const seen = new Set<string>();
    list.forEach((s, i) => {
      seen.add(s.id);
      const selected = s.id === selectedId;
      const key = `${s.kind}:${selected ? 1 : 0}:${i + 1}:${s.enabled ? 1 : 0}`;
      let h = this.handles.get(s.id);
      if (!h) {
        const center = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, sizeAttenuation: false }));
        const dir = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.handleTexture('dir'), depthTest: false, depthWrite: false, sizeAttenuation: false }));
        const arm = new THREE.Line(
          new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)),
          new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }),
        );
        center.renderOrder = dir.renderOrder = 7;
        arm.renderOrder = 6;
        this.root.add(arm, center, dir);
        h = { center, dir, arm, key: '' };
        this.handles.set(s.id, h);
      }
      if (h.key !== key) {
        h.center.material.map = this.handleTexture(key);
        h.center.material.needsUpdate = true;
        h.key = key;
      }
      h.center.position.set(s.x, s.y, 0);
      const a = (s.direction * Math.PI) / 180;
      const hx = s.x + Math.cos(a) * DIRECTION_ARM_MM, hy = s.y + Math.sin(a) * DIRECTION_ARM_MM;
      h.dir.position.set(hx, hy, 0);
      const showDir = s.kind === 'travel';
      h.dir.visible = h.arm.visible = showDir && this.handlesVisible;
      h.center.visible = this.handlesVisible;
      const pos = h.arm.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, s.x, s.y, 0);
      pos.setXYZ(1, hx, hy, 0);
      pos.needsUpdate = true;
    });
    for (const [id, h] of this.handles) {
      if (seen.has(id)) continue;
      this.root.remove(h.center, h.dir, h.arm);
      h.center.material.dispose();
      h.dir.material.dispose();
      h.arm.geometry.dispose();
      this.handles.delete(id);
    }
    this.updateScale();
    this.viewer.requestRender();
  }

  /** Keep sprites a constant size on screen. Call after camera or viewport changes. */
  updateScale(): void {
    const el = this.viewer.renderer.domElement;
    const hPx = el.clientHeight || 1;
    const k = (2 * Math.tan(THREE.MathUtils.degToRad(this.viewer.camera.fov / 2))) / hPx;
    for (const h of this.handles.values()) {
      h.center.scale.setScalar(HANDLE_PX * k);
      h.dir.scale.setScalar(DIR_HANDLE_PX * k);
    }
  }

  handleAt(clientX: number, clientY: number): HandleHit | null {
    if (!this.root.visible || !this.handlesVisible) return null;
    let best: HandleHit | null = null;
    let bestD = Infinity;
    for (const s of this.sources) {
      const h = this.handles.get(s.id);
      if (!h) continue;
      const c = this.viewer.project(s.x, s.y, 0);
      const d = Math.hypot(c.x - clientX, c.y - clientY);
      if (d < HANDLE_PX * 0.75 && d < bestD) {
        best = { id: s.id, part: 'center' };
        bestD = d;
      }
      if (s.kind === 'travel') {
        const p = this.viewer.project(h.dir.position.x, h.dir.position.y, 0);
        const dd = Math.hypot(p.x - clientX, p.y - clientY);
        if (dd < DIR_HANDLE_PX * 0.9 && dd < bestD) {
          best = { id: s.id, part: 'direction' };
          bestD = dd;
        }
      }
    }
    return best;
  }

  private handleTexture(key: string): THREE.CanvasTexture {
    const cached = this.handleTextures.get(key);
    if (cached) return cached;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.translate(64, 64);
    if (key === 'dir') {
      g.shadowColor = 'rgba(0,0,0,0.35)';
      g.shadowBlur = 10;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(0, 0, 40, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
      g.fillStyle = '#007aff';
      g.beginPath();
      g.arc(0, 0, 18, 0, Math.PI * 2);
      g.fill();
    } else {
      const [kind, sel, num, enabled] = key.split(':');
      const selected = sel === '1';
      g.shadowColor = 'rgba(0,0,0,0.4)';
      g.shadowBlur = 12;
      g.fillStyle = enabled === '1' ? '#ffffff' : '#d7dae0';
      g.beginPath();
      g.arc(0, 0, 50, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
      g.lineWidth = selected ? 10 : 5;
      g.strokeStyle = selected ? '#007aff' : '#4b5059';
      g.beginPath();
      g.arc(0, 0, selected ? 47 : 48, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = selected ? '#007aff' : '#30343a';
      g.lineWidth = 5;
      if (kind === 'ripple') {
        for (const r of [9, 22]) {
          g.beginPath();
          g.arc(0, 0, r, 0, Math.PI * 2);
          g.stroke();
        }
      } else {
        for (const x of [-16, 0, 16]) {
          g.beginPath();
          g.moveTo(x - 4, -20);
          g.quadraticCurveTo(x + 6, 0, x - 4, 20);
          g.stroke();
        }
      }
      if (Number(num) > 1 || this.sources.length > 1) {
        g.fillStyle = selected ? '#007aff' : '#30343a';
        g.beginPath();
        g.arc(34, -34, 20, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#fff';
        g.font = '700 26px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(num, 34, -32);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.handleTextures.set(key, tex);
    return tex;
  }

  /* ---------------------------------------------------------------- brush cursor */

  setBrush(b: BrushCursor | null): void {
    const show = !!b;
    this.brushMesh.visible = show;
    this.glyph.visible = show;
    if (!b) {
      this.viewer.requestRender();
      return;
    }
    this.brushMesh.position.set(b.x, b.y, 0);
    this.brushMesh.scale.setScalar(b.radius);
    this.brushMesh.material.uniforms.uActive.value = b.active ? 1 : 0;
    const warm = b.sign < 0 && (b.kind === 'height' || b.kind === 'leanX' || b.kind === 'leanY');
    (this.brushMesh.material.uniforms.uColor.value as THREE.Color).set(warm ? '#ffd29a' : '#ffffff');
    const key = glyphKey(b);
    let tex = this.glyphCache.get(key);
    if (!tex) {
      tex = makeGlyph(b);
      this.glyphCache.set(key, tex);
    }
    if (this.glyph.material.map !== tex) {
      this.glyph.material.map = tex;
      this.glyph.material.needsUpdate = true;
    }
    const mmPerPx = this.viewer.mmPerPixel(b.x, b.y);
    const size = Math.min(b.radius * 1.1, Math.max(b.radius * 0.62, 46 * mmPerPx));
    this.glyph.position.set(b.x, b.y, 0);
    this.glyph.scale.setScalar(size);
    this.viewer.requestRender();
  }

  /* ---------------------------------------------------------------- issues */

  setFlags(flagged: ReadonlyMap<number, Severity>, outer: Float64Array): void {
    const n = flagged.size;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const lpos = new Float32Array(n * 6 * 2 * 3);
    const lcol = new Float32Array(n * 6 * 2 * 3);
    let k = 0, l = 0;
    const red = new THREE.Color('#ff3b30'), amber = new THREE.Color('#ffb020');
    for (const [i, sev] of flagged) {
      const c = sev === 'error' ? red : amber;
      const apex = this.sculpture.roles[i * 4 + 3];
      const o = i * 12;
      pos.set([outer[o + apex * 3], outer[o + apex * 3 + 1], outer[o + apex * 3 + 2]], k * 3);
      col.set([c.r, c.g, c.b], k * 3);
      k++;
      for (const [a, b] of [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]) {
        for (const v of [a, b]) {
          lpos.set([outer[o + v * 3], outer[o + v * 3 + 1], outer[o + v * 3 + 2]], l * 3);
          lcol.set([c.r, c.g, c.b], l * 3);
          l++;
        }
      }
    }
    this.flags.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.flags.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.flagLines.geometry.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
    this.flagLines.geometry.setAttribute('color', new THREE.BufferAttribute(lcol, 3));
    this.flags.visible = this.flagLines.visible = n > 0;
    this.viewer.requestRender();
  }

  /* ---------------------------------------------------------------- board guides */

  setBoardGuides(board: BoardSettings, env: Envelope, report: BorderReport): void {
    this.boardLines.clear();
    const rect = (x0: number, y0: number, x1: number, y1: number, color: string, opacity: number, dashed: boolean) => {
      const pts = [new THREE.Vector3(x0, y0, 0), new THREE.Vector3(x1, y0, 0), new THREE.Vector3(x1, y1, 0), new THREE.Vector3(x0, y1, 0), new THREE.Vector3(x0, y0, 0)];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 14, gapSize: 10, depthTest: false })
        : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
      const line = new THREE.Line(geo, mat);
      if (dashed) line.computeLineDistances();
      line.renderOrder = 2;
      this.boardLines.add(line);
    };
    const bx0 = board.centerX - board.width / 2, bx1 = board.centerX + board.width / 2;
    const by0 = board.centerY - board.height / 2, by1 = board.centerY + board.height / 2;
    rect(bx0 + board.border, by0 + board.border, bx1 - board.border, by1 - board.border, '#ffffff', 0.4, true);
    if (report.status !== 'ok') {
      rect(env.minX, env.minY, env.maxX, env.maxY, report.status === 'exceeds' ? '#ff3b30' : '#ffb020', 0.95, false);
    }
    this.viewer.requestRender();
  }
}

function glyphKey(b: BrushCursor): string {
  return `${b.kind}:${b.sign}:${b.kind === 'smooth' ? b.axis : ''}`;
}

/** Direction glyph drawn in the board plane: arrows for lean, out/in symbols for height. */
function makeGlyph(b: BrushCursor): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.translate(128, 128);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const stroke = (draw: () => void) => {
    g.strokeStyle = 'rgba(10,12,14,0.75)';
    g.lineWidth = 30;
    draw();
    g.stroke();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 15;
    draw();
    g.stroke();
  };
  const arrow = (angle: number) => {
    g.save();
    g.rotate(-angle); // canvas y points down; board y points up
    stroke(() => {
      g.beginPath();
      g.moveTo(-80, 0);
      g.lineTo(80, 0);
      g.moveTo(40, -42);
      g.lineTo(84, 0);
      g.lineTo(40, 42);
    });
    g.restore();
  };
  switch (b.kind) {
    case 'leanX':
      arrow(b.sign > 0 ? 0 : Math.PI);
      break;
    case 'leanY':
      arrow(b.sign > 0 ? Math.PI / 2 : -Math.PI / 2);
      break;
    case 'height':
      stroke(() => {
        g.beginPath();
        g.arc(0, 0, 70, 0, Math.PI * 2);
      });
      if (b.sign > 0) {
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(0, 0, 20, 0, Math.PI * 2);
        g.fill();
      } else {
        stroke(() => {
          g.beginPath();
          g.moveTo(-40, -40);
          g.lineTo(40, 40);
          g.moveTo(40, -40);
          g.lineTo(-40, 40);
        });
      }
      break;
    case 'smooth':
      stroke(() => {
        g.beginPath();
        for (const y of [-26, 26]) {
          g.moveTo(-84, y);
          g.bezierCurveTo(-40, y - 44, 0, y + 44, 40, y);
          g.quadraticCurveTo(62, y - 22, 84, y);
        }
      });
      break;
    case 'restore':
      stroke(() => {
        g.beginPath();
        g.arc(0, 0, 66, Math.PI * 0.15, Math.PI * 1.75);
        g.moveTo(66 * Math.cos(Math.PI * 0.15) + 30, 66 * Math.sin(Math.PI * 0.15) - 6);
        g.lineTo(66 * Math.cos(Math.PI * 0.15), 66 * Math.sin(Math.PI * 0.15));
        g.lineTo(66 * Math.cos(Math.PI * 0.15) - 8, 66 * Math.sin(Math.PI * 0.15) - 34);
      });
      break;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeDotTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(32, 32, 24, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
