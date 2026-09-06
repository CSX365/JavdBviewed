import { prepareInsightsPreviewHtml } from './reportPreviewModel';

interface WritePreviewOptions {
  canSave?: boolean;
  ensureActions?: boolean;
  updateGrid?: boolean;
}

interface CreateInsightsPreviewRuntimeOptions {
  documentRef?: Document;
  setCurrentPreviewRawHtml: (html: string) => void;
  getCurrentPreviewRawHtml: () => string;
  setCanSaveReport?: (value: boolean) => void;
  preparePreviewHtml?: (html: string) => string;
  adjustIframeHeight: (iframe: HTMLIFrameElement) => void;
  ensurePreviewCopyButton?: () => unknown;
}

export function createInsightsPreviewRuntime(options: CreateInsightsPreviewRuntimeOptions) {
  const documentRef = options.documentRef || document;
  const preparePreviewHtml = options.preparePreviewHtml || prepareInsightsPreviewHtml;
  // iframe 当前 srcdoc 是否由「当前 raw」生成：温恢复时跳过 srcdoc 重写
  // （重写=iframe 重解析整份月报，S1 归因 §9.2 两个 ~500ms 长任务的来源）
  let previewInIframeValid = false;

  function getPreviewIframe(): HTMLIFrameElement | null {
    return documentRef.getElementById('insights-preview') as HTMLIFrameElement | null;
  }

  function applyGridLayout(): void {
    try {
      const grid = documentRef.querySelector('.tab-section[data-tab-id="insights"] .insights-grid') as HTMLElement | null;
      if (grid) grid.style.gridTemplateColumns = '0.9fr 1.5fr';
    } catch {}
  }

  function writePreparedHtml(iframe: HTMLIFrameElement, html: string): void {
    iframe.srcdoc = preparePreviewHtml(html);
    options.adjustIframeHeight(iframe);
    previewInIframeValid = true;
  }

  function writePreview(rawHtml: string, writeOptions: WritePreviewOptions = {}): boolean {
    const iframe = getPreviewIframe();
    if (!iframe) return false;

    options.setCurrentPreviewRawHtml(rawHtml);
    writePreparedHtml(iframe, rawHtml);

    if (typeof writeOptions.canSave === 'boolean') {
      options.setCanSaveReport?.(writeOptions.canSave);
    }
    if (writeOptions.ensureActions !== false) {
      try { options.ensurePreviewCopyButton?.(); } catch {}
    }
    if (writeOptions.updateGrid !== false) {
      applyGridLayout();
    }

    return true;
  }

  function refreshPreviewFromRaw(request: { force?: boolean } = {}): boolean {
    const iframe = getPreviewIframe();
    const rawHtml = options.getCurrentPreviewRawHtml();
    if (!iframe || !rawHtml) return false;

    // 非强制刷新且 iframe 仍持当前预览时跳过重写（tab 温恢复路径）；
    // 主题切换等显式场景传 force=true 保持原「重烘焙」行为。
    if (!request.force && previewInIframeValid) return true;

    writePreparedHtml(iframe, rawHtml);
    return true;
  }

  function markIframeCleared(): void {
    previewInIframeValid = false;
  }

  return {
    writePreview,
    refreshPreviewFromRaw,
    markIframeCleared,
  };
}
