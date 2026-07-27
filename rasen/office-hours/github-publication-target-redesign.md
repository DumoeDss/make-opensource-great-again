# 出口① GitHub 发布目标重设计

> Status: APPROVED  
> Date: 2026-07-27  
> Scope: 用“UI 配置 GitHub 目标 + daemon 托管工作区”直接替换现有 `--data-repo` / 用户本地 clone 模型。项目仍在开发中，不提供迁移、兼容或弃用过渡。

## 1. 结论

出口①的产品对象是“目标 GitHub 数据仓库”，不是“用户本机上的仓库路径”。

当前实现把三件不同的事情合并成了一个 `dataRepoPath`：

```text
目标 GitHub 仓库
    ≈ 本地 clone 路径
    ≈ Git remote origin
```

重设计后的最终模型：

```text
UI 配置 GitHub upstream
        ↓
daemon 验证账号、权限与 direct/fork 路径
        ↓
daemon 在应用自有目录管理 Git 工作区
        ↓
统一 preview / submit
        ↓
push 到 upstream 或用户 fork
        ↓
向 upstream 创建 PR
```

本次直接破坏性替换：

- 删除 `--data-repo` 和 `dataRepoPath`。
- 不提供弃用警告或旧 clone 导入。
- 不实现 `LegacyCloneWorkspaceAdapter`。
- 不保留旧 publish HTTP 路由。
- 不同时维护新旧 `PublishPreflight`。
- single 与 batch 不再拥有两套发布接口和 Git 操作。

## 2. 设计目标

### 2.1 产品目标

- 设置页配置并展示真实 GitHub 目标，如 `mosga/community-data`。
- 普通贡献者没有 upstream 写权限时，自动解析为 fork PR 流程。
- 用户不需要理解 clone、remote、dirty tree、branch residue 或本机路径。
- PR 预览明确展示数据最终进入哪里、分支推到哪里、是否创建 fork。
- 发布成功返回真实 PR URL 和可审计回执。

### 2.2 安全目标

- HTTP 永不接受任意本机路径、clone URL、remote 名称或 push URL。
- 强制人工 gate 与 exact-byte publication precheck 保持不变。
- preview 必须绑定目标 revision 和内容 digest，防止预览后更换目标或内容。
- preview 不产生 GitHub 写操作；fork、push、PR 只能在明确 submit 后发生。
- HTTP 不返回本机绝对路径、凭据、原始 stderr 或原始敏感命中。
- 同一 submit 重试幂等，不得重复创建 PR。

### 2.3 架构目标

- 对 UI、daemon HTTP 路由和测试暴露一个深的 `GitHubPublication` Module。
- 将内容生成与 GitHub 交付分开：
  - publisher 负责生成通过预检的 contribution bundle；
  - publication Module 负责目标、fork、工作区、push、PR 和回执。
- single 与 batch 统一为 `reviewIds`，N=1 只是 N 条发布的一个特例。
- 第一版用托管 Git/gh 实现；未来可替换为 GitHub Git Data API Adapter，不改变产品接口。

## 3. 非目标

- 首版不支持多个活动 GitHub 目标。
- 首版不抽象 GitLab、Gitea 或任意代码托管平台。
- 首版不允许 UI 指定 GitHub Enterprise host。
- 不允许用户选择自定义本地工作区。
- 不保留“把 daemon 内部 clone 交给用户手动接管”的 UI。
- 不在此次设计中决定最终官方仓库名和数据许可证，但二者是出口①真实上线的前置决策。

## 4. 外部 Module Interface

```ts
interface GitHubPublication {
  inspect(): Promise<PublicationStatus>;

  configure(input: {
    upstream: string | null;
  }): Promise<PublicationStatus>;

  preview(input: {
    reviewIds: string[];
  }): Promise<PublicationPreview>;

  submit(input: {
    previewId: string;
    confirmPublic: true;
  }): Promise<PublicationReceipt>;
}
```

调用者只需要知道四项行为：

- `inspect`：读取当前目标与发布就绪状态。
- `configure`：设置或清除一个活动 upstream。
- `preview`：执行 gate、导出、exact-byte precheck，并生成 UI-safe PR 预览。
- `submit`：使用 sealed preview 执行工作区、commit、fork、push 和 PR。

