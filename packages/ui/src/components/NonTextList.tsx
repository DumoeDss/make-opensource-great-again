import type { Finding, NonTextDisposition, NonTextItem } from '../api/types';

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
    return <p className="text-sm text-gray-500">No non-text content in this session.</p>;
  }
  return (
    <ul className="space-y-2" data-testid="nontext-list">
      {items.map((item) => {
        const context = contextFor(item.messageIndex);
        return (
          <li
            key={item.messageUuid}
            className="rounded border border-gray-200 p-3"
            data-testid={`nontext-${item.messageUuid}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm">
                <span className="mr-2">⚠</span>
                <b>{item.blockTypes.join(', ')}</b>{' '}
                <span className="text-gray-500">at message[{item.messageIndex}]</span>
                {context && (
                  <div className="mt-1 max-w-xl truncate text-xs text-gray-500">“{context}”</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    item.disposition === 'pending'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-green-100 text-green-700'
                  }`}
                >
                  {item.disposition}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onDisposition(item.messageUuid, 'keep')}
                  data-testid={`nontext-keep-${item.messageUuid}`}
                  className={`rounded px-2 py-1 text-xs ${
                    item.disposition === 'keep'
                      ? 'bg-green-600 text-white'
                      : 'border border-green-400 text-green-700 hover:bg-green-50'
                  }`}
                >
                  confirm (keep)
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onDisposition(item.messageUuid, 'remove')}
                  data-testid={`nontext-remove-${item.messageUuid}`}
                  className={`rounded px-2 py-1 text-xs ${
                    item.disposition === 'remove'
                      ? 'bg-gray-800 text-white'
                      : 'border border-gray-300 text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  exclude (remove)
                </button>
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
