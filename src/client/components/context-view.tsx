import type { ReactElement } from 'react'
import type { AcpAgentProfile } from '../../shared/types.ts'
import type { Translate } from '../locales/index.ts'
import type { ConfigForm, JsonValue } from '../types/runtime.ts'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { saveAgent } from '../service/agents.ts'
import { snapshotOf } from '../service/agents.utils.ts'
import { ContextUsageHint } from './context-usage.tsx'

/** dsh 窗口的快捷档位。 */
const WINDOW_PRESETS = [300_000, 600_000, 1_000_000] as const

/** CodeBuddy 压缩窗口的快捷档位（它会夹在 100K–1M 之间）。 */
const COMPACT_PRESETS = [200_000, 400_000, 1_000_000] as const

const COMPACT_WINDOW_ENV = 'CODEBUDDY_AUTO_COMPACT_WINDOW'
const COMPACT_PCT_ENV = 'CODEBUDDY_AUTOCOMPACT_PCT_OVERRIDE'

/** CodeBuddy 源码里的默认窗口（模型窗口未知时）与默认触发比例。 */
const COMPACT_FALLBACK_WINDOW = 1_000_000
const COMPACT_DEFAULT_PCT = 85

function presetEnabled(env: Record<string, string>): boolean {
  const value = env.CODEBUDDY_MAIN_AGENT_ALLOW_UNOPTED
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

function formatWindow(count: number): string {
  return count >= 1_000_000 ? `${count / 1_000_000}M` : `${Math.round(count / 1000)}K`
}

function numberIn(env: Record<string, string>, key: string): number | undefined {
  const raw = env[key]
  if (raw === undefined)
    return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function compactWindowOf(profile: AcpAgentProfile): number {
  return numberIn(profile.env, COMPACT_WINDOW_ENV) ?? profile.contextWindow ?? COMPACT_FALLBACK_WINDOW
}

function compactPctOf(profile: AcpAgentProfile): number {
  return numberIn(profile.env, COMPACT_PCT_ENV) ?? COMPACT_DEFAULT_PCT
}

/**
 * 把 schema 解析后的 profile 变成可写回配置的纯 JSON。
 *
 * 走 `row.profile` 而不是 `row.user`：用户层可能只写了几个字段，直接写回会丢掉
 * 其余默认值。
 */
function profileJson(
  profile: AcpAgentProfile,
  contextWindow: number,
  env: Record<string, string>,
): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify({ ...profile, contextWindow, env })) as Record<string, JsonValue>
}

/** 一页之内的待保存改动。 */
interface Edits {
  contextWindow?: number
  compactWindow?: number
  compactPct?: number
}

export interface ContextViewProps {
  form: ConfigForm
  /** dsh 自己的 compaction-basic 表单；读不到时为 undefined。 */
  compaction?: ConfigForm
  t: Translate
}

