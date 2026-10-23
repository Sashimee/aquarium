import { describe, expect, it } from 'vitest';
import {
  EffectsRecovery,
  EffectsSlot,
  isTransientFailure,
  type FrameEffects,
  type PhotoPost,
} from './effectsSlot';
import { PhotoLook } from './photo/look';

class FakeEffects implements FrameEffects {
  temporal = false;
  renders = 0;
  disposed = 0;
  focus: boolean[] = [];
  resized = 0;
  resizeError: Error | null = null;
  photo: (PhotoPost | null)[] = [];
  renderError: Error | null = null;
  focusError: Error | null = null;
  disposeError: Error | null = null;

  render(): void {
    this.renders += 1;
    if (this.renderError !== null) throw this.renderError;
  }

  setFocusMode(on: boolean): void {
    if (this.focusError !== null) throw this.focusError;
    this.focus.push(on);
  }

  setPhoto(photo: PhotoPost | null): void {
    this.photo.push(photo);
  }

  ownsMaterial(id: number): boolean {
    return id === 7;
  }

  tankResized(): void {
    if (this.resizeError !== null) throw this.resizeError;
    this.resized += 1;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    this.disposed += 1;
    if (this.disposeError !== null) throw this.disposeError;
  }
}

function setup() {
  const reports: { message: string; cause: unknown }[] = [];
  const temporal: boolean[] = [];
  const slot = new EffectsSlot(
    (message, cause) => reports.push({ message, cause }),
    (on) => temporal.push(on),
  );
  return { slot, reports, temporal };
}

