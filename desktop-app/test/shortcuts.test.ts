import { describe, expect, it } from 'vitest';
import { blockedShortcut, type KeyInput } from '../src/shortcuts';

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  type: 'keyDown',
  key: k,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods,
});

describe('blocked shortcuts', () => {
  it.each([
    ['Alt+F4', key('F4', { alt: true })],
    ['Ctrl+W', key('w', { control: true })],
    ['Cmd+W', key('w', { meta: true })],
    ['Cmd+Q', key('q', { meta: true })],
    ['Ctrl+Q', key('q', { control: true })],
    ['Cmd+M', key('m', { meta: true })],
    ['Cmd+H', key('h', { meta: true })],
    ['F5', key('F5')],
    ['Ctrl+R', key('r', { control: true })],
    ['Cmd+R', key('r', { meta: true })],
    ['F11', key('F11')],
    ['F12', key('F12')],
    ['Ctrl+Shift+I', key('I', { control: true, shift: true })],
    ['Alt+Cmd+I', key('i', { meta: true, alt: true })],
    ['Ctrl+Shift+J', key('J', { control: true, shift: true })],
    ['Ctrl+U', key('u', { control: true })],
    ['Ctrl+P', key('p', { control: true })],
    ['Ctrl+S', key('s', { control: true })],
    ['Ctrl+N', key('n', { control: true })],
    ['Cmd+T', key('t', { meta: true })],
    ['Alt+ArrowLeft', key('ArrowLeft', { alt: true })],
    ['Ctrl+=', key('=', { control: true })],
    ['Cmd+-', key('-', { meta: true })],
    ['Ctrl+0', key('0', { control: true })],
  ])('blocks %s', (expected, input) => {
    expect(blockedShortcut(input)).toBe(expected);
  });

  it('leaves ordinary typing and the shortcuts the exam screens handle themselves', () => {
    for (const input of [
      key('a'),
      key('p'),
      key('Enter'),
      key('Tab'),
      key('ArrowDown'),
      key('Backspace'),
      key('A', { shift: true }),
      key('a', { control: true }), // select all
      key('z', { control: true }), // undo
      key('c', { control: true }), // copy, blocked and recorded by the exam screens
      key('v', { meta: true }), // paste, likewise
      key('x', { control: true }),
      key('F4'), // not Alt+F4
      key('f', { control: true }), // find
    ]) {
      expect(blockedShortcut(input), JSON.stringify(input)).toBeNull();
    }
  });

  it('only acts on key presses, not releases', () => {
    expect(blockedShortcut({ ...key('F5'), type: 'keyUp' })).toBeNull();
  });
});