调用者不应知道：

- daemon 工作区路径；
- Git remote 名称；
- clone/fetch/worktree 实现；
- `git` / `gh` 命令序列；
- fork 的探测和创建细节；
- publication journal、恢复和清理方式。

## 5. 目标模型

### 5.1 持久化输入

只保存用户选择的 canonical upstream：

```ts
interface StoredTarget {
  schemaVersion: 1;
  revision: number;
  upstream: {
    owner: string;
    repo: string;
  };
}
```

默认保存位置：

```text
~/.mosga/publication-target.json
```

即使项目当前不需要迁移，`schemaVersion` 仍保留，供未来演进。

### 5.2 解析后的目标

```ts
interface ResolvedTarget {
  upstream: {
    repositoryId: string;
    slug: string;
    url: string;
    defaultBranch: string;
    visibility: 'public' | 'private';
  };

  push:
    | {
        mode: 'direct';
        slug: string;
      }
    | {
        mode: 'fork';
        slug: string;
        provision: 'existing' | 'on-submit';
      }
    | {
        mode: 'unresolved';
      };

  actor?: string;
  targetRevision: number;
}
```

语义必须明确：

```text
upstream = PR 最终进入的 canonical 数据仓库
push     = 贡献分支实际推送到的仓库
```

自动解析规则：

1. 当前 GitHub 用户对 upstream 有写权限：`direct`。
2. 无写权限但已有合法 fork：`fork / existing`。
3. 无写权限且允许 fork：`fork / on-submit`。
4. 无法 direct 或 fork：发布阻断。

default branch 由 GitHub 仓库元数据解析，不由 UI 默认猜测 `main`。

## 6. 状态模型

替换当前由 UI 根据五个布尔值自行推导状态的方式：

```ts
type PublicationStatus =
  | {
      state: 'unconfigured';
    }
  | {
      state: 'login_required';
      target: TargetSummary;
    }
  | {
      state: 'fork_confirmation_required';
      target: TargetSummary;
      actor: string;
    }
  | {
      state: 'ready';
      target: TargetSummary;
      actor: string;
      route: 'direct' | 'fork';
      pushRepository: string;
    }
  | {
      state: 'blocked';
      target?: TargetSummary;
      issues: PublicationIssue[];
    };
```

UI 不再自行组合：

```ts
dataRepoConfigured
gitAvailable
ghAvailable
ghAuthenticated
repoClean
```

工作区属于 daemon；dirty、错误 remote 和残留分支应由 Module 隔离、恢复或重建，不应成为普通用户需要解决的设置状态。

## 7. Preview 契约

```ts
interface PublicationPreview {
  previewId: string;
  expiresAt: string;

  target: {
    repositoryId: string;
    revision: number;
    upstream: string;
    pushRepository: string;
    mode: 'direct' | 'fork';
    baseBranch: string;
    willCreateFork: boolean;
  };

  contribution: {
    branch: string;
    prTitle: string;
    prBody: string;
    recordCount: number;
    totalBytes: number;
    contentDigest: string;
    files: Array<{
      path: string;
      bytes: number;
      contentHash: string;
    }>;
    engine: Record<string, unknown>;
  };
}
```

Preview 不返回：

- contribution 原始记录字节；
- 本地绝对路径；
- daemon 内部 workspace；
- `git` / `gh` 手动命令；
- raw command stderr；
- secret match 原始值。

### 7.1 Preview 顺序

1. 校验、去重 `reviewIds`，保留 1–500 上限。
2. 从 `ReviewStore` 获取 review。
3. 应用 disposition 并检查 gate unlocked。
4. 生成将要发布的 exact bytes。
5. 对 exact bytes 执行 mandatory publication precheck。
6. 只读验证目标、账号、权限和 direct/fork 路径。
7. 生成 PR title/body、文件清单、内容哈希。
8. 保存 sealed preview，并返回 UI-safe 数据。

Preview 阶段不得：

