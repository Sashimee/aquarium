import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createBackgroundTasks, shutdown } from './background.ts';
import { createHarness, type Harness } from './test-harness.ts';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('background tasks', () => {
  it('waits for a pending task and forgets it once it resolves', async () => {
    const tasks = createBackgroundTasks();
    const gate = deferred();
    tasks.run(gate.promise);
    expect(tasks.pending).toBe(1);

    let drained = false;
    const drain = tasks.drain(5000).then((r) => {
      drained = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);

    gate.resolve();
    expect(await drain).toEqual({ abandoned: 0 });
    expect(tasks.pending).toBe(0);
  });

  it('abandons tasks that outlast the timeout and reports how many', async () => {
    const tasks = createBackgroundTasks();
    const first = deferred();
    const second = deferred();
    tasks.run(first.promise);
    tasks.run(second.promise);
    expect(await tasks.drain(30)).toEqual({ abandoned: 2 });
    first.resolve();
    second.resolve();
  });

  it('drops a rejected task without an unhandled rejection and logs only the error name', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const tasks = createBackgroundTasks();
      const gate = deferred();
      tasks.run(gate.promise);
      gate.reject(new Error('smtp said no to someone@bas.lu token=abc'));
      expect(await tasks.drain(1000)).toEqual({ abandoned: 0 });
      await new Promise((r) => setImmediate(r));
      expect(tasks.pending).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
      expect(JSON.stringify(logged.mock.calls)).not.toMatch(/bas\.lu|token/);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('returns immediately when nothing is running', async () => {
    expect(await createBackgroundTasks().drain(10_000)).toEqual({ abandoned: 0 });
  });
});

describe('shutdown', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.dropDatabase();
    harness = undefined;
  });

  it('keeps the pool open for tasks pending or queued during app.close()', async () => {
    harness = await createHarness();
    const { database } = harness;
    const tasks = createBackgroundTasks();
    const gate = deferred();
    const late = deferred();
    const results: number[] = [];
    const query = async () => {
      const rows = await database.db.execute(sql`select 1 as one`);
      results.push(Number(rows.rows[0]?.['one']));
    };
    tasks.run(gate.promise.then(query));

    const order: string[] = [];
    const done = shutdown({
      stopMaintenance: () => order.push('maintenance'),
      closeApp: async () => {
        order.push('app');
        await new Promise((r) => setTimeout(r, 10));
        tasks.run(late.promise.then(query));
      },
      tasks,
      closeDatabase: async () => {
        order.push('db');
        await database.close();
      },
      budgetMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['maintenance', 'app']);

    gate.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['maintenance', 'app']);

    late.resolve();
    await done;
    expect(order).toEqual(['maintenance', 'app', 'db']);
    expect(results).toEqual([1, 1]);
  });

  it('runs afterDrain before closing the database, only when tasks were abandoned', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = async (hang: boolean) => {
      const tasks = createBackgroundTasks();
      const gate = deferred();
      if (hang) tasks.run(gate.promise);
      const order: string[] = [];
      await shutdown({
        stopMaintenance: () => undefined,
        closeApp: async () => undefined,
        tasks,
        afterDrain: async (abandoned) => {
          order.push(`release:${abandoned}`);
        },
        closeDatabase: async () => {
          order.push('db');
        },
        budgetMs: 30,
      });
      gate.resolve();
      return order;
    };
    expect(await run(true)).toEqual(['release:1', 'db']);
    expect(await run(false)).toEqual(['db']);
  });

  it('logs the abandoned count on timeout, then still closes the database', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tasks = createBackgroundTasks();
    const never = deferred();
    tasks.run(never.promise);
    const closeDatabase = vi.fn(async () => {});
    await shutdown({
      stopMaintenance: () => {},
      closeApp: async () => {},
      tasks,
      closeDatabase,
      budgetMs: 30,
    });
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('abandoned 1 background task'));
    never.resolve();
  });

  it('spends one budget across app.close() and the drain', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tasks = createBackgroundTasks();
    const never = deferred();
    tasks.run(never.promise);
    const startedAt = Date.now();
    await shutdown({
      stopMaintenance: () => {},
      closeApp: () => new Promise((r) => setTimeout(r, 150)),
      tasks,
      closeDatabase: async () => {},
      budgetMs: 200,
    });
    expect(Date.now() - startedAt).toBeLessThan(400);
    never.resolve();
  });
});
