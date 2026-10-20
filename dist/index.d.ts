import z from "@deepseek-ai/schemastery";
import { GenerateOptions, LlmAdapter, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
import { Volatile } from "@deepseek-ai/cosmokit";

//#region src/shared/types.d.ts
/** Profile shapes shared by the host schema and the client settings editor. */
type PermissionPolicy = 'ask' | 'allow' | 'read-only' | 'reject';
type SystemPromptMode = 'drop' | 'forward';
/**
 * Whether the route offers image input. `auto` follows the `promptCapabilities` the agent
 * declares in its ACP handshake; the other two override an agent that misreports them.
 */
type ImageInputMode = 'auto' | 'force' | 'off';
/**
 * `whitelist`：只放行已知安全的变量（默认）。
 * `inherit`：继承宿主环境，仅挡掉会改变 CLI 认证判定或抢端口的那些。
 */
type EnvMode = 'whitelist' | 'inherit';
interface AcpModelProfile {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
}
interface AcpAgentProfile {
  displayName?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  envMode: EnvMode;
  cwd?: string;
  authMethod?: string;
  models: AcpModelProfile[];
  discoverModels: boolean;
  permission: PermissionPolicy;
  imageInput: ImageInputMode;
  systemPrompt: SystemPromptMode;
  showToolCalls: boolean;
  contextWindow: number;
  startupTimeoutMs: number;
  idleTimeoutMs: number;
}
//#endregion
//#region src/host/config/schema.d.ts
type AgentProfiles = Record<string, AcpAgentProfile>;
interface Config {
  /**
   * Volatile so DSH 0.2 settings serve it as an editable form and commit edits in place
   * (`loader/volatile-update`) instead of restarting the plugin.
   */
  agents: Volatile<AgentProfiles>;
}
declare const AcpAgentProfile: z<AcpAgentProfile>;
declare const Config: z<{
  agents: AgentProfiles;
}, Config>;
//#endregion
//#region src/host/apply.d.ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 0.2 Loader: volatile config fields of this fiber were committed in place. */
    'loader/volatile-update': (paths: string[][]) => void;
  }
}
declare function apply(ctx: Context, config: Config): void;
//#endregion
//#region src/host/types/index.d.ts
interface HostLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
interface HostAgent {
  readonly session: {
    readonly header: {
      readonly cwd?: string;
    };
  };
}
interface ApprovalRequest {
  agent: HostAgent;
  toolName: string;
  reason?: string;
  signal?: AbortSignal;
}
/** One image attachment re-encoded for a model request. */
interface HostImage {
  data: Uint8Array;
  mediaType: string;
  width: number;
  height: number;
}
interface AdapterHost {
  logger: HostLogger;
  agentOf: (sessionId: string) => HostAgent | undefined;
  approve: ((request: ApprovalRequest) => Promise<ApprovalOutcome>) | undefined;
  /** Request-sized bytes of one image attachment; absent when no attachment store is mounted. */
  readImage: ((ref: unknown, signal?: AbortSignal) => Promise<HostImage>) | undefined;
}
//#endregion
//#region src/host/service/prompt-capabilities.d.ts
/**
 * The prompt content one ACP agent accepts, exactly as its `initialize` answer declares it.
 * ACP has no other place to ask: an agent states its accepted content types once, during
 * the handshake, so the answer is learned by starting the agent and kept afterwards.
 */
interface AcpPromptCapabilities {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}
/**
 * Prompt capabilities agents answered with during `initialize`, keyed by route. dsh asks a
 * route what input it accepts before the user can attach anything, which is earlier than the
 * first turn that would start the agent; with a `file` the last answer survives restarts, so
 * a route reports image input straight away instead of claiming text only until it is used.
 *
 * Each entry remembers the spawn facts it came from: a route pointed at a different command
 * answers for a different agent, so its stored answer is ignored until the new one speaks.
 */
