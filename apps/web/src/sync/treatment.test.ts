import type { Medicine } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { BUNDLED_ECONOMY } from './bundledEconomy';
import { FISH_1, FISH_2, fishFixture, speciesFixture, tankFixture } from './fixtures';
import {
  blockedText,
  courseDays,
  doseButtonText,
  heatTolerantSick,
  medicineLine,
  planDose,
  severityWord,
  sickKinds,
  switchWarning,
  wantsWaterChange,
} from './treatment';

const NOW = Date.parse('2026-02-01T12:00:00.000Z');
const disease = (kind: 'ich' | 'fin-rot' | 'velvet', severity = 0.4) => ({
  kind,
  since: '2026-02-01T00:00:00.000Z',
  severity,
  treatedUntil: null,
});
const medicine = (kind: Medicine['kind'], doses: number, hoursLeft = 48): Medicine => ({
  kind,
  potency: 'standard',
  doses,
  until: new Date(NOW + hoursLeft * 3_600_000).toISOString(),
});
const ichFish = fishFixture(FISH_1, { name: 'Pip', disease: disease('ich') });
const rotFish = fishFixture(FISH_2, { name: 'Dot', disease: disease('fin-rot') });

describe('planDose', () => {
  it('allows a first dose with nothing to warn about', () => {
    const tank = tankFixture({ fish: [ichFish] });
    expect(planDose(tank, 'ich', 'standard', NOW)).toEqual({
      kind: 'ok',
      overdose: false,
      replaces: null,
    });
  });

  it('refuses when no living fish has the disease', () => {
    const tank = tankFixture({ fish: [ichFish] });
    expect(planDose(tank, 'velvet', 'standard', NOW)).toEqual({
      kind: 'blocked',
      reason: 'nothing-to-treat',
    });
    const dead = fishFixture(FISH_1, { disease: disease('ich'), status: 'dead' });
    expect(planDose(tankFixture({ fish: [dead] }), 'ich', 'standard', NOW)).toMatchObject({
      kind: 'blocked',
    });
  });

  it('calls a second dose of the same kind an overdose', () => {
    const tank = tankFixture({ fish: [ichFish], medicine: medicine('ich', 1) });
    expect(planDose(tank, 'ich', 'standard', NOW)).toMatchObject({ kind: 'ok', overdose: true });
  });

  it('does not call a dose on top of a trace an overdose', () => {
    const tank = tankFixture({ fish: [ichFish], medicine: medicine('ich', 0) });
    expect(planDose(tank, 'ich', 'standard', NOW)).toMatchObject({ overdose: false });
  });

  it('blocks another kind while the medicine is at full strength', () => {
    const tank = tankFixture({ fish: [ichFish, rotFish], medicine: medicine('ich', 1) });
    expect(planDose(tank, 'fin-rot', 'standard', NOW)).toEqual({
      kind: 'blocked',
      reason: 'other-medicine',
    });
  });

  it('blocks at the dose limit', () => {
    const tank = tankFixture({ fish: [ichFish], medicine: medicine('ich', 3) });
    expect(planDose(tank, 'ich', 'standard', NOW)).toEqual({
      kind: 'blocked',
      reason: 'at-limit',
    });
  });

  it('warns that a switch ends the old course for fish still sick with it', () => {
    const tank = tankFixture({ fish: [ichFish, rotFish], medicine: medicine('ich', 0) });
    const plan = planDose(tank, 'fin-rot', 'standard', NOW);
    if (plan.kind !== 'ok' || !plan.replaces) throw new Error('expected a switch warning');
    expect(plan.replaces.fish.map((f) => f.name)).toEqual(['Pip']);
    const text = switchWarning(plan.replaces, 'fin-rot');
    expect(text).toContain('Pip still has ich');
    expect(text).toContain('ends what is left of the ich course');
  });

  it('does not warn when nobody is still sick with the old disease', () => {
    const tank = tankFixture({ fish: [rotFish], medicine: medicine('ich', 0) });
    expect(planDose(tank, 'fin-rot', 'standard', NOW)).toMatchObject({ replaces: null });
  });

  it('ignores a course that already ran out', () => {
    const tank = tankFixture({ fish: [ichFish, rotFish], medicine: medicine('ich', 1, -1) });
    expect(planDose(tank, 'fin-rot', 'standard', NOW)).toMatchObject({
      kind: 'ok',
      replaces: null,
    });
  });
});

describe('treatment wording', () => {
  it('lists every disease that has a living patient, once', () => {
    expect(sickKinds(tankFixture({ fish: [rotFish, ichFish] }))).toEqual(['ich', 'fin-rot']);
  });

  it('prices premium medicine from the economy and calls standard free', () => {
    expect(doseButtonText(BUNDLED_ECONOMY, 'ich', 'standard')).toContain('free');
    expect(doseButtonText(BUNDLED_ECONOMY, 'velvet', 'premium')).toContain('60 Pearls');
    expect(courseDays('ich', 'standard')).toBe('4 days');
    expect(courseDays('ich', 'premium')).toBe('2 days');
  });

  it('words the severity and the medicine left', () => {
    expect(severityWord(0.1)).toBe('just starting');
    expect(severityWord(0.5)).toBe('clearly sick');
    expect(severityWord(0.9)).toBe('very sick');
    expect(medicineLine(medicine('ich', 2), NOW)).toContain('2 doses, an overdose');
    expect(medicineLine(medicine('ich', 0), NOW)).toContain('A trace of ich');
  });

  it('sends the player to a water change for both water refusals but not for no patient', () => {
    expect(wantsWaterChange(blockedText('other-medicine'))).toBe(true);
    expect(wantsWaterChange(blockedText('at-limit'))).toBe(true);
    expect(wantsWaterChange(blockedText('nothing-to-treat'))).toBe(false);
  });
});

describe('heat for ich', () => {
  const tetra = speciesFixture({
    chemistry: { ...speciesFixture().chemistry, temperatureC: [22, 28] },
  });
  const betta = speciesFixture({
    id: 'betta',
    commonName: 'Betta',
    chemistry: { ...tetra.chemistry, temperatureC: [26, 30] },
  });

  it('names only sick species whose comfort range reaches 30 C', () => {
    const bettaFish = fishFixture(FISH_2, { species: 'betta', disease: disease('ich') });
    expect(heatTolerantSick(tankFixture({ fish: [ichFish, bettaFish] }), [tetra, betta])).toEqual([
      'Betta',
    ]);
  });

  it('names nothing for other species, and ignores tolerant fish that are not sick', () => {
    expect(heatTolerantSick(tankFixture({ fish: [ichFish] }), [tetra, betta])).toEqual([]);
    const healthyBetta = fishFixture(FISH_2, { species: 'betta' });
    expect(heatTolerantSick(tankFixture({ fish: [healthyBetta] }), [betta])).toEqual([]);
  });
});
