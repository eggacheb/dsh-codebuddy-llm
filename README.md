# dsh-codebuddy-llm

把本机的 **CodeBuddy** 注册成 DeepSeek Harness 的**模型提供方**：在模型选择器里选中它，对话就交给 CodeBuddy 处理。

用 [ACP（Agent Client Protocol）](https://agentclientprotocol.com) 通信：插件拉起 `codebuddy --acp --acp-transport stdio` 子进程，再把 ACP 的流式事件翻译成 dsh 的 `StreamChunk`。

Fork 自 [Fleey/deepseek-harness-acp](https://github.com/Fleey/deepseek-harness-acp)（MIT，见 `LICENSE`）。上游是通用的「ACP Agent → 模型」适配器；这个 fork 把默认路由、命令发现和默认参数都对准 CodeBuddy，装完即用。

> **接手开发先读 [`HANDOFF.md`](./HANDOFF.md)**：三个决定性结论（环境白名单、Agent 预设有门禁、分类数据为什么到不了前端）、未验证项、以及别再重试的坑。

## 和 dsh-codebuddy 的区别

两个插件都驱动同一个 CodeBuddy，但**接入形态不同**，可以同时安装、各管一段：

| | `dsh-codebuddy`（子智能体版） | 本插件（模型版） |
| --- | --- | --- |
| 接入点 | `ctx.subagents.registerProvider()` | `ctx.llm.registerAdapter()` |
| 在 dsh 里长什么样 | 一个工具 `subagent_codebuddy`，由主模型决定何时调用 | 模型提供方 `codebuddy`，直接在模型选择器里选 |
| 谁在思考 | 主模型思考，CodeBuddy 只当一个被委派的执行者 | CodeBuddy 自己就是那个模型，主循环在它那边 |
| 上下文 | 每次调用带一段任务描述 | 整个对话历史按 ACP 会话续传 |
| 适合 | 让主模型保留决策权，把重活外包 | 想直接用 CodeBuddy 的模型与工具链答话 |

一句话：**子智能体是「叫个人来干活」，模型版是「换个人来当大脑」。**

## 开箱即用

装好即可用，不需要先写配置。插件会自己找：

- `node`：`%LOCALAPPDATA%\pnpm\node.exe` → `%ProgramFiles%\nodejs\node.exe` → `C:\Program Files\nodejs\node.exe`
  **刻意不回落 `process.execPath`**：在 Electron 里那是桌面端自己的 exe，拿它跑 JS 的后果是「退出码 0、stdout 为空」，且没有任何报错。
- CodeBuddy CLI：`%LOCALAPPDATA%\pnpm\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy`，以及 npm 全局的同名路径。

两者都找到时，自动挂上一条路由：

```yaml
codebuddy:
  displayName: CodeBuddy
  command: <node.exe>
  args: [<cli>, --acp, --acp-transport, stdio, --permission-mode, dontAsk, --model, deepseek-v4.1-flash]
  permission: allow
  systemPrompt: drop
  discoverModels: true
```

显式配了 `agents` 之后，默认路由自动让位。

参数与 `dsh-codebuddy` 逐字一致——同一个 CodeBuddy 在两个插件里行为不同，排查起来是没有底的。

### 为什么用 `node <cli>` 而不是 `codebuddy`

`bin/codebuddy` 是没有扩展名的 JS + shebang，Windows 上直接 `spawn` 会失败。走 `node <js>` 才可移植。

同理，spawn 只在**必须**时才开 `shell`：`.exe`/`.com` 直连，裸命令（`npx`、`claude`）和 `.cmd` 才交给 shell。Windows 上 `shell: true` 会把整条命令拼成一行给 `cmd /c` 且不加引号，`C:\Program Files\...` 会在第一个空格处被劈开。

## 工作方式

- 每个配置项是一个 provider 路由，插件按需拉起该 Agent 子进程（stdio JSON-RPC），进程常驻复用。
- 每个 dsh 会话对应一个 ACP 会话，后续轮次只发送新增的用户消息；历史对不上（切过模型、被压缩）时自动新建 ACP 会话，并把历史压平成 `<conversation_history>` 一次性带过去。
- `agent_message_chunk` 映射为正文，`agent_thought_chunk`、工具调用、计划映射为推理块；`usage` 按会话累计值做差分。工具调用渲染成 `▸ [edit] Edit config.json` 这样的行，`showToolCalls: false` 可关掉。
- 工作目录取当前 dsh 会话的 workspace，取不到时回退到 `cwd` 配置或用户主目录。
- 标题生成、压缩等辅助调用使用一次性 ACP 会话，不影响主会话。

模型的上下文窗口与推理等级来自 Agent 本身的应答（`usage_update.size` / `thought_level`），按路由缓存在 `$DSH_HOME/cache/dsh-codebuddy-llm/`，重启后首轮即可用。

## 上下文占用

一轮对话的固定开销几乎全在工具定义上。CodeBuddy 的 ACP 会话默认跑「标准」预设，把全部工具（含 MCP、子智能体、Team）的 schema 都塞进上下文——实测 **41,038 token，占 86%**。

它的 Agent 预设（标准 / PTC / 极简 / 创造）默认只对**声明过** `mainAgentSupport` 的宿主开放。我们的 ACP 客户端没声明，会被 `MainAgentGate` 判成 `unopted` 直接跳过，所以光改 `settings.json` 里的 `mainAgent.default` 也不生效——这也解释了为什么 `--tools`、`--disallowedTools`、`--agent` 在 ACP 下全都没反应：它们改的是另一条装配路径。

插件默认往子进程注入 `CODEBUDDY_MAIN_AGENT_ALLOW_UNOPTED=1`（`resolveMainAgentPolicy()` 里环境变量优先于 settings，且只影响这条路由，不动 WorkBuddy 自己的 sidecar），预设才开始生效。实测同一句 `hi`：

| `codebuddy.mainAgent.default` | 总 token | tools | systemPrompt | skills |
| --- | --- | --- | --- | --- |
| `default`（标准） | 47,711 | 41,038 | 2,806 | 1,385 |
| `ptc`（Code Mode） | **12,835** | 10,915 | 891 | 369 |
| `minimal`（极简） | **9,728** | 8,329 | 608 | 281 |

推荐 `ptc`：工具一个不少，只是收进 REPL 用代码调用，对应 Anthropic 的 [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)（官方给的实测收益是 150k → 2k token）。`minimal` 再省 3k，但没有 Read / Write / Glob / Grep / MCP，日常编码会明显别扭。

预设名只能从 CodeBuddy 自己的设置里读（Web UI 的「Agent 预设」，或直接写文件），插件没法用参数指定：

```json
// ~/.codebuddy/settings.json
{ "codebuddy": { "mainAgent": { "default": "ptc" } } }
```

不设也行——那就是标准预设的 41k，在 1M 窗口里占 4%，不影响可用性，只是白花。

## 配置

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: dsh-codebuddy-llm
  name: dsh-codebuddy-llm
  config:
    agents:
      codebuddy:
        displayName: CodeBuddy
        command: C:/Users/you/AppData/Local/pnpm/node.exe
        args:
          - C:/Users/you/AppData/Local/pnpm/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy
          - --acp
          - --acp-transport
          - stdio
          - --permission-mode
          - dontAsk
          - --model
          - deepseek-v4.1-flash
        permission: allow
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `permission` | `allow` | CodeBuddy 自己执行工具，每问一次权限 dsh 就弹一次框，一个任务几十次调用没法用。可收紧成 `read-only`（只放行 read/search/fetch）或 `ask`（接 dsh 原生审批框）。 |
| `systemPrompt` | `drop` | 不把 dsh 的 system prompt 塞给 CodeBuddy，它有自己的角色设定与工具规范。改成 `forward` 则转发。 |
| `models` / `discoverModels` | `[]` / `true` | 默认让 CodeBuddy 自己报模型。它在 `session/new` 里给出 `availableModels`（实测 20 个：`fast-model`、`deepseek-v4.1-flash`、`glm-5.3`、`kimi-k3-1`、`deepseek-v4-pro`…）和一个 `thought_level` 选项（`low`/`high`/`max`/`enabled`，`enabled` 就是「用模型自带的默认档」），两者都只有在建过一次会话后才拿得到——所以关掉发现会同时失去「模型列表」和「推理等级」两行。代价是首次打开模型选择器要等一次冷启动（实测 6.4s）；超过 25s 还没答就放弃，选择器退回单个 default，不会变成第二次转圈。`models` 里写死列表可跳过这次发现。 |
| `imageInput` | `auto` | 按 ACP 握手里 `promptCapabilities.image` 决定；`force` / `off` 可覆盖 Agent 的漏报。 |
| `showToolCalls` | `true` | 把工具调用与计划渲染进推理块。 |
| `contextWindow` | `1000000` | CodeBuddy 默认模型 `deepseek-v4.1-flash` 的真实窗口（1M，`maxTokens` 384k）。报小了 dsh 会提前压缩历史，等于白丢上下文。Agent 通过 `usage_update` 上报过就以它为准（实测标准预设会报 `size: 300000`，切到 `ptc` 后报 `size: 1000000`）。 |
| `startupTimeoutMs` / `idleTimeoutMs` | `60000` / `600000` | 握手超时 / 一轮对话内无事件多久算卡死。 |
| `env` | `{ CODEBUDDY_MAIN_AGENT_ALLOW_UNOPTED: '1' }` | 在白名单环境之上**追加**变量，最后合并。默认这一条是让 Agent 预设对未声明的 ACP 宿主生效（见上一节）。要放回被挡掉的宿主变量就写这里——注意它整体覆盖默认值，不是追加。

插件带一个设置页：设置 → **ACP Agents**，可以表单化管理路由、导入其他 ACP 客户端的 JSON 配置、按已保存命令发现模型。

设置页只列出**写进配置**的路由。插件自动挂的那条默认路由是合成的，不会出现在这里（也不占配置），所以想在这个页面里编辑它，就把上面那段 YAML 写进 profile——写进去之后内置默认自动让位，两者完全等价。

## 已知限制

- **环境变量必须用白名单构造**，这一条是这个插件最容易踩的坑。CodeBuddy 的认证判定不只看「有没有凭据文件」，还看进程环境：宿主会向自身注入整套 IDE 客户端标识 `CLIENT_INFO_IDE_TYPE` / `_PLATFORM` / `_PLUGIN_NAME` / `_PRODUCT_NAME` / `_USER_AGENT_EXTENSION` / `_MACHINE_ID`。**六项单独存在都没事，同时存在就出事**——CLI 判定「我在宿主里跑」，切到宿主集成认证、转而向宿主索要 token，于是 `~/.codebuddy` 里的登录态根本不会被读取。表现很隐蔽：`initialize` 成功、`session/new` 成功（这两步不碰模型），一 `session/prompt` 就是 `stopReason: refusal`、`reply` 为空，CLI 日志里只有一行 `Request failed with status code 401`。所以子进程环境由 `child-env.ts` 只放行 Windows 基础变量 + `PATH` + 两个登录入口（`CODEBUDDY_API_KEY` / `CODEBUDDY_AUTH_TOKEN`）+ 非本机代理；`CLIENT_INFO_*`、`CODEBUDDY_*`、`CLAUDE_*`、`SERVER__*`、`DSH_*` 全部进不来。要加什么就在路由的 `env` 里写，它最后合并。（实测：白名单下 `deepseek-v4.1-flash` 一轮问答 22 秒返回「好的」。）
- **网关端口**：CodeBuddy 系 CLI 即使走 `--acp --acp-transport stdio`，启动时仍会 bind 一个本地网关端口，并且照读宿主发布自己的 `SERVER__PORT` / `SERVER__HOST`。继承下来就是**父子抢同一个端口**，子进程一启动 `EADDRINUSE`，上层只看到 `initialize failed: ACP connection closed`。白名单天然挡掉这两个变量，CLI 自己 `listen(0)` 拿内核分配的空闲端口，无需插件挑端口。
- **link 安装下的 peer 依赖**：以 `link:` 方式装进 profile 时，插件会从本仓库的 `node_modules` 解析 `@deepseek-ai/dsh-llm`，和宿主不是同一个实例。所以适配器的失败一律以带内 `finish` 返回，不依赖 `instanceof LlmError`。

## 开发

```bash
npm install
npm run build      # tsdown → dist/index.js + dist/client.cjs
npm run typecheck  # tsc --noEmit
npm test           # vitest，69 项
```

装进本机 profile 做真机验证：

```bash
dsh plugin --profile <name> add D:/code/dsh-acp-llm
dsh --profile <name> "说句话试试"
```

改完代码执行 `npm run build`，再重启桌面端即可生效。

`scripts/smoke.mts` 可以脱离 dsh 直接验一个 ACP Agent：

```bash
npx tsx scripts/smoke.mts <command> [args...] -- "提示词"
```
