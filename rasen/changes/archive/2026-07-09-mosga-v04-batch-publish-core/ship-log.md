# Ship log — mosga-v04-batch-publish-core

- 实现：implementer-v04-s1（warm 复用），纯后端 publisher + daemon，零 UI 改动，零新增 real-git 测试。
- 评审：reviewer-v04-s1，verdict CLEAN（13 场景全对应；单会话零回归——pr.test/template.test/publish.test 未改动全绿，pr.ts 仅 2 个 export 关键字；安全轴守住：422 只出规则聚合计数、uiSafeBatchPlan 无 record 字节/路径字面值、逐 review gate 无跳过、互斥双向有测试）。
- 偏离裁定（4 处全接受）：重复/alias 检查前移；batch PR body 段落手工镜像（保单会话 body 逐字节不变）；submit 复制函数体；N=1 refusal 统一包成 BatchPublishRefusedError。
- 评审 Minor：M1（批量路由错误分支测试）+ M2（镜像维护注释）ship 前已补齐；M3/M4 informational（UI 不可达）记录不处理。
- 验证：publisher+daemon 154 passed / 1 skipped（pr.test real-git 用例按既有行为跳过）/ 0 failed；typecheck/build 绿；rasen validate --strict 通过。
- 切片 3 注意（实现者发现）：ExportError（未 stamp）不参与 refusal 聚合、会即刻抛——正常流程不可达（gate 全签才能到 ④），但批量 UI 错误面若要「逐会话跳过」需区分两类。
- Ship 按路径限定：publisher {batch.ts,pr.ts,index.ts,__tests__/batch.test.ts} + daemon {publish.ts,__tests__/publish-batch.test.ts} + 本变更目录；不含并行会话 settings-provider-management 的 daemon/ui/direct-submit 改动。
