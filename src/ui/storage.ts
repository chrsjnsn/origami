/**
 * Named designs saved in this browser (localStorage). Every access is guarded: storage can be
 * unavailable (private windows, blocked site data) and the app must keep working without it.
 */

import type { DesignFile } from '../core/design';

const INDEX_KEY = 'o1829.designs.v1';
const ITEM_PREFIX = 'o1829.design.v1.';
const DRAFT_KEY = 'o1829.draft.v1';

export interface SavedDesignMeta {
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

export function listDesigns(): SavedDesignMeta[] {
  return (read<SavedDesignMeta[]>(INDEX_KEY) ?? []).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function saveDesign(file: DesignFile, thumb?: string, id?: string): SavedDesignMeta | null {
  const list = read<SavedDesignMeta[]>(INDEX_KEY) ?? [];
  const existing = id ? list.find((d) => d.id === id) : list.find((d) => d.name === file.name);
  const meta: SavedDesignMeta = {
    id: existing?.id ?? `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: file.name,
    savedAt: file.savedAt,
    thumb,
  };
  if (!write(ITEM_PREFIX + meta.id, file)) return null;
  const next = [meta, ...list.filter((d) => d.id !== meta.id)];
  if (!write(INDEX_KEY, next)) {
    // Thumbnails are the first thing to drop when storage is tight.
    next.forEach((d) => delete d.thumb);
    if (!write(INDEX_KEY, next)) return null;
  }
  return meta;
}

export function loadDesignFile(id: string): DesignFile | null {
  return read<DesignFile>(ITEM_PREFIX + id);
}

export function deleteDesign(id: string): void {
  remove(ITEM_PREFIX + id);
  write(INDEX_KEY, (read<SavedDesignMeta[]>(INDEX_KEY) ?? []).filter((d) => d.id !== id));
}

export function saveDraft(file: DesignFile): void {
  write(DRAFT_KEY, file);
}

export function loadDraft(): DesignFile | null {
  return read<DesignFile>(DRAFT_KEY);
}

export function clearDraft(): void {
  remove(DRAFT_KEY);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'design'
  );
}
