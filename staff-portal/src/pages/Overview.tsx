import { Badge, Loading, Page, Stat } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { href } from '../lib/router';
import { can, useMe } from '../lib/session';
import { useApi } from '../lib/useApi';

interface LiveSession {
  id: string;
  name: string;
  status: string;
  startsAt: string;
  endsAt: string;
  examName: string;
  candidates: number;
  assigned: number;
}

interface HealthData {
  status: string;
  components: { name: string; label: string; status: string; message: string }[];
  sitting: number;
  offline: number;
  recentSeriousEvents: number;
  incidents: { area: string; severity: string; message: string; sessionId?: string }[];
}

const STATUS_TEXT: Record<string, string> = { ok: '✓ Working', off: '✓ Not used', degraded: '! Limited', down: '✕ Not working' };
const AREA_TEXT: Record<string, string> = {
  service: 'Whole service',
  widespread: 'Many candidates at once',
  regional: 'One session or venue',
  candidate: 'Individual candidates',
  authentication: 'Sign in',
  storage: 'Recording storage',
  live_media: 'Live video',
};

/** System health and incidents (spec sections 5 and 17), refreshed every 30 seconds. */
function SystemHealth() {
  const health = useApi<HealthData>('/system/health', 30_000);
  const d = health.data;
  const shown = ['api', 'database', 'storage', 'media', 'email', 'webhooks', 'workers', 'authentication'];
  return (
    <section className="card" aria-labelledby="health-title">
      <h2 id="health-title">System health</h2>
      <Loading loading={health.loading}>
        {d && (
          <>
            <ul className="health">
              {d.components
                .filter((c) => shown.includes(c.name))
                .map((c) => (
                  <li key={c.name} className={`health-item ${c.status}`} title={c.message}>
                    <span className="health-label">{c.label}</span>
                    <span className="health-status">{STATUS_TEXT[c.status] ?? c.status}</span>
                  </li>
                ))}
            </ul>
            <div className="stats">
              <Stat label="candidates sitting now" value={d.sitting} />
              <Stat label="of them offline" value={d.offline} tone={d.offline ? 'warn' : ''} />
              <Stat label="serious events, last 15 minutes" value={d.recentSeriousEvents} tone={d.recentSeriousEvents ? 'bad' : ''} />
            </div>
            {d.incidents.length > 0 && (
              <>
                <h3>Incidents</h3>
                <ul className="incidents">
                  {d.incidents.map((i, n) => (
                    <li key={n} className={`incident ${i.severity}`}>
                      <strong>{AREA_TEXT[i.area] ?? i.area}:</strong> {i.message} {i.sessionId && <a href={href('live', i.sessionId)}>Open the console</a>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {d.components
              .filter((c) => c.status === 'degraded' || c.status === 'down')
              .map((c) => (
                <p key={c.name} className="small muted">
                  {c.label}: {c.message}
                </p>
              ))}
          </>
        )}
      </Loading>
    </section>
  );
}

export function Overview() {
  const me = useMe();
  const pending = useApi<{ items: unknown[] }>(can(me, 'candidate:view') ? '/candidates?status=pending_approval&limit=100' : null);
  const live = useApi<{ scope: string; items: LiveSession[] }>(can(me, 'live:view') ? '/live/sessions' : null);

  return (
    <Page title={`Welcome, ${me.user.display_name}`}>
      <div className="stats">
        {can(me, 'candidate:view') && (
          <a className="stat-link" href={href('candidates')}>
            <Stat label="candidates waiting for approval" value={pending.data ? (pending.data.items.length >= 100 ? '100+' : pending.data.items.length) : '…'} tone={pending.data?.items.length ? 'warn' : ''} />
          </a>
        )}
        {can(me, 'live:view') && (
          <a className="stat-link" href={href('live')}>
            <Stat label="scheduled or open sessions" value={live.data ? live.data.items.length : '…'} />
          </a>
        )}
      </div>

      {can(me, 'report:view') && <SystemHealth />}

      {can(me, 'live:view') && (
        <section className="card">
          <h2>{live.data?.scope === 'invigilator' ? 'Sessions you are rostered on' : 'Current sessions'}</h2>
          <Loading loading={live.loading} empty={live.data?.items.length === 0 && 'Nothing scheduled.'}>
            <div className="table-wrap">
        <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Exam</th>
                  <th>Starts</th>
                  <th>Status</th>
                  <th>Candidates</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {live.data?.items.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td>{s.examName}</td>
                    <td>{formatDateTime(s.startsAt)}</td>
                    <td>
                      <Badge value={s.status} />
                    </td>
                    <td>{live.data?.scope === 'invigilator' ? `${s.assigned} assigned to you` : s.candidates}</td>
                    <td>
                      <a href={href('live', s.id)}>Open console</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
        </div>
          </Loading>
        </section>
      )}

      <section className="card">
        <h2>How an exam runs</h2>
        <ol className="steps">
          <li>
            <a href={href('candidates')}>Candidates</a>: invite them, or let them create an account, then approve them.
          </li>
          <li>
            <a href={href('exams')}>Exams</a>: add questions, choose how closely to watch, then publish.
          </li>
          <li>
            <a href={href('sessions')}>Sessions</a>: pick a date and time, then add candidates and invigilators. Candidates are shared out among the
            invigilators by themselves.
          </li>
          <li>On the day, candidates sit the exam and invigilators watch the live console.</li>
          <li>
            <a href={href('marking')}>Marking and results</a>: mark written answers, then release the results.
          </li>
        </ol>
      </section>
    </Page>
  );
}
