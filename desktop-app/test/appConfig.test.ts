import { describe, expect, it } from 'vitest';
import { bundledAppUrl, DEFAULT_APP_URL, resolveAppUrl } from '../src/appConfig';

describe('exam address', () => {
  it('lets a developer override it only when running from source', () => {
    const env = { EXAMGUARD_URL: 'http://localhost:9999' };
    expect(resolveAppUrl({ packaged: false, env, bundled: 'https://exams.example.ac.za' })).toBe('http://localhost:9999');
    expect(resolveAppUrl({ packaged: true, env, bundled: 'https://exams.example.ac.za' })).toBe('https://exams.example.ac.za');
  });

  it('falls back to the development address', () => {
    expect(resolveAppUrl({ packaged: false, env: {}, bundled: null })).toBe(DEFAULT_APP_URL);
  });

  it('refuses plain HTTP to a real server in an installed build', () => {
    expect(() => resolveAppUrl({ packaged: true, env: {}, bundled: 'http://exams.example.ac.za' })).toThrow(/HTTPS/);
    expect(() => resolveAppUrl({ packaged: false, env: { EXAMGUARD_URL: 'file:///etc/passwd' }, bundled: null })).toThrow(/Unsupported/);
  });

  it('reads the address written into the build', () => {
    expect(bundledAppUrl(() => '{"appUrl":"https://a.example"}')).toBe('https://a.example');
    expect(bundledAppUrl(() => 'not json')).toBeNull();
    expect(
      bundledAppUrl(() => {
        throw new Error('missing');
      }),
    ).toBeNull();
  });
});
