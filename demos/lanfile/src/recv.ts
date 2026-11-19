// recv —— 手机上传完成的桌面侧通知
//
// server 与 UI 在同一进程、同一事件循环，直接回调即可（同 texts.onUpdate 模式）。
// 只传相对路径，是否提示由 UI 按配置决定。
let onChange: ((rel: string) => void) | null = null

/** UI 注册接收回调（传 null 注销） */
export function onUpload(fn: ((rel: string) => void) | null): void {
    onChange = fn
}

/** 单个文件上传成功后调用 */
export function notifyUpload(rel: string): void {
    if (onChange) onChange(rel)
}
