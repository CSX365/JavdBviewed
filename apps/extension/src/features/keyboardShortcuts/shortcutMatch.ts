/**
 * @file shortcutMatch.ts
 * @description 快捷键匹配纯函数（与 DOM 解耦，便于单测）
 * @module features/keyboardShortcuts
 */

const MODIFIER_KEY_NAMES = new Set(['Ctrl', 'Shift', 'Alt', 'Meta', 'Control']);

export interface ShortcutKeyEvent {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/**
 * 判断一次 keydown 事件是否命中某组快捷键定义。
 * 语义：修饰键集合精确匹配 + 主键单键（大小写不敏感，Ctrl+Shift 下主键为小写定义）。
 * 特例：单键 "?" 由 Shift+/ 产生，其隐式 Shift 不计入修饰键比较。
 */
export function isShortcutMatch(keys: string[], event: ShortcutKeyEvent): boolean {
  if (MODIFIER_KEY_NAMES.has(event.key)) {
    return false;
  }

  const shortcutModifiers = new Set<string>();
  const plainKeys: string[] = [];
  for (const k of keys) {
    if (k === 'Ctrl' || k === 'Shift' || k === 'Alt' || k === 'Meta') {
      shortcutModifiers.add(k);
    } else {
      plainKeys.push(k);
    }
  }
  if (plainKeys.length !== 1 || plainKeys[0].toLowerCase() !== event.key.toLowerCase()) {
    return false;
  }

  const eventModifiers = new Set<string>();
  if (event.ctrlKey) eventModifiers.add('Ctrl');
  if (event.shiftKey) eventModifiers.add('Shift');
  if (event.altKey) eventModifiers.add('Alt');
  if (event.metaKey) eventModifiers.add('Meta');
  if (event.key === '?') {
    eventModifiers.delete('Shift');
  }
  if (eventModifiers.size !== shortcutModifiers.size) {
    return false;
  }
  for (const m of eventModifiers) {
    if (!shortcutModifiers.has(m)) return false;
  }
  return true;
}