- clone 或修改 Git 工作区；
- 创建 fork；
- push branch；
- 创建 GitHub PR；
- 在 GitHub 创建任何远端对象。

## 8. Submit 契约

```ts
interface PublicationReceipt {
  previewId: string;
  upstream: string;
  pushRepository: string;
  mode: 'direct' | 'fork';
  baseBranch: string;
  branch: string;
  commitSha: string;
  prNumber: number;
  prUrl: string;
  recordCount: number;
  contentDigest: string;
  submittedAt: string;
}
```

### 8.1 Submit 顺序

1. 获取 publication single-flight lock。
2. 查询同一 `previewId` 是否已有 receipt；已有则幂等返回。
3. 校验 preview 存在且未过期。
4. 校验 target revision 未变化。
5. 重新检查 review、gate 与内容 digest。
6. 对 sealed exact bytes 再执行最终 publication precheck。
7. 创建或同步 daemon 托管工作区。
8. 从 upstream 默认分支创建内容绑定分支。
9. 写入 exact planned bytes，并在 `git add` 前核对文件 hash。
10. 创建 commit。
11. 如果需要 fork，此时才创建并等待 fork 可用。
12. 明确 push 到 push repository。
13. 明确向 upstream 创建 PR。
14. 原子保存 receipt。
15. 清理成功 publication 的临时 worktree。

### 8.2 分支与幂等

分支名应绑定内容：

```text
contrib/<alias>/<session-or-batch>-<contentHash8>
```

同一 preview 重试时：

- 已有 receipt：直接返回同一 receipt。
- 已 push、PR 未创建：查找该 head branch 的现有 PR，再创建或恢复。
- 同名分支对应相同 digest：恢复现有 publication。
- 同名分支对应不同 digest：返回 `branch_conflict`。

## 9. 托管工作区

推荐目录：

```text
~/.mosga/publish/
  target.json
  receipts/
  journal/
  cache/<repository-id-hash>.git
  worktrees/<preview-id>/
```

推荐 Implementation：

- 每个 GitHub target 一个 bare cache。
- 每个 publication 一个独立 worktree。
- remote 语义固定为：

  ```text
  upstream = canonical PR 目标
  push     = upstream 或用户 fork
  ```

- 从 `upstream/<defaultBranch>` 创建 contribution branch。
- `git add` 使用 `--` 分隔文件参数。
- 所有子进程通过参数数组和 `shell: false` 执行。
- daemon 只能删除带有自身 marker、且 resolved path 位于受控 root 内的工作区。
- 成功后清理 worktree，保留 receipt 和必要 journal。
- retryable failure 可保留 worktree 供恢复，但不向 UI 暴露路径。

如果测试需要改变工作区根目录，使用注入的 `AppOptions.workspaceRoot`；首版不必提供正式 CLI 参数。

## 10. GitHub Adapter

GitHub 是 true external dependency，使用语义级 Interface：

```ts
interface GitHubPort {
  inspectActor(): Promise<GitHubActor>;
  inspectRepository(slug: string): Promise<GitHubRepository>;
  resolvePushRoute(upstream: GitHubRepository): Promise<PushRoute>;
  ensureFork(route: PushRoute): Promise<GitHubRepository>;
  findPullRequest(input: PullRequestIdentity): Promise<PullRequest | null>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
}
```

第一版生产 Adapter 可继续使用 `gh` CLI：

- `gh repo view` / `gh api`：用户、仓库、权限和 fork 检查。
- `gh repo fork`：在 submit 阶段创建 fork。
- `gh pr create`：创建 PR。

创建 PR 时必须显式传递：

```text
--repo <upstream-owner/upstream-repo>
--base <default-branch>
--head <push-owner>:<branch>
```

不能再根据当前工作目录和 `origin` 猜测 PR 目标。

测试使用 `MockGitHubAdapter`，表达 direct、fork、权限、fork propagation、网络失败、已有 PR 和 PR 冲突。

未来可以增加 `GitHubApiDeliveryAdapter`，通过 GitHub Git Data API 直接创建 blob、tree、commit、branch 和 PR。外部 `GitHubPublication` Interface 不变。

## 11. HTTP 设计

### 11.1 状态

