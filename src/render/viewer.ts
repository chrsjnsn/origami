/**
 * Three.js viewer: materials, studio lighting, board, camera views and picking.
 * Board coordinates map directly to three.js world space (mm, X right, Y up, Z toward viewer).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { BoardSettings } from '../core/board';
import type { Sculpture } from '../core/sculpture';
import { findCamera, findLight, type Presentation } from './presentation';
import { ShellMesh } from './shellMesh';

export type ViewName = 'front' | 'angled' | 'detail';

/** Studio balance, tuned by measuring rendered pixels against the Blender reference renders. */
export interface Lighting {
  exposure: number;
  /** Brightness of the soft world dome in the environment map. */
  sky: number;
  /** Brightness of the three softbox panels in the environment map. */
  panels: number;
  key: number;
  fill: number;
  edge: number;
  shadowRadius: number;
  /** Ambient occlusion strength (0 disables the pass). */
  ao: number;
  aoRadius: number;
  backdrop: number;
}

export const DEFAULT_LIGHTING: Lighting = {
  exposure: 1.1,
  sky: 1.2,
  panels: 1.8,
  key: 2.8,
  fill: 0.55,
  edge: 0.9,
  shadowRadius: 5,
  ao: 1.2,
  aoRadius: 80,
  backdrop: 1,
};
export type InteractionMode = 'view' | 'handles' | 'paint';

interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
}

