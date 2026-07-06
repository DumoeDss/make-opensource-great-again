import type { SanitizationReport } from '../api/types';

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
      className={`rounded-lg border p-4 ${
        locked
          ? 'border-red-300 bg-red-50 text-red-900'
          : 'border-green-300 bg-green-50 text-green-900'
      }`}
      data-testid="gate-banner"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="font-semibold" data-testid="gate-status">
            {locked ? '🔒 未清零不解锁 — Gate locked' : '🔓 Gate unlocked'}
          </div>
          <div className="mt-1 text-sm">
            Blocking pending: <b data-testid="blocking-pending">{gate.blockingPending}</b> /{' '}
            {gate.blockingTotal} &nbsp;·&nbsp; Non-text pending:{' '}
            <b data-testid="nontext-pending">{gate.nonTextPending}</b>
          </div>
        </div>
        <button
          type="button"
          onClick={onExport}
          disabled={!canExport}
          data-testid="export-button"
          className={`rounded-md px-4 py-2 text-sm font-medium text-white ${
            canExport ? 'bg-green-600 hover:bg-green-700' : 'cursor-not-allowed bg-gray-400'
          }`}
        >
          {exporting ? 'Exporting…' : 'Export sanitized session'}
        </button>
      </div>

      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={signed}
          disabled={locked}
          onChange={(e) => onSignedChange(e.target.checked)}
          data-testid="sign-checkbox"
          className="mt-0.5"
        />
        <span>
          我确认：<b>{SIGNED_SUMMARY}</b>
          {locked && (
            <span className="ml-1 text-red-700">
              （处置所有阻断项与含图记录后方可签署）
            </span>
          )}
        </span>
      </label>
    </div>
  );
}
