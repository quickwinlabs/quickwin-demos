// engine —— 设备枚举/识别 + 增量导入（只增不删、分块让出、可取消）
//
// 线程模型：单线程 + 消息泵。复制/枚举用 256KB 分块 + 每 1MB `setTimeout(0)` 让出，
// 进度每 200ms 推 store，UI 不冻结、可取消。文件操作全走 wfile.ts（Win32 W API）。
import { PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import { removableDrives } from './drives.js'
import * as wf from './wfile.js'
import { getState, setState, type DeviceView, type JobView } from './store.js'
import { saveConfig, type Config, type DeviceRecord } from './config.js'
import { DeviceTxt, glog } from './log.js'
import { hash8, sanitizeName } from './util.js'

// ── 常量 ──
const CHUNK = 256 * 1024          // 复制分块
const YIELD_EVERY = 1024 * 1024   // 每 1MB 让出一次
const TWO_SEC_100NS = 20000000n   // FAT32 2s 粒度容差

/** 让出：交还消息泵（quickjs 事件循环集成于 gui 消息泵） */
function yieldTo(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0))
}

/** 每设备目录名 <厂商>_<型号>-<hash8(序列号)> */
export function deviceDirName(vendor: string, product: string, serial: string): string {
    return sanitizeName((vendor || 'USB') + '_' + (product || 'DEVICE')) + '-' + hash8(serial)
}

/** 导入元信息：序列号空 = 无序列号盘（手动导入，目录名用 label 兜底，不持久化） */
export interface ImportMeta {
    serial: string
    drive: string
    vendor: string
    product: string
    label: string
    capacity: number
}

/** 每设备目标目录 <destRoot>\<厂商_型号-hash8(序列号|卷标)> */
export function deviceDestDir(cfg: Config, m: ImportMeta): string {
    const id = m.serial || m.label || 'NOSERIAL'
    return cfg.destRoot.replace(/[\\/]+$/, '') + '\\' + deviceDirName(m.vendor, m.product, id)
}

function devName(vendor: string, product: string): string {
    return (vendor + ' ' + product).trim() || 'U盘'
}

// ── 设备列表（连接 + 记住的离线设备）与自动导入触发 ──
let prevSerials = new Set<string>()
let lastViewsJson = ''

export function refreshDrives(): void {
    const st = getState()
    const cfg = st.cfg
    const drives = removableDrives()
    const views: DeviceView[] = []
    const connected = new Set<string>()
    let candidate: ImportMeta | null = null
    let banner = st.banner

    for (const d of drives) {
        if (d.serial) {
            connected.add(d.serial)
            const cap = Number(d.total)
            const rec = cfg.devices[d.serial]
            let mismatch = false
            if (!rec) {
                // 新设备：记配置（默认不授权），提示（总开关开时）
                cfg.devices[d.serial] = {
                    vendor: d.vendor, product: d.product, label: d.label,
                    capacity: cap, allow: false, lastImport: 0,
                }
                saveConfig(cfg)
                if (cfg.autoImport) banner = '发现新设备: ' + devName(d.vendor, d.product) + '（勾选后插入自动备份）'
            } else {
                // 同序列号但容量/卷标变化 → 读卡器换卡/克隆盘：本次不自动导入，更新记录
                mismatch = rec.capacity !== 0 && rec.capacity !== cap
                if (mismatch) {
                    rec.capacity = cap
                    rec.label = d.label
                    rec.vendor = d.vendor
                    rec.product = d.product
                    saveConfig(cfg)
                    banner = '设备容量/卷标变化: ' + devName(d.vendor, d.product) + '（本次不自动导入）'
                }
            }
            const r = cfg.devices[d.serial]!
            views.push({
                key: d.serial, serial: d.serial, vendor: d.vendor, product: d.product,
                label: d.label, capacity: cap, allow: r.allow,
                connected: true, drive: d.letter, mismatch, noSerial: false,
            })
            if (!prevSerials.has(d.serial) && r.allow && !mismatch && cfg.autoImport && !getState().job.running) {
                candidate = {
                    serial: d.serial, drive: d.letter, vendor: d.vendor, product: d.product,
                    label: d.label, capacity: cap,
                }
            }
        } else {
            // 无序列号：只能手动「立即导入」，不持久化
            views.push({
                key: 'noserial:' + d.letter, serial: '', vendor: d.vendor, product: d.product,
                label: d.label, capacity: Number(d.total), allow: false,
                connected: true, drive: d.letter, mismatch: false, noSerial: true,
            })
        }
    }
    // 记住的离线设备
    for (const k of Object.keys(cfg.devices)) {
        if (connected.has(k)) continue
        const rec = cfg.devices[k]!
        views.push({
            key: k, serial: k, vendor: rec.vendor, product: rec.product, label: rec.label,
            capacity: rec.capacity, allow: rec.allow, connected: false, drive: '',
            mismatch: false, noSerial: false,
        })
    }

    prevSerials = connected
    const j = JSON.stringify(views)
    if (j !== lastViewsJson) {
        lastViewsJson = j
        setState({ devices: views })
    }
    if (banner !== st.banner) setState({ banner })

    if (candidate) {
        glog('自动导入: ' + candidate.serial)
        void startImport(candidate)
    }
}

