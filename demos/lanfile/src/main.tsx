// lanfile —— 局域网文件互传（demo.d 旗舰 demo）
//
// 开窗即服务，关窗即停（无常驻托盘）。两个方向：
//   电脑→手机：窗口加文件（添加按钮 / 资源管理器右键菜单），手机浏览器开地址点链接下载
//   手机→电脑：手机页面选文件，fetch PUT 裸 body 流式上传到 exe 同级 uploads\
//
// UI 层用 react-qw（React reconciler → HWND）：布局是 flex（padding/gap/flexGrow），
// 缩放自动重排（WM_SIZE → react-qw 默认类过程 forceFlexLayout），不再手写 CreateWindowEx + SetWindowPos。
// 三处仍是原生代码：
//   1. 主窗：createRoot 默认类过程 + onEvent 接窗口级消息（ERASEBKGND/PAINT/COPYDATA/CLOSE；
//      SIZE/DESTROY 交 react-qw 默认类过程）；单实例判重复用 FindWindow(NULL, 'lanfile')
//   2. QR 面板：STATIC 自绘，用 object 形式 onEvent 接管 PAINT（跳过默认擦除防闪）
//   3. 选文件对话框：PathPicker 自带路径输入框，跟这里「按钮触发」的语义不同 → 照它的
//      原生调用法自己调 GetOpenFileName
//
// 机制要点（deskmon/http-server 之外的新东西集中在四处）：
// 1. 单实例：CreateMutex 判重；第二实例把 argv 路径逐条 WM_COPYDATA 发给主窗后
//    退出（cbData=0 的空消息 = 仅"把你带到前台"）。右键菜单多选 = Explorer 逐个
//    拉起进程，由此收敛为主窗列表逐条追加。
// 2. 右键菜单：HKCU\...\*\shell\lanfile verb（ctxmenu.ts），默认开启、可开关、即时生效。
// 3. QR：lean-qr 直出位图（toImageData，1px/模块），按显示尺寸预放大成 32bpp
//    GDI 位图缓存；WM_PAINT 一次 BitBlt 贴图，不逐模块 FillRect。qrcode.ts 显式
//    指定 modes 排掉 shift_jis，并让 polyfill 先行为 lean-qr 挂 TextEncoder。
// 4. 防火墙：Windows 默认拦入站，手机打不开时程序内没有任何线索。启动后查
//    INetFwPolicy2（quickwin/lib/netfw），被拦且无本 exe 规则时提示一键放行
//    （提权 netsh 加规则后轮询复查）。XP 无该接口，静默跳过。
// 5. 状态持久化：%TEMP%\lanfile.json 存右键菜单开关、选中的网卡地址、上传目录。
//    网卡存地址不存下标——GetAdaptersInfo 枚举顺序不跨重启稳定（VPN 接入/网卡增删
//    会让下标指向另一张卡），存地址自愈合，地址已不存在时回落内核路由主卡。
//
// DPI：布局全用基准像素（400×360 体系）——react-qw 的 flex 定位与控件创建统一乘
// scaleFactor；窗口尺寸（CreateWindow）与 GDI 绘制自己乘 S。不做 WM_DPICHANGED 跨屏
// 动态（跨屏拖动罕见，重启自适应）。
//
// 消息常量一律走 quickwin/constants 与 lib/windows；COPYDATA_MAGIC 是 lanfile 自己的
// 自定义魔数（非 Win32 常量），保留本地定义。
// polyfill 必须最先引入：React 调度器在模块初始化时抓 `typeof setTimeout`，晚于它求值会让
// `setTimeout` 恒为 null —— 首次 commit 抛 TypeError 被 reconciler 的 error boundary 吞掉
// （console.log 无控制台即静默），表现是窗口开着却一个子窗都没有。
import 'quickwin/lib/polyfill.js'   // setTimeout / TextEncoder / URL（早于 react 模块初始化）
import * as gui from 'gui'
import type { HWND } from 'gui'   // gui 与 ffi 的 <HWND>ptr 品牌同型，可互认直传
import * as os from 'os'
import * as std from 'std'
import * as ffi from 'ffi'
import { useEffect, useMemo, useRef, useState } from 'react'
import { bind, WCHAR } from 'quickwin/lib/ffi/bind.js'
import { struct } from 'quickwin/lib/ffi/struct.js'
import { NULL, PtrArrayBuffer, type MaybePtr, type Ptr } from 'quickwin/lib/ffi/ctype.js'
import type { WEvent } from 'quickwin/lib/msg-registry.js'
import { Button, CheckBox, ComboBox, ListBox, PathPicker, Tab, createRoot } from 'quickwin/lib/react-qw/index.js'
import {
    BeginPaint, CloseClipboard, EmptyClipboard, EndPaint, FillRect, FindWindow,
    GetClientRect, GetClipboardData, GetWindowText, GetWindowTextLength,
    InvalidateRect, IsIconic, MessageBox, OpenClipboard, PostQuitMessage,
    SendMessage, SetClipboardData, SetForegroundWindow, ShowWindow,
} from 'quickwin/lib/windows/user32.js'
import {
    BitBlt, CreateBitmap, CreateCompatibleDC, CreateSolidBrush, DeleteDC, DeleteObject,
    SelectObject, SetBkMode, SetTextColor, TextOut,
} from 'quickwin/lib/windows/gdi32.js'
import {
    CreateMutex, GlobalAlloc, GlobalFree, GlobalLock, GlobalUnlock, RtlMoveMemory,
} from 'quickwin/lib/windows/kernel32.js'
import { GetOpenFileName } from 'quickwin/lib/windows/comdlg32.js'
import { ShellExecute } from 'quickwin/lib/windows/shell32.js'
import { OPENFILENAMEW, PAINTSTRUCT, RECT } from 'quickwin/lib/windows/structs.js'
import { createSystemDpiFont, getScaleFactor } from 'quickwin/lib/dpi.js'
import { allowApp, queryFirewall } from 'quickwin/lib/netfw.js'
import {
    BackgroundMode, EditStyle, ErrorCode, MbFlag, MbResult, OpenFileNameFlag, RasterOp,
    ShowWindowCmd, WindowStyle, WmMsg,
} from 'quickwin/constants'

