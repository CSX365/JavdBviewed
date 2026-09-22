/**
 * 统一本地与 WebDAV 备份包格式：ZIP 内包含 backup.json。
 */
// jszip 是 CJS 模块（export =），模块导出类型直接就是构造函数。
// 注意：曾用「用时动态 import」把 jszip(~95KB) 挪出 dashboard 入口静态闭包（L-5），
// 但 SW（Manifest V3）被引擎级禁止运行时 import()，而 WebDAV 自动上传走 SW 路径
// （scheduler → controller → uploadService → createBackupArchive），动态 import 在
// SW 内必死（import() is disallowed）。改回静态导入，代价是入口加载图多一个 jszip chunk。
import JSZip from 'jszip';

type JSZipCtor = typeof JSZip;

function loadJSZip(): Promise<JSZipCtor> {
  return Promise.resolve(JSZip);
}

export const BACKUP_JSON_FILENAME = 'backup.json';

export async function createBackupArchive(data: unknown): Promise<Blob> {
  const zip = new (await loadJSZip())();
  zip.file(BACKUP_JSON_FILENAME, JSON.stringify(data, null, 2));
  const bytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: 'application/zip' });
}

export async function extractBackupJson(input: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  let zip: InstanceType<JSZipCtor>;
  try {
    const source = input instanceof Blob ? await input.arrayBuffer() : input;
    zip = await (await loadJSZip()).loadAsync(source);
  } catch {
    throw new Error('备份 ZIP 无法读取');
  }

  const exactFile = zip.file(BACKUP_JSON_FILENAME);
  const fallbackFile = exactFile || zip.file(/(^|\/)backup\.json$/i)[0];
  if (!fallbackFile) {
    throw new Error('ZIP 中未找到 backup.json');
  }

  try {
    return await fallbackFile.async('string');
  } catch {
    throw new Error('备份 ZIP 中的 backup.json 无法读取');
  }
}

export async function readBackupFileContent(
  fileName: string,
  input: string | Blob | ArrayBuffer | Uint8Array,
): Promise<string> {
  const normalizedName = String(fileName || '').toLowerCase();
  if (normalizedName.endsWith('.zip')) {
    if (typeof input === 'string') {
      throw new Error('备份 ZIP 无法读取');
    }
    return extractBackupJson(input);
  }

  if (normalizedName.endsWith('.json')) {
    if (typeof input === 'string') return input;
    const source = input instanceof Blob ? await input.arrayBuffer() : input;
    return new TextDecoder().decode(source);
  }

  throw new Error('仅支持 ZIP 或 JSON 备份文件');
}
