export interface CreateRecordsDropdownBackdropControllerOptions {
  dropdowns: Array<HTMLElement | null | undefined>;
  closeDropdowns: () => void;
  hostSelector?: string;
  toolbarSelector?: string;
}

export interface RecordsDropdownBackdropController {
  sync: () => void;
  getBackdrop: () => HTMLDivElement | null;
}

function isDropdownOpen(dropdown: HTMLElement | null | undefined): boolean {
  try {
    if (!dropdown) return false;
    // 性能修复：下拉框开合状态全程由内联 style 读写（HTML 初始 style="display:none;"，
    // 所有开/合点只写 style.display），因此直接读内联 display 与 computed 结果等价，
    // 且不会触发强制样式重算。records 页 CSS 规则约 2 万条，getComputedStyle 会强制
    // 全量重算（实测 20-80ms），而本函数经由 document 级 click 监听在 dashboard 每次
    // 点击时都会被调用，是 S0 真机检测坐实的 CPU 热点。
    const inlineDisplay = dropdown.style.display;
    if (inlineDisplay !== '') return inlineDisplay !== 'none';
    // 内联被外部清空（理论边界）时回退 computed，保持行为一致
    return window.getComputedStyle(dropdown).display !== 'none';
  } catch {
    return false;
  }
}

export function createRecordsDropdownBackdropController(
  options: CreateRecordsDropdownBackdropControllerOptions,
): RecordsDropdownBackdropController {
  const hostSelector = options.hostSelector || '#tab-records .card';
  const toolbarSelector = options.toolbarSelector || '#tab-records .records-toolbar';
  let backdrop: HTMLDivElement | null = null;

  const position = () => {
    try {
      if (!backdrop) return;
      const card = backdrop.parentElement as HTMLElement | null;
      const toolbar = document.querySelector(toolbarSelector) as HTMLElement | null;
      if (!card || !toolbar) {
        backdrop.style.top = '0px';
        return;
      }

      const cardRect = card.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const top = Math.max(0, toolbarRect.bottom - cardRect.top);
      backdrop.style.top = `${top}px`;
    } catch {
      if (backdrop) backdrop.style.top = '0px';
    }
  };

  const ensureBackdrop = () => {
    if (backdrop) return backdrop;

    const element = document.createElement('div');
    element.className = 'dropdown-backdrop';
    element.addEventListener('click', () => {
      options.closeDropdowns();
      sync();
    });

    const host = (document.querySelector(hostSelector) as HTMLElement | null) || document.body;
    host.appendChild(element);
    backdrop = element;
    return element;
  };

  const sync = () => {
    const anyOpen = options.dropdowns.some(isDropdownOpen);
    if (anyOpen) {
      const element = ensureBackdrop();
      position();
      element.style.display = 'block';
      return;
    }

    if (backdrop) backdrop.style.display = 'none';
  };

  return {
    sync,
    getBackdrop: () => backdrop,
  };
}
