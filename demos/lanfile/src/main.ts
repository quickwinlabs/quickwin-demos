// lanfile —— 局域网文件互传（demo.d 旗舰 demo）
//
// 开窗即服务，关窗即停（无常驻托盘）。两个方向：
//   电脑→手机：窗口加文件（添加按钮 / 资源管理器右键菜单），手机浏览器开地址点链接下载
//   手机→电脑：手机页面选文件，fetch PUT 裸 body 流式上传到 exe 同级 uploads\
//
// 机制要点（deskmon/http-server 之外的新东西集中在三处）：
// 1. 单实例：CreateMutex 判重；第二实例把 argv 路径逐条 WM_COPYDATA 发给主窗后
//    退出（cbData=0 的空消息 = 仅"把你带到前台"）。右键菜单多选 = Explorer 逐个
//    拉起进程，由此收敛为主窗列表逐条追加。
// 2. 右键菜单：HKCU\...\*\shell\lanfile verb（ctxmenu.ts），默认开启、可开关、即时生效。
// 3. QR：lean-qr 直出位图（toImageData，1px/模块），按显示尺寸预放大成 32bpp
//    GDI 位图缓存；WM_PAINT 一次 BitBlt 贴图，不逐模块 FillRect。qrcode.ts 显式
//    指定 modes 排掉 shift_jis，并让 polyfill 先行为 lean-qr 挂 TextEncoder。
//
// DPI：启动时 lib/dpi 的 getScaleFactor()（GetDeviceCaps/96）取一次，窗口/控件/字体/
// QR 模块边长全乘 scale；不做 WM_DPICHANGED 跨屏动态（跨屏拖动罕见，重启自适应）。
//
// 消息常量：WmMsg 枚举缺 COPYDATA，LB_/ES_ 控件消息不入枚举 → 按 deskmon 惯例
// 手写字面量加注释；其余一律走 quickwin/constants 与 lib/windows。
import * as gui from 'gui'
import * as os from 'os'
import * as std from 'std'
import * as ffi from 'ffi'
import { bind, WCHAR } from 'quickwin/lib/ffi/bind.js'
import { NULL, PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import 'quickwin/lib/polyfill.js'   // setTimeout / TextEncoder / URL（先于本模块体执行）
import {
    CreateWindowEx, ShowWindow, SetWindowPos, InvalidateRect, FillRect, GetClientRect,
    SendMessage, FindWindow, PostQuitMessage, IsIconic, MessageBox, SetForegroundWindow,
    BeginPaint, EndPaint,
} from 'quickwin/lib/windows/user32.js'
import {
    CreateFontIndirect, CreateSolidBrush, SetBkMode, SetTextColor,
    SelectObject, DeleteObject, TextOut,
    CreateBitmap, CreateCompatibleDC, BitBlt, DeleteDC,
} from 'quickwin/lib/windows/gdi32.js'
import { CreateMutex } from 'quickwin/lib/windows/kernel32.js'
import { GetOpenFileName } from 'quickwin/lib/windows/comdlg32.js'
import { RECT, OPENFILENAMEW, PAINTSTRUCT } from 'quickwin/lib/windows/structs.js'
import { getScaleFactor } from 'quickwin/lib/dpi.js'
import {
    BackgroundMode, ButtonCheckState, ButtonMsg, ButtonStyle, EditStyle, LbMsg, ListBoxStyle,
    OpenFileNameFlag, RasterOp, SetWindowPosFlag, SetWindowPosHwnd, ShowWindowCmd,
    WindowStyle, WmMsg,
} from 'quickwin/constants'
import * as shares from './shares.js'
import * as netif from './netif.js'
import * as ctxmenu from './ctxmenu.js'
import { makeQr } from './qrcode.js'
import { setUploadDir, startServer } from './server.js'

// 控件 id（WM_COMMAND LOWORD(wParam)）
const ID_ADD_FILE = 100
const ID_OPEN_DIR = 101
const ID_CTXMENU = 102

const COPYDATA_MAGIC = 0x1A6F1EC   // WM_COPYDATA dwData 自定义魔数（lanfile 的 leet 拼写）

// ── 诊断日志：%TEMP%\lanfile.log（全程静默，deskmon 手法）──
function log(msg: string) {
    try {
        const dir = std.getenv('TEMP')
        if (!dir) return
        const p = dir.replace(/[\\/]+$/, '') + '\\lanfile.log'
        const fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        if (fd === null || (fd as number) < 0) return
        const txt = (Date.now() / 1000).toFixed(3) + ' ' + msg + '\r\n'
        const buf = new ArrayBuffer(txt.length)
        const u8 = new Uint8Array(buf)
        for (let i = 0; i < txt.length; i++) u8[i] = txt.charCodeAt(i)
        os.write(fd as any, buf, 0, txt.length)
        os.close(fd as any)
    } catch { /* 日志失败不影响主体 */ }
}

// ── 配置：%TEMP%\lanfile.json，目前只有 { "ctx": 0|1 }（右键菜单开关；缺省=开）──
type Cfg = { ctx?: number }
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
        return typeof v?.ctx === 'number' ? { ctx: v.ctx } : {}
    } catch { return {} }
}
function saveCfg(c: Cfg): void {
    try {
        const p = cfgPath()
        if (!p) return
        const txt = JSON.stringify(c)
        const fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        if (fd === null || (fd as number) < 0) return
        const bytes = new TextEncoder().encode(txt)
        os.write(fd as any, bytes.buffer as ArrayBuffer, 0, bytes.length)
        os.close(fd as any)
    } catch { /* 静默 */ }
}

