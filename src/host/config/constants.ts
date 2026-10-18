import type { AcpAgentProfile } from '../../shared/types.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

export const DEFAULT_MODEL_ID = 'default'

export const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * CodeBuddy 默认模型 `deepseek-v4.1-flash` 的真实窗口。
 *
 * 读自 CLI 的模型元数据：`contextWindow: 1,000,000` / `maxTokens: 384,000`。
 * 窗口报小了 dsh 会提前触发压缩，把还能用的历史压掉。
 */
export const CODEBUDDY_CONTEXT_WINDOW = 1_000_000

/**
 * CodeBuddy 的默认模型。
 *
 * 和 `dsh-codebuddy`（子智能体版）保持一致：两边锁同一个模型，
 * 才不会出现「同一个 CodeBuddy，当模型时是 A、当子代理时是 B」。
 */
export const DEFAULT_CODEBUDDY_MODEL = 'deepseek-v4.1-flash'

/**
 * 找一个**真正的 node.exe**。
 *
 * 绝对不能回落到 `process.execPath`：dsh 桌面端里那是 `DeepSeek Harness.exe`，
 * 拿它跑 JS 脚本的后果是「退出码 0、stdout 为空」，而且没有任何报错。
 * 这一条在 `dsh-codebuddy` 上已经踩过一次，别再来一次。
 */
function findNode(): string | undefined {
  const local = process.env.LOCALAPPDATA ?? ''
  const candidates = [
    join(local, 'pnpm', 'node.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
    'C:\\Program Files\\nodejs\\node.exe',
  ]
  return candidates.find(candidate => candidate.length > 0 && existsSync(candidate))
}

/** CodeBuddy CLI 的入口脚本（JS，需要用 node 去跑）。 */
function findCli(): string | undefined {
  const local = process.env.LOCALAPPDATA ?? ''
  const candidates = [
    join(local, 'pnpm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    join(local, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
  ]
  return candidates.find(candidate => candidate.length > 0 && existsSync(candidate))
}

/**
 * 开箱即用的 CodeBuddy 路由：`agents` 为空时自动挂上。
 *
 * 为什么给默认值而不是要求手写配置：这个插件的用途就是「把本机 CodeBuddy 接成模型」，
 * 装完不能直接用就等于没装。显式配了 `agents` 之后默认值自动让位。
 *
 * `command` 用 node 而不是 `codebuddy`：bin 是无扩展名的 JS + shebang，
 * Windows 上直接 spawn 会失败；走 `node <js>` 才是可移植的。
 */
export function defaultCodeBuddyProfile(): AcpAgentProfile | undefined {
  const node = findNode()
  const cli = findCli()
  if (node === undefined || cli === undefined) return undefined
  return {
    displayName: 'CodeBuddy',
    command: node,
    // 第一个参数是 CLI 入口脚本本身：`node <js> --acp ...`
    //
    // 参数与 `dsh-codebuddy`（子智能体版）逐字一致，多一个都不加：
    // 同一个 CodeBuddy 在两个插件里行为不同，排查起来是没有底的。
    //
    // `--permission-mode dontAsk`：CodeBuddy 自己执行工具（读文件、跑命令），
    // 它每问一次权限，dsh 这边就弹一次审批框，一个任务几十次调用直接没法用。
    // 这里的 dontAsk 就是「让它按自己的判断干」，与子智能体版的默认一致。
    args: [cli, '--acp', '--acp-transport', 'stdio', '--permission-mode', 'dontAsk', '--model', DEFAULT_CODEBUDDY_MODEL],
    // 让 CodeBuddy 对「未声明的 ACP 宿主」也应用 Agent 预设。
    //
    // 预设默认只对声明过 `clientCapabilities._meta["codebuddy.ai"].mainAgentSupport`
    // 的宿主开放；我们的客户端没声明，于是被 MainAgentGate 跳过，工具集固定成标准模式的
    // 全量清单 —— 实测 41,038 token，占一轮对话的 86%。打开这一项后才会去读 settings 里的
    // `codebuddy.mainAgent.default`：ptc 降到 10,915，minimal 降到 8,329。
    //
    // 用 env 而不是让用户改全局设置：`resolveMainAgentPolicy()` 里环境变量的优先级高于
    // settings，所以这条只影响本路由的子进程，不会波及 WorkBuddy 自己的 sidecar。
    env: { CODEBUDDY_MAIN_AGENT_ALLOW_UNOPTED: '1' },
    // 留空表示「让 Agent 自己报」。CodeBuddy 在 session/new 里给了 availableModels
    // （deepseek-v4.1-flash / glm-5.3 / kimi-k3-1 …）和一个 thought_level 选项
    // （low / high / max / enabled），但两者都只有在**建过一次会话**之后才拿得到。
    // 所以 discoverModels 必须开：关掉的话模型选择器里只剩一个 default，
    // 推理等级那一行也不会出现。
    models: [],
    discoverModels: true,
    // 兜底：万一 CodeBuddy 仍然发来 permission 请求，选 allow 而不是卡住。
    // 想收紧就改成 read-only（只放行 read/search/fetch）或 ask（接 dsh 审批框）。
    permission: 'allow',
    imageInput: 'auto',
    // 不把 dsh 的 system prompt 塞给 CodeBuddy：它有自己的角色设定与工具规范，
    // 混进别人的系统提示只会互相打架。需要时可在配置里改成 forward。
    systemPrompt: 'drop',
    showToolCalls: true,
    // `deepseek-v4.1-flash` 的真实窗口是 1M（maxTokens 384k，读自 CLI 的模型元数据）。
    // 这里给 1M 而不是通用默认 200k：窗口报小了 dsh 会提前压缩历史，等于白白丢上下文。
    // Agent 自己通过 usage_update 上报过之后，仍以它为准。
    contextWindow: CODEBUDDY_CONTEXT_WINDOW,
    startupTimeoutMs: 60_000,
    idleTimeoutMs: 600_000,
  }
}
