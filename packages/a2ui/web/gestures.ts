/** Native handoff must leave controls, maps, nested scrollers and selection to WebKit. */
export function canScrollAt(x: number, y: number): boolean {
  if (window.getSelection()?.type === 'Range') return false;
  let target = document.elementFromPoint(x * innerWidth, y * innerHeight);
  if (!target) return false;
  if (target.closest('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"]),[role="slider"],[draggable="true"],.leaflet-container,[data-aui="map"]')) return false;
  while (target && target !== document.body && target !== document.documentElement) {
    const style = getComputedStyle(target);
    if (style.touchAction === 'none' || style.touchAction === 'pan-x' ||
        (/(auto|scroll)/.test(style.overflowY) && target.scrollHeight > target.clientHeight + 1)) return false;
    target = target.parentElement;
  }
  return true;
}
