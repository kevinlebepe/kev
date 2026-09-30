// Opening the application from a link in the browser (examguard://open?exam=...).
// The link names only an exam. The address the application shows always comes
// from its own settings and never from a link, so a link cannot send it to
// another site, and no password or token travels in it.

export const PROTOCOL = 'examguard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LaunchLink {
  exam: string;
}

export function parseLaunchLink(raw: string): LaunchLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL}:` || url.hostname !== 'open') return null;
  const exam = url.searchParams.get('exam');
  return exam && UUID.test(exam) ? { exam: exam.toLowerCase() } : null;
}

/** On Windows and Linux the link arrives as a command line argument. */
export function findLaunchLink(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}:`)) ?? null;
}

/** The page to show: the application's own address, plus which exam to open. */
export function launchTarget(appUrl: string, link: LaunchLink | null): string {
  if (!link) return appUrl;
  const target = new URL(appUrl);
  target.searchParams.set('exam', link.exam);
  return target.toString();
}
