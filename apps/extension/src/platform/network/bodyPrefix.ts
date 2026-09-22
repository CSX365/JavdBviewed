/**
 * @file bodyPrefix.ts
 * @description 轻量正文前缀读取 —— 探测类请求只下载响应正文前 N 字节，读满即取消剩余流
 * @module platform/network
 */

/**
 * 从响应正文流中最多读取 maxBytes 字节并解码为 UTF-8 文本。
 *
 * 读满上限后立即取消（cancel）剩余流，让服务端尽早停止传输；
 * 流自然结束时做 decoder 收尾，截断时不收尾，避免半个多字节字符变成替换字符噪音。
 * 响应没有 body 流或 maxBytes 非法时退化为完整 text()，保持原行为。
 */
export async function readBodyPrefix(response: Response, maxBytes: number): Promise<string> {
  const limit = Math.floor(maxBytes);
  if (!Number.isFinite(limit) || limit <= 0 || !response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  let ended = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;

      const take = Math.min(value.byteLength, limit - total);
      const chunk = take === value.byteLength ? value : value.slice(0, take);
      parts.push(decoder.decode(chunk, { stream: true }));
      total += take;
      if (total >= limit) break;
    }
  } finally {
    if (!ended) {
      try {
        await reader.cancel();
      } catch {
        // 流可能已关闭，忽略
      }
    }
  }

  if (ended) {
    parts.push(decoder.decode());
  }
  return parts.join('');
}
