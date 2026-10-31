// store —— 轻量全局状态（自管组件订阅；引擎在模块级跑，不挂组件）
import { defaultConfig, type Config } from './config.js'

export interface DeviceView {
    /** 设备身份 key：硬件序列号；无序列号盘为 'noserial:<盘符>'（不持久化） */
    key: string
    serial: string
    vendor: string
    product: string
    label: string
    /** 容量（字节） */
    capacity: number
    /** 是否允许自动备份（每行复选框） */
    allow: boolean
    /** 当前已连接 */
    connected: boolean
    /** 当前盘符（'F'；离线 ''） */
    drive: string
    /** 容量/卷标与上次记录不一致（读卡器换卡/克隆盘）→ 本次不自动导入 */
    mismatch: boolean
    /** 无硬件序列号 → 复选框禁用，只能手动「立即导入」 */
    noSerial: boolean
}

export interface JobView {
    running: boolean
    phase: 'idle' | 'scan' | 'copy'
    /** 目标设备序列号 */
    serial: string
    /** 源盘符（'F'） */
    drive: string
    /** 目标目录（<destRoot>\<厂商_型号-hash8>） */
    destDir: string
    totalFiles: number
    doneFiles: number
    copied: number
    skipped: number
    failed: number
    bytesCopied: number
    totalBytes: number
    currentFile: string
    error: string
    /** 请求取消（UI 置位；引擎只读） */
    cancel: boolean
}

export const IDLE_JOB: JobView = {
    running: false,
    phase: 'idle',
    serial: '',
    drive: '',
    destDir: '',
    totalFiles: 0,
    doneFiles: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    bytesCopied: 0,
    totalBytes: 0,
    currentFile: '',
    error: '',
    cancel: false,
}

export interface State {
    cfg: Config
    devices: DeviceView[]
    job: JobView
    tab: number
    /** 状态行文本（插盘/发现/容量变化等一次性提示） */
    banner: string
}

let state: State = {
    cfg: defaultConfig(),
    devices: [],
    job: { ...IDLE_JOB },
    tab: 0,
    banner: '',
}

const listeners = new Set<() => void>()

export function getState(): State {
    return state
}

export function setState(p: Partial<State>): void {
    state = { ...state, ...p }
    for (const f of listeners) f()
}

export function subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
}
