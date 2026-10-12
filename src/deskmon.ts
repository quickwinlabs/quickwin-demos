// deskmon —— quickwin 桌面资源监控悬浮窗
//
// 常驻桌面细条：网速 / 内存 / CPU，1s 刷新；托盘右键菜单支持置顶切换与退出；
// 整窗 WM_NCHITTEST→HTCAPTION 全区可拖（STATIC 子控件不截获鼠标，拖动不受影响）。
// 数据全部来自 Win32 FFI（XP+ 可用，无第三方依赖）：
//   CPU    GetSystemTimes 两次采样差分（kernel32）
//   内存   GlobalMemoryStatusEx（kernel32）
//   网速   GetIfTable 遍历非 loopback 且 OPER_UP 的接口，In/OutOctets 差分（iphlpapi）
//
// 构建：npm run build（build.ts：tsc → esbuild --bundle → brotli embed）
//   - tsc 负责类型检查，并把 quickwin_const.d.ts 的 const enum（gui.WindowStyle 等）
//     内联为数字字面量——esbuild 不解析 .d.ts，这一步是枚举可用的前提
//   - gui/std/os/ffi 为运行时模块，bundle 保留 ESM import（format=esm）
import * as gui from 'gui'
import * as os from 'os'
import { bind } from 'quickwin/lib/ffi/bind.js'
import { struct } from 'quickwin/lib/ffi/struct.js'
import { PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import { SystemParametersInfo } from 'quickwin/lib/windows/user32.js'
import { RECT } from 'quickwin/lib/windows/structs.js'

// ── setTimeout 桥接：os 事件循环已与 gui 消息泵集成（quickjs-libc 消息泵里 poll 定时器）──
if (typeof (globalThis as any).setTimeout === 'undefined') {
    ;(globalThis as any).setTimeout = (fn: any, _ms?: number, ...a: any[]) =>
        os.setTimeout(() => fn(...a), _ms ?? 0)
}

// ── 常量 ──
// Win32 枚举（WindowStyle/WmMsg/NotifyIconCmd/...）来自 quickwin.d.ts 的 const enum，
// 由构建链的 tsc 阶段内联为数字（esbuild 只拿 .tsc-out 的字面量产物）
const WM_TRAY = 0x8001          // 托盘回调消息（自定义）
const WM_NCHITTEST = 0x0084
const WM_SETFONT = 0x0030
const HTCAPTION = 2             // 整窗返回此命中码 = 系统级窗口拖动
const SPI_GETWORKAREA = 0x0030  // 工作区（不含任务栏）——悬浮窗贴任务栏上沿
const IF_TYPE_SOFTWARE_LOOPBACK = 24   // 注意：6 = IF_TYPE_ETHERNET_CSMACD（以太网），别搞混
const NET_RESET_BPS = 5e8       // 聚合增量换算 > 500MB/s：计数器重置/网卡重枚举，按 0 处理
const TICK_MS = 1000
const MON_W = 330               // 悬浮窗尺寸：单行文本（最长 "↓ 1023.9 MB/s ↑ 1023.9 MB/s 内存 100% CPU 100%"）
const MON_H = 28
const MENU_EXIT = 1
const MENU_TOPMOST = 2
const MAX_IF = 64               // 接口数上限：MIB_IFTABLE 缓冲按 64 行预分配
// MIB_IFROW（实测行距 860B = MSDN sizeof；mingw 头的 852 少 8B 尾部 padding）——
//   首行偏移：dwIndex@512 dwType@516 dwMtu@520 dwSpeed@524
//   dwOperStatus@544  dwInOctets@552  dwOutOctets@556
const IFROW_SIZE = 860
const IFROW_OFF_TYPE = 516
const IFROW_OFF_OPER = 544
const IFROW_OFF_IN = 552
const IFROW_OFF_OUT = 556

// ── FFI：结构（出参位 def.alloc() 零填充槽，调用后 decode 读回）──
const FILETIME = /* @__PURE__ */ struct('FILETIME', {
    dwLowDateTime: 'u32',
    dwHighDateTime: 'u32',
})
// 入+就地出混合（dwLength 必填入参 + 系统填充其余）→ encode 流（同 DEVMODEW 先例）
const MEMORYSTATUSEX = /* @__PURE__ */ struct('MEMORYSTATUSEX', {
    dwLength: 'u32',
    dwMemoryLoad: 'u32',
    ullTotalPhys: 'u64',
    ullAvailPhys: 'u64',
    ullTotalPageFile: 'u64',
    ullAvailPageFile: 'u64',
    ullTotalVirtual: 'u64',
    ullAvailVirtual: 'u64',
    ullAvailExtendedVirtual: 'u64',
})

// ── FFI：绑定（出参/通用缓冲位不注册 encoder——位只收 def.alloc() 分配的 .ptr）──
const GetSystemTimes = bind('kernel32.dll', 'GetSystemTimes', '<FILETIME>ptr <FILETIME>ptr <FILETIME>ptr -> i32')
const GlobalMemoryStatusEx = bind('kernel32.dll', 'GlobalMemoryStatusEx', '<MEMORYSTATUSEX>ptr -> i32', { MEMORYSTATUSEX })
const GetIfTable = bind('iphlpapi.dll', 'GetIfTable', '<>ptr <>ptr u32 -> u32')

// ── 采样器 ──
let prevIdle = -1, prevKernel = -1, prevUser = -1
/** CPU 使用率（0-100 整数）；首个样本只打底，返回 null */
function sampleCpu(): number | null {
    const i = FILETIME.alloc(), k = FILETIME.alloc(), u = FILETIME.alloc()
    if (!GetSystemTimes(i.ptr, k.ptr, u.ptr)) return null
    const toN = (buf: any) => {
        const d: any = FILETIME.decode(buf)
        return d.dwHighDateTime * 2 ** 32 + d.dwLowDateTime
    }
    const idle = toN(i), kernel = toN(k), user = toN(u)
    if (prevIdle < 0) { prevIdle = idle; prevKernel = kernel; prevUser = user; return null }
    const dTotal = (kernel - prevKernel) + (user - prevUser)
    const dIdle = idle - prevIdle
    prevIdle = idle; prevKernel = kernel; prevUser = user
    if (dTotal <= 0) return null
    return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)))
}

