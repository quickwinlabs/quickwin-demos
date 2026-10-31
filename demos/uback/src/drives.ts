// drives —— 可移动盘枚举与 USB 存储识别（仅用 iSerialNumber 做设备身份）
//
// 关键点：
//   - 枚举用 GetLogicalDrives 位掩码 + GetDriveTypeW（只看 DRIVE_REMOVABLE）
//   - 设备身份从 \\.\X: 的 IOCTL_STORAGE_QUERY_PROPERTY → STORAGE_DEVICE_DESCRIPTOR 读
//     VendorId/ProductId/SerialNumber 偏移 + BusType；无 iSerialNumber 的盘无法自动识别
//   - 路径取 SHGetFolderPathW（CSIDL_APPDATA / CSIDL_DESKTOPDIRECTORY），不走 std.getenv
//     （ANSI，中文用户名会乱码）；失败回退 exe 目录 / GetTempPathW
import { bind, WCHAR } from 'quickwin/lib/ffi/bind.js'
import { NULL, PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import { CloseHandle, CreateFile, GetModuleFileName, GetTempPath } from 'quickwin/lib/windows/kernel32.js'
import { FileAccess, FileCreation, FileShare } from 'quickwin/constants'

const GetLogicalDrives = bind('kernel32.dll', 'GetLogicalDrives', ' -> u32')
const GetDriveTypeW = bind('kernel32.dll', 'GetDriveTypeW', '<WCHAR>ptr! -> u32')
const GetVolumeInformationW = bind('kernel32.dll', 'GetVolumeInformationW',
    '<WCHAR>ptr! <BYTE>ptr u32 <BYTE>ptr <BYTE>ptr <BYTE>ptr <BYTE>ptr u32 -> i32')
const GetDiskFreeSpaceExW = bind('kernel32.dll', 'GetDiskFreeSpaceExW',
    '<WCHAR>ptr! <BYTE>ptr <BYTE>ptr <BYTE>ptr -> i32')
const DeviceIoControl = bind('kernel32.dll', 'DeviceIoControl',
    '<HFILE>ptr! u32 <BYTE>ptr u32 <BYTE>ptr u32 <BYTE>ptr <>ptr -> i32')
const SHGetFolderPathW = bind('shell32.dll', 'SHGetFolderPathW',
    '<HWND>ptr i32 <>ptr u32 <BYTE>ptr -> i32')

// —— 常量（demo 内字面量，不改 constants.ts）——
const DRIVE_REMOVABLE = 2
const IOCTL_STORAGE_QUERY_PROPERTY = 0x2D1400
const StorageDeviceProperty = 0
const PropertyStandardQuery = 0
export const BusTypeUsb = 7
export const CSIDL_APPDATA = 0x001A
export const CSIDL_DESKTOPDIRECTORY = 0x0010

export interface DriveInfo {
    /** 盘符（无冒号），如 'F' */
    letter: string
    /** 根路径，如 'F:\\' */
    root: string
    /** GetDriveTypeW 返回值（本 demo 只处理 DRIVE_REMOVABLE=2） */
    type: number
    /** 卷标（可为空） */
    label: string
    /** 文件系统名（FAT32/NTFS/…，可为空） */
    fs: string
    /** 容量（字节） */
    total: bigint
    /** 可用（字节） */
    free: bigint
    /** USB 描述符：厂商（可为空） */
    vendor: string
    /** USB 描述符：产品（可为空） */
    product: string
    /** USB 描述符：iSerialNumber（可为空 → 无法自动识别） */
    serial: string
    /** STORAGE_BUS_TYPE（7 = USB） */
    busType: number
}

/** 位掩码 → 存在的盘符列表（'A'..'Z'） */
export function existingLetters(): string[] {
    const mask = GetLogicalDrives()
    const out: string[] = []
    for (let i = 0; i < 26; i++) {
        if (mask & (1 << i)) out.push(String.fromCharCode(65 + i))
    }
    return out
}

/** 读卷信息（卷标/文件系统/容量）；失败 → null（未格式化盘） */
function readVolume(letter: string): { label: string; fs: string; total: bigint; free: bigint } | null {
    const labelBuf = new PtrArrayBuffer(520)   // <BYTE>ptr 出参：无品牌缓冲（UTF-16LE）
    const fsBuf = new PtrArrayBuffer(520)
    const serialOut = new PtrArrayBuffer(4)
    const maxLenOut = new PtrArrayBuffer(4)
    const flagsOut = new PtrArrayBuffer(4)
    const ok = GetVolumeInformationW(letter + ':\\', labelBuf, 260, serialOut, maxLenOut, flagsOut, fsBuf, 260)
    if (!ok) return null
    const freeOut = new PtrArrayBuffer(8)
    const totalOut = new PtrArrayBuffer(8)
    const totalFreeOut = new PtrArrayBuffer(8)
    if (!GetDiskFreeSpaceExW(letter + ':\\', freeOut, totalOut, totalFreeOut)) return null
    return {
        label: wstr(labelBuf),
        fs: wstr(fsBuf),
        total: new DataView(totalOut).getBigUint64(0, true),
        free: new DataView(freeOut).getBigUint64(0, true),
    }
}

/** 无品牌缓冲 → UTF-16LE 字符串（到 NUL 截断） */
function wstr(buf: PtrArrayBuffer): string {
    const s = new TextDecoder('utf-16le').decode(new Uint8Array(buf))
    const i = s.indexOf('\0')
    return i >= 0 ? s.slice(0, i) : s
}

/** 从 STORAGE_DEVICE_DESCRIPTOR 缓冲读一个偏移字符串（ASCII，长度 = 下一偏移 - 偏移） */
function readAscii(buf: PtrArrayBuffer, off: number, end: number): string {
    if (off === 0 || end <= off) return ''
    const dv = new DataView(buf)
    const bytes: number[] = []
    for (let i = off; i < end && i < buf.byteLength; i++) {
        const c = dv.getUint8(i)
        if (c === 0) break
        bytes.push(c)
    }
    if (bytes.length === 0) return ''
    // 描述符里常见 ISO-8859-1 拉丁字符；按单字节解码（ASCII 子集为主，够用）
    return String.fromCharCode(...bytes).replace(/\s+$/, '')
}

/** 读 USB 存储描述符；失败 → null（无媒体/被占用/权限等） */
function readStorageDescriptor(letter: string): {
    vendor: string; product: string; serial: string; busType: number
} | null {
    const h = CreateFile('\\\\.\\' + letter + ':', FileAccess.GENERIC_READ,
        FileShare.READ | FileShare.WRITE, NULL, FileCreation.OPEN_EXISTING, 0, NULL)
    if (!h || h === -1) return null
    try {
        // STORAGE_PROPERTY_QUERY：PropertyId(0) + QueryType(0) + AdditionalParameters[1] = 12B
        const query = new PtrArrayBuffer(12)
        const qdv = new DataView(query)
        qdv.setUint32(0, StorageDeviceProperty, true)
        qdv.setUint32(4, PropertyStandardQuery, true)
        const out = new PtrArrayBuffer(1024)
        const bytesReturned = new PtrArrayBuffer(4)
        if (!DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, query, 12, out, 1024, bytesReturned, NULL)) {
            return null
        }
        const dv = new DataView(out)
        const size = dv.getUint32(4, true)      // STORAGE_DEVICE_DESCRIPTOR.Size
        const vOff = dv.getUint32(12, true)
        const pOff = dv.getUint32(16, true)
        const sOff = dv.getUint32(24, true)
        const busType = dv.getUint32(28, true)
        // 各字符串长度 = 下一个偏移 - 自身偏移（无下一个则到 Size）
        const vendor = readAscii(out, vOff, pOff !== 0 ? pOff : size)
        const product = readAscii(out, pOff, sOff !== 0 ? sOff : size)
        const serial = readAscii(out, sOff, size)
        return { vendor, product, serial, busType }
    } finally {
        CloseHandle(h)
    }
}

