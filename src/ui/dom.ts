/** Small DOM helpers shared by the UI. */

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
}

export function $$<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(sel)];
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

/** Paint the filled part of a range input track. */
export function paintRange(input: HTMLInputElement): void {
  const min = Number(input.min || 0), max = Number(input.max || 100);
  const pct = ((Number(input.value) - min) / (max - min || 1)) * 100;
  input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
}

let toastTimer = 0;
export function toast(message: string, ms = 2200): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

export function confirmDialog(title: string, body: string, ok = 'OK', cancel: string | null = 'Cancel'): Promise<boolean> {
  const dialog = document.getElementById('dialog') as HTMLDialogElement;
  $('#dialog-title', dialog).textContent = title;
  $('#dialog-body', dialog).textContent = body;
  $('#dialog-ok', dialog).textContent = ok;
  const cancelBtn = $('#dialog-cancel', dialog);
  cancelBtn.hidden = cancel === null;
  if (cancel) cancelBtn.textContent = cancel;
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.returnValue = '';
    dialog.showModal();
  });
}
