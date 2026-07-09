import { Lock, Unlock } from 'lucide-react';

import type { SanitizationReport } from '../api/types';
import { Button } from './ui/button';

/** The signed confirmation summary the reviewer must affirm to unlock export. */
export const SIGNED_SUMMARY = '命中项已全部处置 + 含图记录已逐条确认 + 抽检通过';

interface GateBannerProps {
  gate: SanitizationReport['gate'];
  signed: boolean;
  onSignedChange: (signed: boolean) => void;
  onExport: () => void;
  exporting?: boolean;
}

/**
 * The confirmation gate. Stays LOCKED until `gate.unlocked` (every blocking
 * finding and non-text item dispositioned). Export is disabled while locked or
 * until the reviewer affirms the signed summary — there is no path around it.
 */
export function GateBanner({
  gate,
  signed,
  onSignedChange,
  onExport,
  exporting,
}: GateBannerProps): JSX.Element {
  const locked = !gate.unlocked;
  const canExport = gate.unlocked && signed && !exporting;

  return (
    <div
      className={`rounded-lg border p-4 text-foreground ${
        locked
          ? 'border-destructive/50 bg-destructive/10'
          : 'border-success/50 bg-success/15'
      }`}
      data-testid="gate-banner"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <div
            className={`flex items-center gap-1.5 font-semibold ${
              locked ? 'text-destructive' : 'text-success'
            }`}
            data-testid="gate-status"
          >
            {locked ? (
              <>
                <Lock className="h-4 w-4" strokeWidth={1.5} />
                未清零不解锁 — Gate locked
              </>
            ) : (
              <>
                <Unlock className="h-4 w-4" strokeWidth={1.5} />
                Gate unlocked
              </>
            )}
          </div>
          <div className="mt-1 text-sm">
            Blocking pending: <b data-testid="blocking-pending">{gate.blockingPending}</b> /{' '}
            {gate.blockingTotal} &nbsp;·&nbsp; Non-text pending:{' '}
            <b data-testid="nontext-pending">{gate.nonTextPending}</b>
          </div>
        </div>
        <Button
          type="button"
          onClick={onExport}
          disabled={!canExport}
          data-testid="export-button"
          size="lg"
        >
          {exporting ? 'Exporting…' : 'Export sanitized session'}
        </Button>
      </div>

      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={signed}
          disabled={locked}
          onChange={(e) => onSignedChange(e.target.checked)}
          data-testid="sign-checkbox"
          className="mt-0.5 accent-primary"
        />
        <span>
          我确认：<b>{SIGNED_SUMMARY}</b>
          {locked && (
            <span className="ml-1 text-destructive">
              （处置所有阻断项与含图记录后方可签署）
            </span>
          )}
        </span>
      </label>
    </div>
  );
}
