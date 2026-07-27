import type { ProcessRunner } from '../workspace/process.js';
import { GitHubAdapterError } from './port.js';

export interface GitAuthEnvironment {
  GIT_CONFIG_COUNT: '1';
  GIT_CONFIG_KEY_0: 'credential.https://github.com.helper';
  GIT_CONFIG_VALUE_0: '!gh auth git-credential';
  GIT_TERMINAL_PROMPT: '0';
}

/**
 * Supplies a child-process-only Git credential-helper configuration. The
 * publication process never receives or serializes the underlying gh token.
 */
export interface GitCredentialPort {
  withCredentials<T>(
    action: (environment: GitAuthEnvironment) => Promise<T>,
  ): Promise<T>;
}

export class GhGitCredentialPort implements GitCredentialPort {
  constructor(private readonly runner: ProcessRunner) {}

  async withCredentials<T>(
    action: (environment: GitAuthEnvironment) => Promise<T>,
  ): Promise<T> {
    const result = await this.runner.run('gh', [
      'auth',
      'status',
      '--hostname',
      'github.com',
    ], {
      maxOutputBytes: 16 * 1024,
    });
    if (result.code !== 0) {
      throw new GitHubAdapterError(
        result.code === 127 ? 'client_missing' : 'login_required',
      );
    }
    return action({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '!gh auth git-credential',
      GIT_TERMINAL_PROMPT: '0',
    });
  }
}

export class FakeGitCredentialPort implements GitCredentialPort {
  calls = 0;

  async withCredentials<T>(
    action: (environment: GitAuthEnvironment) => Promise<T>,
  ): Promise<T> {
    this.calls += 1;
    return action({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '!gh auth git-credential',
      GIT_TERMINAL_PROMPT: '0',
    });
  }
}
