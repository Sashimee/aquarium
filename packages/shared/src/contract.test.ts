import { describe, expect, it } from 'vitest';
import {
  addFishRequestSchema,
  apiErrorSchema,
  ateBatchRequestSchema,
  careActionSchema,
  careEventSchema,
  replayQuerySchema,
  DEFAULT_EQUIPMENT,
  newTankChemistry,
  decorItemSchema,
  legacyTintSeed,
  memorialSchema,
  waterParametersSchema,
  createTankRequestSchema,
  treatRequestSchema,
  fishSchema,
  httpUrlSchema,
  presetLayoutSchema,
  revokeSessionRequestSchema,
  sessionInfoSchema,
  signInRequestSchema,
  signUpRequestSchema,
  speciesSchema,
  tankSchema,
  updateTankRequestSchema,
  waterSchema,
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
  sex: 'female',
  stage: 'adult',
  personality: { boldness: 0.5, greed: 0.5, sociability: 0.5 },
  disease: null,
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
    perceptionRangeM: 0.3,
    perceptionFovDeg: 300,
    curiosity: 0.4,
    boldness: 0.3,
  },
  locomotion: {
    swimmingMode: 'carangiform',
    gait: 'burst-and-coast',
    maxSpeedMps: 0.5,
    cruiseSpeedMps: 0.12,
    massKg: 0.0005,
    maxTurnRateDegPerS: 540,
    maxPitchDeg: 30,
    bodyLengthM: 0.035,
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
    birthSizeM: 0.008,
    maxSizeM: 0.04,
    lifespanDays: 1500,
    diet: ['flakes', 'brine-shrimp'],
    growthPerDay: 0.02,
    bioload: 1,
    ammoniaPerBioloadPerHour: 0.01,
  },
};

describe('error codes', () => {
  it('has distinct codes for oversized and unsupported bodies', () => {
    for (const code of ['payload_too_large', 'unsupported_media_type']) {
      expect(apiErrorSchema.safeParse({ error: { code, message: 'x' } }).success).toBe(true);
    }
  });
});

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
    expect(userSchema.safeParse({ ...user, id: 'x'.repeat(32) }).success).toBe(true);
    expect(userSchema.safeParse({ ...user, id: '' }).success).toBe(false);
    expect(userSchema.safeParse({ ...user, id: 'x'.repeat(65) }).success).toBe(false);
    const session = { id, createdAt: ts, expiresAt: ts, userAgent: null, current: true };
    expect(sessionInfoSchema.safeParse(session).success).toBe(true);
    expect(sessionInfoSchema.safeParse({ ...session, current: 'yes' }).success).toBe(false);
    expect(
      revokeSessionRequestSchema.safeParse({ sessionId: 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6' })
        .success,
    ).toBe(true);
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
      decorEdited: true,
      backgroundId: 'bg-reef-coral-wall',
      roomId: 'room-living',
      roomSetAt: null,
      water: { ammonia: 0, nitrate: 2, algae: 0.1, uneatenFood: 0 },
      lastTickAt: ts,
      chemistry: newTankChemistry('freshwater'),
      size: 'standard',
      quarantine: false,
      shared: false,
      inGallery: false,
      acceptsGifts: false,
      co2OwnedTier: 0,
      shareToken: null,
      equipment: DEFAULT_EQUIPMENT,
      recentVisitDays: 3,
      fish: [fish],
      memorials: [],
    };
    const parsed = tankSchema.parse(tank);
    expect(parsed.decorLayout[0]?.scale).toBe(1);
    expect(parsed.decorEdited).toBe(true);
    expect(tankSchema.safeParse({ ...tank, recentVisitDays: 15 }).success).toBe(false);
    expect(tankSchema.safeParse({ ...tank, recentVisitDays: -1 }).success).toBe(false);
    expect(tankSchema.safeParse({ ...tank, decorEdited: undefined }).success).toBe(false);
    expect(tankSchema.safeParse({ ...tank, backgroundId: 'nope' }).success).toBe(false);
    expect(tankSchema.safeParse({ ...tank, roomId: null }).success).toBe(true);
    expect(tankSchema.safeParse({ ...tank, roomId: 'room-attic' }).success).toBe(false);
    expect(
      tankSchema.parse({ ...tank, futureField: 1, fish: [{ ...fish, futureField: 1 }] }),
    ).toEqual(parsed);
    const futureDecor = [{ ...tank.decorLayout[0], futureField: 1 }];
    expect(tankSchema.parse({ ...tank, decorLayout: futureDecor }).decorLayout).toEqual(
      parsed.decorLayout,
    );
    expect(updateTankRequestSchema.safeParse({ decorLayout: futureDecor }).success).toBe(false);
    expect(tankSchema.safeParse({ ...tank, biome: 'pond' }).success).toBe(false);
    expect(tankSchema.safeParse({ ...tank, water: { ...tank.water, algae: 2 } }).success).toBe(
      false,
    );
  });

  it('requires an idempotency key on treat and bottled bacteria', () => {
    expect(treatRequestSchema.safeParse({ kind: 'ich' }).success).toBe(false);
    expect(treatRequestSchema.safeParse({ kind: 'ich', idempotencyKey: 'abcdefgh1' }).success).toBe(
      true,
    );
    expect(careActionSchema.safeParse({ type: 'bottled_bacteria' }).success).toBe(false);
    expect(
      careActionSchema.safeParse({ type: 'bottled_bacteria', idempotencyKey: 'abcdefgh1' }).success,
    ).toBe(true);
  });

  it('validates tank and fish requests', () => {
    expect(
      createTankRequestSchema.safeParse({
        name: 'T',
        biome: 'freshwater',
        idempotencyKey: 'abcdefgh1',
      }).success,
    ).toBe(true);
    expect(createTankRequestSchema.safeParse({ name: '', biome: 'freshwater' }).success).toBe(
      false,
    );
    expect(updateTankRequestSchema.safeParse({ name: 'New' }).success).toBe(true);
    expect(updateTankRequestSchema.safeParse({}).success).toBe(false);
    const buy = { stage: 'adult', idempotencyKey: 'abcdefgh1' };
    expect(
      addFishRequestSchema.safeParse({ species: 'neon-tetra', name: 'Blip', ...buy }).success,
    ).toBe(true);
    expect(
      addFishRequestSchema.safeParse({ species: 'Neon Tetra', name: 'Blip', ...buy }).success,
    ).toBe(false);
  });
});

