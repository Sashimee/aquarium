import { describe, expect, it, vi } from 'vitest';
import { FoodLink, type AteEvent, type FoodBridge } from './link';
import { FoodField, type FoodEnvironment } from './particles';
import { sceneToSim } from './simSpace';

const env: FoodEnvironment = {
  bounds: { minX: -0.5, maxX: 0.5, minZ: -0.2, maxZ: 0.2, waterTop: 0.45 },
  groundHeight: () => 0.05,
  current: (_x, _y, _z, out) => {
    out[0] = out[1] = out[2] = 0;
  },
};

function setup(bridge: FoodBridge) {
  const field = new FoodField(env, () => 0.5);
  const onEaten = vi.fn();
  const link = new FoodLink(
    field,
    bridge,
    sceneToSim(() => 0.05),
    onEaten,
  );
  return { field, link, onEaten };
}

describe('FoodLink', () => {
  it('sends one buffer per sim tick', () => {
    const setFood = vi.fn();
    const { field, link } = setup({ setFood });
    field.drop('pellets', 1, 0, 0);
    link.update(1 / 100);
    expect(setFood).not.toHaveBeenCalled();
    link.update(1 / 40);
    expect(setFood).toHaveBeenCalledTimes(1);
    const sent = setFood.mock.calls[0]?.[0] as Float32Array;
    expect(sent.length).toBe(field.count * 5);
  });

  it('does nothing without a sim, so particles still render and settle', () => {
    const { field, link, onEaten } = setup({});
    field.drop('pellets', 1, 0, 0);
    expect(() => link.update(1)).not.toThrow();
    expect(field.count).toBeGreaterThan(0);
    expect(onEaten).not.toHaveBeenCalled();
  });

  it('removes eaten particles and reports each fish portion once', () => {
    const { field, link, onEaten } = setup({});
    field.drop('pellets', 1, 0, 0);
    const [a, b] = field.particles;
    const events: AteEvent[] = [
      { fishId: 'f1', foodId: a?.id ?? -1, portion: 0.3 },
      { fishId: 'f2', foodId: a?.id ?? -1, portion: 0.3 },
      { fishId: 'f2', foodId: b?.id ?? -1, portion: 0.2 },
      { fishId: 'f3', foodId: 424242, portion: 0.5 },
    ];
    const before = field.count;
    link.handleAte(events);
    expect(field.count).toBe(before - 2);
    expect(onEaten).toHaveBeenCalledWith([
      { fishId: 'f1', portion: 0.3 },
      { fishId: 'f2', portion: 0.2 },
    ]);
  });

  it('stays silent when nothing eaten is known', () => {
    const { link, onEaten } = setup({});
    link.handleAte([{ fishId: 'f1', foodId: 77, portion: 1 }]);
    expect(onEaten).not.toHaveBeenCalled();
  });

  it('subscribes to ate events and detaches on dispose', () => {
    const holder: { listener?: (e: readonly AteEvent[]) => void } = {};
    const off = vi.fn();
    const { field, link, onEaten } = setup({
      onAte: (l) => {
        holder.listener = l;
        return off;
      },
    });
    field.drop('pellets', 1, 0, 0);
    holder.listener?.([{ fishId: 'f1', foodId: field.particles[0]?.id ?? -1, portion: 0.1 }]);
    expect(onEaten).toHaveBeenCalledTimes(1);
    link.dispose();
    expect(off).toHaveBeenCalled();
  });
});
