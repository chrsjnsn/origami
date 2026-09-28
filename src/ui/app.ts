/**
 * App controller: connects the StudioModel (authoritative design state) to the viewer,
 * overlays and page UI. The model never depends on anything here.
 */

import { type BorderReport, type Envelope } from '../core/board';
import { type BrushKind, type BrushSettings, BRUSH_RANGE, brushMmPerSecond, defaultBrush, type SmoothAxis } from '../core/brushes';
import { deserializeDesign, serializeDesign, type ValidationSummary } from '../core/design';
import { buildDesignGlb } from '../core/exportGeometry';
import { FLOATS_PER_SHELL, writeThickShell } from '../core/solidify';
import type { ChangeKind, RestoreTarget, StudioModel } from '../core/studio';
import type { ValidationResult } from '../core/validation';
import { WAVE_LIMITS, type WaveSource } from '../core/waves';
import { readAccessor, readGlb } from '../core/glb';
import { Overlays } from '../render/overlays';
import type { ViewName, Viewer } from '../render/viewer';
import { $, $$, confirmDialog, h, isTyping, paintRange, setPressed, setSegmented, toast } from './dom';
import * as store from './storage';
import { zip } from './zip';

export type Tool = 'navigate' | 'waves' | BrushKind;
const BRUSH_TOOLS: BrushKind[] = ['height', 'leanX', 'leanY', 'smooth', 'restore'];
const isBrush = (t: Tool): t is BrushKind => (BRUSH_TOOLS as string[]).includes(t);

const BRUSH_TEXT: Record<BrushKind, { title: string; desc: string; plus: string; minus: string; label: [string, string] }> = {
  height: { title: 'Height brush', desc: 'Raises tips toward you or lowers them toward the board. Changes height (Z) only.', plus: 'Raise +Z', minus: 'Lower −Z', label: ['Raise · toward you (+Z)', 'Lower · toward the board (−Z)'] },
  leanX: { title: 'X lean brush', desc: 'Leans tips right or left across the board. Changes X only.', plus: 'Right +X', minus: 'Left −X', label: ['Lean right (+X)', 'Lean left (−X)'] },
  leanY: { title: 'Y lean brush', desc: 'Leans tips up or down the board. Changes Y only.', plus: 'Up +Y', minus: 'Down −Y', label: ['Lean up (+Y)', 'Lean down (−Y)'] },
  smooth: { title: 'Smooth brush', desc: 'Softens abrupt steps between neighbors while keeping broad crests and troughs. Only pieces under the brush move.', plus: '', minus: '', label: ['Smooth', 'Smooth'] },
  restore: { title: 'Restore brush', desc: 'Blends the painted area back toward a baseline you choose.', plus: '', minus: '', label: ['Restore', 'Restore'] },
};

interface Drag {
  pointerId: number;
  id: string;
  part: 'center' | 'direction';
}

export class App {
  mode: 'view' | 'customize' = 'view';
  tool: Tool = 'waves';
  selectedSource: string | null = null;
  readonly brushes: Record<BrushKind, BrushSettings> = {
    height: defaultBrush('height'),
    leanX: defaultBrush('leanX'),
    leanY: defaultBrush('leanY'),
    smooth: { ...defaultBrush('smooth'), strength: 4 },
    restore: { ...defaultBrush('restore'), strength: 4 },
  };
  playing = false;
  /** Seconds per wave cycle at speed 1x. */
  tempo = 8;
  showing: 'design' | 'original' = 'design';
  comparing = false;
  validation: ValidationResult | null = null;
  border: BorderReport | null = null;
  envelope: Envelope | null = null;

  private readonly overlays: Overlays;
  private readonly coarse = matchMedia('(pointer: coarse)').matches;
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: Drag | null = null;
  private strokePointer: number | null = null;
  private strokeLast = { x: 0, y: 0 };
  private tap: { pointerId: number; x: number; y: number; t: number } | null = null;
  private hover: { x: number; y: number } | null = null;
  private spaceHeld = false;
  private altHeld = false;
  private pending = new Set<ChangeKind>();
  private validationTimer = 0;
  private lastValidation = 0;
  private draftTimer = 0;
  private hintTimer = 0;
  private savedId: string | null = null;
  private lastCamera = '';

  constructor(private readonly model: StudioModel, private readonly viewer: Viewer) {
    this.overlays = new Overlays(viewer, model.sculpture);
    this.overlays.setVisible(false);
    model.name = 'My version';
    model.onChange((kinds) => kinds.forEach((k) => this.pending.add(k)));
    viewer.onFrame((t, dt) => this.tick(t, dt));
    this.bindHero();
    this.bindToolstrip();
    this.bindPanels();
    this.bindPointer();
    this.bindKeys();
    this.pending = new Set(['pose', 'sources', 'board', 'history', 'meta']);
    this.sync();
    this.renderDesignList();
    this.checkDraft();
    this.setInteraction();
    this.updateInsets();
    this.viewer.goTo('front', false);
    new ResizeObserver(() => this.updateInsets()).observe($('#viewer'));
    this.showHint(this.coarse ? 'Swipe sideways to turn · Pinch to zoom' : 'Drag to orbit · Scroll to zoom · Right-drag to pan', 5000);
  }

  /* ================================================================ frame loop & sync */

  private tick(t: number, dt: number): void {
    if (this.playing && this.model.wavesActive) {
      this.model.setPhase(this.model.snap.phase + (dt * 2 * Math.PI) / this.tempo);
    }
    if (this.model.stroking && this.strokePointer !== null) {
      this.model.strokeTo(this.strokeLast.x, this.strokeLast.y, t / 1000);
    }
    const cam = this.viewer.camera;
    const key = `${cam.position.x.toFixed(1)},${cam.position.y.toFixed(1)},${cam.position.z.toFixed(1)},${cam.quaternion.x.toFixed(4)},${this.viewer.renderer.domElement.clientHeight}`;
    if (key !== this.lastCamera) {
      this.lastCamera = key;
      this.overlays.updateScale();
      this.updateBrushCursor();
    }
    if (this.pending.size) this.sync();
  }

  private sync(): void {
    const kinds = this.pending;
    this.pending = new Set();
    const m = this.model;
    if (kinds.has('pose')) {
      this.pushShells();
      this.scheduleValidation();
      this.scheduleDraft();
    }
    if (kinds.has('sources') || kinds.has('pose') || kinds.has('meta')) {
      if (this.selectedSource && !m.snap.sources.some((s) => s.id === this.selectedSource)) this.selectedSource = null;
      if (!this.selectedSource && m.snap.sources.length) this.selectedSource = m.snap.sources[0].id;
      this.overlays.setSources(m.snap.sources, this.selectedSource, m.snap.phase, m.snap.board);
      this.updatePlayback();
    }
    if (kinds.has('sources') || kinds.has('history') || kinds.has('meta')) this.renderSourcePanel();
    if (kinds.has('board')) {
      this.viewer.setBoard(m.snap.board);
      this.scheduleValidation();
      this.renderStats();
    }
    if (kinds.has('history') || kinds.has('meta')) {
      this.renderHistory();
      this.renderStartingPoint();
      this.renderKept();
      this.renderBrushPanel();
      this.scheduleDraft();
    }
    this.renderDesignToggle();
  }

