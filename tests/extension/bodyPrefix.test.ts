/**
 * @file bodyPrefix.test.ts
 * @description 轻量正文前缀读取（readBodyPrefix）测试
 * @module tests/extension
 */
import { describe, expect, it } from 'vitest';
import { readBodyPrefix } from '../../apps/extension/src/platform/network/bodyPrefix';

function chunkedStream(
  chunks: string[],
  hooks: { onRead?: () => void; onCancel?: () => void } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks.onRead?.();
      const next = chunks.shift();
      if (next === undefined) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(next));
      }
    },
    cancel() {
      hooks.onCancel?.();
    },
  });
}

describe('readBodyPrefix', () => {
  it('reads only up to maxBytes and cancels the remaining stream', async () => {
    let reads = 0;
    let cancelled = false;
    const body = chunkedStream(['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)], {
      onRead: () => { reads += 1; },
      onCancel: () => { cancelled = true; },
    });
    const response = new Response(body);

    const text = await readBodyPrefix(response, 150);

    expect(text).toBe(`${'a'.repeat(100)}${'b'.repeat(50)}`);
    expect(reads).toBe(2);
    expect(cancelled).toBe(true);
  });

  it('returns the whole short body when it ends before maxBytes', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('short body'));
        controller.close();
      },
    });

    expect(await readBodyPrefix(new Response(body), 100)).toBe('short body');
  });

  it('falls back to full text when the response carries no body stream', async () => {
    expect(await readBodyPrefix(new Response(null), 10)).toBe('');
  });

  it('falls back to full text when maxBytes is not a positive number', async () => {
    expect(await readBodyPrefix(new Response('hello world'), 0)).toBe('hello world');
    expect(await readBodyPrefix(new Response('hello world'), Number.NaN)).toBe('hello world');
    expect(await readBodyPrefix(new Response('hello world'), -5)).toBe('hello world');
  });

  it('counts bytes (not characters) for multi-byte text and drops the dangling partial character', async () => {
    const encoder = new TextEncoder();
    const source = '好'.repeat(50); // 150 bytes
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(source));
        controller.close();
      },
    });

    const text = await readBodyPrefix(new Response(body), 100);

    expect(text).toBe('好'.repeat(33));
    expect(text.length).toBe(33);
  });
});
