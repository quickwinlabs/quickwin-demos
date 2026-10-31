// log —— 全局日志 %APPDATA%\uback\uback.log + 每设备目录 uback.txt（追加写、缓冲）
//
// uback.txt 约定（方案定稿）：
//   - 只逐文件记「复制 / 失败」，跳过只在汇总行报数
//   - UTF-8 带 BOM（首建时写）；XP/7 记事本可读
//   - 单次运行明细 5 万行上限；文件 5MB 轮转 uback.1.txt（只留一份旧的）
//   - 8KB 文本缓冲，满/每 100 行 flush；开始行立即落盘（拔盘也能看出"开始了"）
//   - 写失败不中断导入，只记全局日志
import { PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import * as wf from './wfile.js'
import { fmtBytes, fmtBytesRaw, fmtSecs, nowStr } from './util.js'
import { appDir } from './config.js'

// ── 全局日志 ──

/** 追加一行全局日志（低频率；失败静默） */
export function glog(msg: string): void {
    try {
        wf.appendText(appDir() + '\\uback.log', nowStr() + ' ' + msg + '\r\n')
    } catch { /* 日志失败不影响主体 */ }
}

// ── 设备操作记录（uback.txt） ──

const MAX_LINES = 50000        // 单次运行明细行数上限
const MAX_BYTES = 5 * 1024 * 1024
const BUF_MAX = 8192           // 8KB 文本缓冲
const FLUSH_LINES = 100
const REL_WIDTH = 44           // 明细行 rel 部分显示宽度

export interface DeviceMeta {
    serial: string
    vendor: string
    product: string
    label: string
    capacity: number
}

export class DeviceTxt {
    private path = ''
    private h: ReturnType<typeof wf.openAppend> = null
    private buf: string[] = []
    private bufLen = 0
    private lineCount = 0
    private truncated = false
    private writeErr = false

    /** 打开记录文件；失败 → false（调用方照常导入，只少记录）。 */
    open(destDir: string, meta: DeviceMeta): boolean {
        this.path = destDir.replace(/[\\/]+$/, '') + '\\uback.txt'
        wf.mkdirs(destDir)
        // 轮转：超过 5MB → uback.1.txt（只留一份旧的）
        const st = wf.stat(this.path)
        const existed = !!st
        if (st && st.size > MAX_BYTES) {
            wf.removeFile(destDir.replace(/[\\/]+$/, '') + '\\uback.1.txt')
            wf.moveFileEx(this.path, destDir.replace(/[\\/]+$/, '') + '\\uback.1.txt', true)
        }
        this.h = wf.openAppend(this.path)
        if (!this.h) return false
        if (!existed) {
            // 首建：BOM + header（容量人类可读）
            const head =
                'uback 操作记录\r\n' +
                '设备: ' + (meta.vendor + ' ' + meta.product).trim() + '\r\n' +
                '序列号: ' + meta.serial + '\r\n' +
                '容量: ' + fmtBytes(meta.capacity) + '\r\n' +
                '首次: ' + nowStr() + '\r\n\r\n'
            const u8 = wf.utf8Encode(head)
            const pab = new PtrArrayBuffer(3 + u8.length)
            const u = new Uint8Array(pab)
            u[0] = 0xEF; u[1] = 0xBB; u[2] = 0xBF
            u.set(u8, 3)
            if (wf.write(this.h, pab, u8.length + 3) !== u8.length + 3) this.writeErr = true
            wf.flush(this.h)
        }
        return true
    }

    /** 开始行：立即落盘 */
    start(drive: string): void {
        this.writeLine('[' + nowStr() + '] 开始导入 (' + drive + ':)', true)
    }

    /** 中止行（用户取消/异常） */
    abort(reason: string): void {
        this.writeLine('[' + nowStr() + '] ' + reason, true)
    }

    /** 复制成功明细 */
    copy(rel: string, size: number): void {
        if (this.truncated) return
        if (this.lineCount >= MAX_LINES) {
            this.truncated = true
            this.writeLine('…（明细过多，后续只记摘要与失败项）', true)
            return
        }
        this.writeLine('复制  ' + rel.padEnd(REL_WIDTH, ' ') + '  ' + fmtBytesRaw(size), false)
    }

    /** 失败明细（不受行数上限限制） */
    fail(rel: string, size: number, reason: string): void {
        this.writeLine('失败  ' + rel.padEnd(REL_WIDTH, ' ') + '  ' + fmtBytesRaw(size) + '  ' + reason, false)
    }

    /** 汇总行 */
    summary(copied: number, skipped: number, failed: number, bytes: number, secs: number): void {
        this.writeLine('[' + nowStr() + '] 完成: 复制 ' + copied + ' 个 (' + fmtBytes(bytes) +
            '), 跳过 ' + skipped + ' 个, 失败 ' + failed + ' 个, 用时 ' + fmtSecs(secs), true)
    }

    /** 收尾：flush + close */
    close(): void {
        this.flushNow()
        if (this.h) { wf.close(this.h); this.h = null }
    }

    private writeLine(line: string, flush: boolean): void {
        if (!this.h || this.writeErr) return
        const s = line + '\r\n'
        this.buf.push(s)
        this.bufLen += s.length
        this.lineCount++
        if (flush || this.bufLen >= BUF_MAX || this.buf.length >= FLUSH_LINES) this.flushNow()
    }

    private flushNow(): void {
        if (!this.h || this.bufLen === 0) return
        const text = this.buf.join('')
        const u8 = wf.utf8Encode(text)
        const pab = new PtrArrayBuffer(u8.length)
        new Uint8Array(pab).set(u8)
        const n = wf.write(this.h, pab, u8.length)
        this.buf = []
        this.bufLen = 0
        if (n !== u8.length) {
            this.writeErr = true
            glog('设备记录写失败: ' + this.path)
        }
    }
}
