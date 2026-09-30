import type { FastifyRequest } from 'fastify';
import type { Queryable } from './db.js';

export interface AuditEntry {
  organisationId: string | null;
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  data?: Record<string, unknown>;
  ip?: string;
}

/** Write inside the same transaction as the change so the trail cannot diverge from the data. */
export async function audit(q: Queryable, entry: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (organisation_id, actor_user_id, action, target_type, target_id, data, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.organisationId,
      entry.actorUserId,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.data ?? {},
      entry.ip ?? null,
    ],
  );
}

export function auditFrom(req: FastifyRequest): Pick<AuditEntry, 'organisationId' | 'actorUserId' | 'ip'> {
  return {
    organisationId: req.auth?.organisationId ?? null,
    actorUserId: req.auth?.userId ?? null,
    ip: req.ip,
  };
}
