export type CleanupStep = () => void | Promise<void>;

/** Releases acquired resources in reverse order; a failing step does not stop the rest. */
export class DisposeStack {
  private readonly steps: CleanupStep[] = [];
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  get size(): number {
    return this.steps.length;
  }

  add(step: CleanupStep): void {
    if (this.disposed) throw new Error('DisposeStack: add() after dispose()');
    this.steps.push(step);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (let step = this.steps.pop(); step; step = this.steps.pop()) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `DisposeStack: ${errors.length} cleanup step(s) failed`);
    }
  }
}

/** Runs every step, last first, then throws the failures of any that threw together. */
export function releaseAll(steps: readonly (() => void)[], owner: string): void {
  const errors: unknown[] = [];
  for (const step of [...steps].reverse()) {
    try {
      step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${owner}: ${errors.length} cleanup step(s) failed`);
  }
}

/**
 * Runs `build`, registering cleanups on the stack as resources are acquired. If `build`
 * throws, everything acquired so far is released and the original error is rethrown;
 * cleanup failures go to `onCleanupError` so they cannot mask it.
 */
export async function buildOrRelease<T>(
  build: (cleanup: DisposeStack) => Promise<T>,
  onCleanupError: (error: unknown) => void,
): Promise<T> {
  const cleanup = new DisposeStack();
  try {
    return await build(cleanup);
  } catch (error) {
    await cleanup.dispose().catch(onCleanupError);
    throw error;
  }
}
