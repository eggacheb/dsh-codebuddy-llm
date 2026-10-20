import type { AcpClientContext } from './types/runtime.ts'
import { PLUGIN_ID } from '../shared/constants.ts'
import { en, NS, zh } from './locales/index.ts'
import { registerAgentsSection } from './register/agents-section.ts'
import { registerContextView } from './register/context-view.ts'
import { registerStyles } from './register/styles.ts'

export const name = PLUGIN_ID

export const inject = ['slots', 'locale', 'remote', 'remote.llm', 'configForms']

export function apply(ctx: AcpClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${PLUGIN_ID}: locale dictionaries`)
  ctx.effect(registerStyles, `${PLUGIN_ID}: page styles`)
  ctx.effect(() => registerAgentsSection(ctx), `${PLUGIN_ID}: agents settings section`)
  ctx.effect(() => registerContextView(ctx), `${PLUGIN_ID}: context view`)
}