const linear = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly overlayScene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly outer: ShellMesh;
  readonly inner: ShellMesh;
  readonly outerMaterial: THREE.MeshPhysicalMaterial;
  readonly innerMaterial: THREE.MeshPhysicalMaterial;
  private board!: THREE.Mesh;
  private boardSettings!: BoardSettings;
  readonly keyLight: THREE.DirectionalLight;
  private needsRender = true;
  private tween: { from: CameraPose; to: CameraPose; t0: number; ms: number } | null = null;
  private frameHooks = new Set<(t: number, dt: number) => void>();
  private lastFrame = performance.now();
  private readonly raycaster = new THREE.Raycaster();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private resizeObserver: ResizeObserver;
  private gizmo: AxisGizmo;
  showGizmo = false;
  overlaysVisible = true;
  /** Rolling frame-time statistics (ms) for the performance readout. */
  readonly stats = { frames: 0, renderMs: 0, frameMs: 0 };
  private initialView: ViewName = 'front';
  /** Last named view, re-applied after a resize unless the user has moved the camera since. */
  private currentView: ViewName | null = 'front';
  private reframeTimer = 0;
  /** Screen space (CSS px) covered by page UI at the top and bottom of the viewer. */
  viewInsets = { top: 0, bottom: 0 };
  private lights: { key: THREE.DirectionalLight; fill: THREE.DirectionalLight; edge: THREE.DirectionalLight };
  lighting: Lighting = { ...DEFAULT_LIGHTING };
  private composer: EffectComposer;
  private gtao: GTAOPass;
  private backdrop: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  /** 'high' / 'medium' = ambient occlusion on (half resolution), 'low' = no AO. */
  quality: 'high' | 'medium' | 'low';
  /** Dynamic resolution: current and maximum pixel ratio. */
  private pixelRatio: number;
  private readonly maxPixelRatio: number;
  private readonly minPixelRatio: number;
  private intervals: number[] = [];
  private renderedLastFrame = false;
  private lastQualityChange = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly sculpture: Sculpture,
    private readonly presentation: Presentation,
    grain: THREE.Texture,
  ) {
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.quality = coarse ? 'medium' : 'high';
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    // 1.5x with 4x MSAA is visually crisp; dynamic resolution lowers it if frames run slow.
    this.maxPixelRatio = Math.min(devicePixelRatio, 1.5);
    this.minPixelRatio = Math.min(this.maxPixelRatio, coarse ? 0.75 : 1);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Linear tone mapping with exposure behaves like Blender's "Standard" view transform:
    // no hue shift, so the #007AFF blue stays saturated instead of drifting toward periwinkle.
    this.renderer.toneMapping = THREE.LinearToneMapping;
    this.renderer.toneMappingExposure = this.lighting.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.className = 'viewer-canvas';
    container.prepend(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(22, 1, 10, 50000);
    this.camera.position.set(725, 450, 4000);

    // ---------------------------------------------------------------- materials
    grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
    grain.colorSpace = THREE.NoColorSpace;
    grain.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const outerRamp = presentation.materials.outer.ramp?.at(-1)?.linear_rgb ?? [0.0071, 0.0082, 0.0094];
    const innerRamp = presentation.materials.inner.ramp?.at(-1)?.linear_rgb ?? [0, 0.2277, 1.17];
    this.outerMaterial = new THREE.MeshPhysicalMaterial({
      name: 'Matte black dyed cardboard',
      color: linear(outerRamp[0], outerRamp[1], outerRamp[2]),
      map: grain,
      bumpMap: grain,
      bumpScale: 1.6,
      roughness: 0.88,
      metalness: 0,
      specularIntensity: 0.44, // Blender Specular IOR Level 0.22 (F0 = 0.04 * 0.44)
      envMapIntensity: 1,
    });
    this.innerMaterial = new THREE.MeshPhysicalMaterial({
      name: 'Vibrant message blue paper - sRGB 007AFF',
      color: linear(innerRamp[0], innerRamp[1], innerRamp[2]),
      map: grain,
      bumpMap: grain,
      bumpScale: 0.8,
      roughness: 0.72,
      metalness: 0,
      specularIntensity: 0.44,
      envMapIntensity: 1,
    });

    // ---------------------------------------------------------------- shells
    const p = sculpture.data.presentation;
    const tile = presentation.grainTexture.tile_mm;
    this.outer = new ShellMesh(sculpture, { thickness: p.outerThicknessMm, offset: 1 }, this.outerMaterial, tile);
    this.inner = new ShellMesh(sculpture, { thickness: p.innerThicknessMm, offset: -1 }, this.innerMaterial, tile);
    this.scene.add(this.outer.mesh, this.inner.mesh);

    // ---------------------------------------------------------------- studio
    this.lights = this.addLights();
    this.keyLight = this.lights.key;
    this.setLighting({});
    // Studio backdrop (the wall the board hangs on), as in the Blender scene.
    const bd = presentation.materials.backdrop?.principled?.['Base Color'] as number[] | undefined;
    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(60000, 60000),
      new THREE.MeshStandardMaterial({ color: linear(bd?.[0] ?? 0.26, bd?.[1] ?? 0.28, bd?.[2] ?? 0.3), roughness: 0.91, metalness: 0 }),
    );
    this.backdrop.position.z = presentation.backdropZMm ?? -6.8;
    this.backdrop.receiveShadow = true;
    this.backdrop.name = 'Studio backdrop';
    this.scene.add(this.backdrop);
    this.scene.background = linear(0.62, 0.66, 0.72);

    // Post-processing: MSAA beauty pass -> ground-truth ambient occlusion -> tone mapping.
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.updateGtaoMaterial({ radius: 80, distanceExponent: 1, thickness: 40, scale: 2, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.composer.addPass(this.gtao);
    this.composer.addPass(new OutputPass());

    // ---------------------------------------------------------------- controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 110;
    this.controls.maxDistance = 7000;
    this.controls.minAzimuthAngle = -1.35;
    this.controls.maxAzimuthAngle = 1.35;
    this.controls.minPolarAngle = 0.18;
    this.controls.maxPolarAngle = Math.PI - 0.18;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => (this.needsRender = true));
    this.controls.addEventListener('start', () => {
      this.tween = null;
      this.currentView = null;
    });

    this.gizmo = new AxisGizmo();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.goTo(this.initialView, false);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /* ---------------------------------------------------------------- scene content ---- */

  /** Apply (part of) a lighting configuration. */
  setLighting(patch: Partial<Lighting>): void {
    const prev = this.lighting;
    const next = { ...prev, ...patch };
    this.lighting = next;
    if (!this.scene.environment || patch.sky !== undefined || patch.panels !== undefined) {
      this.scene.environment?.dispose();
      this.scene.environment = buildStudioEnvironment(this.renderer, this.presentation, next.sky, next.panels);
    }
    this.renderer.toneMappingExposure = next.exposure;
    this.lights.key.intensity = next.key;
    this.lights.fill.intensity = next.fill;
    this.lights.edge.intensity = next.edge;
    this.lights.key.shadow.radius = next.shadowRadius;
    if (this.gtao) {
      this.gtao.enabled = next.ao > 0 && this.quality !== 'low';
      this.gtao.blendIntensity = next.ao;
      this.gtao.updateGtaoMaterial({ radius: next.aoRadius });
    }
    if (this.backdrop) {
      const bd = this.presentation.materials.backdrop?.principled?.['Base Color'] as number[] | undefined;
      const k = next.backdrop;
      this.backdrop.material.color.copy(linear((bd?.[0] ?? 0.26) * k, (bd?.[1] ?? 0.28) * k, (bd?.[2] ?? 0.3) * k));
    }
    this.needsRender = true;
  }

  private addLights() {
    const pres = this.presentation;
    const center = new THREE.Vector3(pres.board.center[0], pres.board.center[1], 0);
    const keyInfo = findLight(pres, 'key');
    const fillInfo = findLight(pres, 'fill');
    const edgeInfo = findLight(pres, 'edge');
    const mk = (info: typeof keyInfo, intensity: number, fallback: [number, number, number]) => {
      const light = new THREE.DirectionalLight(
        info ? linear(info.color[0], info.color[1], info.color[2]) : 0xffffff,
        intensity,
      );
      const pos = info ? new THREE.Vector3(...info.positionMm) : new THREE.Vector3(...fallback);
      light.position.copy(pos);
      light.target.position.copy(center);
      this.scene.add(light, light.target);
      return light;
    };
    const key = mk(keyInfo, 2.3, [-75, 950, 2200]);
    const fill = mk(fillInfo, 0.55, [2125, -350, 1700]);
    const edge = mk(edgeInfo, 0.9, [925, 2050, 1000]);

    key.castShadow = true;
    const s = key.shadow;
    s.mapSize.set(4096, 4096);
    s.radius = 5;
    s.bias = -0.0002;
    s.normalBias = 0.35;
    this.fitShadowCamera(key);
    return { key, fill, edge };
  }

  private fitShadowCamera(light: THREE.DirectionalLight): void {
    const b = this.presentation.board;
    const cam = light.shadow.camera;
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();
    const view = new THREE.Matrix4().lookAt(light.position, light.target.position, new THREE.Vector3(0, 1, 0));
    const inv = view.clone().invert();
    const pts: THREE.Vector3[] = [];
    const m = 120;
    for (const x of [b.center[0] - b.widthMm / 2 - m, b.center[0] + b.widthMm / 2 + m]) {
      for (const y of [b.center[1] - b.heightMm / 2 - m, b.center[1] + b.heightMm / 2 + m]) {
        for (const z of [-10, 130]) pts.push(new THREE.Vector3(x, y, z).sub(light.position).applyMatrix4(inv));
      }
    }
    const box = new THREE.Box3().setFromPoints(pts);
    cam.left = box.min.x;
    cam.right = box.max.x;
    cam.bottom = box.min.y;
    cam.top = box.max.y;
    cam.near = Math.max(1, -box.max.z - 50);
    cam.far = -box.min.z + 50;
    cam.updateProjectionMatrix();
  }

  setBoard(board: BoardSettings): void {
    const same =
      this.boardSettings &&
      board.width === this.boardSettings.width &&
      board.height === this.boardSettings.height &&
      board.centerX === this.boardSettings.centerX &&
      board.centerY === this.boardSettings.centerY;
    if (same) return;
    this.boardSettings = { ...board };
    if (this.board) {
      this.scene.remove(this.board);
      this.board.geometry.dispose();
    }
    const geo = new RoundedBoxGeometry(board.width, board.height, board.thickness, 3, 0.6);
    // Box-projected UVs in millimeters for the paper grain.
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const tile = this.presentation.grainTexture.tile_mm;
    for (let i = 0; i < pos.count; i++) {
      const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
      const x = pos.getX(i) + board.centerX, y = pos.getY(i) + board.centerY, z = pos.getZ(i);
      if (az >= ax && az >= ay) uv.setXY(i, x / tile, y / tile);
      else if (ax >= ay) uv.setXY(i, y / tile, z / tile);
      else uv.setXY(i, x / tile, z / tile);
    }
    this.board = new THREE.Mesh(geo, this.outerMaterial);
    this.board.position.set(board.centerX, board.centerY, board.topZ - board.thickness / 2);
    this.board.receiveShadow = true;
    this.board.castShadow = true;
    this.board.name = 'Backing board';
    this.scene.add(this.board);
    this.needsRender = true;
  }

  setShells(outer: Float64Array, inner: Float64Array): void {
    this.outer.update(outer);
    this.inner.update(inner);
    this.needsRender = true;
  }

  requestRender(): void {
    this.needsRender = true;
  }

  onFrame(fn: (t: number, dt: number) => void): () => void {
    this.frameHooks.add(fn);
    return () => this.frameHooks.delete(fn);
  }

  /* ---------------------------------------------------------------- camera ---- */

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(w, h);
    // Occlusion is low-frequency: half resolution costs a quarter and looks the same after denoising.
    this.gtao.setSize(Math.ceil((w * this.pixelRatio) / 2), Math.ceil((h * this.pixelRatio) / 2));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
    if (this.currentView) {
      clearTimeout(this.reframeTimer);
      const view = this.currentView;
      this.reframeTimer = window.setTimeout(() => this.currentView === view && this.goTo(view, false), 120);
    }
  }

  /** Pose that frames a W x H region around `target`, seen along `dir` (from target to camera). */
  private framePose(dir: THREE.Vector3, up: THREE.Vector3, target: THREE.Vector3, w: number, h: number, margin: number): CameraPose {
    const d = dir.clone().normalize();
    const right = new THREE.Vector3().crossVectors(up, d).normalize();
    const trueUp = new THREE.Vector3().crossVectors(d, right).normalize();
    // Project the region's corners onto the camera axes to get its apparent size.
    let maxR = 0, maxU = 0;
    for (const sx of [-0.5, 0.5]) {
      for (const sy of [-0.5, 0.5]) {
        const c = new THREE.Vector3(sx * w, sy * h, 0);
        maxR = Math.max(maxR, Math.abs(c.dot(right)));
        maxU = Math.max(maxU, Math.abs(c.dot(trueUp)));
      }
    }
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const tanH = tanV * this.camera.aspect;
    // Fit into the part of the viewer not covered by page UI, then shift so the artwork is
    // centered in that free band.
    const H = Math.max(1, this.container.clientHeight);
    const { top, bottom } = this.viewInsets;
    const free = Math.max(0.35, (H - top - bottom) / H);
    const dist = Math.max(maxU / (tanV * free), maxR / tanH) * margin;
    const shift = ((top - bottom) / 2) * ((2 * dist * tanV) / H);
    const t = target.clone().addScaledVector(trueUp, shift);
    return { position: t.clone().addScaledVector(d, dist), target: t, up: trueUp };
  }

  viewPose(name: ViewName): CameraPose {
    const b = this.boardSettings ?? {
      width: this.presentation.board.widthMm,
      height: this.presentation.board.heightMm,
      centerX: this.presentation.board.center[0],
      centerY: this.presentation.board.center[1],
    };
    const center = new THREE.Vector3(b.centerX, b.centerY, 20);
    const narrow = this.camera.aspect < 1;
    if (name === 'front') {
      return this.framePose(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), center, b.width, b.height, narrow ? 1.04 : 1.1);
    }
    if (name === 'angled') {
      const cam = findCamera(this.presentation, '02');
      const dir = cam ? new THREE.Vector3(...cam.forward).negate() : new THREE.Vector3(0.18, -0.35, 0.92);
      const up = cam ? new THREE.Vector3(...cam.up) : new THREE.Vector3(0, 1, 0);
      return this.framePose(dir, up, center, b.width, b.height, narrow ? 1.12 : 1.16);
    }
    const cam = findCamera(this.presentation, '03');
    const dir = cam ? new THREE.Vector3(...cam.forward).negate() : new THREE.Vector3(0.5, 0.4, 0.75);
    const up = cam ? new THREE.Vector3(...cam.up) : new THREE.Vector3(0, 1, 0);
    const t = cam ? new THREE.Vector3(cam.targetOnBoardMm[0], cam.targetOnBoardMm[1], 30) : center;
    const size = cam ? cam.orthoScaleMm : 490;
    return this.framePose(dir, up, t, size, size * 0.8, 1.0);
  }

  goTo(name: ViewName, animate = true): void {
    this.currentView = name;
    this.applyPose(this.viewPose(name), animate);
  }

  resetView(): void {
    this.goTo(this.initialView);
  }

  /** Fly to a close view of one piece (used by the geometry check). */
  focusPiece(index: number): void {
    this.currentView = null;
    const a = this.sculpture.anchors;
    const target = new THREE.Vector3(a[index * 3], a[index * 3 + 1], 30);
    const dir = new THREE.Vector3(0.25, -0.3, 0.92);
    this.applyPose(this.framePose(dir, new THREE.Vector3(0, 1, 0), target, 360, 280, 1), true);
  }

  private applyPose(pose: CameraPose, animate: boolean): void {
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.tween = null;
      this.camera.position.copy(pose.position);
      this.camera.up.copy(pose.up);
      this.controls.target.copy(pose.target);
      this.camera.lookAt(pose.target);
      this.controls.update();
      this.needsRender = true;
      return;
    }
    this.tween = {
      from: { position: this.camera.position.clone(), target: this.controls.target.clone(), up: this.camera.up.clone() },
      to: pose,
      t0: performance.now(),
      ms: 900,
    };
  }

  setInteraction(mode: InteractionMode): void {
    const c = this.controls;
    const NONE = -1 as unknown as THREE.MOUSE;
    if (mode === 'paint') {
      c.mouseButtons = { LEFT: NONE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      c.touches = { ONE: -1 as unknown as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_ROTATE };
    } else {
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    }
    this.renderer.domElement.dataset.mode = mode;
  }

  /* ---------------------------------------------------------------- picking ---- */

  /** Board-plane (z = 0) point under a client position, or null if the ray misses. */
  boardPoint(clientX: number, clientY: number, z = 0): { x: number; y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.plane.constant = -z;
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, hit)) return null;
    return { x: hit.x, y: hit.y };
  }

  /** Client coordinates of a world point. */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, visible: v.z < 1 };
  }

  /** World size (mm) of one CSS pixel at a board point, for screen-constant overlays. */
  mmPerPixel(x: number, y: number): number {
    const dist = this.camera.position.distanceTo(new THREE.Vector3(x, y, 0));
    const h = this.renderer.domElement.clientHeight || 1;
    return (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h;
  }

  /* ---------------------------------------------------------------- rendering ---- */

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.frameHooks.forEach((fn) => fn(now, dt));
    if (this.tween) {
      const { from, to, t0, ms } = this.tween;
      const k = Math.min(1, (now - t0) / ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(from.position, to.position, e);
      this.controls.target.lerpVectors(from.target, to.target, e);
      this.camera.up.lerpVectors(from.up, to.up, e).normalize();
      this.camera.lookAt(this.controls.target);
      if (k >= 1) this.tween = null;
      this.needsRender = true;
    }
    if (this.controls.update()) this.needsRender = true;
    if (!this.needsRender) {
      this.renderedLastFrame = false;
      return;
    }
    if (this.renderedLastFrame) this.adaptResolution(now, dt * 1000);
    this.renderedLastFrame = true;
    this.needsRender = false;
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(2, dist * 0.02);
    this.camera.far = dist * 6 + 20000;
    this.camera.updateProjectionMatrix();
    const t0 = performance.now();
    this.renderScene(true);
    const r = performance.now() - t0;
    this.stats.frames++;
    this.stats.renderMs = this.stats.renderMs * 0.9 + r * 0.1;
    this.stats.frameMs = this.stats.frameMs * 0.9 + dt * 1000 * 0.1;
  }

  /** Step the pixel ratio down when continuous rendering is slow, and back up when there is headroom. */
  private adaptResolution(now: number, intervalMs: number): void {
    if (intervalMs > 100) return; // hidden tab or a one-off hitch
    this.intervals.push(intervalMs);
    if (this.intervals.length > 45) this.intervals.shift();
    if (this.intervals.length < 30 || now - this.lastQualityChange < 1500) return;
    const avg = this.intervals.reduce((a, b) => a + b, 0) / this.intervals.length;
    let next = this.pixelRatio;
    if (avg > 21 && this.pixelRatio > this.minPixelRatio) next = Math.max(this.minPixelRatio, this.pixelRatio - 0.25);
    else if (avg < 13 && this.pixelRatio < this.maxPixelRatio) next = Math.min(this.maxPixelRatio, this.pixelRatio + 0.25);
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.lastQualityChange = now;
      this.intervals = [];
      this.resize();
    }
  }

  get currentPixelRatio(): number {
    return this.pixelRatio;
  }

  private renderScene(withOverlays: boolean): void {
    const r = this.renderer;
    r.autoClear = true;
    this.composer.render();
    if (withOverlays && this.overlaysVisible) {
      r.autoClear = false;
      r.clearDepth();
      r.render(this.overlayScene, this.camera);
      if (this.showGizmo) this.gizmo.render(r, this.camera);
      r.autoClear = true;
    }
  }

  /** Render immediately without overlays (used by pixel measurements and captures). */
  renderClean(): void {
    this.renderScene(false);
  }

  /** Render a clean image (no overlays) whose long side is about `longSide` pixels. */
  async capture(longSide = 3000): Promise<Blob> {
    const r = this.renderer;
    const pr = r.getPixelRatio();
    const size = r.getSize(new THREE.Vector2());
    const maxSide = Math.min(8192, r.capabilities.maxTextureSize, longSide);
    const k = Math.max(0.1, maxSide / (Math.max(size.x, size.y) * pr));
    r.setPixelRatio(pr * k);
    r.setSize(size.x, size.y, false);
    this.composer.setPixelRatio(pr * k);
    this.composer.setSize(size.x, size.y);
    this.renderScene(false);
    const src = r.domElement;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    r.setPixelRatio(pr);
    this.resize();
    this.needsRender = true;
    return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('Image capture failed'))), 'image/png'));
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }
}