const COMPACTION_FALLBACK: ConfigForm = {
  getSnapshot: () => ({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' }),
  subscribe: () => () => {},
  mutate: async () => false,
}

const COMPACTION_YAML = `- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: false
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16`

/**
 * 会话标签页：窗口与压缩都在这改，不用离开对话。
 *
 * 两套窗口说清楚：
 * - **dsh 窗口** = dsh 认为的上下文上限，`compaction-basic` 未启用时它只是上限提示。
 * - **CodeBuddy 压缩窗口** = 真正在压的那个；触发点 = 窗口 × 比例。
 */
export function ContextView({ form, compaction, t }: ContextViewProps): ReactElement {
  // ConfigForm methods read their own `this`; never hand them to React unbound.
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const agents = useMemo(() => snapshotOf(snapshot), [snapshot])
  const writable = snapshot.status === 'ready' && agents.writable

  const compactionForm = compaction ?? COMPACTION_FALLBACK
  const compactionSubscribe = useCallback((listener: () => void) => compactionForm.subscribe(listener), [compactionForm])
  const compactionGet = useCallback(() => compactionForm.getSnapshot(), [compactionForm])
  const compactionSnapshot = useSyncExternalStore(compactionSubscribe, compactionGet, compactionGet)
  const compactionValue = compactionSnapshot.value as { disabled?: boolean, config?: { thresholdRatio?: number, retainRatio?: number } } | undefined
  const compactionKnown = compactionSnapshot.status === 'ready' && compactionValue !== undefined
  const compactionEnabled = compactionKnown ? compactionValue?.disabled !== true : undefined
  const compactionRatio = compactionValue?.config?.thresholdRatio

  const [edits, setEdits] = useState<Record<string, Edits>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  function edit(route: string, patch: Edits): void {
    setEdits(current => ({ ...current, [route]: { ...current[route], ...patch } }))
  }

  async function apply(route: string): Promise<void> {
    const row = agents.rows.find(item => item.route === route)
    if (row === undefined)
      return
    const current = edits[route] ?? {}
    const contextWindow = current.contextWindow ?? row.profile.contextWindow
    const compactWindow = current.compactWindow ?? compactWindowOf(row.profile)
    const compactPct = current.compactPct ?? compactPctOf(row.profile)

    const env: Record<string, string> = {
      ...row.profile.env,
      [COMPACT_WINDOW_ENV]: String(compactWindow),
      [COMPACT_PCT_ENV]: String(compactPct),
    }

    setSaving(route)
    setNote(null)
    const result = await saveAgent({
      form,
      originalRoute: route,
      route,
      profile: profileJson(row.profile, contextWindow, env),
    })
    setSaving(null)
    if (result.ok) {
      setEdits((existing) => {
        const next = { ...existing }
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
        const current = edits[row.route] ?? {}
        const windowValue = current.contextWindow ?? row.profile.contextWindow
        const compactWindow = current.compactWindow ?? compactWindowOf(row.profile)
        const compactPct = current.compactPct ?? compactPctOf(row.profile)
        const triggerAt = Math.round(compactWindow * compactPct / 100)
        const dirty = Object.keys(current).length > 0
        const busy = saving === row.route
        return (
          <div key={row.route} className="dta-context-card">
            <div className="dta-context-head">
              <span className="dta-name-text">{row.profile.displayName ?? row.route}</span>
              <span className="dta-sub">{row.route}</span>
            </div>

            <div className="dta-section-label">{t('contextDshWindow')}</div>
            <div className="dta-window-row">
              <input
                className="dta-input"
                type="number"
                min={1000}
                step={1000}
                value={windowValue}
                disabled={!writable || busy}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (Number.isFinite(next) && next > 0)
                    edit(row.route, { contextWindow: Math.round(next) })
                }}
              />
              {WINDOW_PRESETS.map(option => (
                <button
                  key={option}
                  type="button"
                  className="dta-chip"
                  data-active={windowValue === option}
                  disabled={!writable || busy}
                  onClick={() => edit(row.route, { contextWindow: option })}
                >
                  {formatWindow(option)}
                </button>
              ))}
            </div>
            <div className="dta-hint">{t('contextDshWindowHint')}</div>

            <ContextUsageHint contextWindow={windowValue} presetEnabled={presetEnabled(row.profile.env)} t={t} />

            <div className="dta-section-label">
              {t('contextCompact')}
              {' '}
              <span className="dta-hint">{t('contextCompactTrigger', { tokens: formatWindow(triggerAt) })}</span>
            </div>
            <div className="dta-window-row">
              <span className="dta-inline-label">{t('contextCompactWindow')}</span>
              <input
                className="dta-input"
                type="number"
                min={100_000}
                max={1_000_000}
                step={10_000}
                value={compactWindow}
                disabled={!writable || busy}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (Number.isFinite(next) && next > 0)
                    edit(row.route, { compactWindow: Math.round(next) })
                }}
              />
              {COMPACT_PRESETS.map(option => (
                <button
                  key={option}
                  type="button"
                  className="dta-chip"
                  data-active={compactWindow === option}
                  disabled={!writable || busy}
                  onClick={() => edit(row.route, { compactWindow: option })}
                >
                  {formatWindow(option)}
                </button>
              ))}
            </div>
            <div className="dta-window-row">
              <span className="dta-inline-label">{t('contextCompactPct')}</span>
              <input
                className="dta-input dta-input-narrow"
                type="number"
                min={1}
                max={100}
                step={1}
                value={compactPct}
                disabled={!writable || busy}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (Number.isFinite(next) && next >= 1 && next <= 100)
                    edit(row.route, { compactPct: Math.round(next) })
                }}
              />
              <span className="dta-hint">%</span>
            </div>
            <div className="dta-hint">{t('contextCompactHint')}</div>
            {compactWindow > windowValue && <div className="dta-banner" data-tone="error">{t('contextCompactMismatch')}</div>}

            <div className="dta-window-row dta-window-actions">
              <button
                type="button"
                className="dta-chip"
                data-active
                disabled={!writable || busy || !dirty}
                onClick={() => void apply(row.route)}
              >
                {busy ? t('saving') : t('save')}
              </button>
            </div>
          </div>
        )
      })}
      <div className="dta-footnote">
        <div className="dta-section-label">{t('contextDshCompact')}</div>
        <div className="dta-hint">
          {compactionKnown
            ? compactionEnabled
              ? t('contextDshCompactOn', { ratio: compactionRatio === undefined ? '0.8' : String(compactionRatio) })
              : t('contextDshCompactOff')
            : t('contextDshCompactUnknown')}
        </div>
        <div className="dta-hint">{t('contextDshCompactNote')}</div>
        <div className="dta-window-row dta-window-actions">
          <button
            type="button"
            className="dta-chip"
            onClick={() => {
              void navigator.clipboard?.writeText(COMPACTION_YAML)
              setNote(t('contextDshCompactCopied'))
            }}
          >
            {t('contextDshCompactCopy')}
          </button>
        </div>
      </div>
      {note !== null && <div className="dta-banner" data-tone="ok">{note}</div>}
    </div>
  )
}
