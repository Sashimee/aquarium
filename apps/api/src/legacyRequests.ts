import { randomUUID } from 'node:crypto';

// TODO(#924): the create-tank, treat and bottled-bacteria schemas still make idempotencyKey
// optional; make it required there too, then delete this file.
export const legacyKey = (key: string | undefined): string => key ?? randomUUID();
