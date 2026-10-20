import type { EnvMode } from '../../shared/types.ts'
import process from 'node:process'

/**
 * 子进程环境用**白名单**构造，不是「继承全部再剔除」。
 *
 * 黑名单在这里不成立，因为 CodeBuddy 的认证判定是「组合触发」的：宿主（WorkBuddy /
 * CodeBuddy 桌面端）会向自身进程注入整套 IDE 客户端标识 ——
 * `CLIENT_INFO_IDE_TYPE` / `CLIENT_INFO_PLATFORM` / `CLIENT_INFO_PLUGIN_NAME` /
 * `CLIENT_INFO_PRODUCT_NAME` / `CLIENT_INFO_USER_AGENT_EXTENSION` /
 * `CLIENT_INFO_MACHINE_ID`。这六项单独存在时 CLI 仍按独立账号登录；整套同时出现时
 * 它会判定「我在宿主里跑」，切换成宿主集成认证、转而向宿主索要 token，于是
 * `~/.codebuddy` 里的登录态根本不会被读取 —— 表现为 `--print` 的
 * "Authentication required"，ACP 里则是 `stopReason: refusal` 配日志里的 401。
 *
 * 这一点在本仓库上真机验证过：摘掉 `SERVER__*` 后子进程能启动、`session/new` 也成功
 * （那两步不碰模型），但真正 `session/prompt` 立刻 refusal；CLI 日志里是
 * `Failed to recall prompt friction intent: Request failed with status code 401`。
 * 同一份白名单在 `dsh-codebuddy`（子智能体版）上已经跑了很久，那边记的实测结论是：
 * 干净环境 20 秒成功；六项里只加任意一项仍成功；六项同时存在 15 秒后认证失败。
 *
 * 另一个必须处理的点：宿主的网关端口（`SERVER__PORT` / `SERVER__HOST`）也在这个环境里。
 * CodeBuddy CLI 启动时会 bind 一个本地网关端口并照读这两个变量，于是父子抢同一个
 * 地址、子进程一启动就 `EADDRINUSE` 退出。白名单天然挡掉它们，CLI 自己 listen(0)。
 */
/** 一点 PATH 都没有时的兜底：Windows 上至少能找到 cmd 和系统工具。 */
const FALLBACK_PATH = 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem'

const SAFE_ENV_KEYS = [
  'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC',
  'PATHEXT', 'SystemDrive', 'SYSTEMDRIVE',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE',
  'PROGRAMFILES', 'ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  // Git Bash 读 HOME 找 ~/.bash_profile；Windows 上通常只设 USERPROFILE。
  // 缺了它 `bash -c -l` 会失败，ptc 模式的 shell snapshot 直接起不来。
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'OS', 'PSModulePath', 'LANG', 'LC_ALL',
  // Git Bash 的 `-l` 会按 SHELL 决定用哪个解释器；宿主有就带上，没有也不影响。
  'SHELL',
]

/**
 * 凭据形状的变量默认不转发，但这两个是 CodeBuddy 官方读登录态的入口：
 * 用户显式设置时应当生效（否则等于把「用环境变量登录」的人踢下线）。
 */
const PASSTHROUGH_ENV = ['CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_API_KEY']

/**
 * `inherit` 模式下仍然要挡掉的变量。
 *
 * 这几组不是「安全」问题，而是会直接改掉 CLI 的行为：`CLIENT_INFO_*` 六项凑齐会让它
 * 判定在宿主里跑并转去要宿主 token（401）；`SERVER__*` 会和宿主抢网关端口；
 * `CODEBUDDY_CONFIG_DIR` 会把它指到另一个配置目录、读不到自己的登录态；
 * `CODEBUDDY_ENABLE_SECURITY_AUDIT` 会打开内置审计，把 REPL 这类工具在
 * PreToolUse 阶段直接拒掉（日志里是 `Tool REPL blocked by PreToolUse hook`）。
 */
const HOSTILE_ENV = /^(?:CLIENT_INFO_|SERVER__|DSH_|CLAUDE_|CODEBUDDY_CONFIG_DIR|CODEBUDDY_ENABLE_SECURITY_AUDIT)/

/** 指向宿主机器的代理只服务宿主自身进程，外部 CLI 用不上。 */
const LOCAL_PROXY = /^(https?|socks5?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']

const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy']

/**
 * PATH 里 Git Bash / MSYS 的项（`/c/...`、`/usr/bin`）对 Windows 的 cmd 没有意义，
 * 留着只会让 CLI 的路径探测走偏，直接剔掉。
 */
function windowsPath(raw: string | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0)
    return ''
  return raw
    .split(';')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && !entry.startsWith('/'))
    .join(';')
}

/**
 * The environment an ACP child should start with.
 *
 * 与「继承再剔除」的差别不只是安全：白名单之外的一切都进不了子进程，所以宿主以后新增
 * 某个同类变量时这里不需要跟着改。真正要加的按路由写进 profile 的 `env`，它最后合并。
 */
export function childEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
  mode: EnvMode = 'whitelist',
): NodeJS.ProcessEnv {
  if (mode === 'inherit')
    return inheritEnv(source, extra)

  const env: NodeJS.ProcessEnv = {}
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined)
      env[key] = value
  }

  // Git Bash 在 Windows 上仍然认 HOME；没有就退到 USERPROFILE。
  if (env.HOME === undefined && env.USERPROFILE !== undefined)
    env.HOME = env.USERPROFILE

  const path = windowsPath(source.PATH ?? source.Path)
  env.PATH = path.length > 0 ? path : 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem'

  for (const key of PASSTHROUGH_ENV) {
    const value = source[key]
    if (value !== undefined && value.length > 0)
      env[key] = value
  }

  for (const key of PROXY_KEYS) {
    const value = source[key]
    if (value === undefined || value.length === 0 || LOCAL_PROXY.test(value.trim()))
      continue
    env[key] = value
  }
  for (const key of NO_PROXY_KEYS) {
    const value = source[key]
    if (value !== undefined && value.length > 0)
      env[key] = value
  }

  return { ...env, ...extra }
}

/**
 * `inherit`：继承宿主环境，只挡掉 {@link HOSTILE_ENV} 和指向本机的代理。
 *
 * 给「白名单漏了某个变量」的场景兜底——比如 Git Bash 的 HOME、用户自己的
 * API key、内网代理。代价是宿主以后新增同类变量时会自动漏进来，所以默认不开。
 */
function inheritEnv(source: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || HOSTILE_ENV.test(key))
      continue
    env[key] = value
  }
  for (const key of PROXY_KEYS) {
    const value = env[key]
    if (value !== undefined && LOCAL_PROXY.test(value.trim()))
      delete env[key]
  }
  // 宿主进程通常只有 USERPROFILE；Git Bash 的 `-l` 却认 HOME。两套模式都得补，
  // 否则 inherit 反而比白名单更容易缺这一项。
  if (env.HOME === undefined && env.USERPROFILE !== undefined)
    env.HOME = env.USERPROFILE

  // PATH 同样要过一遍：Git Bash 的 `/c/...`、`/usr/bin` 对 Windows 的 cmd 没意义，
  // 留着会让 CLI 的路径探测走偏（最坏情况是找到 MSYS 的 bash 而不是 Git 的）。
  const path = windowsPath(env.PATH ?? env.Path)
  env.PATH = path.length > 0 ? path : FALLBACK_PATH
  return { ...env, ...extra }
}
