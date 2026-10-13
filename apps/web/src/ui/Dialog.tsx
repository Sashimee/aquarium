import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** A modal that takes focus on open, keeps Tab inside, closes on Escape and gives focus back. */
export function Dialog({
  title,
  onClose,
  children,
  tone = 'calm',
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  tone?: 'calm' | 'loss';
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    heading.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab' || !box.current) return;
    const focusable = box.current.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input, select, [tabindex="0"]',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="dialog-backdrop" onKeyDown={onKeyDown}>
      <div
        ref={box}
        className={`panel dialog ${tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <h2 id="dialog-title" ref={heading} tabIndex={-1}>
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.getElementById('ui') ?? document.body,
  );
}