describe('care events', () => {
  it('accepts a bare salt_dose action and event and rejects extra fields', () => {
    expect(careActionSchema.safeParse({ type: 'salt_dose' }).success).toBe(true);
    expect(careActionSchema.safeParse({ type: 'salt_dose', amount: 3 }).success).toBe(false);
    const event = { id, tankId: id2, at: '2026-01-01T00:00:00.000Z', kind: 'salt_dose' };
    expect(careEventSchema.safeParse({ ...event, payload: {} }).success).toBe(true);
    expect(careEventSchema.safeParse({ ...event, payload: { grams: 1 } }).success).toBe(false);
  });

  it('requires an idempotency key on buffer_dose and add_botanicals and logs bare events', () => {
    for (const type of ['buffer_dose', 'add_botanicals'] as const) {
      expect(careActionSchema.safeParse({ type }).success).toBe(false);
      expect(careActionSchema.safeParse({ type, idempotencyKey: 'abcdefgh1' }).success).toBe(true);
      const event = { id, tankId: id2, at: ts, kind: type };
      expect(careEventSchema.safeParse({ ...event, payload: {} }).success).toBe(true);
    }
  });

  it('defaults water tannin to 0 so saved tanks still parse', () => {
    expect(waterSchema.parse({ ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0 }).tannin).toBe(0);
    expect(
      waterSchema.safeParse({ ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0, tannin: 2 })
        .success,
    ).toBe(false);
  });

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

  it('validates replay events and queries', () => {
    const base = { id, tankId: id2, at: ts };
    expect(
      careEventSchema.safeParse({ ...base, kind: 'sick', payload: { fishId: id } }).success,
    ).toBe(true);
    expect(
      careEventSchema.safeParse({
        ...base,
        kind: 'water_alert',
        payload: { metric: 'ammonia', state: 'high' },
      }).success,
    ).toBe(true);
    expect(
      careEventSchema.safeParse({
        ...base,
        kind: 'water_alert',
        payload: { metric: 'ph', state: 'high' },
      }).success,
    ).toBe(false);
    const moved = {
      ...base,
      kind: 'fish_moved',
      payload: { fishId: id, direction: 'out', otherTankId: id2 },
    };
    expect(careEventSchema.safeParse(moved).success).toBe(true);
    expect(
      careEventSchema.safeParse({ ...moved, payload: { ...moved.payload, direction: 'up' } })
        .success,
    ).toBe(false);
    expect(replayQuerySchema.parse({ since: ts }).limit).toBe(200);
    expect(replayQuerySchema.safeParse({ since: ts, limit: '501' }).success).toBe(false);
    expect(replayQuerySchema.safeParse({}).success).toBe(false);
  });

  it('validates logged events', () => {
    const event = {
      id,
      tankId: id2,
      kind: 'feed',
      payload: { food: 'flakes', portion: 1 },
      at: ts,
    };
    expect(careEventSchema.safeParse(event).success).toBe(true);
    expect(careEventSchema.safeParse({ ...event, kind: 'nap' }).success).toBe(false);
    expect(careEventSchema.safeParse({ ...event, payload: {} }).success).toBe(false);
    expect(careEventSchema.safeParse({ ...event, kind: 'water_change', payload: {} }).success).toBe(
      true,
    );
    expect(
      careEventSchema.safeParse({ ...event, kind: 'water_change', payload: { food: 'flakes' } })
        .success,
    ).toBe(false);
    const death = { ...event, kind: 'death', payload: { fishId: id, cause: 'starvation' } };
    expect(careEventSchema.safeParse(death).success).toBe(true);
    expect(
      careEventSchema.safeParse({ ...death, payload: { fishId: id, cause: 'boredom' } }).success,
    ).toBe(false);
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

  it('allows species without a schooling block', () => {
    const solitary = Object.fromEntries(
      Object.entries(species.behaviour).filter(([key]) => key !== 'schooling'),
    );
    expect(speciesSchema.safeParse({ ...species, behaviour: solitary }).success).toBe(true);
  });

  it('requires cruise speed not above max speed', () => {
    const locomotion = { ...species.locomotion, cruiseSpeedMps: 0.6 };
    expect(speciesSchema.safeParse({ ...species, locomotion }).success).toBe(false);
  });

  it('rejects a birth size above the maximum size', () => {
    const lifecycle = { ...species.lifecycle, birthSizeM: 0.05, maxSizeM: 0.04 };
    const result = speciesSchema.safeParse({ ...species, lifecycle });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['lifecycle', 'birthSizeM']);
    const equal = { ...species.lifecycle, birthSizeM: 0.04, maxSizeM: 0.04 };
    expect(speciesSchema.safeParse({ ...species, lifecycle: equal }).success).toBe(true);
  });

  it('requires lifespan, birth size and a non-empty diet', () => {
    const bad = (patch: object) =>
      speciesSchema.safeParse({ ...species, lifecycle: { ...species.lifecycle, ...patch } })
        .success;
    expect(bad({ lifespanDays: 0 })).toBe(false);
    expect(bad({ birthSizeM: -1 })).toBe(false);
    expect(bad({ diet: [] })).toBe(false);
    expect(bad({ diet: ['pizza'] })).toBe(false);
  });

  it('rejects the old tank-level keys inside a species lifecycle', () => {
    const lifecycle = { ...species.lifecycle, filterRemovalPerHour: 0.2 };
    expect(speciesSchema.safeParse({ ...species, lifecycle }).success).toBe(false);
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

  it('validates substrate, plant patches and the current of a full preset', () => {
    const preset = {
      id: 'planted-20',
      name: 'Planted 20',
      biome: 'freshwater',
      decor: [],
      substrate: { assetId: 'coast-sand-01', tileMeters: 0.5 },
      plantPatches: [
        {
          id: 'carpet',
          assetId: 'staurogyne-repens',
          center: [0, 0.1],
          radius: 0.2,
          count: 12,
          scale: [0.8, 1.2],
          seed: 7,
        },
      ],
      current: { direction: [1, 0], speed: 0.04, gustPeriodS: 9, gustDepth: 0.4 },
    };
    const parsed = presetLayoutSchema.parse(preset);
    expect(parsed.substrate?.tint).toEqual([1, 1, 1]);
    expect(presetLayoutSchema.parse({ ...preset, plantPatches: undefined }).plantPatches).toEqual(
      [],
    );
    expect(
      presetLayoutSchema.safeParse({
        ...preset,
        current: { ...preset.current, direction: [0, 0] },
      }).success,
    ).toBe(false);
    expect(
      presetLayoutSchema.safeParse({
        ...preset,
        plantPatches: [{ ...preset.plantPatches[0], count: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe('decor bounds', () => {
  const item = { assetId: 'rock-1', position: [0, 0, 0] };
  it('accepts a sane item and applies defaults', () => {
    expect(decorItemSchema.parse(item)).toMatchObject({ rotationY: 0, scale: 1 });
  });
  it('accepts a tint seed and rejects out-of-range ones', () => {
    expect(decorItemSchema.parse({ ...item, tintSeed: 7 }).tintSeed).toBe(7);
    expect(decorItemSchema.parse(item).tintSeed).toBeUndefined();
    for (const tintSeed of [-1, 1.5, 2 ** 32])
      expect(decorItemSchema.safeParse({ ...item, tintSeed }).success).toBe(false);
  });
  it('derives the legacy seed from placement only', () => {
    const a = legacyTintSeed({ position: [0.1, 0.05, 0.2], rotationY: 0.5 });
    expect(a).toBe(legacyTintSeed({ position: [0.1, 0.05, 0.2], rotationY: 0.5 }));
    expect(a).not.toBe(legacyTintSeed({ position: [0.3, 0.05, 0.2], rotationY: 0.5 }));
    expect(Number.isInteger(a) && a >= 0 && a <= 0xffffffff).toBe(true);
  });
  it.each([
    ['huge assetId', { ...item, assetId: 'a'.repeat(65) }],
    ['empty assetId', { ...item, assetId: '' }],
    ['position out of tank', { ...item, position: [1e300, 0, 0] }],
    ['non-finite position', { ...item, position: [Infinity, 0, 0] }],
    ['huge scale', { ...item, scale: 1e300 }],
    ['tiny scale', { ...item, scale: 0 }],
    ['rotation out of range', { ...item, rotationY: 1e9 }],
  ])('rejects %s', (_name, value) => {
    expect(decorItemSchema.safeParse(value).success).toBe(false);
  });
});

describe('memorial and water', () => {
  const memorial = {
    id,
    tankId: id2,
    fishName: 'Blip',
    species: 'neon-tetra',
    bornAt: ts,
    diedAt: ts,
    cause: 'starvation',
  };
  it('validates memorials', () => {
    expect(memorialSchema.safeParse(memorial).success).toBe(true);
    expect(memorialSchema.safeParse({ ...memorial, cause: null }).success).toBe(false);
    expect(memorialSchema.safeParse({ ...memorial, species: 'Neon Tetra' }).success).toBe(false);
    expect(memorialSchema.safeParse({ ...memorial, diedAt: 'yesterday' }).success).toBe(false);
  });
  it('validates water parameters', () => {
    const params = {
      foodDecayMinutes: 60,
      ammoniaPerPortion: 0.1,
      algaePerHour: 0.001,
    };
    expect(waterParametersSchema.safeParse(params).success).toBe(true);
    expect(waterParametersSchema.safeParse({ ...params, foodDecayMinutes: 0 }).success).toBe(false);
  });
});

describe('httpUrlSchema', () => {
  it('accepts http and https', () => {
    expect(httpUrlSchema.safeParse('http://example.com/a').success).toBe(true);
    expect(httpUrlSchema.safeParse('https://example.com/a').success).toBe(true);
  });

  it('rejects javascript:, data: and vbscript:', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)']) {
      expect(httpUrlSchema.safeParse(url).success).toBe(false);
    }
  });
});
