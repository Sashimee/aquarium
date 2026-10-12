import { describe, expect, it } from 'vitest';
import {
  addFishRequestSchema,
  apiErrorSchema,
  ateBatchRequestSchema,
  careActionSchema,
  careEventSchema,
  createTankRequestSchema,
  fishSchema,
  presetLayoutSchema,
  revokeSessionRequestSchema,
  sessionInfoSchema,
  signInRequestSchema,
  signUpRequestSchema,
  speciesSchema,
  tankSchema,
  updateTankRequestSchema,
  userSchema,
} from './index.js';

const id = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const id2 = '0b9d7a52-1f3c-4a8e-8d6b-7e5c4a3b2d1f';
const ts = '2026-10-12T10:00:00.000Z';

const fish = {
  id,
  tankId: id2,
  species: 'neon-tetra',
  name: 'Blip',
  bornAt: ts,
  size: 1.2,
  hunger: 0.1,
  health: 1,
  status: 'alive',
  diedAt: null,
  cause: null,
};

const species = {
  id: 'neon-tetra',
  commonName: 'Neon tetra',
  scientificName: 'Paracheirodon innesi',
  biome: 'freshwater',
  behaviour: {
    schooling: { minGroup: 6, topologicalNeighbours: 7, tightenWhenStartled: true },
    territorial: false,
    preferredZone: 'mid',
    depthBand: [0.3, 0.7],
    perceptionRange: 12,
    perceptionFovDeg: 300,
    curiosity: 0.4,
    boldness: 0.3,
  },
  locomotion: {
    swimmingMode: 'carangiform',
    gait: 'burst-and-coast',
    maxSpeed: 30,
    cruiseSpeed: 8,
    mass: 0.0005,
    maxTurnRateDegPerS: 540,
    maxPitchDeg: 30,
    bodyLength: 3.5,
  },
  render: {
    modelId: 'neon-tetra',
    lods: ['high', 'mid', 'impostor'],
    scale: 1,
    tintVariation: 0.1,
    finMask: true,
  },
  lifecycle: {
    hungerPerHour: 0.02,
    healthLossPerHourStarving: 0.01,
    healthRecoveryPerHour: 0.005,
    ammoniaTolerance: 0.5,
    maxSize: 4,
    growthPerDay: 0.02,
    bioload: 1,
    ammoniaPerBioloadPerHour: 0.01,
    foodDecayMinutes: 60,
    filterRemovalPerHour: 0.2,
    nitratePerHour: 0.05,
  },
};

describe('auth', () => {
  it('accepts a valid sign-up and rejects bad email, short password and extra keys', () => {
    const ok = { email: 'a@bas.lu', password: 'correct horse', name: 'Al' };
    expect(signUpRequestSchema.safeParse(ok).success).toBe(true);
    expect(signUpRequestSchema.safeParse({ ...ok, email: 'nope' }).success).toBe(false);
    expect(signUpRequestSchema.safeParse({ ...ok, password: 'short' }).success).toBe(false);
    expect(signUpRequestSchema.safeParse({ ...ok, admin: true }).success).toBe(false);
  });

  it('validates sign-in', () => {
    expect(signInRequestSchema.safeParse({ email: 'a@bas.lu', password: 'x' }).success).toBe(true);
    expect(signInRequestSchema.safeParse({ email: 'a@bas.lu', password: '' }).success).toBe(false);
  });

  it('validates user and sessions', () => {
    const user = { id, email: 'a@bas.lu', name: 'Al', emailVerified: false, createdAt: ts };
    expect(userSchema.safeParse(user).success).toBe(true);
    expect(userSchema.safeParse({ ...user, id: 'not-a-uuid' }).success).toBe(false);
    const session = { id, createdAt: ts, expiresAt: ts, userAgent: null, current: true };
    expect(sessionInfoSchema.safeParse(session).success).toBe(true);
    expect(sessionInfoSchema.safeParse({ ...session, current: 'yes' }).success).toBe(false);
    expect(revokeSessionRequestSchema.safeParse({ sessionId: id }).success).toBe(true);
    expect(revokeSessionRequestSchema.safeParse({ sessionId: 1 }).success).toBe(false);
  });
});

describe('error shape', () => {
  it('accepts known codes only', () => {
    expect(
      apiErrorSchema.safeParse({ error: { code: 'not_found', message: 'No such tank' } }).success,
    ).toBe(true);
    expect(
      apiErrorSchema.safeParse({
        error: {
          code: 'validation_failed',
          message: 'bad',
          issues: [{ path: ['name', 0], message: 'x' }],
        },
      }).success,
    ).toBe(true);
    expect(apiErrorSchema.safeParse({ error: { code: 'teapot', message: 'x' } }).success).toBe(
      false,
    );
    expect(apiErrorSchema.safeParse({ error: { code: 'internal', message: '' } }).success).toBe(
      false,
    );
  });
});

