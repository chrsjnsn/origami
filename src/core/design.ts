/**
 * The one authoritative design state.
 *
 *   pose tips = anchors + base offsets + wave field(sources, phase)
 *
 * Everything else (outer shells, inner shells, validation, envelopes, saved files, exports)
 * is derived from this. Inner geometry is never stored or edited independently.
 */

import { type BoardSettings, importedBoard } from './board';
import type { Sculpture } from './sculpture';
import { evaluateWaveField, loopTurns, type WaveSource } from './waves';

export type StartingPoint = 'current' | 'neutral';

export interface KeptShape {
  id: string;
  /** ISO timestamp. */
  at: string;
  label: string;
  /** Generating settings at the moment the shape was kept. */
  sources: WaveSource[];
  phase: number;
  /** Base offsets before the kept pose was committed (lets the user return to the recipe). */
  baseBefore: Float64Array;
}

export interface DesignSnapshot {
  startingPoint: StartingPoint;
  /** Editable offsets (the committed base layer: starting point + kept shapes + brush edits). */
  base: Float64Array;
  /** The chosen baseline for Restore: the starting point, or the most recently kept shape. */
  reference: Float64Array;
  referenceLabel: string;
  sources: WaveSource[];
  /** Global wave phase in radians. Deterministic: the pose depends only on this value. */
  phase: number;
  board: BoardSettings;
  kept: KeptShape[];
}

export function cloneSource(s: WaveSource): WaveSource {
  return { ...s };
}

export function cloneSnapshot(s: DesignSnapshot): DesignSnapshot {
  return {
    startingPoint: s.startingPoint,
    base: s.base.slice(),
    reference: s.reference,
    referenceLabel: s.referenceLabel,
    sources: s.sources.map(cloneSource),
    phase: s.phase,
    board: { ...s.board },
    kept: s.kept.map((k) => ({ ...k, sources: k.sources.map(cloneSource), baseBefore: k.baseBefore })),
  };
}

export function startingOffsets(sculpture: Sculpture, sp: StartingPoint): Float64Array {
  return (sp === 'current' ? sculpture.originalOffsets : sculpture.neutralOffsets).slice();
}

export function initialSnapshot(sculpture: Sculpture): DesignSnapshot {
  return {
    startingPoint: 'current',
    base: startingOffsets(sculpture, 'current'),
    reference: startingOffsets(sculpture, 'current'),
    referenceLabel: 'Current sculpture',
    sources: [],
    phase: 0,
    board: importedBoard(sculpture),
    kept: [],
  };
}

/** Evaluate the pose tip offsets of a snapshot (base + waves) into `out`. */
export function poseOffsets(sculpture: Sculpture, snap: DesignSnapshot, out: Float64Array, field?: Float64Array): Float64Array {
  const f = field ?? new Float64Array(sculpture.count * 3);
  evaluateWaveField(snap.sources, sculpture.anchors, snap.phase, f);
  for (let j = 0; j < out.length; j++) out[j] = snap.base[j] + f[j];
  return out;
}

export function poseTips(sculpture: Sculpture, snap: DesignSnapshot, out: Float64Array = new Float64Array(sculpture.count * 3)): Float64Array {
  poseOffsets(sculpture, snap, out);
  for (let j = 0; j < out.length; j++) out[j] += sculpture.anchors[j];
  return out;
}

/** Wrap the phase into one full loop so long playback stays numerically tidy. */
export function wrapPhase(phase: number, sources: readonly WaveSource[]): number {
  const period = 2 * Math.PI * loopTurns(sources);
  const p = phase % period;
  return p < 0 ? p + period : p;
}

/* ------------------------------------------------------------------------------------------ */
/* Undo history                                                                                */
/* ------------------------------------------------------------------------------------------ */

export interface HistoryEntry {
  label: string;
  snapshot: DesignSnapshot;
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private lastKey: string | null = null;
  private lastTime = 0;
  constructor(private readonly limit = 200) {}

  /**
   * Record the state *before* a change. Changes with the same `coalesceKey` arriving within
   * `windowMs` merge into one undo step (for example one slider drag).
   */
  record(label: string, before: DesignSnapshot, coalesceKey: string | null = null, now = Date.now(), windowMs = 900): void {
    if (coalesceKey && coalesceKey === this.lastKey && now - this.lastTime < windowMs) {
      this.lastTime = now;
      return;
    }
    this.undoStack.push({ label, snapshot: cloneSnapshot(before) });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.lastKey = coalesceKey;
    this.lastTime = now;
  }

