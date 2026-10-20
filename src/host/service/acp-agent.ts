import type {
  ContentBlock as AcpContentBlock,
  ClientConnection,
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  SessionConfigOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk'
import type { ChildProcess } from 'node:child_process'
import type { AcpAgentProfile } from '../../shared/types.ts'
import type { HostLogger } from '../types/index.ts'
import type { AcpPromptCapabilities } from './prompt-capabilities.ts'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import process from 'node:process'
import { Readable, Writable } from 'node:stream'
import { client as createClientApp, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { PLUGIN_ID } from '../../shared/constants.ts'
import { DEFAULT_MODEL_ID } from '../config/constants.ts'
import { childEnv } from './child-env.ts'
import { promptCapabilitiesOf } from './prompt-capabilities.ts'

export interface AcpAdvertisedModel {
  id: string
  name: string
  description?: string
}

export interface AcpSessionModels {
  configId?: string
  legacy: boolean
  current?: string
  available: AcpAdvertisedModel[]
}

/** The agent's `thought_level` config option, mapped onto dsh reasoning efforts. */
export interface AcpSessionEfforts {
  configId: string
  current?: string
  /** The level the session started with: what dsh's "Default" effort restores. */
  initial?: string
  available: AcpAdvertisedModel[]
}

export interface AcpSession {
  sessionId: string
  generation: number
  models: AcpSessionModels
  efforts?: AcpSessionEfforts
}

export type AcpPermissionHandler = (sessionId: string, request: RequestPermissionRequest) => Promise<RequestPermissionResponse>

export interface AcpAgentOptions {
  route: string
  profile: () => AcpAgentProfile
  onPermission: AcpPermissionHandler
  logger: HostLogger
  /** Every completed handshake, so the caller can remember what this agent accepts. */
  onCapabilities?: (capabilities: AcpPromptCapabilities) => void
}

interface LiveAgent {
  child: ChildProcess
  connection: ClientConnection
  init: InitializeResponse
  generation: number
}

interface LegacyModels {
  currentModelId?: string
  availableModels?: Array<{ modelId: string, name?: string, description?: string | null }>
}

const AUTH_REQUIRED_CODE = -32000

const STDERR_TAIL_BYTES = 4096

/**
 * How long a catalog probe may take.
 *
 * 模型发现是「打开选择器」时顺手做的旁路请求，不能把它变成第二次长时间转圈：Agent 正忙
 * （正在跑一个回合）时 `session/new` 会排在后面，等多久取决于那一轮什么时候结束。超时就
 * 认输，选择器退回单个 default，等用户下次打开再试。
 */
const DISCOVERY_TIMEOUT_MS = 25_000

/**
 * Whether spawning this command needs a shell.
 *
 * On Windows `spawn` with `shell: true` joins everything into one line for `cmd /c` **without
 * quoting**, so a command living under `C:\Program Files\...` is split at the first space and
 * dies as "not recognized". A real `.exe` therefore must never go through a shell. Only bare
 * names (`npx`, `claude`) and `.cmd`/`.bat` shims need one — Node refuses to run those directly.
 */
export function needsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32')
    return false
  return !/\.(?:exe|com)$/i.test(command)
}

function selectOption(options: readonly SessionConfigOption[] | null | undefined, category: string): { id: string, current: string, available: AcpAdvertisedModel[] } | undefined {
  const option = options?.find(item => item.category === category && item.type === 'select')
  if (option === undefined || option.type !== 'select')
    return undefined
  const available = option.options.flatMap(entry => 'group' in entry ? entry.options : [entry])
    .map(entry => ({ id: entry.value, name: entry.name, ...entry.description ? { description: entry.description } : {} }))
  return { id: option.id, current: option.currentValue, available }
}

/** Read the `thought_level` select the agent offers, if any. */
export function sessionEfforts(options: readonly SessionConfigOption[] | null | undefined): AcpSessionEfforts | undefined {
  const option = selectOption(options, 'thought_level')
  return option === undefined || option.available.length === 0 ? undefined : { configId: option.id, current: option.current, initial: option.current, available: option.available }
}

/** Fold a fresh `configOptions` list (set_config_option answer or config_option_update) into a session. */
export function applyConfigOptions(session: AcpSession, options: readonly SessionConfigOption[] | null | undefined): void {
  const model = selectOption(options, 'model')
  if (model !== undefined && session.models.configId === model.id)
    session.models.current = model.current
  const efforts = sessionEfforts(options)
  if (efforts !== undefined)
    session.efforts = { ...efforts, initial: session.efforts?.initial ?? efforts.initial }
  else if (options?.some(item => item.id === session.efforts?.configId) === false)
    delete session.efforts
}

export function sessionModels(response: NewSessionResponse): AcpSessionModels {
  const option = selectOption(response.configOptions, 'model')
  if (option !== undefined)
    return { configId: option.id, legacy: false, current: option.current, available: option.available }
  const legacy = Reflect.get(response, 'models') as LegacyModels | null | undefined
  if (legacy?.availableModels !== undefined) {
    return {
      legacy: true,
      ...legacy.currentModelId === undefined ? {} : { current: legacy.currentModelId },
      available: legacy.availableModels.map(entry => ({
        id: entry.modelId,
        name: entry.name ?? entry.modelId,
        ...entry.description ? { description: entry.description } : {},
      })),
    }
  }
  return { legacy: false, available: [] }
}

function describeError(error: unknown): string {
  if (error instanceof Error)
    return error.message
  if (typeof error === 'object' && error !== null && typeof Reflect.get(error, 'message') === 'string')
    return Reflect.get(error, 'message') as string
  return String(error)
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

function abortError(): LlmError {
  return new LlmError('ACP request was aborted', 'ABORTED')
}

export class AcpAgentProcess {
  private live: LiveAgent | undefined
  private starting: Promise<LiveAgent> | undefined
  private generationCounter = 0
  private disposed = false
  private stderrTail = ''
  private readonly listeners = new Map<string, (update: SessionUpdate) => void>()
  private liveCwd: string | undefined
  private lastCwd: string | undefined
  private advertised: AcpAdvertisedModel[] | undefined
  private efforts: AcpSessionEfforts | undefined
  private discovering: Promise<readonly AcpAdvertisedModel[]> | undefined

  constructor(private readonly options: AcpAgentOptions) {}

  get generation(): number {
    return this.live?.generation ?? -1
  }

  /** What the running agent said it accepts in a prompt; undefined until it has spoken. */
  get promptCapabilities(): AcpPromptCapabilities | undefined {
    const live = this.live
    return live === undefined ? undefined : promptCapabilitiesOf(live.init.agentCapabilities?.promptCapabilities)
  }

  get supportsImages(): boolean {
    return this.promptCapabilities?.image === true
  }

  /**
   * Ask the agent itself what prompt content it accepts. ACP answers that in `initialize`,
   * so the handshake alone is enough — no session and no turn.
   */
  async probeCapabilities(signal?: AbortSignal): Promise<AcpPromptCapabilities> {
    const live = await this.ensure(signal)
    return promptCapabilitiesOf(live.init.agentCapabilities?.promptCapabilities)
  }

  get advertisedModels(): readonly AcpAdvertisedModel[] | undefined {
    return this.advertised
  }

  /** The thought levels the agent offered on its latest session, if it offers any. */
  get advertisedEfforts(): AcpSessionEfforts | undefined {
    return this.efforts
  }

  async newSession(cwd: string, signal?: AbortSignal): Promise<AcpSession> {
    const live = await this.ensure(signal, cwd)
    let response: NewSessionResponse
    try {
      response = await this.withAbort(live.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }), signal)
    }
    catch (error) {
      if (error instanceof LlmError)
        throw error
      if (errorCode(error) === AUTH_REQUIRED_CODE) {
        const available = (live.init.authMethods ?? []).map(method => method.id).join(', ')
        throw new LlmError(
          `${PLUGIN_ID}: ACP agent "${this.options.route}" requires authentication; sign in with the agent's own CLI or set authMethod${available.length > 0 ? ` (one of: ${available})` : ''} — ${describeError(error)}`,
          'MISSING_CREDENTIAL',
          { cause: error },
        )
      }
      throw this.transportError('session/new', error)
    }
    const models = sessionModels(response)
    if (models.available.length > 0)
      this.advertised = models.available
    const efforts = sessionEfforts(response.configOptions)
    this.efforts = efforts
    return { sessionId: response.sessionId, generation: live.generation, models, ...efforts === undefined ? {} : { efforts } }
  }

  async selectModel(session: AcpSession, model: string, signal?: AbortSignal): Promise<void> {
    if (model === DEFAULT_MODEL_ID || model === session.models.current)
      return
    const live = this.requireLive(session.generation)
    const { configId, legacy } = session.models
    try {
      if (configId !== undefined) {
        const response = await this.withAbort(live.connection.agent.request(methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId,
          value: model,
        }), signal)
        applyConfigOptions(session, response.configOptions)
      }
      else if (legacy) {
        await this.withAbort(live.connection.agent.request('session/set_model', { sessionId: session.sessionId, modelId: model }), signal)
      }
      else {
        throw new LlmError(
          `${PLUGIN_ID}: ACP agent "${this.options.route}" does not expose model selection; use model "${DEFAULT_MODEL_ID}"`,
          'MODEL_NOT_FOUND',
        )
      }
    }
    catch (error) {
      if (error instanceof LlmError)
        throw error
      throw new LlmError(
        `${PLUGIN_ID}: ACP agent "${this.options.route}" rejected model "${model}": ${describeError(error)}`,
        'MODEL_NOT_FOUND',
        { cause: error },
      )
    }
    session.models.current = model
  }

  /**
   * Apply a dsh reasoning effort through the agent's `thought_level` option. Unknown efforts
   * (the model changed the offered levels) keep the agent's current level.
   */
  async selectEffort(session: AcpSession, effort: string, signal?: AbortSignal): Promise<void> {
    const efforts = session.efforts
    if (efforts === undefined || efforts.current === effort)
      return
    if (!efforts.available.some(level => level.id === effort)) {
      this.options.logger.warn(`${PLUGIN_ID}: ACP agent "${this.options.route}" does not offer reasoning effort "${effort}"; keeping "${efforts.current ?? 'default'}"`)
      return
    }
    const live = this.requireLive(session.generation)
    try {
      const response = await this.withAbort(live.connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: efforts.configId,
        value: effort,
      }), signal)
      efforts.current = effort
      applyConfigOptions(session, response.configOptions)
    }
    catch (error) {
      if (error instanceof LlmError)
        throw error
      throw new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" rejected reasoning effort "${effort}": ${describeError(error)}`, 'INVALID_REQUEST', { cause: error })
    }
  }

  async prompt(session: AcpSession, prompt: AcpContentBlock[], onUpdate: (update: SessionUpdate) => void): Promise<PromptResponse> {
    const live = this.requireLive(session.generation)
    this.listeners.set(session.sessionId, onUpdate)
    try {
      return await live.connection.agent.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt })
    }
    catch (error) {
      throw this.transportError('session/prompt', error)
    }
    finally {
      if (this.listeners.get(session.sessionId) === onUpdate)
        this.listeners.delete(session.sessionId)
    }
  }

  cancel(session: AcpSession): void {
    const live = this.live
    if (live === undefined || live.generation !== session.generation)
      return
    void live.connection.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId }).catch(() => {})
  }

  closeSession(session: AcpSession): void {
    const live = this.live
    if (live === undefined || live.generation !== session.generation)
      return
    if (!Reflect.get(live.init.agentCapabilities?.sessionCapabilities ?? {}, 'close'))
      return
    void live.connection.agent.request(methods.agent.session.close, { sessionId: session.sessionId }).catch(() => {})
  }

  async discoverModels(cwd: string, signal?: AbortSignal): Promise<readonly AcpAdvertisedModel[]> {
    if (this.advertised !== undefined)
      return this.advertised
    // Catalog reads resolve every model at once; they share one probe session.
    // 用这个进程已经在的目录：设置页取模型列表不该把正在对话的会话按到别的目录去。
    this.discovering ??= this.timed(
      DISCOVERY_TIMEOUT_MS,
      `did not answer session/new within ${DISCOVERY_TIMEOUT_MS}ms while listing models`,
      this.newSession(this.liveCwd ?? this.lastCwd ?? cwd).then((session) => {
        this.closeSession(session)
        this.advertised ??= session.models.available
        return this.advertised
      }),
    ).finally(() => {
      this.discovering = undefined
    })
    return this.withAbort(this.discovering, signal)
  }

  restart(): void {
    this.advertised = undefined
    this.efforts = undefined
    this.discovering = undefined
    this.teardown()
  }

  dispose(): void {
    this.disposed = true
    this.teardown()
  }

  private teardown(): void {
    const live = this.live
    this.live = undefined
    this.liveCwd = undefined
    this.starting = undefined
    this.listeners.clear()
    if (live === undefined)
      return
    live.connection.close()
    live.child.stdin?.end()
    if (live.child.exitCode === null && live.child.signalCode === null)
      live.child.kill('SIGTERM')
  }

  private requireLive(generation: number): LiveAgent {
    const live = this.live
    if (live === undefined || live.generation !== generation)
      throw new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" restarted during the request`, 'TRANSPORT')
    return live
  }

  /**
   * @param cwd 这次要用的工作目录（dsh 会话的 workspace）。子进程的 shell 必须和 ACP
   * 会话报的目录一致：CodeBuddy 的 Bash 工具跟随进程 cwd，两者不一致时它会发现
   * 「runtime context 说 A、我的 shell 在 B」，然后停下来反问用户。
   */
  private ensure(signal?: AbortSignal, cwd?: string): Promise<LiveAgent> {
    if (this.disposed)
      return Promise.reject(new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" was disposed`, 'TRANSPORT'))
    if (this.live !== undefined) {
      if (cwd === undefined || this.liveCwd === undefined || cwd === this.liveCwd)
        return Promise.resolve(this.live)
      // 一个路由只能有一个进程（CodeBuddy 系 CLI 会抢同一个网关端口），所以换工作区
      // 只能重启。已经聊过的会话在自己那一侧仍有上下文，这里丢的只是 shell 的落脚点。
      this.options.logger.info(`${PLUGIN_ID}: ACP agent "${this.options.route}" restarts for working directory "${cwd}"`)
      this.restart()
    }
    this.starting ??= this.start(cwd).finally(() => {
      this.starting = undefined
    })
    return this.withAbort(this.starting, signal)
  }

  private async start(cwdHint?: string): Promise<LiveAgent> {
    const profile = this.options.profile()
    const generation = ++this.generationCounter
    this.stderrTail = ''
    // 显式配的 cwd 优先；其次这次会话的工作区；再次上次用过的（同一窗口的后续回合）。
    const cwd = profile.cwd ?? cwdHint ?? this.lastCwd ?? homedir()
    this.lastCwd = cwd
    const child = spawn(profile.command, profile.args, {
      cwd,
      // 子进程环境用白名单构造：宿主的 CLIENT_INFO_* 一旦整套进去，CLI 会切到宿主集成
      // 认证从而读不到自己的登录态；SERVER__PORT 则会让父子抢同一个网关端口。
      // 路由自己的 env 是最后合并的，要加什么都在那里加。
      env: childEnv(process.env, profile.env, profile.envMode),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: needsShell(profile.command),
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
    })
    const exited = new Promise<never>((_, reject) => {
      child.once('error', error => reject(this.startError(`failed to spawn "${profile.command}": ${error.message}`, error)))
      child.once('exit', (code, sig) => reject(this.startError(`agent exited during startup (code ${code ?? 'null'}, signal ${sig ?? 'null'})`)))
    })
    exited.catch(() => {})

    const app = createClientApp({ name: PLUGIN_ID })
      .onNotification(methods.client.session.update, ({ params }) => {
        this.listeners.get(params.sessionId)?.(params.update)
        return Promise.resolve()
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.options.onPermission(params.sessionId, params))
    const connection = app.connect(ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    ))

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(this.startError(`initialize timed out after ${profile.startupTimeoutMs}ms`)), profile.startupTimeoutMs)
    })
    let init: InitializeResponse
    try {
      init = await Promise.race([
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: PLUGIN_ID, version: '0.2.0' },
        }),
        exited,
        timeout,
      ])
    }
    catch (error) {
      connection.close()
      if (child.exitCode === null)
        child.kill('SIGKILL')
      throw error instanceof LlmError ? error : this.startError(`initialize failed: ${describeError(error)}`, error)
    }
    finally {
      clearTimeout(timer)
    }

    if (profile.authMethod !== undefined) {
      try {
        await Promise.race([connection.agent.request(methods.agent.authenticate, { methodId: profile.authMethod }), exited])
      }
      catch (error) {
        connection.close()
        if (child.exitCode === null)
          child.kill('SIGKILL')
        const available = (init.authMethods ?? []).map(method => method.id).join(', ')
        throw new LlmError(
          `${PLUGIN_ID}: ACP agent "${this.options.route}" rejected authMethod "${profile.authMethod}"${available.length > 0 ? ` (available: ${available})` : ''}: ${describeError(error)}${this.stderrSuffix()}`,
          'MISSING_CREDENTIAL',
          { cause: error },
        )
      }
    }

    const live: LiveAgent = { child, connection, init, generation }
    child.removeAllListeners('exit')
    child.once('exit', (code, sig) => {
      if (this.live === live) {
        this.options.logger.warn(`${PLUGIN_ID}: ACP agent "${this.options.route}" exited (code ${code ?? 'null'}, signal ${sig ?? 'null'})${this.stderrSuffix()}`)
        this.live = undefined
        this.listeners.clear()
        connection.close()
      }
    })
    this.live = live
    this.liveCwd = cwd
    this.options.onCapabilities?.(promptCapabilitiesOf(init.agentCapabilities?.promptCapabilities))
    return live
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.trim()
    return tail.length === 0 ? '' : `\n${tail}${this.portHint(tail)}`
  }

  /**
   * CodeBuddy 系 CLI 启动时会 bind 一个本地网关端口，被占就直接退出，stderr 只留一行
   * EADDRINUSE，上层只能看到「ACP connection closed」。
   *
   * 最常见的成因是宿主的 `SERVER__PORT` 被继承下来（见 `child-env.ts`，插件的默认行为已经
   * 把它摘掉了），所以现在还撞上，就只剩两种可能：别的 CodeBuddy 系进程真的占着那个端口，
   * 或者 profile 的 `env` 又把它写回去了。
   */
  private portHint(tail: string): string {
    if (!tail.includes('EADDRINUSE'))
      return ''
    return '\n  hint: the agent could not bind its local gateway port. The plugin strips SERVER__PORT / CODEBUDDY_* from the child environment by default, so this now means either another CodeBuddy-family process (CodeBuddy CLI, WorkBuddy, a leaked run) owns that port, or this route\'s `env` sets it again.'
  }

  private startError(message: string, cause?: unknown): LlmError {
    return new LlmError(
      `${PLUGIN_ID}: ACP agent "${this.options.route}" ${message}${this.stderrSuffix()}`,
      'TRANSPORT',
      cause === undefined ? undefined : { cause },
    )
  }

  private transportError(stage: string, error: unknown): LlmError {
    if (error instanceof LlmError)
      return error
    return new LlmError(
      `${PLUGIN_ID}: ACP agent "${this.options.route}" ${stage} failed: ${describeError(error)}${this.stderrSuffix()}`,
      'TRANSPORT',
      { cause: error },
    )
  }

  private withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined)
      return promise
    if (signal.aborted)
      return Promise.reject(abortError())
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  /** Reject with a named reason instead of waiting forever for an agent that never answers. */
  private async timed<T>(ms: number, why: string, action: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LlmError(`${PLUGIN_ID}: ACP agent "${this.options.route}" ${why}`, 'TRANSPORT')), ms)
    })
    action.catch(() => {})
    try {
      return await Promise.race([action, timeout])
    }
    finally {
      clearTimeout(timer)
    }
  }
}
