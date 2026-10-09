import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Db, Queryable } from './db.js';
import { withTransaction } from './db.js';

// Webhooks: ExamGuard tells an organisation's own systems when something
// happens, for example so a student record system can pick up released
// results. Deliveries are written in the same transaction as the change and
// sent by a worker, signed with the organisation's secret, and retried.

export const WEBHOOK_EVENTS = ['attempt.submitted', 'result.released'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | 'webhook.test';
export const MAX_WEBHOOK_ATTEMPTS = 8;

export interface WebhookConfig {
  url: string;
  events: string[];
  secret: string;
}

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/** Queues an event for the organisation's webhook, if it has one listening for it. */
export async function enqueueWebhook(q: Queryable, organisationId: string, event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
  await q.query(
    `INSERT INTO webhook_deliveries (organisation_id, event, payload)
     SELECT $1, $2, $3 FROM integration_configs
      WHERE organisation_id = $1 AND kind = 'webhook' AND enabled
        AND ($2 = 'webhook.test' OR config->'events' ? $2)`,
    [organisationId, event, { event, occurredAt: new Date().toISOString(), data: payload }],
  );
}

/**
 * The signature a receiver checks: HMAC SHA-256 of "timestamp.body" with the
 * secret. Including the time lets receivers refuse old, replayed messages.
 */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) {
    const rest = v6.slice(7);
    // An IPv4 address inside IPv6, written either way: ::ffff:192.168.1.1 or ::ffff:c0a8:101.
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return privateAddress(rest);
  }
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/**
 * Webhook addresses are chosen by organisations, so the server must not be
 * usable to reach its own private network. Checked at send time, after DNS.
 */
export async function checkWebhookUrl(url: string, opts: { allowPrivate: boolean; resolve?: (host: string) => Promise<string[]> }): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(opts.allowPrivate && u.protocol === 'http:')) throw new Error('Webhook addresses must use HTTPS');
  if (u.username || u.password) throw new Error('Webhook addresses cannot contain a user name or password');
  if (opts.allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await (opts.resolve ?? (async (h) => (await lookup(h, { all: true })).map((a) => a.address)))(host);
  if (!addresses.length || addresses.some(privateAddress)) throw new Error('Webhook addresses must be on the public internet');
}

export interface Sender {
  (url: string, init: { headers: Record<string, string>; body: string }): Promise<{ status: number }>;
}

const realSender: Sender = async (url, init) => {
  const res = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  return { status: res.status };
};

/** Sends due deliveries. Safe on several instances: each row is locked while sent. */
export async function deliverWebhooks(db: Db, opts: { allowPrivate: boolean; send?: Sender; resolve?: (host: string) => Promise<string[]>; limit?: number }): Promise<number> {
  let delivered = 0;
  for (let i = 0; i < (opts.limit ?? 20); i++) {
    const outcome = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string; event: string; payload: unknown; attempts: number; config: WebhookConfig | null; enabled: boolean | null }>(
        `SELECT d.id, d.event, d.payload, d.attempts, c.config, c.enabled
           FROM webhook_deliveries d
           LEFT JOIN integration_configs c ON c.organisation_id = d.organisation_id AND c.kind = 'webhook'
          WHERE d.delivered_at IS NULL AND d.failed_at IS NULL AND d.next_attempt_at <= now()
          ORDER BY d.next_attempt_at LIMIT 1
          FOR UPDATE OF d SKIP LOCKED`,
      );
      const d = rows[0];
      if (!d) return 'empty' as const;
      const fail = async (error: string, status: number | null, final: boolean) => {
        await tx.query(
          `UPDATE webhook_deliveries SET attempts = attempts + 1, last_error = $2, last_status = $3,
                  next_attempt_at = now() + make_interval(mins => power(2, attempts)::int),
                  failed_at = CASE WHEN $4 OR attempts + 1 >= $5 THEN now() END
            WHERE id = $1`,
          [d.id, error.slice(0, 500), status, final, MAX_WEBHOOK_ATTEMPTS],
        );
        return 'failed' as const;
      };
      if (!d.config || !d.enabled) return fail('The webhook is switched off', null, true);
      try {
        await checkWebhookUrl(d.config.url, opts);
      } catch (err) {
        return fail((err as Error).message, null, true);
      }
      const body = JSON.stringify({ id: d.id, ...(d.payload as object) });
      const timestamp = Math.floor(Date.now() / 1000);
      let status = 0;
      try {
        const res = await (opts.send ?? realSender)(d.config.url, {
          headers: {
            'content-type': 'application/json',
            'user-agent': 'ExamGuard-Webhooks/1',
            'x-examguard-event': d.event,
            'x-examguard-delivery': d.id,
            'x-examguard-timestamp': String(timestamp),
            'x-examguard-signature': signWebhook(d.config.secret, timestamp, body),
          },
          body,
        });
        if (res.status < 200 || res.status >= 300) return fail(`The receiver answered ${res.status}`, res.status, false);
        status = res.status;
      } catch (err) {
        return fail((err as Error).message, null, false);
      }
      await tx.query(`UPDATE webhook_deliveries SET delivered_at = now(), attempts = attempts + 1, last_status = $2, last_error = NULL WHERE id = $1`, [d.id, status]);
      return 'sent' as const;
    });
    if (outcome === 'empty') break;
    if (outcome === 'sent') delivered += 1;
  }
  return delivered;
}
