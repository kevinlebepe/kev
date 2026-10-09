// Handing a candidate from the browser to the desktop application. The link
// carries only which exam to open. Nothing secret travels in it: the
// candidate signs in again inside the application.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function launchLink(assignmentId: string): string {
  return `examguard://open?exam=${encodeURIComponent(assignmentId)}`;
}

/** The exam named in the address (`?exam=...`), if it is a real id. */
export function examFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('exam');
  return value && UUID.test(value) ? value : null;
}

/** Where candidates download the application. Set for each deployment. */
export const DOWNLOAD_URL: string | undefined = import.meta.env.VITE_DESKTOP_DOWNLOAD_URL || undefined;
