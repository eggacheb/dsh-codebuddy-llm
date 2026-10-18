import type { AcpAgentProfile } from '../../shared/types.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

export const DEFAULT_MODEL_ID = 'default'

export const DEFAULT_CONTEXT_WINDOW = 200_000

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
    env: {},
    models: [],
    discoverModels: false,
    // 兜底：万一 CodeBuddy 仍然发来 permission 请求，选 allow 而不是卡住。
    // 想收紧就改成 read-only（只放行 read/search/fetch）或 ask（接 dsh 审批框）。
    permission: 'allow',
    imageInput: 'auto',
    // 不把 dsh 的 system prompt 塞给 CodeBuddy：它有自己的角色设定与工具规范，
    // 混进别人的系统提示只会互相打架。需要时可在配置里改成 forward。
    systemPrompt: 'drop',
    showToolCalls: true,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    startupTimeoutMs: 60_000,
    idleTimeoutMs: 600_000,
  }
}
