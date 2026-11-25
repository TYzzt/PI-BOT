/** Heights are natural content CSS pixels, independent of the native viewport cap. */
export function observeUiHeight(root: HTMLElement, post: (value: {type: 'height'; height: number; width: number}) => void) {
  let frame = 0, lastHeight = -1, lastWidth = -1;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const height = Math.ceil(Math.max(root.getBoundingClientRect().height, root.scrollHeight));
      const width = window.innerWidth;
      if (height !== lastHeight || width !== lastWidth) {
        lastHeight = height; lastWidth = width;
        post({type: 'height', height, width});
      }
    });
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(root);
  window.addEventListener('resize', schedule);
  schedule();
  return () => { observer.disconnect(); window.removeEventListener('resize', schedule); cancelAnimationFrame(frame); };
}
