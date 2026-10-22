export interface TrailingCall {
  schedule(): void;
  flush(): void;
  cancel(): void;
}

export function trailingCall(run: () => void, waitMs: number): TrailingCall {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  return {
    schedule() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, waitMs);
    },
    flush() {
      if (timer === null) return;
      cancel();
      run();
    },
    cancel,
  };
}
