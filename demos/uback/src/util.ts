// util —— 散列/格式化小工具

/** FNV-1a 32 位 → 8 位小写 hex（设备目录名用，序列号哈希） */
export function hash8(s: string): string {
    let h = 0x811C9DC5
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = (h * 0x01000193) >>> 0
    }
    return ('00000000' + h.toString(16)).slice(-8)
}

/** 字节数 → 人类可读（"29.8 GB" / "3.4 MB" / "512 B"） */
export function fmtBytes(n: number): string {
    if (!isFinite(n) || n < 0) return '-'
    if (n < 1024) return Math.round(n) + ' B'
    const units = ['KB', 'MB', 'GB', 'TB', 'PB']
    let v = n
    let u = -1
    do { v /= 1024; u++ } while (v >= 1024 && u < units.length - 1)
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[u]
}

/** 字节数 → 原始整数 + 单位（日志用："2345678 B"） */
export function fmtBytesRaw(n: number): string {
    return Math.round(n) + ' B'
}

function pad2(n: number): string {
    return n < 10 ? '0' + n : String(n)
}

/** 本地时间 "YYYY-MM-DD HH:mm:ss"（日志/记录文件用） */
export function nowStr(): string {
    const d = new Date()
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}

/** 秒数 → "88s" / "1m30s" */
export function fmtSecs(s: number): string {
    s = Math.max(0, Math.round(s))
    if (s < 60) return s + 's'
    return Math.floor(s / 60) + 'm' + (s % 60) + 's'
}

/** 把路径非法字符替换为下划线（设备目录名用） */
export function sanitizeName(s: string): string {
    return s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'USB_DEVICE'
}
