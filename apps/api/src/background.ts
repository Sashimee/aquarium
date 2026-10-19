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
  afterDrain?(abandoned: number): Promise<void>;
  budgetMs: number;
}

// budgetMs covers closeApp and the drain together, so the sequence ends before the
// orchestrator's stop grace period turns into SIGKILL.
export async function shutdown(deps: ShutdownDeps): Promise<void> {
  const startedAt = Date.now();
  deps.stopMaintenance();
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.budgetMs);
  });
  try {
    const outcome = await Promise.race([deps.closeApp().then(() => 'closed' as const), elapsed]);
    if (outcome === 'timeout') console.error('shutdown: app.close() outlasted the budget');
  } finally {
    clearTimeout(timer);
  }
  const remaining = Math.max(0, deps.budgetMs - (Date.now() - startedAt));
  const { abandoned } = await deps.tasks.drain(remaining);
  if (abandoned > 0) {
    console.error(
      `shutdown: abandoned ${abandoned} background task(s) at the ${deps.budgetMs} ms budget`,
    );
  }
  if (abandoned > 0) await deps.afterDrain?.(abandoned);
  await deps.closeDatabase();
}
