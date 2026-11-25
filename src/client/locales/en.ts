/**
 * Copy dictionaries for the MCP servers settings card.
 *
 * All user-visible text lives here and reaches the component as the injected
 * `copy` object, so no product string is spelled inside a component body. The
 * card cannot rely on the framework `t` seat: the seat is typed per merged
 * locale namespace in `@deepseek-ai/dsh-client-ui-slots`, and a declaration
 * this package merged into another package's interface would have to be
 * visible to that package's renderer, which an external plugin cannot arrange.
 * The dictionary is therefore bound in `apply()` and passed through the
 * registration's inject face.
 *
 * The Chinese dictionary is authoritative for the KEY SET; the English one is
 * checked against it, so a key added to one language cannot silently go
 * missing from the other.
 */

/** Simplified Chinese dictionary; also the key source of truth. */
export const zh = {
  nav: 'MCP 服务器',
  intro: '在此添加、启用、停用或删除 MCP 服务器。改动立即生效，并保存到本机设置，对所有 profile 生效。',
  empty: '尚未配置任何 MCP 服务器。',
  hostAbsent: '未挂载后端：本插件的主机部分未在此部署中注册 MCP 服务器命名空间。请检查该插件是否已安装并启用。',
  add: '添加服务器',
  edit: '编辑',
  remove: '删除',
  save: '保存',
  cancel: '取消',
  confirmRemove: '确认删除',
  serverName: '服务器名称（工具前缀 mcp__<名称>__）',
  transport: '传输方式',
  enabled: '已启用',
  command: '命令',
  args: '参数（每行一个）',
  env: '环境变量（每行一个 KEY=value；值只写不读）',
  headers: '请求头（每行一个 KEY=value；值只写不读）',
  cwd: '工作目录（可选）',
  url: '地址 URL',
  stateMounted: '已挂载',
  stateEmpty: '已挂载，但未注册任何工具',
  stateDisabled: '已停用',
  stateConflict: '冲突',
  stateInvalid: '无效',
  stateFailed: '失败',
  transportStdio: 'stdio（子进程）',
  transportHttp: 'streamable-http',
  headersKept: '已保存 {n} 个请求头值，出于安全原因不回显。',
  envKept: '已保存 {n} 个环境变量值，出于安全原因不回显。',
  invalidServerName: '服务器名称必须匹配 [A-Za-z0-9_-]{1,32}。',
  invalidMapLine: '第 {line} 行不是合法的 KEY=value：{text}',
  writeFailed: '保存失败：{message}',
  editorTitleNew: '新增 MCP 服务器',
  editorTitleEdit: '编辑 MCP 服务器',
  routesNav: '子代理路由',
  routesIntro: '在此为每个项目子代理选择 provider、model 与 reasoningEffort。选项来自本机运行中的 provider 目录，选择会写回该定义文件 front-matter 的 llm: 块。',
  routesApplies: '更改只对解析到此根目录的新顶层会话生效；已打开的会话保留它已经挂载的路由。',
  routesRoot: '根目录',
  routesVia: '来源：{via}',
  routesCandidates: '候选根目录：{list}',
  routesEmpty: '此根目录下没有任何项目层子代理定义。',
  routesUnavailable: '未挂载后端：本插件的主机部分未在此部署中注册该路由，或本 profile 没有 connection 服务。请检查插件是否已安装并启用。',
  routesLoadFailed: '读取失败：{message}',
  routesRootFailed: '无法确定可写入的平台根目录：{message}',
  routesRootFailedHint: '请在 profile patch 中设置 agents.platformRoot 指向 Aweave 平台根目录。',
  routesReload: '重新加载',
  routesProvider: 'provider',
  routesModel: 'model',
  routesEffort: 'reasoningEffort',
  routesEffortDefault: '默认（随路由）',
  routesSave: '保存',
  routesReadOnly: '只读：{reason}',
  routesPreflight: '这里的 mountable 只是写入前的当前预检，不保证将来的会话或运行中的 provider 仍可挂载。',
  routesMountYes: '预检：可挂载',
  routesMountNo: '预检：不可挂载',
  routesMountUnknown: '预检：未确认',
  routesUnmatched: '文件中的当前值 {value} 不在实时目录中，保存前请重新选择。',
  routesCatalogPartial: '目录部分可用：{count} 个 provider 未能列出。',
  routesCatalogUnavailable: '目录不可用，无法列出 provider / model。',
  routesEffortsPending: '正在读取该 model 的 reasoningEffort…',
  routesEffortsUnavailable: '该 model 的 reasoningEffort 不可用：{message}',
  routesStale: '文件已被其他写入改动，请重新加载后再保存。',
  routesCode401: '会话未通过认证，请刷新页面重新登录。',
  routesCode403: '当前会话无权修改该文件。',
  routesCode413: '请求体超过 8 KiB 上限。',
  routesCode422: '主机拒绝了该路由：{message}',
  routesCode500: '主机端写入失败：{message}',
  routesUnknownError: '请求失败（HTTP {status}）：{message}',
} satisfies Record<string, string>

