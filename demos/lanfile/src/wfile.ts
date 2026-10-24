// wfile —— Unicode 安全的文件操作（Win32 W 版 API）
//
// 运行时 os.open/os.stat/os.readdir 走 ANSI CRT：JS 的 UTF-8 路径被按 ACP 解释，
// 中文名写盘成乱码；readdir 回来的 ANSI 字节还可能恰好是合法 UTF-8，被当成文本
// 解码后无法还原。凡是用户可见的路径（共享文件/上传路径/文件夹遍历）一律走这里。
//
// 句柄用 lib/windows/kernel32 的 CreateFileW/ReadFile/WriteFile，不用 CRT fd。
import { NULL, PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import {
    CreateFile, ReadFile, WriteFile, SetFilePointer, CloseHandle, GetFileAttributes,
    CreateDirectory, DeleteFile, FindFirstFile, FindNextFile, FindClose,
} from 'quickwin/lib/windows/kernel32.js'
import { WIN32_FIND_DATAW } from 'quickwin/lib/windows/structs.js'
import { FileAccess, FileAttribute, FileCreation, FileSeekFrom, FileShare } from 'quickwin/constants'

const INVALID = 0xFFFFFFFF

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

export function close(h: HFile): void {
    CloseHandle(h)
}

/** 路径属性（文件/目录/大小）；不存在 → null。目录 size 恒 0 */
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
