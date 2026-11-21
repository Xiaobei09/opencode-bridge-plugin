// R2715：模型/思考深度命令（/model /think）从桥内上收。
// 原实现两段各自重复：解析目标、拉模型表、直切或打开选择器；直切还要处理
// 宿主错误体与 HTML 转义。集中后桥只注入 HTTP 适配器、菜单跳转与缓存写入。
// 文案按“只阐述事件/消息本身”收敛：去掉“下次生成生效 / 再切”这类解释尾巴。
import { htmlEsc } from "./tg-html"
import { variantListOf, thinkLabel, resolveThinkLevel } from "./think-depth"

export type ModelEntryLike = {
  id: string
  providerID: string
  name?: string
  key?: string
  display?: string
  variants?: unknown[]
}

export type SessionModelLike = { id: string; providerID: string; variant?: string }
export type ModelSetResult = { ok: boolean; status?: number; body?: unknown }

export type ModelRunArgs = {
  chatID: string
  text: string
  /** 已归一（小写、去 @suffix）的命令名。 */
  cmd: string
  reply: (chatID: string, text: string) => Promise<void>
}

export type ModelDeps = {
  /** 当前目标会话（钉选优先，否则前台）。 */
  target: () => Promise<string | undefined>
  modelList: () => Promise<ModelEntryLike[]>
  modelSession: (sid: string) => Promise<SessionModelLike | null>
  modelSet: (sid: string, body: Record<string, unknown>) => Promise<ModelSetResult>
  /** 用户输入 → 模型引用（桥的纯函数 resolveModelRef）。 */
  resolveModelRef: (arg: string, list: ModelEntryLike[], cur?: { providerID?: string }) => { id: string; providerID: string; label: string } | null
  sessionTag: (sid: string) => string
  clean: (s: unknown, n: number) => string
  commandArg: (text: string) => string
  cacheModel: (chatID: string, list: ModelEntryLike[]) => void
  cacheThink: (chatID: string, value: { vs: ReturnType<typeof variantListOf>; label: string; id: string; providerID: string }) => void
  showMenu: (chatID: string, view: "model" | "think") => Promise<void>
}

const failDetail = (res: ModelSetResult, clean: (s: unknown, n: number) => string): string => {
  const b = res.body
  const why = typeof b === "object" && b ? String((b as any).error ?? "") || String(b) : String(b)
  return `HTTP ${res.status ?? "?"}：${htmlEsc(clean(String(why ?? ""), 140))}`
}

export const createModelCommands = (deps: ModelDeps) => {
  const { target, modelList, modelSession, modelSet, resolveModelRef, sessionTag, clean, commandArg, cacheModel, cacheThink, showMenu } = deps

  const needTarget = async (chatID: string, reply: ModelRunArgs["reply"]): Promise<string | undefined> => {
    const t = await target()
    if (!t) await reply(chatID, "无法解析目标会话")
    return t
  }

  const listOrErr = async (chatID: string, reply: ModelRunArgs["reply"]): Promise<ModelEntryLike[] | undefined> => {
    const list = await modelList()
    if (list.length === 0) {
      await reply(chatID, "❌ 拉取模型列表失败")
      return undefined
    }
    return list
  }

  const runModel = async (chatID: string, text: string, reply: ModelRunArgs["reply"]): Promise<void> => {
    const sid = await needTarget(chatID, reply)
    if (!sid) return
    const list = await listOrErr(chatID, reply)
    if (!list) return
    const sesNow = await modelSession(sid)
    const arg = commandArg(text).trim()
    if (arg) {
      const hit = resolveModelRef(arg, list, sesNow ?? undefined)
      if (!hit) {
        const sample = list.slice(0, 12).map((m) => m.key).join("、")
        await reply(chatID, `❌ 未找到模型：${htmlEsc(clean(arg, 40))}\n可用的（节选）：${htmlEsc(sample)}${list.length > 12 ? "…" : ""}`)
        return
      }
      const res = await modelSet(sid, { id: hit.id, providerID: hit.providerID })
      if (!res.ok) {
        await reply(chatID, `❌ 切换失败（${failDetail(res, clean)}）`)
        return
      }
      await reply(chatID, `✅ ${htmlEsc(sessionTag(sid))}（${htmlEsc(sid.slice(0, 12))}）→ <b>${htmlEsc(hit.label)}</b>`)
      return
    }
    cacheModel(chatID, list)
    await showMenu(chatID, "model")
  }

  const runThink = async (chatID: string, text: string, reply: ModelRunArgs["reply"]): Promise<void> => {
    const sid = await needTarget(chatID, reply)
    if (!sid) return
    const list = await listOrErr(chatID, reply)
    if (!list) return
    const sesNow = await modelSession(sid)
    if (!sesNow) {
      await reply(chatID, "❌ 读不到当前模型")
      return
    }
    const entry = list.find((m) => m.id === sesNow.id && m.providerID === sesNow.providerID)
    const vs = variantListOf(entry)
    const label = entry?.display ?? `${sesNow.providerID}/${sesNow.id}`
    const arg = commandArg(text).trim()
    if (arg) {
      const hit = resolveThinkLevel(arg, vs)
      if (!hit) {
        // 宿主不校验 variant（传错也 204），所以这里必须自己挡住，不能放行去写坏会话档位。
        const sample = vs.map((v) => thinkLabel(v)).join("、")
        await reply(chatID, `❌ 未找到档位：${htmlEsc(clean(arg, 30))}\n可选：${htmlEsc(sample)}`)
        return
      }
      const res = await modelSet(sid, { id: sesNow.id, providerID: sesNow.providerID, variant: hit.id })
      if (!res.ok) {
        await reply(chatID, `❌ 切换失败（${failDetail(res, clean)}）`)
        return
      }
      await reply(chatID, `✅ ${htmlEsc(sessionTag(sid))}（${htmlEsc(sid.slice(0, 12))}）思考 → <b>${htmlEsc(thinkLabel(hit))}</b>（${htmlEsc(hit.id)}）`)
      return
    }
    cacheThink(chatID, { vs, label, id: sesNow.id, providerID: sesNow.providerID })
    await showMenu(chatID, "think")
  }

  const run = async ({ chatID, text, cmd, reply }: ModelRunArgs): Promise<boolean> => {
    if (cmd === "model" || text === "/model" || text.startsWith("/model ")) {
      await runModel(chatID, text, reply)
      return true
    }
    if (cmd === "think" || text === "/think" || text.startsWith("/think ")) {
      await runThink(chatID, text, reply)
      return true
    }
    return false
  }

  return { run }
}
