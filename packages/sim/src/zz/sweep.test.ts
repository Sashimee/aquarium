import { it } from 'vitest';
import { BEHAVIOUR } from '../behaviour.ts';
import {
  ARCHETYPES,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  royalGramma,
  spawnMany,
  benchmarkConfig,
  neonTetra,
} from '../fixtures.ts';
import { FishState } from '../snapshot.ts';
import { toSimSpecies } from '../species.ts';
import { World } from '../world.ts';

const at = (a: ArrayLike<number>, i: number) => a[i] as number;
const cave = REEF_ANCHORS.find((a) => a.id === 'cave')!;
const dist = (w: World, i: number, p: readonly number[]) =>
  Math.hypot(
    at(w.position, i * 3) - p[0]!,
    at(w.position, i * 3 + 1) - p[1]!,
    at(w.position, i * 3 + 2) - p[2]!,
  );
const seeds = (process.env.SEEDS ?? '1-13').split('-').map(Number);

it.skipIf(!process.env.GRAMMA)(
  'gramma sweep',
  () => {
    const length = toSimSpecies(royalGramma).bodyLength;
    const leash = cave.radius + BEHAVIOUR.caveLeashBodyLengths * length + length;
    const rows: string[] = [];
    for (let seed = seeds[0]!; seed <= seeds[1]!; seed++) {
      const w = new World({
        seed,
        tank: REEF_TANK,
        species: ARCHETYPES,
        decor: REEF_DECOR,
        anchors: REEF_ANCHORS,
        fish: spawnMany(royalGramma.id, 1),
      });
      let close = 0,
        day = 0;
      for (let t = 0; t < 3000; t++) {
        w.step();
        if (t < 300) continue;
        if (dist(w, 0, cave.position) < leash) close++;
        day++;
      }
      w.startle({ position: [at(w.position, 0), at(w.position, 1), 0.3], intensity: 1 });
      let sh = false;
      let reachT = -1;
      for (let t = 0; t < 300; t++) {
        w.step();
        if (at(w.state, 0) === FishState.Shelter) sh = true;
        if (reachT < 0 && dist(w, 0, cave.position) < cave.radius + length) reachT = t;
      }
      w.setLight(0);
      let inside = 0,
        night = 0;
      for (let t = 0; t < 9000; t++) {
        w.step();
        if (t < 4500) continue;
        const s = at(w.state, 0);
        if (
          (s === FishState.Shelter || s === FishState.Rest) &&
          dist(w, 0, cave.position) < cave.radius + length
        )
          inside++;
        night++;
      }
      rows.push(
        `seed ${seed}: close ${(close / day).toFixed(2)} shelter ${sh} reachT ${reachT} inside ${(inside / night).toFixed(2)} contacts ${w.contacts}`,
      );
    }
    console.log(rows.join('\n'));
  },
  1_200_000,
);

it.skipIf(!process.env.SCHOOL)(
  'school sweep',
  () => {
    const rows: string[] = [];
    for (let seed = seeds[0]!; seed <= seeds[1]!; seed++) {
      const w = new World(benchmarkConfig(seed));
      const tetras: number[] = [];
      for (let i = 0; i < w.count; i++) if (w.speciesOf(i).id === 'neon-tetra') tetras.push(i);
      const link = 4 * toSimSpecies(neonTetra).bodyLength;
      let clusters = 0,
        largest = 0,
        snaps = 0;
      for (let t = 0; t < 6000; t++) {
        w.step();
        if (t < 600 || t % 15 !== 0) continue;
        const parent = tetras.map((_, k) => k);
        const find = (k: number): number => {
          while (parent[k] !== k) k = parent[k]!;
          return k;
        };
        for (let a = 0; a < tetras.length; a++)
          for (let b = a + 1; b < tetras.length; b++) {
            const j = tetras[b]!;
            if (
              dist(w, tetras[a]!, [
                at(w.position, j * 3),
                at(w.position, j * 3 + 1),
                at(w.position, j * 3 + 2),
              ]) < link
            )
              parent[find(a)] = find(b);
          }
        const sizes = new Map<number, number>();
        for (let a = 0; a < tetras.length; a++) sizes.set(find(a), (sizes.get(find(a)) ?? 0) + 1);
        clusters += sizes.size;
        largest += Math.max(...sizes.values()) / tetras.length;
        snaps++;
      }
      rows.push(
        `seed ${seed}: clusters ${(clusters / snaps).toFixed(2)} largest ${(largest / snaps).toFixed(3)}`,
      );
    }
    console.log(rows.join('\n'));
  },
  1_200_000,
);
