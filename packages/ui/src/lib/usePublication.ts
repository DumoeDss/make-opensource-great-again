import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../api/client';
import type {
  PublicationErrorBody,
  PublicationStatus,
} from '../api/types';

export type PublicationLoadState = 'loading' | 'loaded' | 'error';
export type PublicationMutation = 'configure' | 'clear' | null;

export interface PublicationState {
  status: PublicationStatus | null;
  loadState: PublicationLoadState;
  error: PublicationErrorBody | null;
  pendingMutation: PublicationMutation;
  refresh(): Promise<PublicationStatus | null>;
  configure(repository: string): Promise<PublicationStatus | null>;
  clear(): Promise<PublicationStatus | null>;
}

/** The daemon status is the only publication-readiness authority. */
export function usePublication(client: ApiClient): PublicationState {
  const [status, setStatus] = useState<PublicationStatus | null>(null);
  const [loadState, setLoadState] = useState<PublicationLoadState>('loading');
  const [error, setError] = useState<PublicationErrorBody | null>(null);
  const [pendingMutation, setPendingMutation] = useState<PublicationMutation>(null);
  const latestRequest = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      latestRequest.current += 1;
    };
  }, []);

  const refresh = useCallback(async (): Promise<PublicationStatus | null> => {
    const request = ++latestRequest.current;
    setLoadState('loading');
    setError(null);
    setPendingMutation(null);
    const result = await client.inspectPublication();
    if (!mounted.current || request !== latestRequest.current) return null;
    if (result.ok) {
      setStatus(result.data);
      setLoadState('loaded');
      return result.data;
    }
    setStatus(null);
    setError(result.error);
    setLoadState('error');
    return null;
  }, [client]);

  useEffect(() => {
    setStatus(null);
    void refresh();
    return () => {
      latestRequest.current += 1;
    };
  }, [refresh]);

  const configure = useCallback(
    async (repository: string): Promise<PublicationStatus | null> => {
      const request = ++latestRequest.current;
      setPendingMutation('configure');
      setLoadState('loading');
      setError(null);
      const result = await client.configurePublicationTarget(repository);
      if (!mounted.current || request !== latestRequest.current) return null;
      setPendingMutation(null);
      if (result.ok) {
        setStatus(result.data);
        setLoadState('loaded');
        return result.data;
      }
      setError(result.error);
      setLoadState('error');
      return null;
    },
    [client],
  );

  const clear = useCallback(async (): Promise<PublicationStatus | null> => {
    const request = ++latestRequest.current;
    setPendingMutation('clear');
    setLoadState('loading');
    setError(null);
    const result = await client.clearPublicationTarget();
    if (!mounted.current || request !== latestRequest.current) return null;
    setPendingMutation(null);
    if (result.ok) {
      setStatus(result.data);
      setLoadState('loaded');
      return result.data;
    }
    setError(result.error);
    setLoadState('error');
    return null;
  }, [client]);

  return {
    status,
    loadState,
    error,
    pendingMutation,
    refresh,
    configure,
    clear,
  };
}
