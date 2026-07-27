// Persistent OS process-tree boundary.
//
// A single boundary owns the tree identity for the entire lifecycle of one
// spawned process (capability probe OR replay execution). The supervisor
// creates the boundary, binds the just-spawned child to it, and queries /
// terminates through it — never through the original PID, which on Windows
// goes stale the moment the direct parent exits while a detached descendant
// survives (the SPEC-B1 defect).
//
// Platform implementations:
//   - win32: WindowsJobObjectBoundary (Win32 Job Object via koffi FFI).
//   - other: PosixProcessGroupBoundary (detached process group, current behavior).
//
// koffi is an optional win32-only dependency. It is imported LAZILY and ONLY
// inside the win32 branch, via a non-literal module specifier so that
// TypeScript does not attempt to resolve the type on platforms where koffi is
// not installed. Any failure to load koffi or to create the Job fails CLOSED
// (runtime-policy-unsupported, stage launch) — the runtime never spawns an
// unbounded tree.

import type { SourceCli } from '@mosga/contracts';

import { RuntimeFault } from './errors.js';

/**
 * Opaque kernel handle (koffi pointer). Typed as `unknown` because the value
 * is only ever produced and consumed by the FFI layer; application code never
 * inspects it.
 */
export type NativeHandle = unknown;

export interface ProcessTreeBoundary {
  /**
   * Bind the just-spawned child to the persistent OS handle. Called exactly
   * once, immediately after host.spawn returns — BEFORE awaiting any child
   * output. The assignment must complete before the child has a chance to
   * spawn descendants that could escape the boundary.
   *
   * On win32 this opens the child process and assigns it to the Job Object.
   * Future descendants the child spawns inherit the Job automatically (the
   * boundary deliberately does NOT set JOB_OBJECT_LIMIT_BREAKAWAY_OK, so
   * CREATE_BREAKAWAY_FROM_JOB is denied by the kernel).
   */
  assignChild(child: { readonly pid: number }): Promise<void>;
  /**
   * Query the OS-level boundary, NOT the original PID. Resolves false only
   * when the boundary is empty (no descendant alive either). Resolves true
   * on an unknown/error state (an unconfirmed tree is treated as alive — the
   * safe direction).
   */
  isTreeAlive(): Promise<boolean>;
  /**
   * Terminate every process in the boundary. The supervisor sequences a
   * graceful request (child.kill / group signal) first, then calls this to
   * force-reap anything still alive; `force` is recorded for diagnostics but
   * the kernel call is the same.
   */
  terminateTree(force: boolean): Promise<void>;
  /** Release the OS handle. Idempotent. Called on every terminal path. */
  dispose(): void;
}

export interface ProcessTreeBoundaryFactory {
  create(): Promise<ProcessTreeBoundary>;
}

// ---------------------------------------------------------------------------
// POSIX: detached process group (unchanged behavior, moved behind the boundary).
// ---------------------------------------------------------------------------

/**
 * On POSIX the child is spawned `detached: true` so pid == pgid (process-group
 * leader). assignChild records the pid; liveness and termination use the
 * negative-pid group form. assignChild and dispose are no-ops.
 */
export class PosixProcessGroupBoundary implements ProcessTreeBoundary {
  private pid: number | null = null;

  async assignChild(child: { readonly pid: number }): Promise<void> {
    this.pid = child.pid;
  }

