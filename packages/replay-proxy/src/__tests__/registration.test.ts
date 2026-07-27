import { describe, expect, it } from 'vitest';

import { createReplayProxy } from '../index.js';

import {
  CLAUDE_REQUIREMENT,
  CLAUDE_TARGET_ANTHROPIC,
  CLAUDE_TARGET_CHAT,
  CODEX_REQUIREMENT,
  CODEX_TARGET_CHAT,
  createRecordingTransport,
  jsonResponse,
} from './fixtures.js';

describe('registerRoute validation and binding construction', () => {
  it('produces a valid loopback binding for a matching upstream', async () => {
    const proxy = createReplayProxy();
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    const { binding } = reg.handle;

    // Every source/protocol/auth/target field is repeated from the requirement.
    expect(binding.sourceCli).toBe(CLAUDE_REQUIREMENT.sourceCli);
    expect(binding.wireProtocol).toBe(CLAUDE_REQUIREMENT.wireProtocol);
    expect(binding.transport).toBe('loopback-http');
    expect(binding.authScheme).toBe('route-bearer');
    expect(binding.targetProviderId).toBe(CLAUDE_REQUIREMENT.targetProviderId);
    expect(binding.targetModel).toBe(CLAUDE_REQUIREMENT.targetModel);

    // Loopback with an explicit port, no userinfo/query/fragment/path.
    const url = new URL(binding.baseUrl);
    expect(url.protocol).toBe('http:');
    expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
    expect(Number.parseInt(url.port, 10)).toBeGreaterThan(0);
    expect(url.username).toBe('');
    expect(url.password).toBe('');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(url.pathname).toBe('/');

    // Token and cliModel are nonempty.
    expect(binding.routeToken.length).toBeGreaterThan(0);
    expect(binding.cliModel).toBe(CLAUDE_REQUIREMENT.targetModel);

    await proxy.shutdown();
  });

  it('rejects a target provider mismatch before listening', async () => {
    const proxy = createReplayProxy();
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, {
      ...CLAUDE_TARGET_CHAT,
      targetProviderId: 'wrong-provider',
    });
    expect(reg.ok).toBe(false);
    if (reg.ok) return;
    expect(reg.error.code).toBe('registration-invalid');
    expect(reg.error.stage).toBe('register');
    await proxy.shutdown();
  });

  it('rejects a target model mismatch before listening', async () => {
    const proxy = createReplayProxy();
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, {
      ...CLAUDE_TARGET_CHAT,
      targetModel: 'wrong-model',
    });
    expect(reg.ok).toBe(false);
    if (reg.ok) return;
    expect(reg.error.code).toBe('registration-invalid');
    await proxy.shutdown();
  });

  it('rejects an empty upstream API key', async () => {
    const proxy = createReplayProxy();
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, {
      ...CLAUDE_TARGET_CHAT,
      upstreamApiKey: '',
    });
    expect(reg.ok).toBe(false);
    if (reg.ok) return;
    expect(reg.error.code).toBe('registration-invalid');
    await proxy.shutdown();
  });

  it('rejects a non-HTTPS, non-loopback upstream base URL', async () => {
    const proxy = createReplayProxy();
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, {
      ...CLAUDE_TARGET_CHAT,
      upstreamBaseUrl: 'http://api.example.com',
    });
    expect(reg.ok).toBe(false);
    if (reg.ok) return;
    expect(reg.error.code).toBe('registration-invalid');
    await proxy.shutdown();
  });

  it('rejects an HTTPS loopback upstream base URL', async () => {
    const proxy = createReplayProxy();
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, {
      ...CLAUDE_TARGET_CHAT,
      upstreamBaseUrl: 'https://127.0.0.1:8443',
    });
    expect(reg.ok).toBe(false);
    if (reg.ok) return;
    expect(reg.error.code).toBe('registration-invalid');
    await proxy.shutdown();
  });

  it('rejects an upstream base URL with query or fragment', async () => {
    const proxy = createReplayProxy();
    for (const baseUrl of [
      'https://api.example.com?x=1',
      'https://api.example.com#frag',
      'https://user:pass@api.example.com',
    ]) {
      const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, {
        ...CLAUDE_TARGET_CHAT,
        upstreamBaseUrl: baseUrl,
      });
      expect(reg.ok).toBe(false);
      if (!reg.ok) expect(reg.error.code).toBe('registration-invalid');
    }
    await proxy.shutdown();
  });

  it('fails closed for an unsupported (source, target) converter pair', async () => {
    const proxy = createReplayProxy();
    // anthropic-messages -> openai-responses has no registered converter.
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, {
      ...CLAUDE_TARGET_CHAT,
      upstreamApiFormat: 'openai-responses',
    });
    expect(reg.ok).toBe(false);
    if (reg.ok) return;
    expect(reg.error.code).toBe('converter-unsupported');
    await proxy.shutdown();
  });

  it('refuses registration after shutdown', async () => {
    const proxy = createReplayProxy();
    await proxy.shutdown();
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    expect(reg.ok).toBe(false);
    if (reg.ok) return;
    expect(reg.error.code).toBe('proxy-shutdown');
  });

  it('binds to ::1 when loopbackHost is requested', async () => {
    const proxy = createReplayProxy();
    const rec = createRecordingTransport(jsonResponse(200, {}));
    const proxyV6 = createReplayProxy({ transport: rec.transport });
    const reg = await proxyV6.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT, {
      loopbackHost: '::1',
    });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    const url = new URL(reg.handle.binding.baseUrl);
    // WHATWG URL serializes IPv6 hosts with brackets.
    expect(url.hostname.replace(/[\[\]]/g, '')).toBe('::1');
    await proxyV6.shutdown();
    await proxy.shutdown();
  });
});
