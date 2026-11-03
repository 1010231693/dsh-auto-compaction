# dsh-auto-compaction

**给 DeepSeek Harness 的空档期「交接式」上下文压缩。** 到阈值后不立刻动手，等 agent 回合结束，让模型按你的模板写一份交接文档，然后把整段历史替换成这一条消息——下一轮只剩系统提示词 + 工具定义 + 交接文档。

- **无额外全量 prefill**：交接文档那一轮复用会话自己的前缀，命中 KV 缓存。
- **不打断任务**：只在 `agent/status === idle` / `turn/end` 时执行。
- **比例语义单调**：比例作用于「可用输入预算 = 窗口 − 输出预留」，再受 headroom 封顶，0–100% 全程有效。
- **历史可回滚**：走 DSH 自己的压缩事务（`surfaceOp: replace`），旧消息留在会话日志里，rewind 仍可撤回。
- **模板可编辑**：外置 Markdown 模板，每次压缩时读取，改完不用重启。
- **设置页**：`设置 → 会话压缩`，滑条吸附 5%、数字框不吸附，保存即生效（边车文件）。

> English: idle-time handoff compaction for DeepSeek Harness — at a configurable share of the usable input budget the plugin waits for an idle turn, writes a handoff checkpoint from the session's own cached prefix, and replaces the whole compactable surface with that single message.

## 组成

| 包 | 作用 | 挂载方式 |
|---|---|---|
| `dsh-auto-compaction` | 引擎：提供 `ctx.compaction`，负责触发、摘要、替换历史 | Agent 预设里的 `compaction-basic` 槽位 |
| `dsh-auto-compaction-ui` | 设置页：`设置 → 会话压缩`，读写边车配置 | profile 的 `dsh.profile.bundles` |

> 引擎包**绝不能**声明 `dsh.client`：那会让 DSH 把它当 profile 级插件再挂一次，导致 `ctx.compaction` 重复注册、启动失败。

## 它是怎么压缩的

1. 到阈值后**不立即动手**，等 agent 结束当前回合（`agent/status idle` 或 `turn/end`）。
2. 用会话自己的前缀（命中缓存）让模型按模板写交接文档 —— 不额外全量 prefill。
3. 通过 DSH 的压缩事务把整段历史替换成这一条消息；旧消息仍在会话日志里，rewind 可回滚。
4. 下一轮上下文只剩 系统提示词 + 工具定义 + 交接文档。

## 触发点公式

```
触发点 = min( round(预算 × 比例), 预算 − headroom )
预算   = 模型窗口 − 输出预留(maxTokens)
```

| 配置 | 预算 | headroom | 90% 触发点 |
|---|---|---|---|
| 250K 窗口 / 20K 输出预留 | 230,000 | 10,000 | **207,000** |
| 500K 窗口 / 20K 输出预留 | 480,000 | 10,000 | **432,000** |

换模型或换窗口不用改配置；比例滑到 100% 也只是到「预算 − headroom」的安全上限。

## 安装（本机 / 非 npm 开发态）

1. 引擎：把 Agent 预设 `compaction` 组里的 `compaction-basic` 行换成

   ```yaml
   - id: compaction-basic
     name: "dsh-auto-compaction"
     config:
       thresholdRatio: 0.9
       headroomTokens: 10000
       maxTokens: 8192
       idleDelayMs: 1500
       presetId: <preset id>
   ```

2. UI：把 `dsh-auto-compaction-ui` 加入 profile 的 `dependencies`（`link:` 或 npm）与 `dsh.profile.bundles`。
3. 重启 DSH。

仓库内含 `scripts/preset-scope.mjs`，可在「原生压缩」和「插件接管」之间整块切换（写前校验 YAML、留 `.bak-scope` 备份）：

```bash
node scripts/preset-scope.mjs status  [--preset <cordis.patch.yml>] [--all-local]
node scripts/preset-scope.mjs enable
node scripts/preset-scope.mjs disable
```

## 配置

| 位置 | 内容 |
|---|---|
| 预设行 `config` | 默认值：`thresholdRatio` / `headroomTokens` / `maxTokens` / `idleDelayMs` / `presetId` |
| `~/.dsh-handoff-compaction/settings.json` | 设置页写入的实时值（引擎每次判定读取，按 mtime 缓存） |
| `~/.dsh-handoff-compaction/template.md` | 交接模板（缺失时按内置模板生成） |
| `~/.dsh-handoff-compaction/ui.log` | 设置页 RPC 与「打开文件」诊断日志 |

设置页支持「全局生效 / 按预设生效」：按预设时只对勾选且挂了本插件的预设生效；未勾选的预设保持默认配置。

## 与 DSH 原生压缩的关系

一个上下文只能有一个 `ctx.compaction` 提供者，所以「关掉原生压缩」体现为预设里那一行指向谁。切回原生：

```bash
node scripts/preset-scope.mjs disable   # 恢复 @deepseek-ai/dsh-compaction-basic + auto: true
```

## 已知限制

- 只在 web/desktop profile 上验证过（`dsh` 0.2.x）。
- 交接文档是有损的：没写进文档的细节无法从上下文里找回（旧消息仍在会话日志，供人查看/rewind）。
- 客户端设置页依赖 DSH 的 `connection.rpc` 与 `settings.section` 槽位，二者属于宿主内部接口，宿主升级后可能变化。

## 开发

```bash
node test/plan.test.mjs          # 纯逻辑：阈值/重试闸
node test/integration.test.mjs   # 带假 DSH 服务的集成测试
```

## License

MIT
