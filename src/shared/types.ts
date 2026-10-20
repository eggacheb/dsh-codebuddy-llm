/** Profile shapes shared by the host schema and the client settings editor. */

export type PermissionPolicy = 'ask' | 'allow' | 'read-only' | 'reject'

export type SystemPromptMode = 'drop' | 'forward'

/**
 * Whether the route offers image input. `auto` follows the `promptCapabilities` the agent
 * declares in its ACP handshake; the other two override an agent that misreports them.
 */
export type ImageInputMode = 'auto' | 'force' | 'off'

/**
 * `whitelist`：只放行已知安全的变量（默认）。
 * `inherit`：继承宿主环境，仅挡掉会改变 CLI 认证判定或抢端口的那些。
 */
export type EnvMode = 'whitelist' | 'inherit'

export interface AcpModelProfile {
  id: string
  name?: string
  description?: string
  contextWindow?: number
}

export interface AcpAgentProfile {
  displayName?: string
  command: string
  args: string[]
  env: Record<string, string>
  envMode: EnvMode
  cwd?: string
  authMethod?: string
  models: AcpModelProfile[]
  discoverModels: boolean
  permission: PermissionPolicy
  imageInput: ImageInputMode
  systemPrompt: SystemPromptMode
  showToolCalls: boolean
  contextWindow: number
  startupTimeoutMs: number
  idleTimeoutMs: number
}