/** 勾选/取消某设备授权（立即写配置） */
export function toggleAllow(key: string): void {
    const st = getState()
    const rec = st.cfg.devices[key]
    if (!rec) return
    rec.allow = !rec.allow
    saveConfig(st.cfg)
    setState({
        cfg: { ...st.cfg },
        devices: st.devices.map((v) => (v.key === key ? { ...v, allow: rec.allow } : v)),
    })
}

/** 忘记设备（只删配置记录；不删备份目录与 uback.txt） */
export function forgetDevice(key: string): void {
    const st = getState()
    if (!st.cfg.devices[key]) return
    delete st.cfg.devices[key]
    saveConfig(st.cfg)
    setState({ cfg: { ...st.cfg }, devices: st.devices.filter((v) => v.key !== key) })
}

/** 总开关（设置页/托盘同源） */
export function setAutoImport(on: boolean): void {
    const st = getState()
    st.cfg.autoImport = on
    saveConfig(st.cfg)
    setState({ cfg: { ...st.cfg } })
    glog('自动备份总开关: ' + (on ? '开' : '关'))
}

// ── 导入引擎 ──
interface FileItem {
    rel: string
    size: number
    mtime: bigint
    isDir: boolean
    needCopy: boolean
}

let activeJob: JobView | null = null

export function cancelImport(): void {
    if (activeJob && activeJob.running) activeJob.cancel = true
}

/** 手动「立即导入」：对指定设备（含无序列号盘） */
export function manualImport(key: string, drive: string): void {
    const st = getState()
    if (st.job.running || !drive) return
    const v = st.devices.find((d) => d.key === key && d.connected)
    if (!v) return
    void startImport({
        serial: v.serial, drive, vendor: v.vendor, product: v.product,
        label: v.label, capacity: v.capacity,
    })
}

async function scanSource(srcRoot: string, destDir: string, job: JobView): Promise<FileItem[]> {
    const items: FileItem[] = []
    const stack: { dir: string; rel: string }[] = [{ dir: srcRoot, rel: '' }]
    let n = 0
    while (stack.length) {
        const cur = stack.pop()!
        for (const e of wf.listDir(cur.dir)) {
            const rel = cur.rel ? cur.rel + '\\' + e.name : e.name
            if (e.isDir) {
                items.push({ rel, size: 0, mtime: e.mtime, isDir: true, needCopy: false })
                stack.push({ dir: cur.dir + '\\' + e.name, rel })
            } else {
                const d = wf.stat(destDir + '\\' + rel)
                const needCopy = !d || d.size !== e.size || e.mtime > d.mtime + TWO_SEC_100NS
                items.push({ rel, size: e.size, mtime: e.mtime, isDir: false, needCopy })
                if (needCopy) {
                    job.totalFiles++
                    job.totalBytes += e.size
                }
            }
            n++
            if (n % 512 === 0) {
                pushJob(job)
                await yieldTo()
            }
            if (job.cancel) return items
        }
    }
    return items
}