describe('EffectsSlot', () => {
  it('asks for a plain render while nothing is attached', () => {
    const { slot, reports } = setup();
    expect(slot.render()).toBe(false);
    expect(slot.active).toBe(false);
    expect(reports).toEqual([]);
  });

  it('lets attached effects draw every frame', () => {
    const { slot } = setup();
    const effects = new FakeEffects();
    slot.attach(effects);
    expect(slot.render()).toBe(true);
    expect(slot.render()).toBe(true);
    expect(effects.renders).toBe(2);
  });

  it('applies the focus mode chosen before the effects arrived', () => {
    const { slot } = setup();
    slot.setFocusMode(true);
    const effects = new FakeEffects();
    slot.attach(effects);
    slot.setFocusMode(false);
    expect(effects.focus).toEqual([true, false]);
  });

  it('applies the photo look chosen before the effects arrived, then each change', () => {
    const { slot } = setup();
    const shot = { look: new PhotoLook(), depthOfField: true, graded: true };
    slot.setPhoto(shot);
    const effects = new FakeEffects();
    slot.attach(effects);
    slot.setPhoto(null);
    expect(effects.photo).toEqual([shot, null]);
  });

  it('is ready at once without effects, and when the attached ones are', async () => {
    const { slot } = setup();
    await expect(slot.ready()).resolves.toBeUndefined();
    const effects = new FakeEffects();
    let settle: () => void = () => undefined;
    effects.ready = () =>
      new Promise<void>((resolve) => {
        settle = () => resolve();
      });
    slot.attach(effects);
    let done = false;
    const ready = slot.ready().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    settle();
    await ready;
    expect(done).toBe(true);
  });

  it('refuses a second set of effects', () => {
    const { slot } = setup();
    slot.attach(new FakeEffects());
    expect(() => slot.attach(new FakeEffects())).toThrow(/already attached/);
  });

  it('reports a render failure once, disposes the effects and falls back for good', () => {
    const { slot, reports } = setup();
    const effects = new FakeEffects();
    const broken = new Error('shader build failed');
    effects.renderError = broken;
    slot.attach(effects);

    expect(slot.render()).toBe(false);
    expect(slot.render()).toBe(false);
    expect(slot.render()).toBe(false);

    expect(effects.renders).toBe(1);
    expect(effects.disposed).toBe(1);
    expect(slot.active).toBe(false);
    expect(reports).toEqual([{ message: expect.stringMatching(/effects failed/), cause: broken }]);
  });

  it('drops the effects when switching focus mode fails', () => {
    const { slot, reports } = setup();
    const effects = new FakeEffects();
    slot.attach(effects);
    const broken = new Error('depth of field build failed');
    effects.focusError = broken;

    expect(() => slot.setFocusMode(true)).not.toThrow();
    expect(slot.active).toBe(false);
    expect(effects.disposed).toBe(1);
    expect(reports.map((r) => r.cause)).toEqual([broken]);
    expect(slot.render()).toBe(false);
  });

  it('passes a tank resize on, and drops the effects when it fails', () => {
    const { slot, reports } = setup();
    slot.tankResized();
    const effects = new FakeEffects();
    slot.attach(effects);
    slot.tankResized();
    expect(effects.resized).toBe(1);

    const broken = new Error('resize failed');
    effects.resizeError = broken;
    expect(() => slot.tankResized()).not.toThrow();
    expect(slot.active).toBe(false);
    expect(reports.map((r) => r.cause)).toEqual([broken]);
  });

  it('drops effects that fail while being attached', () => {
    const { slot, reports } = setup();
    slot.setFocusMode(true);
    const effects = new FakeEffects();
    effects.focusError = new Error('broken');
    slot.attach(effects);
    expect(slot.active).toBe(false);
    expect(effects.disposed).toBe(1);
    expect(reports).toHaveLength(1);
  });

  it('reports a dispose failure after a render failure and still falls back', () => {
    const { slot, reports } = setup();
    const effects = new FakeEffects();
    const renderError = new Error('render');
    const disposeError = new Error('dispose');
    effects.renderError = renderError;
    effects.disposeError = disposeError;
    slot.attach(effects);

    expect(slot.render()).toBe(false);
    expect(reports.map((r) => r.cause)).toEqual([renderError, disposeError]);
    expect(slot.render()).toBe(false);
    expect(effects.renders).toBe(1);
  });

  it('asks the attached effects which materials they own', () => {
    const { slot } = setup();
    expect(slot.ownsMaterial(7)).toBe(false);
    slot.attach(new FakeEffects());
    expect(slot.ownsMaterial(7)).toBe(true);
    expect(slot.ownsMaterial(8)).toBe(false);
  });

  it('drops the effects for a failure found outside their calls', () => {
    const { slot, reports, temporal } = setup();
    const effects = new FakeEffects();
    effects.temporal = true;
    slot.attach(effects);
    const broken = new Error('pipeline creation failed');
    slot.fail(broken);
    expect(slot.active).toBe(false);
    expect(effects.disposed).toBe(1);
    expect(reports.map((r) => r.cause)).toEqual([broken]);
    expect(temporal).toEqual([true, false]);
    expect(slot.render()).toBe(false);
  });

  it('ignores a failure once nothing is attached', () => {
    const { slot, reports } = setup();
    slot.fail(new Error('late pipeline failure'));
    expect(reports).toEqual([]);
  });

  it('disposes the attached effects once', () => {
    const { slot } = setup();
    const effects = new FakeEffects();
    slot.attach(effects);
    slot.dispose();
    slot.dispose();
    expect(effects.disposed).toBe(1);
    expect(slot.render()).toBe(false);
  });

  it('resolves temporally only while attached effects do', () => {
    const { slot, temporal } = setup();
    expect(slot.temporal).toBe(false);
    const effects = new FakeEffects();
    effects.temporal = true;
    slot.attach(effects);
    expect(slot.temporal).toBe(true);
    effects.temporal = false;
    slot.refresh();
    slot.refresh();
    expect(slot.temporal).toBe(false);
    effects.temporal = true;
    slot.render();
    expect(temporal).toEqual([true, false, true]);
    slot.dispose();
    expect(slot.temporal).toBe(false);
    expect(temporal).toEqual([true, false, true, false]);
  });

  it('stops resolving temporally once failed effects are dropped', () => {
    const { slot, temporal } = setup();
    const effects = new FakeEffects();
    effects.temporal = true;
    slot.attach(effects);
    effects.renderError = new Error('TRAA pipeline failed');
    expect(slot.render()).toBe(false);
    expect(slot.temporal).toBe(false);
    expect(temporal).toEqual([true, false]);
  });

  it('stops resolving temporally even when disposing throws', () => {
    const { slot, temporal } = setup();
    const effects = new FakeEffects();
    effects.temporal = true;
    effects.disposeError = new Error('dispose');
    slot.attach(effects);
    expect(() => slot.dispose()).toThrow('dispose');
    expect(slot.temporal).toBe(false);
    expect(temporal).toEqual([true, false]);
  });

  it('tells the owner which failure dropped the effects, after they are gone', () => {
    const dropped: { cause: unknown; active: boolean }[] = [];
    const slot: EffectsSlot = new EffectsSlot(
      () => undefined,
      () => undefined,
      (cause) => dropped.push({ cause, active: slot.active }),
    );
    const effects = new FakeEffects();
    slot.attach(effects);
    effects.renderError = new Error('post failed');
    slot.render();
    slot.fail(new Error('late'));
    expect(dropped).toEqual([{ cause: new Error('post failed'), active: false }]);
  });
});

