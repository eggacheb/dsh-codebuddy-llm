/**
 * Narrow projections of the official client services this plugin uses on DSH 0.2 cores
 * (`configForms` from dsh-client-ui-settings, `locale`, `slots`, and the `remote.llm`
 * Remote namespace). Only the members called here are declared.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type SettingsPathOpView
  = | { op: 'set', path: string[], value: JsonValue }
    | { op: 'unset', path: string[] }

/** Client-side state of one settings namespace (`ConfigFormSnapshot`). */
export interface ConfigFormSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  /** Schema-resolved section. */
  value: JsonValue | undefined
  /** Composition layer (profile bundle / YAML) the value resolves over. */
  base: unknown
  /** Raw user layer; presence of a field marks it overridden. */
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

/** One namespace's values and serialized writes (`ConfigForm`). */
export interface ConfigForm {
  getSnapshot: () => ConfigFormSnapshot
  subscribe: (listener: () => void) => () => void
  /** Resolves true when the Host accepted the ops; a refused write reloads Host state and resolves false. */
  mutate: (ops: readonly SettingsPathOpView[], expectedRevision?: number) => Promise<boolean>
}

export interface ConfigFormsService {
  get: (entryId: string) => ConfigForm
  whileServed: (namespaces: readonly string[], register: () => () => void) => () => void
}

export interface LocaleService {
  register: (namespace: string, dicts: { zh: Record<string, string>, en: Record<string, string> }) => () => void
  bind: (namespace: string) => (key: string) => string
}

export interface SettingsSectionEntry<P> {
  name: 'settings.section'
  id: string
  order: number
  locale: string
  label: () => string
  inject: () => P
}

/** A session-scoped tab beside Chat / Trajectory (`conversation.view`). */
export interface ConversationViewEntry<P> {
  name: 'conversation.view'
  id: string
  order?: number
  locale: string
  label: () => string
  /** Receives the bound session id; return the props the component reads. */
  inject?: (sessionId: string) => P
}

export interface SlotsService {
  inject: (name: string, register: () => () => void) => () => void
  register: <P extends object>(
    entry: SettingsSectionEntry<P> | ConversationViewEntry<P>,
    component: ComponentType<P>,
  ) => () => void
}

export interface RemoteFailure {
  code: string
  message: string
}

export type RemoteResult<T>
  = | { ok: true, value: T }
    | { ok: false, error: RemoteFailure }

export interface LlmDiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
}

export interface LlmRemote {
  discoverModels: (settingsNs: string, request: { provider?: string }) => Promise<RemoteResult<LlmDiscoveredModel[]>>
}

export type AcpClientContext = Context & {
  configForms: ConfigFormsService
  locale: LocaleService
  slots: SlotsService
  remote: { llm: LlmRemote }
}
