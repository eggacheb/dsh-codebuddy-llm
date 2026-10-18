# CodeBuddy / Claude Code：ACP 下 40k 工具定义能不能裁剪

调研 2026-10-18。**【一手】**=官方文档/协议规范/源码；**【二手】**=博客、issue 讨论；**【未找到】**=无公开资料。

**结论先行**：ACP 协议层**没有**任何「客户端限制 agent 工具集」的能力（一手确认，不是配置没找对）。口子全在 agent 自己身上：CodeBuddy 已内建完整的工具延迟加载体系（`Defer()` / `ToolSearch` / `DeferExecuteTool` / REPL 渐进披露），但 `--tools` 通道在 ACP 会话里**没接线**。第一优先级不是改协议，而是把 CodeBuddy 自己的 defer/REPL 开关用环境变量打进去。

## 0. 已有实测基线

token 取自 CLI 在 ACP `usage_update` 自报的 `codebuddy.ai/usageByCategory`（本机 `@tencent-ai/codebuddy-code` 2.168.2）：

| 尝试 | 总上下文 | tools | 冷启动 |
|---|---|---|---|
| 基线（ptc + 15 插件） | 47,730 | 41,040 | 21s |
| `--tools ""` | 47,730 | 41,040 | 19s |
| `--disallowedTools` 六个 | 47,730 | 41,040 | 15s |
| `--agent minimal` | 47,261 | 40,637 | 15s |
| `mainAgent.default = minimal` | 47,730 | 41,040 | 22s |
| `--strict-mcp-config --mcp-config '{}'` | 47,730 | 41,094 | 16s |
| 关掉全部 15 个插件 | 47,730 | 42,035 | **11s** |
| `-p` 路径（对照） | 12,850 | ~6k | 6s |
| `-p` + `--tools ""` | **6,984** | 0 | 6s |

两个新推断：`--agent minimal` 只掉 403 token，说明 agent 的 tools 白名单**部分**生效（少了一两个），大头没动；`--strict-mcp-config` 让 tools 反**涨** 54，说明 41k 几乎不含 MCP 工具。
## 1. ACP 规范：有没有 tool allowlist？

**结论：没有。规范里不存在任何限制 agent 可用工具的字段。**

【一手】`session/new` 入参只有 `cwd`、`mcpServers`、`additionalDirectories`（后者需 `sessionCapabilities.additionalDirectories`）。规范唯一涉及工具的话是概念性的：

> "Clients MAY use this ability to provide tools directly to the underlying language model by including their own MCP server."
> "This root set SHOULD serve as a boundary for tool operations on the file system."

【一手】`initialize` 的 agent capability 只有 `loadSession` / `promptCapabilities`（image/audio/embeddedContext）/ `mcpCapabilities`（http/sse）/ `auth` / `sessionCapabilities`；client 侧只有 `fs` / `terminal` / `elicitation`。**没有 tools 相关 capability。**

【一手】`session/set_config_option` 是唯一运行时配置入口，但语义被限死：类别只有 `mode` / `model` / `model_config` / `thought_level`，且 "Clients MUST handle missing or unknown categories gracefully" —— configOptions 是**agent 自定义**的开放列表，规范没为「工具集」留 id。客户端只能选 agent 愿意暴露的选项。

【一手】唯一逃生口是 `_meta`：

> "Object types that define a `_meta` field can use it to attach custom information... Implementations MUST NOT add any custom fields at the root of a type that's part of the specification."

即厂商私有字段**必须**塞 `_meta`，不能加在 `session/new` 顶层。

**对插件**：不可操作，这条路是死的。
## 2. `--tools` / `--allowedTools` / `--disallowedTools`

**结论：`--tools` 是「限制内置工具集」，官方文档从未说过它只在 print 模式生效；它在 ACP 下失效是 CodeBuddy 适配层的实现问题，不是 CLI 语义。**

【一手】Claude Code CLI reference（https://code.claude.com/docs/en/cli-reference）：

