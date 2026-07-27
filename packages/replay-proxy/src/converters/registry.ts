import type { ReplayApiFormat, ReplaySourceWireProtocol } from '../types.js';

import type { ReplayProtocolConverter } from './types.js';

/**
 * The closed converter registry. Looked up by the `(sourceProtocol,
 * targetFormat)` pair implied by the route requirement's `wireProtocol` and the
 * upstream target's `upstreamApiFormat`. An unregistered pair fails closed at
 * registration with `converter-unsupported`; the registry NEVER falls back to a
 * nearest-match, identity, or best-effort converter.
 *
 * The v1 set is exactly four converters (two passthrough + two cross-protocol
 * to OpenAI Chat Completions). Any other pair — notably the reverse
 * cross-protocol pairs and Anthropic↔Responses — fails closed.
 */
export class ConverterRegistry {
  private readonly entries = new Map<string, ReplayProtocolConverter>();

  public register(converter: ReplayProtocolConverter): void {
    const key = pairKey(converter.sourceProtocol, converter.targetFormat);
    if (this.entries.has(key)) {
      throw new Error(
        `converter already registered for ${key} (${this.entries.get(key)?.id})`,
      );
    }
    this.entries.set(key, converter);
  }

  public lookup(
    sourceProtocol: ReplaySourceWireProtocol,
    targetFormat: ReplayApiFormat,
  ): ReplayProtocolConverter | undefined {
    return this.entries.get(pairKey(sourceProtocol, targetFormat));
  }

  /** The set of registered pair keys, for matrix tests. */
  public registeredPairs(): string[] {
    return [...this.entries.keys()].sort();
  }
}

export function pairKey(
  sourceProtocol: ReplaySourceWireProtocol,
  targetFormat: ReplayApiFormat,
): string {
  return `${sourceProtocol}->${targetFormat}`;
}

/** Build the v1 registry with exactly the four supported converters. */
export function buildV1Registry(
  converters: readonly ReplayProtocolConverter[],
): ConverterRegistry {
  const registry = new ConverterRegistry();
  for (const converter of converters) {
    registry.register(converter);
  }
  return registry;
}
