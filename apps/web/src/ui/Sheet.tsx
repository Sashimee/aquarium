import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { OpenPanel } from './panels';

const DISMISS_DRAG_PX = 80;

/** A bottom sheet on phones and a side drawer on wide screens; one is mounted at a time. */
export function Sheet({
  panel,
  label,
  title,
  closeLabel = 'Close',
  onClose,
  children,
}: {
  panel: OpenPanel;
  label: string;
  title: string;
  closeLabel?: string;
  onClose(): void;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<number | null>(null);

  useEffect(() => {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    heading.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const node = root.current;
    return () => {
      document.removeEventListener('keydown', onKey);
      const active = document.activeElement;
      if (active && active !== document.body && !node?.contains(active)) return;
      const target = opener?.isConnected
        ? opener
        : document.querySelector<HTMLElement>(`[data-opener="${panel}"]`);
      target?.focus({ preventScroll: true });
    };
  }, [panel]);

  const down = (e: PointerEvent) => {
    start.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(0);
  };
  const move = (e: PointerEvent) => {
    if (start.current === null) return;
    setDrag(Math.max(0, e.clientY - start.current));
  };
  const up = () => {
    const dragged = drag ?? 0;
    start.current = null;
    setDrag(null);
    if (dragged > DISMISS_DRAG_PX) onClose();
  };

  return (
    <section
      ref={root}
      id={`panel-${panel}`}
      className={`sheet sheet-${panel}`}
      aria-label={label}
      style={drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined}
    >
      <div
        className="sheet-grab"
        aria-hidden="true"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <span />
      </div>
      <div className="panel-head">
        <h2 ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <button type="button" onClick={onClose}>
          {closeLabel}
        </button>
      </div>
      <div className="sheet-body">{children}</div>
    </section>
  );
}
