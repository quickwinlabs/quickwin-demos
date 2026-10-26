// deskmon —— quickwin 桌面资源监控悬浮窗
//
// 常驻桌面细条：网速 / 内存 / CPU，1s 刷新；托盘右键菜单支持置顶切换、大小档、开机自启动、背景深浅与退出；
// 大小档 = 整窗倍率缩放（尺寸/圆角/间距/字体/图标一起乘），默认跟随系统 DPI
// （GetDeviceCaps/96 就近取档）；档位/背景深浅/拖动位置均写 %TEMP%/deskmon.json
// （缺失/损坏静默回默认），重启恢复上次位置与背景（工作区外回落默认）。
// 置顶维持：Win11 点任务栏会激活任务栏——同属 topmost 的窗口"后激活者居上"，挂件被压到任务栏下后
// 自身不会再抬回。故随 1s 数据刷新顺带沿 Z 序向上看：上方只要有"可见且与自身矩形相交"的窗口
// （点任务栏后就是任务栏）就重设 HWND_TOPMOST 抬回；没被压住时一次重设也不发。win11 实测任务栏
// 为前台时也能抬回（若个别环境压不回，焦点一移开的下一次刷新即自愈）。拖动中跳过（改 Z 序会打断移动循环）。
// 整窗 WM_NCHITTEST→HTCAPTION 全区可拖。半透明背景：WS_EX_LAYERED + LWA_ALPHA
// （XP 软件混合 / win7+ DWM，桌面壁纸透出）。文字由父窗 WM_PAINT 自绘而非 STATIC
// 子控件——Win8 起才支持 layered 子窗口合成，Win8 前 child 不参与（MSDN）。
// 数据全部来自 Win32 FFI（XP+ 可用，无第三方依赖）：
//   CPU    GetSystemTimes 两次采样差分（kernel32）
//   内存   GlobalMemoryStatusEx（kernel32）
//   网速   GetBestInterface 定位默认路由网卡，GetIfTable 取其 In/OutOctets 差分（iphlpapi）
//
// 构建：npm run build（tsc noEmit 类型检查 → build.ts：esbuild --bundle → brotli embed）
//   - 枚举（WindowStyle 等）import 自 quickwin/constants（真 .ts），const enum 内联
//     由 esbuild 完成（字面量直接进 bundle）；tsc 仅做类型检查
//   - gui/std/os/ffi 为运行时模块，bundle 保留 ESM import（format=esm）
//   - 3.0 起 gui 只剩建窗/消息泵原语，其余走 lib/windows/* 绑定（随 bundle 打进来）；
//     出参位只收 def.alloc().ptr、读回走 decode——下面三处便利版（rectOf/cursorPos/exePath）
//     即 gui.GetWindowRect / gui.GetCursorPos / win.GetModuleFileName 的等价替换
import * as gui from 'gui'                 // 3.0 起只剩建窗/消息泵原语（清单见 quickwin.d.ts）
import * as os from 'os'
import * as std from 'std'
import { bind, WCHAR } from 'quickwin/lib/ffi/bind.js'
import { struct } from 'quickwin/lib/ffi/struct.js'
import { NULL, PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import {
    SystemParametersInfo, BeginPaint, EndPaint, DrawText, GetDC, ReleaseDC, IsWindowVisible,
    InvalidateRect, SetWindowPos, GetWindowRect, ShowWindow, GetWindowLongPtr, SetWindowLongPtr,
    SetForegroundWindow, GetWindow, PostQuitMessage,
    CreatePopupMenu, AppendMenu, TrackPopupMenu, DestroyMenu, GetCursorPos, LoadImageOrdinal,
} from 'quickwin/lib/windows/user32.js'
import { CreateSolidBrush, SetBkMode, SetTextColor, SelectObject, CreateFontIndirect, GetTextExtentPoint32, GetDeviceCaps, DeleteObject } from 'quickwin/lib/windows/gdi32.js'
import { GetModuleFileName } from 'quickwin/lib/windows/kernel32.js'
import { ShellNotifyIcon } from 'quickwin/lib/windows/shell32.js'
import { RECT, PAINTSTRUCT, LOGFONTW, SIZE, POINT, NOTIFYICONDATAW } from 'quickwin/lib/windows/structs.js'
import { RegCloseKey, RegCreateKeyEx, RegOpenKeyEx, RegQueryValueEx, RegSetValueEx } from 'quickwin/lib/windows/advapi32.js'
import { ICON_NET_B64, ICON_MEM_B64, ICON_CPU_B64 } from './icons.js'
import { BackgroundMode, DeviceCap, DtFlag, GetWindowCmd, Gwlp, HKey, HitTest, IDI, IfType, ImageType, LoadImageFlag, NotifyIconCmd, NotifyIconFlag, RegAccess, RegType, SetWindowPosFlag, SetWindowPosHwnd, ShowWindowCmd, Spi, TrackPopupMenuFlag, WindowStyle, WmMsg } from 'quickwin/constants'

// ── setTimeout 桥接：os 事件循环已与 gui 消息泵集成（quickjs-libc 消息泵里 poll 定时器）──
// 本项目刻意不开 DOM lib，故这里补一条引擎全局的类型声明（同 quickwin/lib/polyfill.js 里的声明；
// 只 import polyfill 会连带打进 url/text-codec/SHA-1 等 ~12KB 死码，故不 import，自己桥接）
declare global {
    function setTimeout(fn: () => void, ms?: number): number
}
if (typeof (globalThis as any).setTimeout === 'undefined') {
    ;(globalThis as any).setTimeout = (fn: any, _ms?: number, ...a: any[]) =>
        os.setTimeout(() => fn(...a), _ms ?? 0)
}

// ── 常量 ──
// Win32 枚举（WindowStyle/WmMsg/NotifyIconCmd/...）import 自 quickwin/constants（真 .ts），
// 由 esbuild 在 bundle 时内联为数字字面量
const WM_TRAY = 0x8001          // 托盘回调消息（自定义）
const LWA_ALPHA = 0x2           // SetLayeredWindowAttributes 用全局 alpha（非色键）
const ALPHA = 130               // 不透明度 0-255（≈51%：更强挂件感，白字仍可读）
// 背景主题（COLORREF 0x00BBGGRR）：深色为默认；浅色必须连文字一起翻转，否则白底白字不可读。
// 边框两档共用深灰：alpha 半透明下深浅底都能收边。
const THEME = [
    { bg: 0x00101010, text: 0x00FFFFFF, border: 0x00555555 },   // 0 深色（近黑）
    { bg: 0x00FFFFFF, text: 0x00000000, border: 0x00555555 },   // 1 浅色（纯白）
]
let bgLight = false              // 当前浅色与否：启动从 cfg 恢复，托盘菜单切换
let colorText = THEME[0].text    // 文字色随主题；paint 每帧读
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
const MENU_AUTOSTART = 4            // 开机自启动开关（1/2/10..13 已占）
const MENU_BG = 5                   // 背景深浅切换
const MAX_IF = 64               // 接口数上限：MIB_IFTABLE 缓冲按 64 行预分配
// MIB_IFROW（mingw iprtrmib.h，sizeof = 860，无尾部 padding）——
//   wszName@0 WCHAR[256]，其后：dwIndex@512 dwType@516 dwMtu@520 dwSpeed@524
//   dwPhysAddrLen@528 dwPhysAddr@532[8] dwAdminStatus@540 dwOperStatus@544
//   dwLastChange@548 dwInOctets@552 dwInUcastPkts@556 … dwInUnknownProtos@572
//   dwOutOctets@576 dwOutUcastPkts@580 … dwDescrLen@600 bDescr@604[256]
const IFROW_SIZE = 860
const IFROW_OFF_TYPE = 516
const IFROW_OFF_OPER = 544
const IFROW_OFF_INDEX = 512   // dwIndex：对齐 GetBestInterface 返回的 ifIndex
const IFROW_OFF_IN = 552
const IFROW_OFF_OUT = 576

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
// 默认路由所在接口：GetIfTable 会把 WSL/Docker/VPN 等虚拟网卡与其转发的物理网卡各记一次
// 同一批字节（dwType 都是 ETHERNET，无从区分），求和会大几倍；只统计这张 = 外网速度
// ifIndex 走 PDWORD 出参（mingw `GetBestInterface(IPAddr, PDWORD*)`），误绑 1 参会让出参
// 落在栈垃圾上、bestHit 永远 false，退化成全量求和 = 虚拟网卡双计数原样复现
const GetBestInterface = bind('iphlpapi.dll', 'GetBestInterface', 'u32 <>ptr -> u32')
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
// 开机自启动：lib/windows 未封装 RegDeleteValue → 自 bind（只删值，不动 Run 键本体）
const RegDeleteValue = bind('advapi32.dll', 'RegDeleteValueW', '<>ptr <WCHAR>ptr -> i32')

// ── 3.0 移除的 gui/win 便利版：就地补回（出参位只收 def.alloc().ptr，读回走 decode——
//    方向约定见 lib/windows/user32.ts 头注释）──
/** 窗口屏幕矩形（原 gui.GetWindowRect 返对象）；失败 → null */
function rectOf(h: any) {
    const rc = RECT.alloc()
    return GetWindowRect(h, rc.ptr) ? RECT.decode(rc) : null
}
/** 光标屏幕坐标（原 gui.GetCursorPos 返 [x, y]）；失败 → null */
function cursorPos() {
    const pt = POINT.alloc()
    return GetCursorPos(pt.ptr) ? POINT.decode(pt) : null
}
/** 当前进程 exe 完整路径（原 win.GetModuleFileName 无参版，MAX_PATH 缓冲）；失败 → '' */
function exePath() {
    const buf = WCHAR.alloc(520)
    return GetModuleFileName(NULL, buf, 520) > 0 ? WCHAR.decode(buf) : ''
}

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
    new Uint8Array(buf).set(bytes)
    // ico 布局 6B ICONDIR + 16B ICONDIRENTRY + DIB；CreateIconFromResourceEx 的
    // presbits 期望 BITMAPINFOHEADER 起（Wine/ReactOS 实现）→ 跳 22；dwVer = 0x00030000
    return CreateIconFromResourceEx(buf.ptr + 22, bytes.length - 22, 1, 0x00030000, SRC_ICON, SRC_ICON, 0)
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
const bestIf = new PtrArrayBuffer(4)   // GetBestInterface 的 PDWORD 出参
let prevNetIn = -1, prevNetOut = -1, prevNetMs = 0
/** [下行B/s, 上行B/s]；首个样本/失败返回 null */
function sampleNet(): [number, number] | null {
    const dv = new DataView(ifBuf)
    new DataView(ifSize).setUint32(0, ifBuf.byteLength, true)   // 入参：缓冲容量（写 pSize，别污染 ifBuf 的 dwNumEntries）
    if (GetIfTable(ifBuf.ptr, ifSize.ptr, 1) !== 0) return null  // NO_ERROR = 0
    const n = Math.min(dv.getUint32(0, true), MAX_IF)
    // 2 参：ifIndex 走出参；rc != NO_ERROR（如 ERROR_NO_NETWORK）→ IF_INDEX_ERROR 回落求和
    const best = GetBestInterface(0, bestIf.ptr) === 0
        ? new DataView(bestIf).getUint32(0, true)
        : 0xffffffff
    // 优先只统计默认路由网卡：WSL2/Docker/VPN 等虚拟网卡与其转发的物理网卡会各记一次
    // 同一批字节（dwType 都是 ETHERNET，无从区分），求和会大几倍；best 未在表中则回落全量求和
    let inSum = 0, outSum = 0, bestIn = 0, bestOut = 0, bestHit = false
    for (let r = 0; r < n; r++) {
        const off = 4 + r * IFROW_SIZE
        if (dv.getUint32(off + IFROW_OFF_TYPE, true) === IfType.SOFTWARE_LOOPBACK) continue
        // 不按 operStatus 过滤：Dormant(5) 等低功耗态接口同样承载流量（win7 NAT 网卡实测 Dormant）
        const inc = dv.getUint32(off + IFROW_OFF_IN, true)
        const ouc = dv.getUint32(off + IFROW_OFF_OUT, true)
        inSum += inc
        outSum += ouc
        if (!bestHit && dv.getUint32(off + IFROW_OFF_INDEX, true) === best) { bestIn = inc; bestOut = ouc; bestHit = true }
    }
    if (best !== 0 && best !== 0xffffffff && bestHit) { inSum = bestIn; outSum = bestOut }
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
let dragging = false               // 整窗 HTCAPTION 系统拖动中（WM_ENTERSIZEMOVE..EXITSIZEMOVE）：跳过置顶维持
// 分段自绘文本：[网速值] [内存%] [CPU%]（图标即字段标签，段间空格；tick 更新 → InvalidateRect）
let segTexts = ['starting…', '', '']
let font: any = null               // Tahoma（按档 lfHeight），applyScale 重建并删旧
let hwndMain: any = null           // 建窗前先 applyScale 派生尺寸；窗存在后调档原地改几何
const paintBuf = PAINTSTRUCT.alloc()     // BeginPaint/EndPaint 出参（消息内复用）
let bgBrush = CreateSolidBrush(THEME[0].bg)
let borderPen = CreatePen(0, 1, THEME[0].border)   // PS_SOLID：1px 描边

/** 切背景深浅：重建 brush/pen + 文字色并重绘；persist=true 时写盘 */
function setBg(light: boolean, persist = false) {
    bgLight = light
    const th = THEME[light ? 1 : 0]
    log('setBg: light=' + light + ' delBrush=' + DeleteObject(bgBrush) + ' delPen=' + DeleteObject(borderPen))
    bgBrush = CreateSolidBrush(th.bg)
    borderPen = CreatePen(0, 1, th.border)
    colorText = th.text
    if (hwndMain) InvalidateRect(hwndMain, NULL, 0)
    if (persist) { cfgData.bg = light ? 1 : 0; saveCfg() }
}

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
        const r1 = SetWindowPos(hwndMain, SetWindowPosHwnd.TOP, 0, 0, MON_W, MON_H, 0x0002 | 0x0004)
        const r2 = SetWindowRgn(hwndMain, CreateRoundRectRgn(0, 0, MON_W, MON_H, RGN_RADIUS, RGN_RADIUS), 1)
        InvalidateRect(hwndMain, NULL, 0)
        log('  new=' + MON_W + 'x' + MON_H + ' swp=' + r1 + ' rgn=' + r2 +
            ' rectNow=' + JSON.stringify(rectOf(hwndMain)))
    }
    if (persist) { cfgData.scale = s; saveCfg() }
}
/** 系统 DPI（GetDeviceCaps/LOGPIXELSX ÷ 96）就近取档；探测失败（XP/异常）回 1 */
function defaultScaleByDpi(): number {
    let res = 1
    try {
        const dc = GetDC(NULL)       // NULL → 桌面 DC（引擎层 NULL=0 直通）
        if (dc) {
            const dpi = GetDeviceCaps(dc, DeviceCap.LOGPIXELSX)
            ReleaseDC(NULL, dc)
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
type Cfg = { scale?: number; bg?: number; pos?: { x: number; y: number } }
/** 运行期配置：启动读一次进 cfgData，任一字段变更统一 saveCfg 整写（旧文件缺字段回落默认） */
let cfgData: Cfg = {}

/** 读配置；缺失/损坏 → {}（各字段回落默认） */
function loadCfg(): Cfg {
    const res: Cfg = {}
    try {
        const p = cfgPath(); if (!p) { log('loadCfg: no TEMP/cfgPath'); return res }
        const fd = os.open(p, os.O_RDONLY)
        if (fd === null || fd < 0) { log('loadCfg: open failed (' + p + ')'); return res }
        const buf = new ArrayBuffer(256)
        const n = os.read(fd, buf, 0, 256)
        os.close(fd)
        if (n <= 0) { log('loadCfg: empty file'); return res }
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
        const v = JSON.parse(txt)
        if (typeof v.scale === 'number' && SCALES.indexOf(v.scale) >= 0) res.scale = v.scale
        if (v.bg === 0 || v.bg === 1) res.bg = v.bg
        if (v.pos && typeof v.pos.x === 'number' && typeof v.pos.y === 'number')
            res.pos = { x: Math.round(v.pos.x), y: Math.round(v.pos.y) }
    } catch (e) { log('loadCfg: parse err ' + e); return {} }
    log('loadCfg: -> ' + JSON.stringify(res))
    return res
}
/** 写 cfgData 整对象；任何失败静默（挂件不因配置起不来） */
function saveCfg() {
    try {
        const p = cfgPath(); if (!p) { log('saveCfg: no cfgPath'); return }
        const fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        if (fd === null || fd < 0) { log('saveCfg: open failed'); return }
        const txt = JSON.stringify(cfgData)
        const buf = new ArrayBuffer(txt.length)
        const u8 = new Uint8Array(buf)
        for (let i = 0; i < txt.length; i++) u8[i] = txt.charCodeAt(i)
        const nw = os.write(fd, buf, 0, txt.length)
        os.close(fd)
        log('saveCfg: wrote ' + nw + 'B "' + txt + '"')
    } catch (e) { log('saveCfg: err ' + e) }
}

/** 拖动结束/退出时记住窗口左上角；位置未变不写盘 */
function savePos(h: any) {
    try {
        const r = rectOf(h)
        if (!r) { log('savePos: no rect'); return }
        const p = cfgData.pos
        if (p && p.x === r.left && p.y === r.top) return
        cfgData.pos = { x: r.left, y: r.top }
        saveCfg()
        log('savePos: ' + r.left + ',' + r.top)
    } catch (e) { log('savePos: err ' + e) }
}

// ── 开机自启动：HKCU Run 键即状态源（启动读一次打勾，切换按返回码决定翻转）；
//    注册表任何失败静默降级——菜单状态不变，挂件不受影响 ──
const AUTOSTART_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const AUTOSTART_VAL = 'deskmon'
/** REG_SZ 数据 = UTF-16LE 含结尾 NUL（exe 路径可能含中文）——照 test/test_registry.ts */
function wbuf(s: string): any {
    const p = new PtrArrayBuffer((s.length + 1) * 2)
    const dv = new DataView(p)
    for (let i = 0; i <= s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true)
    return p
}
/** 键句柄出参回读（ia32 4B / x64 8B）——照 test_registry 的 readPtr 先例 */
function readRegPtr(dv: DataView): number {
    if (os.arch === 'ia32') return dv.getUint32(0, true)
    return dv.getUint32(0, true) + dv.getUint32(4, true) * 4294967296
}
/** Run 值存在 = 开；键/值缺失、任何异常一律 false（菜单回未勾） */
function autostartGet(): boolean {
    let on = false
    try {
        const phk = new PtrArrayBuffer(8)
        const rc = RegOpenKeyEx(HKey.CURRENT_USER, AUTOSTART_KEY, 0, RegAccess.READ, phk)
        if (rc === 0) {
            const hkey = readRegPtr(new DataView(phk))
            // 空探针（lpData=NULL）：值存在即 0，不读数据——test_registry 同款
            on = RegQueryValueEx(hkey, AUTOSTART_VAL, NULL, NULL, NULL, NULL) === 0
            RegCloseKey(hkey)
        }
        log('autostartGet: openRc=' + rc + ' on=' + on)
    } catch (e) { log('autostartGet: err ' + e) }
    return on
}
/** 写/删 Run 值；true = 已达目标态（关闭分支 rc=2 = 键/值本就不在，视为达成） */
function autostartSet(on: boolean): boolean {
    let rc = -1
    let path = ''
    try {
        let data = ''
        if (on) {
            path = exePath()
            if (!path) { log('autostartSet: no exe path'); return false }
            data = '"' + path + '"'   // 引号包裹：Run 键路径含空格必需
        }
        const phk = new PtrArrayBuffer(8)
        rc = on
            ? RegCreateKeyEx(HKey.CURRENT_USER, AUTOSTART_KEY, 0, NULL, 0,
                RegAccess.SET_VALUE, NULL, phk, NULL)
            : RegOpenKeyEx(HKey.CURRENT_USER, AUTOSTART_KEY, 0, RegAccess.SET_VALUE, phk)
        if (rc === 0) {
            const hkey = readRegPtr(new DataView(phk))
            rc = on
                ? RegSetValueEx(hkey, AUTOSTART_VAL, 0, RegType.SZ,
                    wbuf(data), (data.length + 1) * 2)
                : RegDeleteValue(hkey, AUTOSTART_VAL)   // 2 = 值不在（关态已达成）
            RegCloseKey(hkey)
        }
        log('autostartSet: on=' + on + ' rc=' + rc + (on ? ' path=' + path : ''))
        return rc === 0 || (!on && rc === 2)
    } catch (e) { log('autostartSet: err ' + e); return false }
}
let autostart = autostartGet()   // 菜单打勾状态；外部改了注册表，重启即同步

gui.RegisterClass('DeskMon', (hwnd: any, msg: number, _w: number, lParam: number) => {
    if (!hwnd) return gui.DefWindowProc(hwnd, msg, _w, lParam)
    if (msg === WmMsg.NCHITTEST) return HitTest.CAPTION
    // 自绘窗口：RoundRect 底色+描边擦除 → DrawText；erase=false 时不发本消息
    if (msg === WmMsg.ERASEBKGND) return 1
    if (msg === WmMsg.PAINT) {
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
                SetBkMode(hdc, BackgroundMode.TRANSPARENT)   // 底已 RoundRect 填充，文字背景透明防覆盖
                SetTextColor(hdc, colorText)
                // 分段 [icon] 值文本水平居中：先 GetTextExtentPoint32 累加总宽，
                // 再从 (MON_W - total)/2 起绘
                const icons = [hIconNet, hIconMem, hIconCpu]
                const sz = SIZE.alloc()
                let total = 3 * ICON_SIZE + 2 * SEG_GAP + 3 * ICON_TEXT_GAP
                for (const t of segTexts) {
                    if (!t) continue
                    if (GetTextExtentPoint32(hdc, t, t.length, sz.ptr)) {
                        total += SIZE.decode(sz).cx
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
                    DrawText(hdc, t, -1, r.ptr, DtFlag.SINGLELINE | DtFlag.VCENTER | DtFlag.NOPREFIX)
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
            SetForegroundWindow(hwnd)
            const p = cursorPos()
            const menu = CreatePopupMenu()
            if (!menu) return 0   // 拿不到句柄就放弃本次菜单（HMENU 是 HMENU | null）
            AppendMenu(menu, 0, MENU_TOPMOST, topmost ? '取消置顶(&T)' : '窗口置顶(&T)')
            AppendMenu(menu, 0x0800, 0, '')   // MF_SEPARATOR
            // 大小子菜单：MF_POPUP(0x10)，id 位放子菜单句柄；DestroyMenu(menu) 递归销毁
            const sub = CreatePopupMenu()
            if (!sub) {
                DestroyMenu(menu)   // 子菜单建不出来就整条菜单放弃，别泄漏
                return 0
            }
            for (let i = 0; i < SCALES.length; i++) {
                AppendMenu(sub, SCALES[i] === scale ? 0x8 : 0,   // MF_CHECKED 标当前档
                    MENU_SCALE_BASE + i, Math.round(SCALES[i] * 100) + '%')
            }
            AppendMenu(menu, 0x10, sub, '大小(&S)')
            AppendMenu(menu, autostart ? 0x8 : 0, MENU_AUTOSTART, '开机自启动(&A)')   // MF_CHECKED 按 Run 键实况
            AppendMenu(menu, bgLight ? 0x8 : 0, MENU_BG, '浅色背景(&B)')   // MF_CHECKED = 浅色生效中
            AppendMenu(menu, 0x0800, 0, '')   // MF_SEPARATOR
            AppendMenu(menu, 0, MENU_EXIT, '退出(&X)')
            // 原 gui 版默认 flags = TPM_RETURNCMD | TPM_RIGHTBUTTON（返回值即命令 id）
            const cmd = TrackPopupMenu(menu,
                TrackPopupMenuFlag.RETURNCMD | TrackPopupMenuFlag.RIGHTBUTTON,
                p ? p.x : 0, p ? p.y : 0, 0, hwnd, NULL)
            DestroyMenu(menu)
            log('menu cmd=' + cmd + ' (EXIT=' + MENU_EXIT + ' TOPMOST=' + MENU_TOPMOST + ' SCALE_BASE=' + MENU_SCALE_BASE + ' AUTOSTART=' + MENU_AUTOSTART + ' BG=' + MENU_BG + ')')
            if (cmd === MENU_EXIT) {
                ShellNotifyIcon(NotifyIconCmd.DELETE, { cbSize: NOTIFYICONDATAW.size, hWnd: hwnd, uID: 1 })
                savePos(hwnd)   // 拖动之外的位移兜底（位置未变则不写）
                PostQuitMessage(0)
            } else if (cmd === MENU_TOPMOST) {
                topmost = !topmost
                // SWP_NOMOVE | SWP_NOSIZE
                SetWindowPos(hwnd, topmost ? SetWindowPosHwnd.TOPMOST : SetWindowPosHwnd.NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002)
            } else if (cmd >= MENU_SCALE_BASE && cmd < MENU_SCALE_BASE + SCALES.length) {
                applyScale(SCALES[cmd - MENU_SCALE_BASE], true)   // 切档即持久化
            } else if (cmd === MENU_AUTOSTART) {
                const want = !autostart
                if (autostartSet(want)) autostart = want   // 返回码达成才翻转；失败保持原打勾
            } else if (cmd === MENU_BG) {
                setBg(!bgLight, true)   // 切换即持久化
            }
        }
        return 0
    }
    if (msg === WmMsg.ENTERSIZEMOVE) {   // 整窗 HTCAPTION 拖动开始：期间不重设置顶（会打断移动循环）
        dragging = true
        return 0
    }
    if (msg === WmMsg.EXITSIZEMOVE) {   // 拖动结束：记位置（重启恢复）+ 立刻归位
        dragging = false
        savePos(hwnd)
        keepTopmost()
        return 0
    }
    if (msg === WmMsg.CLOSE) {   // 关窗 = 隐藏到托盘（常驻），仅菜单退出
        ShowWindow(hwnd, ShowWindowCmd.HIDE)      // SW_HIDE
        return 0
    }
    return gui.DefWindowProc(hwnd, msg, _w, lParam)
})

// 配置（%TEMP%/deskmon.json）：档位 > 系统 DPI 就近取档；派生 MON_* 与字体后建窗
cfgData = loadCfg()
const _bootScale = cfgData.scale ?? null
const _bootDpi = _bootScale === null ? defaultScaleByDpi() : null
log('boot: cfg=' + _bootScale + ' dpiDefault=' + _bootDpi + ' -> scale=' + (_bootScale ?? _bootDpi))
applyScale(_bootScale ?? _bootDpi ?? 1)
if (cfgData.bg === 1) setBg(true)   // 恢复浅色主题（启动恢复不回写）

// 工作区右下角（任务栏上沿）落位；上次拖动位置与工作区相交可见则恢复
const wa: any = RECT.alloc()
SystemParametersInfo(Spi.GETWORKAREA, 0, wa.ptr, 0)
const work: any = RECT.decode(wa)
let initX = (work.right || 1024) - MON_W - 8
let initY = (work.bottom || 768) - MON_H - 40   // 默认稍抬高：距任务栏上沿 40px
const savedPos = cfgData.pos
if (savedPos && savedPos.x + MON_W > 0 && savedPos.x < (work.right || 1024) &&
        savedPos.y + MON_H > 0 && savedPos.y < (work.bottom || 768)) {
    initX = savedPos.x
    initY = savedPos.y
}

// WS_POPUP（不带 VISIBLE）：EX 风格 CreateWindow 不带 → 补位后再显示，
// 否则任务栏已按普通窗口建好按钮（事后补 TOOLWINDOW 两机实测不刷新）
hwndMain = gui.CreateWindow(
    'DeskMon', '',
    WindowStyle.POPUP,
    initX, initY, MON_W, MON_H, null, null)
if (!hwndMain) std.exit(1)

// 半透明 + 免任务栏按钮：EX 风格 CreateWindow 不带 → 事后补位（MSDN 支持的用法）
const exStyle = GetWindowLongPtr(hwndMain, Gwlp.EXSTYLE as unknown as Gwlp)
SetWindowLongPtr(hwndMain, Gwlp.EXSTYLE as unknown as Gwlp, exStyle | WindowStyle.LAYERED | WindowStyle.TOOLWINDOW)
SetLayeredWindowAttributes(hwndMain, 0, ALPHA, LWA_ALPHA)
// 圆角 region：显示前设好（显示瞬间已是圆角；region 对象系统接管）
SetWindowRgn(hwndMain, CreateRoundRectRgn(0, 0, MON_W, MON_H, RGN_RADIUS, RGN_RADIUS), 1)
ShowWindow(hwndMain, ShowWindowCmd.SHOW)   // SW_SHOW：此刻起任务栏按 TOOLWINDOW 不建按钮

// Tahoma 字体已在 applyScale 创建（按档 lfHeight），此处不再单独建

// 置顶 + 托盘
SetWindowPos(hwndMain, SetWindowPosHwnd.TOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002)

// ── 置顶维持（随 tick 顺带，见文件头注释）──
// 判据：沿 Z 序向上（GetWindow(GW_HWNDPREV)）找"可见且与自身矩形相交"的窗口 = 被压住。
// 只看可见 + 相交：稳态时压在上面的那批 topmost 辅助窗不可见，不会误触发；
// 任务栏在别的显示器上/其它置顶窗口在别处时也不算被压（不会无谓地互相抢顶）。
// SWP_NOSIZE|NOMOVE|NOACTIVATE：只改 Z 序，不动几何、不抢焦点。| 拖动中/已取消置顶/无窗口：不动作。
function keepTopmost() {
    if (!topmost || dragging || !hwndMain) return
    const me = rectOf(hwndMain)
    if (!me) return
    for (let h = GetWindow(hwndMain, GetWindowCmd.PREV), i = 0;
            h && i < 64;
            h = GetWindow(h, GetWindowCmd.PREV), i++) {
        if (!IsWindowVisible(h)) continue
        const r = rectOf(h)
        if (r && r.left < me.right && r.right > me.left && r.top < me.bottom && r.bottom > me.top) {
            SetWindowPos(hwndMain, SetWindowPosHwnd.TOPMOST, 0, 0, 0, 0,
                SetWindowPosFlag.SWP_NOSIZE | SetWindowPosFlag.SWP_NOMOVE | SetWindowPosFlag.SWP_NOACTIVATE)
            log('keepTopmost: raised by ' + String(h))
            return
        }
    }
}

let hIcon: any = gui.LoadAppIcon()
if (!hIcon) hIcon = LoadImageOrdinal(NULL, IDI.APPLICATION, ImageType.ICON, 0, 0, LoadImageFlag.SHARED)
if (hIcon) {
    ShellNotifyIcon(NotifyIconCmd.ADD, {
        cbSize: NOTIFYICONDATAW.size,
        hWnd: hwndMain, uID: 1,
        uFlags: NotifyIconFlag.MESSAGE | NotifyIconFlag.ICON,
        uCallbackMessage: WM_TRAY,
        hIcon,
    })
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
    InvalidateRect(hwndMain, NULL, 0)   // WM_PAINT 自绘（RoundRect 自擦，erase=false）
    keepTopmost()                               // 顺带：被任务栏/其它 topmost 压下去就抬回
    print('⇅ ' + segTexts.join(''))
    setTimeout(tick, TICK_MS)
}
print('deskmon started: ' + MON_W + 'x' + MON_H + ' @(' + initX + ',' + initY
    + ') scale=' + scale + ' topmost=' + topmost + ' tick=' + TICK_MS + 'ms')
log('boot done: ' + MON_W + 'x' + MON_H + ' @(' + initX + ',' + initY + ') scale=' + scale +
    ' bg=' + (bgLight ? 'light' : 'dark') + ' pos=' + (savedPos ? 'saved' : 'default'))
setTimeout(tick, TICK_MS)
