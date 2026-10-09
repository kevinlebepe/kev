import { ActionButton, ErrorText, Loading, Page } from '../components/ui';
import { request } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { href } from '../lib/router';
import { useApi } from '../lib/useApi';

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  sessionId: string | null;
  attemptId: string | null;
  caseId: string | null;
}
export interface Inbox {
  unread: number;
  items: NotificationItem[];
}

/** Where a notification leads: the attempt's report, or the session. */
function target(n: NotificationItem): string | null {
  if (n.caseId) return href('support', n.caseId);
  if (n.attemptId) return href('report', n.attemptId);
  if (n.sessionId) return href('sessions', n.sessionId);
  return null;
}

/** Sidebar link with the number of unread notifications, checked every 30 seconds. */
export function NotificationsLink({ current }: { current: boolean }) {
  const inbox = useApi<Inbox>('/me/notifications?unread=true&limit=1', 30_000);
  const n = inbox.data?.unread ?? 0;
  return (
    <a href={href('notifications')} aria-current={current ? 'page' : undefined}>
      Notifications{n > 0 && <span className="count" aria-label={`${n} unread`}>{n}</span>}
    </a>
  );
}

export function Notifications() {
  const inbox = useApi<Inbox>('/me/notifications?limit=100');
  const d = inbox.data;
  return (
    <Page
      title="Notifications"
      actions={
        d && d.unread > 0 ? (
          <ActionButton
            onClick={async () => {
              await request('POST', '/me/notifications/read', {});
              await inbox.reload();
            }}
          >
            Mark all as read
          </ActionButton>
        ) : undefined
      }
    >
      <p className="muted">Things that need attention during and around exams. Serious ones are also emailed.</p>
      <ErrorText error={inbox.error} />
      <Loading loading={inbox.loading} empty={d?.items.length === 0 && 'Nothing yet.'}>
        <ul className="notifications">
          {d?.items.map((n) => {
            const link = target(n);
            return (
              <li key={n.id} className={n.readAt ? 'card' : 'card unread'}>
                <div className="row spread">
                  <strong>
                    {!n.readAt && <span className="sr-only">Unread: </span>}
                    {n.title}
                  </strong>
                  <span className="muted small">{formatDateTime(n.createdAt)}</span>
                </div>
                <p>{n.body}</p>
                <div className="row">
                  {link && (
                    <a
                      href={link}
                      onClick={() => {
                        if (!n.readAt) void request('POST', '/me/notifications/read', { ids: [n.id] });
                      }}
                    >
                      Open
                    </a>
                  )}
                  {!n.readAt && (
                    <ActionButton
                      className="link"
                      onClick={async () => {
                        await request('POST', '/me/notifications/read', { ids: [n.id] });
                        await inbox.reload();
                      }}
                    >
                      Mark as read
                    </ActionButton>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Loading>
    </Page>
  );
}