// 消费方声明合并：WM_COPYDATA 是 lanfile 特有的单实例转发消息（框架注册表不预填），
// lParam = COPYDATASTRUCT*（lanfile 当原始指针读）
declare global {
    interface QuickWinMsgRegistry {
        [WmMsg.COPYDATA]: { wParam: number; lParam: MaybePtr<'COPYDATASTRUCT'> }
        [WmMsg.DROPFILES]: { wParam: number; lParam: number }   // wParam = HDROP
    }
}
import * as shares from './shares.js'
import * as texts from './texts.js'
import * as netif from './netif.js'
import * as ctxmenu from './ctxmenu.js'
import { makeQr, type QrImage } from './qrcode.js'
import { setUploadDir as setServerDir, startServer } from './server.js'

const COPYDATA_MAGIC = 0x1A6F1EC   // WM_COPYDATA dwData 自定义魔数（lanfile 的 leet 拼写）

// ── 布局（基准像素；flex 样式由 reconciler 乘 scaleFactor，GDI 处自己乘 S）──
const S = getScaleFactor()
const WIN_W = Math.round(400 * S)
const WIN_H = Math.round(360 * S)
const PAD = 12
const GAP = 6
const CTRL_H = 26
const QR_W = 176      // 左侧 QR 面板宽
const CHK_W = 80      // ☑右键菜单（含勾选块 + 文字 + 边距）
const COPY_W = 52     // 复制 / 已复制
const ADD_W = 66      // 添加文件
const OPEN_W = 52     // 打开
const TIP_H = 20
const TIP_X = 10
const TIP_DY = 3

// ── 诊断日志：%TEMP%\lanfile.log（全程静默，deskmon 手法）──
function log(msg: string) {
    try {
        const dir = std.getenv('TEMP')
        if (!dir) return
        const p = dir.replace(/[\\/]+$/, '') + '\\lanfile.log'
        const fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        if (fd === null || fd < 0) return
        const txt = (Date.now() / 1000).toFixed(3) + ' ' + msg + '\r\n'
        const buf = new ArrayBuffer(txt.length)
        const u8 = new Uint8Array(buf)
        for (let i = 0; i < txt.length; i++) u8[i] = txt.charCodeAt(i)
        os.write(fd, buf, 0, txt.length)
        os.close(fd)
    } catch { /* 日志失败不影响主体 */ }
}

// ── 配置：%TEMP%\lanfile.json：
//   { "ctx": 0|1 }         右键菜单开关（缺省=开）
//   { "addr": "192.168.." } 用户选中的网卡地址。存地址不存下标：GetAdaptersInfo 的枚举
//                          顺序不跨重启稳定，VPN 接入/网卡增删会让下标指向另一张卡；
//                          地址已不存在时回落内核路由主卡
//   { "uploads": "D:\\..\\uploads" } 上传保存目录（缺省=exe 同级 uploads）
type Cfg = { ctx?: number, addr?: string, uploads?: string }
function cfgPath(): string | null {
    const dir = std.getenv('TEMP')
    return dir ? dir.replace(/[\\/]+$/, '') + '\\lanfile.json' : null
}
function loadCfg(): Cfg {
    try {
        const p = cfgPath()
        if (!p) return {}
        const txt = std.loadFile(p)
        if (!txt) return {}
        const v = JSON.parse(txt)
        const out: Cfg = {}
        if (typeof v?.ctx === 'number') out.ctx = v.ctx
        if (typeof v?.addr === 'string') out.addr = v.addr
        if (typeof v?.uploads === 'string') out.uploads = v.uploads
        return out
    } catch { return {} }
}
function saveCfg(c: Cfg): void {
    try {
        const p = cfgPath()
        if (!p) return
        const txt = JSON.stringify(c)
        const fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        if (fd === null || fd < 0) return
        const bytes = new TextEncoder().encode(txt)
        os.write(fd, bytes.buffer, 0, bytes.length)
        os.close(fd)
    } catch { /* 静默 */ }
}

