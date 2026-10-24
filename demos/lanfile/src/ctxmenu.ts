// ctxmenu —— 资源管理器右键"发送到 lanfile"（HKCU shell verb）
//
// 键布局（HKCU 免管理员；shell verb 每次点击现读注册表，写入即刻生效无需重启 Explorer）：
//   Software\Classes\*\shell\lanfile          默认值=菜单文案；Icon=exe 路径
//     \command                                默认值="exe路径" --share "%1"
//   Software\Classes\Directory\shell\lanfile  同上一份（右键文件夹 = 共享整夹）
//
// 多选时 Explorer 按文件数逐个拉起进程（经典 verb 无多参机制）——由 main.ts 的
// 单实例互斥量 + WM_COPYDATA 转发收敛。Win11 上出现在"显示更多选项"旧菜单。
//
// 命令行里的 --share 是必需的：启动器把 exe 后第一个非 - 开头的参数当脚本文件，
// 带 - 前缀才会落进 scriptArgs。
import * as os from 'os'
import { bind, WCHAR } from 'quickwin/lib/ffi/bind.js'
import { NULL, PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import { GetModuleFileName } from 'quickwin/lib/windows/kernel32.js'
import {
    RegCloseKey, RegCreateKeyEx, RegOpenKeyEx, RegSetValueEx,
} from 'quickwin/lib/windows/advapi32.js'
import { HKey, RegAccess, RegType } from 'quickwin/constants'

const RegDeleteKeyW = bind('advapi32.dll', 'RegDeleteKeyW', '<>ptr <WCHAR>ptr -> i32')

const MENU_TEXT = '发送到 lanfile'
const BASES = [
    'Software\\Classes\\*\\shell\\lanfile',
    'Software\\Classes\\Directory\\shell\\lanfile',
]

/** 当前进程 exe 完整路径；失败 → ''（lib GetModuleFileName + WCHAR 编解码） */
export function exePath(): string {
    const buf = WCHAR.alloc(520)
    return GetModuleFileName(NULL, buf, 520) > 0 ? WCHAR.decode(buf) : ''
}

/** JS 字符串 → UTF-16LE（含结尾 NUL）缓冲，照 deskmon/test_registry */
function wbuf(s: string): PtrArrayBuffer<''> {
    const p = new PtrArrayBuffer((s.length + 1) * 2)
    const dv = new DataView(p)
    for (let i = 0; i <= s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true)
    return p
}

/** 键句柄出参回读（ia32 4B / x64 8B）——照 deskmon/test_registry 的 readPtr 先例 */
function readRegPtr(dv: DataView): number {
    if (os.arch === 'ia32') return dv.getUint32(0, true)
    return dv.getUint32(0, true) + dv.getUint32(4, true) * 4294967296
}

function setVerb(base: string, exe: string): boolean {
    try {
        const phk = new PtrArrayBuffer(8)
        if (RegCreateKeyEx(HKey.CURRENT_USER, base, 0, NULL, 0,
                RegAccess.SET_VALUE, NULL, phk, NULL) !== 0) return false
        const hk = readRegPtr(new DataView(phk))
        // lpValueName 是 <WCHAR>ptr：JS 字符串直传（bind 自动编码）；默认值名 = NULL
        // lpData 是 <BYTE>ptr：PAB 直传（UTF-16LE 含结尾 NUL）
        RegSetValueEx(hk, NULL, 0, RegType.SZ, wbuf(MENU_TEXT), (MENU_TEXT.length + 1) * 2)
        RegSetValueEx(hk, 'Icon', 0, RegType.SZ, wbuf(exe), (exe.length + 1) * 2)
        RegCloseKey(hk)
        const pc = new PtrArrayBuffer(8)
        if (RegCreateKeyEx(HKey.CURRENT_USER, base + '\\command', 0, NULL, 0,
                RegAccess.SET_VALUE, NULL, pc, NULL) !== 0) return false
        const hcmd = readRegPtr(new DataView(pc))
        const cmd = '"' + exe + '" --share "%1"'
        RegSetValueEx(hcmd, NULL, 0, RegType.SZ, wbuf(cmd), (cmd.length + 1) * 2)
        RegCloseKey(hcmd)
        return true
    } catch {
        return false
    }
}

function clearVerb(base: string): void {
    try {
        // 先删子键 command 再删父键（XP 兼容的 RegDeleteKeyW 无递归能力）
        RegDeleteKeyW(HKey.CURRENT_USER, base + '\\command')
        RegDeleteKeyW(HKey.CURRENT_USER, base)
    } catch { /* 已不存在视为达成 */ }
}

/** 右键菜单当前是否已注册（command 键存在即开） */
export function isEnabled(): boolean {
    try {
        const phk = new PtrArrayBuffer(8)
        const rc = RegOpenKeyEx(HKey.CURRENT_USER, BASES[0] + '\\command', 0,
            RegAccess.READ, phk)
        if (rc === 0) RegCloseKey(readRegPtr(new DataView(phk)))
        return rc === 0
    } catch {
        return false
    }
}

/** 开/关右键菜单；true = 已达目标态 */
export function setEnabled(on: boolean): boolean {
    if (on) {
        const exe = exePath()
        if (!exe) return false
        return setVerb(BASES[0], exe) && setVerb(BASES[1], exe)
    }
    for (const b of BASES) clearVerb(b)
    return true
}