declare class PromptCapabilitiesCache {
  private readonly file?;
  private readonly logger?;
  private readonly entries;
  private saving;
  constructor(file?: string | undefined, logger?: HostLogger | undefined);
  get(route: string, facts: string): AcpPromptCapabilities | undefined;
  set(route: string, facts: string, capabilities: AcpPromptCapabilities): void;
  /** Settles once every answer stored so far is on disk. */
  flush(): Promise<void>;
}
//#endregion
//#region src/host/service/acp-agent.d.ts
interface AcpAdvertisedModel {
  id: string;
  name: string;
  description?: string;
}
//#endregion
//#region src/host/service/context-windows.d.ts
/**
 * Context window sizes agents reported through `usage_update`, keyed by route and model.
 * dsh resolves a model's window before each request, so a size learned only in memory
 * leaves the first turn after every restart on the configured default; with a `file`
 * the sizes survive restarts.
 */
declare class ContextWindows {
  private readonly file?;
  private readonly logger?;
  private readonly sizes;
  private saving;
  constructor(file?: string | undefined, logger?: HostLogger | undefined);
  get(route: string, model: string): number | undefined;
  set(route: string, model: string, size: number): void;
  /** Settles once every size set so far is on disk. */
  flush(): Promise<void>;
}
//#endregion
//#region src/host/service/acp-adapter.d.ts
declare class AcpAdapter extends LlmAdapter {
  private readonly host;
  private readonly profiles;
  private readonly contextWindows;
  private readonly capabilities;
  private readonly traceFile;
  private readonly agents;
  private readonly bindings;
  private readonly turns;
  private readonly retryPolicy;
  constructor(host: AdapterHost, profiles: () => ReadonlyMap<string, AcpAgentProfile>, contextWindows?: ContextWindows, capabilities?: PromptCapabilitiesCache, traceFile?: string | undefined);
  sync(): void;
  dispose(): void;
  providerInfo(provider: string): LlmProviderInfo;
  providerRetryPolicy(): ResolvedRetryPolicy;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  /**
   * Ask the agent behind one configured route which models it advertises, regardless of
   * the profile's declared `models` and `discoverModels` switch. Settings surfaces use this
   * to offer the agent's own list for adoption.
   */
  advertisedModels(provider: string, signal?: AbortSignal): Promise<readonly AcpAdvertisedModel[]>;
  /**
   * Exact-model metadata. Capabilities come from the agent itself: accepted input from the
   * `promptCapabilities` of its ACP handshake (learned here, remembered across restarts),
   * reasoning efforts from its `thought_level` option, and the context window it last
   * reported through `usage_update`, else one a "1m" token in the model's id, name or
   * description implies.
   */
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  /**
   * What the route accepts as input. dsh reads an omitted `inputModalities` as "unknown" and
   * sends images through untouched, while an explicit list without `image` is a negative it
   * acts on by replacing every attachment with text before the adapter is even called. So an
   * agent whose handshake nobody has heard yet must stay silent rather than claim text only.
   */
  private modalities;
  /** The running agent's handshake answer, else the one it gave for these spawn facts before. */
  private promptCapabilitiesOf;
  /**
   * Make sure the ACP handshake has happened at least once, since that is where an agent
   * states the content types it accepts. The answer is cached per route, so this starts an
   * agent only the first time dsh asks about a route it has never heard from.
   */
  private learnCapabilities;
  /** Read every image the prompt wants, as base64 request versions; unreadable ones stay text. */
  private readImages;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  private run;
  private finish;
  private agent;
  /**
   * 等一个提问前的请求，但不等到底。
   *
   * Agent 收下请求却不回应时，界面上只会一直转圈、插件停在某个 await 上，既没有异常也没有
   * 日志。这里给个上限，让它变成一条点名到阶段的错误；同时把这个子进程重启掉——一个请求
   * 已经半开着的连接，后面的回合也不会再用得顺。
   */
  private guard;
  private cwdOf;
  private dropBindings;
}
//#endregion
//#region src/index.d.ts
declare const name = "dsh-codebuddy-llm";
declare const inject: string[];
//#endregion
export { AcpAdapter, type AcpAgentProfile, type AcpModelProfile, Config, type PermissionPolicy, type SystemPromptMode, apply, inject, name };