// ── exe 路径统一走 ctxmenu.exePath（lib GetModuleFileName 封装）──

// ── 单实例：第二实例把 argv 路径 COPYDATA 给主窗后退出 ──
const MUTEX_NAME = 'Local\\lanfile-singleton'
const GetLastError = bind('kernel32.dll', 'GetLastError', ' -> u32')
const FlashWindow = bind('user32.dll', 'FlashWindow', '<HWND>ptr i32 -> i32')
const ShellExecuteW = bind('shell32.dll', 'ShellExecuteW',
    '<HWND>ptr <WCHAR>ptr <WCHAR>ptr <WCHAR>ptr <WCHAR>ptr i32 -> <>ptr')

const IS64 = os.arch !== 'ia32'
const CDS_SIZE = IS64 ? 24 : 12   // COPYDATASTRUCT：dwData(ULONG_PTR) cbData(DWORD) lpData(PTR)
                                  // x64 实占 24（cbData 后 4B 对齐垫）；ia32 12

function wbuf(s: string): any {
    const p = new PtrArrayBuffer((s.length + 1) * 2)
    const dv = new DataView(p)
    for (let i = 0; i <= s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true)
    return p
}

/** 向已运行主窗转发文件路径；path=null 发空消息仅请求"带到前台"。成功 true */
function forwardPath(hwnd: any, path: string | null): boolean {
    const data = path === null ? null : wbuf(path)   // const 绑定：SendMessage 期间保活
    const cds = new PtrArrayBuffer(CDS_SIZE)
    const dv = new DataView(cds)
    if (IS64) {
        dv.setUint32(0, COPYDATA_MAGIC, true)
        dv.setUint32(8, data ? data.byteLength : 0, true)
        dv.setUint32(16, data ? (data as any).ptr : 0, true)
        dv.setUint32(20, 0, true)
    } else {
        dv.setUint32(0, COPYDATA_MAGIC, true)
        dv.setUint32(4, data ? data.byteLength : 0, true)
        dv.setUint32(8, data ? (data as any).ptr : 0, true)
    }
    // SendMessage 同步：主进程拷完才返回，cds/data 生命周期因此安全
    SendMessage(hwnd, WmMsg.COPYDATA as any, 0, (cds as any).ptr)
    return true
}