async function copyFile(src: string, dst: string, f: FileItem, job: JobView):
    Promise<{ ok: boolean; cancelled: boolean; err?: string }> {
    const part = dst + '.part'
    const srcH = wf.openRead(src)
    if (!srcH) return { ok: false, cancelled: false, err: '无法打开源文件' }
    const dstH = wf.openWrite(part)
    if (!dstH) {
        wf.close(srcH)
        return { ok: false, cancelled: false, err: '无法写入目标' }
    }
    const buf = new PtrArrayBuffer(CHUNK)
    let lastYield = 0
    try {
        for (;;) {
            if (job.cancel) {
                wf.close(srcH); wf.close(dstH); wf.removeFile(part)
                return { ok: false, cancelled: true }
            }
            const n = wf.read(srcH, buf, CHUNK)
            if (n === 0) break
            if (n < 0) {
                wf.close(srcH); wf.close(dstH); wf.removeFile(part)
                return { ok: false, cancelled: false, err: '读取失败' }
            }
            if (wf.write(dstH, buf, n) !== n) {
                wf.close(srcH); wf.close(dstH); wf.removeFile(part)
                return { ok: false, cancelled: false, err: '写入失败（空间不足？）' }
            }
            lastYield += n
            if (lastYield >= YIELD_EVERY) {
                lastYield = 0
                await yieldTo()
            }
        }
        // 保留源 mtime（FAT32 2s 粒度，源文件本身来自 U 盘）
        wf.setFileTime(dstH, f.mtime)
        wf.flush(dstH)
        wf.close(dstH)
        wf.close(srcH)
        wf.moveFileEx(part, dst, true)
        return { ok: true, cancelled: false }
    } catch {
        wf.close(dstH); wf.close(srcH); wf.removeFile(part)
        return { ok: false, cancelled: false, err: '复制异常' }
    }
}

let lastUi = 0
function pushJob(job: JobView): void {
    setState({ job: { ...job } })
}
function pushJobThrottled(job: JobView): void {
    const now = Date.now()
    if (now - lastUi >= 200) {
        lastUi = now
        setState({ job: { ...job } })
    }
}

export async function startImport(m: ImportMeta): Promise<void> {
    const st = getState()
    if (st.job.running) return
    const cfg = st.cfg
    const destDir = deviceDestDir(cfg, m)
    const job: JobView = {
        running: true, phase: 'scan', serial: m.serial, drive: m.drive, destDir,
        totalFiles: 0, doneFiles: 0, copied: 0, skipped: 0, failed: 0,
        bytesCopied: 0, totalBytes: 0, currentFile: '', error: '', cancel: false,
    }
    activeJob = job
    setState({ job: { ...job }, banner: '正在导入 ' + devName(m.vendor, m.product) + ' …' })

    const meta = { serial: m.serial, vendor: m.vendor, product: m.product, label: m.label, capacity: m.capacity }
    const txt = new DeviceTxt()
    const txtOk = txt.open(destDir, meta)
    if (txtOk) txt.start(m.drive)
    const t0 = Date.now()
    try {
        const files = await scanSource(m.drive + ':\\', destDir, job)
        if (job.cancel) {
            if (txtOk) txt.abort('中止（用户取消）')
            return
        }
        job.phase = 'copy'
        pushJob(job)
        for (const f of files) {
            if (job.cancel) {
                if (txtOk) txt.abort('中止（用户取消）')
                break
            }
            if (f.isDir) {
                wf.mkdirs(destDir + '\\' + f.rel)
                continue
            }
            job.currentFile = f.rel
            if (!f.needCopy) {
                job.skipped++
                job.doneFiles++
                pushJobThrottled(job)
                continue
            }
            const r = await copyFile(m.drive + ':\\' + f.rel, destDir + '\\' + f.rel, f, job)
            if (r.ok) {
                job.copied++
                job.bytesCopied += f.size
                if (txtOk) txt.copy(f.rel, f.size)
            } else if (!r.cancelled) {
                job.failed++
                if (txtOk) txt.fail(f.rel, f.size, r.err || '复制失败')
            }
            job.doneFiles++
            pushJobThrottled(job)
        }
    } finally {
        const secs = (Date.now() - t0) / 1000
        if (txtOk) txt.summary(job.copied, job.skipped, job.failed, job.bytesCopied, secs)
        txt.close()
        if (m.serial) {
            const r2 = cfg.devices[m.serial]
            if (r2) {
                r2.lastImport = Date.now()
                saveConfig(cfg)
                setState({ cfg: { ...cfg } })
            }
        }
        setState({ job: { ...job, running: false, phase: 'idle', currentFile: '' } })
        activeJob = null
        glog('导入结束 ' + (m.serial || '无序列号') + ': 复制 ' + job.copied + ' 跳过 ' + job.skipped +
            ' 失败 ' + job.failed + ' 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')
    }
}
