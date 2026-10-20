import type { ReactElement } from 'react'
import type { LocaleKey, Translate } from '../locales/index.ts'

/**
 * CodeBuddy 在不同 Agent 预设下的实测固定开销（token）。
 *
 * 数字来自本机 ACP 会话的 `usage_update._meta["codebuddy.ai/usageByCategory"]`，
 * 同一模型、同一预设下基本恒定；对话部分会随历史增长，所以只作参考。
 * 标准预设：deepseek-v4.1-flash，工具全量。
 * PTC 预设：工具收进 REPL，`--tools` 那一层降到 11k。
 */
const PTC_BREAKDOWN = { systemPrompt: 909, tools: 11_234, conversation: 656, mcp: 4, skills: 470 }
const STANDARD_BREAKDOWN = { systemPrompt: 2_806, tools: 41_038, conversation: 2_418, mcp: 0, skills: 1_385 }

const COLORS: Record<string, string> = {
  tools: '#4f7cff',
  systemPrompt: '#8b6cff',
  conversation: '#25a97a',
  skills: '#e0a021',
  mcp: '#9aa3b2',
}

const ORDER = ['tools', 'systemPrompt', 'conversation', 'skills', 'mcp'] as const

/** 扁平 key（`Translate` 不做嵌套查找）。 */
const LABELS: Record<string, LocaleKey> = {
  tools: 'contextUsageTools',
  systemPrompt: 'contextUsageSystemPrompt',
  conversation: 'contextUsageConversation',
  skills: 'contextUsageSkills',
  mcp: 'contextUsageMcp',
}

function formatTokens(count: number): string {
  if (count >= 1_000_000)
    return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000)
    return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}

export interface ContextUsageHintProps {
  contextWindow: number
  /** 路由 env 里有没有开 `CODEBUDDY_MAIN_AGENT_ALLOW_UNOPTED`：没开就按标准预设估算。 */
  presetEnabled: boolean
  t: Translate
}

/**
 * 「改窗口大小时顺手看一眼」的参考条：不订阅任何实时数据，只把实测值按当前窗口折算。
 *
 * 放在 `contextWindow` 字段下面而不是输入框旁边，是因为这里要的是「这块窗口里有多少
 * 是固定开销」这个判断，不是每轮的实时监控。
 */
export function ContextUsageHint({ contextWindow, presetEnabled, t }: ContextUsageHintProps): ReactElement {
  const source = presetEnabled ? PTC_BREAKDOWN : STANDARD_BREAKDOWN
  const slices = ORDER
    .map(key => ({ key, tokens: source[key], color: COLORS[key] ?? '#9aa3b2' }))
    .filter(slice => slice.tokens > 0)
  const total = slices.reduce((sum, slice) => sum + slice.tokens, 0)
  const share = contextWindow > 0 ? (total / contextWindow) * 100 : 0

  return (
    <div className="dta-usage">
      <div className="dta-usage-head">
        <span>{t('contextUsage')}</span>
        <span className="dta-usage-total">
          {formatTokens(total)}
          {contextWindow > 0 ? ` · ${share.toFixed(1)}%` : ''}
        </span>
      </div>
      <div className="dta-usage-bar">
        {slices.map(slice => (
          <span
            key={slice.key}
            style={{ width: `${(slice.tokens / total) * 100}%`, background: slice.color }}
          />
        ))}
      </div>
      <div className="dta-usage-legend">
        {slices.map(slice => (
          <span key={slice.key}>
            <i style={{ background: slice.color }} />
            {t(LABELS[slice.key] ?? 'contextUsageTools')}
            {' '}
            {formatTokens(slice.tokens)}
          </span>
        ))}
      </div>
      <div className="dta-hint">{t('contextUsageHint')}</div>
      {!presetEnabled && <div className="dta-hint">{t('contextUsagePresetHint')}</div>}
    </div>
  )
}