// ── 布局（基准像素 × DPI scale）──
const S = getScaleFactor()
const WIN_W = Math.round(520 * S)
const WIN_H = Math.round(360 * S)
const QR_W = Math.round(176 * S)      // 左侧 QR 面板宽
const CHK_W = Math.round(94 * S)      // ☑右键菜单（勾选框，跟地址栏同一行；含勾选块 + 文字 + 边距）
const ADD_W = Math.round(84 * S)      // 添加文件
const OPEN_W = Math.round(68 * S)     // 打开上传目录
const PAD = Math.round(12 * S)
const TIP_H = Math.round(20 * S)
const CTRL_H = Math.round(26 * S)
const FONT_H = -Math.round(12 * S)

let hwndMain: any = null
let hFont: any = null
let hList: any = null
let hAddr: any = null
let hDirTip: any = null
let hBtnCtx: any = null
let bgBrush = CreateSolidBrush(0x00ffffff)   // COLORREF 0x00BBGGRR 白
let clientW = WIN_W            // 客户区实际尺寸（buildControls 里取，窗口外框 ≠ 客户区）
let clientH = WIN_H
let serverPort = 0
let serverFallback = false
let primary = ''
let uploadAbs = ''
let qr: ReturnType<typeof makeQr> | null = null
let ctxOn = false
let cfg: Cfg = {}

function scriptArgPaths(): string[] {
    const args: string[] = []
    try {
        for (const a of (globalThis as any).scriptArgs ?? []) {
            if (typeof a !== 'string' || a.length === 0) continue
            if (/^[a-zA-Z]:[\\/]/.test(a) || a.startsWith('\\\\')) args.push(a)
        }
    } catch { /* 无 argv */ }
    return args
}

// ── UI 构建 ──
const CHILD = WindowStyle.CHILD | WindowStyle.VISIBLE

function child(cls: string, text: string, style: number, x: number, y: number, w: number, h: number, id: number): any {
    const hc = CreateWindowEx(
        0, cls, text, style,
        x, y, w, h,
        hwndMain, id as any, NULL as any, NULL)
    if (hc && hFont) SendMessage(hc, WmMsg.SETFONT, hFont as any, 1)
    return hc
}

function setText(hc: any, text: string): void {
    if (!hc) return
    // lParam 是 <>ptr（只收数字/NULL）→ 字符串先进 UTF-16 缓冲再传地址；const 绑定保活
    const b = wbuf(text)
    SendMessage(hc, WmMsg.SETTEXT, 0 as any, (b as any).ptr)
}

function buildControls(): void {
    // 布局按客户区算：CreateWindow 的宽高是外框，直接用会切掉底部。
    // 三行：① 地址栏 + ☑右键菜单（勾选框跟在 URL 右边）
    //      ② 左 QR 面板 / 右共享列表（列表填满剩余高度）
    //      ③ 添加文件 / 上传保存路径 / 打开上传目录
    const rcBuf = RECT.alloc()
    GetClientRect(hwndMain, rcBuf.ptr)
    const rc = RECT.decode(rcBuf) as { left: number; top: number; right: number; bottom: number }
    clientW = rc.right - rc.left
    clientH = rc.bottom - rc.top

    const gap = Math.round(6 * S)
    const rightX = QR_W + PAD
    const rightW = clientW - rightX - PAD
    const listY = PAD + CTRL_H + gap
    const rowY = clientH - PAD - CTRL_H

    hAddr = child('EDIT', '', CHILD | EditStyle.READONLY | WindowStyle.BORDER,
        PAD, PAD, clientW - PAD * 2 - CHK_W - gap, CTRL_H, 0)
    // AUTOCHECKBOX 自己翻勾选态并回发 WM_COMMAND(BN_CLICKED)
    hBtnCtx = child('BUTTON', '右键菜单(&M)', CHILD | ButtonStyle.AUTOCHECKBOX,
        clientW - PAD - CHK_W, PAD, CHK_W, CTRL_H, ID_CTXMENU)

    hList = child('LISTBOX', '', CHILD | ListBoxStyle.HASSTRINGS | WindowStyle.VSCROLL | WindowStyle.BORDER,
        rightX, listY, rightW, rowY - gap - listY, 0)

    child('BUTTON', '添加文件(&A)', CHILD, PAD, rowY, ADD_W, CTRL_H, ID_ADD_FILE)
    hDirTip = child('STATIC', '', CHILD, PAD + ADD_W + gap, rowY,
        clientW - PAD * 2 - ADD_W - OPEN_W - gap * 2, CTRL_H, 0)
    child('BUTTON', '打开(&O)', CHILD, clientW - PAD - OPEN_W, rowY, OPEN_W, CTRL_H, ID_OPEN_DIR)
}

