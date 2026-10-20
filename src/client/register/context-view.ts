import type { ContextViewProps } from '../components/context-view.tsx'
import type { AcpClientContext } from '../types/runtime.ts'
import { PLUGIN_ID } from '../../shared/constants.ts'
import { ContextView } from '../components/context-view.tsx'
import { NS, translator } from '../locales/index.ts'

const ENTRY = PLUGIN_ID

const VIEW_ID = 'acp-context'

/** 排在 Chat / Trajectory / 内置「上下文」之后。 */
const VIEW_ORDER = 50

/**
 * 会话标签页「上下文用量」。
 *
 * 放在 `conversation.view` 而不是设置页：改窗口和看构成是同一件事，用户不想为它
 * 离开对话。写回走 `configForms`，与设置页同一条通道，不需要新的 host 接口。
 */
export function registerContextView(ctx: AcpClientContext): () => void {
  const t = translator(ctx.locale)
  return ctx.configForms.whileServed([ENTRY], () => {
    const props: ContextViewProps = { form: ctx.configForms.get(ENTRY), t }
    return ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view',
      id: VIEW_ID,
      order: VIEW_ORDER,
      locale: NS,
      label: () => t('contextViewTab'),
      inject: () => props,
    }, ContextView))
  })
}