```http
GET /api/publish
```

返回 `PublicationStatus`。

### 11.2 设置目标

```http
PUT /api/publish/target
Content-Type: application/json

{
  "repository": "mosga/community-data"
}
```

只接受规范化后的 `owner/repo` 或可无歧义转换为该形式的 `https://github.com/owner/repo`。

### 11.3 清除目标

```http
DELETE /api/publish/target
```

清除本地配置和未提交 preview，不删除远端 fork、branch 或 PR。

### 11.4 预览

```http
POST /api/publish/preview
Content-Type: application/json

{
  "reviewIds": ["review-1", "review-2"]
}
```

### 11.5 发布

```http
POST /api/publish/submit
Content-Type: application/json

{
  "previewId": "preview_xxx",
  "confirmPublic": true
}
```

HTTP 请求永远不能提交：

- `workspacePath`
- `cwd`
- clone URL
- remote 名称
- push URL
- base/head branch
- fork repository
- GitHub token

## 12. UI 设计

### 12.1 设置页

将“数据仓库（出口①，只读）”替换为“GitHub 发布目标”。

展示：

- 目标仓库；
- 官方目标 / 自定义目标标识；
- GitHub 当前账号；
- 默认分支；
- direct / fork 贡献方式；
- push repository；
- 数据集兼容性与许可证；
- 就绪状态和阻断原因。

操作：

- 输入 `owner/repo`；
- 验证并连接；
- 重新检测；
- 清除目标。

首版只有一个活动目标，不提供多目标列表或发布时目标选择器。

### 12.2 出口①卡片

卡片明确展示：

```text
贡献到 mosga/community-data
将通过 @sayo 的 fork 创建 PR
```

状态文案由 daemon 的 discriminated status 驱动，不再由 UI 拼接五个布尔值。

### 12.3 发布向导

视觉上保留三步：

```text
① 安全预检
② PR 预览
③ 确认并创建 PR
```

后端只有 `preview → submit`，不再暴露单独 `stage`。

预览中必须展示：

- upstream；
- push repository；
- direct/fork；
- 是否创建 fork；
- base/head；
- 文件路径、字节数和 content hash；
- PR title/body；
- 公开发布确认。

如果 GitHub 发布能力不可用，保留现有“仅导出脱敏文件”，不展示 daemon 内部 clone 或命令。

### 12.4 回执

展示：

- PR URL 和编号；
- upstream；
- push repository；
- branch；
- commit SHA；
- record count；
- content digest；
- submittedAt。

## 13. 目标仓库兼容清单

目标仓库需要版本化清单：

```text
.mosga-dataset.json
```

建议内容：

```json
{
  "kind": "mosga-community-data",
  "contractVersion": 1,
  "acceptedSchemaVersions": ["0.1.0"],
  "license": "CC-BY-4.0"
}
```

连接目标时检查：

- repository 存在；
- 出口①要求 public；
- 清单存在且 `kind` 正确；
- contract version 受支持；
- 当前 record schema 可接受；
- license 不是 `TBD`；
- default branch 存在；
- 当前账号可以 direct 或 fork。

模板 `templates/community-data-repo/` 需要新增此文件，并让 CI 验证清单与记录 schema。

## 14. 安全约束

### 14.1 远程目标输入

- 首版仅允许 `github.com`。
- 拒绝 `file://`、SSH、任意 host、带凭据 URL、query 和 fragment。
- owner/repo 使用严格字符集和长度限制。
- remote URL 由 daemon 根据 normalized slug 生成。
- GitHub Enterprise 必须等有真实需求后，通过受信任 daemon host allowlist 单独设计。

### 14.2 本地文件系统

- workspace root 不经 HTTP 配置。
- target path 使用 repository ID hash 派生，不直接拼接 owner/repo。
- 每次写入检查最终路径位于 managed root。
- 写 repo-relative 文件时执行 root containment 和 symlink/junction 检查。
- 不在用户提供的路径执行清理、reset 或删除。

### 14.3 HTTP

