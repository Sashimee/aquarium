export interface BackgroundTasks {
  run(task: Promise<void>): void;
  readonly pending: number;
  drain(timeoutMs: number): Promise<{ abandoned: number }>;
}

export function createBackgroundTasks(): BackgroundTasks {
  const inFlight = new Set<Promise<void>>();

  return {
    run(task) {
      inFlight.add(task);
      const settle = () => {
        inFlight.delete(task);
      };
      task.then(settle, (err: unknown) => {
        settle();
        console.error('background task failed:', err instanceof Error ? err.name : 'unknown');
      });
    },
    get pending() {
      return inFlight.size;
    },
    async drain(timeoutMs) {
      if (inFlight.size === 0) return { abandoned: 0 };
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const settled = Promise.allSettled([...inFlight]).then(() => 'done' as const);
      try {
        await Promise.race([settled, timedOut]);
      } finally {
        clearTimeout(timer);
      }
      return { abandoned: inFlight.size };
    },
  };
}

export interface ShutdownDeps {
  stopMaintenance(): void;
  closeApp(): Promise<unknown>;
  tasks: BackgroundTasks;
  closeDatabase(): Promise<void>;
  drainTimeoutMs: number;
}

export async function shutdown(deps: ShutdownDeps): Promise<void> {
  deps.stopMaintenance();
  await deps.closeApp();
  const { abandoned } = await deps.tasks.drain(deps.drainTimeoutMs);
  if (abandoned > 0) {
    console.error(
      `shutdown: abandoned ${abandoned} background task(s) after ${deps.drainTimeoutMs} ms`,
    );
  }
  await deps.closeDatabase();
}