/* ---------------------------------------------------------------------------------------- */

/**
 * Image-based lighting that mirrors the Blender studio: a soft blue-gray world plus the three
 * disk softboxes (key, fill, edge) as emissive panels, prefiltered with PMREM.
 */
function buildStudioEnvironment(renderer: THREE.WebGLRenderer, pres: Presentation, skyScale: number, panelScale: number): THREE.Texture {
  const env = new THREE.Scene();
  const w = pres.world?.color ?? [0.72, 0.79, 0.91];
  const world = [w[0] * skyScale, w[1] * skyScale, w[2] * skyScale];
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(100, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: linear(world[0] * 0.55, world[1] * 0.55, world[2] * 0.55) },
        horizon: { value: linear(world[0] * 0.3, world[1] * 0.3, world[2] * 0.3) },
        bottom: { value: linear(0.035, 0.037, 0.04) },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; varying vec3 vDir;
        void main(){ float y = vDir.y; vec3 c = y > 0.0 ? mix(horizon, top, pow(y, 0.6)) : mix(horizon, bottom, pow(-y, 0.5)); gl_FragColor = vec4(c, 1.0); }`,
    }),
  );
  env.add(sky);
  const center = new THREE.Vector3(pres.board.center[0], pres.board.center[1], 0);
  for (const l of pres.lights) {
    const rel = new THREE.Vector3(...l.positionMm).sub(center);
    const dist = rel.length();
    const dir = rel.normalize();
    const angular = l.sizeMm / dist; // angular diameter (radians)
    const r = 60 * Math.tan(angular / 2);
    const strength = (panelScale * l.energyW) / 170; // relative to the key light
    const panel = new THREE.Mesh(
      new THREE.CircleGeometry(r, 48),
      new THREE.MeshBasicMaterial({ color: linear(l.color[0] * 4.2 * strength, l.color[1] * 4.2 * strength, l.color[2] * 4.2 * strength), side: THREE.DoubleSide }),
    );
    panel.position.copy(dir.multiplyScalar(60));
    panel.lookAt(0, 0, 0);
    env.add(panel);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.035).texture;
  pmrem.dispose();
  return tex;
}

/** Small XYZ triad showing board axes (X right, Y up, Z toward viewer) in the corner. */
class AxisGizmo {
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  constructor() {
    const axes: [THREE.Vector3, string, string][] = [
      [new THREE.Vector3(1, 0, 0), '#ff5a5f', 'X'],
      [new THREE.Vector3(0, 1, 0), '#34c759', 'Y'],
      [new THREE.Vector3(0, 0, 1), '#0a84ff', 'Z'],
    ];
    for (const [dir, color, label] of axes) {
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color, 0.28, 0.16);
      (arrow.line.material as THREE.LineBasicMaterial).linewidth = 2;
      this.scene.add(arrow);
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = color;
      g.font = '600 44px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, 32, 34);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
      sprite.position.copy(dir.clone().multiplyScalar(1.38));
      sprite.scale.setScalar(0.5);
      this.scene.add(sprite);
    }
  }

  render(renderer: THREE.WebGLRenderer, main: THREE.PerspectiveCamera): void {
    const size = 84;
    const w = renderer.getSize(new THREE.Vector2()).x;
    this.cam.position.set(0, 0, 4).applyQuaternion(main.quaternion);
    this.cam.quaternion.copy(main.quaternion);
    renderer.clearDepth();
    renderer.setScissorTest(true);
    // Bottom-right corner (three.js viewports are measured from the bottom-left).
    renderer.setScissor(w - size - 14, 14, size, size);
    renderer.setViewport(w - size - 14, 14, size, size);
    renderer.render(this.scene, this.cam);
    renderer.setScissorTest(false);
    const full = renderer.getSize(new THREE.Vector2());
    renderer.setViewport(0, 0, full.x, full.y);
  }
}
