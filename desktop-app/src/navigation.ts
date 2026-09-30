// The window may only show ExamGuard. Anything else is refused, so a link on a
// page cannot take the candidate to a search engine or another site.

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function isAllowedNavigation(url: string, appOrigin: string): boolean {
  return originOf(url) === appOrigin;
}

// Camera and microphone for the exam, and full screen. Everything else a page
// can ask for (location, notifications, clipboard reading, and so on) is refused.
const ALLOWED_PERMISSIONS = new Set(['media', 'fullscreen']);

export function isAllowedPermission(permission: string, requestingUrl: string, appOrigin: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && originOf(requestingUrl) === appOrigin;
}
