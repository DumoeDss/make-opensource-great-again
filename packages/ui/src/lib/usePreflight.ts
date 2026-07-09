/**
 * usePreflight — fetch `GET /api/publish/preflight` and derive the exit-① card's
 * four states from the five capability flags (design B4 / decision 7):
 *
 *   dataRepoConfigured=false                    → 需配置
 *   git missing OR repo dirty                   → 缺依赖
 *   gh present but not authenticated            → gh未登录
 *   otherwise (incl. gh absent → manual path)   → 就绪
 *
 * `gh` being absent is NOT a blocker: the wizard's 提交 step has a gh-free manual
 * fallback (staged locations + commands + compareUrl), so an unconfigured-gh
 * clone is still 就绪.
 */
import { useCallback, useEffect, useState } from 'react';

import type { ApiClient } from '../api/client';
import type { PublishPreflight } from '../api/types';

export type ExitOneState = 'loading' | '就绪' | '需配置' | 'gh未登录' | '缺依赖';

export function deriveExitOneState(flags: PublishPreflight | null): ExitOneState {
  if (!flags) return 'loading';
  if (!flags.dataRepoConfigured) return '需配置';
  if (!flags.gitAvailable || !flags.repoClean) return '缺依赖';
  if (flags.ghAvailable && !flags.ghAuthenticated) return 'gh未登录';
  return '就绪';
}

export interface PreflightHook {
  state: ExitOneState;
  flags: PublishPreflight | null;
  refresh: () => void;
}

export function usePreflight(client: ApiClient): PreflightHook {
  const [flags, setFlags] = useState<PublishPreflight | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    client
      .getPreflight()
      .then((f) => active && setFlags(f))
      .catch(() => active && setFlags(null));
    return () => {
      active = false;
    };
  }, [client, nonce]);

  return { state: deriveExitOneState(flags), flags, refresh };
}
