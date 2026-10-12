// deskmon —— quickwin 桌面资源监控悬浮窗
//
// 常驻桌面细条：网速 / 内存 / CPU，1s 刷新；托盘右键菜单支持置顶切换与退出；
// 整窗 WM_NCHITTEST→HTCAPTION 全区可拖。半透明背景：WS_EX_LAYERED + LWA_ALPHA
// （XP 软件混合 / win7+ DWM，桌面壁纸透出）。文字由父窗 WM_PAINT 自绘而非 STATIC
// 子控件——Win8 起才支持 layered 子窗口合成，Win8 前 child 不参与（MSDN）。
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
import { SystemParametersInfo, BeginPaint, EndPaint, DrawText } from 'quickwin/lib/windows/user32.js'
import { CreateSolidBrush, SetBkMode, SetTextColor, SelectObject, CreateFontIndirect, GetTextExtentPoint32 } from 'quickwin/lib/windows/gdi32.js'
import { RECT, PAINTSTRUCT, LOGFONTW, SIZE } from 'quickwin/lib/windows/structs.js'
import { ICON_NET_B64, ICON_MEM_B64, ICON_CPU_B64 } from './icons.js'

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
const WM_PAINT = 0x000F
const WM_ERASEBKGND = 0x0014
const HTCAPTION = 2             // 整窗返回此命中码 = 系统级窗口拖动
const GWL_EXSTYLE = -20         // Gwlp 枚举无 EXSTYLE → 字面量绕过枚举域
const WS_EX_LAYERED = 0x00080000
const WS_EX_TOOLWINDOW = 0x00000080   // 工具窗口：任务栏不显示按钮、Alt+Tab 不列出（常驻入口只留托盘）
const LWA_ALPHA = 0x2           // SetLayeredWindowAttributes 用全局 alpha（非色键）
const ALPHA = 130               // 不透明度 0-255（≈51%：更强挂件感，白字仍可读）
const COLOR_BG = 0x00101010     // 底色（COLORREF 0x00BBGGFF 近黑）：整窗按 alpha 混合到桌面
const COLOR_BORDER = 0x00555555 // 1px 描边：比底色亮一档的内敛挂件感
const COLOR_WHITE = 0x00FFFFFF
const RGN_RADIUS = 8            // 圆角椭圆参数（region/RoundRect 同语义，视觉半径≈4px；28 高过圆显幼稚）
const DT_FLAGS = 0x00000824     // DT_SINGLELINE|DT_VCENTER|DT_NOPREFIX；DT_VCENTER 无 SINGLELINE 时被 MS 忽略→顶对齐
const SPI_GETWORKAREA = 0x0030  // 工作区（不含任务栏）——悬浮窗贴任务栏上沿
const IF_TYPE_SOFTWARE_LOOPBACK = 24   // 注意：6 = IF_TYPE_ETHERNET_CSMACD（以太网），别搞混
const NET_RESET_BPS = 5e8       // 聚合增量换算 > 500MB/s：计数器重置/网卡重枚举，按 0 处理
const TICK_MS = 1000
const MON_W = 185               // 悬浮窗尺寸：三段紧凑（水平居中，段间隙 8px，icon→text 4px）
const SEG_GAP = 8               // 段与段之间空隙（无竖线，仅靠呼吸空隙）
const ICON_TEXT_GAP = 4         // icon 与其后文本的紧凑空隙
const MON_H = 24
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
// 半透明：lib/windows 未封装 → 自 bind
const SetLayeredWindowAttributes = bind('user32.dll', 'SetLayeredWindowAttributes', '<>ptr u32 u32 u32 -> i32')
// 圆角 region：lib/windows 未封装 → 自 bind（HRGN 成功后系统接管，勿 DeleteObject）
const CreateRoundRectRgn = bind('gdi32.dll', 'CreateRoundRectRgn', 'i32 i32 i32 i32 i32 i32 -> <HGDIOBJ>ptr')
const SetWindowRgn = bind('user32.dll', 'SetWindowRgn', '<>ptr <>ptr i32 -> i32')
// 圆角描边一体：RoundRect 用当前 pen 画边（沿角弧）+ 当前 brush 填充
const CreatePen = bind('gdi32.dll', 'CreatePen', 'i32 i32 u32 -> <HGDIOBJ>ptr')
const RoundRect = bind('gdi32.dll', 'RoundRect', '<>ptr i32 i32 i32 i32 i32 i32 -> i32')
// 字段图标：内存字节成像 + 绘制（lib/windows 未封装 → 自 bind）
const CreateIconFromResourceEx = bind('user32.dll', 'CreateIconFromResourceEx', '<>ptr u32 i32 i32 i32 i32 u32 -> <HICON>ptr')
const DrawIconEx = bind('user32.dll', 'DrawIconEx', '<>ptr i32 i32 <>ptr i32 i32 u32 <>ptr u32 -> i32')

