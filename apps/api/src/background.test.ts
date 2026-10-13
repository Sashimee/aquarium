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

  it('keeps the pool open until a pending task that uses it has finished', async () => {
    harness = await createHarness();
    const { database } = harness;
    const tasks = createBackgroundTasks();
    const gate = deferred();
    let result = 0;
    tasks.run(
      gate.promise.then(async () => {
        const rows = await database.db.execute(sql`select 1 as one`);
        result = Number(rows.rows[0]?.['one']);
      }),
    );

    const order: string[] = [];
    const done = shutdown({
      stopMaintenance: () => order.push('maintenance'),
      closeApp: async () => {
        order.push('app');
      },
      tasks,
      closeDatabase: async () => {
        order.push('db');
        await database.close();
      },
      drainTimeoutMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['maintenance', 'app']);

    gate.resolve();
    await done;
    expect(order).toEqual(['maintenance', 'app', 'db']);
    expect(result).toBe(1);
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
      drainTimeoutMs: 30,
    });
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('abandoned 1 background task'));
    never.resolve();
  });
});
