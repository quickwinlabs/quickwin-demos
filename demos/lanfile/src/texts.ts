// texts —— 共享文字（最新一条）：手机网页与桌面「文字」页签共用
//
// 语义是"共享剪贴板"：只保留最新一条，任何一侧修改都会覆盖上一条。
// ts 用于手机端轮询去重（GET /t?since=<ts> 无变化返回 204）；单调递增，
// 避免同一毫秒内两次写入让轮询漏掉后一次。
// 服务端与 UI 在同一事件循环，set() 直接回调桌面刷新，不需要 IPC。
export interface TextState {
    text: string
    ts: number
}

let cur: TextState = { text: '', ts: 0 }
let onChange: (() => void) | null = null

/** UI 注册刷新回调（传 null 注销）；文字变化后调用 */
export function onUpdate(fn: (() => void) | null): void {
    onChange = fn
}

export function get(): TextState {
    return cur
}

/** 写入新文字；内容未变时不改 ts、不触发刷新（避免无意义的轮询响应） */
export function set(text: string): TextState {
    if (text === cur.text) return cur
    cur = { text, ts: Math.max(Date.now(), cur.ts + 1) }
    if (onChange) onChange()
    return cur
}
