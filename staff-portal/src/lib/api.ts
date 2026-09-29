// Client for the ExamGuard API. The access token lives in memory only; the
// refresh token is kept for the browser session so a reload does not sign out.

const BASE = import.meta.env.VITE_API_BASE ?? '/api';
const REFRESH_KEY = 'examguard.staff.refresh';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
    // Storage unavailable: sign in again after a reload.
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

// Refresh tokens rotate on every use and a reused one ends the session, so
// requests that find the access token expired together share one refresh.
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

async function authed(method: string, path: string, body?: unknown): Promise<Response> {
  let res = await raw(method, path, body);
  if (res.status === 401 && (await refresh())) res = await raw(method, path, body);
  return res;
}

/** Turns the server's validation details into one readable line. */
export function describeDetails(details: unknown): string {
  if (Array.isArray(details)) return details.map(String).join('; ');
  const messages: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { errors?: string[]; properties?: Record<string, unknown>; items?: unknown[] };
    for (const e of n.errors ?? []) messages.push(path ? `${path}: ${e}` : e);
    for (const [k, v] of Object.entries(n.properties ?? {})) walk(v, path ? `${path}.${k}` : k);
    (n.items ?? []).forEach((v, i) => walk(v, `${path}[${i}]`));
  };
  walk(details, '');
  return messages.join('; ');
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await authed(method, path, body);
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    const detail = describeDetails(data?.error?.details);
    const message = data?.error?.message ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, detail ? `${message}: ${detail}` : message, data?.error?.details);
  }
  return data as T;
}

/** Fetches a file, such as a recording, as a Blob. Null when there is none (404). */
export async function fetchBlob(path: string): Promise<Blob | null> {
  const res = await authed('GET', path);
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(res.status, `Could not load (${res.status})`);
  return res.blob();
}

/** Downloads a file from the API with the signed in user's credentials. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await authed('GET', path);
  if (!res.ok) throw new ApiError(res.status, `Download failed (${res.status})`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

export const resumeSession = () => refresh();

export async function signOut(): Promise<void> {
  const refreshToken = storedRefresh();
  accessToken = null;
  storeRefresh(null);
  if (refreshToken) await raw('POST', '/auth/logout', { refreshToken }, null).catch(() => undefined);
}
