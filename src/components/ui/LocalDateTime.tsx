"use client";

import { useMemo } from "react";

export function formatLocalDateTime(iso?: string | null, fallback = "—"): string {
  if (!iso || typeof iso !== "string") return fallback;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString();
}

export default function LocalDateTime({
  iso,
  fallback = "—",
  className,
}: {
  iso?: string | null;
  fallback?: string;
  className?: string;
}) {
  const text = useMemo(() => formatLocalDateTime(iso, fallback), [iso, fallback]);

  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}
