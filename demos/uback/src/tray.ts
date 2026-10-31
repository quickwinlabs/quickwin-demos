// tray —— 托盘常驻（ShellNotifyIcon + 右键菜单；「暂停/恢复」与设置页总开关同源持久化）
import * as gui from 'gui'
import { NULL, PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import {
    AppendMenu, CreatePopupMenu, DestroyMenu, GetCursorPos, LoadImageOrdinal,
    PostQuitMessage, SetForegroundWindow, ShowWindow, TrackPopupMenu,
} from 'quickwin/lib/windows/user32.js'
import { ShellNotifyIcon } from 'quickwin/lib/windows/shell32.js'
import { NOTIFYICONDATAW, POINT } from 'quickwin/lib/windows/structs.js'
import { IDI, ImageType, LoadImageFlag, NotifyIconCmd, NotifyIconFlag, ShowWindowCmd, TrackPopupMenuFlag } from 'quickwin/constants'
import { getState } from './store.js'
import { setAutoImport } from './engine.js'

export const WM_TRAY = 0x8001

const CMD_OPEN = 1
const CMD_PAUSE = 2
const CMD_EXIT = 3

let hwnd: gui.HWND | null = null
let hIcon: unknown = null
let onExit: (() => void) | null = null

export function setTrayExitHandler(fn: () => void): void {
    onExit = fn
}

function trayData(): Record<string, unknown> {
    return {
        cbSize: NOTIFYICONDATAW.size,
        hWnd: hwnd,
        uID: 1,
        uFlags: NotifyIconFlag.MESSAGE | NotifyIconFlag.ICON | NotifyIconFlag.TIP,
        uCallbackMessage: WM_TRAY,
        hIcon,
        szTip: 'uback 自动备份',
    }
}

/** 添加托盘图标；失败 → false（不影响主功能） */
export function initTray(h: gui.HWND): boolean {
    hwnd = h
    hIcon = gui.LoadAppIcon(16, 16) ||
        LoadImageOrdinal(NULL, IDI.APPLICATION, ImageType.ICON, 16, 16, LoadImageFlag.SHARED)
    if (!hIcon) return false
    return ShellNotifyIcon(NotifyIconCmd.ADD, trayData()) !== 0
}

export function removeTray(): void {
    if (hwnd && hIcon) ShellNotifyIcon(NotifyIconCmd.DELETE, trayData())
}

function cursorPos(): { x: number; y: number } | null {
    const pt = POINT.alloc()
    return GetCursorPos(pt.ptr) ? POINT.decode(pt) : null
}

function showMenu(): void {
    if (!hwnd) return
    SetForegroundWindow(hwnd)
    const p = cursorPos()
    const menu = CreatePopupMenu()
    if (!menu) return
    const paused = !getState().cfg.autoImport   // 总开关关 = 暂停中
    AppendMenu(menu, 0, CMD_OPEN, '打开窗口(&O)')
    AppendMenu(menu, paused ? 0x8 : 0, CMD_PAUSE, paused ? '恢复自动备份(&P)' : '暂停自动备份(&P)')
    AppendMenu(menu, 0x0800, 0, '')             // MF_SEPARATOR
    AppendMenu(menu, 0, CMD_EXIT, '退出(&X)')
    const cmd = TrackPopupMenu(menu,
        TrackPopupMenuFlag.RETURNCMD | TrackPopupMenuFlag.RIGHTBUTTON,
        p ? p.x : 0, p ? p.y : 0, 0, hwnd, NULL)
    DestroyMenu(menu)
    if (cmd === CMD_OPEN) {
        ShowWindow(hwnd, ShowWindowCmd.SHOWNORMAL)
        SetForegroundWindow(hwnd)
    } else if (cmd === CMD_PAUSE) {
        setAutoImport(!getState().cfg.autoImport)
    } else if (cmd === CMD_EXIT) {
        removeTray()
        if (onExit) onExit()
        else PostQuitMessage(0)
    }
}

/** 托盘回调：lParam 0x0201 左键 / 0x0204、0x007B 右键 */
export function onTrayEvent(lParam: number): void {
    if (lParam === 0x0204 || lParam === 0x007B) {
        showMenu()
    } else if (lParam === 0x0201) {
        if (hwnd) {
            ShowWindow(hwnd, ShowWindowCmd.SHOWNORMAL)
            SetForegroundWindow(hwnd)
        }
    }
}
