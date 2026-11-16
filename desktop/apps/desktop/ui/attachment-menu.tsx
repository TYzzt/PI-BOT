import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './icons.js';

export function AttachmentMenu({ disabled, onFiles }: { disabled: boolean; onFiles: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const unavailable = disabled;
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);
  useLayoutEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[index]?.focus();
    }
  };
  return <div className="attachment-picker" ref={root} onKeyDown={key}>
    <button type="button" ref={trigger} className="attach ghost" disabled={unavailable} aria-label="添加附件" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(value => !value)}><Icon name="plus" /></button>
    {open && <div className="attachment-menu" role="menu" aria-label="添加附件" id={menuId}>
      <button type="button" role="menuitem" disabled={disabled} title="选择文件，每份最多 10 MiB" onClick={() => { close(); onFiles(); }}>文件</button>
    </div>}
  </div>;
}
