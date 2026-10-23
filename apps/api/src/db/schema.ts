import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
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
  'water_quality',
  'old_age',
  'unknown',
]);
export const eventKindEnum = pgEnum('event_kind', [
  'feed',
  'water_change',
  'gravel_vacuum',
  'algae_scrape',
  'bottled_bacteria',
  'filter_rinse',
  'ate',
  'death',
  'born',
  'sick',
  'water_alert',
  'fish_moved',
  'salt_dose',
  'buffer_dose',
  'add_botanicals',
]);

export const tanks = pgTable(
  'tanks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // null: owned by the system (the community tank), never by an account.
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'cascade' }),
    biome: biomeEnum('biome').notNull(),
    size: tankSizeEnum('size').notNull().default('standard'),
    quarantine: boolean('quarantine').notNull().default(false),
    shareTokenHash: text('share_token_hash').unique(),
    // A public link is not a gallery listing: this is a second opt-in, honoured only while the link is on.
    inGallery: boolean('in_gallery').notNull().default(false),
    acceptsGifts: boolean('accepts_gifts').notNull().default(false),
    name: text('name').notNull(),
    // The client's idempotency key of the request that made the tank. Free tanks leave no ledger
    // row, so this is what lets a retry find the tank it already got.
    creationKey: text('creation_key'),
    // The medicine in the water: one course at a time (see medicineSchema). null: none.
    medicine: jsonb('medicine'),
    // Recent treat requests (key, kind, potency, overdose) so a retry replays instead of dosing again.
    treatKeys: jsonb('treat_keys').notNull().default([]),
    decorLayout: jsonb('decor_layout'),
    // Growth state of the layout plants and their offsets (storedPlantsSchema), reconciled with the
    // layout on every tick.
    plants: jsonb('plants').notNull().default([]),
    // Recent trim requests (key, plantKey, size) so a retry replays instead of trimming twice.
    plantTrimKeys: jsonb('plant_trim_keys').notNull().default([]),
    // State of the layout corals and their fragments (storedCoralsSchema), reconciled with the layout
    // on every tick.
    corals: jsonb('corals').notNull().default([]),
    // Recent frag requests (key, coralKey) so a retry replays instead of cutting twice.
    coralFragKeys: jsonb('coral_frag_keys').notNull().default([]),
    // null: the player never chose one, so the biome's default shows.
    backgroundId: text('background_id'),
    water: jsonb('water')
      .notNull()
      .default(sql`'{"ammonia":0,"nitrate":0,"algae":0,"uneatenFood":0,"tannin":0}'::jsonb`),
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
        sql`'{"filter":{"tier":1},"heater":{"tier":1},"light":{"tier":1,"intensity":0.8,"onHour":8,"offHour":20},"co2":{"tier":0},"waveMaker":{"tier":0}}'::jsonb`,
      ),
    // The highest CO2 tier this tank has been bought up to; the installed tier can sit below it.
    co2OwnedTier: integer('co2_owned_tier').notNull().default(0),
  },
  (t) => [
    index('tanks_owner_id_idx').on(t.ownerId),
    uniqueIndex('tanks_owner_creation_key_idx')
      .on(t.ownerId, t.creationKey)
      .where(sql`${t.creationKey} is not null`),
  ],
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
    lastBroodAt: timestamptz('last_brood_at'),
    personality: jsonb('personality').notNull(),
    disease: jsonb('disease'),
    // When the player bought the fish; null for fry born in the tank. Starts the new-fish disease window.
    introducedAt: timestamptz('introduced_at'),
    // The tank the fish was moved out of, and its introducedAt there, so moving it back restores
    // the old tank's settled-in state instead of counting it as new.
    previousTankId: uuid('previous_tank_id'),
    previousIntroducedAt: timestamptz('previous_introduced_at'),
  },
  (t) => [index('fish_tank_id_idx').on(t.tankId)],
);

export const tankVisits = pgTable(
  'tank_visits',
  {
    tankId: uuid('tank_id')
      .notNull()
      .references(() => tanks.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tankId, t.day] })],
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

export const reminderPrefs = pgTable('reminder_prefs', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  mailEnabled: boolean('mail_enabled').notNull().default(false),
  pushEnabled: boolean('push_enabled').notNull().default(false),
  lastSentAt: timestamptz('last_sent_at'),
});

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastUsedAt: timestamptz('last_used_at'),
  },
  (t) => [index('push_subscriptions_user_id_idx').on(t.userId)],
);

export const releasedHandles = pgTable('released_handles', {
  handle: text('handle').primaryKey(),
  releasedAt: timestamptz('released_at').notNull().defaultNow(),
});

export const reactionKindEnum = pgEnum('reaction_kind', ['heart', 'star', 'wow']);

