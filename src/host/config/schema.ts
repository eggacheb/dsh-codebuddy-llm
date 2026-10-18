import type { Volatile } from '@deepseek-ai/cosmokit'
import type { AcpAgentProfile, AcpModelProfile } from '../../shared/types.ts'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_CONTEXT_WINDOW, defaultCodeBuddyProfile } from './constants.ts'

const DEFAULT_IDLE_TIMEOUT_MS = 600_000

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000

export type AgentProfiles = Record<string, AcpAgentProfile>

export interface Config {
  /**
   * Volatile so DSH 0.2 settings serve it as an editable form and commit edits in place
   * (`loader/volatile-update`) instead of restarting the plugin.
   */
  agents: Volatile<AgentProfiles>
}

const AcpModelProfile: z<AcpModelProfile> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.natural(),
})

const AcpAgentProfile: z<AcpAgentProfile> = z.object({
  displayName: z.string(),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  env: z.dict(z.string()).default({}),
  cwd: z.string(),
  authMethod: z.string(),
  models: z.array(AcpModelProfile).default([]),
  discoverModels: z.boolean().default(true),
  permission: z.union(['ask', 'allow', 'read-only', 'reject'] as const).default('ask'),
  imageInput: z.union(['auto', 'force', 'off'] as const).default('auto'),
  systemPrompt: z.union(['drop', 'forward'] as const).default('drop'),
  showToolCalls: z.boolean().default(true),
  contextWindow: z.natural().default(DEFAULT_CONTEXT_WINDOW),
  startupTimeoutMs: z.natural().default(DEFAULT_STARTUP_TIMEOUT_MS),
  idleTimeoutMs: z.natural().default(DEFAULT_IDLE_TIMEOUT_MS),
})

export const Config: z<{ agents: AgentProfiles }, Config> = z.object({
  agents: z.dict(AcpAgentProfile).default({}).volatile(),
})

/** Read the agents of a resolved config; a cell from another schemastery copy is read the same way. */
export function agentsOf(config: Pick<Config, 'agents'> | undefined): AgentProfiles {
  const agents = config?.agents as Volatile<AgentProfiles> | AgentProfiles | undefined
  if (agents === undefined)
    return builtInDefault()
  const resolved = typeof agents.get === 'function' ? (agents as Volatile<AgentProfiles>).get() as AgentProfiles : agents as AgentProfiles
  // 空配置不是「用户不想要任何路由」，而是「还没配」——挂上 CodeBuddy 默认路由，
  // 让装完即可用。一旦显式配了 agents，默认值自动让位。
  return Object.keys(resolved).length === 0 ? builtInDefault() : resolved
}

/** 默认 CodeBuddy 路由；本机找不到 node 或 CLI 时给空（让配置页面去报错，而不是静默失败）。 */
function builtInDefault(): AgentProfiles {
  const profile = defaultCodeBuddyProfile()
  return profile === undefined ? {} : { codebuddy: profile }
}
