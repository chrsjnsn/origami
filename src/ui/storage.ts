/**
 * Designs saved in this browser (localStorage). Every access is guarded: storage can be
 * unavailable (private windows, blocked site data) and the site must keep working without it.
 */

import type { Look } from '../core/look';

const INDEX_KEY = 'ow.designs.v1';
const ITEM_PREFIX = 'ow.design.v1.';
const CURRENT_KEY = 'ow.current.v1';

export interface SavedDesign {
  id: string;
  name: string;
  savedAt: string;
  thumb?: string;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export function listDesigns(): SavedDesign[] {
  return (read<SavedDesign[]>(INDEX_KEY) ?? []).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function saveDesign(name: string, look: Look, thumb?: string): SavedDesign | null {
  const list = read<SavedDesign[]>(INDEX_KEY) ?? [];
  const meta: SavedDesign = {
    id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    savedAt: new Date().toISOString(),
    thumb,
  };
  if (!write(ITEM_PREFIX + meta.id, look)) return null;
  if (!write(INDEX_KEY, [meta, ...list])) {
    // Probably out of space: try again without the thumbnail.
    delete meta.thumb;
    if (!write(INDEX_KEY, [meta, ...list])) {
      remove(ITEM_PREFIX + meta.id);
      return null;
    }
  }
  return meta;
}

export function loadDesign(id: string): Look | null {
  return read<Look>(ITEM_PREFIX + id);
}

export function deleteDesign(id: string): void {
  remove(ITEM_PREFIX + id);
  write(INDEX_KEY, (read<SavedDesign[]>(INDEX_KEY) ?? []).filter((d) => d.id !== id));
}

/** The look being customized, restored on the next visit. */
export function saveCurrent(look: Look): void {
  write(CURRENT_KEY, look);
}

export function loadCurrent(): Look | null {
  return read<Look>(CURRENT_KEY);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'design'
  );
}