  async isTreeAlive(): Promise<boolean> {
    if (this.pid === null) return false;
    try {
      process.kill(-this.pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      // EPERM means the group exists but is not ours — treat as alive.
      if (code === 'EPERM') return true;
      // Unknown tree state is not safe evidence of termination.
      return true;
    }
  }

  async terminateTree(force: boolean): Promise<void> {
    if (this.pid === null) return;
    try {
      process.kill(-this.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  dispose(): void {
    this.pid = null;
  }
}

// ---------------------------------------------------------------------------
// Windows: Job Object via koffi.
// ---------------------------------------------------------------------------

// JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64. The only field we
// set is BasicLimitInformation.LimitFlags at offset 16; everything else is
// zeroed (= no limit). Setting JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE guarantees
// that when the Job handle is closed — including if our Node process dies —
// the kernel kills every process still in the Job.
const EXTENDED_LIMITS_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectExtendedLimitInformation = 9;
const JobObjectBasicProcessIdList = 3;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
// JOBOBJECT_BASIC_PROCESS_ID_LIST layout: u32 NumberOfAssignedProcesses,
// u32 NumberOfProcessIdsInList, then u64 ProcessIdList[]. 64 slots is far
// beyond any realistic CLI helper fan-out.
const PID_LIST_CAPACITY = 64;
const PID_LIST_BUFFER_SIZE = 8 + 8 * PID_LIST_CAPACITY;

/** Minimal koffi surface we depend on (avoids coupling to koffi's full API). */
interface KoffiModule {
  load(name: string): KoffiLibrary;
}
interface KoffiLibrary {
  func(declaration: string): (...args: never[]) => unknown;
}

interface WindowsJobFunctions {
  CreateJobObjectW(attributes: null, name: null): NativeHandle;
  SetInformationJobObject(
    job: NativeHandle,
    infoClass: number,
    info: Buffer,
    length: number,
  ): number;
  AssignProcessToJobObject(job: NativeHandle, process: NativeHandle): number;
  QueryInformationJobObject(
    job: NativeHandle,
    infoClass: number,
    info: Buffer,
    length: number,
    returnLength: null,
  ): number;
  TerminateJobObject(job: NativeHandle, exitCode: number): number;
  CloseHandle(handle: NativeHandle): number;
  OpenProcess(access: number, inheritHandle: number, pid: number): NativeHandle;
}

let cachedWindowsApi: WindowsJobFunctions | null = null;

/**
 * Lazily import koffi and bind the kernel32 functions. Cached so repeated
 * boundary creation reuses one library handle (koffi.load on the same library
 * name more than once is rejected). The dynamic import uses a non-literal
 * specifier so that `tsc` does not require koffi's types to be present on
 * platforms where it is never imported.
 */
async function loadWindowsJobApi(): Promise<WindowsJobFunctions> {
  if (cachedWindowsApi !== null) return cachedWindowsApi;
  // Non-literal specifier: TS infers `any`, avoiding a hard type dependency on
  // koffi for platforms where it is not installed.
  const specifier = 'koffi';
  const koffiModule = (await import(specifier)) as {
    default: KoffiModule;
  };
  const lib = koffiModule.default.load('kernel32.dll');
  cachedWindowsApi = {
    CreateJobObjectW: lib.func(
      'void *CreateJobObjectW(void *attributes, void *name)',
    ) as WindowsJobFunctions['CreateJobObjectW'],
    SetInformationJobObject: lib.func(
      'int32 SetInformationJobObject(void *job, int32 infoClass, void *info, uint32 length)',
    ) as WindowsJobFunctions['SetInformationJobObject'],
    AssignProcessToJobObject: lib.func(
      'int32 AssignProcessToJobObject(void *job, void *process)',
    ) as WindowsJobFunctions['AssignProcessToJobObject'],
    QueryInformationJobObject: lib.func(
      'int32 QueryInformationJobObject(void *job, int32 infoClass, void *info, uint32 length, void *returnLength)',
    ) as WindowsJobFunctions['QueryInformationJobObject'],
    TerminateJobObject: lib.func(
      'int32 TerminateJobObject(void *job, uint32 exitCode)',
    ) as WindowsJobFunctions['TerminateJobObject'],
    CloseHandle: lib.func(
      'int32 CloseHandle(void *handle)',
    ) as WindowsJobFunctions['CloseHandle'],
    OpenProcess: lib.func(
      'void *OpenProcess(uint32 access, int32 inheritHandle, uint32 pid)',
    ) as WindowsJobFunctions['OpenProcess'],
  };
  return cachedWindowsApi;
}

class WindowsJobObjectBoundary implements ProcessTreeBoundary {
  private readonly api: WindowsJobFunctions;
  private readonly job: NativeHandle;
  private disposed = false;
  private terminated = false;

  constructor(api: WindowsJobFunctions) {
    this.api = api;
    const job = api.CreateJobObjectW(null, null);
    if (!job) {
      throw new Error('CreateJobObjectW returned a null handle');
    }
    const limits = Buffer.alloc(EXTENDED_LIMITS_SIZE);
    limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET);
    if (
      api.SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        limits,
        EXTENDED_LIMITS_SIZE,
      ) === 0
    ) {
      api.CloseHandle(job);
      throw new Error('SetInformationJobObject failed');
    }
    this.job = job;
  }

  async assignChild(child: { readonly pid: number }): Promise<void> {
    // OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid).
    // PROCESS_SET_QUOTA is required to assign to a Job; PROCESS_TERMINATE so
    // the handle is consistent with the access the Job needs to reap it.
    const handle = this.api.OpenProcess(
      PROCESS_SET_QUOTA | PROCESS_TERMINATE,
      0,
      child.pid,
    );
    if (!handle) {
      throw new Error(`OpenProcess(${child.pid}) returned a null handle`);
    }
    try {
      if (this.api.AssignProcessToJobObject(this.job, handle) === 0) {
        throw new Error('AssignProcessToJobObject failed');
      }
    } finally {
      this.api.CloseHandle(handle);
    }
  }

  async isTreeAlive(): Promise<boolean> {
    if (this.terminated) return false;
    const buffer = Buffer.alloc(PID_LIST_BUFFER_SIZE);
    const ok = this.api.QueryInformationJobObject(
      this.job,
      JobObjectBasicProcessIdList,
      buffer,
      PID_LIST_BUFFER_SIZE,
      null,
    );
    // A failed query is not safe evidence of termination — treat as alive.
    if (ok === 0) return true;
    // NumberOfProcessIdsInList lives at offset 4.
    return buffer.readUInt32LE(4) > 0;
  }

  async terminateTree(force: boolean): Promise<void> {
    if (this.terminated) return;
    // Graceful-vs-forced is expressed by sequence (the supervisor requests
    // graceful shutdown via child.kill first), not by two different Job calls.
    // TerminateJobObject kernel-kills every process still in the Job and is
    // idempotent on an already-empty Job.
    this.terminated = true;
    void force;
    if (this.api.TerminateJobObject(this.job, 1) === 0) {
      throw new Error('TerminateJobObject failed');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // With KILL_ON_JOB_CLOSE set, CloseHandle reaps any straggler still in the
    // Job — this is the host-crash safety net.
    try {
      this.api.CloseHandle(this.job);
    } catch {
      // dispose is best-effort and must never throw on a terminal path.
    }
  }
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

/**
 * Returns the platform-selected boundary factory. On win32 each `create()`
 * lazily loads koffi (cached) and constructs a Job Object; if koffi is missing
 * or Job creation fails, `create()` rejects with `runtime-policy-unsupported`
 * (stage launch) so the caller fails closed WITHOUT spawning.
 */
export function createProcessTreeBoundaryFactory(): ProcessTreeBoundaryFactory {
  if (process.platform !== 'win32') {
    return {
      async create() {
        return new PosixProcessGroupBoundary();
      },
    };
  }
  return {
    async create(): Promise<ProcessTreeBoundary> {
      let api: WindowsJobFunctions;
      try {
        api = await loadWindowsJobApi();
      } catch {
        throw new RuntimeFault(
          'runtime-policy-unsupported',
          'launch',
        );
      }
      try {
        return new WindowsJobObjectBoundary(api);
      } catch {
        throw new RuntimeFault('runtime-policy-unsupported', 'launch');
      }
    },
  };
}

/**
 * Internal: build a boundary factory that injects the sourceCli / replay CLI
 * version into the fail-closed fault so downstream failures carry full
 * context. Used by the supervisor and probe supervisor.
 */
export function createProcessTreeBoundaryFactoryFor(
  _sourceCli: SourceCli,
  _replayCliVersion: string,
): ProcessTreeBoundaryFactory {
  // The factory's fail-closed fault is context-free (runtime-policy-unsupported
  // is always stage 'launch'); the supervisor wraps the spawn path in a fault
  // that already carries sourceCli/version. Kept as a seam for future per-CLI
  // boundary policy without expanding the public API.
  return createProcessTreeBoundaryFactory();
}
