import type { SpeciesSummary, Tank } from '@aquarium/shared';
import { livingFish, waterReport, type WaterQuality } from '../sync/life';

export type Tone = 'good' | 'fair' | 'poor';

export interface Gauge {
  key: 'health' | 'fed' | 'water';
  label: string;
  /** 0 (empty) to 1 (full). */
  value: number;
  tone: Tone;
}

const WATER_VALUE: Record<WaterQuality, number> = { good: 1, fair: 0.55, poor: 0.2 };
const WATER_ORDER: readonly WaterQuality[] = ['good', 'fair', 'poor'];

export function toneFor(value: number): Tone {
  if (value >= 0.66) return 'good';
  if (value >= 0.33) return 'fair';
  return 'poor';
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function tankGauges(tank: Tank, species: readonly SpeciesSummary[]): Gauge[] {
  const report = waterReport(tank.water, tank, species);
  const worst = [report.ammonia, report.nitrate, report.algae, report.leftoverFood].reduce(
    (a, b) => (WATER_ORDER.indexOf(b) > WATER_ORDER.indexOf(a) ? b : a),
  );
  const water = WATER_VALUE[worst];
  const living = livingFish(tank);
  const gauges: Gauge[] = [];
  if (living.length > 0) {
    const health = clamp01(mean(living.map((f) => f.health)));
    const fed = clamp01(1 - mean(living.map((f) => f.hunger)));
    gauges.push(
      { key: 'health', label: 'Health', value: health, tone: toneFor(health) },
      { key: 'fed', label: 'Fed', value: fed, tone: toneFor(fed) },
    );
  }
  gauges.push({ key: 'water', label: 'Water', value: water, tone: toneFor(water) });
  return gauges;
}

export function gaugeSummary(gauges: readonly Gauge[]): string {
  if (gauges.length === 0) return '';
  return gauges
    .map((g) => `${g.label.toLowerCase()} ${Math.round(g.value * 100)} percent`)
    .join(', ');
}

export type TimeOfDay = 'Night' | 'Dawn or dusk' | 'Day';

export function timeOfDay(level: number): TimeOfDay {
  if (level >= 0.7) return 'Day';
  if (level >= 0.25) return 'Dawn or dusk';
  return 'Night';
}