/** 已用内存百分比；失败返回 null */
function sampleMem(): number | null {
    const ms: any = MEMORYSTATUSEX.encode({ dwLength: MEMORYSTATUSEX.size })
    if (!GlobalMemoryStatusEx(ms.ptr)) return null
    const s: any = MEMORYSTATUSEX.decode(ms)
    const total = Number(s.ullTotalPhys)
    const avail = Number(s.ullAvailPhys)
    if (!(total > 0)) return null
    return Math.round((1 - avail / total) * 100)
}

// MIB_IFTABLE 变长表：4B dwNumEntries + MAX_IF × MIB_IFROW 连续行；手动 DataView 读取
const ifBuf = new PtrArrayBuffer(4 + MAX_IF * IFROW_SIZE)
const ifSize = new PtrArrayBuffer(4)
let prevNetIn = -1, prevNetOut = -1, prevNetMs = 0
/** [下行B/s, 上行B/s]；首个样本/失败返回 null */
function sampleNet(): [number, number] | null {
    const dv = new DataView(ifBuf)
    dv.setUint32(0, ifBuf.byteLength, true)   // 入参：缓冲容量；出参：实际所需字节
    if (GetIfTable((ifBuf as any).ptr, (ifSize as any).ptr, 1) !== 0) return null  // NO_ERROR = 0
    const n = Math.min(dv.getUint32(0, true), MAX_IF)
    let inSum = 0, outSum = 0
    for (let r = 0; r < n; r++) {
        const off = 4 + r * IFROW_SIZE
        if (dv.getUint32(off + IFROW_OFF_TYPE, true) === IF_TYPE_SOFTWARE_LOOPBACK) continue
        // 不按 operStatus 过滤：Dormant(5) 等低功耗态接口同样承载流量（win7 NAT 网卡实测 Dormant）
        inSum += dv.getUint32(off + IFROW_OFF_IN, true)
        outSum += dv.getUint32(off + IFROW_OFF_OUT, true)
    }
    const now = Date.now()
    if (prevNetIn < 0) { prevNetIn = inSum; prevNetOut = outSum; prevNetMs = now; return null }
    const dt = (now - prevNetMs) / 1000
    // u32 octets 差分：>>>0 吸收回绕；增量异常（重置）按 0
    const dIn = (inSum - prevNetIn) >>> 0
    const dOut = (outSum - prevNetOut) >>> 0
    prevNetIn = inSum; prevNetOut = outSum; prevNetMs = now
    if (dt <= 0) return null
    return [
        dIn / dt < NET_RESET_BPS ? dIn / dt : 0,
        dOut / dt < NET_RESET_BPS ? dOut / dt : 0,
    ]
}

function fmtRate(bps: number | null): string {
    if (bps === null) return '—'
    if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s'
    if (bps >= 1024) return Math.round(bps / 1024) + ' KB/s'
    return Math.round(bps) + ' B/s'
}

// ── GUI ──
let topmost = true
let textHwnd: any = null

