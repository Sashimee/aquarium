export interface NoticeAction {
  readonly label: string;
  run(): void;
}

const STACK_CLASS = 'engine-notices';

/** Notices share one column so a WebGL 2 notice and a later loss notice stack, not overlap. */
function noticeStack(parent: HTMLElement): HTMLElement {
  const existing = parent.querySelector<HTMLElement>(`:scope > .${STACK_CLASS}`);
  if (existing) return existing;
  const stack = document.createElement('div');
  stack.className = STACK_CLASS;
  Object.assign(stack.style, {
    position: 'fixed',
    top: 'max(0.75rem, env(safe-area-inset-top))',
    left: '50%',
    transform: 'translateX(-50%)',
    // Above the loading screen (20): a phone can lose its device while the tank's textures upload.
    zIndex: '30',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.5rem',
    width: 'min(30rem, calc(100% - 1.5rem))',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  parent.appendChild(stack);
  return stack;
}

/**
 * A banner about the graphics device, above the UI overlay. The engine shows it itself because the
 * overlay may be what failed to draw; the action defaults to dismissing it.
 */
export function showDeviceNotice(
  parent: HTMLElement,
  message: string,
  action?: NoticeAction,
): () => void {
  const box = document.createElement('div');
  box.className = 'engine-notice';
  box.setAttribute('role', 'alert');
  Object.assign(box.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    maxWidth: '100%',
    pointerEvents: 'auto',
    padding: '0.5rem 0.5rem 0.5rem 1rem',
    borderRadius: '1rem',
    background: 'var(--glass-strong, rgba(10, 20, 32, 0.9))',
    border: '1px solid var(--glass-edge, rgba(255, 255, 255, 0.16))',
    color: 'var(--ink, #f4f7fa)',
    font: '15px/1.4 system-ui, sans-serif',
  } satisfies Partial<CSSStyleDeclaration>);

  const text = document.createElement('span');
  text.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = action?.label ?? 'Dismiss';
  Object.assign(button.style, {
    flex: 'none',
    padding: '0.35rem 0.85rem',
    border: '0',
    borderRadius: '99rem',
    background: 'var(--accent, #7fd1ff)',
    color: 'var(--accent-ink, #04141f)',
    font: 'inherit',
    fontWeight: '600',
    cursor: 'pointer',
  } satisfies Partial<CSSStyleDeclaration>);

  const stack = noticeStack(parent);
  const remove = () => {
    box.remove();
    if (stack.childElementCount === 0) stack.remove();
  };
  button.addEventListener('click', () => {
    remove();
    action?.run();
  });
  box.append(text, button);
  stack.appendChild(box);
  return remove;
}