// ── 单实例：第二实例把 argv 路径 COPYDATA 给主窗后退出 ──
const MUTEX_NAME = 'Local\\lanfile-singleton'
const GetLastError = bind('kernel32.dll', 'GetLastError', ' -> u32')
const FlashWindow = bind('user32.dll', 'FlashWindow', '<HWND>ptr i32 -> i32')

// 文件拖拽（经典 WM_DROPFILES，Win95 起稳定）：目标窗 DragAcceptFiles 接受，
// 拖入时收 WM_DROPFILES(wParam=HDROP)，DragQueryFileW 逐个取路径，DragFinish 释放
const DragAcceptFiles = bind('shell32.dll', 'DragAcceptFiles', '<HWND>ptr i32 -> void')
const DragQueryFileW = bind('shell32.dll', 'DragQueryFileW', 'u32 u32 <WCHAR>ptr u32 -> u32')
const DragFinish = bind('shell32.dll', 'DragFinish', 'u32 -> void')

/** 向已运行主窗转发文件路径；path=null 发空消息仅请求"带到前台"。成功 true */
function forwardPath(hwnd: HWND, path: string | null): boolean {
    const data = path === null ? null : WCHAR.encode(path)   // const 绑定：SendMessage 期间保活
    const cds = COPYDATASTRUCT.encode({
        dwData: COPYDATA_MAGIC, cbData: data ? data.byteLength : 0,
        lpData: data ? data.ptr : 0,
    })
    // SendMessage 同步：主进程拷完才返回，cds/data 生命周期因此安全
    SendMessage(hwnd, WmMsg.COPYDATA, 0, cds.ptr)
    return true
}

// ── 启动期算好的初始值（组件以它们为初始 state）──
let hwndMain: HWND | null = null
let uploadAbs = ''
let shareItems: string[] = []
let ctxOn = false
let cfg: Cfg = {}

function scriptArgPaths(): string[] {
    const args: string[] = []
    try {
        for (const a of globalThis.scriptArgs ?? []) {
            if (typeof a !== 'string' || a.length === 0) continue
            if (/^[a-zA-Z]:[\\/]/.test(a) || a.startsWith('\\\\')) args.push(a)
        }
    } catch { /* 无 argv */ }
    return args
}

function fmtSize(n: number): string {
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
    return n + ' B'
}

/** UTF-16LE 解码（Win32 宽字符面；recvCopyData 路径 / 文件对话框共用） */
function decodeUtf16(buf: ArrayBuffer): string {
    return new TextDecoder('utf-16le').decode(new Uint8Array(buf))
}

function itemsOf(): string[] {
    return shares.all().map((e) => e.rel + '  (' + fmtSize(e.size) + ')')
}

// ── 背景与绘制（消息内复用同一 buffer）──
const bgBrush = CreateSolidBrush(0x00ffffff)   // COLORREF 0x00BBGGRR 白
const hFont = createSystemDpiFont()            // 与 react-qw 控件同一套系统字体
const paintBuf = PAINTSTRUCT.alloc()
const rcBuf = RECT.alloc()

function clientSize(hwnd: HWND): { w: number; h: number } {
    GetClientRect(hwnd, rcBuf.ptr)
    const rc = RECT.decode(rcBuf)
    return { w: rc.right - rc.left, h: rc.bottom - rc.top }
}

/** 整块客户区填白：WM_ERASEBKGND 被抑制（防闪），漏填的区域会留上次的残影 */
function fillWhite(hdc: Ptr<'HDC'>, w: number, h: number): void {
    const rc = RECT.encode({ left: 0, top: 0, right: w, bottom: h })
    FillRect(hdc, rc.ptr, bgBrush)
}

// ── QR 位图（内容不变只生成一次；WM_PAINT 一次 BitBlt 贴图）──
// 库出的是 1px/模块 RGBA；QR 只有黑白像素，RGBA 与 GDI 32bpp 的 BGRA 同值。
// 位图按 1px/模块保存，贴图时再放大 cell 倍，避免按显示尺寸存大图。
// cell 从面板的设备像素宽度推（(QR_W - 2*PAD) * S），高 DPI 下 QR 随面板等比放大。
interface QrDraw { bmp: Ptr<'HGDIOBJ'>; px: number }   // px = 设备像素

/** 生成失败返回 null（QrView 会显示"请用手机输入地址"提示） */
function makeQrSafe(text: string): QrImage | null {
    try {
        return makeQr(text)
    } catch (e) {
        log('qr failed: ' + e)
        return null
    }
}

