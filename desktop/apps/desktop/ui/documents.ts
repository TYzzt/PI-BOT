import { call } from "./bridge.js";
import type { ArtifactRef } from "../../../packages/protocol/src/index.js";
export const DOCUMENT_ACCEPT = ".pdf,.docx,.xlsx";
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export async function uploadDocument(
  file: File,
  botId: string,
  requestId: string,
  progress: (sent: number) => void,
  signal: AbortSignal,
): Promise<ArtifactRef> {
  if (
    !/\.(pdf|docx|xlsx)$/i.test(file.name) ||
    !file.size ||
    file.size > MAX_DOCUMENT_BYTES
  )
    throw new Error("仅支持 PDF、DOCX、XLSX，每份最多 10 MiB");
  const check = () => {
    if (signal.aborted) throw new Error("上传已取消");
  };
  const retry = async <T>(operation: () => Promise<T>) => {
    try {
      return await operation();
    } catch (error) {
      check();
      return operation();
    }
  };
  check();
  const begin = await retry(() =>
    call<{ artifact?: ArtifactRef }>("documentUploadBegin", {
      botId,
      request_id: requestId,
      name: file.name,
      size: file.size,
    }),
  );
  check();
  if (begin.artifact) return begin.artifact;
  const bytes = await file.arrayBuffer();
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  for (
    let offset = 0, part = 0;
    offset < bytes.byteLength;
    offset += 256 * 1024, part++
  ) {
    check();
    const chunk = new Uint8Array(bytes.slice(offset, offset + 256 * 1024));
    let binary = "";
    for (let i = 0; i < chunk.length; i += 8192)
      binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
    await retry(() =>
      call("documentUploadChunk", { id: requestId, part, data: btoa(binary) }),
    );
    progress(Math.min(bytes.byteLength, offset + chunk.length));
  }
  check();
  const result = await retry(() =>
    call<{ artifact: ArtifactRef }>("documentUploadComplete", {
      id: requestId,
      sha256: hash,
    }),
  );
  check();
  return result.artifact;
}