  private pushShells(): void {
    if (this.comparing || (this.mode === 'view' && this.showing === 'original')) {
      const o = this.model.originalShells();
      this.viewer.setShells(o.outer, o.inner);
    } else {
      const p = this.model.getPose();
      this.viewer.setShells(p.outer, p.inner);
    }
  }

  /* ================================================================ validation */

  private scheduleValidation(): void {
    clearTimeout(this.validationTimer);
    const busy = this.playing || this.model.stroking || this.drag !== null;
    const since = performance.now() - this.lastValidation;
    const delay = busy ? Math.max(0, 350 - since) : 140;
    this.validationTimer = window.setTimeout(() => this.runValidation(), delay);
  }

  runValidation(): ValidationResult {
    this.lastValidation = performance.now();
    const r = this.model.validate();
    this.validation = r;
    this.envelope = this.model.envelope();
    this.border = this.model.border();
    this.renderValidation();
    this.renderBoard();
    const pose = this.model.getPose();
    this.overlays.setFlags(this.mode === 'customize' ? r.flagged : new Map(), pose.outer);
    if (this.mode === 'customize') this.overlays.setBoardGuides(this.model.snap.board, this.envelope, this.border);
    return r;
  }

  private summary(r: ValidationResult): ValidationSummary {
    const ids = this.model.sculpture.ids;
    const errors = r.issues.filter((i) => i.severity === 'error').length;
    const warnings = r.issues.filter((i) => i.severity === 'warning').length;
    return {
      checkedAt: new Date().toISOString(),
      passed: errors === 0,
      errors,
      warnings,
      issues: r.issues.map((i) => ({ code: i.code, severity: i.severity, pieces: i.pieces.map((p) => ids[p]), message: i.message })),
      note: 'Checks design surfaces only (fixed bases, exact 75% inner shells, tip height, face shape, neighbor crossings). Not a fabrication test.',
    };
  }

  /** Complete check before saving or exporting. Resolves false if the user cancels. */
  private async checkBeforeExport(action: string): Promise<ValidationSummary | null> {
    const r = this.runValidation();
    const s = this.summary(r);
    const border = this.border;
    const problems = [...r.issues.filter((i) => i.severity === 'error').map((i) => `• ${i.message}`)];
    if (border && border.status === 'exceeds') problems.push(`• ${border.message}`);
    if (!problems.length) return s;
    const go = await confirmDialog(
      'This design has geometry problems',
      `${problems.join('\n')}\n\nYou can still ${action}; the file records that it did not pass the check.`,
      `${action[0].toUpperCase()}${action.slice(1)} anyway`,
    );
    return go ? s : null;
  }

  /* ================================================================ hero & mode */

