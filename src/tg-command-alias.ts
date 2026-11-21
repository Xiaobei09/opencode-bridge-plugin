// R2714：会话别名命令（/alias）从桥内上收。
// 原实现把“列别名/查别名/删别名/设置别名”四段混在 handleUpdateInner 里，
// 设置分支还夹着与 /use 同一套存在性校验。集中后桥只注入实时 aliasMap 与查询函数。
// 文案按“只阐述事件/消息本身”收敛：不再在错误里附带操作指引。
export type AliasRunArgs = {
  chatID: string
  text: string
  /** 已归一（小写、去 @suffix）的命令名。 */
  cmd: string
  reply: (chatID: string, text: string) => Promise<void>
}

export type AliasDeps = {
  /** 桥的实时别名表（直接引用，读写同一份）。 */
  aliasMap: Map<string, string>
  /** 会话名/序号/前缀/ID → 完整 ID（桥的 resolveSessionID）。 */
  resolveSessionID: (want: string) => Promise<string>
  /** 刷新宿主会话列表，返回是否成功。 */
  refreshTitles: () => Promise<boolean>
  /** 当前已知会话 ID（桥的 cachedSessionList）。 */
  knownIds: () => readonly string[]
  /** 存在性判据（拉不到列表时保守放行）。 */
  acceptable: (id: string, knownIds: readonly string[], listOk: boolean) => boolean
  saveState: () => void
  clean: (s: unknown, n: number) => string
  commandArg: (text: string) => string
}

export const createAliasCommands = (deps: AliasDeps) => {
  const { aliasMap, resolveSessionID, refreshTitles, knownIds, acceptable, saveState, clean, commandArg } = deps

  const list = (): string => {
    const lines = ["🏷 别名"]
    if (aliasMap.size === 0) lines.push("（暂无）")
    else for (const [k, v] of aliasMap) lines.push(`· ${k} → ${v.slice(0, 12)}`)
    return lines.join("\n")
  }

  const del = async (chatID: string, arg: string, reply: AliasRunArgs["reply"]): Promise<void> => {
    aliasMap.delete(arg.toLowerCase())
    saveState()
    await reply(chatID, `🏷 已删别名 ${arg}`)
  }

  const set = async (chatID: string, name: string, arg: string, reply: AliasRunArgs["reply"]): Promise<void> => {
    const id = await resolveSessionID(arg)
    if (!id.startsWith("ses_")) {
      await reply(chatID, `❌ 未找到会话：${clean(arg, 40)}`)
      return
    }
    // R1872：与 /use（R1829）同一存在性不变量 —— 别名指向已删除/不存在的完整 ID 会成为
    // “毒别名”：/use 名字会报错（好），但 /watch 名字会经 aliasHit 直接拿到该死 id。
    const listOk = await refreshTitles()
    if (!acceptable(id, knownIds(), listOk)) {
      await reply(chatID, `❌ 会话不存在：${clean(arg, 40)}`)
      return
    }
    aliasMap.set(name, id)
    if (aliasMap.size > 50) {
      const k = aliasMap.keys().next().value
      if (k !== undefined) aliasMap.delete(k)
    }
    saveState()
    await reply(chatID, `🏷 ${name} → ${id.slice(0, 12)}`)
  }

  const run = async ({ chatID, text, cmd, reply }: AliasRunArgs): Promise<boolean> => {
    if (!(text === "/alias" || text.startsWith("/alias ") || cmd === "alias")) return false
    const rest = commandArg(text)
    if (!rest) {
      await reply(chatID, list())
      return true
    }
    const sp = rest.search(/\s/)
    if (sp < 0) {
      const hit = aliasMap.get(rest.toLowerCase())
      await reply(chatID, hit ? `🏷 ${rest} → ${hit.slice(0, 12)}` : `🏷 无别名 ${rest}`)
      return true
    }
    const name = rest.slice(0, sp).toLowerCase()
    const arg = rest.slice(sp + 1).trim()
    if (name === "del" || name === "rm") {
      await del(chatID, arg, reply)
      return true
    }
    await set(chatID, name, arg, reply)
    return true
  }

  return { run, list }
}
