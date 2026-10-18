import process from 'node:process'

/**
 * 宿主的环境变量会顺着 `...process.env` 漏给 ACP 子进程，把子进程拽进宿主的身份里。
 *
 * 最要命的是 `SERVER__PORT` / `SERVER__HOST`：dsh 跑在 CodeBuddy 系宿主里时，宿主用这两个
 * 变量发布自己的网关端口，而 CodeBuddy CLI 启动时也会读它们去 bind 同一个地址——于是子进程
 * 一启动就 `EADDRINUSE 127.0.0.1:<宿主端口>`，进程退出，客户端只看到「ACP connection
 * closed」。实测（2026-10）：继承环境下 initialize 直接失败；摘掉这些前缀后同一个 CLI
 * 6.4s 完成握手、7.7s 建好会话并正常报出全部模型。所以那不是端口冲突，是父子同抢一个端口。
 *
 * 其余同类污染：
 * - `CODEBUDDY_CONFIG_DIR`：子进程会读写宿主的配置与会话目录，两边的会话混在一个桶里。
 * - `CODEBUDDY_HOST` / `CODEBUDDY_HOST_CAPABILITIES` / `CODEBUDDY_GATEWAY_*`：让它以为
 *   自己是宿主的一部分，去连宿主的网关、用宿主的鉴权口令。
 * - `CODEBUDDY_SESSION_ID` / `CODEBUDDY_CONVERSATION_*` / `CODEBUDDY_TOOL_CALL_ID`：把宿主
 *   正在进行的会话 id 塞进子进程自己的会话，日志与审批都会串。
 * - `CODEBUDDY_FORCE_HEADLESS_BUNDLE` / `CODEBUDDY_FORCE_LITE_WB_BUNDLE`：把宿主选的打包
 *   形态强加给子进程，而我们并不知道那个形态是否带 ACP。
 *
 * 只按前缀摘，不按具体名字摘：这条规则要能跟着对方版本演进继续生效，新增的同类变量自动
 * 被挡在外面。任何一条都可以在 profile 的 `env` 里按路由加回去（`env` 是后合并的）。
 */
const STRIPPED_PREFIXES = ['CODEBUDDY_', 'CLAUDE_', 'SERVER__'] as const

/**
 * 前缀之内但值得跨进程传的少数几个。
 *
 * 凭据类：用户可能就是用环境变量登录的，摘掉等于让它变成未登录。`INTERNET_ENVIRONMENT`
 * 是环境路由（内网/公网端点），跟「我是谁、我绑哪个端口」无关，摘掉反而可能连不上。
 */
const KEPT = new Set([
  'CODEBUDDY_API_KEY',
  'CODEBUDDY_AUTH_TOKEN',
  'CODEBUDDY_BASE_URL',
  'CODEBUDDY_INTERNET_ENVIRONMENT',
])

/**
 * The environment an ACP child should start with: everything the host has, minus the
 * variables that would make it act as part of the host instead of as its own agent.
 */
export function childEnv(
  source: NodeJS.ProcessEnv = process.env,
  stripped: readonly string[] = STRIPPED_PREFIXES,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase()
    const polluted = stripped.some(prefix => upper.startsWith(prefix))
    if (!polluted || KEPT.has(upper))
      env[key] = value
  }
  return env
}
