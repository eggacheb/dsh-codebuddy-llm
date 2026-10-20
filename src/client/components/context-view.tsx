import type { ReactElement } from 'react'
import type { AcpAgentProfile } from '../../shared/types.ts'
import type { Translate } from '../locales/index.ts'
import type { ConfigForm, JsonValue } from '../types/runtime.ts'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { saveAgent } from '../service/agents.ts'
import { snapshotOf } from '../service/agents.utils.ts'
import { ContextUsageHint } from './context-usage.tsx'

/** 与设置页同一组档位。 */
const WINDOW_PRESETS = [300_000, 600_000, 1_000_000] as const

function presetEnabled(env: Record<string, string>): boolean {
  const value = env.CODEBUDDY_MAIN_AGENT_ALLOW_UNOPTED
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

function formatWindow(count: number): string {
  return count >= 1_000_000 ? `${count / 1_000_000}M` : `${Math.round(count / 1000)}K`
}

/**
 * 把 schema 解析后的 profile 变成可写回配置的纯 JSON。
 *
 * 走 `row.profile` 而不是 `row.user`：用户层可能只写了几个字段，直接写回会把
 * 默认值以外的内容丢掉；schema 解析结果已经补齐，功能等价。
 */
function profileJson(profile: AcpAgentProfile, contextWindow: number): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify({ ...profile, contextWindow })) as Record<string, JsonValue>
}

export interface ContextViewProps {
  form: ConfigForm
  t: Translate
}

/**
 * 会话标签页：改上下文窗口 + 看构成，不用离开对话。
 *
 * 数据是实测参考值而不是实时监控——固定开销在同一模型、同一预设下基本不变，
 * 这里要回答的是「这块窗口里有多少是固定成本」，不是「这一轮花了多少」。
 */
export function ContextView({ form, t }: ContextViewProps): ReactElement {
  // ConfigForm methods read their own `this`; never hand them to React unbound.
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const agents = useMemo(() => snapshotOf(snapshot), [snapshot])
  const writable = snapshot.status === 'ready' && agents.writable

  const [edits, setEdits] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const windowOf = (route: string): number =>
    edits[route] ?? agents.rows.find(row => row.route === route)?.profile.contextWindow ?? 0

  async function apply(route: string): Promise<void> {
    const row = agents.rows.find(item => item.route === route)
    if (row === undefined)
      return
    setSaving(route)
    setNote(null)
    const result = await saveAgent({
      form,
      originalRoute: route,
      route,
      profile: profileJson(row.profile, windowOf(route)),
    })
    setSaving(null)
    if (result.ok) {
      setEdits((current) => {
        const next = { ...current }
        delete next[route]
        return next
      })
      setNote(t('contextViewSaved'))
    }
    else {
      setNote(result.error ?? t('refused'))
    }
  }

  return (
    <div className="dta-root dta-context-view">
      <div className="dta-head">
        <div className="dta-head-text">
          <div className="dta-title">{t('contextViewTitle')}</div>
          <div className="dta-hint">{t('contextViewHint')}</div>
        </div>
      </div>
      {agents.rows.length === 0 && <div className="dta-empty">{t('empty')}</div>}
      {agents.rows.map((row) => {
        const value = windowOf(row.route)
        const busy = saving === row.route
        return (
          <div key={row.route} className="dta-context-card">
            <div className="dta-context-head">
              <span className="dta-name-text">{row.profile.displayName ?? row.route}</span>
              <span className="dta-sub">{row.route}</span>
            </div>
            <div className="dta-window-row">
              <input
                className="dta-input"
                type="number"
                min={1000}
                step={1000}
                value={value}
                disabled={!writable || busy}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (Number.isFinite(next) && next > 0)
                    setEdits(current => ({ ...current, [row.route]: Math.round(next) }))
                }}
              />
              {WINDOW_PRESETS.map(option => (
                <button
                  key={option}
                  type="button"
                  className="dta-chip"
                  data-active={value === option}
                  disabled={!writable || busy}
                  onClick={() => setEdits(current => ({ ...current, [row.route]: option }))}
                >
                  {formatWindow(option)}
                </button>
              ))}
              <button
                type="button"
                className="dta-chip"
                data-active
                disabled={!writable || busy || edits[row.route] === undefined}
                onClick={() => void apply(row.route)}
              >
                {busy ? t('saving') : t('save')}
              </button>
            </div>
            <ContextUsageHint contextWindow={value} presetEnabled={presetEnabled(row.profile.env)} t={t} />
          </div>
        )
      })}
      {note !== null && <div className="dta-banner" data-tone="ok">{note}</div>}
    </div>
  )
}
