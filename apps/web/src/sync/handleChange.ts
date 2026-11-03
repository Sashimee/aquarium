type Listener = (handle: string | null) => void;

const listeners = new Set<Listener>();

export function onOwnHandleChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function announceOwnHandle(handle: string | null): void {
  for (const listener of [...listeners]) listener(handle);
}
