# Make-OpenSource-Great-Again

> 「我们希望更多人，哪怕一个小 app 都可以低成本去用上大模型，而不是技术只掌握在一部分人和公司手中，形成垄断。」
> —— 梁文锋（DeepSeek），《暗涌》访谈

**A privacy-first pipeline that lets anyone donate their real AI-coding session data to the open-source model community.**

开源模型生态最稀缺的不是权重，而是**真实世界的人机协作开发轨迹数据**。闭源实验室通过自家产品持续获得海量真实用户与 AI 结对编程的过程数据，而开源社区几乎只能靠合成数据自举。与此同时，每个 AI 编程工具的用户本地都沉睡着大量这类数据（如 Claude Code 存于 `~/.claude/projects/` 的完整会话），却因为隐私风险没有安全的贡献通道。

本项目为"科技平权"做一点微小的贡献：**把这条通道修出来。**

## 它是什么

一个「会话脱敏导出工具 + 社区数据集」，双通道架构：

```
本地 AI 编程会话（v0.1: Claude Code JSONL）
   │  白名单式选择可公开的项目/会话
   ▼
多层自动脱敏（Gitleaks 规则集 + 自定义规则 + 结构感知化名映射）
   ▼
强制人工确认门（命中项逐项处置 / 一键批量替换 / 含图记录逐条确认）
   ▼
出口①  HuggingFace 公开数据集        出口②  API 重放直投
       （GitHub PR 投稿 → CI 复扫          （环境变量注入 base_url/key，
        → 合并 → 同步 HF，                  目标厂商用户自配置 + 官方预设，
        所有开源模型受益）                   数据仅用户与目标厂商可见）
```

- **检测器不自研**：清洗层复用 Gitleaks 规则集等成熟引擎；本项目的独特价值是**懂 agent 会话结构的管道 + 人工审查体验 + 统一导出 schema**。
- **脱敏是命门**：本地预检是拦截防线（不通过拒绝生成 PR），CI 是验证防线；纯自动清洗在理论上就不充分，人工确认门是默认设计而非可选项。
- **双通道尊重隐私偏好**：想让所有开源模型受益就走公开数据集；只信任特定厂商就走直投。

## 快速开始

要求：Node.js ≥ 20（npm workspaces monorepo，TypeScript）。

```bash
npm install        # 安装全部 workspace 依赖
npm run build      # 构建全部包（contracts → readers → sanitizer → ui → daemon → publisher → direct-submit）
npm test           # vitest 全量测试
npm run typecheck  # 全包类型检查
```

### 启动审查界面（浏览器）

```bash
npx mosga ui
# 常用选项：
#   -p, --port N       监听端口（默认 8899，或 $MOSGA_PORT）
#       --no-open      只启动 daemon 不开浏览器（打印 URL）
#       --data-repo P  你本地 clone 的公开数据仓库路径——出口① 发布所需；
#                      仅启动时配置、永不经 HTTP 接受；省略则出口① 显示"需配置"
```

daemon 只绑定 `127.0.0.1`、无鉴权（v0.x 威胁模型：单机单用户），自托管界面在 `http://127.0.0.1:8899/ui/`。四步旅程：①选择会话 → ②处置命中 → ③签署确认 → ④选择出口（HuggingFace 数据集 PR / API 直投）。另有面向脚本场景的 `npx mosga-publish`（出口① 命令行）与 `npx mosga-submit`（出口② 命令行）。

### 桌面壳（Tauri v2，可选）

```bash
npm run build:shell            # 产出桌面安装包（需要 Rust 工具链）
# 或开发模式：
cd apps/desktop && npm run dev # 自动构建 daemon 并以 adopt-or-spawn 模式启动
```

## 项目状态

✅ **v0.3 已完成**（2026-07）。设计文档（均经多轮对抗性评审）：
[数据贡献管道](rasen/office-hours/agent-session-data-contribution.md) ·
[前端重设计](rasen/office-hours/frontend-ui-redesign.md)。

### 路线图

- ~~**v0.1** — TypeScript monorepo + Claude Code adapter + 三层脱敏 + 人工确认门（daemon + React 审查 UI）~~ ✅
- ~~**v0.2** — 出口②：API 重放直投（复用 omnicross provider 生态，用户自备 key）+ Tauri 桌面壳~~ ✅
- ~~**v0.3** — 前端重设计（omnicross/Claude 风格设计系统 + 四步旅程）+ 出口① HF 发布向导接线~~ ✅
- **v0.4** — 公开数据仓库建仓 + CI 复扫 + HF 同步跑通（真实端到端首投）
- **v1.x** — 更多采集 adapter（Codex / Cursor / Cline …）
- **v2** — 服务器收件模式，面向无 GitHub 账号的更广人群

## 已知风险（透明声明）

- **ToS 合规**：会话包含闭源模型输出，用于训练其他模型存在服务条款风险，处置策略按通道分别制定（见设计文档 Open Questions）。
- **重识别残余风险**：即使脱敏完善，写作风格/话题仍可能关联到个人；贡献流程包含知情同意。
- **泄漏应急预案**：v0.1 发布前必须就位（HF 记录删除、仓库历史处理、凭据轮换通知、公开事故记录）。

## License

[MIT](LICENSE)
