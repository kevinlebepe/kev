import { useState } from 'react';
import { ErrorText, Loading, Page } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { useApi } from '../lib/useApi';

interface Entry {
  id: number;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export function Audit() {
  const [offset, setOffset] = useState(0);
  const list = useApi<{ items: Entry[]; nextOffset: number | null }>(`/audit?limit=100&offset=${offset}`);
  return (
    <Page title="Audit log">
      <p className="muted">Every change in the organisation, newest first. Entries can never be edited or deleted.</p>
      <ErrorText error={list.error} />
      <Loading loading={list.loading} empty={list.data?.items.length === 0 && 'Nothing recorded yet.'}>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>On</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((e) => (
              <tr key={e.id}>
                <td className="small">{formatDateTime(e.createdAt)}</td>
                <td className="small">{e.actorEmail ?? 'System'}</td>
                <td className="mono small">{e.action}</td>
                <td className="small">
                  {e.targetType} <span className="mono muted">{e.targetId?.slice(0, 8)}</span>
                </td>
                <td className="mono small details">{Object.keys(e.data).length ? JSON.stringify(e.data) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Loading>
      <div className="row pager">
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>
          ‹ Newer
        </button>
        <button disabled={list.data?.nextOffset == null} onClick={() => setOffset(list.data!.nextOffset!)}>
          Older ›
        </button>
      </div>
    </Page>
  );
}