function updateAddrText(): void {
    setText(hAddr, 'http://' + primary + ':' + serverPort + '/'
        + (serverFallback ? '   （默认端口被占，已改用随机端口）' : ''))
}

function refreshList(): void {
    if (!hList) return
    SendMessage(hList, LbMsg.RESETCONTENT, 0 as any, 0 as any)
    for (const e of shares.all()) {
        const b = wbuf(e.rel + '  (' + fmtSize(e.size) + ')')   // const 绑定保活
        SendMessage(hList, LbMsg.ADDSTRING, 0 as any, (b as any).ptr)
    }
    InvalidateRect(hwndMain, NULL, 0)
}

function fmtSize(n: number): string {
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
    return n + ' B'
}

// ── QR 位图（内容不变只生成一次；WM_PAINT 一次 BitBlt 贴图）──
// 库出的是 1px/模块 RGBA；QR 只有黑白像素，RGBA 与 GDI 32bpp 的 BGRA 同值。
// 位图按 1px/模块保存，贴图时再放大 cell 倍，避免按显示尺寸存大图。
let hbmQr: any = null
let qrW = 0
let qrH = 0
let qrPx = 0
let qrOx = 0
let qrOy = 0

function buildQrBitmap(): void {
    if (hbmQr) { DeleteObject(hbmQr); hbmQr = null }
    if (!qr) return
    const cell = Math.max(2, Math.floor((QR_W - PAD * 2) / qr.width))
    qrW = qr.width
    qrH = qr.height
    qrPx = qrW * cell
    // 在 JS 里按显示尺寸最近邻放大：XP 的 GDI 对 32bpp DDB 做 StretchBlt 会整块变黑，
    // 换成等尺寸 BitBlt 后两个系统一致（每行同色可直接整理，这里方块数很少，逐像素即可）。
    const buf = new PtrArrayBuffer(qrPx * qrPx * 4)
    const out = new Uint8Array(buf)
    const src = qr.data
    for (let y = 0; y < qrPx; y++) {
        const sy = (y / cell) | 0
        for (let x = 0; x < qrPx; x++) {
            const si = (sy * qrW + ((x / cell) | 0)) * 4
            const di = (y * qrPx + x) * 4
            out[di] = src[si]
            out[di + 1] = src[si + 1]
            out[di + 2] = src[si + 2]
            out[di + 3] = 255
        }
    }
    hbmQr = CreateBitmap(qrPx, qrPx, 1, 32, buf)
    // QR 面板 = 地址行以下、底部按钮行以上（底部再留出 tip 文字），竖向居中
    const panelTop = PAD + CTRL_H + Math.round(6 * S)
    const panelBot = clientH - PAD - CTRL_H
    qrOx = Math.floor((QR_W - qrPx) / 2)
    qrOy = panelTop + Math.max(0, Math.floor((panelBot - TIP_H - panelTop - qrPx) / 2))
}

// ── WM_PAINT：左侧 QR 面板 ──
const paintBuf = PAINTSTRUCT.alloc()   // 消息内复用（deskmon 同款）
const WM_ERASEBKGND = 0x0014

