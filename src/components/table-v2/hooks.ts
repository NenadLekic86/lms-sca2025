import { useEffect, useState } from "react";

export function useEscClose(enabled: boolean, onClose: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onClose]);
}

export function useMountedForAnimation(open: boolean, durationMs: number) {
  // `keepMounted` is only used to keep the component mounted briefly after close,
  // so we can play the close animation.
  const [keepMounted, setKeepMounted] = useState(false);

  useEffect(() => {
    if (open) {
      if (keepMounted) return;
      // Avoid sync setState in effect body (lint rule).
      const t = window.setTimeout(() => setKeepMounted(true), 0);
      return () => window.clearTimeout(t);
    }
    if (!keepMounted) return;
    const t = window.setTimeout(() => setKeepMounted(false), durationMs);
    return () => window.clearTimeout(t);
  }, [durationMs, keepMounted, open]);

  return open || keepMounted;
}

export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}

export function useOutsideClickClose(options: {
  enabled: boolean;
  onOutside: () => void;
  isInside: (target: EventTarget | null) => boolean;
}) {
  const { enabled, isInside, onOutside } = options;

  useEffect(() => {
    if (!enabled) return;

    const onMouseDown = (e: MouseEvent) => {
      if (isInside(e.target)) return;
      onOutside();
    };

    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [enabled, isInside, onOutside]);
}

