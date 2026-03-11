const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generateSupportId(prefix = "SR"): string {
  const bytes = new Uint8Array(6);
  try {
    globalThis.crypto?.getRandomValues?.(bytes);
  } catch {
    // ignore (fallback below)
  }

  let token = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? Math.floor(Math.random() * 256);
    token += ALPHABET[b % ALPHABET.length];
  }
  return `${prefix}-${token}`;
}