function paint(): void {
    const hdc = BeginPaint(hwndMain, paintBuf.ptr)
    if (!hdc) return
    try {
        // 整块客户区都填：WM_ERASEBKGND 被抑制（防闪），漏填的区域会留上次的残影
        const rc = RECT.encode({ left: 0, top: 0, right: clientW, bottom: clientH })
        FillRect(hdc, rc.ptr, bgBrush)
        if (hbmQr) {
            const mem = CreateCompatibleDC(hdc)
            if (!mem) throw new Error('CreateCompatibleDC failed')
            const old = SelectObject(mem, hbmQr)
            BitBlt(hdc, qrOx, qrOy, qrPx, qrPx, mem, 0, 0, RasterOp.SRCCOPY)
            SelectObject(mem, old)
            DeleteDC(mem)
        }
        if (hFont) SelectObject(hdc, hFont)
        SetBkMode(hdc, BackgroundMode.TRANSPARENT)
        SetTextColor(hdc, 0x00555555)
        const tip = qrPx ? '手机扫码或输入地址' : '二维码生成失败，请用手机输入地址'
        // tip 贴在 QR 面板底部（按钮行上方），不再占独立一行
        TextOut(hdc, Math.round(10 * S), clientH - PAD - CTRL_H - TIP_H + Math.round(3 * S), tip, tip.length)
    } catch (e) {
        log('paint err: ' + e)
    }
    EndPaint(hwndMain, paintBuf.ptr)
}

