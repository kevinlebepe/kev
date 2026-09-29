// Thin client for the ExamGuard API. Access tokens live in memory only; the
// refresh token is kept for the session so a reload does not force a new login.

import { getDesktop } from './desktop';

const BASE = import.meta.env.VITE_API_BASE ?? '/api';
const REFRESH_KEY = 'examguard.refresh';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Extra detail from the server, for example the receipt of a closed attempt. */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;

function storedRefresh(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function storeRefresh(token: string | null) {
  try {
    if (token) sessionStorage.setItem(REFRESH_KEY, token);
    else sessionStorage.removeItem(REFRESH_KEY);
  } catch {
    // Storage unavailable: the candidate simply signs in again after a reload.
  }
}

async function raw(
  method: string,
  path: string,
  body?: unknown,
  token = accessToken,
  keepalive = false,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const binary = body instanceof Blob;
  return fetch(`${BASE}${path}`, {
    method,
    keepalive,
    headers: {
      // Lets the server keep desktop only exams away from browsers. It is the
      // app's own claim, so it stops mistakes rather than a determined cheat.
      'x-examguard-client': getDesktop() ? 'desktop' : 'browser',
      ...(body === undefined || binary ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
  });
}

// Refresh tokens rotate on every use, and the server treats a second use of the
// same token as theft and ends the session. If several requests find the
// access token expired at once, they must share a single refresh.
let refreshInFlight: Promise<boolean> | null = null;

function refresh(): Promise<boolean> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  const refreshToken = storedRefresh();
  if (!refreshToken) return false;
  const res = await raw('POST', '/auth/refresh', { refreshToken }, null);
  if (!res.ok) {
    storeRefresh(null);
    return false;
  }
  const data = await res.json();
  accessToken = data.accessToken;
  storeRefresh(data.refreshToken);
  return true;
}

/**
 * `keepalive` lets a request finish even while the page is being closed, which
 * is how a close attempt is reported before the window goes away.
 */
export async function request<T>(method: string, path: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<T> {
  let res = await raw(method, path, body, accessToken, opts.keepalive);
  if (res.status === 401 && (await refresh())) res = await raw(method, path, body, accessToken, opts.keepalive);
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `Request failed (${res.status})`, data?.error?.details);
  return data as T;
}

/** Sends raw bytes, such as a piece of a recording, with the given content type and headers. */
export async function sendBlob(path: string, blob: Blob, headers: Record<string, string>): Promise<void> {
  const h = { 'content-type': blob.type || 'application/octet-stream', ...headers };
  let res = await raw('POST', path, blob, accessToken, false, h);
  if (res.status === 401 && (await refresh())) res = await raw('POST', path, blob, accessToken, false, h);
  if (!res.ok) {
    const data = await res.json().catch(() => undefined);
    throw new ApiError(res.status, data?.error?.message ?? `Upload failed (${res.status})`, data?.error?.details);
  }
}

/** Signs in with a password. With two factor sign in on, returns a ticket for the code step instead. */
export async function signIn(organisation: string, email: string, password: string): Promise<{ mfaToken?: string }> {
  const res = await raw('POST', '/auth/login', { organisation, email, password }, null);
  const data = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? 'Sign in failed');
  if (data.mfaRequired) return { mfaToken: data.mfaToken };
  accessToken = data.accessToken;
  storeRefresh(data.refreshToken);
  return {};
}

export async function completeMfa(mfaToken: string, code: string): Promise<void> {
  const res = await raw('POST', '/auth/mfa', { mfaToken, code }, null);
  const data = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? 'Sign in failed');
  accessToken = data.accessToken;
  storeRefresh(data.refreshToken);
}

export async function resumeSession(): Promise<boolean> {
  return refresh();
}

export async function signOut(): Promise<void> {
  const refreshToken = storedRefresh();
  accessToken = null;
  storeRefresh(null);
  if (refreshToken) await raw('POST', '/auth/logout', { refreshToken }, null).catch(() => undefined);
}

/** Server time from the Date header, used for the clock check. */
export async function serverTime(): Promise<{ time: Date; latencyMs: number }> {
  const started = performance.now();
  const res = await raw('GET', '/health', undefined, null);
  const latencyMs = Math.round(performance.now() - started);
  const header = res.headers.get('date');
  return { time: header ? new Date(header) : new Date(), latencyMs };
}