- 修改型接口仅接受 `application/json`。
- 保留 loopback bind 和严格 Host allowlist。
- 拒绝 `Sec-Fetch-Site: cross-site`。
- 请求携带 `Origin` 时必须匹配当前 daemon origin。
- 不发送跨域允许头。

### 14.4 数据与日志

- precheck refusal 只返回 rule-aggregated count。
- GitHub token 由 gh credential store 管理，不进入 JSON 配置。
- HTTP 不返回 workspace、原始命令日志或可能含路径的 stderr。
- receipt 不包含 record 原始字节。

## 15. 错误模型

```ts
interface PublicationError {
  code: string;
  phase: 'target' | 'preview' | 'workspace' | 'push' | 'pull_request';
  message: string;
  retryable: boolean;
  recovery?: string;
}
```

稳定错误码：

```text
invalid_target
target_not_configured
target_not_found
target_incompatible
target_changed
github_client_missing
github_login_required
github_unavailable
permission_denied
fork_confirmation_required
fork_failed
review_not_found
GATE_LOCKED
precheck_refused
preview_not_found
preview_expired
preview_stale
publish_in_flight
workspace_unavailable
workspace_corrupt
branch_conflict
push_rejected
pr_create_failed
```

错误响应不得包含 GitHub token、本机绝对路径、raw matched value 或未经清理的外部错误文本。

## 16. 代码改动

### 16.1 `packages/publisher`

重构 `src/pr.ts`：

- 将 pure planning options 与 workspace options 分离。
- plan 不再接收 `targetRepo`。
- plan 不再探测 `ghAvailable`。
- plan 不再生成依赖本机路径或 `origin` 的手动命令。
- 移出 `stageContribution*`、`submitContribution*` 和 `writeRepoFile`。

重构 `src/batch.ts`：

- 只负责 N-record contribution bundle。
- 与 single 共用同一个 bundle compiler。
- 删除重复的 write/commit/push/PR Implementation。

新增：

```text
src/publication.ts
src/target.ts
src/github.ts
src/workspace.ts
src/journal.ts
```

`src/runner.ts` 保留为内部 local-substitutable seam，不再让 daemon 拼接 Git/gh 语义。

### 16.2 `packages/daemon`

`src/app.ts`：

- 删除 `AppOptions.dataRepoPath`。
- 注入 `GitHubPublication` 或其内部依赖。
- 增加 target store、workspace root 和 GitHub Adapter 测试注入点。

`src/cli.ts`：

- 删除 `--data-repo` 解析、帮助文案和启动传递。

`src/publish.ts`：

- 缩成 HTTP Adapter。
- reviewId → stamped sessions。
- Zod 请求校验。
- 调用 `GitHubPublication`。
- 将领域错误映射为 HTTP。
- 删除本地路径检查、origin 推导、branch 探测、`stageState` 和旧 mutex。
- 删除旧 single/batch plan-stage-submit 路由。

新增：

```text
src/publicationTargetStore.ts
```

提供 file-backed 和 in-memory 两个 Adapter，原子写入目标配置。

`src/http.ts`：

- 增加修改型接口的 JSON 和 same-origin guard。

### 16.3 `packages/ui`

`src/api/types.ts`：

- 删除旧 `PublishPreflight` 五布尔模型。
- 新增 `PublicationStatus`、`PublicationPreview`、`PublicationReceipt`。

`src/api/client.ts`：

- 删除旧 single/batch plan-stage-submit 方法。
- 新增 inspect/configure/clear/preview/submit。

`src/lib/usePreflight.ts`：

- 替换为 `usePublication.ts`。
- 直接消费 daemon 状态，不再在 UI 推导状态。

`src/components/SettingsPage.tsx`：

- 用 GitHub 目标编辑和状态替换只读 data-repo 区块。

`src/components/journey/PublishWizard.tsx`：

- 接受 `reviewIds`。
- 统一 single/batch。
- 只执行 preview → submit。
- 删除本地 stage、绝对路径和手动命令 UI。

`src/components/journey/BatchPublishWizard.tsx`：

- 删除，或仅保留为通用 `PublishWizard` 的薄包装。

`ExitCards.tsx` / `BatchExitCards.tsx`：

