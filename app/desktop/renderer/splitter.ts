/**
 * Versleepbare scheiding tussen de TUI-pane (links) en de console-pane (rechts).
 * Stuurt de CSS-variabele `--left-width` op het grid; de terminals herschalen
 * automatisch mee via hun ResizeObserver. Breedte wordt onthouden in
 * localStorage; dubbelklik reset naar de default.
 */
const STORAGE_KEY = 'flux.leftWidth';
const MIN = 220;
const MAX_RATIO = 0.7;

export function setupSplitter(app: HTMLElement, splitter: HTMLElement): void {
  const apply = (px: number) => app.style.setProperty('--left-width', `${px}px`);

  const saved = Number(localStorage.getItem(STORAGE_KEY));
  if (saved > 0) apply(saved);

  let dragging = false;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
    document.body.classList.add('resizing');
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const max = window.innerWidth * MAX_RATIO;
    const w = Math.max(MIN, Math.min(max, e.clientX));
    apply(w);
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    const cur = parseInt(app.style.getPropertyValue('--left-width'), 10);
    if (cur > 0) localStorage.setItem(STORAGE_KEY, String(cur));
  });

  // Dubbelklik → terug naar de default (25%).
  splitter.addEventListener('dblclick', () => {
    app.style.removeProperty('--left-width');
    localStorage.removeItem(STORAGE_KEY);
  });
}
