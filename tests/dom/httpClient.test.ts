/**
 * @file httpClient.test.ts
 * @description HttpClient background fetch handling 测试
 * @module tests/dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../apps/extension/src/platform/network/httpClient';

describe('HttpClient background fetch handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects background fetch responses with HTTP error status', async () => {
    vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation((_message: any, callback?: (response: any) => void) => {
      callback?.({
        success: true,
        status: 404,
        data: '<html><title>404 Not Found</title></html>',
      });
    });
    const client = new HttpClient();

    await expect(client.get<string>('https://example.test/missing', {
      responseType: 'text',
      retries: 0,
    })).rejects.toThrow('HTTP 404');
  });

  it('uses document-only accept headers for HTML document requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body>OK</body></html>', { status: 200 }),
    );
    const client = new HttpClient(window.location.origin, {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    await client.getDocument('/sync-page', { retries: 0 });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Accept).toBe('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1');
    expect(headers?.Accept).not.toContain('image/');
  });

  it('limits same-origin text bodies to maxBodyBytes and drops the rest', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('a'.repeat(1000)));
    const client = new HttpClient(window.location.origin);

    const text = await client.get<string>('/partial', { responseType: 'text', retries: 0, maxBodyBytes: 256 });

    expect(text).toBe('a'.repeat(256));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards maxBodyBytes to the background fetch for cross-origin urls', async () => {
    const sent: any[] = [];
    vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation((_message: any, callback?: (response: any) => void) => {
      sent.push(_message);
      callback?.({ success: true, status: 200, data: 'ok' });
    });
    const client = new HttpClient();

    await client.get<string>('https://other.test/partial', { responseType: 'text', retries: 0, maxBodyBytes: 4096 });

    expect(sent[0]?.type).toBe('fetch-external-data');
    expect(sent[0]?.options.maxBodyBytes).toBe(4096);
  });

  it('omits maxBodyBytes from background fetch options when not requested', async () => {
    const sent: any[] = [];
    vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation((_message: any, callback?: (response: any) => void) => {
      sent.push(_message);
      callback?.({ success: true, status: 200, data: 'ok' });
    });
    const client = new HttpClient();

    await client.get<string>('https://other.test/full', { responseType: 'text', retries: 0 });

    expect(sent[0]?.options.maxBodyBytes).toBeUndefined();
  });

});
