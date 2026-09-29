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
          <li>Invite candidates, then approve them once they accept.</li>
          <li>Create an exam, add questions, set the rules, then publish it. A published version never changes.</li>
          <li>Create a session for the published version, assign candidates and roster invigilators.</li>
          <li>Open the session. Candidates run the device check and sit the exam; invigilators watch the live console.</li>
          <li>Mark free text answers, then release the results.</li>
        </ol>
      </section>
    </Page>
  );
}