  breakCoalescing(): void {
    this.lastKey = null;
  }

  undo(current: DesignSnapshot): HistoryEntry | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ label: e.label, snapshot: cloneSnapshot(current) });
    this.lastKey = null;
    return e;
  }

  redo(current: DesignSnapshot): HistoryEntry | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, snapshot: cloneSnapshot(current) });
    this.lastKey = null;
    return e;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastKey = null;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Serialization                                                                               */
/* ------------------------------------------------------------------------------------------ */

export const DESIGN_FORMAT = 'origami1829-design';
export const DESIGN_VERSION = 1;

type Triple = [number, number, number];

export interface DesignFile {
  format: typeof DESIGN_FORMAT;
  version: number;
  name: string;
  savedAt: string;
  units: 'mm';
  coordinateSystem: string;
  source: { file: string; sha256: string };
  startingPoint: StartingPoint;
  offsetsRelativeTo: string;
  pieceIds: string[];
  baseOffsets: Triple[];
  reference: { label: string; offsets: Triple[] };
  waves: { sources: SerializedSource[]; phase: number; loopTurns: number };
  board: BoardSettings;
  presentation: { outerThicknessMm: number; innerThicknessMm: number; boardThicknessMm: number };
  kept: { id: string; at: string; label: string; sources: SerializedSource[]; phase: number; baseBefore: Triple[] }[];
  pose: { note: string; tips: Triple[] };
  /** Result of the complete geometry check run when the file was saved or exported. */
  validation?: ValidationSummary;
}

export interface ValidationSummary {
  checkedAt: string;
  passed: boolean;
  errors: number;
  warnings: number;
  issues: { code: string; severity: string; pieces: string[]; message: string }[];
  note: string;
}

type SerializedSource = Omit<WaveSource, 'reach'> & { reach: number | 'board' };

function serializeSource(s: WaveSource): SerializedSource {
  return { ...s, reach: Number.isFinite(s.reach) ? s.reach : 'board' };
}

