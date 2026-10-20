import type { ContentBlock as AcpContentBlock, PromptResponse, Usage } from '@agentclientprotocol/sdk'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ReasoningEffortId,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AcpAgentProfile } from '../../shared/types.ts'
import type { AdapterHost } from '../types/index.ts'
import type { AcpAdvertisedModel, AcpSession } from './acp-agent.ts'
import type { AcpPromptCapabilities } from './prompt-capabilities.ts'
import type { PromptImage, PromptImages } from './transcript.ts'
import type { PermissionTurn } from './permission.ts'
import { homedir } from 'node:os'
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PLUGIN_ID } from '../../shared/constants.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MODEL_ID } from '../config/constants.ts'
import { AcpAgentProcess, applyConfigOptions } from './acp-agent.ts'
import { ChunkTranslator, usageDelta } from './chunk-translator.ts'
import { ContextWindows, inferContextWindow } from './context-windows.ts'
import { decidePermission } from './permission.ts'
import { PromptCapabilitiesCache } from './prompt-capabilities.ts'
import { consumedIds, conversationOf, fullPrompt, incrementalPrompt, systemText } from './transcript.ts'
import { TurnTrace } from './turn-trace.ts'

interface Binding {
  session: AcpSession
  cwd: string
  model: string
  consumed: string[]
  usage: Usage | undefined
  /**
   * CodeBuddy 自己报的上下文构成（`systemPrompt` / `tools` / `conversation` / `mcp` / `skills`）
   * 与它认定的有效窗口。ACP 的 `TokenUsage` 没有分类维度，只能在这里单独留着。
   */
  breakdown?: Record<string, number>
  contextSize?: number
}

const TEXT_ONLY: readonly ModelModality[] = ['text']

const TEXT_AND_IMAGE: readonly ModelModality[] = ['text', 'image']

type Outcome =
  | { kind: 'response', response: PromptResponse }
  | { kind: 'error', error: unknown }
  | { kind: 'aborted' }
  | { kind: 'timeout' }

const NO_RETRY = { mode: 'normal', maxRetries: 0 } as const

const CANCEL_GRACE_MS = 5_000

/**
 * 提问前的配置类请求（选模型、选推理等级）本该在毫秒级返回。给它们一个上限，是为了让
 * 「Agent 收下请求却不回应」表现为一条明确的错误，而不是界面上一圈永远转下去。
 */
const STAGE_TIMEOUT_MS = 20_000

function promptHead(blocks: readonly AcpContentBlock[]): string {
  const text = blocks.map(block => block.type === 'text' ? block.text : '').join(' ').trim()
  return text.length <= 60 ? text : `${text.slice(0, 60)}…`
}

function spawnFacts(profile: AcpAgentProfile): string {
  return JSON.stringify([profile.command, profile.args, profile.env, profile.cwd ?? null, profile.authMethod ?? null])
}

function failure(code: string, message: string): { code: string, message: string } {
  return { code, message }
}

function failureOf(error: unknown): { code: string, message: string } {
  const known = typeof error === 'object' && error !== null ? Reflect.get(error, 'failure') as { code?: unknown, message?: unknown } | undefined : undefined
  if (typeof known?.code === 'string' && typeof known.message === 'string')
    return failure(known.code, known.message)
  return failure('TRANSPORT', error instanceof Error ? error.message : String(error))
}

/** 12835 → "12.8K"，1000000 → "1.0M"。 */
function formatTokens(count: number): string {
  if (count >= 1_000_000)
    return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000)
    return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}

const CONTEXT_CATEGORIES: ReadonlyArray<readonly [string, string]> = [
  ['systemPrompt', '提示词'],
  ['tools', '工具'],
  ['conversation', '对话'],
  ['mcp', 'MCP'],
  ['skills', '技能'],
]