- 使用统一 PublicationStatus 和 wizard。
- 展示 upstream 与 fork 路径。

### 16.4 模板和文档

- 新增 `templates/community-data-repo/.mosga-dataset.json`。
- 更新模板 README 和 CI 检查。
- 删除根 README、daemon README 中所有 `--data-repo` 指引。
- 文档统一使用“GitHub 发布目标”“upstream”“push repository”，不再把本地 clone 称为数据仓库配置。

## 17. 实施切片

### Slice 1：Pure contribution bundle

- 重构 publisher。
- 分离内容生成与 Git/workspace。
- 合并 single/batch。
- 保持 exact-byte precheck 与 PR 内容字节契约。

### Slice 2：GitHub Publication Module

- 实现单活动 target store。
- 实现 GitHubPort 和 gh Adapter。
- 实现 direct/fork 解析。
- 实现 managed cache/worktree。
- 实现 sealed preview、target revision、content digest、journal 和幂等 receipt。
- 实现新 daemon HTTP 路由。

### Slice 3：UI 与旧实现删除

- 实现 GitHub 目标设置页。
- 替换 preflight 状态模型。
- 统一 single/batch wizard。
- 实现真实 PR receipt。
- 删除 `--data-repo`、旧路由、旧类型、旧组件、旧测试和旧文档。

三个切片严格串行，不保留可运行的新旧双栈作为最终状态。

## 18. 验证策略

### 18.1 Publisher

- N=1 与 batch 的 record bytes 保持确定性。
- mandatory precheck 对最终 exact bytes 生效。
- precheck refusal 时不产生任何 workspace 或 GitHub 写调用。
- PR title/body、content hash、record paths 正确。

### 18.2 Publication Module

- direct publish。
- existing fork publish。
- submit 时创建 fork。
- fork 不属于目标 upstream 时拒绝。
- target revision 变化使旧 preview 失效。
- review/disposition 内容变化使旧 preview 失效。
- submit 幂等。
- push 成功、PR 失败后的恢复。
- remote branch collision 与已有 PR 恢复。
- daemon 重启后 staged/pushed publication 恢复。
- managed path containment 和 symlink/junction 防护。
- HTTP-safe error redaction。

### 18.3 Daemon

- target configure/clear/status。
- single/batch 统一 `reviewIds`。
- gate locked。
- unknown review。
- precheck refusal 只返回聚合计数。
- cross-site 和非 JSON 修改请求被拒绝。
- 所有响应均不包含本机路径、凭据或 raw stderr。

### 18.4 UI

- 未配置。
- GitHub 未登录。
- fork confirmation required。
- ready/direct。
- ready/fork。
- target incompatible。
- preview target/upstream/push 信息。
- target changed 后要求重新 preview。
- submit loading、retryable failure 和成功 receipt。
- N=1 与 batch 使用同一个 wizard。

GitHub 测试使用 mock Adapter；Git/fs 使用临时目录和临时 Git 仓库。自动测试不得向真实外部仓库创建 fork、branch 或 PR。

## 19. 验收标准

- 代码库中不再存在 `dataRepoPath`、`dataRepoConfigured` 或 `--data-repo`。
- UI 可以设置、清除并验证一个 GitHub upstream。
- UI 不接受或展示本机工作区路径。
- direct 与 fork 都使用显式 upstream/base/head。
- single 与 batch 共用同一个 publication Interface 和 wizard。
- preview 无外部写副作用。
- submit 使用与 preview 绑定的目标 revision 和 exact-byte digest。
- mandatory publication precheck 仍是 push 前不可绕过的最后防线。
- 同一 preview 重试不会创建重复 PR。
- 成功结果包含真实 PR URL、PR 编号和 commit SHA。
- 所有测试不触碰真实 GitHub 写操作。

## 20. 上线前仍需决策

以下事项不阻塞代码重构，但阻塞出口①真实上线：

1. 官方 GitHub data repository 的 owner/repo。
2. 数据集许可证。
3. `.mosga-dataset.json` 的最终 contract version 与 accepted schema。
4. 首版 GitHub 登录是否只支持既有 `gh auth`，还是同时实现原生 OAuth。
