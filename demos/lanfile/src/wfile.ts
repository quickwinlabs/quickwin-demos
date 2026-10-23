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
import { FileCreation, FileSeekFrom } from 'quickwin/constants'

const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const FILE_SHARE_READ = 0x1
const FILE_SHARE_WRITE = 0x2
const FILE_ATTRIBUTE_NORMAL = 0x80
const FILE_ATTRIBUTE_DIRECTORY = 0x10
const INVALID = 0xFFFFFFFF

const readOut = new PtrArrayBuffer(4)
const writeOut = new PtrArrayBuffer(4)

function bad(h: any): boolean {
    return !h || h === -1 || (h >>> 0) === INVALID
}

export interface Entry {
    name: string
    size: number
    isDir: boolean
}

/** 打开读；失败 → null */
export function openRead(path: string): any {
    const h = CreateFile(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
        FileCreation.OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL)
    return bad(h) ? null : h
}

/** 打开写（覆盖）；失败 → null */
export function openWrite(path: string): any {
    const h = CreateFile(path, GENERIC_WRITE, FILE_SHARE_READ, NULL,
        FileCreation.CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL)
    return bad(h) ? null : h
}

/** 读至多 len 字节到 buf；返回实际字节数，失败 -1，EOF 0 */
export function read(h: any, buf: PtrArrayBuffer, len: number): number {
    if (!ReadFile(h, buf, len, readOut, NULL)) return -1
    return new DataView(readOut).getUint32(0, true)
}

/** 写 buf 前 len 字节；返回实际写入数，失败 -1 */
export function write(h: any, buf: PtrArrayBuffer, len: number): number {
    if (!WriteFile(h, buf, len, writeOut, NULL)) return -1
    return new DataView(writeOut).getUint32(0, true)
}

/** 绝对定位到 offset（文件头起） */
export function seek(h: any, offset: number): void {
    SetFilePointer(h, offset, NULL, FileSeekFrom.BEGIN)
}

export function close(h: any): void {
    CloseHandle(h)
}

/** 路径属性（文件/目录/大小）；不存在 → null。目录 size 恒 0 */
export function stat(path: string): Entry | null {
    const fd = WIN32_FIND_DATAW.alloc()
    const h = FindFirstFile(path, fd.ptr)
    if (bad(h)) return null
    const f = WIN32_FIND_DATAW.decode(fd) as any
    FindClose(h)
    const attrs = f.dwFileAttributes as number
    return {
        name: f.cFileName as string,
        size: f.nFileSizeLow + f.nFileSizeHigh * 4294967296,
        isDir: (attrs & FILE_ATTRIBUTE_DIRECTORY) !== 0,
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
            const f = WIN32_FIND_DATAW.decode(fd) as any
            const name = f.cFileName as string
            if (name !== '.' && name !== '..') {
                out.push({
                    name,
                    size: f.nFileSizeLow + f.nFileSizeHigh * 4294967296,
                    isDir: (f.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) !== 0,
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
