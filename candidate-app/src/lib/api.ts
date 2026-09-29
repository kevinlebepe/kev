// Thin client for the ExamGuard API. Access tokens live in memory only; the
// refresh token is kept for the session so a reload does not force a new login.

const BASE = import.meta.env.VITE_API_BASE ?? '/api';
const REFRESH_KEY = 'examguard.refresh';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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

async function raw(method: string, path: string, body?: unknown, token = accessToken): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function refresh(): Promise<boolean> {
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

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await raw(method, path, body);
  if (res.status === 401 && (await refresh())) res = await raw(method, path, body);
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}

export async function signIn(organisation: string, email: string, password: string): Promise<void> {
  const res = await raw('POST', '/auth/login', { organisation, email, password }, null);
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
