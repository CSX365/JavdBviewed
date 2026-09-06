import { describe, expect, it } from 'vitest';

import { isShortcutMatch } from './shortcutMatch';

describe('isShortcutMatch', () => {
  it('matches single plain keys', () => {
    expect(isShortcutMatch(['/'], { key: '/' })).toBe(true);
    expect(isShortcutMatch(['Home'], { key: 'Home' })).toBe(true);
    expect(isShortcutMatch(['End'], { key: 'End' })).toBe(true);
    expect(isShortcutMatch(['F5'], { key: 'F5' })).toBe(true);
    expect(isShortcutMatch(['F11'], { key: 'F11' })).toBe(true);
    expect(isShortcutMatch(['ArrowRight'], { key: 'ArrowRight' })).toBe(true);
    expect(isShortcutMatch(['ArrowLeft'], { key: 'ArrowLeft' })).toBe(true);
    expect(isShortcutMatch(['/'], { key: 'a' })).toBe(false);
  });

  it('treats the implicit shift of "?" as not part of the modifier set', () => {
    // Shift+/ 产生 e.key === "?"
    expect(isShortcutMatch(['?'], { key: '?', shiftKey: true })).toBe(true);
    expect(isShortcutMatch(['?'], { key: '/' })).toBe(false);
  });

  it('matches alt combinations', () => {
    expect(isShortcutMatch(['Alt', 'h'], { key: 'h', altKey: true })).toBe(true);
    expect(isShortcutMatch(['Alt', 's'], { key: 's', altKey: true })).toBe(true);
    expect(isShortcutMatch(['Alt', 'v'], { key: 'v', altKey: true })).toBe(true);
    expect(isShortcutMatch(['Alt', 'r'], { key: 'r', altKey: true })).toBe(true);
    // 缺修饰键不匹配
    expect(isShortcutMatch(['Alt', 'h'], { key: 'h' })).toBe(false);
    // 多一个修饰键不匹配
    expect(isShortcutMatch(['Alt', 'h'], { key: 'h', altKey: true, ctrlKey: true })).toBe(false);
    expect(isShortcutMatch(['Alt', 'Shift', 'r'], { key: 'r', altKey: true, shiftKey: true })).toBe(true);
  });

  it('matches ctrl+shift combinations with lowercase definitions (event key is uppercase)', () => {
    // Ctrl+Shift+V 实机 e.key 为 'V'
    expect(isShortcutMatch(['Ctrl', 'Shift', 'v'], { key: 'V', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isShortcutMatch(['Ctrl', 'Shift', 't'], { key: 'T', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isShortcutMatch(['Ctrl', 'Shift', 'u'], { key: 'U', ctrlKey: true, shiftKey: true })).toBe(true);
    // 缺 Shift 不匹配
    expect(isShortcutMatch(['Ctrl', 'Shift', 'v'], { key: 'v', ctrlKey: true })).toBe(false);
    // 仅 Ctrl 组合不撞车
    expect(isShortcutMatch(['Ctrl', 'v'], { key: 'v', ctrlKey: true })).toBe(true);
    expect(isShortcutMatch(['Ctrl', 'Shift', 'v'], { key: 'v', ctrlKey: true })).toBe(false);
  });

  it('never matches on modifier-only presses or malformed definitions', () => {
    expect(isShortcutMatch(['Alt'], { key: 'Alt' })).toBe(false);
    expect(isShortcutMatch(['Shift'], { key: 'Shift', shiftKey: true })).toBe(false);
    expect(isShortcutMatch([], { key: 'a' })).toBe(false);
    expect(isShortcutMatch(['Ctrl', 'Shift'], { key: 'v', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isShortcutMatch(['Ctrl', 'Shift', 'v', 'x'], { key: 'V', ctrlKey: true, shiftKey: true })).toBe(false);
  });
});
