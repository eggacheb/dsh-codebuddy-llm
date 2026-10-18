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
const SAFE_ENV_KEYS = [
  'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC',
  'PATHEXT', 'SystemDrive', 'SYSTEMDRIVE',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE',
  'PROGRAMFILES', 'ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'OS', 'PSModulePath', 'LANG', 'LC_ALL',
]

/**
 * 凭据形状的变量默认不转发，但这两个是 CodeBuddy 官方读登录态的入口：
 * 用户显式设置时应当生效（否则等于把「用环境变量登录」的人踢下线）。
 */
const PASSTHROUGH_ENV = ['CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_API_KEY']

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
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined)
      env[key] = value
  }

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
