import { useEffect, useState } from 'react';
import { ActionButton, Badge, Check, ErrorText, Field, Form, Loading, Page } from '../components/ui';
import { request } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useApi } from '../lib/useApi';

interface WebhookView {
  configured: boolean;
  url: string | null;
  events: string[];
  enabled: boolean;
  secretHint: string | null;
  availableEvents: string[];
  deliveries: { id: string; event: string; attempts: number; createdAt: string; deliveredAt: string | null; failedAt: string | null; lastStatus: number | null; lastError: string | null }[];
}

const EVENT_TEXT: Record<string, string> = {
  'attempt.submitted': 'A candidate submits an exam, or it is submitted for them',
  'result.released': 'A result is released',
};

export function Integrations() {
  const hook = useApi<WebhookView>('/integrations/webhook');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [secret, setSecret] = useState<string | null>(null);
  const d = hook.data;

  useEffect(() => {
    if (!d) return;
    setUrl(d.url ?? '');
    setEvents(d.configured ? d.events : d.availableEvents);
    setEnabled(d.configured ? d.enabled : true);
  }, [d]);

  async function save(rotateSecret: boolean) {
    const res = await request<{ secret?: string }>('PUT', '/integrations/webhook', { url: url.trim(), events, enabled, rotateSecret });
    setSecret(res.secret ?? null);
    await hook.reload();
  }

  return (
    <Page title="Integrations">
      <p className="muted">
        A webhook sends a message to your own system, such as a student records system, when something happens in ExamGuard. Each message is signed so
        your system can check it came from ExamGuard.
      </p>
      <ErrorText error={hook.error} />
      <Loading loading={hook.loading}>
        {d && (
          <>
            {secret && (
              <div className="banner warn" role="status">
                <p>Copy this signing secret now. It is not shown again.</p>
                <code className="secret">{secret}</code>
              </div>
            )}
            <Form submitText={d.configured ? 'Save webhook' : 'Create webhook'} onSubmit={() => save(false)}>
              <h2>Webhook</h2>
              <Field label="Address" hint="Must start with https://">
                <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://records.example.ac.za/examguard" required />
              </Field>
              <fieldset>
                <legend>Send a message when</legend>
                {d.availableEvents.map((e) => (
                  <Check
                    key={e}
                    label={EVENT_TEXT[e] ?? e}
                    checked={events.includes(e)}
                    onChange={(v) => setEvents(v ? [...events, e] : events.filter((x) => x !== e))}
                  />
                ))}
              </fieldset>
              <Check label="Switched on" checked={enabled} onChange={setEnabled} />
              {d.secretHint && <p className="muted small">Signing secret: {d.secretHint}</p>}
            </Form>
            {d.configured && (
              <div className="row">
                <ActionButton onClick={() => request('POST', '/integrations/webhook/test').then(() => hook.reload())} disabled={!d.enabled}>
                  Send a test message
                </ActionButton>
                <ActionButton confirm="Make a new signing secret? Your system must be updated with it straight away." onClick={() => save(true)}>
                  New signing secret
                </ActionButton>
              </div>
            )}

            <section className="card">
              <h2>Recent messages</h2>
              {d.deliveries.length === 0 ? (
                <p className="muted">None yet.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Event</th>
                        <th>Status</th>
                        <th>Tries</th>
                        <th>Last answer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.deliveries.map((x) => (
                        <tr key={x.id}>
                          <td className="small">{formatDateTime(x.createdAt)}</td>
                          <td className="mono small">{x.event}</td>
                          <td>{x.deliveredAt ? <Badge value="delivered" tone="ok" /> : x.failedAt ? <Badge value="failed" tone="bad" /> : <Badge value="waiting" tone="warn" />}</td>
                          <td>{x.attempts}</td>
                          <td className="small">{x.lastError ?? x.lastStatus ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="muted small">
                Failed messages are tried again after 2, 4, 8 minutes and so on, up to 8 tries. Your system should answer with a 2xx status within 10 seconds.
              </p>
            </section>
          </>
        )}
      </Loading>
    </Page>
  );
}
