// uback —— U 盘 → 电脑增量备份（托盘常驻、开机自启）
//
// 交互：两个页签「备份 / 设置」。备份页每行一个复选框（勾选 = 该设备插入时自动备份），
// 设置页总开关 + 开机自启。托盘菜单「打开窗口 / 暂停·恢复自动备份 / 退出」，
// 「暂停/恢复」与设置页总开关同源持久化（setAutoImport）。
//
// 消息：WM_CLOSE → 隐藏到托盘；WM_DEVICECHANGE(0x0219) 广播 + 3s GetLogicalDrives 轮询兜底
// 都走 refreshDrives；WM_TRAY(0x8001) 托盘回调。
//
// 单实例：CreateMutex 判重；第二实例把已有窗口带回前台后退出。
import 'quickwin/lib/polyfill.js'
import { useMemo, useSyncExternalStore } from 'react'
import * as gui from 'gui'
import { bind, WCHAR } from 'quickwin/lib/ffi/bind.js'
import { NULL } from 'quickwin/lib/ffi/ctype.js'
import { CreateMutex } from 'quickwin/lib/windows/kernel32.js'
import { FindWindow, PostQuitMessage, SetForegroundWindow, ShowWindow } from 'quickwin/lib/windows/user32.js'
import { Button, CheckBox, PathPicker, ProgressBar, ScrollView, Tab, createRoot } from 'quickwin/lib/react-qw/index.js'
import type { WEvent } from 'quickwin/lib/msg-registry.js'
import { ErrorCode, ShowWindowCmd, WindowStyle, WmMsg } from 'quickwin/constants'
import { getState, setState, subscribe, type DeviceView, type State } from './store.js'
import {
    cancelImport, forgetDevice, manualImport, refreshDrives, setAutoImport, toggleAllow,
} from './engine.js'
import { applyAutoStart, configPath, loadConfig, saveConfig } from './config.js'
import { initTray, onTrayEvent, removeTray, setTrayExitHandler, WM_TRAY } from './tray.js'
import { fmtBytes } from './util.js'
import { glog } from './log.js'

// WM_DEVICECHANGE 框架注册表未预填（未注册消息比较会 TS2367），这里声明合并
declare global {
    interface QuickWinMsgRegistry {
        0x8001: { wParam: number; lParam: number }
        0x0219: { wParam: number; lParam: number }
    }
}

const WM_DEVICECHANGE = 0x0219
const MUTEX_NAME = 'Local\\uback-singleton'
const GetLastError = bind('kernel32.dll', 'GetLastError', ' -> u32')

let rootHwnd: gui.HWND | null = null
let devTimer = 0

// ── store 桥接 ──
function useStore(): State {
    return useSyncExternalStore(subscribe, getState)
}

// ── 文本 ──
function rowText(d: DeviceView): string {
    const name = (d.vendor + ' ' + d.product).trim() || (d.label || '未知 U 盘')
    const cap = d.capacity > 0 ? ' · ' + fmtBytes(d.capacity) : ''
    let state: string
    if (d.noSerial) state = ' · 无序列号'
    else if (!d.connected) state = ' · 未连接'
    else state = ' · ' + d.drive + ':'
    const mm = d.mismatch ? ' · 容量变化' : ''
    return name + state + cap + mm
}

function statusLine(st: State): string {
    const j = st.job
    if (j.running) {
        if (j.phase === 'scan') return '正在扫描 ' + j.drive + ': ...'
        return '正在导入 ' + j.currentFile + '   文件 ' + j.doneFiles + '/' + j.totalFiles +
            '   ' + fmtBytes(j.bytesCopied) + '/' + fmtBytes(j.totalBytes) +
            (j.failed > 0 ? '   失败 ' + j.failed : '')
    }
    if (st.banner) return st.banner
    const connected = st.devices.filter((d) => d.connected).length
    const off = st.devices.length - connected
    let s = '就绪'
    if (connected) s += '：已连接 ' + connected + ' 台'
    if (off > 0) s += '，记住 ' + off + ' 台'
    return s
}

// ── 页签：备份 ──
const ROW_H = 26

function BackupPane() {
    const st = useStore()
    const job = st.job
    const rows = st.devices.length
    const firstConnected = st.devices.find((d) => d.connected)
    return (
        <w type="STATIC" style={{ flexGrow: 1, flexDirection: 'column', gap: 6 }}>
            <w type="STATIC" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <w type="STATIC" text="目标文件夹" style={{ width: 70, height: 22 }} />
                <PathPicker type="folder" value={st.cfg.destRoot} onChange={onDestRoot} style={{ flexGrow: 1, height: 22 }} />
            </w>
            <w type="STATIC" text="已识别的 U 盘（勾选 = 插入时自动备份）" style={{ height: 18 }} />
            <ScrollView style={{ flexGrow: 1 }} contentWidth={480} contentHeight={Math.max(rows, 1) * ROW_H + 4}>
                {rows === 0 ? (
                    <w type="STATIC" text="未发现 U 盘（插上后自动识别）" style={{ width: 480, height: ROW_H }} />
                ) : st.devices.map((d) => (
                    <w type="STATIC" key={d.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, width: 480, height: ROW_H }}>
                        <CheckBox checked={d.allow} disabled={d.noSerial || job.running} label={rowText(d)}
                            onChange={() => toggleAllow(d.key)} style={{ flexGrow: 1 }} />
                        {!d.connected ? (
                            <Button onClick={() => forgetDevice(d.key)} style={{ width: 24, height: 22 }}>×</Button>
                        ) : null}
                    </w>
                ))}
            </ScrollView>
            <w type="STATIC" text={statusLine(st)} style={{ height: 18 }} />
            {job.running && job.phase === 'copy' ? (
                <ProgressBar value={job.doneFiles} max={Math.max(job.totalFiles, 1)} style={{ height: 14 }} />
            ) : null}
            <w type="STATIC" style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 6 }}>
                <Button
                    onClick={() => firstConnected && manualImport(firstConnected.key, firstConnected.drive)}
                    disabled={!firstConnected || job.running}>立即导入</Button>
                <Button onClick={cancelImport} disabled={!job.running}>停止</Button>
            </w>
        </w>
    )
}

