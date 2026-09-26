/**
 * @vitest-environment jsdom
 * @file OverlayShell.test.tsx
 * @description OverlayShell portal 化回归：落位 document.body、Esc/backdrop 关闭、渲染序、滚动锁
 *
 * 背景：祖先 .tab-content 的 contain: layout（cycle-9 A1）会把本壳 position:fixed
 * 的包含块从视口改为 tab 盒，深滚动时关闭入口出视口、backdrop 覆盖不完整。
 * portal 到 document.body 后 fixed 恢复视口参照——本文件锁住该落位与既有交互语义。
 * @module ui/patterns/OverlayShell
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayShell } from './OverlayShell';

let container: HTMLDivElement;
let root: Root;

function mount(node: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(node);
  });
}

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  // 兜底：清掉可能残留的 portal 节点与样式
  document.querySelectorAll('.ui-overlay-shell').forEach((el) => el.remove());
  document.body.style.overflow = '';
  vi.clearAllMocks();
});

/** 状态宿主：便于在同一用例内切换 open / 双壳挂载 */
function Host({
  open,
  children,
  second,
}: {
  open: boolean;
  children?: ReactNode;
  second?: ReactNode;
}) {
  return (
    <>
      <OverlayShell open={open} title="详情" onClose={() => undefined}>
        {children}
      </OverlayShell>
      {second ? (
        <OverlayShell open={open} title="播放" onClose={() => undefined} hideHeader>
          {second}
        </OverlayShell>
      ) : null}
    </>
  );
}

function TogglerHost({
  onToggle,
  children,
}: {
  onToggle: (setOpen: (v: boolean) => void) => void;
  children: (open: boolean, setOpen: (v: boolean) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  onToggle(setOpen);
  return <>{children(open, setOpen)}</>;
}

describe('OverlayShell portal 落位', () => {
  it('open 时 shell 渲染在 document.body 而非渲染容器内（脱离 contain 祖先）', () => {
    mount(
      <div className="fake-tab-content">
        <OverlayShell open title="详情" onClose={() => undefined}>
          <div>内容</div>
        </OverlayShell>
      </div>,
    );
    expect(container.querySelector('.ui-overlay-shell')).toBeNull();
    const inBody = document.body.querySelector('.ui-overlay-shell');
    expect(inBody).not.toBeNull();
    expect(inBody?.parentElement).toBe(document.body);
  });

  it('open=false 时 body 与容器均无 shell', () => {
    mount(
      <OverlayShell open={false} title="详情" onClose={() => undefined}>
        <div>内容</div>
      </OverlayShell>,
    );
    expect(container.querySelector('.ui-overlay-shell')).toBeNull();
    expect(document.body.querySelector('.ui-overlay-shell')).toBeNull();
  });

  it('open false→true→false 切换，shell 始终落在 body', () => {
    let setOpen: (v: boolean) => void = () => undefined;
    mount(
      <TogglerHost onToggle={(fn) => (setOpen = fn)}>
        {(open) => (
          <OverlayShell open={open} title="详情" onClose={() => undefined}>
            <div>内容</div>
          </OverlayShell>
        )}
      </TogglerHost>,
    );
    expect(document.body.querySelector('.ui-overlay-shell')).toBeNull();
    act(() => setOpen(true));
    expect(document.body.querySelector('.ui-overlay-shell')).not.toBeNull();
    act(() => setOpen(false));
    expect(document.body.querySelector('.ui-overlay-shell')).toBeNull();
  });
});

describe('OverlayShell 交互语义（portal 化后保持）', () => {
  it('Esc 关闭（window 级监听不受落位影响）', () => {
    const onClose = vi.fn();
    mount(
      <OverlayShell open title="详情" onClose={onClose}>
        <div>内容</div>
      </OverlayShell>,
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('默认点 backdrop 关闭', () => {
    const onClose = vi.fn();
    mount(
      <OverlayShell open title="详情" onClose={onClose}>
        <div>内容</div>
      </OverlayShell>,
    );
    const backdrop = document.body.querySelector<HTMLButtonElement>('.ui-overlay-shell__backdrop');
    expect(backdrop).not.toBeNull();
    act(() => {
      backdrop?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closeOnBackdrop=false 时点 backdrop 不关闭（播放器语义）', () => {
    const onClose = vi.fn();
    mount(
      <OverlayShell open title="播放" onClose={onClose} closeOnBackdrop={false} hideHeader>
        <div>播放器</div>
      </OverlayShell>,
    );
    const backdrop = document.body.querySelector<HTMLButtonElement>('.ui-overlay-shell__backdrop');
    expect(backdrop).not.toBeNull();
    act(() => {
      backdrop?.click();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('同页双 shell：先挂载者在 body 中靠前（叠放顺序=组件序，播放器在详情之上）', () => {
    mount(
      <Host open second={<div>播放</div>}>
        <div>详情</div>
      </Host>,
    );
    const shells = Array.from(document.body.children).filter((el) =>
      el instanceof HTMLElement ? el.classList.contains('ui-overlay-shell') : false,
    );
    expect(shells).toHaveLength(2);
    expect(shells[0]?.querySelector('.ui-overlay-shell__title')?.textContent).toBe('详情');
    // 第二壳 hideHeader：无标题栏
    expect(shells[1]?.querySelector('.ui-overlay-shell__title')).toBeNull();
  });

  it('open 时锁 body 滚动，关闭后恢复', () => {
    let setOpen: (v: boolean) => void = () => undefined;
    mount(
      <TogglerHost onToggle={(fn) => (setOpen = fn)}>
        {(open) => (
          <OverlayShell open={open} title="详情" onClose={() => undefined}>
            <div>内容</div>
          </OverlayShell>
        )}
      </TogglerHost>,
    );
    act(() => setOpen(true));
    expect(document.body.style.overflow).toBe('hidden');
    act(() => setOpen(false));
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});
