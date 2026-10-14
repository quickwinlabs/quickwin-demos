// deskmon —— quickwin 桌面资源监控悬浮窗
//
// 常驻桌面细条：网速 / 内存 / CPU，1s 刷新；托盘右键菜单支持置顶切换、大小档与退出；
// 大小档 = 整窗倍率缩放（尺寸/圆角/间距/字体/图标一起乘），默认跟随系统 DPI
// （GetDeviceCaps/96 就近取档），切换后写 %TEMP%/deskmon.json（缺失/损坏静默回默认）。
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
import * as std from 'std'
import { bind } from 'quickwin/lib/ffi/bind.js'
import { struct } from 'quickwin/lib/ffi/struct.js'
import { PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import { SystemParametersInfo, BeginPaint, EndPaint, DrawText, GetDC, ReleaseDC } from 'quickwin/lib/windows/user32.js'
import { CreateSolidBrush, SetBkMode, SetTextColor, SelectObject, CreateFontIndirect, GetTextExtentPoint32, GetDeviceCaps, DeleteObject } from 'quickwin/lib/windows/gdi32.js'
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
const DT_FLAGS = 0x00000824     // DT_SINGLELINE|DT_VCENTER|DT_NOPREFIX；DT_VCENTER 无 SINGLELINE 时被 MS 忽略→顶对齐
const SPI_GETWORKAREA = 0x0030  // 工作区（不含任务栏）——悬浮窗贴任务栏上沿
const IF_TYPE_SOFTWARE_LOOPBACK = 24   // 注意：6 = IF_TYPE_ETHERNET_CSMACD（以太网），别搞混
const NET_RESET_BPS = 5e8       // 聚合增量换算 > 500MB/s：计数器重置/网卡重枚举，按 0 处理
const TICK_MS = 1000
// ── 大小档：BASE_* 为 100% 基准，MON_* 等由 applyScale 按档位派生 ──
const SCALES = [1, 1.25, 1.5, 2]    // 托盘菜单档位（配置文件只认这四个值）
const BASE_W = 185                  // 悬浮窗基准尺寸：三段紧凑（水平居中，段间隙 8px，icon→text 4px）
const BASE_H = 24
const BASE_GAP = 8                  // 段与段之间空隙（无竖线，仅靠呼吸空隙）
const BASE_ITG = 4                  // icon 与其后文本的紧凑空隙
const BASE_RADIUS = 8               // 圆角椭圆参数（region/RoundRect 同语义，28 高过圆显幼稚）
const BASE_ICON = 16                // 图标基准（源 ico 16×16，绘制时 DrawIconEx 按档拉伸）
const BASE_FONT_H = 12              // Tahoma 字符高 px（lfHeight 负值语义；数字渲染比默认宋体清晰）
let scale = 1                       // 当前档（启动：配置 > 系统 DPI 就近取档）
let MON_W = BASE_W, MON_H = BASE_H, SEG_GAP = BASE_GAP, ICON_TEXT_GAP = BASE_ITG
let RGN_RADIUS = BASE_RADIUS, ICON_SIZE = BASE_ICON
const MENU_EXIT = 1
const MENU_TOPMOST = 2
const MENU_SCALE_BASE = 10          // 大小子菜单 id 基址：10..13 ↔ SCALES 各档
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
const SRC_ICON = 16                // 源 ico 固定 16×16（成像尺寸）；绘制放大走 DrawIconEx 拉伸
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
    return CreateIconFromResourceEx((buf as any).ptr + 22, bytes.length - 22, 1, 0x00030000, SRC_ICON, SRC_ICON, 0)
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
let font: any = null               // Tahoma（按档 lfHeight），applyScale 重建并删旧
let hwndMain: any = null           // 建窗前先 applyScale 派生尺寸；窗存在后调档原地改几何
const paintBuf = PAINTSTRUCT.alloc()     // BeginPaint/EndPaint 出参（消息内复用）
const bgBrush = CreateSolidBrush(COLOR_BG)
const borderPen = CreatePen(0, 1, COLOR_BORDER)   // PS_SOLID：1px 描边

// ── 大小档：派生几何/字体 + 持久化（全程静默降级，配置坏了不影响挂件）──
function applyScale(s: number, persist = false) {
    log('applyScale enter: s=' + s + ' persist=' + persist +
        ' hwnd=' + (hwndMain ? String(hwndMain) : 'null') +
        ' old=' + MON_W + 'x' + MON_H + ' scale=' + scale)
    scale = s
    MON_W = Math.round(BASE_W * s)
    MON_H = Math.round(BASE_H * s)
    SEG_GAP = Math.round(BASE_GAP * s)
    ICON_TEXT_GAP = Math.round(BASE_ITG * s)
    RGN_RADIUS = Math.round(BASE_RADIUS * s)
    ICON_SIZE = Math.round(BASE_ICON * s)
    // Tahoma：数字渲染比默认宋体清晰；中文经 GDI 字体链接 fallback
    const f = CreateFontIndirect({ lfHeight: -Math.round(BASE_FONT_H * s), lfWeight: 400, lfFaceName: 'Tahoma' })
    log('  font new=' + (f ? 'ok' : 'NULL') + ' delOld=' + (font ? String(DeleteObject(font)) : 'n/a'))   // 旧字体已随 paint DC 释放、无归属，可删
    font = f
    if (hwndMain) {
        // SWP_NOMOVE(0x2)|SWP_NOZORDER(0x4)：原地改尺寸；region 圆角随之重建
        // 注意 SetWindowPos 是 7 参 (hwnd, insertAfter, x, y, cx, cy, flags)，多传会整体错位
        const r1 = gui.SetWindowPos(hwndMain, 0, 0, 0, MON_W, MON_H, 0x0002 | 0x0004)
        const r2 = SetWindowRgn(hwndMain, CreateRoundRectRgn(0, 0, MON_W, MON_H, RGN_RADIUS, RGN_RADIUS), 1)
        gui.InvalidateRect(hwndMain, null, false)
        log('  new=' + MON_W + 'x' + MON_H + ' swp=' + r1 + ' rgn=' + r2 +
            ' rectNow=' + JSON.stringify(gui.GetWindowRect(hwndMain)))
    }
    if (persist) saveScale(s)
}
/** 系统 DPI（GetDeviceCaps/LOGPIXELSX ÷ 96）就近取档；探测失败（XP/异常）回 1 */
function defaultScaleByDpi(): number {
    let res = 1
    try {
        const dc = GetDC(0 as any)       // NULL → 桌面 DC（引擎层 NULL=0 直通）
        if (dc) {
            const dpi = GetDeviceCaps(dc, gui.DeviceCap.LOGPIXELSX)
            ReleaseDC(0 as any, dc)
            log('defaultScaleByDpi: dpi=' + dpi)
            if (dpi > 0) {
                const want = dpi / 96
                let best = SCALES[0]
                for (const s of SCALES) if (Math.abs(s - want) < Math.abs(best - want)) best = s
                res = best
            }
        }
    } catch (e) { log('defaultScaleByDpi: err ' + e) /* 取不到 → 1 */ }
    log('defaultScaleByDpi: -> ' + res)
    return res
}
function cfgPath(): string | null {
    const dir = std.getenv('TEMP')   // 注意:os 模块没有 getenv(quickjs-libc 语义,在 std)
    return dir ? dir.replace(/[\\/]+$/, '') + '\\deskmon.json' : null
}
// ── 诊断日志:append 写 %TEMP%\deskmon.log(每条一行,unix 时间戳);全程静默 ──
function log(msg: string) {
    try {
        const p = cfgPath(); if (!p) return
        const fd = os.open(p.replace(/deskmon\.json$/, 'deskmon.log'),
            os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        if (fd === null || fd < 0) return
        const txt = (Date.now() / 1000).toFixed(3) + ' ' + msg + '\r\n'
        const buf = new ArrayBuffer(txt.length)
        const u8 = new Uint8Array(buf)
        for (let i = 0; i < txt.length; i++) u8[i] = txt.charCodeAt(i)
        os.write(fd, buf, 0, txt.length)
        os.close(fd)
    } catch (e) { /* 日志失败不影响挂件 */ }
}
/** 读档位；缺失/损坏/非档位值 → null（调用方回默认） */
function loadScale(): number | null {
    let res: number | null = null
    try {
        const p = cfgPath(); if (!p) { log('loadScale: no TEMP/cfgPath'); return null }
        const fd = os.open(p, os.O_RDONLY)
        if (fd === null || fd < 0) { log('loadScale: open failed (' + p + ')'); return null }
        const buf = new ArrayBuffer(256)
        const n = os.read(fd, buf, 0, 256)
        os.close(fd)
        if (n <= 0) { log('loadScale: empty file'); return null }
        const u8 = new Uint8Array(buf)
        // 文本解码:兼容 UTF-16LE(带 BOM;cmd `echo` 落盘是无 BOM 宽字符,按偶数位 ASCII 判)
        // 与 UTF-8 BOM(记事本另存形态)。内容本身纯 ASCII,各分支直拷码位即可。
        let txt = ''
        if (n >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {          // UTF-16LE + BOM
            for (let i = 2; i + 1 < n; i += 2) txt += String.fromCharCode(u8[i] | (u8[i + 1] << 8))
        } else if (n >= 2 && u8[1] === 0) {                         // UTF-16LE 无 BOM
            for (let i = 0; i + 1 < n; i += 2) txt += String.fromCharCode(u8[i] | (u8[i + 1] << 8))
        } else {                                                    // UTF-8 / ANSI
            for (let i = u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf ? 3 : 0; i < n; i++)
                txt += String.fromCharCode(u8[i])
        }
        const v = JSON.parse(txt).scale
        res = (typeof v === 'number' && SCALES.indexOf(v) >= 0) ? v : null
    } catch (e) { log('loadScale: parse err ' + e); return null }
    log('loadScale: -> ' + res)
    return res
}
/** 写 {scale:…}；任何失败静默（挂件不因配置起不来） */
function saveScale(s: number) {
    try {
        const p = cfgPath(); if (!p) { log('saveScale: no cfgPath'); return }
        const fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        if (fd === null || fd < 0) { log('saveScale: open failed'); return }
        const txt = JSON.stringify({ scale: s })
        const buf = new ArrayBuffer(txt.length)
        const u8 = new Uint8Array(buf)
        for (let i = 0; i < txt.length; i++) u8[i] = txt.charCodeAt(i)
        const nw = os.write(fd, buf, 0, txt.length)
        os.close(fd)
        log('saveScale: wrote ' + nw + 'B "' + txt + '"')
    } catch (e) { log('saveScale: err ' + e) }
}

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
            log('paint err: ' + e)
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
            // 大小子菜单：MF_POPUP(0x10)，id 位放子菜单句柄；DestroyMenu(menu) 递归销毁
            const sub = gui.CreatePopupMenu()
            for (let i = 0; i < SCALES.length; i++) {
                gui.AppendMenu(sub, SCALES[i] === scale ? 0x8 : 0,   // MF_CHECKED 标当前档
                    MENU_SCALE_BASE + i, Math.round(SCALES[i] * 100) + '%')
            }
            gui.AppendMenu(menu, 0x10, sub, '大小(&S)')
            gui.AppendMenu(menu, 0x0800, 0, '')   // MF_SEPARATOR
            gui.AppendMenu(menu, 0, MENU_EXIT, '退出(&X)')
            const cmd = gui.TrackPopupMenu(menu, p ? p[0] : 0, p ? p[1] : 0, undefined, hwnd)
            gui.DestroyMenu(menu)
            log('menu cmd=' + cmd + ' (EXIT=' + MENU_EXIT + ' TOPMOST=' + MENU_TOPMOST + ' SCALE_BASE=' + MENU_SCALE_BASE + ')')
            if (cmd === MENU_EXIT) {
                gui.ShellNotifyIcon(gui.NotifyIconCmd.DELETE, { hwnd, uID: 1 } as any)
                gui.PostQuitMessage(0)
            } else if (cmd === MENU_TOPMOST) {
                topmost = !topmost
                // SWP_NOMOVE | SWP_NOSIZE
                gui.SetWindowPos(hwnd, topmost ? gui.SetWindowPosHwnd.TOPMOST : gui.SetWindowPosHwnd.NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002)
            } else if (cmd >= MENU_SCALE_BASE && cmd < MENU_SCALE_BASE + SCALES.length) {
                applyScale(SCALES[cmd - MENU_SCALE_BASE], true)   // 切档即持久化
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

// 大小档：配置（%TEMP%/deskmon.json）> 系统 DPI 就近取档；派生 MON_* 与字体后建窗
const _bootCfg = loadScale()
const _bootDpi = _bootCfg === null ? defaultScaleByDpi() : null
log('boot: cfg=' + _bootCfg + ' dpiDefault=' + _bootDpi + ' -> scale=' + (_bootCfg ?? _bootDpi))
applyScale(_bootCfg ?? _bootDpi ?? 1)

// 工作区右下角（任务栏上沿）落位
const wa: any = RECT.alloc()
SystemParametersInfo(SPI_GETWORKAREA, 0, wa.ptr, 0)
const work: any = RECT.decode(wa)
const initX = (work.right || 1024) - MON_W - 8
const initY = (work.bottom || 768) - MON_H - 40   // 默认稍抬高：距任务栏上沿 40px

// WS_POPUP（不带 VISIBLE）：EX 风格 CreateWindow 不带 → 补位后再显示，
// 否则任务栏已按普通窗口建好按钮（事后补 TOOLWINDOW 两机实测不刷新）
hwndMain = gui.CreateWindow(
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

// Tahoma 字体已在 applyScale 创建（按档 lfHeight），此处不再单独建

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
    + ') scale=' + scale + ' topmost=' + topmost + ' tick=' + TICK_MS + 'ms')
log('boot done: ' + MON_W + 'x' + MON_H + ' @(' + initX + ',' + initY + ') scale=' + scale)
setTimeout(tick, TICK_MS)
