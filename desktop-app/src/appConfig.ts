// Where the exam screens come from. An installed application uses only the
// address fixed when it was built, so nobody can point it at another site by
// changing the environment. Running from source may override it for testing.

export const DEFAULT_APP_URL = 'http://localhost:5173';

export function resolveAppUrl(opts: { packaged: boolean; env: Record<string, string | undefined>; bundled: string | null }): string {
  const candidate = !opts.packaged && opts.env.EXAMGUARD_URL ? opts.env.EXAMGUARD_URL : (opts.bundled ?? DEFAULT_APP_URL);
  const url = new URL(candidate);
  // A packaged build talks to a real deployment only over HTTPS.
  if (opts.packaged && url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error(`The exam address must use HTTPS: ${candidate}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Unsupported exam address: ${candidate}`);
  return url.toString().replace(/\/$/, '');
}

/** Reads the address written into the build by scripts/write-config.mjs. */
export function bundledAppUrl(read: () => string): string | null {
  try {
    const parsed = JSON.parse(read()) as { appUrl?: unknown };
    return typeof parsed.appUrl === 'string' ? parsed.appUrl : null;
  } catch {
    return null;
  }
}
