import { describe, expect, it } from 'vitest'
import { childEnv } from '../src/host/service/child-env.ts'

const HOSTILE = {
  PATH: '/usr/bin',
  LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
  // 宿主发布自己的网关端口，子进程读同一份设置就会去 bind 同一个地址。
  SERVER__PORT: '12118',
  SERVER__HOST: '127.0.0.1',
  // 宿主自己的身份与会话。
  CODEBUDDY_CONFIG_DIR: 'C:\\Users\\someone\\.workbuddy',
  CODEBUDDY_HOST: 'workbuddy-desktop',
  CODEBUDDY_GATEWAY_AUTH: 'password',
  CODEBUDDY_GATEWAY_PASSWORD: 'secret',
  CODEBUDDY_HOST_CAPABILITIES: 'elicitation.form',
  CODEBUDDY_SESSION_ID: 'ffda6149',
  CODEBUDDY_CONVERSATION_REQUEST_ID: '01a14f18',
  CODEBUDDY_TOOL_CALL_ID: 'call_00',
  CODEBUDDY_FORCE_HEADLESS_BUNDLE: '1',
  CLAUDE_PROJECT_DIR: 'C:/Users/someone/WorkBuddy/session',
  CLAUDE_SESSION_ID: 'ffda6149',
  // 前缀之内但要留住的。
  CODEBUDDY_API_KEY: 'sk-test',
  CODEBUDDY_BASE_URL: 'https://example.invalid',
  CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
} as const

describe('child environment', () => {
  const env = childEnv({ ...HOSTILE })

  it('keeps everything the child needs to be itself', () => {
    expect(env.PATH).toBe('/usr/bin')
    expect(env.LOCALAPPDATA).toBe(HOSTILE.LOCALAPPDATA)
  })

  it('credential-looking variables survive the prefix rule', () => {
    expect(env.CODEBUDDY_API_KEY).toBe('sk-test')
    expect(env.CODEBUDDY_BASE_URL).toBe('https://example.invalid')
    expect(env.CODEBUDDY_INTERNET_ENVIRONMENT).toBe('internal')
  })

  it('drops the host gateway port, which would make both processes bind the same address', () => {
    expect(env.SERVER__PORT).toBeUndefined()
    expect(env.SERVER__HOST).toBeUndefined()
  })

  it('drops the host identity, session ids and bundle forcing', () => {
    for (const key of [
      'CODEBUDDY_CONFIG_DIR',
      'CODEBUDDY_HOST',
      'CODEBUDDY_GATEWAY_AUTH',
      'CODEBUDDY_GATEWAY_PASSWORD',
      'CODEBUDDY_HOST_CAPABILITIES',
      'CODEBUDDY_SESSION_ID',
      'CODEBUDDY_CONVERSATION_REQUEST_ID',
      'CODEBUDDY_TOOL_CALL_ID',
      'CODEBUDDY_FORCE_HEADLESS_BUNDLE',
      'CLAUDE_PROJECT_DIR',
      'CLAUDE_SESSION_ID',
    ])
      expect(env[key], key).toBeUndefined()
  })

  it('matches prefixes regardless of case, so a different casing cannot slip through', () => {
    expect(childEnv({ Server__Port: '1', codebuddy_host: 'x' })).toEqual({})
  })

  it('leaves lookalike names alone: only the documented prefixes are the host\'s', () => {
    // 单下划线的 SERVER_PORT 不是宿主那一套（那是 Spring 风格的 SERVER__PORT），
    // 用户的脚本可能自己在用，摘掉它就成了另一种「猜」。
    expect(childEnv({ SERVER_PORT: '8080', CODEBUDDY: 'x' })).toEqual({ SERVER_PORT: '8080', CODEBUDDY: 'x' })
  })
})