> `--tools`："Restrict which built-in tools Claude can use. Use `""` to disable all, `"default"` for the default set... **The flag doesn't affect MCP tools**; to deny those too, use `--disallowedTools "mcp__*"`."
> `--allowedTools`："Tools that execute without prompting for permission... To restrict which tools are available, use `--tools` instead."
> `--disallowedTools`："Deny rules. A bare tool name **removes the matching tools from Claude's context**."

同页对 `--max-turns` / `--json-schema` / `--max-budget-usd` 都明确标 "(print mode only)"，这三个工具标志**没有** —— 直接反证「仅 print 模式生效」（该说法只见于二手博客，不采信）。另："`claude --help` does not list every flag"，本次检索**未找到** `--strict-tools`、`--max-tools`、`--tool-search`、`--deferred-tools` 的任何一手记载。

【一手】CodeBuddy `--help` 同样定义 `--tools <value>`，且 `--agent` 说明明写：

> "Default main agent for this process (**TUI, --print/headless, --serve Web, ACP**)."

但实测 `--agent` 在 ACP 下几乎不掉 token（§0）——**文档与实现不一致**，可直接作为 issue 论据。

**对插件**：CLI 层不可操作。
## 3. `claude-code-acp` 怎么暴露工具

**结论：它在 ACP 上开了非标准后门 `_meta.claudeCode.options`，把整份 Claude Agent SDK `Options` 透传 —— 含 `tools`/`allowedTools`/`disallowedTools`。这是「ACP 客户端做工具裁剪」唯一被实现过的形态，但属于 adapter 自定义扩展，不是 ACP 规范。**

【一手】`zed-industries/claude-code-acp` `src/acp-agent.ts`：

```ts
export type NewSessionMeta = {
  claudeCode?: { options?: Options; emitRawSDKMessages?: boolean | SDKMessageFilter[] };
  additionalRoots?: string[];
};
const OPTION_REBUILDS_SESSION = { allowedTools: true, disallowedTools: true, tools: true,
  mcpServers: true, systemPrompt: true, settingSources: true, ... }
```

注释原文：

> "`disallowedTools` (merged with ACP's disallowedTools)"
> "`tools` (passed through; defaults to `claude_code` preset if not provided)"
> "Those parameters will be ignored and managed by ACP: cwd / includePartialMessages / permissionMode / canUseTool / executable"

`computeSessionFingerprint()` 还把 `disableBuiltInTools`、`_meta.systemPrompt` 算进会话指纹 —— 它确实把「工具集」当会话定义的一部分。注意该包已改名 `@agentclientprotocol/claude-agent-acp`，README 里**没有**这段说明，只在源码里（半公开扩展）。

**对插件**：CodeBuddy 没抄这个设计。推进方式 = 照这个形状提 PR：`session/new` 的 `_meta` 接受 `codebuddy.ai/options`，把 `tools`/`disallowedTools`/`deferToolLoading` 透传到 agent 装配处。改动小、有先例、无破坏性。
## 4. Tool Search / deferred tools / Code Mode

**结论：有两套。Claude 侧是 API 的 Tool Search Tool（`defer_loading`）；CodeBuddy 侧是 `Defer()` + `ToolSearch` + `DeferExecuteTool` + REPL 目录。这是唯一能真正把 41k 打下来的机制。**

【一手】Anthropic《Introducing advanced tool use》(2025-11)：

> "Tool Search Tool preserves 191,300 tokens of context compared to 122,800 with Claude's traditional approach."
> "Traditional approach: All tool definitions loaded upfront (~72K tokens for 50+ MCP tools)... ~77K tokens before any work begins"
> "With the Tool Search Tool: Only the Tool Search Tool loaded upfront (~500 tokens)... ~8.7K tokens, **preserving 95% of context window**... an **85% reduction**"
> "At Anthropic, we've seen tool definitions consume **134K tokens** before optimization."
> 准确率：Opus 4 49%→74%，Opus 4.5 79.5%→88.1%。触发条件 ">10K tokens" / "10+ tools"。

机制：传 `{"type":"tool_search_tool_regex_20251119"}` 搜索工具，其余标 `defer_loading: true`，搜到才展开；deferred 工具不进 prefix，**不破坏 prompt cache**。