/** 当前可移动盘（DRIVE_REMOVABLE）列表；只带卷信息成功者（有媒体） */
export function removableDrives(): DriveInfo[] {
    const out: DriveInfo[] = []
    for (const letter of existingLetters()) {
        const type = GetDriveTypeW(letter + ':\\')
        if (type !== DRIVE_REMOVABLE) continue
        const vol = readVolume(letter)
        if (!vol) continue   // 空卡槽/未格式化：不进设备列表（也无需提示）
        const desc = readStorageDescriptor(letter)
        out.push({
            letter,
            root: letter + ':\\',
            type,
            label: vol.label,
            fs: vol.fs,
            total: vol.total,
            free: vol.free,
            vendor: desc ? desc.vendor : '',
            product: desc ? desc.product : '',
            serial: desc ? desc.serial : '',
            busType: desc ? desc.busType : 0,
        })
    }
    return out
}

// ── 路径工具 ──

/** 当前进程 exe 完整路径；失败 → '' */
export function exePath(): string {
    const buf = WCHAR.alloc(520)
    return GetModuleFileName(NULL, buf, 520) > 0 ? WCHAR.decode(buf) : ''
}

/** SHGetFolderPathW 封装；失败 → '' */
function folderPath(csidl: number): string {
    const buf = WCHAR.alloc(260)
    return SHGetFolderPathW(NULL, csidl, NULL, 0, buf) === 0 ? WCHAR.decode(buf) : ''
}

/** %APPDATA%（SHGetFolderPathW，避免 std.getenv 的 ANSI 中文乱码）；失败回退 exe 目录 */
export function appDataBase(): string {
    const p = folderPath(CSIDL_APPDATA)
    if (p) return p.replace(/[\\/]+$/, '')
    const exe = exePath()
    if (exe) {
        const i = exe.lastIndexOf('\\')
        return i > 0 ? exe.slice(0, i) : exe
    }
    return tempDir()
}

/** 桌面目录（CSIDL_DESKTOPDIRECTORY）；失败回退 %TEMP% */
export function desktopPath(): string {
    const p = folderPath(CSIDL_DESKTOPDIRECTORY)
    if (p) return p.replace(/[\\/]+$/, '')
    return tempDir()
}

/** 临时目录（尾带反斜杠，去尾） */
export function tempDir(): string {
    const buf = WCHAR.alloc(260)
    const n = GetTempPath(260, buf)
    if (n === 0) return ''
    const p = WCHAR.decode(buf).replace(/[\\/]+$/, '')
    return p || 'C:\\Windows\\Temp'
}
