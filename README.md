# dsh-auto-compaction

<p align="center"><img src="docs/icon.png" width="120" height="120" alt="dsh-auto-compaction icon"></p>

**一个对本地模型十分友好的会话自动压缩插件，压缩时不会触发本地模型重读历史，节约大量时间，压缩触发时机，压缩会话的保存内容可由用户自定义。**

![设置 → 会话压缩](docs/settings.png)

- **无额外全量 prefill**：交接文档那一轮复用会话自己的前缀，命中 KV 缓存。
- **不打断任务**：只在 `agent/status === idle` / `turn/end` 时执行。
- **比例语义单调**：比例作用于「可用输入预算 = 窗口 − 输出预留」，再受 headroom 封顶，0–100% 全程有效。
- **历史可回滚**：走 DSH 自己的压缩事务（`surfaceOp: replace`），旧消息留在会话日志里，rewind 仍可撤回。
- **模板可编辑**：外置 Markdown 模板，每次压缩时读取，改完不用重启。
- **压缩可见**：压缩期间显示状态提示（阶段、已用时间、排队提示），完成/失败有收尾提示。
- **进度样式可选**：设置页的「压缩显示方式」可选轨道环（默认）、输入区状态条、中央进度环、顶部加载条、右上角卡片；保存后下一次压缩生效。所有浮层与完成/失败状态条都用不透明表面色，背景文字不会透上来。
- **摘要完整**：按模板校验小节；缺节先续写、再重写，仍不完整就放弃提交，不会把「（截断）」的稿子替换进历史。
- **可随时停用**：设置页顶部的「启用插件」开关关闭后，压缩立即交回 DSH 原生实现（自动阈值与 `/compact` 都是原生摘要），无需重启、不卸载插件。
- **设置页**：`设置 → 会话压缩`，滑条吸附 5%、数字框不吸附，保存即生效（边车文件）。

> English: a session auto-compaction plugin that is friendly to local models — compaction never makes the local engine re-read history, saving a lot of time; both the trigger point and the saved content of the compacted session are user-configurable.

## 组成

| 包 | 作用 | 挂载方式 |
|---|---|---|
| `dsh-auto-compaction` | 设置页与状态提示（bundle）：`设置 → 会话压缩`，读写边车配置 | profile 的 `dsh.profile.bundles` |
| `dsh-auto-compaction-engine` | 引擎：提供 `ctx.compaction`，负责触发、摘要、替换历史 | Agent 预设里的 `compaction-basic` 槽位 |

> 0.2.0 起两个包名互换：`dsh-auto-compaction` 是市场里安装/显示的 bundle 包，引擎改名为 `dsh-auto-compaction-engine`（旧版 `dsh-auto-compaction-ui` 已废弃）。

> 引擎包**绝不能**声明 `dsh.client`：那会让 DSH 把它当 profile 级插件再挂一次，导致 `ctx.compaction` 重复注册、启动失败。

## 它是怎么压缩的

1. 到阈值后**不立即动手**，等 agent 结束当前回合（`agent/status idle` 或 `turn/end`）。
2. 用会话自己的前缀（命中缓存）让模型按模板写交接文档 —— 不额外全量 prefill；缺小节或模型自己标注「截断」时，先续写、再重写。
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
     name: "dsh-auto-compaction-engine"
     config:
       thresholdRatio: 0.9
       headroomTokens: 10000
       maxTokens: 12288
       idleDelayMs: 1500
       presetId: <preset id>
   ```

2. UI：把 `dsh-auto-compaction` 加入 profile 的 `dependencies`（`link:` 或 npm）与 `dsh.profile.bundles`；它会带着引擎依赖一起安装。
3. 重启 DSH。

仓库内含 `scripts/preset-scope.mjs`，可在「原生压缩」和「插件接管」之间整块切换（写前校验 YAML、留 `.bak-scope` 备份）：

```bash
node scripts/preset-scope.mjs status  [--preset <cordis.patch.yml>] [--all-local]
node scripts/preset-scope.mjs enable   # 读取 settings.json，按勾选的预设逐一切换
node scripts/preset-scope.mjs disable  # 全部恢复原生
```

不带 `--preset/--all-local` 时，`enable` 默认读取 `~/.dsh-handoff-compaction/settings.json` 的 `scope` / `presets`：勾选的预设切到插件，其余可编辑预设恢复自身原生行；只有带 `# >>> handoff:slot` 标记的预设能被切换。

## 配置

| 位置 | 内容 |
|---|---|
| 预设行 `config` | 默认值：`thresholdRatio` / `headroomTokens` / `maxTokens` / `idleDelayMs` / `presetId` |
| `~/.dsh-handoff-compaction/settings.json` | 设置页写入的实时值（引擎每次判定读取，按 mtime 缓存） |
| `~/.dsh-handoff-compaction/template.md` | 交接模板（缺失时按内置模板生成） |
| `~/.dsh-handoff-compaction/ui.log` | 设置页 RPC 与「打开文件」诊断日志 |

设置页支持「全局生效 / 按预设生效」：保存时 UI 会自动执行 `preset-scope.mjs enable`。按预设时，勾选的预设切到插件并关闭其原生压缩，其余可编辑预设恢复自身原生行；根级 `compaction-basic` 的 `auto:false` 守卫只在至少一个预设使用插件时写入。

`enabled`（默认 `true`）是设置页顶部的开关：引擎每次判定都读取，写盘后下一次判定即生效。关闭时引擎不再挂交接文档，把 `compactIfNeeded` / `summarize` / `compactNow` 全部交回 `@deepseek-ai/dsh-compaction-basic`，即 DSH 原生压缩；设置页同时也隐藏状态提示。

## 与 DSH 原生压缩的关系

两种回到原生的方式：

- **软开关（推荐，无需重启）**：设置页关闭「启用插件」。预设行仍指向插件，但引擎把自己的自动触发、交接模板和状态边车都交回原生实现；手动 `/compact` 也走原生摘要。
- **硬切换（整行换回，需重启 DSH）**：

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