/** English dictionary, checked against the Chinese key set. */
export const en = {
  nav: 'MCP servers',
  intro: 'Add, enable, disable and remove MCP servers here. A change takes effect immediately and is stored in the machine settings, so it applies to every profile.',
  empty: 'No MCP server is configured yet.',
  hostAbsent: 'Host half not mounted: this deployment registers no MCP server namespace. Check that the plugin is installed and enabled.',
  add: 'Add server',
  edit: 'Edit',
  remove: 'Remove',
  save: 'Save',
  cancel: 'Cancel',
  confirmRemove: 'Confirm removal',
  serverName: 'Server name (tool prefix mcp__<name>__)',
  transport: 'Transport',
  enabled: 'Enabled',
  command: 'Command',
  args: 'Arguments (one per line)',
  env: 'Environment (one KEY=value per line; values are write-only)',
  headers: 'Headers (one KEY=value per line; values are write-only)',
  cwd: 'Working directory (optional)',
  url: 'Endpoint URL',
  stateMounted: 'mounted',
  stateEmpty: 'mounted, registered no tool',
  stateDisabled: 'disabled',
  stateConflict: 'conflict',
  stateInvalid: 'invalid',
  stateFailed: 'failed',
  transportStdio: 'stdio (child process)',
  transportHttp: 'streamable-http',
  headersKept: '{n} header value(s) are stored and deliberately not echoed back.',
  envKept: '{n} environment value(s) are stored and deliberately not echoed back.',
  invalidServerName: 'The server name must match [A-Za-z0-9_-]{1,32}.',
  invalidMapLine: 'Line {line} is not a KEY=value pair: {text}',
  writeFailed: 'The write was refused: {message}',
  editorTitleNew: 'Add an MCP server',
  editorTitleEdit: 'Edit the MCP server',
  routesNav: 'Subagent routes',
  routesIntro: 'Pick a provider, model and reasoningEffort for each project subagent here. The options come from the live provider registry, and a choice is written back into the llm: block of that definition\'s front-matter.',
  routesApplies: 'A change applies to new top-level Sessions resolving to this root only; an open Session keeps the route it already mounted.',
  routesRoot: 'Root',
  routesVia: 'via {via}',
  routesCandidates: 'Candidate roots: {list}',
  routesEmpty: 'This root declares no project-layer subagent definition.',
  routesUnavailable: 'Host half not mounted: this deployment registers no such route, or this profile carries no connection service. Check that the plugin is installed and enabled.',
  routesLoadFailed: 'The read failed: {message}',
  routesRootFailed: 'No writable platform root could be established: {message}',
  routesRootFailedHint: 'Set agents.platformRoot to the Aweave platform root in the profile patch.',
  routesReload: 'Reload',
  routesProvider: 'provider',
  routesModel: 'model',
  routesEffort: 'reasoningEffort',
  routesEffortDefault: 'Default (route)',
  routesSave: 'Save',
  routesReadOnly: 'Read-only: {reason}',
  routesPreflight: 'The mountable value here is the present preflight only; it is not a guarantee for a future Session or for provider availability at run time.',
  routesMountYes: 'preflight: mountable',
  routesMountNo: 'preflight: not mountable',
  routesMountUnknown: 'preflight: not confirmed',
  routesUnmatched: 'The current value {value} is not in the live catalog; pick another before saving.',
  routesCatalogPartial: 'The catalog is partial: {count} provider(s) could not be listed.',
  routesCatalogUnavailable: 'The catalog is unavailable, so no provider or model can be offered.',
  routesEffortsPending: 'Reading this model\'s reasoningEffort options…',
  routesEffortsUnavailable: 'This model\'s reasoningEffort options are unavailable: {message}',
  routesStale: 'The file changed underneath this page; reload and save again.',
  routesCode401: 'This Session is not authenticated; reload the page and sign in again.',
  routesCode403: 'This Session may not modify that file.',
  routesCode413: 'The request body exceeds the 8 KiB bound.',
  routesCode422: 'The host refused that route: {message}',
  routesCode500: 'The host failed to write: {message}',
  routesUnknownError: 'The request failed (HTTP {status}): {message}',
} satisfies Record<LocaleKey, string>

/** Every key the card's copy dictionary defines. */
export type LocaleKey = keyof typeof zh

/** One bound translate function over the card's dictionary. */
export type Translate = (key: LocaleKey, params?: Readonly<Record<string, string | number>>) => string

/**
 * Bind a dictionary to a translate function.
 * @param dict - the locale dictionary to read.
 * @returns a translate function with `{name}` placeholder substitution.
 */
export function bind(dict: Readonly<Record<string, string>>): Translate {
  return (key, params) => {
    const template = dict[key] ?? en[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = params[name]
      return value === undefined ? match : String(value)
    })
  }
}
