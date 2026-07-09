# Ship log — mosga-v04-batch-exits-ui

- 实现：implementer-v04-s1（warm 复用），纯 packages/ui，零 daemon/publisher 改动，零新依赖。
- 评审：reviewer-v04-s1，verdict CLEAN（11 场景全对应；N=1 冻结契约未动——PublishWizard/SubmitPanel/ExitCards 的 git diff 为空；安全轴：每条 consent 逐条断言绑各自 contentHash、下载仅走 export ok 分支、blockingBySession 无原值、跳回已签会话改处置过作废守卫）。
- 评审 Minor 处理：M1 spec 措辞对齐（lead）；M2 运行期禁用 target select + M3 跳转后守卫组合断言（implementer，ship 前补齐）；M4 informational（jsdom 下载告警，真实浏览器正常）。
- **历史归属备注**：api/types.ts + api/client.ts 的批量 client 表面（PublishBatch* 类型 + 3 个方法）本属本切片，被并行会话 ship 提交 e2358b2（settings-provider-management）从共享工作树意外卷入先行落地。内容评审核对正确、测试全绿，不重写历史；本切片提交含其余全部产物（组件/测试/ReviewView 接线/删除过渡组件）。
- 验证：全仓 343 passed / 1 skipped / 0 failed（含并行会话套件）；typecheck/build 绿；strict valid。
- 顺路收口：切片 1 的 M3 测试缺口（导出 409/失败分支）由 BatchExitCards.test 覆盖。
