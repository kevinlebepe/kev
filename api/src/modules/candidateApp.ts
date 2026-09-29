import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../context.js';
import { withTransaction } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { authorize, requireCandidate, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { notify } from '../notifications.js';
import { examConfig } from '../examConfig.js';
import { evaluateReadiness, readinessReport } from '../readiness.js';
import { signManifest } from '../signing.js';
import { idParams, page, pagination, parse } from '../validation.js';

// Endpoints used by the candidate secure application (spec sections 4, 9, 10).
export async function candidateAppRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;

  app.get('/me/entitlements', async (req) => {
    const auth = requireCandidate(req);
    const { rows } = await db.query<{ config: unknown } & Record<string, unknown>>(
      `SELECT a.id, a.status, s.id AS "sessionId", s.name AS "sessionName", s.status AS "sessionStatus",
              s.starts_at AS "startsAt", s.ends_at AS "endsAt",
              v.manifest->>'name' AS "examName", v.manifest->>'code' AS "examCode", v.version AS "examVersion",
              v.manifest->'config' AS config,
              rc.passed AS "lastCheckPassed", rc.checks AS "lastChecks", rc.created_at AS "lastCheckedAt"
         FROM exam_assignments a
         JOIN sessions s ON s.id = a.session_id
         JOIN exam_versions v ON v.id = s.exam_version_id
         LEFT JOIN readiness_checks rc ON rc.id = a.last_check_id
        WHERE a.candidate_id = $1 AND a.organisation_id = $2 AND a.status <> 'revoked'
        ORDER BY s.starts_at`,
      [auth.candidateId, auth.organisationId],
    );
    // Candidates see what will be monitored and what the device needs, never marking settings.
    return {
      items: rows.map(({ config: raw, ...row }) => {
        const c = examConfig.parse(raw ?? {});
        return { ...row, requirements: { timing: c.timing, security: c.security, offline: c.offline, device: c.device } };
      }),
    };
  });

  // Can be run any number of times, days before the exam (spec section 10).
  app.post('/me/entitlements/:id/precheck', async (req) => {
    const auth = requireCandidate(req);
    const { id } = parse(idParams, req.params);
    const report = parse(readinessReport, req.body);

    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{
        status: string;
        session_status: string;
        config: unknown;
        identity_status: string;
        user_id: string;
      }>(
        `SELECT a.status, s.status AS session_status, v.manifest->'config' AS config, c.identity_status, c.user_id
           FROM exam_assignments a
           JOIN sessions s ON s.id = a.session_id
           JOIN exam_versions v ON v.id = s.exam_version_id
           JOIN candidates c ON c.id = a.candidate_id
          WHERE a.id = $1 AND a.candidate_id = $2 AND a.organisation_id = $3
          FOR UPDATE OF a`,
        [id, auth.candidateId, auth.organisationId],
      );
      const row = rows[0];
      if (!row || row.status === 'revoked') throw notFound('Entitlement');
      if (!['assigned', 'precheck_complete'].includes(row.status)) throw conflict(`Entitlement is already ${row.status}`);
      if (!['scheduled', 'open'].includes(row.session_status)) throw conflict(`Session is ${row.session_status}`);

      const { rows: now } = await tx.query<{ now: Date }>('SELECT now()');
      const result = evaluateReadiness(examConfig.parse(row.config ?? {}), report, {
        identityVerified: row.identity_status === 'verified',
        serverTime: now[0]!.now,
      });

      const { rows: inserted } = await tx.query<{ id: string }>(
        `INSERT INTO readiness_checks (organisation_id, assignment_id, passed, checks, report, client_ip)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [auth.organisationId, id, result.passed, JSON.stringify(result.checks), report, req.ip],
      );
      const status = result.passed ? 'precheck_complete' : 'assigned';
      await tx.query('UPDATE exam_assignments SET status = $2, last_check_id = $3 WHERE id = $1', [id, status, inserted[0]!.id]);

      if (!result.passed) {
        await notify(tx, {
          organisationId: auth.organisationId,
          kind: 'readiness_failure',
          recipientUserId: row.user_id,
          payload: { assignmentId: id, failed: result.checks.filter((c) => !c.passed).map((c) => c.key) },
        });
      }
      await audit(tx, {
        ...auditFrom(req),
        action: result.passed ? 'readiness.passed' : 'readiness.failed',
        targetType: 'exam_assignment',
        targetId: id,
      });
      return { assignmentId: id, status, ...result };
    });
  });

  // The signed exam package plus a signed entitlement the application caches
  // locally, so a later authentication outage cannot stop a started exam (spec section 3).
  app.get('/me/entitlements/:id/package', async (req) => {
    const auth = requireCandidate(req);
    const { id } = parse(idParams, req.params);

    const { rows } = await db.query<{
      status: string;
      candidate_status: string;
      session_id: string;
      session_status: string;
      exam_version_id: string;
      not_before: Date;
      not_after: Date;
      too_early: boolean;
      too_late: boolean;
      manifest: unknown;
      manifest_sha256: string;
      signature: string;
      signing_key_id: string;
    }>(
      `SELECT a.status, c.status AS candidate_status, s.id AS session_id, s.status AS session_status,
              v.id AS exam_version_id,
              s.starts_at - make_interval(mins => $4) AS not_before, s.ends_at AS not_after,
              now() < s.starts_at - make_interval(mins => $4) AS too_early, now() > s.ends_at AS too_late,
              v.manifest, v.manifest_sha256, v.signature, v.signing_key_id
         FROM exam_assignments a
         JOIN candidates c ON c.id = a.candidate_id
         JOIN sessions s ON s.id = a.session_id
         JOIN exam_versions v ON v.id = s.exam_version_id
        WHERE a.id = $1 AND a.candidate_id = $2 AND a.organisation_id = $3`,
      [id, auth.candidateId, auth.organisationId, config.packagePrefetchMinutes],
    );
    const row = rows[0];
    if (!row || row.status === 'revoked') throw notFound('Entitlement');
    if (row.candidate_status !== 'approved') throw conflict('Candidate is not approved');
    if (!['precheck_complete', 'active'].includes(row.status)) throw conflict('Complete the device check first');
    if (!['scheduled', 'open'].includes(row.session_status)) throw conflict(`Session is ${row.session_status}`);
    if (row.too_early) throw conflict(`The exam package is available from ${row.not_before.toISOString()}`);
    if (row.too_late) throw conflict('This session has ended');

    const entitlement = {
      schema: 'examguard.entitlement/1',
      organisationId: auth.organisationId,
      candidateId: auth.candidateId,
      assignmentId: id,
      sessionId: row.session_id,
      examVersionId: row.exam_version_id,
      manifestSha256: row.manifest_sha256,
      notBefore: row.not_before.toISOString(),
      notAfter: row.not_after.toISOString(),
      issuedAt: new Date().toISOString(),
    };
    const signedEntitlement = signManifest(entitlement, config.examSigning.privateKey);

    await audit(db, { ...auditFrom(req), action: 'package.download', targetType: 'exam_assignment', targetId: id });
    return {
      keyId: config.examSigning.keyId,
      exam: { manifest: row.manifest, manifestSha256: row.manifest_sha256, signature: row.signature, keyId: row.signing_key_id },
      entitlement: { payload: entitlement, signature: signedEntitlement.signature },
    };
  });

  // Organisation view of readiness before the session (spec section 10).
  app.get('/sessions/:id/readiness', { preHandler: authorize('session:manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { limit, offset } = parse(pagination, req.query);
    const { rowCount } = await db.query('SELECT 1 FROM sessions WHERE id = $1 AND organisation_id = $2', [id, auth.organisationId]);
    if (!rowCount) throw notFound('Session');
    const { rows } = await db.query(
      `SELECT a.id AS "assignmentId", c.id AS "candidateId", c.full_name AS "fullName", a.status,
              rc.passed AS "lastCheckPassed", rc.created_at AS "lastCheckedAt",
              coalesce((SELECT jsonb_agg(x->>'key') FROM jsonb_array_elements(rc.checks) x
                         WHERE (x->>'passed')::boolean = false), '[]') AS "failedChecks"
         FROM exam_assignments a
         JOIN candidates c ON c.id = a.candidate_id
         LEFT JOIN readiness_checks rc ON rc.id = a.last_check_id
        WHERE a.session_id = $1 AND a.status <> 'revoked'
        ORDER BY (rc.passed IS TRUE), c.full_name, a.id
        LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    );
    return page(rows, limit, offset);
  });
}