/**
 * 一轮结束时补一行「上下文构成」。
 *
 * CodeBuddy 在 `usage_update._meta["codebuddy.ai/usageByCategory"]` 里给了分类明细，
 * 但 ACP 的 `TokenUsage` 只有 input / output / cache 三类，分类在适配层就被丢掉了。
 * dsh 自己的上下文面板按字符估算 dsh 发出去的那部分，看不到 CodeBuddy 进程里的工具
 * 定义、系统提示词和技能——对这条路由会严重偏低。
 *
 * 所以把每轮的分类压成一行推理文本：数字是 CodeBuddy 亲口报的，不是估算。放在推理
 * 块里不打断正文，展开「思考过程」就能看到；客户端要画圆环也可以直接解析这一行。
 */
export function* contextReport(binding: Binding, index: number): Iterable<StreamChunk> {
  const byCategory = binding.breakdown
  if (byCategory === undefined)
    return
  const parts = CONTEXT_CATEGORIES
    .map(([key, label]) => [label, byCategory[key] ?? 0] as const)
    .filter(([, value]) => value > 0)
  const total = parts.reduce((sum, [, value]) => sum + value, 0)
  if (total === 0)
    return
  const size = binding.contextSize
  const share = size === undefined || size <= 0 ? '' : `（${(total / size * 100).toFixed(1)}%）`
  const window = size === undefined ? '' : ` / ${formatTokens(size)}`
  const body = parts.map(([label, value]) => `${label} ${formatTokens(value)}`).join(' · ')
  const text = `上下文 ${formatTokens(total)}${window}${share}｜${body}`
  yield { type: 'block-start', index, blockType: 'reasoning' }
  yield { type: 'reasoning-delta', index, text }
  yield { type: 'block-end', index, block: { type: 'reasoning', text } }
}

export class AcpAdapter extends LlmAdapter {
  private readonly agents = new Map<string, { process: AcpAgentProcess, facts: string }>()
  private readonly bindings = new Map<string, Binding>()
  private readonly turns = new Map<string, PermissionTurn>()
  private readonly retryPolicy: ResolvedRetryPolicy = resolveRetryPolicy(NO_RETRY, `${PLUGIN_ID}: retryPolicy`)

  constructor(
    private readonly host: AdapterHost,
    private readonly profiles: () => ReadonlyMap<string, AcpAgentProfile>,
    private readonly contextWindows: ContextWindows = new ContextWindows(),
    private readonly capabilities: PromptCapabilitiesCache = new PromptCapabilitiesCache(),
    private readonly traceFile: string | undefined = undefined,
  ) {
    super()
  }

  sync(): void {
    const profiles = this.profiles()
    for (const [route, entry] of this.agents) {
      const profile = profiles.get(route)
      if (profile !== undefined && spawnFacts(profile) === entry.facts)
        continue
      entry.process.dispose()
      this.agents.delete(route)
      this.dropBindings(route)
    }
  }

