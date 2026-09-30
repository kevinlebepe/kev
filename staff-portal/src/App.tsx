import { useCallback, useEffect, useState } from 'react';
import { completeSso, request, resumeSession, signOut } from './lib/api';
import { href, useRoute } from './lib/router';
import { can, type Me, MeContext } from './lib/session';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Candidates } from './pages/Candidates';
import { Exams, ExamDetail } from './pages/Exams';
import { Sessions, SessionDetail } from './pages/Sessions';
import { Invigilators } from './pages/Invigilators';
import { LiveSessions, LiveConsole } from './pages/Live';
import { MarkingSessions, Results, Marking } from './pages/Results';
import { Staff } from './pages/Staff';
import { Audit } from './pages/Audit';
import { Integrations } from './pages/Integrations';
import { AttemptReport, Reports } from './pages/Reports';
import { Notifications, NotificationsLink } from './pages/Notifications';
import { Support } from './pages/Support';
import { Account, TwoFactorRequired } from './pages/Account';
import { AcceptStaffInvitation, ResetPassword } from './pages/Public';

interface NavItem {
  path: string;
  text: string;
  permission: string;
}

const NAV: NavItem[] = [
  { path: 'live', text: 'Live console', permission: 'live:view' },
  { path: 'sessions', text: 'Sessions', permission: 'session:manage' },
  { path: 'exams', text: 'Exams', permission: 'exam:create' },
  { path: 'marking', text: 'Marking and results', permission: 'report:view' },
  { path: 'reports', text: 'Reports', permission: 'report:view' },
  { path: 'candidates', text: 'Candidates', permission: 'candidate:view' },
  { path: 'invigilators', text: 'Invigilators', permission: 'invigilator:create' },
  { path: 'support', text: 'Support', permission: 'support:manage' },
  { path: 'staff', text: 'Staff', permission: 'organisation:manage_users' },
  { path: 'integrations', text: 'Integrations', permission: 'organisation:manage_users' },
  { path: 'audit', text: 'Audit log', permission: 'audit:view' },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const route = useRoute();

  const load = useCallback(async () => {
    try {
      const data = await request<Me>('GET', '/me');
      if (data.organisationId && data.mfaSetupRequired) {
        setNotice(null);
        setMe(data);
        return;
      }
      if (!data.organisationId || data.permissions.length === 0) {
        await signOut();
        setNotice('This account has no staff access. Candidates sign in to the ExamGuard exam app instead.');
        setMe(null);
        return;
      }
      setNotice(null);
      setMe(data);
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    // Back from single sign on: swap the one time code for a session, then tidy the address.
    const params = new URLSearchParams(window.location.search);
    const ssoCode = params.get('sso');
    const ssoError = params.get('sso_error');
    if (ssoCode || ssoError) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    if (ssoError) setNotice(ssoError);
    const start = ssoCode ? completeSso(ssoCode).then(() => true, (err: Error) => (setNotice(err.message), false)) : resumeSession();
    start.then((ok) => (ok ? load() : setMe(null)));
  }, [load]);

  // Links from emails open before, and without, signing in.
  if (route[0] === 'invitation' && route[1]) return <AcceptStaffInvitation token={route[1]} />;
  if (route[0] === 'reset' && route[1]) return <ResetPassword token={route[1]} />;

  if (me === undefined) return <main className="centered">Starting…</main>;
  if (me === null) return <Login onSignedIn={load} notice={notice} />;
  if (me.mfaSetupRequired) {
    return (
      <MeContext.Provider value={me}>
        <TwoFactorRequired
          onChanged={load}
          onSignOut={async () => {
            await signOut();
            setMe(null);
          }}
        />
      </MeContext.Provider>
    );
  }

  const nav = NAV.filter((n) => can(me, n.permission));
  const [section, id, sub] = route;

  return (
    <MeContext.Provider value={me}>
      <div className="shell">
        <aside className="sidebar">
          <a className="brand" href="#/">
            EXAMGUARD
          </a>
          <nav aria-label="Sections">
            <ul>
              <li>
                <a href="#/" aria-current={!section ? 'page' : undefined}>
                  Overview
                </a>
              </li>
              <li>
                <NotificationsLink current={section === 'notifications'} />
              </li>
              {nav.map((n) => (
                <li key={n.path}>
                  <a href={href(n.path)} aria-current={section === n.path ? 'page' : undefined}>
                    {n.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="who">
            <span>{me.user.display_name}</span>
            <span className="muted small">{me.user.email}</span>
            <a href={href('account')} className="small">
              Your account{me.mfaEnabled ? '' : ' (turn on two factor sign in)'}
            </a>
            <button
              className="link"
              onClick={async () => {
                await signOut();
                setMe(null);
              }}
            >
              Sign out
            </button>
          </div>
        </aside>
        <main className="content">{section === 'account' ? <Account onChanged={load} /> : render(section, id, sub)}</main>
      </div>
    </MeContext.Provider>
  );
}

function render(section: string | undefined, id: string | undefined, sub: string | undefined) {
  switch (section) {
    case undefined:
      return <Overview />;
    case 'candidates':
      return <Candidates />;
    case 'exams':
      return id ? <ExamDetail id={id} /> : <Exams />;
    case 'sessions':
      if (id && sub === 'results') return <Results sessionId={id} />;
      return id ? <SessionDetail id={id} /> : <Sessions />;
    case 'marking':
      return id ? <Marking attemptId={id} /> : <MarkingSessions />;
    case 'invigilators':
      return <Invigilators />;
    case 'live':
      return id ? <LiveConsole sessionId={id} /> : <LiveSessions />;
    case 'staff':
      return <Staff />;
    case 'audit':
      return <Audit />;
    case 'reports':
      return <Reports />;
    case 'notifications':
      return <Notifications />;
    case 'support':
      return <Support {...(id ? { caseId: id } : {})} />;
    case 'report':
      return id ? <AttemptReport attemptId={id} /> : <Reports />;
    case 'integrations':
      return <Integrations />;
    default:
      return <NotFound />;
  }
}

function NotFound() {
  return (
    <section className="page">
      <h1>Page not found</h1>
      <p>
        <a href="#/">Back to the overview</a>
      </p>
    </section>
  );
}
