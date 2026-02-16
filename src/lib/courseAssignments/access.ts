export type AccessDurationKey = "unlimited" | "3m" | "1m" | "1w";

export const ACCESS_DURATION_KEYS: AccessDurationKey[] = ["unlimited", "3m", "1m", "1w"];

export function isAccessDurationKey(v: unknown): v is AccessDurationKey {
  return v === "unlimited" || v === "3m" || v === "1m" || v === "1w";
}

function addMonthsClampedUtc(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = date.getUTCSeconds();
  const ms = date.getUTCMilliseconds();

  const targetMonthIndex = month + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const mod = targetMonthIndex % 12;
  const targetMonth = mod < 0 ? mod + 12 : mod;

  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);

  return new Date(Date.UTC(targetYear, targetMonth, clampedDay, hour, minute, second, ms));
}

export function computeAccessExpiresAt(key: AccessDurationKey, now: Date = new Date()): string | null {
  if (key === "unlimited") return null;
  if (key === "1w") return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  if (key === "1m") return addMonthsClampedUtc(now, 1).toISOString();
  // "3m"
  return addMonthsClampedUtc(now, 3).toISOString();
}

export function accessKeyLabel(key: AccessDurationKey): string {
  if (key === "unlimited") return "Unlimited";
  if (key === "3m") return "3 months";
  if (key === "1m") return "1 month";
  return "1 week";
}