// ── 对话框（照 react-qw PathPicker 的原生调用法）──
function openFilesDialog(): string[] {
    try {
        const fileBuf = WCHAR.alloc(16384)   // 多选：dir\0file1\0file2\0\0
        const filter = WCHAR.encode('所有文件\0*.*\0\0')
        const title = WCHAR.encode('选择要共享的文件')
        const ofn = OPENFILENAMEW.encode({
            lStructSize: OPENFILENAMEW.size,
            hwndOwner: hwndMain,
            lpstrFilter: filter.ptr,
            lpstrFile: fileBuf.ptr,
            nMaxFile: 16384,
            lpstrTitle: title.ptr,
            Flags: OpenFileNameFlag.HIDEREADONLY | OpenFileNameFlag.PATHMUSTEXIST | OpenFileNameFlag.FILEMUSTEXIST
                | OpenFileNameFlag.ALLOWMULTISELECT | OpenFileNameFlag.EXPLORER,
        })
        if (!GetOpenFileName(ofn.ptr)) return []
        const strs = new TextDecoder('utf-16le')
            .decode(new Uint8Array(fileBuf)).split('\0')
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
function recvCopyData(lParam: number): void {
    try {
        if (!lParam) return
        const magic = ffi.readPtr(lParam)
        if (magic !== COPYDATA_MAGIC) return
        const cbData = os.arch !== 'ia32'
            ? new DataView(ffi.readBytes(lParam + 8, 4)).getUint32(0, true)
            : new DataView(ffi.readBytes(lParam + 4, 4)).getUint32(0, true)
        const lpData = ffi.readPtr(lParam + (IS64 ? 16 : 8))
        if (cbData === 0 || !lpData) {
            bringToFront()      // 空消息 = 第二实例请求"带前台"
            return
        }
        const bytes = ffi.readBytes(lpData, cbData)
        const path = new TextDecoder('utf-16le').decode(new Uint8Array(bytes))
        // 尾部 NUL 去除
        const clean = path.replace(/\0+$/, '')
        if (clean) shares.addPath(clean)
        bringToFront()
    } catch (e) {
        log('recvCopyData err: ' + e)
    }
}

// ── 动作 ──
function addFiles(): void {
    for (const f of openFilesDialog()) shares.addPath(f)
}
function openUploadDir(): void {
    ShellExecuteW(hwndMain, wbuf('open'), wbuf(uploadAbs), NULL as any, NULL as any, 1)
}
// 勾选框自己翻勾选态；这里只回写注册表 + 配置（注册表失败保持原态）
function toggleCtx(): void {
    const want = !ctxOn
    if (!ctxmenu.setEnabled(want)) return
    ctxOn = want
    cfg.ctx = ctxOn ? 1 : 0
    saveCfg(cfg)
}
// 启动时按配置回显勾选态
function setCtxChecked(on: number): void {
    if (hBtnCtx) SendMessage(hBtnCtx, ButtonMsg.SETCHECK,
        on ? ButtonCheckState.CHECKED : ButtonCheckState.UNCHECKED, 0 as any)
}

gui.RegisterClass('lanfile_Main', (hwnd: any, msg: number, wParam: number, lParam: number): number => {
    if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
    if (msg === WM_ERASEBKGND) return 1   // 背景由 paint 统一填，避免先擦白再画闪一下
    if (msg === WmMsg.PAINT) {
        paint()
        return 0
    }
    if (msg === WmMsg.COMMAND) {
        const id = wParam & 0xffff
        if (id === ID_ADD_FILE) addFiles()
        else if (id === ID_OPEN_DIR) openUploadDir()
        else if (id === ID_CTXMENU) toggleCtx()   // AUTOCHECKBOX 已翻好勾选态
        return 0
    }
    if (msg === WmMsg.COPYDATA) {
        recvCopyData(lParam)
        return 1
    }
    if (msg === WmMsg.CLOSE) {
        PostQuitMessage(0)
        return 0
    }
    return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

shares.onUpdate(refreshList)

// ── 启动 ──
function main(): void {
    cfg = loadCfg()

    // 1. 单实例：已有主窗 → 转发 argv 路径（无路径则只请求带前台）后退出
    CreateMutex(NULL as any, 0, MUTEX_NAME)
    const exists = GetLastError() === 183   // ERROR_ALREADY_EXISTS
    const argvPaths = scriptArgPaths()
    if (exists) {
        const hwnd = FindWindow('lanfile_Main', NULL as any)
        if (hwnd) {
            for (const p of argvPaths) forwardPath(hwnd, p)
            if (argvPaths.length === 0) forwardPath(hwnd, null)
        }
        log('second instance: forwarded ' + argvPaths.length + ' path(s), exit')
        std.exit(0)
    }

    // 2. 窗口（消息循环集成在 os 事件循环；gui 无独立 pump 调用）
    // CLIPCHILDREN：父窗自绘时不往子控件区域画（否则整块 FillRect 会盖住控件）
    hwndMain = gui.CreateWindow('lanfile_Main', 'lanfile',
        WindowStyle.OVERLAPPEDWINDOW | WindowStyle.CLIPCHILDREN,
        Math.round(80 * S), Math.round(80 * S), WIN_W, WIN_H, null, null)
    if (!hwndMain) {
        log('CreateWindow failed')
        std.exit(1)
    }
    hFont = CreateFontIndirect({ lfHeight: FONT_H, lfWeight: 400, lfFaceName: 'Tahoma' })
    buildControls()
    const exe = ctxmenu.exePath()
    uploadAbs = exe.slice(0, exe.lastIndexOf('\\')) + '\\uploads'
    setUploadDir(uploadAbs)
    setText(hDirTip, '上传保存: ' + uploadAbs)
    ctxOn = cfg.ctx !== 0          // 右键菜单默认开；注册表与勾选框一起反映
    ctxmenu.setEnabled(ctxOn)
    setCtxChecked(ctxOn ? 1 : 0)

    // 3. 服务（8321 被占自动回退随机端口）
    try {
        const r = startServer(8321)
        serverPort = r.port
        serverFallback = r.fallback
    } catch (e) {
        log('listen failed: ' + e)
        MessageBox(hwndMain, '端口监听失败：' + String(e), 'lanfile', 0)
        std.exit(1)
    }
    const lan = netif.lanAddresses()
    primary = lan.primary
    try {
        qr = makeQr('http://' + primary + ':' + serverPort + '/')
    } catch (e) {
        log('qr failed: ' + e)
        qr = null
    }
    buildQrBitmap()
    log('server: ' + primary + ':' + serverPort + ' fallback=' + serverFallback
        + ' addrs=' + lan.all.join(','))
    updateAddrText()

    // 4. argv 文件入表
    for (const p of argvPaths) shares.addPath(p)
    refreshList()
    SetWindowPos(hwndMain, SetWindowPosHwnd.TOP, 0, 0, 0, 0,
        SetWindowPosFlag.SWP_NOMOVE | SetWindowPosFlag.SWP_NOSIZE)
    ShowWindow(hwndMain, ShowWindowCmd.SHOWNORMAL)
    print('lanfile: http://' + primary + ':' + serverPort + '/ uploads=' + uploadAbs)
}

main()