function buildQrDraw(qr: QrImage): QrDraw | null {
    const cell = Math.max(2, Math.floor((QR_W - PAD * 2) * S / qr.width))
    const px = qr.width * cell
    // 在 JS 里按显示尺寸最近邻放大：XP 的 GDI 对 32bpp DDB 做 StretchBlt 会整块变黑，
    // 换成等尺寸 BitBlt 后两个系统一致（每行同色可直接整理，这里方块数很少，逐像素即可）。
    const buf = new PtrArrayBuffer(px * px * 4)
    const out = new Uint8Array(buf)
    const src = qr.data
    for (let y = 0; y < px; y++) {
        const sy = (y / cell) | 0
        for (let x = 0; x < px; x++) {
            const si = (sy * qr.width + ((x / cell) | 0)) * 4
            const di = (y * px + x) * 4
            out[di] = src[si]
            out[di + 1] = src[si + 1]
            out[di + 2] = src[si + 2]
            out[di + 3] = 255
        }
    }
    const bmp = CreateBitmap(px, px, 1, 32, buf)
    return bmp ? { bmp, px } : null
}

/** QR 面板自绘：位图居中，提示文字贴面板底（按钮行上方） */
function paintQr(hwnd: HWND, d: QrDraw | null): void {
    const hdc = BeginPaint(hwnd, paintBuf.ptr)
    if (!hdc) return
    try {
        const { w, h } = clientSize(hwnd)
        fillWhite(hdc, w, h)
        if (d) {
            const mem = CreateCompatibleDC(hdc)
            if (mem) {
                const old = SelectObject(mem, d.bmp)
                const x = Math.floor((w - d.px) / 2)
                const y = Math.max(0, Math.floor((h - TIP_H * S - d.px) / 2))
                BitBlt(hdc, x, y, d.px, d.px, mem, 0, 0, RasterOp.SRCCOPY)
                SelectObject(mem, old)
                DeleteDC(mem)
            }
        }
        if (hFont) SelectObject(hdc, hFont)
        SetBkMode(hdc, BackgroundMode.TRANSPARENT)
        SetTextColor(hdc, 0x00555555)
        const tip = d ? '手机扫码或输入地址' : '二维码生成失败，请用手机输入地址'
        TextOut(hdc, Math.round(TIP_X * S), h - TIP_H * S + Math.round(TIP_DY * S), tip, tip.length)
    } catch (e) {
        log('qr paint err: ' + e)
    }
    EndPaint(hwnd, paintBuf.ptr)
}

/** QR 面板：STATIC 只当自绘区域用（flex 里 width 固定、高度随行拉伸） */
function QrView({ qr }: { qr: QrImage | null }) {
    const boxRef = useRef<HWND>(null)
    const drawRef = useRef<QrDraw | null>(null)

    useEffect(() => {
        const prev = drawRef.current
        drawRef.current = qr ? buildQrDraw(qr) : null
        if (prev && prev.bmp) DeleteObject(prev.bmp)
        if (boxRef.current) InvalidateRect(boxRef.current, NULL, 1)
    }, [qr])
    useEffect(() => () => {                       // 卸载时释放位图
        const d = drawRef.current
        if (d && d.bmp) DeleteObject(d.bmp)
        drawRef.current = null
    }, [])

    return (
        <w type="STATIC"
           ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
           style={{ width: QR_W }}
           ref={boxRef}
           // object 形式 = 接管 wndproc：ERASEBKGND/PAINT 不调旧过程，其它消息回落
           onEvent={{ fn: (e) => {
               if (e.msg === WmMsg.ERASEBKGND) return 1
               if (e.msg === WmMsg.PAINT) {
                   paintQr(e.hwnd, drawRef.current)
                   return 0
               }
               return e.callOldWndProc()
           }}}
      />
    )
}

// ── 对话框（照 react-qw PathPicker 的原生调用法）──
function openFilesDialog(): string[] {
    try {
        const fileBuf = WCHAR.alloc(16384)   // 多选：dir\0file1\0file2\0\0
        const filter = WCHAR.encode('所有文件\0*.*\0\0')
        const title = WCHAR.encode('选择要共享的文件')
        const ofn = OPENFILENAMEW.encode({
            lStructSize: OPENFILENAMEW.size,
            hwndOwner: hwndMain ?? NULL,   // 槽位不收 JS null，未建窗时显式给 NULL
            lpstrFilter: filter.ptr,
            lpstrFile: fileBuf.ptr,
            nMaxFile: 16384,
            lpstrTitle: title.ptr,
            Flags: OpenFileNameFlag.HIDEREADONLY | OpenFileNameFlag.PATHMUSTEXIST | OpenFileNameFlag.FILEMUSTEXIST
                | OpenFileNameFlag.ALLOWMULTISELECT | OpenFileNameFlag.EXPLORER,
        })
        if (!GetOpenFileName(ofn.ptr)) return []
        const strs = decodeUtf16(fileBuf).split('\0')
        const dir = strs[0] ?? ''
        const files = strs.slice(1).filter((f) => f.length > 0).map((f) => dir + '\\' + f)
        if (files.length > 0) return files
        return dir ? [dir] : []
    } catch (e) {
        log('openFilesDialog err: ' + e)
        return []
    }
}

