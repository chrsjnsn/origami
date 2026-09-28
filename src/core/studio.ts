/**
 * StudioModel: every user action on the design, with undo history. No DOM or WebGL, so the
 * whole editing workflow is exercised by the Node test suite; the UI is a thin layer on top.
 */

import { type BoardSettings, type Envelope, borderReport, fitBoard, importedBoard, presentationEnvelope } from './board';
import { applyBrush, type BrushSettings, EDIT_LIMITS, Stroke } from './brushes';
import {
  cloneSnapshot,
  type DesignSnapshot,
  History,
  initialSnapshot,
  poseOffsets,
  type StartingPoint,
  startingOffsets,
  wrapPhase,
} from './design';
import type { Sculpture } from './sculpture';
import { GridStencils } from './smoothing';
import { validateShells, type ValidationResult } from './validation';
import { defaultSource, hasActiveWaves, loopTurns, type WaveKind, type WaveSource } from './waves';

export type ChangeKind = 'pose' | 'sources' | 'board' | 'history' | 'meta';
export type RestoreTarget = 'reference' | 'original' | 'neutral';

export interface Pose {
  tips: Float64Array;
  offsets: Float64Array;
  outer: Float64Array;
  inner: Float64Array;
}

const STARTING_LABEL: Record<StartingPoint, string> = { current: 'Current sculpture', neutral: 'Neutral pattern' };

export class StudioModel {
  readonly grid: GridStencils;
  readonly history = new History();
  snap: DesignSnapshot;
  name = 'Untitled design';
  extendedRanges = false;
  restoreTarget: RestoreTarget = 'reference';
  /** Monotonic counter bumped on every change (UI polls/diffs it). */
  revision = 0;

  private pose: Pose;
  private poseDirty = true;
  private field: Float64Array;
  private listeners = new Set<(kinds: Set<ChangeKind>) => void>();
  private pending = new Set<ChangeKind>();
  private strokeBefore: DesignSnapshot | null = null;
  private strokeChanged = false;
  private stroke: Stroke | null = null;
  private idCounter = 0;

  constructor(readonly sculpture: Sculpture) {
    this.grid = new GridStencils(sculpture.cols, sculpture.rows);
    this.snap = initialSnapshot(sculpture);
    const n = sculpture.count;
    this.field = new Float64Array(n * 3);
    this.pose = {
      tips: new Float64Array(n * 3),
      offsets: new Float64Array(n * 3),
      outer: new Float64Array(n * 12),
      inner: new Float64Array(n * 12),
    };
  }

  /* ---------------------------------------------------------------- derived state ---- */

  getPose(): Pose {
    if (this.poseDirty) {
      const { sculpture, pose } = this;
      poseOffsets(sculpture, this.snap, pose.offsets, this.field);
      sculpture.tipsFromOffsets(pose.offsets, pose.tips);
      sculpture.shellVertices(pose.tips, pose.outer, pose.inner);
      this.poseDirty = false;
    }
    return this.pose;
  }

  /** Shell vertices for the imported original (used for before/after comparison). */
  originalShells(): { outer: Float64Array; inner: Float64Array } {
    const tips = this.sculpture.tipsFromOffsets(this.sculpture.originalOffsets);
    return this.sculpture.shellVertices(tips);
  }

  validate(subset?: Iterable<number>): ValidationResult {
    const p = this.getPose();
    return validateShells(this.sculpture, p.outer, p.inner, { subset });
  }

  envelope(): Envelope {
    const p = this.getPose();
    return presentationEnvelope(this.sculpture, p.outer, p.inner);
  }

  border() {
    return borderReport(this.snap.board, this.envelope());
  }

  get limits() {
    return this.extendedRanges ? EDIT_LIMITS.extended : EDIT_LIMITS.normal;
  }

  get wavesActive(): boolean {
    return hasActiveWaves(this.snap.sources);
  }

  get loopTurns(): number {
    return loopTurns(this.snap.sources);
  }

  /** True when the pose differs from the imported sculpture. */
  isModified(): boolean {
    const p = this.getPose();
    const o = this.sculpture.originalOffsets;
    for (let j = 0; j < o.length; j++) if (Math.abs(p.offsets[j] - o[j]) > 1e-9) return true;
    return false;
  }

  /* ---------------------------------------------------------------- change plumbing ---- */