export const tankReactions = pgTable(
  'tank_reactions',
  {
    tankId: uuid('tank_id')
      .notNull()
      .references(() => tanks.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: reactionKindEnum('kind').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tankId, t.userId] }),
    index('tank_reactions_user_id_idx').on(t.userId),
  ],
);

export const tankVotes = pgTable(
  'tank_votes',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    weekStart: timestamptz('week_start').notNull(),
    tankId: uuid('tank_id')
      .notNull()
      .references(() => tanks.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.weekStart] }),
    index('tank_votes_week_tank_idx').on(t.weekStart, t.tankId),
    index('tank_votes_tank_id_idx').on(t.tankId),
  ],
);

export const tankOfWeek = pgTable('tank_of_week', {
  weekStart: timestamptz('week_start').primaryKey(),
  // null: the week was settled with no eligible tank, or the winner was deleted. Kept so it is never re-decided.
  tankId: uuid('tank_id').references(() => tanks.id, { onDelete: 'set null' }),
  votes: integer('votes').notNull(),
  decidedAt: timestamptz('decided_at').notNull().defaultNow(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamptz('at').notNull().defaultNow(),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'cascade' }),
    tankId: uuid('tank_id').references(() => tanks.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [index('audit_log_tank_id_at_idx').on(t.tankId, t.at)],
);

export const collectionEntries = pgTable(
  'collection_entries',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    species: text('species').notNull(),
    keptAt: timestamptz('kept_at').notNull(),
    bredAt: timestamptz('bred_at'),
    raisedAt: timestamptz('raised_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.species] })],
);

export const achievementAwards = pgTable(
  'achievement_awards',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    achievementId: text('achievement_id').notNull(),
    earnedAt: timestamptz('earned_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.achievementId] })],
);

export const ledgerReasonEnum = pgEnum('ledger_reason', [
  'purchase',
  'earn',
  'grant',
  'pack',
  'subscription',
  'refund',
  'clawback',
  'restore',
]);
export const ledgerSourceEnum = pgEnum('ledger_source', ['stripe', 'apple', 'game']);

export const wallet = pgTable('wallet', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  balance: integer('balance').notNull().default(0),
});

// SET NULL, not cascade: real-money rows outlive the account, pseudonymised, for 10 years. Play rows
// (source 'game') are deleted explicitly before the user row, and ledger_game_has_user turns a
// forgotten delete into an error instead of an orphan.
export const ledger = pgTable(
  'ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    delta: integer('delta').notNull(),
    reason: ledgerReasonEnum('reason').notNull(),
    source: ledgerSourceEnum('source').notNull(),
    itemRef: text('item_ref'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ledger_payment_key_idx')
      .on(t.source, t.idempotencyKey)
      .where(sql`${t.source} <> 'game'`),
    uniqueIndex('ledger_play_key_idx')
      .on(t.userId, t.idempotencyKey)
      .where(sql`${t.source} = 'game'`),
    index('ledger_user_id_created_at_idx').on(t.userId, t.createdAt),
    check('ledger_delta_nonzero', sql`${t.delta} <> 0`),
    check('ledger_game_has_user', sql`${t.source} <> 'game' or ${t.userId} is not null`),
  ],
);

export const giftStatusEnum = pgEnum('gift_status', [
  'open',
  'countered',
  'accepted',
  'declined',
  'cancelled',
  'expired',
]);

// The sender's fish is deleted from the tank and kept here as a snapshot while the offer is open;
// it is re-inserted with the same id into the sender's tank on a return, or the recipient's on
// acceptance. to_user_id is SET NULL so deleting the recipient's account leaves the fish findable:
// the next settle returns it to the sender. A deleted sender takes the offer, and its fish, along.
export const giftOffers = pgTable(
  'gift_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromUserId: text('from_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    toUserId: text('to_user_id').references(() => user.id, { onDelete: 'set null' }),
    fromTankId: uuid('from_tank_id')
      .notNull()
      .references(() => tanks.id, { onDelete: 'cascade' }),
    status: giftStatusEnum('status').notNull().default('open'),
    fish: jsonb('fish').notNull(),
    wantsReturn: boolean('wants_return').notNull().default(false),
    recipientTankId: uuid('recipient_tank_id'),
    pledgedFishId: uuid('pledged_fish_id'),
    creationKey: text('creation_key').notNull(),
    acceptKey: text('accept_key'),
    confirmKey: text('confirm_key'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    settledAt: timestamptz('settled_at'),
  },
  (t) => [
    uniqueIndex('gift_offers_creation_key_idx').on(t.fromUserId, t.creationKey),
    index('gift_offers_from_user_idx').on(t.fromUserId, t.status),
    index('gift_offers_to_user_idx').on(t.toUserId, t.status),
    index('gift_offers_from_tank_idx').on(t.fromTankId),
  ],
);

// At most one row: the id check pins it. The tank itself is an ordinary tanks row with no owner.
export const communityTank = pgTable(
  'community_tank',
  {
    id: integer('id').primaryKey().default(1),
    tankId: uuid('tank_id')
      .notNull()
      .unique()
      .references(() => tanks.id, { onDelete: 'restrict' }),
  },
  (t) => [check('community_tank_singleton', sql`${t.id} = 1`)],
);

// One row per accepted community feed. Cascades with the account, so the quota history is personal
// data that leaves with it.
export const communityFeeds = pgTable(
  'community_feeds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    food: text('food').notNull(),
    portion: doublePrecision('portion').notNull(),
    fedAt: timestamptz('fed_at').notNull(),
  },
  (t) => [
    uniqueIndex('community_feeds_user_key_idx').on(t.userId, t.idempotencyKey),
    index('community_feeds_fed_at_idx').on(t.fedAt),
  ],
);

// Append-only history: every confirm/withdraw cycle is a row, and at most one row per user is open.
export const adultConfirmations = pgTable(
  'adult_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    confirmedAt: timestamptz('confirmed_at').notNull().defaultNow(),
    withdrawnAt: timestamptz('withdrawn_at'),
  },
  (t) => [
    index('adult_confirmations_user_idx').on(t.userId, t.confirmedAt),
    uniqueIndex('adult_confirmations_open_idx')
      .on(t.userId)
      .where(sql`${t.withdrawnAt} is null`),
  ],
);