function deserializeSource(s: SerializedSource): WaveSource {
  const out: WaveSource = {
    id: String(s.id),
    kind: s.kind === 'travel' ? 'travel' : 'ripple',
    x: num(s.x),
    y: num(s.y),
    height: num(s.height),
    lean: num(s.lean),
    spacing: num(s.spacing),
    reach: s.reach === 'board' || s.reach === null ? Infinity : num(s.reach),
    direction: num(s.direction ?? 0),
    speed: num(s.speed ?? 1),
    phaseOffset: num(s.phaseOffset ?? 0),
    enabled: s.enabled !== false,
  };
  if (out.spacing <= 0) throw new Error('A wave source has an invalid spacing.');
  return out;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in design file: ${String(v)}`);
  return n;
}

function toTriples(a: Float64Array): Triple[] {
  const out: Triple[] = [];
  for (let j = 0; j < a.length; j += 3) out.push([a[j], a[j + 1], a[j + 2]]);
  return out;
}

function fromTriples(t: unknown, count: number, what: string): Float64Array {
  if (!Array.isArray(t) || t.length !== count) throw new Error(`${what}: expected ${count} entries.`);
  const out = new Float64Array(count * 3);
  t.forEach((v, i) => {
    if (!Array.isArray(v) || v.length !== 3) throw new Error(`${what}: entry ${i} is not [x, y, z].`);
    for (let k = 0; k < 3; k++) out[i * 3 + k] = num(v[k]);
  });
  return out;
}

export function serializeDesign(
  sculpture: Sculpture,
  snap: DesignSnapshot,
  name: string,
  savedAt = new Date().toISOString(),
  validation?: ValidationSummary,
): DesignFile {
  const p = sculpture.data.presentation;
  return {
    format: DESIGN_FORMAT,
    version: DESIGN_VERSION,
    name,
    savedAt,
    units: 'mm',
    coordinateSystem: sculpture.data.coordinateSystem,
    source: { file: sculpture.data.source.file, sha256: sculpture.data.source.sha256 },
    startingPoint: snap.startingPoint,
    offsetsRelativeTo: 'Fixed base-grid anchors: the centroid of each piece’s triangular base (see sculpture.json baseCentroid).',
    pieceIds: [...sculpture.ids],
    baseOffsets: toTriples(snap.base),
    reference: { label: snap.referenceLabel, offsets: toTriples(snap.reference) },
    waves: { sources: snap.sources.map(serializeSource), phase: snap.phase, loopTurns: loopTurns(snap.sources) },
    board: { ...snap.board },
    presentation: { outerThicknessMm: p.outerThicknessMm, innerThicknessMm: p.innerThicknessMm, boardThicknessMm: p.boardThicknessMm },
    kept: snap.kept.map((k) => ({
      id: k.id,
      at: k.at,
      label: k.label,
      sources: k.sources.map(serializeSource),
      phase: k.phase,
      baseBefore: toTriples(k.baseBefore),
    })),
    pose: {
      note: 'Evaluated outer tip positions (mm, board coordinates) for this saved pose. Bases and inner shells follow from sculpture.json and the 75% rule.',
      tips: toTriples(poseTips(sculpture, snap)),
    },
    ...(validation ? { validation } : {}),
  };
}

export interface LoadedDesign {
  name: string;
  snapshot: DesignSnapshot;
  /** Largest difference between the stored pose and the pose rebuilt from the settings (mm). */
  poseMismatchMm: number;
}

export function deserializeDesign(sculpture: Sculpture, raw: unknown): LoadedDesign {
  const f = raw as Partial<DesignFile>;
  if (!f || f.format !== DESIGN_FORMAT) throw new Error('This file is not an Origami 1829 design.');
  if (typeof f.version !== 'number' || f.version > DESIGN_VERSION) throw new Error('This design was saved by a newer version of the studio.');
  if (!Array.isArray(f.pieceIds) || f.pieceIds.length !== sculpture.count || f.pieceIds.some((id, i) => id !== sculpture.ids[i])) {
    throw new Error('The design’s pieces do not match this sculpture.');
  }
  const base = fromTriples(f.baseOffsets, sculpture.count, 'baseOffsets');
  const startingPoint: StartingPoint = f.startingPoint === 'neutral' ? 'neutral' : 'current';
  const reference = f.reference?.offsets
    ? fromTriples(f.reference.offsets, sculpture.count, 'reference.offsets')
    : startingOffsets(sculpture, startingPoint);
  const sources = (f.waves?.sources ?? []).map(deserializeSource);
  const board = f.board as BoardSettings;
  const fallback = importedBoard(sculpture);
  const snapshot: DesignSnapshot = {
    startingPoint,
    base,
    reference,
    referenceLabel: typeof f.reference?.label === 'string' ? f.reference.label : startingPoint === 'neutral' ? 'Neutral pattern' : 'Current sculpture',
    sources,
    phase: num(f.waves?.phase ?? 0),
    board: {
      width: num(board?.width ?? fallback.width),
      height: num(board?.height ?? fallback.height),
      centerX: num(board?.centerX ?? fallback.centerX),
      centerY: num(board?.centerY ?? fallback.centerY),
      thickness: num(board?.thickness ?? fallback.thickness),
      topZ: num(board?.topZ ?? fallback.topZ),
      border: num(board?.border ?? fallback.border),
      origin: board?.origin === 'fitted' ? 'fitted' : 'imported',
    },
    kept: (f.kept ?? []).map((k) => ({
      id: String(k.id),
      at: String(k.at),
      label: String(k.label),
      sources: k.sources.map(deserializeSource),
      phase: num(k.phase),
      baseBefore: fromTriples(k.baseBefore, sculpture.count, 'kept.baseBefore'),
    })),
  };
  let mismatch = 0;
  if (f.pose?.tips) {
    const stored = fromTriples(f.pose.tips, sculpture.count, 'pose.tips');
    const rebuilt = poseTips(sculpture, snapshot);
    for (let j = 0; j < stored.length; j++) mismatch = Math.max(mismatch, Math.abs(stored[j] - rebuilt[j]));
  }
  return { name: typeof f.name === 'string' ? f.name : 'Imported design', snapshot, poseMismatchMm: mismatch };
}
