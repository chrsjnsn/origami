/**
 * Page controller: the main viewing page, the info panel, and the customize page (colors,
 * pattern styles, motion with a live play bar, saving and exports).
 */

import { buildDesignGlb } from '../core/exportGeometry';
import { lookDesignFile } from '../core/exportLook';
import { readAccessor, readGlb } from '../core/glb';
import { isOriginal, type Look, ORIGINAL_COLORS, ORIGINAL_LOOK, PALETTES, type PaperColors, sameLook, sanitizeLook } from '../core/look';
import type { Sculpture } from '../core/sculpture';
import { FLOATS_PER_SHELL, writeThickShell } from '../core/solidify';
import { validateShells } from '../core/validation';
import { importedBoard } from '../core/board';
import { makeSafe, STYLE_DEFAULTS, STYLES, type StyleId, type Variation, VariationEngine } from '../core/variations';
import type { Viewer, ViewName } from '../render/viewer';
import { $, $$, confirmDialog, h, paintRange, toast } from './dom';
import * as store from './storage';
import { inches, inchValue } from './units';
import { zip } from './zip';

type Page = 'home' | 'customize';

/** Length of the rewindable window of the live motion (seconds). */
const REWIND_WINDOW = 60;
const MORPH_MS = 750;

export class App {
  readonly engine: VariationEngine;
  /** What the visitor has chosen on the customize page. */
  look: Look;
  page: Page = 'home';
  private undoStack: Look[] = [];
  private redoStack: Look[] = [];
  /** Offsets currently shown, and the pose being shown (target of any morph). */
  private shown: Float64Array;
  private target: Float64Array;
  private morph: { from: Float64Array; t0: number } | null = null;
  private dirty = true;
  /** Safety-net strength for the current variation (1 = as designed). */
  private strength = 1;
  private safetyTimer = 0;
  private playing = false;
  private animating = false;
  private liveTime = 0;
  private readonly tips: Float64Array;
  private readonly outer: Float64Array;
  private readonly inner: Float64Array;
  private thumbTimer = 0;

  constructor(
    readonly sculpture: Sculpture,
    readonly viewer: Viewer,
  ) {
    this.engine = new VariationEngine(sculpture);
    const n = sculpture.count;
    this.shown = sculpture.originalOffsets.slice();
    this.target = sculpture.originalOffsets.slice();
    this.tips = new Float64Array(n * 3);
    this.outer = new Float64Array(n * 12);
    this.inner = new Float64Array(n * 12);
    const saved = store.loadCurrent();
    this.look = saved ? sanitizeLook(saved) : structuredClone(ORIGINAL_LOOK);
    this.liveTime = this.look.time;

    this.viewer.setBoard(importedBoard(sculpture));
    this.viewer.setColors(ORIGINAL_COLORS);
    this.pushShells(this.shown);

    this.buildFacts();
    this.buildSwatches();
    this.buildStyles();
    this.bindHome();
    this.bindStudio();
    this.bindPlaybar();
    this.renderDesigns();
    this.viewer.onFrame((_t, dt) => this.frame(dt));
    window.addEventListener('hashchange', () => this.route());
    window.addEventListener('resize', () => this.updateInsets(false));
    document.addEventListener('keydown', (e) => this.onKey(e));
    this.route(true);
  }

  /* ================================================================ pose */

  private pushShells(offsets: Float64Array): void {
    const s = this.sculpture;
    s.tipsFromOffsets(offsets, this.tips);
    s.shellVertices(this.tips, this.outer, this.inner);
    this.viewer.setShells(this.outer, this.inner);
  }

  /** Offsets of what the current page should show. */
  private computeTarget(out: Float64Array): void {
    if (this.page === 'home') out.set(this.sculpture.originalOffsets);
    else this.engine.offsets(this.look.variation, this.look.time, out, this.strength);
  }

