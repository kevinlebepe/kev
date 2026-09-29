import { describe, expect, it } from 'vitest';
import { isAllowedNavigation, isAllowedPermission } from '../src/navigation';

const ORIGIN = 'https://exams.university.example';

describe('navigation', () => {
  it('allows pages of the exam site and nothing else', () => {
    expect(isAllowedNavigation('https://exams.university.example/', ORIGIN)).toBe(true);
    expect(isAllowedNavigation('https://exams.university.example/a/b?c=d#e', ORIGIN)).toBe(true);
    for (const url of [
      'https://www.google.com/',
      'https://exams.university.example.evil.example/',
      'https://evil.example/exams.university.example',
      'http://exams.university.example/', // different scheme
      'https://exams.university.example:8443/', // different port
      'https://sub.exams.university.example/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>hi</h1>',
      'about:blank',
      'not a url',
      '',
    ]) {
      expect(isAllowedNavigation(url, ORIGIN), url).toBe(false);
    }
  });

  it('works with a local development address', () => {
    expect(isAllowedNavigation('http://localhost:5173/x', 'http://localhost:5173')).toBe(true);
    expect(isAllowedNavigation('http://localhost:3000/x', 'http://localhost:5173')).toBe(false);
  });
});

describe('permissions', () => {
  it('grants only camera, microphone and full screen, and only to the exam site', () => {
    expect(isAllowedPermission('media', 'https://exams.university.example/exam', ORIGIN)).toBe(true);
    expect(isAllowedPermission('fullscreen', 'https://exams.university.example/exam', ORIGIN)).toBe(true);
    expect(isAllowedPermission('media', 'https://evil.example/', ORIGIN)).toBe(false);
    for (const p of ['geolocation', 'notifications', 'clipboard-read', 'midi', 'openExternal', 'pointerLock', 'display-capture']) {
      expect(isAllowedPermission(p, 'https://exams.university.example/', ORIGIN), p).toBe(false);
    }
  });
});
