import { useEffect, useState } from "react";
import type { HostService } from "../../host/service.ts";

export function useBrowserAgentControl(host: HostService["browser"]) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = host.isAvailable();
  useEffect(() => {
    if (!available) return;
    let active = true;
    let observed = false;
    let unsubscribe = () => {};
    void host
      .onAgentControl(({ enabled: actual }) => {
        observed = true;
        if (active) setEnabled(actual);
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      })
      .then(async () => {
        if (!active) return;
        const value = await host.agentControlEnabled();
        if (active && !observed) setEnabled(value);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [available, host]);

  return {
    available,
    enabled,
    pending,
    error,
    change: (value: boolean) => {
      setPending(true);
      void host
        .setAgentControl(value)
        .then((actual) => {
          setEnabled(actual);
          setError(null);
        })
        .catch((cause) => setError(String(cause)))
        .finally(() => setPending(false));
    },
  };
}