// ── 字段图标：base64 → RT_ICON（ico 跳 6B ICONDIR）→ 内存成像，免外置文件 ──
const ICON_SIZE = 16
const B64T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function b64bytes(s: string): Uint8Array {
    const out = new Uint8Array((s.length * 3) >> 2)
    let v = 0, vi = 0, oi = 0
    for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) === 61) break   // '='
        const d = B64T.indexOf(s[i])
        if (d < 0) continue
        v = (v << 6) | d; vi += 6
        if (vi >= 8) { vi -= 8; out[oi++] = (v >> vi) & 0xff }
    }
    return out.subarray(0, oi)
}
function makeIcon(b64: string): any {
    const bytes = b64bytes(b64)
    const buf = new PtrArrayBuffer(bytes.length)
    new Uint8Array(buf as any).set(bytes)
    // ico 布局 6B ICONDIR + 16B ICONDIRENTRY + DIB；CreateIconFromResourceEx 的
    // presbits 期望 BITMAPINFOHEADER 起（Wine/ReactOS 实现）→ 跳 22；dwVer = 0x00030000
    return CreateIconFromResourceEx((buf as any).ptr + 22, bytes.length - 22, 1, 0x00030000, ICON_SIZE, ICON_SIZE, 0)
}
const hIconNet = makeIcon(ICON_NET_B64)
const hIconMem = makeIcon(ICON_MEM_B64)
const hIconCpu = makeIcon(ICON_CPU_B64)

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
// 分段自绘文本：[网速值] [内存%] [CPU%]（图标即字段标签，段间空格；tick 更新 → InvalidateRect）
let segTexts = ['starting…', '', '']
const paintBuf = PAINTSTRUCT.alloc()     // BeginPaint/EndPaint 出参（消息内复用）
const bgBrush = CreateSolidBrush(COLOR_BG)
const borderPen = CreatePen(0, 1, COLOR_BORDER)   // PS_SOLID：1px 描边

