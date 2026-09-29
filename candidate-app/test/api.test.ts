import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fresh module state for every test, since the client keeps tokens in module variables.
async function loadApi() {
  vi.resetModules();
  return import('../src/lib/api');
}

function fakeSessionStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('token refresh', () => {
  let refreshCalls: string[];
  let valid: string; // the only refresh token the fake server still accepts

  beforeEach(() => {
    refreshCalls = [];
    valid = 'refresh-1';
    vi.stubGlobal('sessionStorage', fakeSessionStorage({ 'examguard.refresh': 'refresh-1' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: string; headers: Record<string, string> }) => {
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
        if (url.endsWith('/auth/refresh')) {
          const token = JSON.parse(init.body!).refreshToken as string;
          refreshCalls.push(token);
          // Like the real server: a token that was already used is refused.
          if (token !== valid) return json(401, { error: { message: 'Invalid refresh token' } });
          valid = `refresh-${refreshCalls.length + 1}`;
          return json(200, { accessToken: `access-${refreshCalls.length}`, refreshToken: valid });
        }
        const authorised = init.headers.authorization === 'Bearer access-1';
        return authorised ? json(200, { ok: true }) : json(401, { error: { message: 'expired' } });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shares one refresh between requests that fail at the same moment', async () => {
    const { request } = await loadApi();
    const results = await Promise.all([request('GET', '/a'), request('GET', '/b'), request('GET', '/c')]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshCalls).toEqual(['refresh-1']); // used exactly once
  });

  it('shares one refresh when the session is resumed twice at once', async () => {
    const { resumeSession } = await loadApi();
    expect(await Promise.all([resumeSession(), resumeSession()])).toEqual([true, true]);
    expect(refreshCalls).toEqual(['refresh-1']);
  });

  it('can refresh again later, using the newly issued token', async () => {
    const { resumeSession } = await loadApi();
    await resumeSession();
    await resumeSession();
    expect(refreshCalls).toEqual(['refresh-1', 'refresh-2']);
  });

  it('tells the server whether it is the desktop application or a browser', async () => {
    const kinds: string[] = [];
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_url: string, init: { headers: Record<string, string> }) => {
      kinds.push(init.headers['x-examguard-client'] as string);
      return new Response('{}', { status: 200 });
    });
    const { request } = await loadApi();
    await request('GET', '/a');
    vi.stubGlobal('window', { examguardDesktop: {} });
    await request('GET', '/b');
    expect(kinds).toEqual(['browser', 'desktop']);
  });

  it('gives up cleanly when the refresh token is refused', async () => {
    valid = 'something-else';
    const { request, resumeSession } = await loadApi();
    await expect(request('GET', '/a')).rejects.toMatchObject({ status: 401 });
    expect(await resumeSession()).toBe(false);
    expect(refreshCalls).toEqual(['refresh-1']); // the bad token was discarded, not retried
  });
});