const SUBMIT_FAILURE = new Error(
  'THREE.WebGPURenderer: Async render pipeline creation failed (renderPipeline_fish:angelfish:' +
    'texture_1_223): Destroyed texture [Texture "ShadowDepthTexture"] used in a submit.',
);

describe('isTransientFailure', () => {
  it('tells a submit that used a freed texture from a pipeline that cannot build', () => {
    expect(isTransientFailure(SUBMIT_FAILURE)).toBe(true);
    expect(isTransientFailure(new Error('Invalid ShaderModule: unresolved sampler'))).toBe(false);
    expect(isTransientFailure('used in a submit')).toBe(false);
  });
});

describe('EffectsRecovery', () => {
  function setup(delaysMs?: readonly number[]) {
    const pending: { run: () => void; delayMs: number; cancelled: boolean }[] = [];
    let rebuilds = 0;
    const recovery = new EffectsRecovery(
      () => rebuilds++,
      (run, delayMs) => {
        const entry = { run, delayMs, cancelled: false };
        pending.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
      delaysMs,
    );
    const fire = () => {
      const entry = pending.shift();
      if (entry !== undefined && !entry.cancelled) entry.run();
    };
    return { recovery, pending, fire, rebuilds: () => rebuilds };
  }

  it('brings the effects back after a transient failure dropped them', () => {
    const slot: EffectsSlot = new EffectsSlot(
      () => undefined,
      () => undefined,
      (cause) => recovery.dropped(cause),
    );
    const recovery = new EffectsRecovery(
      () => slot.attach(new FakeEffects()),
      (run) => {
        queued.push(run);
        return () => undefined;
      },
    );
    const queued: (() => void)[] = [];
    slot.attach(new FakeEffects());
    slot.fail(SUBMIT_FAILURE);
    expect(slot.active).toBe(false);
    for (const run of queued.splice(0)) run();
    expect(slot.active).toBe(true);
    expect(slot.render()).toBe(true);
  });

  it('leaves the effects dropped after a failure that is not transient', () => {
    const { recovery, pending } = setup();
    expect(recovery.dropped(new Error('shader failed'))).toBe(false);
    expect(pending).toEqual([]);
  });

  it('backs off between rebuilds and gives up after the last delay', () => {
    const { recovery, pending, fire, rebuilds } = setup([10, 20]);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const scheduled = recovery.dropped(SUBMIT_FAILURE);
      delays.push(pending[0]?.delayMs ?? -1);
      expect(scheduled).toBe(i < 2);
      fire();
    }
    expect(delays).toEqual([10, 20, -1]);
    expect(rebuilds()).toBe(2);
  });

  it('schedules one rebuild for drops that arrive while one is pending', () => {
    const { recovery, pending } = setup();
    recovery.dropped(SUBMIT_FAILURE);
    expect(recovery.dropped(SUBMIT_FAILURE)).toBe(false);
    expect(pending).toHaveLength(1);
  });

  it('cancels a pending rebuild on dispose', () => {
    const { recovery, fire, rebuilds } = setup();
    recovery.dropped(SUBMIT_FAILURE);
    recovery.dispose();
    fire();
    expect(rebuilds()).toBe(0);
  });
});