gui.RegisterClass('DeskMon', (hwnd: any, msg: number, _w: number, lParam: number) => {
    if (!hwnd) return gui.DefWindowProc(hwnd, msg, _w, lParam)
    if (msg === WM_NCHITTEST) return HTCAPTION
    if (msg === WM_TRAY) {
        // lParam：0x0201 左键 / 0x0204、0x007B 右键（对齐 tray_demo）
        if (lParam === 0x0204 || lParam === 0x007B) {
            gui.SetForegroundWindow(hwnd)
            const p = gui.GetCursorPos()
            const menu = gui.CreatePopupMenu()
            gui.AppendMenu(menu, 0, MENU_TOPMOST, topmost ? '取消置顶(&T)' : '窗口置顶(&T)')
            gui.AppendMenu(menu, 0x0800, 0, '')   // MF_SEPARATOR
            gui.AppendMenu(menu, 0, MENU_EXIT, '退出(&X)')
            const cmd = gui.TrackPopupMenu(menu, p ? p[0] : 0, p ? p[1] : 0, undefined, hwnd)
            gui.DestroyMenu(menu)
            if (cmd === MENU_EXIT) {
                gui.ShellNotifyIcon(gui.NotifyIconCmd.DELETE, { hwnd, uID: 1 } as any)
                gui.PostQuitMessage(0)
            } else if (cmd === MENU_TOPMOST) {
                topmost = !topmost
                // SWP_NOMOVE | SWP_NOSIZE
                gui.SetWindowPos(hwnd, topmost ? gui.SetWindowPosHwnd.TOPMOST : gui.SetWindowPosHwnd.NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002)
            }
        }
        return 0
    }
    if (msg === gui.WmMsg.CLOSE) {   // 关窗 = 隐藏到托盘（常驻），仅菜单退出
        gui.ShowWindow(hwnd, 0)      // SW_HIDE
        return 0
    }
    return gui.DefWindowProc(hwnd, msg, _w, lParam)
})

// 工作区右下角（任务栏上沿）落位
const wa: any = RECT.alloc()
SystemParametersInfo(SPI_GETWORKAREA, 0, wa.ptr, 0)
const work: any = RECT.decode(wa)
const initX = (work.right || 1024) - MON_W - 8
const initY = (work.bottom || 768) - MON_H - 8

// WS_POPUP | WS_VISIBLE；EX 风格暂不引入（gui.CreateWindow 无 exStyle 位）——
// 任务栏多一个按钮的观感代价换取 100% gui 封装路径，后续可切 FFI CreateWindowExW
const hwndMain = gui.CreateWindow(
    'DeskMon', '',
    gui.WindowStyle.POPUP | gui.WindowStyle.VISIBLE,
    initX, initY, MON_W, MON_H, null, null)
if (!hwndMain) os.exit(1)

// STATIC 子控件承载文本：不截获鼠标 → 点击落回父窗 → WM_NCHITTEST(HTCAPTION) 整窗可拖
textHwnd = gui.CreateWindow(
    'STATIC', 'deskmon starting…',
    gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE,
    8, 5, MON_W - 16, MON_H - 10, hwndMain, null)
const font = gui.CreateSystemDpiFont()
if (textHwnd && font) gui.SendMessage(textHwnd, WM_SETFONT, font as any, 1)

// 置顶 + 托盘
gui.SetWindowPos(hwndMain, gui.SetWindowPosHwnd.TOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002)
let hIcon: any = gui.LoadAppIcon()
if (!hIcon) hIcon = gui.LoadImage(null, gui.IDI.APPLICATION, gui.ImageType.ICON, 0, 0, gui.LoadImageFlag.SHARED)
if (hIcon) {
    gui.ShellNotifyIcon(gui.NotifyIconCmd.ADD, {
        hwnd: hwndMain, uID: 1,
        flags: gui.NotifyIconFlag.MESSAGE | gui.NotifyIconFlag.ICON,
        callbackMessage: WM_TRAY,
        hIcon,
    } as any)
}

// ── 刷新循环（setTimeout 自调度；无控制台时 print 静默丢弃，-o CON/-o LOG 可观察）──
function tick() {
    const cpu = sampleCpu()
    const mem = sampleMem()
    const net = sampleNet()
    const line = '↓ ' + fmtRate(net ? net[0] : null)
        + '   ↑ ' + fmtRate(net ? net[1] : null)
        + '   内存 ' + (mem === null ? '--' : mem) + '%'
        + '   CPU ' + (cpu === null ? '--' : cpu) + '%'
    if (textHwnd) gui.SetWindowText(textHwnd, line)
    print(line)
    setTimeout(tick, TICK_MS)
}
print('deskmon started: ' + MON_W + 'x' + MON_H + ' @(' + initX + ',' + initY
    + ') topmost=' + topmost + ' tick=' + TICK_MS + 'ms')
setTimeout(tick, TICK_MS)
