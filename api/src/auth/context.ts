import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { forbidden, unauthorized } from '../errors.js';
import { verifyAccessToken } from './tokens.js';

export type PermissionKey =
  | 'exam:create'
  | 'exam:publish'
  | 'session:manage'
  | 'candidate:view'
  | 'candidate:invite'
  | 'candidate:approve'
  | 'invigilator:create'
  | 'invigilation:allocate'
  | 'live:view'
  | 'live:voice'
  | 'recording:view'
  | 'recording:download'
  | 'report:view'
  | 'result:release'
  | 'organisation:manage_users'
  | 'organisation:manage_security'
  | 'audit:view';

export interface AuthContext {
  userId: string;
  isSuperAdmin: boolean;
  /** Set when the token is scoped to an organisation the user belongs to (as staff and/or candidate). */
  organisationId: string | null;
  /** Staff permissions from the user's role; empty for candidates. */
  permissions: ReadonlySet<PermissionKey>;
  /** Set when the user is a candidate of the scoped organisation. */
  candidateId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/**
 * Resolves the caller from the bearer token. Permissions are loaded from the
 * database on every request rather than embedded in the token, so suspending a
 * member or changing a role takes effect immediately.
 */
export async function resolveAuth(db: Db, config: Config, req: FastifyRequest): Promise<AuthContext | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const claims = await verifyAccessToken(config, header.slice(7));
  if (!claims) return null;

  const { rows: users } = await db.query<{ platform_role: string | null }>(
    'SELECT platform_role FROM users WHERE id = $1',
    [claims.sub],
  );
  const user = users[0];
  if (!user) return null;

  let permissions = new Set<PermissionKey>();
  let candidateId: string | null = null;
  if (claims.org) {
    const { rows } = await db.query<{ permission_key: PermissionKey | null }>(
      `SELECT rp.permission_key
         FROM organisation_users ou
         LEFT JOIN role_permissions rp ON rp.role_id = ou.role_id
        WHERE ou.organisation_id = $1 AND ou.user_id = $2 AND ou.status = 'active'`,
      [claims.org, claims.sub],
    );
    permissions = new Set(rows.flatMap((r) => (r.permission_key ? [r.permission_key] : [])));

    const { rows: candidates } = await db.query<{ id: string }>(
      `SELECT id FROM candidates
        WHERE organisation_id = $1 AND user_id = $2 AND status NOT IN ('rejected', 'blocked')`,
      [claims.org, claims.sub],
    );
    candidateId = candidates[0]?.id ?? null;

    // Neither an active member nor an admissible candidate: the organisation scope is no longer valid.
    if (rows.length === 0 && !candidateId) return null;
  }

  return {
    userId: claims.sub,
    isSuperAdmin: user.platform_role === 'super_admin',
    organisationId: claims.org,
    permissions,
    candidateId,
  };
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Caller must act within an organisation; returns the tenant id every query must be scoped to. */
export function requireOrg(req: FastifyRequest): AuthContext & { organisationId: string } {
  const auth = requireAuth(req);
  if (!auth.organisationId) throw forbidden('An organisation-scoped session is required');
  return auth as AuthContext & { organisationId: string };
}

export function authorize(...required: PermissionKey[]): preHandlerAsyncHookHandler {
  return async (req) => {
    const auth = requireOrg(req);
    const missing = required.filter((p) => !auth.permissions.has(p));
    if (missing.length) throw forbidden(`Missing permission: ${missing.join(', ')}`);
  };
}

export const requireSuperAdmin: preHandlerAsyncHookHandler = async (req) => {
  if (!requireAuth(req).isSuperAdmin) throw forbidden('Platform super admin only');
};
