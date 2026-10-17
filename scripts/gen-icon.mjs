#!/usr/bin/env node
// 一次性工具：demos/<name>/icon.svg → 多条目 .ico
// 用法：node scripts/gen-icon.mjs demos/<name>
// 条目策略：16/24/32/48 用 32bpp BMP（+ AND 掩码，XP 起的系统全认）；64/128/256 用 PNG（Vista+）
// 小尺寸各自独立渲染（不是拿 48px 缩），托盘/资源管理器不再糊。
// 产物 icon.ico 随仓库提交；build.ts 只读 icon.ico，CI 不跑本脚本。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const root = process.argv[2]
if (!root) {
    console.error('usage: node scripts/gen-icon.mjs demos/<name>')
    process.exit(1)
}

const BMP_SIZES = [16, 24, 32, 48]   // XP 只认 BMP 条目（且 ≤48）
const PNG_SIZES = [64, 128, 256]     // Vista+ 认 PNG 条目

const svg = readFileSync(join(root, 'icon.svg'), 'utf8')
const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render()

// 32bpp BMP 条目：BITMAPINFOHEADER(biHeight = 2×h) + BGRA 行（自下而上）+ AND 掩码（全 0，透明靠 alpha）
function bmpOf(r) {
    const w = r.width, h = r.height
    const px = r.pixels
    const xor = Buffer.alloc(w * h * 4)
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const s = ((h - 1 - y) * w + x) * 4   // 源自顶向下，BMP 自下而上
            const d = (y * w + x) * 4
            xor[d] = px[s + 2]      // B
            xor[d + 1] = px[s + 1]  // G
            xor[d + 2] = px[s]      // R
            xor[d + 3] = px[s + 3]  // A
        }
    }
    const mask = Buffer.alloc(Math.ceil(w / 32) * 4 * h)
    const ih = Buffer.alloc(40)
    ih.writeUInt32LE(40, 0)          // biSize
    ih.writeInt32LE(w, 4)            // biWidth
    ih.writeInt32LE(h * 2, 8)        // biHeight（XOR + AND）
    ih.writeUInt16LE(1, 12)          // biPlanes
    ih.writeUInt16LE(32, 14)         // biBitCount
    return Buffer.concat([ih, xor, mask])   // biCompression 等字段留 0（BI_RGB）
}

const entries = [
    ...BMP_SIZES.map((size) => ({ size, data: bmpOf(render(size)) })),
    ...PNG_SIZES.map((size) => ({ size, data: render(size).asPng() })),
]

// ICONDIR(6) + ICONDIRENTRY[](16×N) + 数据区
const dir = Buffer.alloc(6 + entries.length * 16)
dir.writeUInt16LE(0, 0)                  // reserved
dir.writeUInt16LE(1, 2)                  // type: 1 = icon
dir.writeUInt16LE(entries.length, 4)     // count
let offset = 6 + entries.length * 16
entries.forEach(({ size, data }, i) => {
    const e = 6 + i * 16
    const dim = size >= 256 ? 0 : size   // 256 记作 0
    dir.writeUInt8(dim, e)               // width
    dir.writeUInt8(dim, e + 1)           // height
    dir.writeUInt8(0, e + 2)             // colors in palette
    dir.writeUInt8(0, e + 3)             // reserved
    dir.writeUInt16LE(1, e + 4)          // planes
    dir.writeUInt16LE(32, e + 6)         // bitCount
    dir.writeUInt32LE(data.length, e + 8)// data size
    dir.writeUInt32LE(offset, e + 12)    // data offset
    offset += data.length
})

const ico = Buffer.concat([dir, ...entries.map((e) => e.data)])
const out = join(root, 'icon.ico')
writeFileSync(out, ico)
console.log(`${out}: ${entries.map((e) => e.size + 'px').join('/')} ` +
    entries.map((e) => `${e.size}:${e.data.length}B`).join(' ') + ` -> ico ${ico.length}B`)
