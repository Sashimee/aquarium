import { describe, expect, it } from 'vitest';
import { EffectsSlot, type FrameEffects } from './effectsSlot';

class FakeEffects implements FrameEffects {
  renders = 0;
  disposed = 0;
  focus: boolean[] = [];
  renderError: Error | null = null;
  focusError: Error | null = null;
  disposeError: Error | null = null;
  drawsFrame = true;

  render(): boolean {
    this.renders += 1;
    if (this.renderError !== null) throw this.renderError;
    return this.drawsFrame;
  }

  setFocusMode(on: boolean): void {
    if (this.focusError !== null) throw this.focusError;
    this.focus.push(on);
  }

  dispose(): void {
    this.disposed += 1;
    if (this.disposeError !== null) throw this.disposeError;
  }
}

function setup() {
  const reports: { message: string; cause: unknown }[] = [];
  const slot = new EffectsSlot((message, cause) => reports.push({ message, cause }));
  return { slot, reports };
}

describe('EffectsSlot', () => {
  it('asks for a plain render while nothing is attached', () => {
    const { slot, reports } = setup();
    expect(slot.render()).toBe(false);
    expect(slot.active).toBe(false);
    expect(reports).toEqual([]);
  });

  it('passes through whether the effects drew the frame', () => {
    const { slot } = setup();
    const effects = new FakeEffects();
    slot.attach(effects);
    expect(slot.render()).toBe(true);
    effects.drawsFrame = false;
    expect(slot.render()).toBe(false);
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

  it('disposes the attached effects once', () => {
    const { slot } = setup();
    const effects = new FakeEffects();
    slot.attach(effects);
    slot.dispose();
    slot.dispose();
    expect(effects.disposed).toBe(1);
    expect(slot.render()).toBe(false);
  });
});