// ── 前台提示：restore + foreground + 闪 3 下（右键分享到达）──
function bringToFront(): void {
    if (!hwndMain) return
    if (IsIconic(hwndMain)) ShowWindow(hwndMain, ShowWindowCmd.RESTORE)
    SetForegroundWindow(hwndMain)
    for (let i = 0; i < 3; i++) FlashWindow(hwndMain, 1)
    FlashWindow(hwndMain, 0)
}

// ── WM_COPYDATA 接收：lParam → COPYDATASTRUCT → UTF-16 路径 ──
// COPYDATASTRUCT（Win32）：dwData=ULONG_PTR、lpData=PVOID（指针宽度，MSVC 自动对齐）
const COPYDATASTRUCT = struct('COPYDATASTRUCT', {
    dwData: '<>ptr', cbData: 'u32', lpData: '<>ptr',
})
function recvCopyData(lParam: MaybePtr<'COPYDATASTRUCT'>): void {
    try {
        if (!lParam) return
        const cds = COPYDATASTRUCT.decode(lParam)
        if (cds.dwData !== COPYDATA_MAGIC) return
        if (cds.cbData === 0 || !cds.lpData) {
            bringToFront()      // 空消息 = 第二实例请求"带前台"
            return
        }
        const bytes = ffi.readBytes(cds.lpData, cds.cbData)
        const path = decodeUtf16(bytes)
        // 尾部 NUL 去除
        const clean = path.replace(/\0+$/, '')
        if (clean) shares.addPath(clean)
        bringToFront()
    } catch (e) {
        log('recvCopyData err: ' + e)
    }
}

/** 拖拽文件到主窗：HDROP → 逐个路径加入分享（DragFinish 释放） */
function recvDropFiles(hdrop: number): void {
    try {
        const n = DragQueryFileW(hdrop, 0xFFFFFFFF, NULL, 0)   // 0xFFFFFFFF = 查文件数
        for (let i = 0; i < n; i++) {
            const len = DragQueryFileW(hdrop, i, NULL, 0)      // 路径字符数（不含 NUL）
            if (len <= 0) continue
            const buf = WCHAR.alloc(len + 1)   // +1：DragQueryFileW 写含 NUL 终止，len 不含它
            DragQueryFileW(hdrop, i, buf.ptr, len + 1)
            const path = decodeUtf16(buf).replace(/\0+$/, '')
            if (path) shares.addPath(path)
        }
    } finally {
        DragFinish(hdrop)
    }
}

// ── 动作 ──
function addFiles(): void {
    for (const f of openFilesDialog()) shares.addPath(f)
}
function openUploadDir(): void {
    ShellExecute(hwndMain ?? NULL, 'open', uploadAbs, NULL, NULL, 1)
}
// 注册表写入失败则保持原态（勾选框是 AUTOCHECKBOX，视觉已翻过；失败时下次启动回滚）
function toggleCtx(want: boolean): boolean {
    if (!ctxmenu.setEnabled(want)) return false
    ctxOn = want
    cfg.ctx = want ? 1 : 0
    saveCfg(cfg)
    return true
}

// ── 防火墙：启动查一次，被拦且无本 exe 规则时提示一键放行 ──

function checkFirewall(exe: string): void {
    try {
        const st = queryFirewall(exe)
        log('firewall: ' + JSON.stringify(st))
        // XP 无 INetFwPolicy2：既查不了也用不了 advfirewall，只能跳过
        if (!st.checked || !st.firewallOn || st.allowed) return
        // hwndMain 建窗后才进这里；槽位不收 JS null，未建窗时给 NULL（= 无属主窗）
        const r = MessageBox(hwndMain ?? NULL,
            'Windows 防火墙正在拦截入站连接，手机可能打不开这个页面。\n\n'
            + '是否现在为本程序添加防火墙放行规则？（会弹出管理员确认）',
            'lanfile', MbFlag.YESNO | MbFlag.ICONQUESTION)
        if (r !== MbResult.YES) return
        allowApp(exe, hwndMain ?? NULL)
        // netsh 在提权进程里异步执行，规则不会立刻出现：轮询复查（最多约 5 秒）
        let tries = 0
        const poll = (): void => {
            const after = queryFirewall(exe)
            if (after.allowed || !after.checked || !after.firewallOn) return
            if (++tries < 10) {
                setTimeout(poll, 500)
                return
            }
            log('firewall: allow rule did not appear')
            MessageBox(hwndMain ?? NULL,
                '放行未生效（可能取消了管理员确认）。\n\n'
                + '仍可在「Windows 防火墙 → 允许应用通过防火墙」里手动允许本程序。',
                'lanfile', MbFlag.OK | MbFlag.ICONWARNING)
        }
        setTimeout(poll, 500)
    } catch (e) {
        log('firewall check err: ' + e)
    }
}

