export function sanitizePercentIntText(raw: string): string {
  const onlyDigits = String(raw ?? "").replace(/[^\d]/g, "");
  if (!onlyDigits) return "";
  const noLeadingZeros = onlyDigits.replace(/^0+(?=\d)/, "");
  const n = Number(noLeadingZeros);
  if (!Number.isFinite(n)) return "";
  const clamped = Math.max(0, Math.min(100, Math.floor(n)));
  return String(clamped);
}

export function coercePercentInt(text: string): number {
  const s = String(text ?? "").trim();
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.floor(n)));
}