describe('tank and fish', () => {
  it('validates fish bounds', () => {
    expect(fishSchema.safeParse(fish).success).toBe(true);
    expect(fishSchema.safeParse({ ...fish, hunger: 1.5 }).success).toBe(false);
    expect(fishSchema.safeParse({ ...fish, status: 'zombie' }).success).toBe(false);
    expect(fishSchema.safeParse({ ...fish, name: ' ' }).success).toBe(false);
  });

  it('validates a full tank', () => {
    const tank = {
      id,
      name: 'Home',
      biome: 'reef',
      decorLayout: [{ assetId: 'rock-1', position: [0, 0, 0] }],
      water: { ammonia: 0, nitrate: 2, algae: 0.1 },
      lastTickAt: ts,
      fish: [fish],
      memorials: [],
    };
    const parsed = tankSchema.parse(tank);
    expect(parsed.decorLayout[0]?.scale).toBe(1);
    expect(tankSchema.safeParse({ ...tank, biome: 'pond' }).success).toBe(false);
    expect(tankSchema.safeParse({ ...tank, water: { ...tank.water, algae: 2 } }).success).toBe(
      false,
    );
  });

  it('validates tank and fish requests', () => {
    expect(createTankRequestSchema.safeParse({ name: 'T', biome: 'freshwater' }).success).toBe(
      true,
    );
    expect(createTankRequestSchema.safeParse({ name: '', biome: 'freshwater' }).success).toBe(
      false,
    );
    expect(updateTankRequestSchema.safeParse({ name: 'New' }).success).toBe(true);
    expect(updateTankRequestSchema.safeParse({}).success).toBe(false);
    expect(addFishRequestSchema.safeParse({ species: 'neon-tetra', name: 'Blip' }).success).toBe(
      true,
    );
    expect(addFishRequestSchema.safeParse({ species: 'Neon Tetra', name: 'Blip' }).success).toBe(
      false,
    );
  });
});

describe('care events', () => {
  it('discriminates on type', () => {
    expect(careActionSchema.safeParse({ type: 'feed', food: 'flakes', portion: 1 }).success).toBe(
      true,
    );
    expect(careActionSchema.safeParse({ type: 'water_change' }).success).toBe(true);
    expect(careActionSchema.safeParse({ type: 'feed', food: 'pizza', portion: 1 }).success).toBe(
      false,
    );
    expect(careActionSchema.safeParse({ type: 'feed', food: 'flakes', portion: -1 }).success).toBe(
      false,
    );
    expect(careActionSchema.safeParse({ type: 'dance' }).success).toBe(false);
  });

  it('validates ate batches', () => {
    const report = { fishId: id, portion: 0.5, at: ts };
    expect(ateBatchRequestSchema.safeParse({ reports: [report] }).success).toBe(true);
    expect(ateBatchRequestSchema.safeParse({ reports: [] }).success).toBe(false);
    expect(ateBatchRequestSchema.safeParse({ reports: [{ ...report, portion: 0 }] }).success).toBe(
      false,
    );
  });

  it('validates logged events', () => {
    const event = { id, tankId: id2, kind: 'feed', payload: { food: 'flakes' }, at: ts };
    expect(careEventSchema.safeParse(event).success).toBe(true);
    expect(careEventSchema.safeParse({ ...event, kind: 'nap' }).success).toBe(false);
  });
});

describe('species and presets', () => {
  it('accepts a full species and applies defaults', () => {
    const parsed = speciesSchema.parse(species);
    expect(parsed.locomotion.strouhal).toBe(0.3);
    expect(parsed.lifecycle.starvationHungerThreshold).toBe(0.75);
    expect(parsed.behaviour.traits).toEqual([]);
  });

  it.each(['behaviour', 'locomotion', 'render', 'lifecycle'] as const)(
    'requires the %s block',
    (block) => {
      const rest = Object.fromEntries(Object.entries(species).filter(([key]) => key !== block));
      expect(speciesSchema.safeParse(rest).success).toBe(false);
    },
  );

  it('rejects invalid values', () => {
    const bad = (patch: object) => speciesSchema.safeParse({ ...species, ...patch }).success;
    expect(bad({ behaviour: { ...species.behaviour, depthBand: [0.8, 0.2] } })).toBe(false);
    expect(bad({ locomotion: { ...species.locomotion, swimmingMode: 'flying' } })).toBe(false);
    expect(bad({ locomotion: { ...species.locomotion, strouhal: 0.9 } })).toBe(false);
    expect(bad({ render: { ...species.render, lods: [] } })).toBe(false);
    expect(bad({ lifecycle: { ...species.lifecycle, hungerPerHour: -1 } })).toBe(false);
    expect(bad({ id: 'Neon Tetra' })).toBe(false);
  });

  it('validates the preset layout stub', () => {
    const preset = {
      id: 'planted-20',
      name: 'Planted 20',
      biome: 'freshwater',
      decor: [{ assetId: 'wood-1', position: [1, 0, 2], rotationY: 1.2 }],
    };
    expect(presetLayoutSchema.safeParse(preset).success).toBe(true);
    expect(
      presetLayoutSchema.safeParse({ ...preset, decor: [{ assetId: 'x', position: [0, 0] }] })
        .success,
    ).toBe(false);
  });
});
