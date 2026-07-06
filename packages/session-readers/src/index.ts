// Adapter interface + registry + the Claude Code adapter.
export type { CliSourceAdapter } from './adapter/types.js';
export { claudeCodeAdapter, extractClaudeTitle } from './adapter/claudeCodeAdapter.js';
export {
  getAdapter,
  listAdapters,
  registerAdapter,
} from './adapter/registry.js';

// Non-text-marker parse wrapper.
export { parseClaudeSession } from './parseClaudeSession.js';

// Cross-platform Claude Code project-path encoder.
export { encodeProjectPath } from './claudeProjectsPaths.js';

// Extracted filesystem discovery primitives (read-only, degrade cleanly).
export {
  scanClaudeProjectDirs,
  listSessionFilesInProject,
  readSessionEntries,
  extractSummaryFromEntries,
  extractCwdFromEntries,
  probeProjectCwd,
} from './filesystem.js';

// Extracted JSONL parse path.
export {
  deduplicateEntries,
  parseContentBlocks,
  parseJsonlEntriesToAgentMessages,
} from './parsers/JsonlParser.js';

// Extracted JSONL entry / content-block / message shapes.
export type { JsonlEntry, ContentBlock, ParsedAgentMessage } from './types.js';
