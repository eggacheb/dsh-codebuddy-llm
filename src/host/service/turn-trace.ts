import { appendFileSync, renameSync, statSync } from 'node:fs'

/**
 * 一次模型回合的轨迹。
 *
 * 为什么要有它：ACP 这一侧最容易出的故障是「某个请求发出去就没回来」，此时界面上只会
 * 一直转圈，插件自己也停在某个 await 上 —— 既没有异常，也没有日志。所以这里按阶段
 * **逐条落盘**（而不是结束时汇总），卡住时最后一行的 `stage` 就是卡住的位置。
 *
 * 体积控制：一行一百多字节，一次回合三四行；超过上限就轮转成 `.1`。
 */
const MAX_BYTES = 256 * 1024

export interface TraceStart {
  route: string
  model: string
  dshSession: string | undefined
  ephemeral: boolean
  reused: boolean
  promptBlocks: number
  promptChars: number
  head: string
}

export interface TraceEnd {
  stopReason: string | undefined
  ms: number
  error?: string
}

export class TurnTrace {
  private readonly lines: string[] = []
  private flushed = 0
  private textBlocks = 0
  private textChars = 0
  private reasoningBlocks = 0
  private toolCalls = 0
  private updates = 0
  private readonly startedAt = Date.now()

  constructor(private readonly file: string | undefined) {}

  start(fields: TraceStart): void {
    this.push({ t: 'start', ...fields })
  }

  /** 记下「正要等这一步」。它会立刻落盘，所以卡住时的最后一行就是卡住的位置。 */
  stage(name: string): void {
    this.push({ t: 'stage', name, ms: Date.now() - this.startedAt })
  }

  /** 一条 ACP 通知的摘要：只累计数量与正文长度，正文留一小截方便认出在说什么。 */
  update(kind: string, text: string | undefined): void {
    this.updates++
    switch (kind) {
      case 'agent_message_chunk':
        if (text !== undefined && text.length > 0) {
          this.textBlocks++
          this.textChars += text.length
        }
        break
      case 'agent_thought_chunk':
        this.reasoningBlocks++
        break
      case 'tool_call':
      case 'tool_call_update':
        this.toolCalls++
        break
      default:
        break
    }
  }

  end(fields: TraceEnd): void {
    this.push({
      t: 'end',
      stopReason: fields.stopReason,
      ms: fields.ms,
      textChunks: this.textBlocks,
      textChars: this.textChars,
      reasoningChunks: this.reasoningBlocks,
      toolCalls: this.toolCalls,
      updates: this.updates,
      ...fields.error === undefined ? {} : { error: fields.error },
    })
  }

  private push(line: Record<string, unknown>): void {
    this.lines.push(`${JSON.stringify(line)}\n`)
    this.flush()
  }

  private flush(): void {
    if (this.file === undefined || this.lines.length === this.flushed)
      return
    const chunk = this.lines.slice(this.flushed).join('')
    this.flushed = this.lines.length
    try {
      rotate(this.file)
      appendFileSync(this.file, chunk)
    }
    catch {
      // 轨迹是诊断用的，写不进去不能影响对话本身。
    }
  }
}

function rotate(file: string): void {
  try {
    if (statSync(file).size < MAX_BYTES)
      return
    renameSync(file, `${file}.1`)
  }
  catch {
    // 文件还不存在：第一次写，不用轮转。
  }
}