【一手】CodeBuddy《工具延迟加载覆盖（Defer / NoDefer）》https://www.codebuddy.ai/docs/zh/cli/tool-defer-overlay：

> "`Defer(X)`：该会话/代理强制让 X 走延迟加载（不直接进入模型的工具列表，可通过 ToolSearch 发现）"
> "只要工具列表里出现了至少一条 `Defer(...)`，CodeBuddy Code 会自动把 `ToolSearch` 与 `DeferExecuteTool` 加进去"
> "`--tools "Defer(*)"` 行为等价于 `--tools "*,ToolSearch,DeferExecuteTool"` + `NoDefer(ToolSearch)` + `NoDefer(DeferExecuteTool)`"
> 可用渠道：CLI `--tools`、agent frontmatter `tools:`、"**ACP 与 SDK 客户端的 `tools` 字段与 CLI 等价**"
> 优先级：session overlay > MCP 工具级 `defer_loading` > MCP 服务器级 > `CODEBUDDY_DEFER_TOOL_LOADING` > `settings.deferToolLoading` > 产品默认

【一手：本地源码】`product.json` 内置 **64** 个工具，**20** 个默认 `deferLoading: true`（NotebookEdit、LSP、ImageGen、VideoGen、Artifact、TeamCreate、Workflow、Monitor…），余 ~44 个主动加载，正好对上 41k。

【一手：本地源码】`settings-protocol.d.ts`：`CODEBUDDY_DEFER_TOOL_LOADING` / `deferToolLoading?: boolean`（注释："是否全局启用 **MCP** 工具延迟加载"）。内置工具不看这个开关 —— `isBuiltinToolDeferLoading()` 注释明写 "The global `isGlobalDeferLoadingEnabled` switch is *not* consulted here"，且产品默认已是 `true`，所以对我们这个 41k **无效**。

**对插件**：可操作，两条：`--tools "Defer(*)"`；或自定义 agent frontmatter 写 `tools: [Defer(*)]` 再用 `--agent`/`settings.agent` 指过去。
## 5. MCP 官方：code execution 省多少

**结论：150,000 → 2,000 token（-98.7%），前提是把工具定义做成文件树、按需读取。**

【一手】Anthropic《Code execution with MCP》：

> "This reduces the token usage from **150,000 tokens to 2,000 tokens**—a time and cost saving of **98.7%**."
> 做法：每个工具生成一个文件（`./servers/google-drive/getDocument.ts`），agent 浏览文件系统按需 import，而非预加载全部定义。代价：需要沙箱、资源限制、监控。

**对插件**：即 CodeBuddy 的 `REPL`/`ptc`（Code Mode）同构实现。
## 6. 社区：有没有人踩过同一个坑

**结论：CodeBuddy 官方仓库有一条几乎一样的提问，官方给的 4 个方案全在 CLI 侧；**没有**任何「ACP 下 `--tools` 被忽略」的公开 issue。**

【一手】https://cnb.cool/codebuddy/codebuddy-code/-/issues/699 「codebuddy cli 启动后，默认的上下文高达 30 多 K，主要是 system tools，请问有没有办法优化？」官方回复节选：

> 方案一：`codebuddy --tools "Read,Edit,Bash,Glob,Grep"`，空字符串 `""` 可禁用所有内置工具
> 方案二：`Defer(...)` 延迟加载（v2.106.0+），"甚至可以直接写 `Defer(*)` …… 系统会自动附加 ToolSearch / DeferExecuteTool 防止自我封死"
> 方案三：`CODEBUDDY_ARTIFACT_ENABLED=0` / `CODEBUDDY_PUSH_NOTIFICATION_ENABLED=0` / `CODEBUDDY_REPORT_FINDINGS_ENABLED=0` / `CODEBUDDY_USE_POWERSHELL_TOOL=0`
> 方案四：`CODEBUDDY_AUTOCOMPACT_PCT_OVERRIDE=50`、`CODEBUDDY_PRE_MESSAGE_COMPACT=1`

证明官方自己承认 30k+ 是工具定义导致的，正解是 `--tools`/`Defer`；但没提 ACP，说明 ACP 场景没人报过。

