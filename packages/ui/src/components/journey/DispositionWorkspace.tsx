/**
 * DispositionWorkspace — step ② (design B3). Merges the former
 * blocking / non-text / Layer-3 tabs into one workspace: a left group nav
 * (密钥命中 / 自定义规则 / 图像附件 / 归一化统计, with counts) + a right disposition
 * queue that reuses `FindingsTable` / `NonTextList` / `Layer3View` UNCHANGED for
 * the selected group. Batch operations are promoted to queue-top suggestion
 * cards. 归一化统计 is read-only (Layer3View) and contributes no gate count.
 */
import { ArrowRight, BarChart3, CheckCircle2, Image, type LucideIcon, KeyRound, SlidersHorizontal, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type {
  Disposition,
  Finding,
  NonTextDisposition,
  NonTextItem,
  NormalizationCategory,
  SanitizationReport,
} from '../../api/types';
import { isMetaFinding } from '../../lib/findings';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import { FindingsTable } from '../FindingsTable';
import { Layer3View } from '../Layer3View';
import { NonTextList } from '../NonTextList';

type GroupId = 'secrets' | 'custom' | 'nontext' | 'normalization';

interface DispositionWorkspaceProps {
  report: SanitizationReport;
  blocking: Finding[];
  nonTextItems: NonTextItem[];
  contextFor: (messageIndex: number) => string | undefined;
  onDisposition: (findingId: string, disposition: Disposition) => void;
  onBatchByRule: (ruleId: string, disposition: Disposition) => void;
  onBatchByType: (category: NormalizationCategory, disposition: Disposition) => void;
  onNonText: (messageUuid: string, disposition: NonTextDisposition) => void;
  busy?: boolean;
  /** When set, select the group holding this rule (from the wizard's 回到② jump). */
  focusRuleId?: string | null;
  /** Auto-cleanable hits in this session (pending + blocking + non-meta); >0 shows the clean card. */
  cleanableCount?: number;
  /** Replace every cleanable hit in this session with its pseudonym. */
  onCleanAll?: () => void;
  /** The gate is unlocked → surface the primary CTA to move on to ③ 选择出口. */
  cleared?: boolean;
  /** Advance the journey to ③ 选择出口. */
  onProceedToExit?: () => void;
}

const GROUP_ICONS: Record<GroupId, LucideIcon> = {
  secrets: KeyRound,
  custom: SlidersHorizontal,
  nontext: Image,
  normalization: BarChart3,
};

/** Batch suggestions: each rule in the current group with >1 pending hit. */
function ruleSuggestions(findings: Finding[]): Array<{ ruleId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const f of findings) {
    if (f.disposition === 'pending') counts.set(f.ruleId, (counts.get(f.ruleId) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, n]) => n > 1)
    .map(([ruleId, count]) => ({ ruleId, count }));
}

