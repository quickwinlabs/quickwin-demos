// shares —— 共享条目表：扁平 id → 磁盘路径
//
// 列表页/下载链接只暴露自增 id，不暴露路径；文件与文件夹统一入表：
// 文件夹在 addPath 时递归展开为多个条目（rel 带相对路径，如 `相册\a.jpg`）。
// 上限保护：深度 8、总数 5000——防止误把整个用户目录拖进来卡死 UI。
import * as wfile from './wfile.js'

export interface ShareEntry {
    id: number
    abs: string     // 磁盘绝对路径（反斜杠规范）
    rel: string     // 列表/下载展示名（含文件夹前缀）
    size: number
}

const MAX_FILES = 5000
const MAX_DEPTH = 8

const entries: ShareEntry[] = []
let nextId = 1
let onChange: (() => void) | null = null

/** UI 注册刷新回调（条目增删后调用） */
export function onUpdate(fn: () => void): void {
    onChange = fn
}

function norm(abs: string): string {
    return abs.replace(/\//g, '\\').replace(/\\+$/, '')
}

/** 已存在同路径（或互为前缀的重复文件夹）时跳过；返回新增条数 */
export function addPath(abs: string): number {
    const p = norm(abs)
    if (!p) return 0
    const st = wfile.stat(p)
    if (!st) return 0
    if (entries.some((e) => e.abs === p)) return 0
    let added = 0
    if (st.isDir) {
        added = walkDir(p, '', 0)
    } else {
        if (push(p, p.slice(p.lastIndexOf('\\') + 1), st.size)) added = 1
    }
    if (added > 0 && onChange) onChange()
    return added
}

function push(abs: string, rel: string, size: number): boolean {
    if (entries.length >= MAX_FILES) return false
    entries.push({ id: nextId++, abs, rel, size })
    return true
}

function walkDir(dir: string, prefix: string, depth: number): number {
    if (depth > MAX_DEPTH) return 0
    let added = 0
    for (const it of wfile.listDir(dir)) {
        const abs = dir + '\\' + it.name
        const rel = prefix ? prefix + '\\' + it.name : it.name
        if (it.isDir) {
            added += walkDir(abs, rel, depth + 1)
        } else {
            if (push(abs, rel, it.size)) added++
        }
        if (entries.length >= MAX_FILES) break
    }
    return added
}

export function all(): readonly ShareEntry[] {
    return entries
}

export function get(id: number): ShareEntry | null {
    return entries.find((e) => e.id === id) ?? null
}

export function totalSize(): number {
    return entries.reduce((s, e) => s + e.size, 0)
}
