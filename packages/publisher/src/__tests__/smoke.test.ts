import { describe, expect, it } from 'vitest';

import { exportSession, precheckRecord, resolveSanitizerPackageVersion } from '../index.js';
import { SANITIZER_PACKAGE_VERSION, cleanSession } from './_fixtures.js';

describe('@mosga/publisher smoke', () => {
  it('exports and pre-checks a clean stamped session', () => {
    const record = exportSession(cleanSession(), { sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION });
    expect(record.recordCount).toBe(1);
    const result = precheckRecord(record.jsonl);
    expect(result.ok).toBe(true);
  });

  it('resolves the real installed @mosga/sanitizer package version', () => {
    expect(resolveSanitizerPackageVersion()).toBe(SANITIZER_PACKAGE_VERSION);
  });
});