  dispose(): void {
    for (const entry of this.agents.values())
      entry.process.dispose()
    this.agents.clear()
    this.bindings.clear()
    this.turns.clear()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.profiles().get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.profiles().get(provider)
    if (profile === undefined)
      return []
    const fallback = (): LlmModelInfo => ({ provider, id: DEFAULT_MODEL_ID, name: `${profile.displayName ?? provider} (default)`, ...this.modalities(provider) })
    if (profile.models.length > 0) {
      return profile.models.map(model => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        ...model.description === undefined ? {} : { description: model.description },
        ...this.modalities(provider),
      }))
    }
    if (!profile.discoverModels)
      return [fallback()]
    try {
      const found = await this.advertisedModels(provider)
      if (found.length === 0)
        return [fallback()]
      return [fallback(), ...found.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        ...this.modalities(provider),
      }))]
    }
    catch (error) {
      this.host.logger.warn(`${PLUGIN_ID}: model discovery for ACP agent "${provider}" failed`, error)
      return [fallback()]
    }
  }

  /**
   * Ask the agent behind one configured route which models it advertises, regardless of
   * the profile's declared `models` and `discoverModels` switch. Settings surfaces use this
   * to offer the agent's own list for adoption.
   */
  async advertisedModels(provider: string, signal?: AbortSignal): Promise<readonly AcpAdvertisedModel[]> {
    const profile = this.profiles().get(provider)
    if (profile === undefined)
      throw new LlmError(`${PLUGIN_ID}: no ACP agent is configured for provider "${provider}"`, 'PROVIDER_NOT_FOUND')
    return this.agent(provider, profile).discoverModels(profile.cwd ?? homedir(), signal)
  }

  /**
   * Exact-model metadata. Capabilities come from the agent itself: accepted input from the
   * `promptCapabilities` of its ACP handshake (learned here, remembered across restarts),
   * reasoning efforts from its `thought_level` option, and the context window it last
   * reported through `usage_update`, else one a "1m" token in the model's id, name or
   * description implies.
   */
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const profile = this.profiles().get(provider)
    await this.learnCapabilities(provider, signal)
    if (profile?.discoverModels === true && this.agents.get(provider)?.process.advertisedModels === undefined) {
      await this.advertisedModels(provider, signal).catch((error: unknown) => {
        this.host.logger.warn(`${PLUGIN_ID}: probing ACP agent "${provider}" for model metadata failed`, error)
      })
    }
    const process = this.agents.get(provider)?.process
    const configured = profile?.models.find(entry => entry.id === model)
    const advertised = process?.advertisedModels?.find(entry => entry.id === model)
    const efforts = process?.advertisedEfforts
    return {
      provider,
      id: model,
      name: configured?.name ?? advertised?.name ?? model,
      ...this.modalities(provider),
      context: {
        contextWindow: configured?.contextWindow
          ?? this.contextWindows.get(provider, model)
          ?? inferContextWindow(model, configured?.name, configured?.description, advertised?.name, advertised?.description)
          ?? profile?.contextWindow
          ?? DEFAULT_CONTEXT_WINDOW,
      },
      ...efforts === undefined
        ? {}
        : {
            reasoning: {
              efforts: efforts.available.map(level => ({
                id: level.id as ReasoningEffortId,
                name: level.name,
                ...level.description === undefined ? {} : { description: level.description },
              })),
              // The level a fresh session starts with. Without it the picker adds its own
              // "Default" entry, which duplicates agents that already offer one.
              ...efforts.available.some(level => level.id === efforts.initial) ? { defaultEffort: efforts.initial as ReasoningEffortId } : {},
            },
          },
    }
  }

  /**
   * What the route accepts as input. dsh reads an omitted `inputModalities` as "unknown" and
   * sends images through untouched, while an explicit list without `image` is a negative it
   * acts on by replacing every attachment with text before the adapter is even called. So an
   * agent whose handshake nobody has heard yet must stay silent rather than claim text only.
   */
  private modalities(provider: string): { inputModalities?: readonly ModelModality[] } {
    const mode = this.profiles().get(provider)?.imageInput ?? 'auto'
    // Without an attachment store there are no image bytes to send, whatever the agent accepts.
    if (mode === 'off' || this.host.readImage === undefined)
      return { inputModalities: TEXT_ONLY }
    if (mode === 'force')
      return { inputModalities: TEXT_AND_IMAGE }
    const known = this.promptCapabilitiesOf(provider)
    if (known === undefined)
      return {}
    return { inputModalities: known.image ? TEXT_AND_IMAGE : TEXT_ONLY }
  }

  /** The running agent's handshake answer, else the one it gave for these spawn facts before. */
  private promptCapabilitiesOf(provider: string): AcpPromptCapabilities | undefined {
    const live = this.agents.get(provider)?.process.promptCapabilities
    if (live !== undefined)
      return live
    const profile = this.profiles().get(provider)
    return profile === undefined ? undefined : this.capabilities.get(provider, spawnFacts(profile))
  }

  /**
   * Make sure the ACP handshake has happened at least once, since that is where an agent
   * states the content types it accepts. The answer is cached per route, so this starts an
   * agent only the first time dsh asks about a route it has never heard from.
   */
  private async learnCapabilities(provider: string, signal?: AbortSignal): Promise<void> {
    const profile = this.profiles().get(provider)
    if (profile === undefined || (profile.imageInput ?? 'auto') !== 'auto' || this.host.readImage === undefined)
      return
    if (this.promptCapabilitiesOf(provider) !== undefined)
      return
    await this.agent(provider, profile).probeCapabilities(signal).catch((error: unknown) => {
      this.host.logger.warn(`${PLUGIN_ID}: asking ACP agent "${provider}" which content it accepts failed`, error)
    })
  }

  /** Read every image the prompt wants, as base64 request versions; unreadable ones stay text. */
  private async readImages(wanted: PromptImages['wanted'], signal: AbortSignal | undefined): Promise<Map<string, PromptImage>> {
    const read = new Map<string, PromptImage>()
    const readImage = this.host.readImage
    if (readImage === undefined)
      return read
    await Promise.all([...wanted].map(async ([id, ref]) => {
      try {
        const image = await readImage(ref, signal)
        read.set(id, { data: Buffer.from(image.data).toString('base64'), mimeType: image.mediaType, width: image.width, height: image.height })
      }
      catch (error) {
        this.host.logger.warn(`${PLUGIN_ID}: could not read image attachment ${id}; sending its text handle instead`, error)
      }
    }))
    return read
  }

  override async* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let finished = false
    try {
      for await (const chunk of this.run(options)) {
        finished ||= chunk.type === 'finish'
        yield chunk
      }
    }
    catch (error) {
      if (finished)
        throw error
      yield { type: 'finish', reason: options.signal?.aborted ? { kind: 'aborted', failure: failure('ABORTED', 'request aborted') } : { kind: 'error', failure: failureOf(error) } }
    }
  }

  private async* run(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const route = options.provider
    const startedAt = Date.now()
    const profile = this.profiles().get(route)
    if (profile === undefined)
      throw new LlmError(`${PLUGIN_ID}: no ACP agent is configured for provider "${route}"`, 'PROVIDER_NOT_FOUND')
    const signal = options.signal
    if (signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: failure('ABORTED', 'request aborted before start') } }
      return
    }
    const agent = this.agent(route, profile)
    const purpose = Reflect.get(options, 'purpose') as string | undefined
    const dshSessionId = options.sessionId as string | undefined
    const ephemeral = dshSessionId === undefined || purpose !== undefined
    const key = `${route}\u0000${dshSessionId ?? ''}`
    const cwd = this.cwdOf(dshSessionId, profile)
    const conversation = conversationOf(options)
    const system = profile.systemPrompt === 'forward' ? systemText(options) : undefined

    const effort = options.reasoningEffort as string | undefined
    const trace = new TurnTrace(this.traceFile)
    let images: PromptImages = { read: new Map(), wanted: new Map() }
    let binding = ephemeral ? undefined : this.bindings.get(key)
    let reused = binding !== undefined && binding.session.generation === agent.generation && binding.cwd === cwd && binding.model === options.model
    const consumedBefore = reused ? binding!.consumed : []
    let prompt = reused ? incrementalPrompt(conversation, consumedBefore, route, images) : undefined
    if (prompt === undefined || binding === undefined) {
      reused = false
      if (binding !== undefined)
        agent.closeSession(binding.session)
      trace.stage('session')
      const session = await this.guard(route, 'session', agent.newSession(cwd, signal), profile.startupTimeoutMs)
      trace.stage('select-model')
      await this.guard(route, 'select-model', agent.selectModel(session, options.model, signal), STAGE_TIMEOUT_MS)
      binding = { session, cwd, model: options.model, consumed: [], usage: undefined }
      images = { read: new Map(), wanted: new Map() }
      prompt = fullPrompt(conversation, system, images)
    }
    trace.start({
      route,
      model: options.model,
      dshSession: dshSessionId,
      ephemeral,
      reused,
      promptBlocks: prompt.length,
      promptChars: prompt.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0),
      head: promptHead(prompt),
    })
    const wantedEffort = effort ?? binding.session.efforts?.initial
    if (wantedEffort !== undefined) {
      trace.stage('select-effort')
      await this.guard(route, 'select-effort', agent.selectEffort(binding.session, wantedEffort, signal), STAGE_TIMEOUT_MS)
    }
    if (images.wanted.size > 0 && agent.supportsImages) {
      trace.stage('images')
      images = { read: await this.readImages(images.wanted, signal), wanted: new Map() }
      prompt = reused ? incrementalPrompt(conversation, consumedBefore, route, images) ?? prompt : fullPrompt(conversation, system, images)
    }
    if (!ephemeral)
      this.bindings.set(key, binding)
    binding.consumed = consumedIds(conversation)

    const session = binding.session
    const translator = new ChunkTranslator(profile.showToolCalls)
    const queue: StreamChunk[] = []
    let outcome: Outcome | undefined
    let wake: (() => void) | undefined
    const notify = (): void => {
      wake?.()
      wake = undefined
    }
    const settle = (next: Outcome): void => {
      outcome ??= next
      notify()
    }

    let idleTimer: NodeJS.Timeout | undefined
    const armIdle = (): void => {
      if (profile.idleTimeoutMs <= 0)
        return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        agent.cancel(session)
        settle({ kind: 'timeout' })
      }, profile.idleTimeoutMs)
    }
    let cancelTimer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      agent.cancel(session)
      cancelTimer = setTimeout(() => settle({ kind: 'aborted' }), CANCEL_GRACE_MS)
    }

    this.turns.set(session.sessionId, { dshSessionId, signal })
    signal?.addEventListener('abort', onAbort, { once: true })
    armIdle()
    const model = binding.model
    trace.stage('prompt')
    agent.prompt(session, prompt, (update) => {
      armIdle()
      trace.update(update.sessionUpdate, update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? update.content.text : undefined)
      if (update.sessionUpdate === 'usage_update' && update.size > 0) {
        this.contextWindows.set(route, model, update.size)
        binding.contextSize = update.size
        const meta = Reflect.get(update, '_meta')
        const byCategory = typeof meta === 'object' && meta !== null
          ? Reflect.get(meta, 'codebuddy.ai/usageByCategory')
          : undefined
        if (typeof byCategory === 'object' && byCategory !== null)
          binding.breakdown = byCategory as Record<string, number>
      }
      else if (update.sessionUpdate === 'config_option_update')
        applyConfigOptions(session, update.configOptions)
      queue.push(...translator.push(update))
      notify()
    }).then(
      response => settle({ kind: 'response', response }),
      error => settle({ kind: 'error', error }),
    )

    try {
      while (true) {
        while (queue.length > 0)
          yield queue.shift()!
        if (outcome !== undefined)
          break
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      trace.stage('drain')
      yield* translator.close()
      yield* this.finish(outcome, translator, binding, ephemeral, signal)
    }
    finally {
      clearTimeout(idleTimer)
      clearTimeout(cancelTimer)
      signal?.removeEventListener('abort', onAbort)
      this.turns.delete(session.sessionId)
      if (outcome === undefined)
        agent.cancel(session)
      if (ephemeral)
        agent.closeSession(session)
      trace.end({
        stopReason: outcome?.kind === 'response' ? outcome.response.stopReason : outcome?.kind,
        ms: Date.now() - startedAt,
      })
    }
  }

  private* finish(outcome: Outcome, translator: ChunkTranslator, binding: Binding, ephemeral: boolean, signal: AbortSignal | undefined): Iterable<StreamChunk> {
    if (outcome.kind === 'error') {
      if (signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: failure('ABORTED', 'request aborted') } }
        return
      }
      throw outcome.error
    }
    if (outcome.kind === 'timeout') {
      yield { type: 'finish', reason: { kind: 'error', failure: failure('TIMEOUT', `ACP agent was idle for longer than the configured idleTimeoutMs`) } }
      return
    }
    if (outcome.kind === 'aborted') {
      yield { type: 'finish', reason: { kind: 'aborted', failure: failure('ABORTED', 'request aborted') } }
      return
    }
    const { response } = outcome
    if (response.usage != null) {
      yield { type: 'usage', usage: usageDelta(response.usage, ephemeral ? undefined : binding.usage) }
      binding.usage = response.usage
    }
    switch (response.stopReason) {
      case 'end_turn':
        if (translator.emittedBlocks === 0) {
          yield { type: 'finish', reason: { kind: 'error', failure: failure('EMPTY_RESPONSE', 'ACP agent ended the turn without any content') } }
          return
        }
        yield* contextReport(binding, translator.emittedBlocks)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      case 'max_tokens':
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      case 'cancelled':
        yield { type: 'finish', reason: { kind: 'aborted', failure: failure('ABORTED', 'ACP agent cancelled the turn') } }
        return
      case 'refusal':
        yield { type: 'finish', reason: { kind: 'error', failure: failure('REFUSAL', 'ACP agent refused the request') } }
        return
      default:
        yield { type: 'finish', reason: { kind: 'error', failure: failure('MAX_TURN_REQUESTS', `ACP agent stopped: ${response.stopReason}`) } }
    }
  }

  private agent(route: string, profile: AcpAgentProfile): AcpAgentProcess {
    const existing = this.agents.get(route)
    if (existing !== undefined)
      return existing.process
    const process = new AcpAgentProcess({
      route,
      profile: () => this.profiles().get(route) ?? profile,
      logger: this.host.logger,
      // Remember the handshake answer against the facts that produced it: a route repointed
      // at another command answers for another agent.
      onCapabilities: capabilities => this.capabilities.set(route, this.agents.get(route)?.facts ?? spawnFacts(profile), capabilities),
      onPermission: (sessionId, request) => decidePermission(
        this.host,
        route,
        (this.profiles().get(route) ?? profile).permission,
        this.turns.get(sessionId),
        request,
      ),
    })
    this.agents.set(route, { process, facts: spawnFacts(profile) })
    return process
  }

  /**
   * 等一个提问前的请求，但不等到底。
   *
   * Agent 收下请求却不回应时，界面上只会一直转圈、插件停在某个 await 上，既没有异常也没有
   * 日志。这里给个上限，让它变成一条点名到阶段的错误；同时把这个子进程重启掉——一个请求
   * 已经半开着的连接，后面的回合也不会再用得顺。
   */
  private async guard<T>(route: string, stage: string, action: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.host.logger.warn(`${PLUGIN_ID}: ACP agent "${route}" accepted ${stage} but did not answer within ${ms}ms; restarting it`)
        this.agents.get(route)?.process.restart()
        this.dropBindings(route)
        reject(new LlmError(`${PLUGIN_ID}: ACP agent "${route}" accepted ${stage} but did not answer within ${ms}ms`, 'TRANSPORT'))
      }, ms)
    })
    // 竞速输了之后这个 promise 仍可能 reject，不能让它变成未处理的 rejection。
    action.catch(() => {})
    try {
      return await Promise.race([action, timeout])
    }
    finally {
      clearTimeout(timer)
    }
  }

  private cwdOf(dshSessionId: string | undefined, profile: AcpAgentProfile): string {
    const sessionCwd = dshSessionId === undefined ? undefined : this.host.agentOf(dshSessionId)?.session.header.cwd
    return sessionCwd ?? profile.cwd ?? homedir()
  }

  private dropBindings(route: string): void {
    for (const key of this.bindings.keys()) {
      if (key.startsWith(`${route}\u0000`))
        this.bindings.delete(key)
    }
  }
}
