# HANDOFF

给接手这个仓库的 agent。`README.md` 讲「怎么用」，这份讲**为什么这样做、哪些还没验、下一步做什么**。

读这一份大约 5 分钟；按最后两节动手之前，先跑一遍「验证」。

---

## 一句话

把本机 CodeBuddy CLI 通过 ACP 接成 **dsh 的模型提供方**。插件 id `dsh-codebuddy-llm`，和 `dsh-codebuddy`（子智能体形态）是两个不同的东西——那个是「主模型调用它干活」，这个是「它自己就是模型」。

本机安装方式是 `link:`：`~/.dsh/profiles/desktop/package.json` 指向 `D:/code/dsh-acp-llm`，路由写在同目录的 `cordis.patch.yml`。改完代码要 `npm run build`，然后重启 dsh。

---

## 现在的状态

| 项 | 状态 |
|---|---|
| 模型列表 / 推理等级 / 流式输出 / 图片输入 / 工具行 / 上下文统计 | 真机验证过 |
| 固定开销从 47.7k 降到 12.8k | 真机验证过，见下 |
| 会话标签页「上下文用量」（`33d2d9a`） | **未验证**，只过了类型检查和构建 |
| 平台 | 只在 Windows + dsh 桌面端验证过 |

最后一笔提交就是那个未验证的标签页，见「待办 1」。

---

## 三个决定性结论

这三条是整条链路的地基。改它们之前先读 `docs/context-slimming.md`，那里记了走错的路。

### 1. 子进程环境必须用白名单，不能用黑名单

`src/host/service/child-env.ts`。

CodeBuddy 的认证判定是**组合触发**的：宿主注入的 `CLIENT_INFO_IDE_TYPE` / `_PLATFORM` / `_PLUGIN_NAME` / `_PRODUCT_NAME` / `_USER_AGENT_EXTENSION` / `_MACHINE_ID` 六项，单独出现都没事，**同时存在**就判定「我在宿主里跑」，切到宿主集成认证、向宿主索要 token，`~/.codebuddy` 的登录态根本不读。

表现极其隐蔽：`initialize` 成功、`session/new` 成功（这两步不碰模型），一 `session/prompt` 就是 `stopReason: refusal`、正文为空，CLI 日志里只有一行 `Request failed with status code 401`。

同一个白名单还挡住了 `SERVER__PORT` / `SERVER__HOST`——宿主用它们发布自己的网关端口，漏给子进程就是**父子抢同一个端口**，`EADDRINUSE` 后进程退出，上层只看到 `initialize failed: ACP connection closed`。

要往回加变量，写进路由的 `env`（最后合并），不要改白名单。

### 2. 工具集由 CodeBuddy 的 Agent 预设决定，开关是 `allowUnopted`

dsh 那一侧的上下文面板对这条路由**不准**（原因见第 3 条），但 CodeBuddy 自己会报真账。

CodeBuddy 的 ACP 会话默认跑「标准」预设，把全部工具 schema 塞进上下文，实测 tools = 41,038 token。它的预设默认只对**声明过** `mainAgentSupport` 的宿主开放；我们的客户端没声明，被 `MainAgentGate` 判成 `unopted` 直接跳过：

```js
function isStandingMainAgentActive(policy, kind) {
  return !!policy.enabled && (kind !== "unopted" || policy.allowUnopted)
}
```

`resolveMainAgentPolicy()` 里**环境变量优先于 settings**，所以插件在自己的 `env` 里注入 `CODEBUDDY_MAIN_AGENT_ALLOW_UNOPTED=1`，只对自己的子进程开门，不影响 WorkBuddy 的 sidecar。

实测（同一句 `hi`）：

| `codebuddy.mainAgent.default` | 总 token | tools |
|---|---|---|
| `default`（标准） | 47,711 | 41,038 |
| `ptc`（Code Mode） | **12,835** | 10,915 |
| `minimal`（极简） | 9,728 | 8,329 |

**预设名只能从 `~/.codebuddy/settings.json` 的 `codebuddy.mainAgent.default` 读**，插件没有参数能指定它。`ptc` 是推荐值。

同一个结论解释了一个反直觉现象：`--tools`、`--disallowedTools`、`--agent` 在 ACP 下**全部无效**——它们改的是另一条装配路径，不是预设。别再试。

### 3. 上下文分类数据到不了前端

- CodeBuddy 在 `usage_update._meta["codebuddy.ai/usageByCategory"]` 里给分类（`systemPrompt` / `tools` / `conversation` / `mcp` / `skills`）。
- dsh 的 `TokenUsage` 只有 `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens`，**没有分类维度**，适配层只能丢。
- dsh 自己的上下文面板走 `dsh-token-meter`，按**字符估算** dsh 发出去的那部分，看不到 CodeBuddy 进程里的工具定义。
- host→client 的自定义通道（`ctx.remote.$mount()`）只接受**构建期生成**的 codec，外部插件注册不了。

所以现在分两步走：

1. `acp-adapter.ts` 的 `contextReport()` 每轮结束时在推理块里追加一行真实统计（`上下文 12.8K / 1.0M（1.3%）｜提示词 909 · 工具 11.2K …`）。
2. `conversation.view` 标签页显示**实测参考值**，不是实时数。