【未找到】GitHub / cnb.cool 上无「claude code ACP 下 `--tools` 无效」的报障与 workaround。

**对插件**：直接拿本文实测数据去 cnb.cool 开 issue。
## 7. 请求体改写（在 CLI 与模型 API 之间拦一层）

**结论：技术可行、有成熟先例，但在我们场景是兜底方案 —— 它绕过了 CLI 的工具状态机。**

【一手：claude-code-router】两个钩子：`transformRequestIn(request, provider)` —— "用于在请求发送到目标 provider 之前修改请求体"；自定义 Agent 的 `shouldHandle(req,config)` + `reqHandler(req,config)` —— "Modifies request body before routing"，且 `req.body` 里就含 `tools`。

【二手】社区插件 `stripReasoningConflict.cjs` 直接按索引删工具：`export CCR_DROP_TOOL_INDICES="32,42"`。

风险按严重度：① 模型调用被删掉的工具 → 400 或死循环（CLI 仍认为工具可用）；② **prompt cache 全失效**（tools 是 prefix 第一段，删一个就整段 miss —— Anthropic 官方正是用 `defer_loading` 规避）；③ 要复刻鉴权 + TLS 中间人（`CODEBUDDY_*_ENDPOINT`/证书），排障成本高。

**对插件**：不建议，除非只删「明显不会被调用」的工具（ImageGen/VideoGen/Workflow/Monitor）。
## 8. CodeBuddy 官方对 ACP 的说明

**结论：ACP 文档只开放了 3 个 `_meta` 扩展点，没有 tools；但 tool-defer 文档声称「ACP 的 tools 字段与 CLI 等价」，与实测矛盾 —— 文档 bug 或未实现。**

【一手】https://www.workbuddy.ai/docs/cli/acp 列出的 ACP 能力只有：`_meta["codebuddy.ai/conversationRequestId"]`；`authenticate` 返回 `_meta["codebuddy.ai/userinfo"]`；**工具代理**（客户端声明 `fs.readTextFile`/`fs.writeTextFile`/`terminal` 后，文件与终端类工具反向代理给客户端执行）；`available_commands_update`；`getConfigOptions`/`setSessionConfigOption` 的 `context_window`（200K/1M）。

【一手：本地源码反编译】`dist/codebuddy-headless.js` 的 ACP `newSession()` 只读三个 `_meta` 键：

```js
let el = eA._meta ?? {},
    ec = !0 === el["codebuddy.ai/continue"],
    ed = !0 === el["codebuddy.ai/takeWriter"] || !0 === eA.takeWriter,
    eu = !0 === el["codebuddy.ai/followOnlyAccept"];
```

**没有 tools、没有 allowedTools、没有 agent。** 与文档「ACP 的 tools 字段与 CLI 等价」直接冲突 —— 那句话只对 **SDK** 成立。

【一手：本地源码】`repl-tool.d.ts` 里有两个 ACP 场景下**从未试过**的开关：

```
CODEBUDDY_REPL_TOOLS_INJECT_CATALOG   // 默认开；=0/false 关掉 REPL 的「骨架目录」注入
CODEBUDDY_REPL_TOOLS_INJECT_BUILTIN   // PTC/Minimal 默认开；=0/false 不把内置工具加载进 REPL
```

> "细闸 `CODEBUDDY_REPL_TOOLS_INJECT_CATALOG=0`（或 `false`）可单独关掉目录注入（**工具仍预加载，只是模型不提前知情，退化为纯渐进披露**）。默认开启。"
> "`CODEBUDDY_REPL_TOOLS_INJECT_BUILTIN` 控制**内置工具**是否加载到 REPL（PTC/Minimal 默认开，其余模式默认关；`1`/`0` 强开强关）"

若 ACP 跑在 PTC/Code Mode 下，41k 很可能**不是真实 tools 数组，而是 REPL 工具 `parameters()` 动态生成的骨架目录** —— 这能同时解释「`--tools ""` 不掉数」（tools 数组只剩 REPL，改它没用）和「`--agent minimal` 只掉 400」（目录采集不看 agent 白名单）。
## 9. 实测结论：候选开关全部无效（2026-10-18）

