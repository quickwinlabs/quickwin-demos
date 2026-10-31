// config —— %APPDATA%\uback\config.json（原子写 tmp + MoveFileEx）与开机自启注册表
import * as os from 'os'
import { bind, WCHAR } from 'quickwin/lib/ffi/bind.js'
import { NULL, PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import { RegCloseKey, RegCreateKeyEx, RegSetValueEx } from 'quickwin/lib/windows/advapi32.js'
import { HKey, RegAccess, RegType } from 'quickwin/constants'
import { appDataBase, desktopPath, exePath } from './drives.js'
import * as wf from './wfile.js'

export interface DeviceRecord {
    vendor: string
    product: string
    label: string
    /** 上次看到的容量（字节，Number 够用：USB < 9PB）；0 = 未知 */
    capacity: number
    /** 是否允许自动备份（每行复选框） */
    allow: boolean
    /** 上次导入完成时间（epoch ms）；0 = 从未 */
    lastImport: number
}

export interface Config {
    version: number
    /** 备份根目录（默认 <桌面>\UsbBackup；每设备子目录 <vendor>_<product>-<hash8>） */
    destRoot: string
    /** 总开关：插入 U 盘时自动备份（与托盘「暂停/恢复」同源） */
    autoImport: boolean
    /** 开机自启 */
    autoStart: boolean
    /** key = 硬件序列号（iSerialNumber） */
    devices: Record<string, DeviceRecord>
}

const RUN_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE_NAME = 'uback'
const RegDeleteValueW = bind('advapi32.dll', 'RegDeleteValueW', '<>ptr <WCHAR>ptr -> i32')

/** 配置目录 %APPDATA%\uback（确保存在） */
export function appDir(): string {
    const dir = appDataBase().replace(/[\\/]+$/, '') + '\\uback'
    wf.mkdirs(dir)
    return dir
}

/** 默认备份根 <桌面>\UsbBackup */
export function defaultDestRoot(): string {
    return desktopPath().replace(/[\\/]+$/, '') + '\\UsbBackup'
}

export function configPath(): string {
    return appDir() + '\\config.json'
}

export function defaultConfig(): Config {
    return {
        version: 1,
        destRoot: defaultDestRoot(),
        autoImport: true,
        autoStart: false,
        devices: {},
    }
}

/** 读配置；损坏/缺失 → 默认 */
export function loadConfig(): Config {
    const text = wf.readText(configPath())
    if (text === null) return defaultConfig()
    try {
        const raw = JSON.parse(text) as Partial<Config>
        const d = defaultConfig()
        const cfg: Config = {
            version: raw.version === 1 ? 1 : d.version,
            destRoot: typeof raw.destRoot === 'string' && raw.destRoot ? raw.destRoot : d.destRoot,
            autoImport: typeof raw.autoImport === 'boolean' ? raw.autoImport : d.autoImport,
            autoStart: typeof raw.autoStart === 'boolean' ? raw.autoStart : d.autoStart,
            devices: {},
        }
        const devs = raw.devices
        if (devs && typeof devs === 'object') {
            for (const k of Object.keys(devs)) {
                const v = devs[k] as Partial<DeviceRecord>
                if (!v || typeof k !== 'string' || !k) continue
                cfg.devices[k] = {
                    vendor: typeof v.vendor === 'string' ? v.vendor : '',
                    product: typeof v.product === 'string' ? v.product : '',
                    label: typeof v.label === 'string' ? v.label : '',
                    capacity: typeof v.capacity === 'number' ? v.capacity : 0,
                    allow: v.allow === true,
                    lastImport: typeof v.lastImport === 'number' ? v.lastImport : 0,
                }
            }
        }
        return cfg
    } catch {
        return defaultConfig()
    }
}

/** 原子写：tmp + MoveFileEx(REPLACE_EXISTING)。目录已由 appDir 确保。 */
export function saveConfig(cfg: Config): void {
    const p = configPath()
    const tmp = p + '.tmp'
    wf.writeText(tmp, JSON.stringify(cfg, null, 2), false)
    wf.moveFileEx(tmp, p, true)
}

/** 键句柄出参回读（ia32 4B / x64 8B）——照 test_registry 的 readPtr 先例 */
function readPtr(buf: PtrArrayBuffer): number {
    const dv = new DataView(buf)
    if (os.arch === 'ia32') return dv.getUint32(0, true)
    return dv.getUint32(0, true) + dv.getUint32(4, true) * 4294967296
}

/** 开机自启：enabled 时写 HKCU\...\Run\uback = "exe 全路径"，否则删该值 */
export function applyAutoStart(enabled: boolean): void {
    const exe = exePath()
    if (!exe) return
    const phk = new PtrArrayBuffer(8)
    const rc = RegCreateKeyEx(HKey.CURRENT_USER, RUN_KEY, 0, NULL, 0, RegAccess.SET_VALUE, NULL, phk, NULL)
    if (rc !== 0) return
    const hkey = readPtr(phk)
    try {
        if (enabled) {
            const val = '"' + exe + '"'
            const vbuf = WCHAR.encode(val)
            // cbData = (字符数 + 1) * 2（含结尾 NUL）
            RegSetValueEx(hkey, VALUE_NAME, 0, RegType.SZ, vbuf, (val.length + 1) * 2)
        } else {
            RegDeleteValueW(hkey, VALUE_NAME)
        }
    } finally {
        RegCloseKey(hkey)
    }
}
