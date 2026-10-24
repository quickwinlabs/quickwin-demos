// netif —— 局域网 IPv4 地址枚举
//
// 两条路：
// 1. primaryByRoute()：UDP socket connect(8.8.8.8:53) 后 getsockname——内核按路由表
//    选中的默认网卡，不实际发包。绝大多数有网环境一步到位。
// 2. adapterIps()：GetAdaptersInfo 遍历全部 IPv4（无外网路由时的回落，也用于地址栏
//    列出全部候选）。IP_ADAPTER_INFO 是变长结构链表，lib/windows 未封装 → 自 bind，
//    布局偏移按 MSDN 推演分架构写死（deskmon 的 MIB_IFTABLE 同手法），只取
//    IpAddressList 链。烟测时两路互验：primary 必须出现在 adapter 列表中。
import * as os from 'os'
import * as sock from 'sock'
import { bind } from 'quickwin/lib/ffi/bind.js'
import { PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'

// IP_ADAPTER_INFO 内我们需要的偏移/尺寸（x64 / ia32；字段对齐按自然边界）：
//   IpAddressList 在结构内偏移  x64=440  ia32=428
//   IP_ADDR_STRING 尺寸          x64=48   ia32=40（Next 指针 + IPAddress[16] + IpMask[16] + Context u32 + 尾对齐）
//   IPAddress char[16] 在链节点内偏移 x64=8 ia32=4
const IS64 = os.arch !== 'ia32'
const OFF_LIST = IS64 ? 440 : 428
const NODE_SIZE = IS64 ? 48 : 40
const OFF_NODE_IP = IS64 ? 8 : 4

const GetAdaptersInfo = bind('iphlpapi.dll', 'GetAdaptersInfo', '<>ptr <>ptr -> u32')

/** 默认路由网卡的本机 IPv4；无外网路由/失败 → null（connect 只做路由选定，不发包） */
export function primaryByRoute(): string | null {
    let s: NonNullable<ReturnType<typeof sock.socket>> | null = null
    try {
        s = sock.socket()
        if (s === null || s < 0) return null
        if (sock.connect(s, '8.8.8.8', 53) !== 0) return null
        const local = sock.getsockname(s)
        if (local && local.addr && local.addr !== '0.0.0.0') return local.addr
        return null
    } catch {
        return null
    } finally {
        try { if (s !== null) sock.closesocket(s) } catch { /* 忽略 */ }
    }
}

function ansi(dv: DataView, off: number): string {
    let s = ''
    for (let i = 0; i < 16; i++) {
        const c = dv.getUint8(off + i)
        if (c === 0) break
        s += String.fromCharCode(c)
    }
    return s
}

function keepIp(ip: string): boolean {
    return ip !== '' && ip !== '0.0.0.0' &&
        !ip.startsWith('127.') && !ip.startsWith('169.254.')
}

/** 全部适配器的 IPv4 列表；失败 → []（调用方至少还有 primaryByRoute） */
export function adapterIps(): string[] {
    const out: string[] = []
    try {
        // 16KB ≈ 26 个适配器（x64 608B/个），家用足够；超出按截断处理不扩容
        const buf = new PtrArrayBuffer(16384)
        const size = new PtrArrayBuffer(4)
        new DataView(size).setUint32(0, 16384, true)
        if (GetAdaptersInfo(buf.ptr, size.ptr) !== 0) return out
        const dv = new DataView(buf)
        const P = os.arch !== 'ia32' ? 8 : 4
        const readPtr = (off: number): number =>
            P === 4 ? dv.getUint32(off, true)
                    : dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 4294967296
        // 链表头节点就内联在缓冲起始（MSDN：pAdapterInfo 指向第一个 IP_ADAPTER_INFO）
        let node = 0
        for (let i = 0; i < 32 && node >= 0; i++) {
            // 遍历该适配器的 IpAddressList（单链）
            let ipNode = node + OFF_LIST
            for (let j = 0; j < 8; j++) {
                const ip = ansi(dv, ipNode + OFF_NODE_IP)
                if (keepIp(ip) && out.indexOf(ip) < 0) out.push(ip)
                const next = readPtr(ipNode)
                if (!next) break
                ipNode = next - buf.ptr   // Next 是绝对地址 → 缓冲内偏移
            }
            const nextAdapter = readPtr(node)
            if (!nextAdapter) break
            node = nextAdapter - buf.ptr
        }
    } catch { /* 取不到 → 空 */ }
    return out
}

/** 主地址（路由选定优先）+ 全部候选（去重）；至少返回一个元素，全失败 → ['127.0.0.1'] */
export function lanAddresses(): { primary: string; all: string[] } {
    const all = adapterIps()
    const primary = primaryByRoute()
    if (primary && all.indexOf(primary) < 0) all.unshift(primary)
    if (all.length === 0) return { primary: '127.0.0.1', all: ['127.0.0.1'] }
    return { primary: primary ?? all[0], all }
}