下面方案 1–4 已经在本机跑完了，结果是一个数都不动：

| 尝试 | 总上下文 | tools |
|---|---|---|
| 基线 | 47,730 | 41,040 |
| `CODEBUDDY_REPL_TOOLS_INJECT_CATALOG=0` | 47,730 | 41,040 |
| `CODEBUDDY_REPL_TOOLS_INJECT_BUILTIN=0` | 47,730 | 41,040 |
| 上面两个同时 =0 | 47,730 | 41,040 |
| `--tools "Defer(*)"` | 47,015 | 40,348（≈抖动） |
| `--agent minimal` | 47,261 | 40,637（≈抖动） |
| `_meta{"codebuddy.ai/agent":"minimal"}`（客户端已声明 mainAgentSupport） | 47,955 | 41,088 |

两行是关键反证：

- **切 `minimal` 后 `currentAgentName` 确实变成 `minimal`，tools 一动不动。** 而 minimal 在 TUI 里的定义是「REPL 里只有 Bash/Edit/Skill，无 Read/Write/Glob/Grep/search/plan/sub-agents/MCP」——最极端的裁剪。它都不生效，说明 ACP 的工具装配**不看 agent 的 tools 白名单**，因此方案 3（自定义 agent 写 `tools:`）同样可判定无效，不必再试。
- **`INJECT_CATALOG=0` 无效，反证了「41k 是 REPL 目录注入」的假设。** 如果它是，关掉注入必然掉数。

**结论：ACP 这条路上没有任何可用的裁剪开关。** 能选的只剩下面 5 / 7 / 8。

### 仍然可选的

| # | 方案 | 省多少 | 改动量 | 风险 |
|---|---|---|---|---|
| 5 | 走 `-p` + `--tools` | 47.7k → 7k（**已实测 -85%**） | 插件换执行协议 | 中高。失去流式、`session/cancel`、权限回调 |
| 6 | 请求体改写删 tools（CCR 式 `transformRequestIn`） | 取决于删多少 | 中（代理 + 证书） | 高。模型可能调不存在的工具、cache 全失效 |
| 7 | 给 CodeBuddy 提 PR：ACP 支持 `_meta.codebuddy.ai/options.tools` | 长期 -80%+ | 上游 | 无 |
| 8 | 上下文窗口拉到 1M | token 不变，占比 24%→4.8% | 一行配置 | 无（不省钱） |

方案 7 有现成参照：`claude-code-acp` 用 `_meta.claudeCode.options` 把 `tools` / `allowedTools` / `disallowedTools` 透传给底层，并靠 `OPTION_REBUILDS_SESSION` 在选项变化时重建会话——说明「适配层透传工具选项」是被实现过的形态，可以直接照这个给 CodeBuddy 提 PR。

## 参考

一手：ACP 规范 https://agentclientprotocol.com/protocol/v1 ；Claude Code CLI https://code.claude.com/docs/en/cli-reference ；claude-code-acp 源码 https://github.com/zed-industries/claude-code-acp ；《Advanced tool use》https://www.anthropic.com/engineering/advanced-tool-use ；《Code execution with MCP》https://www.anthropic.com/engineering/code-execution-with-mcp ；CodeBuddy Defer 文档 https://www.codebuddy.ai/docs/zh/cli/tool-defer-overlay ；CodeBuddy ACP 文档 https://www.workbuddy.ai/docs/cli/acp ；issue #699 https://cnb.cool/codebuddy/codebuddy-code/-/issues/699 ；本机 `@tencent-ai/codebuddy-code` 2.168.2 的 `product.json`、`dist-server/types/node/{tools,settings,acp,agent}/*.d.ts`、`dist/codebuddy-headless.js`。

二手：CCR transformer https://lzw.me/a/claude-code-router-custom-transformer.html ；CCR Agent 机制 https://deepwiki.com/musistudio/claude-code-router/11.3-custom-agents 。注：`ENABLE_TOOL_SEARCH` 只存在于 Claude Code（CodeBuddy 2.168.2 bundle 里 `grep` 为 0），不要照抄。