// ── 剪贴板：CF_UNICODETEXT，GlobalAlloc 拿块 + RtlMoveMemory 灌数据（与 test_sysinfo 同款）──
const GMEM_MOVEABLE = 0x2          // GlobalAlloc：可移动块（剪贴板惯例）
const CF_UNICODETEXT = 13          // 剪贴板格式：UTF-16 文本
function copyText(text: string): boolean {
    if (!OpenClipboard(NULL)) return false          // 别的进程占着剪贴板就放弃，不打扰用户
    EmptyClipboard()
    const src = WCHAR.encode(text)                  // 自带 NUL 终止
    const hMem = GlobalAlloc(GMEM_MOVEABLE, src.byteLength)
    if (!hMem) { CloseClipboard(); return false }
    const dst = GlobalLock(hMem)
    if (!dst) { GlobalFree(hMem); CloseClipboard(); return false }
    RtlMoveMemory(dst, src, src.byteLength)
    GlobalUnlock(hMem)
    const ok = SetClipboardData(CF_UNICODETEXT, hMem) !== 0
    if (!ok) GlobalFree(hMem)                       // 成功后所有权归系统，不能再释放
    CloseClipboard()
    return ok
}

/** 读系统剪贴板文本（CF_UNICODETEXT）；无文本/被其它进程占用时返回 null */
function readClipboardText(): string | null {
    if (!OpenClipboard(NULL)) return null
    try {
        const h = GetClipboardData(CF_UNICODETEXT)
        if (!h) return null
        const p = GlobalLock(h)
        if (!p) return null
        try {
            return WCHAR.decode(p as Ptr<'WCHAR'>)
        } finally {
            GlobalUnlock(h)
        }
    } finally {
        CloseClipboard()
    }
}

// ── 共享文字：多行 EDIT + 自身消息回读 ──
// 不用 Input 组件：它只监听 WM_CHAR，Ctrl+V / 删除等不产生 WM_CHAR，会漏掉。
// 这里直接在 EDIT 上接 KEYUP 与剪贴板消息——先让默认过程处理（完成插入/删除），
// 再回读全文。KEYUP 覆盖键入、Backspace/Delete、Ctrl+V/X/Z；PASTE/CUT/CLEAR/UNDO
// 覆盖右键菜单操作（没有按键事件）。
const WM_CUT = 0x0300
const WM_PASTE = 0x0302
const WM_CLEAR = 0x0303
const WM_UNDO = 0x0304

function readEditText(h: HWND): string {
    const cap = GetWindowTextLength(h) + 1
    if (cap <= 1) return ''
    const buf = WCHAR.alloc(cap)
    GetWindowText(h, buf, cap)
    return WCHAR.decode(buf)
}

function TextArea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const editRef = useRef<HWND>(null)
    return (
        <w type="EDIT"
           text={value}
           ws={WindowStyle.VISIBLE | WindowStyle.BORDER | WindowStyle.VSCROLL
               | EditStyle.MULTILINE | EditStyle.AUTOVSCROLL | EditStyle.WANTRETURN}
           style={{ flexGrow: 1 }}
           ref={editRef}
           onEvent={{ fn: (e) => {
               const ret = e.callOldWndProc()   // 先让默认过程完成编辑
               // msg 的静态类型是已注册消息的联合；WM_PASTE 等未注册，收窄成 number 再比
               const msg: number = e.msg
               if (msg === WmMsg.KEYUP || msg === WM_PASTE || msg === WM_CUT
                   || msg === WM_CLEAR || msg === WM_UNDO) {
                   const h = editRef.current
                   if (h) onChange(readEditText(h))
               }
               return ret
           }}}
        />
    )
}

/** 文字页签内容：本地编辑去抖写回共享 store；手机发来的新文字经 onUpdate 回显 */
function TextPane() {
    const [text, setText] = useState(texts.get().text)
    const textRef = useRef(text)               // 卸载兜底用（state 在 cleanup 闭包里是旧值）
    const timer = useRef<os.TimerId | null>(null)

    useEffect(() => {
        texts.onUpdate(() => {
            const t = texts.get().text
            textRef.current = t
            setText((prev) => (prev === t ? prev : t))
        })
        return () => {
            texts.onUpdate(null)
            if (timer.current !== null) {
                clearTimeout(timer.current)
                timer.current = null
                texts.set(textRef.current)     // 切页签时把还没去抖的编辑落盘
            }
        }
    }, [])

    const onEdit = (v: string): void => {
        textRef.current = v
        setText(v)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
            timer.current = null
            texts.set(v)
        }, 400)
    }
    return <TextArea value={text} onChange={onEdit} />
}

