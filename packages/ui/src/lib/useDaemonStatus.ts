/**
 * useDaemonStatus — a small liveness poll of the daemon `/api/health` endpoint
 * driving the NavRail footer. A successful poll ⇒ `ok` (with the reported
 * name/version); any failure ⇒ `unreachable`. The address is derived from
 * `window.location.host` (the daemon serves this UI same-origin at `/ui`).
 *
 * Additive and non-behavioural: no existing flow depends on it. Guarded for the
 * component tests that render without a real interval by tolerating a missing
 * `window` and cleaning up on unmount.
 */
import { useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../api/client';

export interface DaemonStatus {
  status: 'probing' | 'ok' | 'unreachable';
  name?: string;
  version?: string;
  address: string;
}

const POLL_INTERVAL_MS = 5000;

function currentAddress(): string {
  if (typeof window === 'undefined' || !window.location) return 'localhost';
  return window.location.host || 'localhost';
}

export function useDaemonStatus(client: ApiClient): DaemonStatus {
  const [status, setStatus] = useState<DaemonStatus>({
    status: 'probing',
    address: currentAddress(),
  });
  // Guard against setState after unmount across the async poll loop.
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      const address = currentAddress();
      try {
        const health = await client.getHealth();
        if (!aliveRef.current) return;
        setStatus({ status: 'ok', name: health.name, version: health.version, address });
      } catch {
        if (!aliveRef.current) return;
        setStatus({ status: 'unreachable', address });
      }
      if (aliveRef.current) {
        timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      }
    }

    void tick();

    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [client]);

  return status;
}
