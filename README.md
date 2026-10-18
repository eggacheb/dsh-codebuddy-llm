# dsh-codebuddy-llm

把本机的 **CodeBuddy** 注册成 DeepSeek Harness 的**模型提供方**：在模型选择器里选中它，对话就交给 CodeBuddy 处理。

用 [ACP（Agent Client Protocol）](https://agentclientprotocol.com) 通信：插件拉起 `codebuddy --acp --acp-transport stdio` 子进程，再把 ACP 的流式事件翻译成 dsh 的 `StreamChunk`。

Fork 自 [Fleey/deepseek-harness-acp](https://github.com/Fleey/deepseek-harness-acp)（MIT，见 `LICENSE`）。上游是通用的「ACP Agent → 模型」适配器；这个 fork 把默认路由、命令发现和默认参数都对准 CodeBuddy，装完即用。

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
| `models` / `discoverModels` | `[]` / `true` | 默认让 CodeBuddy 自己报模型。它在 `session/new` 里给出 `availableModels`（`deepseek-v4.1-flash`、`glm-5.3`、`kimi-k3-1`…）和一个 `thought_level` 选项（`low`/`medium`/`high`/`xhigh`/`max`），两者都只有在建过一次会话后才拿得到——所以关掉发现会同时失去「模型列表」和「推理等级」两行。代价是首次打开模型选择器要等一次冷启动（实测握手 6.4s、建会话 7.7s）；超过 25s 还没答就放弃，选择器退回单个 default，不会变成第二次转圈。`models` 里写死列表可跳过这次发现。 |
| `imageInput` | `auto` | 按 ACP 握手里 `promptCapabilities.image` 决定；`force` / `off` 可覆盖 Agent 的漏报。 |
| `showToolCalls` | `true` | 把工具调用与计划渲染进推理块。 |
| `contextWindow` | `200000` | 兜底值；Agent 上报过就以它为准。 |
| `startupTimeoutMs` / `idleTimeoutMs` | `60000` / `600000` | 握手超时 / 一轮对话内无事件多久算卡死。 |

插件带一个设置页：设置 → **ACP Agents**，可以表单化管理路由、导入其他 ACP 客户端的 JSON 配置、按已保存命令发现模型。

设置页只列出**写进配置**的路由。插件自动挂的那条默认路由是合成的，不会出现在这里（也不占配置），所以想在这个页面里编辑它，就把上面那段 YAML 写进 profile——写进去之后内置默认自动让位，两者完全等价。

## 已知限制

- **网关端口**：CodeBuddy 系 CLI 即使走 `--acp --acp-transport stdio`，启动时仍会 bind 一个本地网关端口，读完 `SERVER__PORT` 就照它来。宿主（WorkBuddy / CodeBuddy 桌面端）正好用这两个变量发布自己的网关地址，于是继承下来就是**父子抢同一个端口**：子进程一启动就 `EADDRINUSE`，上层只看到 `initialize failed: ACP connection closed`。插件默认把 `SERVER__*` / `CODEBUDDY_*` / `CLAUDE_*` 从子进程环境里摘掉（见下一条），所以撞上它现在只可能是「别的 CodeBuddy 系进程真的占着」或「路由的 `env` 又把它写回去了」。
- **环境变量**：子进程拿到的是**净化过**的 `process.env` 加上路由的 `env`。净化规则是按前缀摘：`CODEBUDDY_`（配置目录、宿主身份、会话 id、打包形态）、`CLAUDE_`、`SERVER__`（宿主网关端口）——留着它们会让子进程以为自己是宿主的一部分。凭据类例外，会照常传下去：`CODEBUDDY_API_KEY`、`CODEBUDDY_AUTH_TOKEN`、`CODEBUDDY_BASE_URL`、`CODEBUDDY_INTERNET_ENVIRONMENT`。真需要某条被摘掉的变量，在路由的 `env` 里写回去即可，它是后合并的。
- **link 安装下的 peer 依赖**：以 `link:` 方式装进 profile 时，插件会从本仓库的 `node_modules` 解析 `@deepseek-ai/dsh-llm`，和宿主不是同一个实例。所以适配器的失败一律以带内 `finish` 返回，不依赖 `instanceof LlmError`。

## 开发

```bash
npm install
npm run build      # tsdown → dist/index.js + dist/client.cjs
npm run typecheck  # tsc --noEmit
npm test           # vitest，65 项
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
