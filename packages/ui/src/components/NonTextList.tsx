import { AlertTriangle } from 'lucide-react';

import type { Finding, NonTextDisposition, NonTextItem } from '../api/types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface NonTextListProps {
  items: NonTextItem[];
  /** All findings, used only to show nearby text context for a message. */
  contextFor: (messageIndex: number) => string | undefined;
  onDisposition: (messageUuid: string, disposition: NonTextDisposition) => void;
  busy?: boolean;
}

/**
 * Per-item non-text ⚠ confirmation (design D6). Each item shows its block
 * type(s) and message location/context with confirm (keep) / exclude (remove)
 * actions. v0.1 does NOT render image bytes. Items resolved onto a tool_use
 * message are listed at that message via their `messageIndex`.
 */
export function NonTextList({
  items,
  contextFor,
  onDisposition,
  busy,
}: NonTextListProps): JSX.Element {
  if (items.length === 0) {
    return <p className="text-sm text-text-subtle">No non-text content in this session.</p>;
  }
  return (
    <ul className="space-y-2" data-testid="nontext-list">
      {items.map((item) => {
        const context = contextFor(item.messageIndex);
        return (
          <li
            key={item.messageUuid}
            className="rounded-md border border-border bg-surface-1 p-3"
            data-testid={`nontext-${item.messageUuid}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm">
                <AlertTriangle className="mr-2 inline h-4 w-4 text-warning" strokeWidth={1.5} />
                <b>{item.blockTypes.join(', ')}</b>{' '}
                <span className="text-text-subtle">at message[{item.messageIndex}]</span>
                {context && (
                  <div className="mt-1 max-w-xl truncate text-xs text-text-subtle">“{context}”</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={item.disposition === 'pending' ? 'destructive' : 'success'}>
                  {item.disposition}
                </Badge>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => onDisposition(item.messageUuid, 'keep')}
                  data-testid={`nontext-keep-${item.messageUuid}`}
                  size="xs"
                  variant={item.disposition === 'keep' ? 'default' : 'outline'}
                >
                  confirm (keep)
                </Button>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => onDisposition(item.messageUuid, 'remove')}
                  data-testid={`nontext-remove-${item.messageUuid}`}
                  size="xs"
                  variant={item.disposition === 'remove' ? 'default' : 'outline'}
                >
                  exclude (remove)
                </Button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Context lookup: the redacted preview of the first finding on a message. */
export function makeContextLookup(findings: Finding[]): (messageIndex: number) => string | undefined {
  return (messageIndex) =>
    findings.find((f) => f.location.messageIndex === messageIndex)?.matchPreview;
}
