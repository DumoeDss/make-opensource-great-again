import { describe, expect, it } from 'vitest';

import { LOOPBACK_HOST, startDaemon } from '../server.js';
import { withServer } from './_helpers.js';

// Proves resolution → transpile → test is wired so the root vitest runner picks
// the package up, and that the server binds loopback and answers /api/health.
describe('@mosga/daemon smoke', () => {
  it('binds 127.0.0.1 and serves /api/health', async () => {
    await withServer({}, async (base, daemon) => {
      expect(daemon.host).toBe(LOOPBACK_HOST);
      const res = await fetch(`${base}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe('mosga-daemon');
    });
  });

  it('never binds a non-loopback interface', async () => {
    // Binding is hard-wired to 127.0.0.1; the reported address confirms it.
    const daemon = await startDaemon({ port: 0 });
    try {
      const address = daemon.server.address();
      expect(typeof address === 'object' && address ? address.address : '').toBe('127.0.0.1');
    } finally {
      await daemon.close();
    }
  });
});
