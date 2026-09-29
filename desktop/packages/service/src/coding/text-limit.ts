export const HEAD_BYTES = 2 * 1024 * 1024;
export const TAIL_BYTES = 32 * 1024;

export function utf8Head(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

export function utf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

/** Keep a UTF-16 tail without splitting a surrogate pair. */
export function charTail(text: string, chars: number): string {
  let start = Math.max(0, text.length - chars);
  const code = text.charCodeAt(start);
  if (start > 0 && code >= 0xdc00 && code <= 0xdfff) start++;
  return text.slice(start);
}

export class OutputBuffer {
  private full: string | null = '';
  private head = '';
  private tail = '';
  private totalChars = 0;
  constructor(private headBytes = HEAD_BYTES, private tailBytes = TAIL_BYTES) {}
  push(chunk: string) {
    if (!chunk) return;
    this.totalChars += chunk.length;
    if (this.full !== null) {
      this.full += chunk;
      if (Buffer.byteLength(this.full) > this.headBytes + this.tailBytes) {
        this.head = utf8Head(this.full, this.headBytes);
        this.tail = utf8Tail(this.full, this.tailBytes);
        this.full = null;
      }
      return;
    }
    this.tail = utf8Tail(this.tail + chunk, this.tailBytes);
  }
  snapshot(): { body: string; head: string; tail: string; omittedChars: number } {
    if (this.full !== null) return { body: this.full, head: this.full, tail: this.full, omittedChars: 0 };
    const omittedChars = Math.max(0, this.totalChars - this.head.length - this.tail.length);
    const marker = `\n[已省略 ${omittedChars} 个字符]\n`;
    return { body: this.head + marker + this.tail, head: this.head, tail: this.tail, omittedChars };
  }
}
