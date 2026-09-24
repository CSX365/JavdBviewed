// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createRecordsDropdownBackdropController } from './dropdownBackdropController';

type FakeDropdown = HTMLElement & {
  style: { display: string };
};

function makeDropdown(display: string): FakeDropdown {
  return {
    style: { display },
  } as FakeDropdown;
}

describe('records dropdown backdrop controller', () => {
  let originalGCS: typeof window.getComputedStyle;

  beforeEach(() => {
    originalGCS = window.getComputedStyle;
  });

  afterEach(() => {
    window.getComputedStyle = originalGCS;
  });

  it('reads inline display without touching computed style when inline is set', () => {
    const spy = vi.fn(originalGCS);
    window.getComputedStyle = spy;

    const open = makeDropdown('block');
    const closed = makeDropdown('none');
    const controller = createRecordsDropdownBackdropController({
      dropdowns: [open, closed],
      closeDropdowns: vi.fn(),
      hostSelector: '#no-such-host',
    });

    controller.sync();
    expect(spy).not.toHaveBeenCalled();
    // 任一打开 → backdrop 显示（挂载到 body，宿主选择器不存在时的回退）
    const backdrop = controller.getBackdrop();
    expect(backdrop).not.toBeNull();
    expect(backdrop!.style.display).toBe('block');
    backdrop!.remove();
  });

  it('hides backdrop when all dropdowns are inline none', () => {
    const controller = createRecordsDropdownBackdropController({
      dropdowns: [makeDropdown('none'), null, undefined],
      closeDropdowns: vi.fn(),
      hostSelector: '#no-such-host',
    });

    controller.sync();
    const backdrop = controller.getBackdrop();
    // 全关且此前未创建 backdrop → 不应创建
    expect(backdrop).toBeNull();
  });

  it('falls back to computed style only when inline display is empty', () => {
    const spy = vi.fn(originalGCS).mockImplementation(() => ({ display: 'block' }) as CSSStyleDeclaration);
    window.getComputedStyle = spy;

    const emptyInline = { style: { display: '' } } as FakeDropdown;
    const controller = createRecordsDropdownBackdropController({
      dropdowns: [emptyInline],
      closeDropdowns: vi.fn(),
      hostSelector: '#no-such-host',
    });

    controller.sync();
    expect(spy).toHaveBeenCalledTimes(1);
    const backdrop = controller.getBackdrop();
    expect(backdrop).not.toBeNull();
    expect(backdrop!.style.display).toBe('block');
    backdrop!.remove();
  });

  it('treats missing dropdown entries as closed', () => {
    const spy = vi.fn(originalGCS);
    window.getComputedStyle = spy;

    const controller = createRecordsDropdownBackdropController({
      dropdowns: [null, undefined],
      closeDropdowns: vi.fn(),
      hostSelector: '#no-such-host',
    });

    controller.sync();
    expect(spy).not.toHaveBeenCalled();
    expect(controller.getBackdrop()).toBeNull();
  });
});
