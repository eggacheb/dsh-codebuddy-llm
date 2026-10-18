import { describe, expect, it } from 'vitest'
import { childEnv } from '../src/host/service/child-env.ts'

const HOSTILE = {
  // Windows 基础变量，必须活下来。
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  PATH: 'C:\\Windows\\system32;/c/Users/someone/bin;C:\\Program Files\\nodejs',
  USERPROFILE: 'C:\\Users\\someone',
  LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
  TEMP: 'C:\\Users\\someone\\AppData\\Local\\Temp',
  // 整套 IDE 客户端标识：六项同时存在，CLI 会切到宿主集成认证、读不到自己的登录态。
  CLIENT_INFO_IDE_TYPE: 'WorkBuddy',
  CLIENT_INFO_PLATFORM: 'WorkBuddy',
  CLIENT_INFO_PLUGIN_NAME: 'workbuddy-desktop',
  CLIENT_INFO_PRODUCT_NAME: 'WorkBuddy',
  CLIENT_INFO_USER_AGENT_EXTENSION: 'CLI/2.161.0',
  CLIENT_INFO_MACHINE_ID: 'machine',
  // 宿主网关：被继承就会父子抢同一个端口。
  SERVER__PORT: '12118',
  SERVER__HOST: '127.0.0.1',
  // 宿主自己的配置目录、身份、会话。
  CODEBUDDY_CONFIG_DIR: 'C:\\Users\\someone\\.workbuddy',
  CODEBUDDY_HOST: 'workbuddy-desktop',
  CODEBUDDY_GATEWAY_AUTH: 'password',
  CODEBUDDY_GATEWAY_PASSWORD: 'secret',
  CODEBUDDY_HOST_CAPABILITIES: 'elicitation.form',
  CODEBUDDY_SESSION_ID: 'ffda6149',
  CODEBUDDY_FORCE_HEADLESS_BUNDLE: '1',
  CLAUDE_PROJECT_DIR: 'C:/Users/someone/WorkBuddy/session',
  CLAUDE_SESSION_ID: 'ffda6149',
  DSH_HOME: 'C:\\Users\\someone\\.dsh',
  // 登录态入口，必须透传。
  CODEBUDDY_API_KEY: 'sk-test',
  CODEBUDDY_AUTH_TOKEN: 'token-test',
  // 代理：指向本机的是宿主自己的，外网的照传。
  HTTP_PROXY: 'http://127.0.0.1:7890',
  HTTPS_PROXY: 'http://proxy.corp.example:3128',
  NO_PROXY: 'localhost,127.0.0.1',
} as const

describe('child environment', () => {
  const env = childEnv({ ...HOSTILE })

  it('keeps the Windows basics a CLI needs to run', () => {
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.ComSpec).toBe(HOSTILE.ComSpec)
    expect(env.USERPROFILE).toBe(HOSTILE.USERPROFILE)
    expect(env.LOCALAPPDATA).toBe(HOSTILE.LOCALAPPDATA)
    expect(env.TEMP).toBe(HOSTILE.TEMP)
  })

  it('drops the MSYS entries from PATH, which Windows tools cannot use', () => {
    expect(env.PATH).toBe('C:\\Windows\\system32;C:\\Program Files\\nodejs')
  })

  it('drops the whole IDE identity, which is what flips the CLI into host auth', () => {
    for (const key of Object.keys(HOSTILE).filter(key => key.startsWith('CLIENT_INFO_')))
      expect(env[key], key).toBeUndefined()
  })

  it('drops the host gateway port, which would make both processes bind the same address', () => {
    expect(env.SERVER__PORT).toBeUndefined()
    expect(env.SERVER__HOST).toBeUndefined()
  })

  it('drops the host config dir, identity, session ids and bundle forcing', () => {
    for (const key of [
      'CODEBUDDY_CONFIG_DIR',
      'CODEBUDDY_HOST',
      'CODEBUDDY_GATEWAY_AUTH',
      'CODEBUDDY_GATEWAY_PASSWORD',
      'CODEBUDDY_HOST_CAPABILITIES',
      'CODEBUDDY_SESSION_ID',
      'CODEBUDDY_FORCE_HEADLESS_BUNDLE',
      'CLAUDE_PROJECT_DIR',
      'CLAUDE_SESSION_ID',
      'DSH_HOME',
    ])
      expect(env[key], key).toBeUndefined()
  })

  it('passes the two login entry points through, so env-var sign-in still works', () => {
    expect(env.CODEBUDDY_API_KEY).toBe('sk-test')
    expect(env.CODEBUDDY_AUTH_TOKEN).toBe('token-test')
  })

  it('keeps a real proxy but drops one that points back at the host', () => {
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.HTTPS_PROXY).toBe('http://proxy.corp.example:3128')
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1')
  })

  it('lets a route add anything back through its own env', () => {
    const custom = childEnv({ ...HOSTILE }, { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal', SERVER__PORT: '1' })
    expect(custom.CODEBUDDY_INTERNET_ENVIRONMENT).toBe('internal')
    expect(custom.SERVER__PORT).toBe('1')
    expect(custom.HTTP_PROXY).toBeUndefined()
  })

  it('always sets PATH, even when the parent has none', () => {
    expect(childEnv({}).PATH).toBe('C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem')
  })

  it('matches nothing by prefix: a lookalike host variable is simply not on the list', () => {
    expect(childEnv({ Server__Port: '1', codebuddy_host: 'x', CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' })).toEqual({
      PATH: 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem',
    })
  })
})