  onChange(fn: (kinds: Set<ChangeKind>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(...kinds: ChangeKind[]): void {
    if (kinds.includes('pose')) this.poseDirty = true;
    kinds.forEach((k) => this.pending.add(k));
    this.revision++;
    const set = new Set(this.pending);
    this.pending.clear();
    this.listeners.forEach((fn) => fn(set));
  }

  private record(label: string, key: string | null = null): void {
    this.history.record(label, this.snap, key);
  }

  private nextId(prefix: string): string {
    this.idCounter++;
    return `${prefix}-${Date.now().toString(36)}-${this.idCounter}`;
  }

  /* ---------------------------------------------------------------- starting point ---- */

  setStartingPoint(sp: StartingPoint): void {
    if (sp === this.snap.startingPoint && this.baseEquals(startingOffsets(this.sculpture, sp))) return;
    this.record(`Start from ${STARTING_LABEL[sp]}`);
    this.snap.startingPoint = sp;
    this.snap.base = startingOffsets(this.sculpture, sp);
    this.snap.reference = startingOffsets(this.sculpture, sp);
    this.snap.referenceLabel = STARTING_LABEL[sp];
    this.changed('pose', 'history', 'meta');
  }

  /** Reset to the chosen starting point: no waves, no brush edits, imported board. */
  resetToStart(): void {
    this.record('Reset');
    const sp = this.snap.startingPoint;
    this.snap.base = startingOffsets(this.sculpture, sp);
    this.snap.reference = startingOffsets(this.sculpture, sp);
    this.snap.referenceLabel = STARTING_LABEL[sp];
    this.snap.sources = this.snap.sources.map((s) => ({ ...s, height: 0, lean: 0 }));
    this.snap.phase = 0;
    this.snap.board = importedBoard(this.sculpture);
    this.changed('pose', 'sources', 'board', 'history', 'meta');
  }

  private baseEquals(o: Float64Array): boolean {
    for (let j = 0; j < o.length; j++) if (this.snap.base[j] !== o[j]) return false;
    return true;
  }

  /* ---------------------------------------------------------------- wave sources ---- */

  addSource(kind: WaveKind, x?: number, y?: number): WaveSource {
    const b = this.snap.board;
    const src = defaultSource(this.nextId('src'), kind, x ?? b.centerX, y ?? b.centerY);
    this.record(kind === 'ripple' ? 'Add ripple' : 'Add traveling wave');
    this.snap.sources = [...this.snap.sources, src];
    this.changed('sources', 'pose', 'history');
    return src;
  }

  /** Ensure there is one source to work with, without adding any influence. */
  ensureSource(): WaveSource {
    if (this.snap.sources.length) return this.snap.sources[0];
    const b = this.snap.board;
    const src = defaultSource(this.nextId('src'), 'ripple', b.centerX, b.centerY);
    // Zero height and lean: the pose is unchanged, so this is not an undo step.
    this.snap.sources = [src];
    this.changed('sources', 'pose');
    return src;
  }

  updateSource(id: string, patch: Partial<WaveSource>, coalesceKey?: string): void {
    const i = this.snap.sources.findIndex((s) => s.id === id);
    if (i < 0) return;
    const cur = this.snap.sources[i];
    const next = { ...cur, ...patch };
    if (Object.keys(patch).every((k) => (cur as any)[k] === (next as any)[k])) return;
    this.record('Change wave settings', coalesceKey ?? `src:${id}:${Object.keys(patch).join(',')}`);
    const list = this.snap.sources.slice();
    list[i] = next;
    this.snap.sources = list;
    this.changed('sources', 'pose', 'history');
  }

  removeSource(id: string): void {
    if (!this.snap.sources.some((s) => s.id === id)) return;
    this.record('Remove wave source');
    this.snap.sources = this.snap.sources.filter((s) => s.id !== id);
    this.changed('sources', 'pose', 'history');
  }

  /** Phase changes (playback, scrubbing) are not undo steps; they are saved with the design. */
  setPhase(phase: number): void {
    const p = wrapPhase(phase, this.snap.sources);
    if (p === this.snap.phase) return;
    this.snap.phase = p;
    if (this.wavesActive) this.changed('pose');
    else this.changed('meta');
  }

  /**
   * Commit the current pose (base + waves at the current phase) as the new editable base.
   * The generating settings move into the kept-shape history so the user can return to them.
   */
  keepShape(): boolean {
    if (!this.wavesActive) return false;
    this.record('Keep this shape');
    const pose = this.getPose();
    const active = this.snap.sources.filter((s) => s.enabled && (s.height !== 0 || s.lean !== 0));
    const label = `${active.length} wave source${active.length === 1 ? '' : 's'} at ${Math.round(
      ((this.snap.phase / (2 * Math.PI * this.loopTurns)) % 1) * 100,
    )}% of the cycle`;
    this.snap.kept = [
      ...this.snap.kept,
      {
        id: this.nextId('kept'),
        at: new Date().toISOString(),
        label,
        sources: this.snap.sources.map((s) => ({ ...s })),
        phase: this.snap.phase,
        baseBefore: this.snap.base.slice(),
      },
    ];
    // Base is edited in place by brushes; the reference must be a separate, immutable copy.
    this.snap.base = pose.offsets.slice();
    this.snap.reference = pose.offsets.slice();
    this.snap.referenceLabel = 'Last kept shape';
    // Keep the source handles for further use, but with zero influence so the pose is exact.
    this.snap.sources = this.snap.sources.map((s) => ({ ...s, height: 0, lean: 0 }));
    this.changed('pose', 'sources', 'history', 'meta');
    return true;
  }

  /** Bring back the base and wave settings that generated a kept shape. */
  returnToKept(id: string): void {
    const k = this.snap.kept.find((e) => e.id === id);
    if (!k) return;
    this.record('Return to kept settings');
    this.snap.base = k.baseBefore.slice();
    this.snap.sources = k.sources.map((s) => ({ ...s }));
    this.snap.phase = k.phase;
    this.changed('pose', 'sources', 'history', 'meta');
  }

  /* ---------------------------------------------------------------- brushes ---- */

  restoreOffsets(): Float64Array {
    switch (this.restoreTarget) {
      case 'original':
        return this.sculpture.originalOffsets;
      case 'neutral':
        return this.sculpture.neutralOffsets;
      default:
        return this.snap.reference;
    }
  }

  beginStroke(brush: BrushSettings, x: number, y: number, t: number): void {
    this.cancelStroke();
    this.strokeBefore = cloneSnapshot(this.snap);
    this.strokeChanged = false;
    const ctx = {
      sculpture: this.sculpture,
      grid: this.grid,
      offsets: this.snap.base,
      restoreTarget: this.restoreOffsets(),
      limits: this.limits,
    };
    this.stroke = new Stroke((px, py, dt) => {
      applyBrush(ctx, brush, px, py, dt);
      this.strokeChanged = true;
    });
    this.stroke.begin(x, y, t);
    this.changed('pose');
  }

  strokeTo(x: number, y: number, t: number): void {
    if (!this.stroke) return;
    this.stroke.move(x, y, t);
    this.changed('pose');
  }

  /** One continuous stroke = one undo step. */
  endStroke(label = 'Brush stroke'): void {
    if (!this.stroke || !this.strokeBefore) return;
    this.stroke.end();
    if (this.strokeChanged) {
      this.history.record(label, this.strokeBefore);
      this.changed('history');
    }
    this.stroke = null;
    this.strokeBefore = null;
  }

  /** Abandon a stroke (for example when a second finger starts a camera gesture). */
  cancelStroke(): void {
    if (!this.stroke || !this.strokeBefore) return;
    this.snap = this.strokeBefore;
    this.stroke = null;
    this.strokeBefore = null;
    this.changed('pose');
  }

  get stroking(): boolean {
    return this.stroke !== null;
  }

  /* ---------------------------------------------------------------- board ---- */

  fitBoard(): BoardSettings {
    this.record('Fit board with 2-inch border');
    this.snap.board = fitBoard(this.snap.board, this.envelope());
    this.changed('board', 'history');
    return this.snap.board;
  }

  /* ---------------------------------------------------------------- history & files ---- */

  undo(): string | null {
    this.cancelStroke();
    const e = this.history.undo(this.snap);
    if (!e) return null;
    this.snap = e.snapshot;
    this.changed('pose', 'sources', 'board', 'history', 'meta');
    return e.label;
  }

  redo(): string | null {
    this.cancelStroke();
    const e = this.history.redo(this.snap);
    if (!e) return null;
    this.snap = e.snapshot;
    this.changed('pose', 'sources', 'board', 'history', 'meta');
    return e.label;
  }

  /** Replace the whole design (load). Undoable. */
  load(snapshot: DesignSnapshot, name: string): void {
    this.cancelStroke();
    this.record('Load design');
    this.snap = cloneSnapshot(snapshot);
    this.name = name;
    this.changed('pose', 'sources', 'board', 'history', 'meta');
  }

  rename(name: string): void {
    this.name = name;
    this.changed('meta');
  }

  touch(kind: ChangeKind): void {
    this.changed(kind);
  }
}
