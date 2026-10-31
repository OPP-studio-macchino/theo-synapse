const patterns = [
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[^\s"'<>]+/gi,
  /\b(?:sk-(?:proj-)?|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"',;}]+["']?/gi,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/gi
];
export function safeOutput(input, maxBytes=4096) {
  if (typeof input !== 'string') throw Error('INVALID_OUTPUT');
  if (!Number.isInteger(maxBytes) || maxBytes < 64 || maxBytes > 16384) throw Error('INVALID_LIMIT');
  let text = input;
  for (const pattern of patterns) text = text.replace(pattern, '[REDACTED]');
  const redacted = text !== input;
  const bytes = Buffer.from(text);
  const truncated = bytes.length > maxBytes;
  if (truncated) {
    let end = maxBytes;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    text = bytes.subarray(0, end).toString('utf8');
  }
  return {text, redacted, truncated};
}
