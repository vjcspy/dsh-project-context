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
