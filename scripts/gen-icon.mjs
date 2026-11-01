#!/usr/bin/env node
// demos/<name>/icon.svg → 多条目 .ico（build.ts 在 icon.ico 缺失时也会调用它）
// 用法：node scripts/gen-icon.mjs demos/<name> [out.ico]   （缺省输出 demos/<name>/icon.ico）
// 条目策略（最小体积）：16 用 32bpp BMP（XP 只认 BMP，托盘/任务栏小图标）；32/256 用 PNG（Vista+）
// 32px = 任务栏大图标 / Explorer 中图标；256px 供高 DPI / 超大图标（48 由 256 缩小替代，质量无损）。
// 64/128 系统不主动请求，省略。
// 各尺寸默认由 icon.svg 缩放；如某尺寸需要专用稿，可放 icon-<size>.svg 覆盖。
// icon.ico 是构建产物：build.ts 缺失时现场生成到 dist/，仓库不提交。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const root = process.argv[2]
if (!root) {
    console.error('usage: node scripts/gen-icon.mjs demos/<name> [out.ico]')
    process.exit(1)
}
const out = process.argv[3] || join(root, 'icon.ico')

const BMP_SIZES = [16]                   // XP 只认 BMP 条目；16px 覆盖托盘/任务栏小图标
const PNG_SIZES = [32, 256]               // Vista+ 认 PNG；32=任务栏大图标，256=高 DPI（48 由 256 缩小）

const svg = readFileSync(join(root, 'icon.svg'), 'utf8')
// 可选：icon-<size>.svg 覆盖母版（无则用母版缩）
const svgFor = (size) => {
    const p = join(root, `icon-${size}.svg`)
    return existsSync(p) ? readFileSync(p, 'utf8') : svg
}
const render = (size) => new Resvg(svgFor(size), { fitTo: { mode: 'width', value: size } }).render()

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
writeFileSync(out, ico)
console.log(`${out}: ${entries.map((e) => e.size + 'px').join('/')} ` +
    entries.map((e) => `${e.size}:${e.data.length}B`).join(' ') + ` -> ico ${ico.length}B`)
