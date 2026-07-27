// Test-only fake boundary. NOT exported from the package surface; consumed by
// the runtime's own test suite to drive controllable isTreeAlive /
// preserveTreeOnClose scenarios without a real OS boundary.
import type { ProcessTreeBoundary } from '../processTreeBoundary.js';

export interface FakeProcessTreeBoundary extends ProcessTreeBoundary {
  alive: boolean;
  preserveTreeOnClose: boolean;
  assignCalls: number;
  assignedPid: number | null;
  terminateCalls: boolean[];
  disposed: boolean;
  /** Mirror the direct-child-close semantics for test scenarios. */
  onDirectChildClose(): void;
}

export function createFakeProcessTreeBoundary(
  overrides: Partial<
    Pick<FakeProcessTreeBoundary, 'alive' | 'preserveTreeOnClose'>
  > = {},
): FakeProcessTreeBoundary {
  const self: FakeProcessTreeBoundary = {
    alive: overrides.alive ?? true,
    preserveTreeOnClose: overrides.preserveTreeOnClose ?? false,
    assignCalls: 0,
    assignedPid: null,
    terminateCalls: [],
    disposed: false,
    async assignChild(child) {
      self.assignedPid = child.pid;
      self.assignCalls += 1;
    },
    async isTreeAlive() {
      return self.alive;
    },
    async terminateTree(force) {
      // Record only — sending a signal does not synchronously change liveness.
      // The test's onTerminate callback simulates the effect (child close,
      // alive flip) so escalation scenarios stay controllable.
      self.terminateCalls.push(force);
    },
    dispose() {
      self.disposed = true;
    },
    onDirectChildClose() {
      // If the descendant tree is not preserved, the boundary goes empty when
      // the direct child closes.
      if (!self.preserveTreeOnClose) self.alive = false;
    },
  };
  return self;
}