export const paymentChargeKindEnum = pgEnum('payment_charge_kind', ['pack', 'invoice']);

// One row per paid Checkout Session (kind pack, id cs_...) or paid subscription invoice (kind
// invoice, id in_...). SET NULL like the ledger: the accounting record outlives the account. A pack
// row is written in the same transaction as the credit, so its existence means "credited".
export const paymentCharges = pgTable(
  'payment_charges',
  {
    id: text('id').primaryKey(),
    kind: paymentChargeKindEnum('kind').notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    paymentIntentId: text('payment_intent_id'),
    amountCents: integer('amount_cents').notNull(),
    packId: text('pack_id'),
    packPearls: integer('pack_pearls'),
    subscriptionId: text('subscription_id'),
    periodStart: timestamptz('period_start'),
    periodEnd: timestamptz('period_end'),
    consentAt: timestamptz('consent_at'),
    receiptPending: boolean('receipt_pending').notNull().default(false),
    receiptAttempts: integer('receipt_attempts').notNull().default(0),
    receiptNextTryAt: timestamptz('receipt_next_try_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_charges_intent_idx')
      .on(t.paymentIntentId)
      .where(sql`${t.paymentIntentId} is not null`),
    index('payment_charges_subscription_idx').on(t.subscriptionId),
    check('payment_charges_amount_nonneg', sql`${t.amountCents} >= 0`),
  ],
);

// invoice_payment.paid names the PaymentIntent of an invoice, which refunds and disputes later
// refer to. It can arrive before invoice.paid created the charge row, so there is no foreign key.
export const paymentIntentLinks = pgTable('payment_intent_links', {
  paymentIntentId: text('payment_intent_id').primaryKey(),
  invoiceId: text('invoice_id').notNull(),
});

export const paymentRefunds = pgTable('payment_refunds', {
  refundId: text('refund_id').primaryKey(),
  chargeId: text('charge_id')
    .notNull()
    .references(() => paymentCharges.id, { onDelete: 'cascade' }),
  cents: integer('cents').notNull(),
  pearls: integer('pearls').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const paymentDisputeStateEnum = pgEnum('payment_dispute_state', ['lost', 'won']);

export const paymentDisputes = pgTable('payment_disputes', {
  disputeId: text('dispute_id').primaryKey(),
  chargeId: text('charge_id')
    .notNull()
    .references(() => paymentCharges.id, { onDelete: 'cascade' }),
  state: paymentDisputeStateEnum('state').notNull(),
  cents: integer('cents').notNull(),
  pearls: integer('pearls').notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

// paidStart/paidEnd come from the latest paid invoice. Daily Pearls need status active, now inside
// that window and paidRevoked false (the invoice was refunded in full or its dispute lost).
export const clubSubscriptions = pgTable(
  'club_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    status: text('status').notNull(),
    statusEventAt: timestamptz('status_event_at').notNull().defaultNow(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    paidInvoiceId: text('paid_invoice_id'),
    paidStart: timestamptz('paid_start'),
    paidEnd: timestamptz('paid_end'),
    paidRevoked: boolean('paid_revoked').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('club_subscriptions_user_idx').on(t.userId)],
);
