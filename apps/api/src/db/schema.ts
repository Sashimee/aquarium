import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  handle: text('handle').unique(),
  image: text('image'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamptz('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamptz('access_token_expires_at'),
    refreshTokenExpiresAt: timestamptz('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

export const passkey = pgTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    createdAt: timestamptz('created_at').defaultNow(),
    aaguid: text('aaguid'),
  },
  (t) => [
    index('passkey_user_id_idx').on(t.userId),
    index('passkey_credential_id_idx').on(t.credentialID),
  ],
);

export const biomeEnum = pgEnum('biome', [
  'freshwater',
  'reef',
  'cichlid',
  'blackwater',
  'mangrove',
]);
export const fishSexEnum = pgEnum('fish_sex', ['male', 'female']);
export const tankSizeEnum = pgEnum('tank_size', ['nano30', 'standard', 'std200', 'long300']);
export const fishStageEnum = pgEnum('fish_stage', ['fry', 'juvenile', 'adult']);
export const fishStatusEnum = pgEnum('fish_status', ['alive', 'dead']);
export const causeOfDeathEnum = pgEnum('cause_of_death', [
  'starvation',
  'ammonia',
  'nitrite',
  'disease',
  'old_age',
  'unknown',
]);
export const eventKindEnum = pgEnum('event_kind', [
  'feed',
  'water_change',
  'gravel_vacuum',
  'algae_scrape',
  'ate',
  'death',
]);

export const tanks = pgTable(
  'tanks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    biome: biomeEnum('biome').notNull(),
    size: tankSizeEnum('size').notNull().default('standard'),
    quarantine: boolean('quarantine').notNull().default(false),
    shareToken: text('share_token').unique(),
    name: text('name').notNull(),
    decorLayout: jsonb('decor_layout'),
    water: jsonb('water')
      .notNull()
      .default(sql`'{"ammonia":0,"nitrate":0,"algae":0,"uneatenFood":0}'::jsonb`),
    lastTickAt: timestamptz('last_tick_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    chemistry: jsonb('chemistry')
      .notNull()
      .default(
        sql`'{"nitrite":0,"ph":7,"kh":4,"temperatureC":25,"salinity":0,"bacteria":{"ammoniaOxidisers":1,"nitriteOxidisers":1}}'::jsonb`,
      ),
    equipment: jsonb('equipment')
      .notNull()
      .default(
        sql`'{"filter":{"tier":1},"heater":{"tier":0},"light":{"tier":1,"intensity":0.8,"onHour":8,"offHour":20},"co2":{"tier":0},"waveMaker":{"tier":0}}'::jsonb`,
      ),
  },
  (t) => [index('tanks_owner_id_idx').on(t.ownerId)],
);

export const fish = pgTable(
  'fish',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tankId: uuid('tank_id')
      .notNull()
      .references(() => tanks.id, { onDelete: 'cascade' }),
    species: text('species').notNull(),
    name: text('name').notNull(),
    // Assigned for every species, 50/50, even those with no male model; the client decides what it
    // draws.
    sex: fishSexEnum('sex').notNull(),
    bornAt: timestamptz('born_at').notNull().defaultNow(),
    size: doublePrecision('size').notNull(),
    hunger: doublePrecision('hunger').notNull().default(0),
    health: doublePrecision('health').notNull().default(1),
    status: fishStatusEnum('status').notNull().default('alive'),
    diedAt: timestamptz('died_at'),
    cause: causeOfDeathEnum('cause'),
    stage: fishStageEnum('stage').notNull().default('adult'),
    personality: jsonb('personality')
      .notNull()
      .default(sql`'{"boldness":0.5,"greed":0.5,"sociability":0.5}'::jsonb`),
    disease: jsonb('disease'),
  },
  (t) => [index('fish_tank_id_idx').on(t.tankId)],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tankId: uuid('tank_id')
      .notNull()
      .references(() => tanks.id, { onDelete: 'cascade' }),
    at: timestamptz('at').notNull().defaultNow(),
    kind: eventKindEnum('kind').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [index('events_tank_id_at_idx').on(t.tankId, t.at)],
);

export const ateBatches = pgTable(
  'ate_batches',
  {
    tankId: uuid('tank_id')
      .notNull()
      .references(() => tanks.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tankId, t.batchId] }),
    index('ate_batches_created_at_idx').on(t.createdAt),
  ],
);

export const memorials = pgTable(
  'memorials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tankId: uuid('tank_id')
      .notNull()
      .references(() => tanks.id, { onDelete: 'cascade' }),
    fishName: text('fish_name').notNull(),
    species: text('species').notNull(),
    bornAt: timestamptz('born_at').notNull(),
    diedAt: timestamptz('died_at').notNull(),
    cause: causeOfDeathEnum('cause').notNull(),
  },
  (t) => [index('memorials_tank_id_idx').on(t.tankId)],
);

export const mailLimitHits = pgTable(
  'mail_limit_hits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    key: text('key').notNull(),
    at: timestamptz('at').notNull().defaultNow(),
  },
  (t) => [
    index('mail_limit_hits_key_at_idx').on(t.key, t.at),
    index('mail_limit_hits_at_idx').on(t.at),
  ],
);
