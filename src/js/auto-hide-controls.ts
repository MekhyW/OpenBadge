export function setupAutoHideControls(hideAfterMs = 4000): void {
  let timer = 0;

  const show = (): void => {
    document.body.classList.add('controls-visible');
    window.clearTimeout(timer);
    timer = window.setTimeout(() => document.body.classList.remove('controls-visible'), hideAfterMs);
  };

  window.addEventListener('pointerdown', show, { capture: true, passive: true });
  window.addEventListener('keydown', (event) => { if (event.key === 'Tab') show(); }, { capture: true });
  document.addEventListener('focusin', (event) => {
    if ((event.target as HTMLElement).closest?.('.auto-hide')) show();
  });
}
