// wfile —— Unicode 安全的文件操作（Win32 W 版 API）
//
// uback 里凡是用户可见路径（配置/日志/备份目标）一律走这里，不用 os 模块（ANSI CRT，
// 中文路径乱码）。基于 lanfile 的 wfile 裁剪扩展：
//   - Entry 增加 mtime（FILETIME 100ns since 1601，bigint）与 attrs
//   - 增加 moveFileEx / pathExists / openAppend / setFileTime / fileSize / flush
//   - 增加 UTF-8 文本读写（带 BOM 选项），供 config.json / 设备 uback.txt / 全局日志用
import { NULL, PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import {
    CreateFile, ReadFile, WriteFile, SetFilePointer, CloseHandle, GetFileAttributes,
    CreateDirectory, DeleteFile, FindFirstFile, FindNextFile, FindClose, MoveFileEx,
} from 'quickwin/lib/windows/kernel32.js'
import { WIN32_FIND_DATAW } from 'quickwin/lib/windows/structs.js'
import { FileAccess, FileAttribute, FileCreation, FileSeekFrom, FileShare } from 'quickwin/constants'
import { bind } from 'quickwin/lib/ffi/bind.js'

const INVALID = 0xFFFFFFFF
const FlushFileBuffers = bind('kernel32.dll', 'FlushFileBuffers', '<HFILE>ptr! -> i32')
const GetFileSizeEx = bind('kernel32.dll', 'GetFileSizeEx', '<HFILE>ptr! <BYTE>ptr -> i32')
const SetFileTime = bind('kernel32.dll', 'SetFileTime', '<HFILE>ptr! <>ptr <>ptr <>ptr -> i32')

/** CreateFile 返回的句柄品牌；ReadFile/WriteFile/SetFilePointer 同号收 */
type HFile = ReturnType<typeof CreateFile>

const readOut = new PtrArrayBuffer(4)
const writeOut = new PtrArrayBuffer(4)

// 不绑具体品牌：INVALID_HANDLE_VALUE / -1 的判断与句柄种类无关，HFile、HFIND 通用
function bad(h: number): boolean {
    return !h || h === -1 || (h >>> 0) === INVALID
}

export interface Entry {
    name: string
    size: number
    isDir: boolean
    /** FILETIME：1601-01-01 起 100ns 单元（bigint）；目录/无法取得为 0n */
    mtime: bigint
    attrs: number
}

/** 打开读；失败 → null */
export function openRead(path: string): HFile | null {
    const h = CreateFile(path, FileAccess.GENERIC_READ, FileShare.READ | FileShare.WRITE, NULL,
        FileCreation.OPEN_EXISTING, FileAttribute.NORMAL, NULL)
    return bad(h) ? null : h
}

/** 打开写（覆盖）；失败 → null */
export function openWrite(path: string): HFile | null {
    const h = CreateFile(path, FileAccess.GENERIC_WRITE, FileShare.READ, NULL,
        FileCreation.CREATE_ALWAYS, FileAttribute.NORMAL, NULL)
    return bad(h) ? null : h
}

/** 打开追加写（不存在则创建）；失败 → null。句柄定位到文件尾。 */
export function openAppend(path: string): HFile | null {
    const h = CreateFile(path, FileAccess.GENERIC_WRITE, FileShare.READ, NULL,
        FileCreation.OPEN_ALWAYS, FileAttribute.NORMAL, NULL)
    if (bad(h)) return null
    SetFilePointer(h, 0, NULL, FileSeekFrom.END)
    return h
}

/** 读至多 len 字节到 buf；返回实际字节数，失败 -1，EOF 0 */
export function read(h: HFile, buf: PtrArrayBuffer, len: number): number {
    if (!ReadFile(h, buf, len, readOut, NULL)) return -1
    return new DataView(readOut).getUint32(0, true)
}

/** 写 buf 前 len 字节；返回实际写入数，失败 -1 */
export function write(h: HFile, buf: PtrArrayBuffer, len: number): number {
    if (!WriteFile(h, buf, len, writeOut, NULL)) return -1
    return new DataView(writeOut).getUint32(0, true)
}

/** 绝对定位到 offset（文件头起） */
export function seek(h: HFile, offset: number): void {
    SetFilePointer(h, offset, NULL, FileSeekFrom.BEGIN)
}

/** 写盘（刷新到物理介质）；失败静默 */
export function flush(h: HFile): void {
    FlushFileBuffers(h)
}

/** 文件大小（bigint，>4GB 正确）；失败 -1n */
export function fileSize(h: HFile): bigint {
    const out = new PtrArrayBuffer(8)
    if (!GetFileSizeEx(h, out)) return -1n
    return new DataView(out).getBigUint64(0, true)
}

/** 设文件最后写入时间（FILETIME 100ns since 1601，bigint）。句柄须 GENERIC_WRITE 或
 *  FILE_WRITE_ATTRIBUTES 权限。失败静默（FAT 2s 粒度、权限等）。 */
export function setFileTime(h: HFile, mtime100ns: bigint): void {
    const buf = new PtrArrayBuffer(8)
    const dv = new DataView(buf)
    dv.setUint32(0, Number(mtime100ns & 0xFFFFFFFFn), true)
    dv.setUint32(4, Number((mtime100ns >> 32n) & 0xFFFFFFFFn), true)
    SetFileTime(h, NULL, NULL, buf.ptr)
}

export function close(h: HFile): void {
    CloseHandle(h)
}

/** 路径存在（文件/目录）；失败 → false */
export function exists(path: string): boolean {
    return GetFileAttributes(path) !== 0xFFFFFFFF
}

/** 路径属性（文件/目录/大小/mtime）；不存在 → null。目录 size 恒 0 */
export function stat(path: string): Entry | null {
    const fd = WIN32_FIND_DATAW.alloc()
    const h = FindFirstFile(path, fd.ptr)
    if (bad(h)) return null
    const f = WIN32_FIND_DATAW.decode(fd)
    FindClose(h)
    const attrs = f.dwFileAttributes
    return {
        name: f.cFileName,
        size: f.nFileSizeLow + f.nFileSizeHigh * 4294967296,
        isDir: (attrs & FileAttribute.DIRECTORY) !== 0,
        mtime: f.ftLastWriteTime,
        attrs,
    }
}

/** 列举目录内容（不含 . / ..）；失败 → [] */
export function listDir(dir: string): Entry[] {
    const fd = WIN32_FIND_DATAW.alloc()
    const h = FindFirstFile(dir.replace(/\\+$/, '') + '\\*', fd.ptr)
    if (bad(h)) return []
    const out: Entry[] = []
    try {
        for (;;) {
            const f = WIN32_FIND_DATAW.decode(fd)
            const name = f.cFileName
            if (name !== '.' && name !== '..') {
                out.push({
                    name,
                    size: f.nFileSizeLow + f.nFileSizeHigh * 4294967296,
                    isDir: (f.dwFileAttributes & FileAttribute.DIRECTORY) !== 0,
                    mtime: f.ftLastWriteTime,
                    attrs: f.dwFileAttributes,
                })
            }
            if (!FindNextFile(h, fd.ptr)) break
        }
    } finally {
        FindClose(h)
    }
    return out
}

/** 逐级建目录（已存在静默） */
export function mkdirs(dir: string): void {
    const parts = dir.split('\\').filter((p) => p !== '')
    let cur = ''
    for (const p of parts) {
        cur = cur ? cur + '\\' + p : p
        CreateDirectory(cur, NULL)
    }
}

/** 删除文件（失败静默，调用方按需再查） */
export function removeFile(path: string): void {
    DeleteFile(path)
}

/** 移动/改名（可跨卷）；from → to，覆盖目标。失败静默 */
export function moveFileEx(from: string, to: string, replace: boolean): void {
    // MOVEFILE_REPLACE_EXISTING = 0x1
    MoveFileEx(from, to, replace ? 1 : 0)
}

// ── UTF-8 文本（写盘带 BOM 可选；TextEncoder/TextDecoder 由 quickwin/lib/polyfill 提供）──

/** JS 字符串 → UTF-8 字节 */
export function utf8Encode(s: string): Uint8Array {
    return new TextEncoder().encode(s)
}

/** UTF-8 字节 → JS 字符串 */
export function utf8Decode(u8: Uint8Array): string {
    return new TextDecoder('utf-8').decode(u8)
}

/** 读整个文本文件（UTF-8，容 BOM）；不存在/失败 → null */
export function readText(path: string): string | null {
    const h = openRead(path)
    if (!h) return null
    try {
        const size = fileSize(h)
        if (size < 0n || size > 0x4000000n) return null   // 上限 64MB，防呆
        const n = Number(size)
        if (n === 0) return ''
        const buf = new PtrArrayBuffer(n)
        const got = read(h, buf, n)
        if (got !== n) return null
        const u8 = new Uint8Array(buf, 0, n)
        return utf8Decode(u8)
    } finally {
        close(h)
    }
}

/** 整个写文本文件（UTF-8，withBom 时带 BOM 头）；目录不存在不建。失败静默 */
export function writeText(path: string, text: string, withBom: boolean): void {
    const body = utf8Encode(text)
    const bom = withBom ? [0xEF, 0xBB, 0xBF] : []
    const h = openWrite(path)
    if (!h) return
    try {
        if (bom.length) {
            const b = new PtrArrayBuffer(3)
            const u = new Uint8Array(b)
            u[0] = bom[0]!; u[1] = bom[1]!; u[2] = bom[2]!
            write(h, b, 3)
        }
        const b = new PtrArrayBuffer(body.length)
        new Uint8Array(b).set(body)
        write(h, b, body.length)
        flush(h)
    } finally {
        close(h)
    }
}

/** 追加一段文本（UTF-8，无 BOM——BOM 只写首行，由调用方保证首建时写）。失败 → false */
export function appendText(path: string, text: string): boolean {
    const h = openAppend(path)
    if (!h) return false
    try {
        const body = utf8Encode(text)
        const b = new PtrArrayBuffer(body.length)
        new Uint8Array(b).set(body)
        const ok = write(h, b, body.length) === body.length
        if (ok) flush(h)
        return ok
    } finally {
        close(h)
    }
}