gui.RegisterClass('DeskMon', (hwnd: any, msg: number, _w: number, lParam: number) => {
    if (!hwnd) return gui.DefWindowProc(hwnd, msg, _w, lParam)
    if (msg === WM_NCHITTEST) return HTCAPTION
    // 自绘窗口：RoundRect 底色+描边擦除 → DrawText；erase=false 时不发本消息
    if (msg === WM_ERASEBKGND) return 1
    if (msg === WM_PAINT) {
        try {
            // 出参/未注册位只收 .ptr 品牌指针（整 buffer 走 unknown layout fail-fast）
            const hdc = BeginPaint(hwnd, paintBuf.ptr)
            if (hdc) {
                // 一体画底+描边：pen 沿圆角弧（与 region 同椭圆参数），brush 填充；
                // GDI 绘制矩形含 right/bottom 端点 → -1 对齐 region 的 exclusive 语义
                SelectObject(hdc, borderPen)
                SelectObject(hdc, bgBrush)
                RoundRect(hdc, 0, 0, MON_W - 1, MON_H - 1, RGN_RADIUS, RGN_RADIUS)
                if (font) SelectObject(hdc, font)
                SetBkMode(hdc, gui.BackgroundMode.TRANSPARENT)   // 底已 RoundRect 填充，文字背景透明防覆盖
                SetTextColor(hdc, COLOR_WHITE)
                // 分段 [icon] 值文本水平居中：先 GetTextExtentPoint32 累加总宽，
                // 再从 (MON_W - total)/2 起绘
                const icons = [hIconNet, hIconMem, hIconCpu]
                const sz = SIZE.alloc()
                let total = 3 * ICON_SIZE + 2 * SEG_GAP + 3 * ICON_TEXT_GAP
                for (const t of segTexts) {
                    if (!t) continue
                    if (GetTextExtentPoint32(hdc, t, t.length, sz.ptr)) {
                        total += (SIZE.decode(sz) as any).cx
                    }
                }
                let x = Math.max(2, (MON_W - total) >> 1)
                for (let i = 0; i < 3; i++) {
                    if (icons[i]) {
                        // DI_NORMAL = 0x0003（DI_IMAGE|DI_MASK）：flags 传 0 则不绘制
                        DrawIconEx(hdc, x, (MON_H - ICON_SIZE) >> 1, icons[i], ICON_SIZE, ICON_SIZE, 0, 0, 3)
                    }
                    x += ICON_SIZE + ICON_TEXT_GAP
                    const t = segTexts[i]
                    if (!t) continue
                    const r = RECT.encode({ left: x, top: 0, right: MON_W, bottom: MON_H })
                    DrawText(hdc, t, -1, r.ptr, DT_FLAGS)
                    if (GetTextExtentPoint32(hdc, t, t.length, sz.ptr)) {
                        const d: any = SIZE.decode(sz)
                        x += d.cx + SEG_GAP
                    } else {
                        x += SEG_GAP
                    }
                }
            }
            EndPaint(hwnd, paintBuf.ptr)
        } catch (e) {
            print('paint err: ' + e)
        }
        return 0
    }
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
const initY = (work.bottom || 768) - MON_H - 40   // 默认稍抬高：距任务栏上沿 40px

// WS_POPUP（不带 VISIBLE）：EX 风格 CreateWindow 不带 → 补位后再显示，
// 否则任务栏已按普通窗口建好按钮（事后补 TOOLWINDOW 两机实测不刷新）
const hwndMain = gui.CreateWindow(
    'DeskMon', '',
    gui.WindowStyle.POPUP,
    initX, initY, MON_W, MON_H, null, null)
if (!hwndMain) os.exit(1)

// 半透明 + 免任务栏按钮：EX 风格 CreateWindow 不带 → 事后补位（MSDN 支持的用法）
const exStyle = gui.GetWindowLongPtr(hwndMain, GWL_EXSTYLE as any)
gui.SetWindowLongPtr(hwndMain, GWL_EXSTYLE as any, (exStyle as number) | WS_EX_LAYERED | WS_EX_TOOLWINDOW)
SetLayeredWindowAttributes(hwndMain, 0, ALPHA, LWA_ALPHA)
// 圆角 region：显示前设好（显示瞬间已是圆角；region 对象系统接管）
SetWindowRgn(hwndMain, CreateRoundRectRgn(0, 0, MON_W, MON_H, RGN_RADIUS, RGN_RADIUS), 1)
gui.ShowWindow(hwndMain, 5)   // SW_SHOW：此刻起任务栏按 TOOLWINDOW 不建按钮

// Tahoma 9pt（-12px）：数字渲染比默认宋体清晰；中文经 GDI 字体链接 fallback
const font = CreateFontIndirect({ lfHeight: -12, lfWeight: 400, lfFaceName: 'Tahoma' })

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
    segTexts = [
        // 上下行总和单值（云图标即标签），段间隙由 paint 推进量控制
        fmtRate(net ? net[0] + net[1] : null),
        (mem === null ? '--' : mem) + '%',
        (cpu === null ? '--' : cpu) + '%',
    ]
    gui.InvalidateRect(hwndMain, null, false)   // WM_PAINT 自绘（RoundRect 自擦，erase=false）
    print('⇅ ' + segTexts.join(''))
    setTimeout(tick, TICK_MS)
}
print('deskmon started: ' + MON_W + 'x' + MON_H + ' @(' + initX + ',' + initY
    + ') topmost=' + topmost + ' tick=' + TICK_MS + 'ms')
setTimeout(tick, TICK_MS)
