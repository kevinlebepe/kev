import { describe, expect, it } from 'vitest';
import { findLaunchLink, launchTarget, parseLaunchLink } from '../src/launch';

const ID = '3f0a7d2e-9b41-4c55-8a6e-1d2c3b4a5f60';

describe('launch links', () => {
  it('accepts a link that names an exam', () => {
    expect(parseLaunchLink(`examguard://open?exam=${ID}`)).toEqual({ exam: ID });
    expect(parseLaunchLink(`examguard://open?exam=${ID.toUpperCase()}`)).toEqual({ exam: ID });
  });

  it('refuses anything else', () => {
    for (const raw of [
      '',
      'not a link',
      `https://open/?exam=${ID}`,
      `examguard://evil?exam=${ID}`,
      `examguard://open`,
      `examguard://open?exam=`,
      `examguard://open?exam=1`,
      `examguard://open?exam=${ID}x`,
      `examguard://open?exam=../../etc/passwd`,
      `javascript:alert(1)`,
      `file:///etc/passwd`,
    ]) {
      expect(parseLaunchLink(raw), raw).toBeNull();
    }
  });

  it('takes nothing but the exam from a link, whatever else is in it', () => {
    const link = parseLaunchLink(`examguard://open?exam=${ID}&url=https://evil.example&token=abc`);
    expect(link).toEqual({ exam: ID });
    expect(launchTarget('https://exams.university.example', link)).toBe(`https://exams.university.example/?exam=${ID}`);
  });

  it('always shows the application’s own address', () => {
    expect(launchTarget('http://localhost:5173', { exam: ID })).toBe(`http://localhost:5173/?exam=${ID}`);
    expect(launchTarget('http://localhost:5173', null)).toBe('http://localhost:5173');
    expect(new URL(launchTarget('https://exams.university.example/portal', { exam: ID })).origin).toBe('https://exams.university.example');
  });

  it('finds the link in the command line Windows and Linux start the application with', () => {
    expect(findLaunchLink(['C:\\Program Files\\ExamGuard\\ExamGuard.exe', `examguard://open?exam=${ID}`])).toBe(`examguard://open?exam=${ID}`);
    expect(findLaunchLink(['/usr/bin/examguard', '--flag'])).toBeNull();
    expect(findLaunchLink([])).toBeNull();
  });
});