function onDestRoot(v: string): void {
    const st = getState()
    if (!v) return
    st.cfg.destRoot = v
    saveConfig(st.cfg)
    setState({ cfg: { ...st.cfg } })
}

// ── 页签：设置 ──
function SettingsPane() {
    const st = useStore()
    return (
        <w type="STATIC" style={{ flexGrow: 1, flexDirection: 'column', gap: 8, padding: 4 }}>
            <w type="STATIC" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <CheckBox checked={st.cfg.autoImport} label="插入 U 盘时自动备份"
                    onChange={(on) => setAutoImport(on)} style={{ width: 220, height: 22 }} />
            </w>
            <w type="STATIC" text="关闭后仍可在「备份」页用「立即导入」手动备份" style={{ height: 18 }} />
            <w type="STATIC" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <CheckBox checked={st.cfg.autoStart} label="开机自启"
                    onChange={(on) => {
                        const s = getState()
                        s.cfg.autoStart = on
                        saveConfig(s.cfg)
                        applyAutoStart(on)
                        setState({ cfg: { ...s.cfg } })
                    }}
                    style={{ width: 220, height: 22 }} />
            </w>
            <w type="STATIC" text="─── 信息 ───" style={{ height: 18 }} />
            <w type="STATIC" text={'配置文件  ' + configPath()} style={{ height: 18 }} />
            <w type="STATIC" text={'日志文件  ' + configPath().replace(/\\config\.json$/, '\\uback.log')} style={{ height: 18 }} />
            <w type="STATIC" text={'目标目录  ' + st.cfg.destRoot} style={{ height: 18 }} />
            <w type="STATIC" text="版本      uback 1.0" style={{ height: 18 }} />
        </w>
    )
}

// ── App ──
function App() {
    const st = useStore()
    // tabs 引用稳定（useMemo []）：App 因 store 变化重渲染时不会重建页签头
    const tabs = useMemo(() => [
        { title: '备份', content: <BackupPane /> },
        { title: '设置', content: <SettingsPane /> },
    ], [])
    return (
        <w type="STATIC" style={{ flexGrow: 1, padding: 8 }}>
            <Tab tabs={tabs} selectedIndex={st.tab} onChange={(i) => setState({ tab: i })} style={{ flexGrow: 1 }} />
        </w>
    )
}

// ── 窗口消息 ──
function onRootMsg(e: WEvent): number | void {
    if (e.msg === WmMsg.CLOSE) {
        // 关闭 = 隐藏到托盘
        if (rootHwnd) ShowWindow(rootHwnd, ShowWindowCmd.HIDE)
        return 0
    }
    if (e.msg === WM_TRAY) {
        onTrayEvent(e.lParam)
        return 0
    }
    if (e.msg === WM_DEVICECHANGE) {
        scheduleRefresh()
        return 0
    }
    // SIZE → react-qw forceFlexLayout；DESTROY → react-qw 清 rootMap（托盘在退出命令里已删）
}

// ── 设备变化（广播 + 轮询兜底） ──
function scheduleRefresh(): void {
    if (devTimer) return
    devTimer = setTimeout(() => { devTimer = 0; refreshDrives() }, 300) as unknown as number
}

function poll(): void {
    refreshDrives()
    setTimeout(poll, 3000)
}

// ── 启动 ──
function main(): void {
    // 1. 单实例
    CreateMutex(NULL, 0, MUTEX_NAME)
    if (GetLastError() === ErrorCode.ALREADY_EXISTS) {
        const h = FindWindow(NULL, 'uback')
        if (h) {
            ShowWindow(h, ShowWindowCmd.SHOWNORMAL)
            SetForegroundWindow(h)
        }
        glog('second instance: exit')
        PostQuitMessage(0)
        return
    }

    // 2. 配置 + 自启校正
    const cfg = loadConfig()
    applyAutoStart(cfg.autoStart)
    setState({ cfg })

    // 3. 主窗（关闭 → 托盘；WM_DEVICECHANGE/WM_TRAY 由 onRootMsg 接）
    const root = createRoot({
        text: 'uback',
        ws: WindowStyle.CLIPCHILDREN,
        width: 520,
        height: 430,
        onEvent: onRootMsg,
    })
    rootHwnd = root.hwnd

    // 4. 托盘
    const trayOk = initTray(root.hwnd)
    setTrayExitHandler(() => PostQuitMessage(0))
    if (!trayOk) glog('托盘图标创建失败（继续运行）')

    // 5. 渲染 + 首次枚举 + 轮询
    root.render(<App />)
    refreshDrives()
    setTimeout(poll, 3000)

    glog('启动 (tray=' + trayOk + ' autoImport=' + cfg.autoImport + ')')
}

main()
