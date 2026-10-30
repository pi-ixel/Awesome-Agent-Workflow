import { useEffect, useState } from "react";

export const CONNECTION_INTRO_MS = 2_000;

/** Loading owns presentation, regardless of cached or replayed message count. */
export function useConnectionIntro(loading: boolean, scope: unknown) {
  const [phase, setPhase] = useState(() => ({
    scope,
    loading,
    run: loading ? {} : null,
  }));
  const [completed, setCompleted] = useState<object | null>(null);
  if (scope !== phase.scope || loading !== phase.loading) {
    setPhase({
      scope,
      loading,
      run: loading ? {} : scope === phase.scope ? phase.run : null,
    });
  }
  useEffect(() => {
    if (phase.run === null) return;
    const timer = window.setTimeout(
      () => setCompleted(phase.run),
      CONNECTION_INTRO_MS,
    );
    return () => window.clearTimeout(timer);
  }, [phase.run]);
  return (
    loading ||
    (phase.scope === scope && phase.run !== null && completed !== phase.run)
  );
}
