/** Types for public/assets/presentation.json (exported from the .blend by the asset script). */

export interface PresentationCamera {
  name: string;
  type: string;
  orthoScaleMm: number;
  positionMm: [number, number, number];
  forward: [number, number, number];
  up: [number, number, number];
  targetOnBoardMm: [number, number, number];
}

export interface PresentationLight {
  name: string;
  type: string;
  shape: string | null;
  sizeMm: number;
  energyW: number;
  color: [number, number, number];
  positionMm: [number, number, number];
  direction: [number, number, number];
}

export interface PresentationMaterial {
  name: string;
  principled?: Record<string, number | number[]>;
  noise?: { scale_per_m: number; detail: number; roughness: number };
  bump?: { strength: number; distance_m: number };
  ramp?: { position: number; linear_rgb: [number, number, number] }[];
}

export interface Presentation {
  renderLook: { viewTransform: string; exposure: number; engine: string };
  materials: { outer: PresentationMaterial; inner: PresentationMaterial; board: string; backdrop: PresentationMaterial | null };
  board: { widthMm: number; heightMm: number; thicknessMm: number; center: [number, number]; topZMm: number };
  backdropZMm: number | null;
  world: { color: [number, number, number]; strength: number } | null;
  cameras: PresentationCamera[];
  lights: PresentationLight[];
  grainTexture: { size_px: number; tile_mm: number; mm_per_px: number };
}

export function findCamera(p: Presentation, prefix: string): PresentationCamera | undefined {
  return p.cameras.find((c) => c.name.startsWith(prefix));
}

export function findLight(p: Presentation, word: string): PresentationLight | undefined {
  return p.lights.find((l) => l.name.toLowerCase().includes(word));
}
