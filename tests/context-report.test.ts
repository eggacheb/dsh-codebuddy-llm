import { describe, expect, it } from 'vitest'
import { contextReport } from '../src/host/service/acp-adapter.ts'

function binding(breakdown: Record<string, number> | undefined, contextSize?: number): any {
  return { breakdown, contextSize }
}

describe('context report', () => {
  it('renders the breakdown CodeBuddy reported, with share and window', () => {
    const chunks = [...contextReport(binding({ systemPrompt: 891, tools: 10_915, conversation: 643, mcp: 17, skills: 369 }, 1_000_000), 2)]
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'reasoning-delta', 'block-end'])

    const start = chunks[0] as { index: number, blockType: string }
    expect(start.index).toBe(2)
    expect(start.blockType).toBe('reasoning')

    const text = (chunks[1] as { text: string }).text
    expect(text).toContain('上下文 12.8K / 1.0M（1.3%）')
    expect(text).toContain('工具 10.9K')
    expect(text).toContain('提示词 891')
    expect(text).toContain('技能 369')
  })

  it('says nothing when the agent never reported a breakdown', () => {
    expect([...contextReport(binding(undefined), 0)]).toEqual([])
  })

  it('drops categories that are zero', () => {
    const chunks = [...contextReport(binding({ tools: 5000, conversation: 200, mcp: 0, skills: 0 }, 100_000), 0)]
    const text = (chunks[1] as { text: string }).text
    expect(text).not.toContain('MCP')
    expect(text).not.toContain('技能')
    expect(text).not.toContain('提示词')
  })

  it('keeps the totals when the window is unknown', () => {
    const chunks = [...contextReport(binding({ tools: 1200 }), 0)]
    const text = (chunks[1] as { text: string }).text
    expect(text).toBe('上下文 1.2K｜工具 1.2K')
  })
})