// ── 界面 ──
function App({ addrs, initIdx, port, uploadDir }: {
    addrs: string[]; initIdx: number; port: number; uploadDir: string
}) {
    const [idx, setIdx] = useState(initIdx)
    const [items, setItems] = useState<string[]>(shareItems)
    const [ctx, setCtx] = useState(ctxOn)
    const [upDir, setUpDir] = useState(uploadDir)
    const [copied, setCopied] = useState(false)
    const [tab, setTab] = useState(0)          // 右侧页签：0 文件 / 1 文字

    // 下拉项 = 完整 URL（手机要输的就是它）。memo 保持数组引用稳定：ComboBox 的
    // effect 以 [items] 为依赖，每次渲染传新数组会让它 RESETCONTENT 重灌一遍
    const urls = useMemo(() => addrs.map((ip) => 'http://' + ip + ':' + port + '/'),
        [addrs, port])
    // 选中项同时是地址显示与 QR 源，不可能漂移；idx 越界收敛（防御性，列表不应缩短）
    const clamped = Math.min(idx, addrs.length - 1)
    const url = urls[clamped] ?? ''
    const qr = useMemo(() => makeQrSafe(url), [url])

    // 换网卡：地址写回 lanfile.json（存地址不存下标，见 Cfg 注释）
    const onAddr = (i: number): void => {
        if (i < 0 || i >= addrs.length) return
        setIdx(i)
        cfg.addr = addrs[i]
        saveCfg(cfg)
        log('addr -> ' + addrs[i])
    }
    // 换上传目录：server 立刻改走新目录（mkdirs 幂等），配置与 UI 同步
    const onUpDir = (d: string): void => {
        if (!d) return
        setServerDir(d)      // server：HTTP 立刻生效
        uploadAbs = d
        cfg.uploads = d
        saveCfg(cfg)
        setUpDir(d)          // React：PathPicker 靠 key=upDir remount 换值
    }
    // 复制地址：剪贴板写入本身没有视觉反馈，按钮文字临时换成「已复制」再恢复
    const onCopy = (): void => {
        if (!url || !copyText(url)) return
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
    }
    // 文字页签的两个剪贴板动作（直接读写共享 store，TextPane 会经 onUpdate 回显）
    const onCopyText = (): void => {
        const t = texts.get().text
        if (t) copyText(t)
    }
    const onPasteText = (): void => {
        const t = readClipboardText()
        if (t !== null) texts.set(t)
    }

    useEffect(() => {
        setItems(itemsOf())               // 对齐 render 前到达的 COPYDATA
        shares.onUpdate(() => setItems(itemsOf()))
    }, [])

    // 页签内容随文件列表变化重建；TextPane 自管文字状态，打字不会重建页签头
    const tabs = useMemo(() => [
        { title: '文件', content: <ListBox items={items} style={{ flexGrow: 1 }} /> },
        { title: '文字', content: <TextPane /> },
    ], [items])

    return (
      <w type="STATIC"
         ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
         style={{ flexDirection: 'column', padding: PAD, gap: GAP, flexGrow: 1 }}>
        {/* 行1：地址（网卡下拉，选中项即地址与 QR 源）+ 复制 + ☑右键菜单 */}
        <w type="STATIC"
           ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
           style={{ flexDirection: 'row', gap: GAP, height: CTRL_H }}>
          <ComboBox items={urls} selectedIndex={clamped} onChange={onAddr}
                    style={{ flexGrow: 1, height: CTRL_H }} />
          <Button onClick={onCopy} style={{ width: COPY_W, height: CTRL_H }}>
            {copied ? '已复制' : '复制'}
          </Button>
          <CheckBox label='右键菜单' checked={ctx}
                    onChange={(v) => { if (toggleCtx(v)) setCtx(v) }}
                    style={{ width: CHK_W, height: CTRL_H }} />
        </w>
        {/* 行2：左 QR 面板 / 右侧页签（文件列表 / 共享文字），填满剩余高度 */}
        <w type="STATIC"
           ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
           style={{ flexDirection: 'row', gap: GAP * 2, flexGrow: 1 }}>
          <QrView qr={qr} />
          <Tab tabs={tabs} selectedIndex={tab} onChange={setTab}
               style={{ flexGrow: 1 }} />
        </w>
        {/* 行3：随页签切换——文件：添加/上传目录/打开；文字：复制/粘贴 */}
        {tab === 0 ? (
          <w key="files" type="STATIC"
             ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
             style={{ flexDirection: 'row', gap: GAP, height: CTRL_H }}>
            <Button onClick={addFiles} style={{ width: ADD_W, height: CTRL_H }}>添加文件</Button>
            <PathPicker key={upDir} type="folder" value={upDir} onChange={onUpDir}
                        title='选择上传保存目录' style={{ flexGrow: 1, height: CTRL_H }} />
            <Button onClick={openUploadDir} style={{ width: OPEN_W, height: CTRL_H }}>打开</Button>
          </w>
        ) : (
          <w key="text" type="STATIC"
             ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
             style={{ flexDirection: 'row', gap: GAP, height: CTRL_H }}>
            <Button onClick={onCopyText} style={{ width: COPY_W, height: CTRL_H }}>复制</Button>
            <Button onClick={onPasteText} style={{ width: COPY_W, height: CTRL_H }}>粘贴</Button>
          </w>
        )}
      </w>
    )
}

