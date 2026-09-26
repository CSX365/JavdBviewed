/**
 * @file types.ts
 * @description 网络层公共类型定义
 * @module platform/network
 */

/** fetch 请求选项 */
export interface FetchOptions {
  timeout?: number;                                   // 超时时间（毫秒），默认 10000
  retries?: number;                                   // 最大重试次数，默认 3
  headers?: Record<string, string>;
  referrer?: string;
  proxy?: boolean;                                    // 是否通过 background 代理请求（规避 CORS）
  responseType?: 'text' | 'json' | 'blob' | 'document';
  maxBodyBytes?: number;                            // 只读取正文前 N 字节（轻量探测），仅对 text/document 生效
  firstByteTimeoutMs?: number;                      // 首字节快速失败（S1 B2 cycle-14）：N ms 内拿不到响应头即 abort，
                                                    // 仅 background 代理路径（fetch-external-data）生效，供轻量探测快速判败
}

/** 网络请求错误，携带 URL 和状态码信息 */
export class NetworkError extends Error {
  constructor(
    message: string,
    public url: string,
    public statusCode?: number,
    /** S1 B2 (cycle-14)：background 侧该 host 剩余冷却（ms），供重试延迟对齐冷却、免提前入队空转 */
    public cooldownMs?: number,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}
