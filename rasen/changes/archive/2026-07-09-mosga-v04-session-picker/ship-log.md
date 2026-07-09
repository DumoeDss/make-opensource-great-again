# Ship log — mosga-v04-session-picker

- 实现：implementer-v04-s1（后台 worker），纯 packages/ui，零新依赖。
- 评审：reviewer-v04-s1，初判 FIX_REQUIRED（Major-1 spec 措辞与实现相反 + M1 队列切换状态泄漏）；lead 修复后 CLEAN。
- 偏离裁定：Stepper 传 allSigned（接受）、ConfirmDialog 可选 testid prop（接受）、clear 清空全集（接受，spec 正文已对齐）。
- 实现中发现并修复的真实 bug：runMutation 曾用闭包旧值回写签署态，可能复活刚作废的签名；改为函数式更新读最新态，仅在 gate 重锁时清签名。
- 验证：packages/ui 44/44 全绿；typecheck/build 全绿；rasen validate --strict 通过。全量套件中 direct-submit 1 失败属并行会话未提交改动，与本切片无关。
- Accepted-known（转 humanFollowUps）：M2 已签项切回时无「已签署」显式提示（QueueBar chip 承载）；M3 title-hover 与 BatchExitSummary 下载/409 分支无断言；M4 N=1 touched 后 restart 弹确认（Open Q2 有意行为）；M5 过渡态 .jsonl 文件名（切片 3 替换）。
- Ship 提交按路径限定：packages/ui/** + rasen/changes/mosga-v04{,-session-picker}/** + rasen/office-hours/session-picker-batch-journey.md，不含并行会话的 direct-submit/daemon-secrets/config.yaml 改动。