// 窗口级消息（react-qw 默认类过程已处理 SIZE/DESTROY；这里只接 lanfile 特有的）
function onRootMsg(e: WEvent): number | void {
    if (e.msg === WmMsg.ERASEBKGND) return 1   // 背景由 paint 统一填，避免先擦白再画闪一下
    if (e.msg === WmMsg.PAINT) {
        const hdc = BeginPaint(e.hwnd, paintBuf.ptr)
        if (hdc) {
            const { w, h } = clientSize(e.hwnd)
            fillWhite(hdc, w, h)
            EndPaint(e.hwnd, paintBuf.ptr)
        }
        return 0
    }
    if (e.msg === WmMsg.COPYDATA) {
        recvCopyData(e.lParam)
        return 1
    }
    if (e.msg === WmMsg.DROPFILES) {
        recvDropFiles(e.wParam)
        return 0
    }
    if (e.msg === WmMsg.CLOSE) {
        PostQuitMessage(0)
        return 0
    }
    // SIZE → react-qw forceFlexLayout；DESTROY → react-qw 清 rootMap
}

// ── 启动 ──
function main(): void {
    cfg = loadCfg()

    // 1. 单实例：已有主窗 → 转发 argv 路径（无路径则只请求带前台）后退出
    CreateMutex(NULL, 0, MUTEX_NAME)
    const exists = GetLastError() === ErrorCode.ALREADY_EXISTS
    const argvPaths = scriptArgPaths()
    if (exists) {
        const hwnd = FindWindow(NULL, 'lanfile')
        if (hwnd) {
            for (const p of argvPaths) forwardPath(hwnd, p)
            if (argvPaths.length === 0) forwardPath(hwnd, null)
        }
        log('second instance: forwarded ' + argvPaths.length + ' path(s), exit')
        std.exit(0)
    }

    // 2. 窗口（消息循环集成在 os 事件循环；gui 无独立 pump 调用）
    // CLIPCHILDREN：父窗自绘时不往子控件区域画（否则整块 FillRect 会盖住控件）
    const root = createRoot({ text: 'lanfile', ws: WindowStyle.CLIPCHILDREN,
        width: WIN_W / S, height: WIN_H / S, onEvent: onRootMsg })
    hwndMain = root.hwnd
    DragAcceptFiles(hwndMain, 1)        // 接受文件拖拽到窗口
    const exe = ctxmenu.exePath()
    // 上传目录：配置里有就用（上次选过），否则 exe 同级 uploads
    uploadAbs = (cfg.uploads && cfg.uploads.length > 0)
        ? cfg.uploads
        : exe.slice(0, exe.lastIndexOf('\\')) + '\\uploads'
    setServerDir(uploadAbs)
    ctxOn = cfg.ctx !== 0          // 右键菜单默认开；注册表与勾选框一起反映
    ctxmenu.setEnabled(ctxOn)

    // 3. 服务（8321 被占自动回退随机端口）
    let port = 0
    let fallback = false
    try {
        const r = startServer(8321)
        port = r.port
        fallback = r.fallback
    } catch (e) {
        log('listen failed: ' + e)
        MessageBox(hwndMain, '端口监听失败：' + String(e), 'lanfile', 0)
        std.exit(1)
    }
    // 初始网卡下标：配置里选过且仍在列表里 → 用它；否则内核路由主卡
    const lan = netif.lanAddresses()
    const savedIdx = lan.all.indexOf(cfg.addr ?? '')
    const initIdx = savedIdx >= 0 ? savedIdx : Math.max(0, lan.all.indexOf(lan.primary))
    log('server: ' + lan.all[initIdx] + ':' + port + ' fallback=' + fallback
        + ' addrs=' + lan.all.join(','))

    // 4. argv 文件入表（render 之前，作为初始列表）
    for (const p of argvPaths) shares.addPath(p)
    shareItems = itemsOf()

    // 5. 渲染 + 显示
    root.render(<App addrs={lan.all} initIdx={initIdx} port={port}
                uploadDir={uploadAbs} />)
    print('lanfile: http://' + lan.all[initIdx] + ':' + port + '/ uploads=' + uploadAbs)

    // 6. 防火墙：窗口显示后再提示，避免模态框挂在不可见窗口上
    checkFirewall(exe)
}

main()
