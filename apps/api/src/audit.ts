import { schema, type Database } from './db/index.ts';

export type AuditAction =
  | 'share_enabled'
  | 'share_rotated'
  | 'share_revoked'
  | 'reaction_set'
  | 'reaction_removed'
  | 'vote_set'
  | 'vote_removed';

type Executor = Pick<Database['db'], 'insert'>;

export interface AuditEntry {
  action: AuditAction;
  actorId: string;
  tankId: string;
  detail?: Record<string, string>;
}

// detail must never carry a share token, an address or free text.
export async function audit(executor: Executor, entry: AuditEntry): Promise<void> {
  await executor.insert(schema.auditLog).values({
    action: entry.action,
    actorId: entry.actorId,
    tankId: entry.tankId,
    detail: entry.detail ?? {},
  });
}
