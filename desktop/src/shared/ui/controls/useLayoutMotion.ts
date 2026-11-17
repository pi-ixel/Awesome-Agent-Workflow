import { useEffect, useState } from "react";

const LAYOUT_MOTION_MS = 200;

/** Animate state changes after mount, while leaving direct size changes alone. */
export function useLayoutMotion(
  key: string | boolean,
  { enabled = true, duration = LAYOUT_MOTION_MS, scope }: {
    enabled?: boolean;
    duration?: number;
    scope?: string | null;
  } = {},
) {
  const [motion, setMotion] = useState({ key, scope, active: false });
  if (motion.key !== key || motion.scope !== scope) {
    const active = motion.scope === scope && enabled &&
      window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches === true;
    setMotion({ key, scope, active });
  }
  useEffect(() => {
    if (!motion.active) return;
    const timer = window.setTimeout(() => {
      setMotion((current) => current === motion ? { ...current, active: false } : current);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [duration, motion]);
  return enabled && motion.active;
}