  private bindHero(): void {
    for (const b of $$<HTMLButtonElement>('[data-view]')) {
      b.addEventListener('click', () => {
        const v = b.dataset.view!;
        if (v === 'reset') this.viewer.resetView();
        else this.viewer.goTo(v as ViewName);
        setPressed($$('[data-view]'), (x) => x.dataset.view === v && v !== 'reset');
      });
    }
    for (const b of $$('[data-action="customize"]')) {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        this.enterCustomize();
      });
    }
    for (const b of $$('[data-action="done"]')) b.addEventListener('click', () => this.exitCustomize());
    for (const b of $$<HTMLButtonElement>('#design-toggle button')) {
      b.addEventListener('click', () => {
        this.showing = b.dataset.show === 'original' ? 'original' : 'design';
        this.pushShells();
        this.renderDesignToggle();
      });
    }
    const header = document.querySelector('.site-header')!;
    const onScroll = () => header.classList.toggle('solid', window.scrollY > 24);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  enterCustomize(): void {
    if (this.mode === 'customize') {
      $('#studio').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    this.mode = 'customize';
    this.showing = 'design';
    document.body.classList.add('is-customizing');
    $('#toolstrip').hidden = false;
    $('#studio-grid').hidden = false;
    $('#studio-intro').hidden = true;
    this.overlays.setVisible(true);
    this.viewer.showGizmo = true;
    if (this.tool === 'waves') this.model.ensureSource();
    this.setTool(this.tool);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    this.updateInsets();
    this.viewer.goTo('front');
    setPressed($$('[data-view]'), (x) => x.dataset.view === 'front');
    this.pending.add('pose').add('sources').add('board').add('history');
    this.runValidation();
  }

  exitCustomize(): void {
    if (this.mode === 'view') return;
    this.model.cancelStroke();
    this.mode = 'view';
    document.body.classList.remove('is-customizing');
    $('#toolstrip').hidden = true;
    $('#studio-grid').hidden = true;
    $('#studio-intro').hidden = false;
    this.overlays.setVisible(false);
    this.overlays.setBrush(null);
    this.viewer.showGizmo = false;
    $('#brush-label').hidden = true;
    this.setInteraction();
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    requestAnimationFrame(() => {
      this.updateInsets();
      this.viewer.goTo('front');
    });
    this.pending.add('pose');
  }

  /** Tell the viewer how much of it is covered by page UI so framing avoids the text. */
  private updateInsets(): void {
    const v = $('#viewer').getBoundingClientRect();
    if (this.mode === 'customize') {
      this.viewer.viewInsets = { top: 52, bottom: 10 };
      return;
    }
    const cap = $('#caption').getBoundingClientRect();
    const views = $('.hud-views').getBoundingClientRect();
    const cta = $('.hud-customize').getBoundingClientRect();
    // On narrow screens the Customize button sits above the view pills.
    const stacked = cta.bottom <= views.top + 1;
    this.viewer.viewInsets = {
      top: Math.max(0, cap.bottom - v.top + 12),
      bottom: Math.max(0, v.bottom - (stacked ? cta.top : views.top) + 12),
    };
  }

  private renderDesignToggle(): void {
    const modified = this.model.isModified();
    const toggle = $('#design-toggle');
    toggle.hidden = this.mode !== 'view' || !modified;
    if (!modified) this.showing = 'design';
    setPressed($$('#design-toggle button'), (b) => b.dataset.show === this.showing);
    $('#compare-badge').hidden = !this.comparing;
  }

  private renderStats(): void {
    const b = this.model.snap.board;
    $('#stat-board').innerHTML = `${Math.round(b.width)} × ${Math.round(b.height)} <small>mm</small>`;
    $('#caption-meta').textContent = `522 folded pyramids · ${Math.round(b.width)} × ${Math.round(b.height)} mm`;
    const st = this.model.sculpture.data.stats.tipHeightMm;
    $('#stat-heights').innerHTML = `${Math.round(st.min)}–${Math.round(st.max)} <small>mm</small>`;
  }

  private showHint(text: string, ms = 4000): void {
    const el = $('#hint');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => el.classList.remove('show'), ms);
  }

  /* ================================================================ tools & interaction */

  setTool(tool: Tool): void {
    this.model.cancelStroke();
    this.tool = tool;
    setPressed($$('[data-tool]'), (b) => b.dataset.tool === tool);
    for (const pane of $$('[data-pane]')) {
      const p = pane.dataset.pane;
      pane.hidden = !(p === tool || (p === 'brush' && isBrush(tool)));
    }
    if (tool === 'waves') this.model.ensureSource();
    this.overlays.guidesVisible = tool === 'waves' ? ($('#show-guides') as HTMLInputElement).checked : false;
    this.overlays.handlesVisible = tool === 'waves';
    this.pending.add('sources');
    this.renderBrushPanel();
    this.setInteraction();
    this.updateBrushCursor();
    if (this.mode === 'customize') {
      if (tool === 'waves') this.showHint(this.coarse ? 'Drag a handle to move it · Tap the board to place the selected source' : 'Drag a handle to move it · Click the board to place the selected source');
      else if (isBrush(tool)) this.showHint(this.coarse ? 'Paint with one finger · Use two fingers to turn and zoom' : 'Paint with the left button · Right-drag to orbit · Hold Space to move the view · Hold ⌥ to reverse');
      else this.showHint('Drag to orbit · Scroll to zoom · Right-drag to pan');
    }
  }

  private setInteraction(): void {
    const canvas = this.viewer.renderer.domElement;
    if (this.mode === 'view' || this.tool === 'navigate' || this.spaceHeld) {
      this.viewer.setInteraction('view');
    } else if (isBrush(this.tool)) {
      this.viewer.setInteraction('paint');
    } else {
      this.viewer.setInteraction('handles');
    }
    // On touch screens in view mode, vertical swipes scroll the page; sideways swipes turn the artwork.
    canvas.style.touchAction = this.mode === 'view' && this.coarse ? 'pan-y' : 'none';
  }

  private currentBrush(): BrushSettings | null {
    if (!isBrush(this.tool)) return null;
    const b = this.brushes[this.tool];
    return this.altHeld && (b.kind === 'height' || b.kind === 'leanX' || b.kind === 'leanY') ? { ...b, sign: (b.sign * -1) as 1 | -1 } : b;
  }

  private updateBrushCursor(): void {
    const b = this.currentBrush();
    const label = $('#brush-label');
    if (this.mode !== 'customize' || !b || this.spaceHeld || (!this.hover && !this.model.stroking)) {
      this.overlays.setBrush(null);
      label.hidden = true;
      return;
    }
    const at = this.model.stroking ? this.strokeLast : this.hoverBoard();
    if (!at) {
      this.overlays.setBrush(null);
      label.hidden = true;
      return;
    }
    this.overlays.setBrush({ x: at.x, y: at.y, radius: b.radius, kind: b.kind, sign: b.sign, axis: b.smoothAxis, active: this.model.stroking });
    if (this.hover && !this.coarse) {
      label.hidden = false;
      label.style.left = `${this.hover.x}px`;
      label.style.top = `${this.hover.y}px`;
      label.textContent = b.kind === 'smooth' ? `Smooth · ${({ all: 'all axes', z: 'height', x: 'X lean', y: 'Y lean' } as const)[b.smoothAxis]}` : BRUSH_TEXT[b.kind].label[b.sign > 0 ? 0 : 1];
    }
  }

  private hoverBoard(): { x: number; y: number } | null {
    if (!this.hover) return null;
    return this.viewer.boardPoint(this.hover.x, this.hover.y);
  }

  private onBoard(p: { x: number; y: number }, margin = 0): boolean {
    const b = this.model.snap.board;
    return Math.abs(p.x - b.centerX) <= b.width / 2 + margin && Math.abs(p.y - b.centerY) <= b.height / 2 + margin;
  }

  private bindPointer(): void {
    const container = $('#viewer');
    const canvas = this.viewer.renderer.domElement;
    const capture = (id: number) => {
      try {
        canvas.setPointerCapture(id);
      } catch {
        /* pointer already gone */
      }
    };

    container.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target !== canvas) return;
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.mode !== 'customize') return;
        if (this.pointers.size >= 2) {
          // A second finger means a camera gesture: abandon the stroke or drag.
          if (this.model.stroking) this.model.cancelStroke();
          this.strokePointer = null;
          this.endDrag();
          this.tap = null;
          return;
        }
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (this.spaceHeld || this.tool === 'navigate') return;
        if (this.tool === 'waves') {
          const hit = this.overlays.handleAt(e.clientX, e.clientY);
          if (hit) {
            this.drag = { pointerId: e.pointerId, id: hit.id, part: hit.part };
            this.selectSource(hit.id);
            this.viewer.controls.enabled = false;
            capture(e.pointerId);
            canvas.classList.add('grabbing');
            e.preventDefault();
          } else {
            this.tap = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
          }
          return;
        }
        const brush = this.currentBrush();
        const p = this.viewer.boardPoint(e.clientX, e.clientY);
        if (!brush || !p || !this.onBoard(p, brush.radius)) return;
        this.strokePointer = e.pointerId;
        this.strokeLast = p;
        this.hover = { x: e.clientX, y: e.clientY };
        this.model.beginStroke({ ...brush }, p.x, p.y, e.timeStamp / 1000);
        capture(e.pointerId);
        e.preventDefault();
        this.updateBrushCursor();
      },
      { capture: true },
    );

    container.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (e.target === canvas && e.pointerType !== 'touch') this.hover = { x: e.clientX, y: e.clientY };
      if (this.tap && this.tap.pointerId === e.pointerId && Math.hypot(e.clientX - this.tap.x, e.clientY - this.tap.y) > 6) this.tap = null;
      if (this.drag && this.drag.pointerId === e.pointerId) {
        const p = this.viewer.boardPoint(e.clientX, e.clientY);
        const s = this.model.snap.sources.find((x) => x.id === this.drag!.id);
        if (p && s) {
          if (this.drag.part === 'center') {
            const b = this.model.snap.board;
            const x = Math.min(b.centerX + b.width / 2 + 300, Math.max(b.centerX - b.width / 2 - 300, p.x));
            const y = Math.min(b.centerY + b.height / 2 + 300, Math.max(b.centerY - b.height / 2 - 300, p.y));
            this.model.updateSource(s.id, { x, y }, `drag:${s.id}`);
          } else {
            const deg = ((Math.atan2(p.y - s.y, p.x - s.x) * 180) / Math.PI + 360) % 360;
            this.model.updateSource(s.id, { direction: Math.round(deg) }, `dragdir:${s.id}`);
          }
        }
        return;
      }
      if (this.strokePointer === e.pointerId && this.model.stroking) {
        const p = this.viewer.boardPoint(e.clientX, e.clientY);
        if (p) {
          const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
          for (const ce of events.length ? events : [e]) {
            const q = this.viewer.boardPoint(ce.clientX, ce.clientY);
            if (q) this.model.strokeTo(q.x, q.y, ce.timeStamp / 1000);
          }
          this.strokeLast = p;
        }
      }
      if (this.mode === 'customize') {
        if (this.tool === 'waves' && !this.drag) canvas.classList.toggle('grab', !!this.overlays.handleAt(e.clientX, e.clientY));
        this.updateBrushCursor();
      }
    });

    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.drag && this.drag.pointerId === e.pointerId) this.endDrag();
      if (this.strokePointer === e.pointerId) {
        this.strokePointer = null;
        if (e.type === 'pointercancel') this.model.cancelStroke();
        else this.model.endStroke(isBrush(this.tool) ? BRUSH_TEXT[this.tool].title.replace(' brush', ' stroke') : 'Brush stroke');
        if (e.pointerType === 'touch') this.hover = null;
        this.updateBrushCursor();
      }
      if (this.tap && this.tap.pointerId === e.pointerId) {
        const tap = this.tap;
        this.tap = null;
        if (e.type === 'pointerup' && performance.now() - tap.t < 600) this.placeSource(e.clientX, e.clientY);
      }
    };
    container.addEventListener('pointerup', end);
    container.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => {
      if (!this.model.stroking) {
        this.hover = null;
        this.updateBrushCursor();
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.viewer.controls.enabled = true;
    this.model.history.breakCoalescing();
    this.viewer.renderer.domElement.classList.remove('grabbing');
    this.scheduleValidation();
  }

  private placeSource(clientX: number, clientY: number): void {
    const p = this.viewer.boardPoint(clientX, clientY);
    if (!p || !this.onBoard(p)) return;
    const sel = this.model.snap.sources.find((s) => s.id === this.selectedSource);
    if (sel) {
      this.model.updateSource(sel.id, { x: p.x, y: p.y }, `place:${Date.now()}`);
      this.model.history.breakCoalescing();
    } else {
      this.selectSource(this.model.addSource('ripple', p.x, p.y).id);
    }
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
        return;
      }
      if (mod) return;
      if (e.key === 'Alt') {
        this.altHeld = true;
        this.updateBrushCursor();
      }
      if (e.key === ' ' && this.mode === 'customize') {
        e.preventDefault();
        if (!this.spaceHeld) {
          this.spaceHeld = true;
          this.setInteraction();
          this.updateBrushCursor();
        }
        return;
      }
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (['1', '2', '3'].includes(k)) this.viewer.goTo((['front', 'angled', 'detail'] as ViewName[])[Number(k) - 1]);
      else if (k === '0') this.viewer.resetView();
      if (this.mode !== 'customize') return;
      const tools: Record<string, Tool> = { v: 'navigate', w: 'waves', h: 'height', x: 'leanX', y: 'leanY', s: 'smooth', r: 'restore' };
      if (tools[k]) this.setTool(tools[k]);
      else if (k === 'p') this.togglePlay();
      else if (k === 'k') this.keepShape();
      else if (k === 'c') this.setComparing(true);
      else if (k === 'escape') {
        if (this.model.stroking) this.model.cancelStroke();
        else this.exitCustomize();
      } else if ((k === '[' || k === ']') && isBrush(this.tool)) {
        const b = this.brushes[this.tool];
        b.radius = Math.min(BRUSH_RANGE.radius.max, Math.max(BRUSH_RANGE.radius.min, Math.round(b.radius * (k === ']' ? 1.15 : 1 / 1.15))));
        this.renderBrushPanel();
        this.updateBrushCursor();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Alt') {
        this.altHeld = false;
        this.updateBrushCursor();
      }
      if (e.key === ' ') {
        this.spaceHeld = false;
        this.setInteraction();
        this.updateBrushCursor();
      }
      if (e.key.toLowerCase() === 'c') this.setComparing(false);
    });
    window.addEventListener('blur', () => {
      this.spaceHeld = false;
      this.altHeld = false;
      this.setComparing(false);
      this.setInteraction();
    });
  }

  /* ================================================================ toolstrip */

  private bindToolstrip(): void {
    for (const b of $$<HTMLButtonElement>('[data-tool]')) b.addEventListener('click', () => this.setTool(b.dataset.tool as Tool));
    $('#play').addEventListener('click', () => this.togglePlay());
    $('#keep').addEventListener('click', () => this.keepShape());
    $('#undo').addEventListener('click', () => this.undo());
    $('#redo').addEventListener('click', () => this.redo());
    const phase = $<HTMLInputElement>('#phase');
    phase.addEventListener('input', () => {
      this.setPlaying(false);
      const period = 2 * Math.PI * this.model.loopTurns;
      this.model.setPhase((Number(phase.value) / 1000) * period);
    });
    const cmp = $('#compare');
    cmp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.setComparing(true);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) cmp.addEventListener(ev, () => this.setComparing(false));
    cmp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') this.setComparing(true);
    });
    cmp.addEventListener('keyup', () => this.setComparing(false));
    $('#status-pill').addEventListener('click', () => $('#panel-check').scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }

  setComparing(on: boolean): void {
    if (this.comparing === on) return;
    this.comparing = on;
    $('#compare').classList.toggle('active', on);
    this.overlays.setVisible(!on && this.mode === 'customize');
    this.pushShells();
    this.renderDesignToggle();
  }

  togglePlay(): void {
    this.setPlaying(!this.playing);
  }

  setPlaying(on: boolean): void {
    if (on && !this.model.wavesActive) {
      toast('Raise Height or Lean on a wave source first');
      return;
    }
    this.playing = on;
    this.updatePlayback();
    if (!on) this.scheduleValidation();
  }

  keepShape(): void {
    if (!this.model.wavesActive) {
      toast('There is no wave to keep yet');
      return;
    }
    this.setPlaying(false);
    this.model.keepShape();
    toast('Shape kept. Brushes now refine it.');
  }

  undo(): void {
    this.setPlaying(false);
    const label = this.model.undo();
    toast(label ? `Undid: ${label}` : 'Nothing to undo');
  }

  redo(): void {
    this.setPlaying(false);
    const label = this.model.redo();
    toast(label ? `Redid: ${label}` : 'Nothing to redo');
  }

  private updatePlayback(): void {
    const active = this.model.wavesActive;
    $('#playback').classList.toggle('inactive', !active);
    const play = $<HTMLButtonElement>('#play');
    play.classList.toggle('playing', this.playing);
    play.innerHTML = `<svg class="i"><use href="#i-${this.playing ? 'pause' : 'play'}"/></svg>`;
    play.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    ($('#keep') as HTMLButtonElement).disabled = !active;
    const period = 2 * Math.PI * this.model.loopTurns;
    const frac = (this.model.snap.phase % period) / period;
    const input = $<HTMLInputElement>('#phase');
    if (document.activeElement !== input || this.playing) input.value = String(Math.round(frac * 1000));
    paintRange(input);
    $('#phase-out').textContent = `${Math.round(frac * 100)}%`;
  }

  private renderHistory(): void {
    const hist = this.model.history;
    const u = $<HTMLButtonElement>('#undo'), r = $<HTMLButtonElement>('#redo');
    u.disabled = !hist.canUndo;
    r.disabled = !hist.canRedo;
    u.title = hist.undoLabel ? `Undo ${hist.undoLabel} (⌘Z)` : 'Undo (⌘Z)';
    r.title = hist.redoLabel ? `Redo ${hist.redoLabel} (⇧⌘Z)` : 'Redo (⇧⌘Z)';
  }

  /* ================================================================ panels */

  private bindPanels(): void {
    for (const label of $$<HTMLLabelElement>('.field.slider')) {
      const input = label.querySelector('input');
      const name = label.querySelector('.field-label')?.textContent;
      if (input && name) input.setAttribute('aria-label', name);
    }
    $('#phase').setAttribute('aria-label', 'Wave phase');
    $('#status-pill').setAttribute('aria-label', 'Geometry check status');
    // Wave sources.
    $('#add-ripple').addEventListener('click', () => this.selectSource(this.addSourceNear('ripple')));
    $('#add-travel').addEventListener('click', () => this.selectSource(this.addSourceNear('travel')));
    $('#src-kind').addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest('button')?.dataset.value;
      const s = this.selected();
      if (!s || !v || v === s.kind) return;
      this.model.updateSource(s.id, v === 'travel' ? { kind: 'travel', reach: Infinity, spacing: Math.max(s.spacing, 500) } : { kind: 'ripple', reach: 900 });
      this.model.history.breakCoalescing();
    });
    for (const label of $$<HTMLLabelElement>('#source-fields [data-field]')) {
      const field = label.dataset.field as keyof WaveSource;
      const input = $<HTMLInputElement>('input', label);
      input.addEventListener('input', () => {
        const s = this.selected();
        if (!s) return;
        this.model.updateSource(s.id, { [field]: Number(input.value) } as Partial<WaveSource>, `src:${s.id}:${field}`);
      });
      input.addEventListener('change', () => this.model.history.breakCoalescing());
    }
    $<HTMLInputElement>('#src-enabled').addEventListener('change', (e) => {
      const s = this.selected();
      if (s) this.model.updateSource(s.id, { enabled: (e.target as HTMLInputElement).checked }, `en:${Date.now()}`);
    });
    $<HTMLInputElement>('#src-whole').addEventListener('change', (e) => {
      const s = this.selected();
      if (s) this.model.updateSource(s.id, { reach: (e.target as HTMLInputElement).checked ? Infinity : 900 }, `whole:${Date.now()}`);
    });
    $('#src-remove').addEventListener('click', () => {
      const s = this.selected();
      if (s) this.model.removeSource(s.id);
    });
    const tempo = $<HTMLInputElement>('#tempo');
    tempo.addEventListener('input', () => {
      this.tempo = Number(tempo.value);
      $('#tempo-out').textContent = `${this.tempo} s`;
      paintRange(tempo);
    });
    paintRange(tempo);
    $<HTMLInputElement>('#show-guides').addEventListener('change', (e) => {
      this.overlays.guidesVisible = (e.target as HTMLInputElement).checked;
      this.pending.add('sources');
    });

    // Brushes.
    for (const label of $$<HTMLLabelElement>('[data-brush]')) {
      const key = label.dataset.brush as 'radius' | 'strength' | 'smoothness';
      const input = $<HTMLInputElement>('input', label);
      input.addEventListener('input', () => {
        if (!isBrush(this.tool)) return;
        this.brushes[this.tool][key] = Number(input.value);
        this.renderBrushPanel();
        this.updateBrushCursor();
      });
    }
    $('#brush-sign').addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest('button')?.dataset.value;
      if (!v || !isBrush(this.tool)) return;
      this.brushes[this.tool].sign = Number(v) > 0 ? 1 : -1;
      this.renderBrushPanel();
    });
    $('#smooth-axis').addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest('button')?.dataset.value as SmoothAxis | undefined;
      if (!v) return;
      this.brushes.smooth.smoothAxis = v;
      this.renderBrushPanel();
    });
    $('#restore-target').addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest('button')?.dataset.value as RestoreTarget | undefined;
      if (!v) return;
      this.model.restoreTarget = v;
      this.renderBrushPanel();
    });

    // Starting point.
    $('#starting-point').addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest('button')?.dataset.value;
      if (v !== 'current' && v !== 'neutral') return;
      this.setPlaying(false);
      this.model.setStartingPoint(v);
      toast(v === 'neutral' ? 'Starting from the neutral pattern. Undo to go back.' : 'Starting from the current sculpture.');
    });
    $('#reset-design').addEventListener('click', () => {
      this.setPlaying(false);
      this.model.resetToStart();
      toast('Design reset. Undo brings it back.');
    });
    $<HTMLInputElement>('#extended').addEventListener('change', (e) => {
      this.model.extendedRanges = (e.target as HTMLInputElement).checked;
      $('#extended-note').hidden = !this.model.extendedRanges;
      this.renderSourcePanel();
    });

    // Check & board.
    $('#run-check').addEventListener('click', () => {
      const r = this.runValidation();
      toast(`Checked ${r.pairsTested.toLocaleString()} neighbor pairs in ${Math.max(1, Math.round(r.ms))} ms`);
    });
    $('#fit-board').addEventListener('click', () => {
      const b = this.model.fitBoard();
      toast(`Board fitted: ${b.width.toFixed(1)} × ${b.height.toFixed(1)} mm`);
    });

    // Save & export.
    const name = $<HTMLInputElement>('#design-name');
    name.value = this.model.name;
    name.addEventListener('input', () => this.model.rename(name.value.trim() || 'Untitled design'));
    $('#save-local').addEventListener('click', () => void this.saveLocal());
    $('#download-json').addEventListener('click', () => void this.downloadJson());
    $('#import-json').addEventListener('click', () => $<HTMLInputElement>('#file-input').click());
    $<HTMLInputElement>('#file-input').addEventListener('change', (e) => void this.importFile(e.target as HTMLInputElement));
    $('#export-png').addEventListener('click', () => void this.exportPng());
    $('#export-glb').addEventListener('click', () => void this.exportGlb());
    $('#export-blender').addEventListener('click', () => void this.exportBlenderPackage());
    $('#resume-open').addEventListener('click', () => this.openDraft());
    $('#resume-intro').addEventListener('click', () => this.openDraft());
    $('#resume-discard').addEventListener('click', () => {
      store.clearDraft();
      $('#resume').hidden = true;
      $('#resume-intro').hidden = true;
    });
  }

  private selected(): WaveSource | undefined {
    return this.model.snap.sources.find((s) => s.id === this.selectedSource);
  }

  private selectSource(id: string): void {
    this.selectedSource = id;
    this.pending.add('sources');
  }

  private addSourceNear(kind: 'ripple' | 'travel'): string {
    const b = this.model.snap.board;
    const n = this.model.snap.sources.length;
    // Spread new sources around the board so handles do not stack.
    const spots = [[0, 0], [-0.25, 0.2], [0.25, -0.2], [-0.3, -0.25], [0.3, 0.25], [0, 0.3], [0, -0.3], [0.35, 0]];
    const [fx, fy] = spots[n % spots.length];
    return this.model.addSource(kind, b.centerX + fx * b.width, b.centerY + fy * b.height).id;
  }

  private renderSourcePanel(): void {
    const sources = this.model.snap.sources;
    const chips = $('#source-chips');
    chips.replaceChildren(
      ...sources.map((s, i) => {
        const chip = h(
          'button',
          { type: 'button', class: `chip${s.enabled ? '' : ' muted'}`, role: 'option', 'aria-selected': String(s.id === this.selectedSource) },
          h('span', { class: 'dot', text: String(i + 1) }),
          `${s.kind === 'ripple' ? 'Ripple' : 'Traveling wave'}${s.height === 0 && s.lean === 0 ? ' · off' : ''}`,
        );
        chip.addEventListener('click', () => this.selectSource(s.id));
        return chip;
      }),
    );
    const s = this.selected();
    const fields = $('#source-fields');
    fields.hidden = !s;
    const full = sources.length >= 8;
    ($('#add-ripple') as HTMLButtonElement).disabled = full;
    ($('#add-travel') as HTMLButtonElement).disabled = full;
    if (!s) return;
    setSegmented($('#src-kind'), s.kind);
    const ext = this.model.extendedRanges;
    const hMax = ext ? WAVE_LIMITS.height.extended : WAVE_LIMITS.height.normal;
    const lMax = ext ? WAVE_LIMITS.lean.extended : WAVE_LIMITS.lean.normal;
    const set = (field: string, value: number, text: string, opts: { min?: number; max?: number; disabled?: boolean; hidden?: boolean } = {}) => {
      const label = $(`#source-fields [data-field="${field}"]`);
      const input = $<HTMLInputElement>('input', label);
      if (opts.min !== undefined) input.min = String(opts.min);
      if (opts.max !== undefined) input.max = String(opts.max);
      if (document.activeElement !== input) input.value = String(value);
      paintRange(input);
      $('output', label).textContent = text;
      label.classList.toggle('disabled', !!opts.disabled);
      label.hidden = !!opts.hidden;
    };
    set('height', s.height, `${s.height.toFixed(1)} mm`, { max: hMax });
    set('lean', s.lean, `${s.lean > 0 ? '+' : ''}${s.lean.toFixed(1)} mm`, { min: -lMax, max: lMax });
    set('spacing', s.spacing, `${Math.round(s.spacing)} mm`, { min: WAVE_LIMITS.spacing.min, max: WAVE_LIMITS.spacing.max });
    const whole = !Number.isFinite(s.reach);
    set('reach', whole ? 2000 : s.reach, whole ? 'Whole board' : `${Math.round(s.reach)} mm`, { disabled: whole });
    set('direction', s.direction, `${Math.round(s.direction)}°`, { hidden: s.kind !== 'travel' });
    const speedText = s.speed === 0 ? 'Still' : `${s.speed > 0 ? '' : '−'}${Math.abs(s.speed)}× ${s.kind === 'ripple' ? (s.speed > 0 ? 'out' : 'in') : s.speed > 0 ? 'forward' : 'back'}`;
    set('speed', s.speed, speedText);
    set('phaseOffset', s.phaseOffset, `${Math.round(s.phaseOffset)}°`);
    $<HTMLInputElement>('#src-enabled').checked = s.enabled;
    $<HTMLInputElement>('#src-whole').checked = whole;
    $('#source-hint').textContent =
      s.height === 0 && s.lean === 0
        ? 'This source has no influence yet. Raise Height or Lean to start the wave. Drag its handle on the artwork to move it.'
        : this.coarse ? 'Drag the handle to move this source, or tap the board to place it.' : 'Drag the handle to move this source, or click the board to place it. Press Play to watch it move.';
  }

  private renderBrushPanel(): void {
    if (!isBrush(this.tool)) return;
    const kind = this.tool;
    const b = this.brushes[kind];
    const text = BRUSH_TEXT[kind];
    $('#brush-title').textContent = text.title;
    $('#brush-desc').textContent = text.desc;
    const set = (key: string, value: number, out: string) => {
      const label = $(`[data-brush="${key}"]`);
      const input = $<HTMLInputElement>('input', label);
      if (document.activeElement !== input) input.value = String(value);
      paintRange(input);
      $('output', label).textContent = out;
    };
    set('radius', b.radius, `Ø ${Math.round(b.radius * 2)} mm`);
    const axisBrush = kind === 'height' || kind === 'leanX' || kind === 'leanY';
    set('strength', b.strength, axisBrush ? `${brushMmPerSecond(b.strength).toFixed(0)} mm/s` : `${Math.round(b.strength * 10)}%`);
    set('smoothness', b.smoothness, b.smoothness < 0.34 ? 'Gentle' : b.smoothness > 0.66 ? 'Strong' : Math.abs(b.smoothness - 0.5) < 0.01 ? 'Reference' : 'Medium');
    $('#brush-sign-field').hidden = !axisBrush;
    if (axisBrush) {
      const [plus, minus] = $$<HTMLButtonElement>('#brush-sign button');
      plus.textContent = text.plus;
      minus.textContent = text.minus;
      setSegmented($('#brush-sign'), String(b.sign));
    }
    $('#smooth-axis-field').hidden = kind !== 'smooth';
    $('#smoothness-field').hidden = kind !== 'smooth';
    setSegmented($('#smooth-axis'), b.smoothAxis);
    $('#restore-target-field').hidden = kind !== 'restore';
    $('#restore-reference-label').textContent = this.model.snap.referenceLabel;
    setSegmented($('#restore-target'), this.model.restoreTarget);
    $('#brush-gestures').textContent = this.coarse
      ? 'Paint with one finger. Use two fingers to turn and zoom; the stroke in progress is canceled.'
      : 'Paint with the left button. Right-drag orbits, the wheel zooms, Space + drag moves the view. Hold ⌥ Option to reverse. [ and ] change the size.';
  }

  private renderStartingPoint(): void {
    setSegmented($('#starting-point'), this.model.snap.startingPoint);
    $('#start-note').textContent =
      this.model.snap.startingPoint === 'current'
        ? 'Begins from the finished sculpture exactly as imported. The original always stays available.'
        : `Same bases and grid, with every tip centered over its base at the imported median height (${this.model.sculpture.medianHeight.toFixed(1)} mm). The original stays available.`;
    const name = $<HTMLInputElement>('#design-name');
    if (document.activeElement !== name) name.value = this.model.name;
  }

  private renderKept(): void {
    const list = $('#kept-list');
    const kept = this.model.snap.kept;
    list.replaceChildren(
      ...kept.map((k, i) => {
        const btn = h('button', { type: 'button', class: 'btn btn-small', text: 'Return to settings' });
        btn.addEventListener('click', () => {
          this.setPlaying(false);
          this.model.returnToKept(k.id);
          this.setTool('waves');
          toast('Wave settings restored. The kept shape is one undo away.');
        });
        const time = new Date(k.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return h('li', {}, h('div', {}, h('strong', { text: `Kept shape ${i + 1} · ${time}` }), h('span', { text: k.label })), btn);
      }),
    );
    $('#kept-empty').hidden = kept.length > 0;
  }

  private renderValidation(): void {
    const r = this.validation;
    if (!r) return;
    const errors = r.issues.filter((i) => i.severity === 'error');
    const warnings = r.issues.filter((i) => i.severity === 'warning');
    const status = errors.length ? 'error' : warnings.length ? 'warning' : 'ok';
    const pill = $('#status-pill');
    pill.dataset.status = status;
    const flaggedCount = r.flagged.size;
    pill.innerHTML = `<svg class="i"><use href="#i-${status === 'ok' ? 'check' : 'alert'}"/></svg><span>${
      status === 'ok' ? 'Geometry OK' : `${flaggedCount} piece${flaggedCount === 1 ? '' : 's'} flagged`
    }</span>`;
    const sum = $('#check-summary');
    sum.dataset.status = status;
    $('use', sum).setAttribute('href', status === 'ok' ? '#i-check' : '#i-alert');
    $('#check-title').textContent = status === 'ok' ? 'No problems found' : errors.length ? `${errors.length} problem${errors.length === 1 ? '' : 's'} to fix` : `${warnings.length} thing${warnings.length === 1 ? '' : 's'} to watch`;
    $('#check-detail').textContent = ` All ${this.model.sculpture.count} pieces, ${r.pairsTested.toLocaleString()} neighbor pairs, ${Math.max(1, Math.round(r.ms))} ms.`;
    const ids = this.model.sculpture.ids;
    $('#issue-list').replaceChildren(
      ...r.issues.map((issue) => {
        const btn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Show' });
        btn.addEventListener('click', () => {
          this.viewer.focusPiece(issue.pieces[0]);
          toast(`Showing ${ids[issue.pieces[0]]}`);
        });
        return h('li', { 'data-severity': issue.severity }, h('span', { class: 'sev' }), h('span', { text: issue.message }), btn);
      }),
    );
  }

  private renderBoard(): void {
    const b = this.model.snap.board;
    const r = this.border;
    $('#board-size').textContent = `${b.width.toFixed(1)} × ${b.height.toFixed(1)} × ${b.thickness.toFixed(0)} mm  ·  ${(b.width / 25.4).toFixed(2)} × ${(b.height / 25.4).toFixed(2)} in`;
    if (!r) return;
    const status = $('#board-status');
    status.dataset.status = r.status;
    status.textContent = `${r.message}${b.origin === 'fitted' ? ' Board fitted to this design.' : ' Board size from the imported sculpture.'}`;
    for (const [id, v] of [['#bd-l', r.left], ['#bd-r', r.right], ['#bd-t', r.top], ['#bd-b', r.bottom]] as const) {
      const el = $(id);
      el.textContent = `${v.toFixed(1)}`;
      el.classList.toggle('low', v < b.border - 0.5 && v >= 0);
      el.classList.toggle('bad', v < 0);
    }
  }

  /* ================================================================ save, load, export */

  private fileName(ext: string): string {
    return `origami1829-${store.slug(this.model.name)}.${ext}`;
  }

  private async thumbnail(): Promise<string | undefined> {
    try {
      this.overlays.setVisible(false);
      const blob = await this.viewer.capture(480);
      this.overlays.setVisible(this.mode === 'customize' && !this.comparing);
      const bmp = await createImageBitmap(blob);
      const w = 240, hgt = Math.round((240 * bmp.height) / bmp.width);
      const c = h('canvas', { width: String(w), height: String(hgt) });
      c.getContext('2d')!.drawImage(bmp, 0, 0, w, hgt);
      return c.toDataURL('image/jpeg', 0.78);
    } catch {
      return undefined;
    }
  }

  private async saveLocal(): Promise<void> {
    const v = await this.checkBeforeExport('save');
    if (!v) return;
    const file = serializeDesign(this.model.sculpture, this.model.snap, this.model.name, undefined, v);
    const meta = store.saveDesign(file, await this.thumbnail(), this.savedId ?? undefined);
    if (!meta) {
      toast('This browser would not store the design. Download the design file instead.', 3500);
      return;
    }
    this.savedId = meta.id;
    store.clearDraft();
    this.renderDesignList();
    toast(`Saved “${meta.name}” in this browser`);
  }

  private async downloadJson(): Promise<void> {
    const v = await this.checkBeforeExport('download');
    if (!v) return;
    const file = serializeDesign(this.model.sculpture, this.model.snap, this.model.name, undefined, v);
    store.downloadBlob(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }), this.fileName('json'));
  }

  private async importFile(input: HTMLInputElement): Promise<void> {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const loaded = deserializeDesign(this.model.sculpture, JSON.parse(await f.text()));
      this.applyLoaded(loaded.snapshot, loaded.name, loaded.poseMismatchMm);
      this.savedId = null;
    } catch (err) {
      await confirmDialog('Could not open this file', (err as Error).message, 'OK', null);
    }
  }

  private applyLoaded(snapshot: Parameters<StudioModel['load']>[0], name: string, mismatch: number): void {
    this.setPlaying(false);
    this.model.load(snapshot, name);
    if (this.mode !== 'customize') this.enterCustomize();
    if (mismatch > 1e-6) toast(`Loaded “${name}”. Its stored pose differed by ${mismatch.toFixed(4)} mm and was rebuilt from its settings.`, 4500);
    else toast(`Loaded “${name}”`);
  }

  private async exportPng(): Promise<void> {
    this.overlays.setVisible(false);
    const btn = $<HTMLButtonElement>('#export-png');
    btn.disabled = true;
    toast('Rendering image…', 8000);
    try {
      await new Promise((r) => requestAnimationFrame(r));
      const blob = await this.viewer.capture(3000);
      store.downloadBlob(blob, this.fileName('png'));
      toast('Image saved');
    } catch (err) {
      toast(`Could not render the image: ${(err as Error).message}`, 4000);
    } finally {
      btn.disabled = false;
      this.overlays.setVisible(this.mode === 'customize' && !this.comparing);
    }
  }

  private async exportGlb(): Promise<void> {
    const v = await this.checkBeforeExport('export');
    if (!v) return;
    const p = this.model.getPose();
    const bytes = buildDesignGlb(this.model.sculpture, p.outer, p.inner, this.model.snap.board, {
      includePresentation: $<HTMLInputElement>('#glb-thickness').checked,
      designName: this.model.name,
    });
    store.downloadBlob(new Blob([bytes as BlobPart], { type: 'model/gltf-binary' }), this.fileName('glb'));
    if (!v.passed) toast('Exported. Remember: this design did not pass the geometry check.', 4000);
  }

  /** Design file + rebuild script + canonical data, ready to run in Blender. */
  private async exportBlenderPackage(): Promise<void> {
    const v = await this.checkBeforeExport('export');
    if (!v) return;
    const base = import.meta.env.BASE_URL;
    const get = async (path: string) => {
      const r = await fetch(`${base}${path}`);
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    };
    try {
      const [script, sculpture, source, presentation] = await Promise.all([
        get('downloads/rebuild_design.py'),
        get('assets/sculpture.json'),
        get('assets/sculpture-blender.json'),
        get('assets/presentation.json'),
      ]);
      const slug = store.slug(this.model.name);
      const dir = `origami1829-${slug}`;
      const file = serializeDesign(this.model.sculpture, this.model.snap, this.model.name, undefined, v);
      const readme = [
        `Origami 1829 - Blender package for "${this.model.name}"`,
        '',
        'Rebuild the design as a Blender scene (Blender 4.2 or newer):',
        '',
        `  blender -b --factory-startup -P rebuild_design.py -- --design design.json --out ${slug}.blend`,
        '',
        'On macOS use /Applications/Blender.app/Contents/MacOS/Blender in place of "blender".',
        'Run the command from this folder, then open the .blend file.',
        '',
        'The script recreates the 522 outer shells with their original names, vertex order and open',
        'hypotenuse faces, rebuilds every inner shell with inner = M + 0.75 (outer - M), and adds the',
        'presentation-only paper thickness, materials, board, lights and cameras.',
        '',
        `Geometry check when exported: ${v.passed ? 'passed' : `NOT passed (${v.errors} problem(s))`}. This is a design preview, not a fabrication test.`,
        '',
      ].join('\n');
      const bytes = zip([
        { name: `${dir}/README.txt`, data: readme },
        { name: `${dir}/design.json`, data: JSON.stringify(file, null, 1) },
        { name: `${dir}/rebuild_design.py`, data: script },
        { name: `${dir}/sculpture.json`, data: sculpture },
        { name: `${dir}/sculpture-blender.json`, data: source },
        { name: `${dir}/presentation.json`, data: presentation },
      ]);
      store.downloadBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), `${dir}-blender.zip`);
    } catch (err) {
      await confirmDialog('Could not build the Blender package', (err as Error).message, 'OK', null);
    }
  }

  private renderDesignList(): void {
    const list = store.listDesigns();
    $('#design-list').replaceChildren(
      ...list.map((d) => {
        const open = h('button', { type: 'button', class: 'btn btn-small', text: 'Open' });
        const del = h('button', { type: 'button', class: 'btn btn-small btn-ghost danger', text: 'Delete', 'aria-label': `Delete ${d.name}` });
        open.addEventListener('click', () => {
          const file = store.loadDesignFile(d.id);
          if (!file) return toast('That design could not be read from this browser');
          try {
            const loaded = deserializeDesign(this.model.sculpture, file);
            this.applyLoaded(loaded.snapshot, loaded.name, loaded.poseMismatchMm);
            this.savedId = d.id;
          } catch (err) {
            void confirmDialog('Could not open this design', (err as Error).message, 'OK', null);
          }
        });
        del.addEventListener('click', async () => {
          if (await confirmDialog(`Delete “${d.name}”?`, 'This removes it from this browser. Downloaded files are not affected.', 'Delete')) {
            store.deleteDesign(d.id);
            if (this.savedId === d.id) this.savedId = null;
            this.renderDesignList();
          }
        });
        const date = new Date(d.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
        return h(
          'li',
          {},
          d.thumb ? h('img', { src: d.thumb, alt: '' }) : h('img', { alt: '' }),
          h('div', {}, h('strong', { text: d.name }), h('span', { text: date })),
          h('div', { class: 'row-actions' }, open, del),
        );
      }),
    );
    $('#designs-empty').hidden = list.length > 0;
  }

  private scheduleDraft(): void {
    if (this.mode !== 'customize') return;
    clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => {
      if (this.model.isModified() || this.model.snap.sources.some((s) => s.height || s.lean)) {
        store.saveDraft(serializeDesign(this.model.sculpture, this.model.snap, this.model.name));
      }
    }, 1500);
  }

  private checkDraft(): void {
    const d = store.loadDraft();
    $('#resume').hidden = !d;
    $('#resume-intro').hidden = !d;
  }

  private openDraft(): void {
    const d = store.loadDraft();
    if (!d) return;
    try {
      const loaded = deserializeDesign(this.model.sculpture, d);
      this.applyLoaded(loaded.snapshot, loaded.name, loaded.poseMismatchMm);
    } catch (err) {
      void confirmDialog('Could not restore your last session', (err as Error).message, 'OK', null);
    }
    $('#resume').hidden = true;
    $('#resume-intro').hidden = true;
  }

  /* ================================================================ verification hooks */

  /**
   * Live self-test used by the verification pass: invariants of the current pose, agreement
   * between the GPU buffers and the canonical geometry, and a GLB round trip.
   */
  selfTest() {
    const s = this.model.sculpture;
    const p = this.model.getPose();
    let innerErr = 0, baseErr = 0;
    for (let i = 0; i < s.count; i++) {
      const apex = s.roles[i * 4 + 3];
      for (let v = 0; v < 4; v++) {
        for (let k = 0; k < 3; k++) {
          const m = s.midpoints[i * 3 + k];
          innerErr = Math.max(innerErr, Math.abs(m + 0.75 * (p.outer[i * 12 + v * 3 + k] - m) - p.inner[i * 12 + v * 3 + k]));
          if (v !== apex) baseErr = Math.max(baseErr, Math.abs(p.outer[i * 12 + v * 3 + k] - s.originalVertices[i * 12 + v * 3 + k]));
        }
      }
    }
    // Viewport buffers vs. geometry rebuilt from the model.
    const shownOriginal = this.comparing || (this.mode === 'view' && this.showing === 'original');
    const src = shownOriginal ? this.model.originalShells() : p;
    const tmp = new Float64Array(FLOATS_PER_SHELL);
    let gpuErr = 0;
    const gpu = this.viewer.outer.positions();
    const gpuIn = this.viewer.inner.positions();
    const pr = s.data.presentation;
    for (let i = 0; i < s.count; i++) {
      writeThickShell(src.outer, i * 12, s.faces, i * 9, { thickness: pr.outerThicknessMm, offset: 1 }, tmp, null, 0);
      for (let j = 0; j < FLOATS_PER_SHELL; j++) gpuErr = Math.max(gpuErr, Math.abs(tmp[j] - gpu[i * FLOATS_PER_SHELL + j]));
      writeThickShell(src.inner, i * 12, s.faces, i * 9, { thickness: pr.innerThicknessMm, offset: -1 }, tmp, null, 0);
      for (let j = 0; j < FLOATS_PER_SHELL; j++) gpuErr = Math.max(gpuErr, Math.abs(tmp[j] - gpuIn[i * FLOATS_PER_SHELL + j]));
    }
    // GLB round trip.
    const glb = readGlb(buildDesignGlb(s, p.outer, p.inner, this.model.snap.board, { includePresentation: false, designName: 'self-test' }));
    const nodes = new Map<string, any>(glb.json.nodes.map((n: any) => [n.name, n]));
    let glbErr = 0;
    for (let i = 0; i < s.count; i++) {
      for (const [suffix, arr] of [['', p.outer], [' INNER 75%', p.inner]] as const) {
        const node = nodes.get(s.ids[i] + suffix);
        const pos = readAccessor(glb, glb.json.meshes[node.mesh].primitives[0].attributes.POSITION) as Float32Array;
        for (let v = 0; v < 4; v++) {
          glbErr = Math.max(
            glbErr,
            Math.abs(pos[v * 3] * 1000 - arr[i * 12 + v * 3]),
            Math.abs(-pos[v * 3 + 2] * 1000 - arr[i * 12 + v * 3 + 1]),
            Math.abs(pos[v * 3 + 1] * 1000 - arr[i * 12 + v * 3 + 2]),
          );
        }
      }
    }
    const r = this.model.validate();
    return {
      pieces: s.count,
      innerRuleMaxErrorMm: innerErr,
      baseMaxChangeMm: baseErr,
      viewportVsModelMaxErrorMm: gpuErr,
      glbVsPoseMaxErrorMm: glbErr,
      validation: { errors: r.issues.filter((i) => i.severity === 'error').length, warnings: r.issues.filter((i) => i.severity === 'warning').length, ms: r.ms, pairs: r.pairsTested },
      phase: this.model.snap.phase,
      modified: this.model.isModified(),
    };
  }
}