  /** Recompute the target pose; `animate` morphs smoothly from what is shown now. */
  private refreshPose(animate: boolean): void {
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.morph = { from: this.shown.slice(), t0: performance.now() };
    } else {
      this.morph = null;
    }
    this.dirty = true;
  }

  private frame(dt: number): void {
    if (this.playing) {
      this.look.time += dt;
      if (this.look.time > this.liveTime) this.liveTime = this.look.time;
      this.dirty = true;
      this.updatePlaybar();
    }
    if (!this.dirty && !this.morph) return;
    this.computeTarget(this.target);
    if (this.morph) {
      const k = Math.min(1, (performance.now() - this.morph.t0) / MORPH_MS);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const from = this.morph.from;
      for (let j = 0; j < this.shown.length; j++) this.shown[j] = from[j] + (this.target[j] - from[j]) * e;
      if (k >= 1) this.morph = null;
    } else {
      this.shown.set(this.target);
    }
    this.dirty = false;
    this.pushShells(this.shown);
  }

  /**
   * Safety net: after a change settles, run the complete geometry check on the pose and, if it
   * reports anything at all, tone the pattern down until it is clean. The limits built into the
   * variations are designed so this does not happen (see docs/VERIFICATION.md).
   */
  private scheduleSafety(): void {
    clearTimeout(this.safetyTimer);
    this.strength = 1;
    if (this.look.variation.style === 'original') return;
    this.safetyTimer = window.setTimeout(() => {
      if (this.playing || this.page !== 'customize') return;
      const res = makeSafe(this.engine, this.look.variation, this.look.time, new Float64Array(this.sculpture.count * 3));
      if (res.strength < 1) {
        this.strength = res.strength;
        this.refreshPose(true);
      }
    }, 250);
  }

  /* ================================================================ pages */

  private route(initial = false): void {
    const next: Page = location.hash === '#customize' ? 'customize' : 'home';
    if (!initial && next === this.page) return;
    this.page = next;
    document.body.dataset.page = next;
    this.setInfo(false);
    $('#studio').setAttribute('aria-hidden', String(next !== 'customize'));
    if (next === 'home') {
      this.setPlaying(false);
      this.viewer.setColors(ORIGINAL_COLORS);
      $('#playbar').hidden = true;
      document.title = 'Origami Waves';
    } else {
      this.viewer.setColors(this.look.colors);
      $('#playbar').hidden = !this.animating;
      this.syncStudio();
      document.title = 'Customize · Origami Waves';
      this.scheduleSafety();
    }
    this.refreshPose(!initial);
    this.updateInsets(!initial);
  }

  /** Tell the viewer which parts of the screen are covered, so the artwork stays in view. */
  private updateInsets(animate: boolean): void {
    const phone = matchMedia('(max-width: 760px)').matches;
    const top = phone ? 54 : 60;
    const root = document.documentElement.style;
    if (this.page === 'home') {
      // On wide screens the info panel sits beside the artwork instead of over it.
      const info = document.body.classList.contains('info-open') && innerWidth >= 900 ? $('#info-panel').offsetWidth : 0;
      this.viewer.setInsets({ top, bottom: phone ? 130 : 84, left: info, right: 0 }, animate);
      return;
    }
    const studio = $('#studio');
    const playbar = this.animating ? 68 : 0;
    if (phone) {
      const sheet = studio.classList.contains('collapsed') ? 62 : studio.offsetHeight;
      root.setProperty('--free-bottom', `${sheet}px`);
      root.setProperty('--free-right', '0px');
      this.viewer.setInsets({ top, bottom: sheet + playbar, left: 0, right: 0 }, animate);
    } else {
      const right = studio.offsetWidth + 24;
      root.setProperty('--free-bottom', '0px');
      root.setProperty('--free-right', `${right}px`);
      this.viewer.setInsets({ top: 20, bottom: 20 + playbar, left: 0, right }, animate);
    }
  }

  /* ================================================================ main page */

  private bindHome(): void {
    const views = $$<HTMLButtonElement>('.views button');
    for (const b of views) {
      b.addEventListener('click', () => {
        this.viewer.goTo(b.dataset.view as ViewName);
        for (const o of views) o.setAttribute('aria-pressed', String(o === b));
      });
    }
    this.viewer.controls.addEventListener('start', () => {
      for (const o of views) o.setAttribute('aria-pressed', 'false');
      $('#hint').classList.add('gone');
    });
    window.setTimeout(() => $('#hint').classList.add('gone'), 7000);
    $('#info-btn').addEventListener('click', () => this.setInfo(!document.body.classList.contains('info-open')));
    $('#info-close').addEventListener('click', () => this.setInfo(false));
  }

  private setInfo(open: boolean): void {
    document.body.classList.toggle('info-open', open);
    $('#info-panel').setAttribute('aria-hidden', String(!open));
    $('#info-btn').setAttribute('aria-expanded', String(open));
    if (open) $<HTMLButtonElement>('#info-close').focus({ preventScroll: true });
    if (this.page === 'home') this.updateInsets(true);
  }

  private buildFacts(): void {
    const d = this.sculpture.data;
    const tallest = d.stats.tipHeightMm.max;
    const rows: [string, string][] = [
      ['Size', `${inchValue(d.board.widthMm)} × ${inchValue(d.board.heightMm)} in`],
      ['Depth', `about ${inches(d.board.thicknessMm + tallest, 4)}`],
      ['Pyramids', `${this.sculpture.count}, in a ${d.grid.cols} × ${d.grid.rows} grid`],
      ['Grid spacing', inches(d.grid.spacingMm)],
      ['Pyramid height', `${inchValue(d.stats.tipHeightMm.min)} to ${inches(tallest)}`],
      ['Border', `${inches(d.presentation.borderMm, 4)} on every side`],
      ['Board', `${inches(d.board.thicknessMm, 8)} thick, matte black`],
      ['Paper', 'Matte black cardstock, with vivid blue (#007AFF) pyramids inside at 75% scale'],
    ];
    $('#facts').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
  }

  /* ================================================================ customize page */

  private buildSwatches(): void {
    for (const row of $$('.color-row')) {
      const part = row.dataset.part as keyof PaperColors;
      const group = $('.swatches', row);
      const buttons = PALETTES[part].map((sw) => {
        const b = h('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-label': sw.name, title: sw.name, 'data-hex': sw.hex });
        b.style.setProperty('--c', sw.hex);
        b.addEventListener('click', () => this.setColor(part, sw.hex));
        return b;
      });
      const input = h('input', { type: 'color', 'aria-label': `Custom ${part === 'outer' ? 'pyramid' : part === 'inner' ? 'inside' : 'board'} color` });
      const custom = h('label', { class: 'swatch custom', role: 'radio', title: 'Custom color' }, input, h('span', { class: 'dot' }));
      input.addEventListener('input', () => this.setColor(part, input.value.toLowerCase(), false));
      input.addEventListener('change', () => this.setColor(part, input.value.toLowerCase(), true));
      group.replaceChildren(...buttons, custom);
    }
  }

  private setColor(part: keyof PaperColors, hex: string, commit = true): void {
    if (commit && this.look.colors[part] !== hex) this.record();
    this.look.colors[part] = hex;
    this.viewer.setColors(this.look.colors);
    this.syncSwatches();
    this.scheduleThumbs();
    if (commit) this.persist();
  }

  private syncSwatches(): void {
    for (const row of $$('.color-row')) {
      const part = row.dataset.part as keyof PaperColors;
      const hex = this.look.colors[part];
      let matched = false;
      for (const b of $$('.swatch[data-hex]', row)) {
        const on = b.dataset.hex === hex;
        matched ||= on;
        b.setAttribute('aria-checked', String(on));
      }
      const custom = $('.swatch.custom', row);
      custom.setAttribute('aria-checked', String(!matched));
      custom.style.setProperty('--c', matched ? '#ffffff' : hex);
      $<HTMLInputElement>('input', custom).value = hex;
    }
  }

  private buildStyles(): void {
    const cards = STYLES.map((st) => {
      const canvas = h('canvas', { width: '116', height: '72' });
      const b = h('button', { type: 'button', class: 'style-card', role: 'radio', 'data-style': st.id, title: st.description }, canvas, h('span', { text: st.name }));
      b.addEventListener('click', () => this.setStyle(st.id));
      return b;
    });
    $('#styles').replaceChildren(...cards);
  }

  private setStyle(style: StyleId): void {
    const v = this.look.variation;
    if (v.style === style) return;
    this.record();
    this.look.variation = style === 'original' ? { ...v, style } : { ...v, style, ...STYLE_DEFAULTS[style] };
    this.afterPatternChange(true);
  }

  private afterPatternChange(animate: boolean): void {
    if (this.look.variation.style === 'original' && this.animating) this.setAnimating(false);
    this.syncStudio();
    this.refreshPose(animate);
    this.scheduleSafety();
    this.persist();
  }

  private bindStudio(): void {
    for (const id of ['intensity', 'scale', 'flow'] as const) {
      const input = $<HTMLInputElement>(`#${id}`);
      let before: Look | null = null;
      input.addEventListener('pointerdown', () => (before ??= structuredClone(this.look)));
      input.addEventListener('input', () => {
        before ??= structuredClone(this.look);
        this.look.variation[id] = Number(input.value);
        paintRange(input);
        this.strength = 1;
        this.dirty = true;
        this.scheduleThumbs();
      });
      input.addEventListener('change', () => {
        if (before && !sameLook(before, this.look)) this.record(before);
        before = null;
        this.scheduleSafety();
        this.persist();
      });
    }
    $('#shuffle').addEventListener('click', () => {
      this.record();
      const v = this.look.variation;
      if (v.style === 'original') {
        // Shuffling the original starts a random style.
        const styles = STYLES.filter((s) => s.id !== 'original');
        const st = styles[Math.floor(Math.random() * styles.length)].id as Exclude<StyleId, 'original'>;
        this.look.variation = { ...v, style: st, ...STYLE_DEFAULTS[st] };
      }
      this.look.variation.seed = Math.floor(Math.random() * 1_000_000);
      this.afterPatternChange(true);
    });
    $('#animate').addEventListener('click', () => this.setAnimating(!this.animating));
    $('#undo').addEventListener('click', () => this.undo());
    $('#redo').addEventListener('click', () => this.redo());
    $('#reset').addEventListener('click', () => {
      if (sameLook({ ...this.look, time: 0 }, ORIGINAL_LOOK)) return;
      this.record();
      this.look = structuredClone(ORIGINAL_LOOK);
      this.viewer.setColors(this.look.colors);
      this.setAnimating(false);
      this.afterPatternChange(true);
    });
    $('#save-design').addEventListener('click', () => this.saveDesign());
    $('#save-image').addEventListener('click', () => this.saveImage());
    $('#save-blender').addEventListener('click', () => this.saveBlender());
    const handle = $('#sheet-handle');
    const studio = $('#studio');
    const toggleSheet = (collapse?: boolean) => {
      const c = collapse ?? !studio.classList.contains('collapsed');
      studio.classList.toggle('collapsed', c);
      handle.setAttribute('aria-expanded', String(!c));
      handle.setAttribute('aria-label', c ? 'Expand panel' : 'Collapse panel');
      this.updateInsets(true);
    };
    handle.addEventListener('click', () => toggleSheet());
    $('.studio-head').addEventListener('click', (e) => {
      if (studio.classList.contains('collapsed') && !(e.target as HTMLElement).closest('button')) toggleSheet(false);
    });
  }

  /** Bring every control on the customize page in line with the current look. */
  private syncStudio(): void {
    const v = this.look.variation;
    for (const b of $$('.style-card')) b.setAttribute('aria-checked', String(b.dataset.style === v.style));
    $('#style-desc').textContent =
      v.style === 'original'
        ? 'The sculpture as it was made. Choose a style or press Shuffle to create variations of the pattern.'
        : STYLES.find((s) => s.id === v.style)!.description;
    const original = v.style === 'original';
    $('#sliders').classList.toggle('disabled', original);
    for (const id of ['intensity', 'scale', 'flow'] as const) {
      const input = $<HTMLInputElement>(`#${id}`);
      input.value = String(v[id]);
      input.disabled = original;
      paintRange(input);
    }
    $<HTMLButtonElement>('#animate').disabled = original;
    $<HTMLButtonElement>('#undo').disabled = this.undoStack.length === 0;
    $<HTMLButtonElement>('#redo').disabled = this.redoStack.length === 0;
    $<HTMLButtonElement>('#reset').disabled = isOriginal(this.look);
    this.syncSwatches();
    this.drawThumbs();
  }

  private scheduleThumbs(): void {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => this.drawThumbs(), 120);
  }

  /**
   * Pattern previews on the style cards: one square per pyramid, shaded by height, and showing
   * the inside color where the tip leans toward the lower left (which opens the pyramid's open
   * side toward the viewer).
   */
  private drawThumbs(): void {
    const s = this.sculpture;
    const off = new Float64Array(s.count * 3);
    const col = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    const outer = col(this.look.colors.outer), inner = col(this.look.colors.inner), board = col(this.look.colors.board);
    const current = this.look.variation;
    for (const card of $$('.style-card')) {
      const style = card.dataset.style as StyleId;
      const v: Variation =
        style === current.style ? current : style === 'original' ? { ...current, style } : { ...current, style, ...STYLE_DEFAULTS[style] };
      this.engine.offsets(v, style === current.style ? this.look.time : 0, off);
      const canvas = $<HTMLCanvasElement>('canvas', card);
      const g = canvas.getContext('2d')!;
      const img = g.createImageData(canvas.width, canvas.height);
      const px = img.data;
      for (let j = 0; j < px.length; j += 4) {
        px[j] = board[0];
        px[j + 1] = board[1];
        px[j + 2] = board[2];
        px[j + 3] = 255;
      }
      for (let i = 0; i < s.count; i++) {
        const c = i % s.cols, r = Math.floor(i / s.cols);
        const dx = off[i * 3], dy = off[i * 3 + 1];
        const z = s.anchors[i * 3 + 2] + off[i * 3 + 2];
        const open = Math.min(1, Math.max(0, (-(dx + dy) / Math.SQRT2 + 4) / 30));
        const shade = 0.72 + 0.5 * Math.min(1, Math.max(0, (z - 22) / 54));
        const blend = open * 0.9;
        const rgb = [0, 1, 2].map((k) => Math.min(255, outer[k] * shade * (1 - blend) + inner[k] * blend + 18 * shade * (1 - blend)));
        const x0 = c * 4, y0 = (s.rows - 1 - r) * 4;
        for (let y = y0; y < y0 + 3; y++) {
          for (let x = x0; x < x0 + 3; x++) {
            const o = (y * canvas.width + x) * 4;
            px[o] = rgb[0];
            px[o + 1] = rgb[1];
            px[o + 2] = rgb[2];
          }
        }
      }
      g.putImageData(img, 0, 0);
    }
  }

  /* ================================================================ history */

  private record(before: Look = structuredClone(this.look)): void {
    this.undoStack.push({ ...before, time: this.look.time });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(structuredClone(this.look));
    this.applyLook(prev);
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(structuredClone(this.look));
    this.applyLook(next);
  }

  private applyLook(look: Look): void {
    this.look = structuredClone(look);
    this.liveTime = Math.max(this.liveTime, this.look.time);
    this.viewer.setColors(this.look.colors);
    this.afterPatternChange(true);
  }

  private persist(): void {
    store.saveCurrent(this.look);
  }

  /* ================================================================ motion */

  private setAnimating(on: boolean): void {
    if (on && this.look.variation.style === 'original') return;
    this.animating = on;
    const btn = $('#animate');
    btn.setAttribute('aria-pressed', String(on));
    $('span', btn).textContent = on ? 'Stop motion' : 'Animate';
    $('#playbar').hidden = !on || this.page !== 'customize';
    if (on) this.liveTime = Math.max(this.liveTime, this.look.time);
    this.setPlaying(on);
    this.updateInsets(true);
  }

  private setPlaying(on: boolean): void {
    if (this.playing === on) return;
    this.playing = on;
    const btn = $('#pb-play');
    btn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    btn.querySelector('use')!.setAttribute('href', on ? '#i-pause' : '#i-play');
    if (!on) {
      this.persist();
      this.scheduleSafety();
      this.drawThumbs();
    } else {
      this.strength = 1;
    }
    this.updatePlaybar();
  }

  private bindPlaybar(): void {
    const scrub = $<HTMLInputElement>('#pb-scrub');
    $('#pb-play').addEventListener('click', () => this.setPlaying(!this.playing));
    $('#pb-back').addEventListener('click', () => {
      this.look.time = Math.max(this.windowStart(), this.look.time - 5);
      this.dirty = true;
      this.updatePlaybar();
      if (!this.playing) this.scheduleSafety();
    });
    $('#pb-live').addEventListener('click', () => {
      this.look.time = this.liveTime;
      this.dirty = true;
      this.setPlaying(true);
    });
    scrub.addEventListener('input', () => {
      this.setPlaying(false);
      const start = this.windowStart();
      this.look.time = start + (Number(scrub.value) / 1000) * (this.liveTime - start);
      this.dirty = true;
      this.updatePlaybar();
    });
    scrub.addEventListener('change', () => this.scheduleSafety());
    $('#pb-save').addEventListener('click', () => {
      this.setPlaying(false);
      void this.saveDesign();
    });
  }

  private windowStart(): number {
    return Math.max(0, this.liveTime - REWIND_WINDOW);
  }

  private updatePlaybar(): void {
    const scrub = $<HTMLInputElement>('#pb-scrub');
    const start = this.windowStart();
    const span = this.liveTime - start;
    scrub.value = String(span > 0 ? Math.round(((this.look.time - start) / span) * 1000) : 1000);
    paintRange(scrub);
    $('#pb-live').classList.toggle('is-live', this.playing && this.liveTime - this.look.time < 0.25);
  }

  /* ================================================================ save and export */

  private defaultName(): string {
    const v = this.look.variation;
    const style = STYLES.find((s) => s.id === v.style)!.name;
    const same = store.listDesigns().filter((d) => d.name.startsWith(style)).length;
    return `${style} ${same + 1}`;
  }

  /** The exact pose shown for the current look (after any safety adjustment). */
  private currentOffsets(): Float64Array {
    const out = new Float64Array(this.sculpture.count * 3);
    this.engine.offsets(this.look.variation, this.look.time, out, this.strength);
    return out;
  }

  private settle(): void {
    // Finish any morph so images and exports show the final pose.
    this.morph = null;
    this.dirty = true;
    this.frame(0);
  }

  private async saveDesign(): Promise<void> {
    this.settle();
    const name = this.defaultName();
    let thumb: string | undefined;
    try {
      thumb = this.viewer.snapshot(480, 320).toDataURL('image/jpeg', 0.82);
    } catch {
      thumb = undefined;
    }
    const meta = store.saveDesign(name, structuredClone(this.look), thumb);
    if (!meta) {
      await confirmDialog('Could not save', 'This browser is not allowing the site to store designs (for example in a private window). You can still save an image.', 'OK', null);
      return;
    }
    this.renderDesigns();
    toast(`Saved “${name}”`);
  }

  private renderDesigns(): void {
    const list = store.listDesigns();
    $('#designs-empty').hidden = list.length > 0;
    const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    $('#designs').replaceChildren(
      ...list.map((d) => {
        const del = h('button', { type: 'button', class: 'del', 'aria-label': `Delete ${d.name}`, title: 'Delete' });
        del.innerHTML = '<svg class="i"><use href="#i-trash"/></svg>';
        const card = h(
          'div',
          { class: 'design' },
          h(
            'button',
            { type: 'button', class: 'design-open', 'aria-label': `Open ${d.name}` },
            h('img', { src: d.thumb ?? '', alt: '' }),
            h('span', { class: 'meta' }, h('span', { class: 'name', text: d.name }), h('span', { class: 'when', text: fmt.format(new Date(d.savedAt)) })),
          ),
          del,
        );
        $('.design-open', card).addEventListener('click', () => {
          const look = store.loadDesign(d.id);
          if (!look) {
            toast('This design could not be read.');
            return;
          }
          this.record();
          this.setAnimating(false);
          this.applyLook(sanitizeLook(look));
          this.liveTime = this.look.time;
          toast(`Opened “${d.name}”`);
        });
        del.addEventListener('click', async () => {
          if (await confirmDialog(`Delete “${d.name}”?`, 'It will be removed from this browser.', 'Delete')) {
            store.deleteDesign(d.id);
            this.renderDesigns();
          }
        });
        return card;
      }),
    );
  }

  private fileBase(): string {
    const style = STYLES.find((s) => s.id === this.look.variation.style)!.name;
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    return `origami-waves-${store.slug(style)}-${stamp}`;
  }

  private async saveImage(): Promise<void> {
    this.settle();
    const btn = $<HTMLButtonElement>('#save-image');
    btn.disabled = true;
    try {
      const phone = matchMedia('(pointer: coarse)').matches;
      const canvas = this.viewer.snapshot(phone ? 2400 : 3000, phone ? 1600 : 2000);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image capture failed'))), 'image/png'));
      store.downloadBlob(blob, `${this.fileBase()}.png`);
      toast('Image saved');
    } catch (err) {
      toast(`Could not make the image: ${(err as Error).message}`, 4000);
    } finally {
      btn.disabled = false;
    }
  }

  /** Design file, rebuild script, canonical data and a .glb, ready to open in Blender. */
  private async saveBlender(): Promise<void> {
    this.settle();
    const base = import.meta.env.BASE_URL;
    const get = async (path: string) => {
      const r = await fetch(`${base}${path}`);
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    };
    const btn = $<HTMLButtonElement>('#save-blender');
    btn.disabled = true;
    try {
      const name = STYLES.find((s) => s.id === this.look.variation.style)!.name;
      const offsets = this.currentOffsets();
      const s = this.sculpture;
      const file = lookDesignFile(s, this.look, offsets, name);
      const { outer, inner } = s.shellVertices(s.tipsFromOffsets(offsets));
      const glb = buildDesignGlb(s, outer, inner, importedBoard(s), { includePresentation: true, designName: name, colors: this.look.colors });
      const [script, sculpture, source, presentation] = await Promise.all([
        get('downloads/rebuild_design.py'),
        get('assets/sculpture.json'),
        get('assets/sculpture-blender.json'),
        get('assets/presentation.json'),
      ]);
      const dir = this.fileBase();
      const readme = [
        `Origami Waves - Blender files for "${name}"`,
        '',
        'Quick look: in Blender choose File > Import > glTF 2.0 and open design.glb.',
        '',
        'Full scene (materials, lights and cameras, like the original file), Blender 4.2 or newer:',
        '',
        `  blender -b --factory-startup -P rebuild_design.py -- --design design.json --out ${dir}.blend`,
        '',
        'On macOS use /Applications/Blender.app/Contents/MacOS/Blender in place of "blender".',
        'Run the command from this folder, then open the .blend file.',
        '',
        `Colors: pyramids ${this.look.colors.outer}, inside ${this.look.colors.inner}, board ${this.look.colors.board}.`,
        '',
      ].join('\n');
      const bytes = zip([
        { name: `${dir}/README.txt`, data: readme },
        { name: `${dir}/design.glb`, data: glb },
        { name: `${dir}/design.json`, data: JSON.stringify(file, null, 1) },
        { name: `${dir}/rebuild_design.py`, data: script },
        { name: `${dir}/sculpture.json`, data: sculpture },
        { name: `${dir}/sculpture-blender.json`, data: source },
        { name: `${dir}/presentation.json`, data: presentation },
      ]);
      store.downloadBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), `${dir}-blender.zip`);
    } catch (err) {
      await confirmDialog('Could not make the Blender files', (err as Error).message, 'OK', null);
    } finally {
      btn.disabled = false;
    }
  }

  /* ================================================================ keyboard */

  private onKey(e: KeyboardEvent): void {
    const typing = (e.target as HTMLElement | null)?.closest('input[type="text"], textarea');
    if (typing) return;
    if (e.key === 'Escape') {
      if (document.body.classList.contains('info-open')) this.setInfo(false);
      else if (this.page === 'customize') location.hash = '';
      return;
    }
    if (this.page !== 'customize') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (e.key === ' ' && this.animating && !(e.target as HTMLElement).closest('button, input')) {
      e.preventDefault();
      this.setPlaying(!this.playing);
    }
  }

  /* ================================================================ verification */

  /** Checks the live page against the model (used by the documented browser checks). */
  selfTest() {
    this.settle();
    const s = this.sculpture;
    let innerErr = 0, baseErr = 0;
    for (let i = 0; i < s.count; i++) {
      const apex = s.roles[i * 4 + 3];
      for (let v = 0; v < 4; v++) {
        for (let k = 0; k < 3; k++) {
          const m = s.midpoints[i * 3 + k];
          innerErr = Math.max(innerErr, Math.abs(m + 0.75 * (this.outer[i * 12 + v * 3 + k] - m) - this.inner[i * 12 + v * 3 + k]));
          if (v !== apex) baseErr = Math.max(baseErr, Math.abs(this.outer[i * 12 + v * 3 + k] - s.originalVertices[i * 12 + v * 3 + k]));
        }
      }
    }
    // GPU buffers vs. geometry rebuilt from the model.
    const tmp = new Float64Array(FLOATS_PER_SHELL);
    let gpuErr = 0;
    const gpu = this.viewer.outer.positions();
    const gpuIn = this.viewer.inner.positions();
    const pr = s.data.presentation;
    for (let i = 0; i < s.count; i++) {
      writeThickShell(this.outer, i * 12, s.faces, i * 9, { thickness: pr.outerThicknessMm, offset: 1 }, tmp, null, 0);
      for (let j = 0; j < FLOATS_PER_SHELL; j++) gpuErr = Math.max(gpuErr, Math.abs(tmp[j] - gpu[i * FLOATS_PER_SHELL + j]));
      writeThickShell(this.inner, i * 12, s.faces, i * 9, { thickness: pr.innerThicknessMm, offset: -1 }, tmp, null, 0);
      for (let j = 0; j < FLOATS_PER_SHELL; j++) gpuErr = Math.max(gpuErr, Math.abs(tmp[j] - gpuIn[i * FLOATS_PER_SHELL + j]));
    }
    // GLB round trip of the shown pose.
    const glb = readGlb(buildDesignGlb(s, this.outer, this.inner, importedBoard(s), { includePresentation: false, designName: 'self-test' }));
    const nodes = new Map<string, any>(glb.json.nodes.map((n: any) => [n.name, n]));
    let glbErr = 0;
    for (let i = 0; i < s.count; i++) {
      for (const [suffix, arr] of [['', this.outer], [' INNER 75%', this.inner]] as const) {
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
    const r = validateShells(s, this.outer, this.inner);
    return {
      page: this.page,
      look: structuredClone(this.look),
      strength: this.strength,
      pieces: s.count,
      innerRuleMaxErrorMm: innerErr,
      baseMaxChangeMm: baseErr,
      viewportVsModelMaxErrorMm: gpuErr,
      glbVsPoseMaxErrorMm: glbErr,
      validation: { errors: r.issues.filter((i) => i.severity === 'error').length, warnings: r.issues.filter((i) => i.severity === 'warning').length, ms: r.ms, pairs: r.pairsTested },
    };
  }
}