想升级成实时：要么等 dsh 开放 remote，要么让前端解析第 1 步那一行。后者是 hack，但可行。

---

## 文件地图

只列「改这里会牵动什么」。

| 路径 | 职责 |
|---|---|
| `src/host/service/acp-agent.ts` | 子进程生命周期、握手、会话、`session/new`、模型发现。`ensure(cwd)` 会在工作区变化时重启子进程。 |
| `src/host/service/acp-adapter.ts` | `LlmAdapter` 实现：把 dsh 的消息变成 ACP content blocks，把 ACP 更新翻译回 `StreamChunk`。`guard()` 给每个提问前阶段加超时，超时点名到阶段并重启子进程。 |
| `src/host/service/chunk-translator.ts` | ACP update → `StreamChunk` 的唯一翻译层。块索引、reasoning 分隔符都在这里。 |
| `src/host/service/child-env.ts` | 白名单环境（见结论 1）。 |
| `src/host/service/turn-trace.ts` | 每回合一行轨迹，落盘到 `$DSH_HOME/cache/dsh-codebuddy-llm/turns.jsonl`。卡住时最后一行就是卡住的位置。 |
| `src/host/config/constants.ts` | 默认路由（`defaultCodeBuddyProfile`）。`env` 里那条 `ALLOW_UNOPTED` 就在这。 |
| `src/client/components/context-view.tsx` | 会话标签页「上下文用量」。**未验证**。 |
| `src/client/components/context-usage.tsx` | 构成参考条，设置页和标签页共用。 |
| `src/client/service/agents.utils.ts` | 配置 ⇄ 草稿互转。加字段要同时改这里、`agents.types.ts`、`agent-editor-form.tsx`、schema。 |

---

## 待办

按优先级。每条都给了「怎么判断做完了」。

**1. 验证 `conversation.view` 标签页（最优先）**

注册在 `src/client/register/context-view.ts`。结构是照 dsh 自己的 `chat` view 抄的，但没在真机跑过。

判断做完：重启 dsh 后，会话顶部「对话 / 轨迹 / 上下文 / 编队」那一排多出「上下文用量」，点进去能看到窗口输入框和构成条。

没出现的话，大概率是 `conversation.view` 的 entry 缺字段（dsh 的 chat view 还传了 `store` 和 `children`）。先看 renderer 控制台有没有注册报错，再对照 app.asar 里的 `ui-chat` 注册代码补。

**2. 把参考值换成实时数据**

两条路：等 dsh 开 remote，或者前端解析 `contextReport` 那一行。做之前先确认 `conversation` store 在 client 侧怎么读——这个 API 还没摸到。

**3. `idleTimeoutMs` 从 600s 调到 120–180s**

现在一轮里 10 分钟没事件才判卡死，实际冷启动 20 秒内必出东西。默认值在 `constants.ts`。

**4. 工具行补文件路径**

`▸ [edit] Edit config.json` 现在只有标题。ACP 的 `tool_call.rawInput` 里有路径，可以拼进去。

---

## 验证

```bash
npm test              # vitest，73 项
npx tsc --noEmit
npm run build
```

真机：

```bash
# 回合轨迹：卡住时最后一行就是卡住的位置
cat ~/.dsh/cache/dsh-codebuddy-llm/turns.jsonl

# 配置缓存在同目录：context-windows.json / prompt-capabilities.json
```

用真实 CodeBuddy 跑一轮的最小脚本（临时文件，用完删）：构造 `AcpAgentProcess`，`newSession(cwd)` + `prompt([{type:'text',text:'hi'}])`，从 `onUpdate` 里取 `usage_update._meta`。注意 `profile` 要传 `defaultCodeBuddyProfile()`，否则拿不到 `ALLOW_UNOPTED`。

---

## 踩过的坑

- `--port` 是 HTTP server 端口，传了会切到 `serve` 分支，和 stdio ACP 不兼容，进程静默退出。
- `dsh.cmd` 路径含空格会被 bash 拆开；用 `ELECTRON_RUN_AS_NODE=1 "…/DeepSeek Harness.exe" --expose-internals "…/cli.js"`。
- `dsh --profile desktop --dump-config` 会报 `managed exclusively by the Electron application`，没法用 CLI 验证桌面 profile。
- vitest 默认会往真实缓存写假路由；`vitest.config.ts` 里必须隔离 `DSH_HOME`。
- `.git-msg.txt` 这类临时文件会被 `git add -A` 带走，已经写进 `.gitignore`。
- 沙箱会拦 `reg.exe` 和 `CodeBuddyExtension\...\auth`，导致 CLI 报 `requires authentication`。跑真机验证需要完全访问权限。
- `usage_update` 的 `_meta` 不在 ACP 类型里，读它用 `Reflect.get(update, '_meta')`。

---

## 文档索引

- `README.md` —— 用法、配置表、已知限制。**改行为时同步更新它**。
- `docs/context-slimming.md` —— 上下文瘦身的完整调研。第 9 节记了所有走错的路（`--tools`、`REPL_TOOLS_INJECT_*`、agent 模式），第 10 节是正确答案。**别再重试第 9 节里的任何开关。**