export function DispositionWorkspace({
  report,
  blocking,
  nonTextItems,
  contextFor,
  onDisposition,
  onBatchByRule,
  onBatchByType,
  onNonText,
  busy,
  focusRuleId,
  cleanableCount = 0,
  onCleanAll,
  cleared,
  onProceedToExit,
}: DispositionWorkspaceProps): JSX.Element {
  // Secrets = blocking secrets (excl. meta); custom = blocking custom + meta
  // findings (engine/meta hits have no editable text but must be clearable).
  const secretsFindings = useMemo(
    () => blocking.filter((f) => f.layer === 'secrets' && !isMetaFinding(f)),
    [blocking],
  );
  const customFindings = useMemo(
    () => blocking.filter((f) => f.layer === 'custom' || isMetaFinding(f)),
    [blocking],
  );

  const pending = (fs: Finding[]): number => fs.filter((f) => f.disposition === 'pending').length;
  const nonTextPending = nonTextItems.filter((n) => n.disposition === 'pending').length;

  const groups: Array<{ id: GroupId; label: string; count: number; gates: boolean }> = [
    { id: 'secrets', label: '密钥命中', count: pending(secretsFindings), gates: true },
    { id: 'custom', label: '自定义规则', count: pending(customFindings), gates: true },
    { id: 'nontext', label: '图像/附件', count: nonTextPending, gates: true },
    {
      id: 'normalization',
      label: '归一化统计',
      count: report.layerSummary.normalization.total,
      gates: false,
    },
  ];

  const [group, setGroup] = useState<GroupId>('secrets');

  // A 回到② jump from the publish wizard: select whichever group holds the rule.
  useEffect(() => {
    if (!focusRuleId) return;
    if (secretsFindings.some((f) => f.ruleId === focusRuleId)) setGroup('secrets');
    else if (customFindings.some((f) => f.ruleId === focusRuleId)) setGroup('custom');
  }, [focusRuleId, secretsFindings, customFindings]);

  const groupFindings = group === 'secrets' ? secretsFindings : customFindings;
  const suggestions = group === 'secrets' || group === 'custom' ? ruleSuggestions(groupFindings) : [];

  return (
    <div className="space-y-3">
      {/* Gate cleared → the step's explicit primary CTA: move on to ③ 选择出口. */}
      {cleared && onProceedToExit && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/50 bg-success/10 p-3"
          data-testid="cleared-banner"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-success">
            <CheckCircle2 className="h-4 w-4" strokeWidth={1.5} />
            该会话所有命中已处置完毕。
          </span>
          <Button type="button" onClick={onProceedToExit} data-testid="goto-exit">
            前往选择出口
            <ArrowRight className="h-4 w-4" strokeWidth={1.5} />
          </Button>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[13rem_1fr]" data-testid="disposition-workspace">
        <nav className="space-y-1" data-testid="group-nav">
        {groups.map((g) => {
          const Icon = GROUP_ICONS[g.id];
          const active = g.id === group;
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => setGroup(g.id)}
              data-testid={`group-${g.id}`}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                active
                  ? 'border-primary/40 bg-primary-soft/25 text-foreground'
                  : 'border-transparent text-text-muted hover:bg-surface-2/40 hover:text-foreground',
              )}
            >
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                {g.label}
              </span>
              <span
                className={cn(
                  'rounded-full px-1.5 text-xs',
                  g.gates && g.count > 0
                    ? 'bg-destructive/15 text-destructive'
                    : 'bg-surface-2 text-text-subtle',
                )}
                data-testid={`group-count-${g.id}`}
              >
                {g.count}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 space-y-3" data-testid="disposition-queue">
        {/* No-pressure donation: one action clears every rule-based hit at once. */}
        {cleanableCount > 0 && onCleanAll && (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary-soft/25 p-4"
            data-testid="clean-all-card"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                该会话还有 {cleanableCount} 处命中可按规则一键替换
              </p>
              <p className="mt-0.5 text-xs text-text-muted">
                密钥 / 自定义命中将替换为稳定化名；引擎降级与图像附件仍需你人工确认。
              </p>
            </div>
            <Button
              type="button"
              size="lg"
              disabled={busy}
              onClick={onCleanAll}
              data-testid="clean-all"
              className="shrink-0"
            >
              <Wand2 className="h-4 w-4" strokeWidth={1.5} />
              一键全部替换为化名
            </Button>
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="space-y-2" data-testid="batch-suggestions">
            {suggestions.map((s) => (
              <div
                key={s.ruleId}
                className="flex items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary-soft/20 px-3 py-2 text-sm"
              >
                <span>
                  「<code className="font-mono">{s.ruleId}</code>」× {s.count} 处待处置
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="subtle"
                  disabled={busy}
                  onClick={() => onBatchByRule(s.ruleId, 'replace')}
                  data-testid={`batch-suggest-${s.ruleId}`}
                >
                  一键替换为化名
                </Button>
              </div>
            ))}
          </div>
        )}

        {(group === 'secrets' || group === 'custom') && (
          <FindingsTable
            findings={groupFindings}
            onDisposition={onDisposition}
            onBatchByRule={onBatchByRule}
            busy={busy}
          />
        )}
        {group === 'nontext' && (
          <NonTextList
            items={nonTextItems}
            contextFor={contextFor}
            onDisposition={onNonText}
            busy={busy}
          />
        )}
        {group === 'normalization' && (
          <Layer3View report={report} onBatchByType={onBatchByType} busy={busy} />
        )}
      </div>
      </div>
    </div>
  );
}
