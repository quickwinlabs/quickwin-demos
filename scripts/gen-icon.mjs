#!/usr/bin/env node
// 一次性工具：demos/<name>/icon.svg → 48×48 PNG（resvg 渲染）→ 单条目 .ico
// 用法：node scripts/gen-icon.mjs demos/<name>
// 产物 icon.ico 随仓库提交；build.ts 只读 icon.ico，CI 不跑本脚本。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const root = process.argv[2]
if (!root) {
    console.error('usage: node scripts/gen-icon.mjs demos/<name>')
    process.exit(1)
}
const SIZE = 48 // 单条目 48×48（Vista+ 全场景够用；PNG 存储，XP 不显示已接受）

const svg = readFileSync(join(root, 'icon.svg'), 'utf8')
const png = Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: SIZE } }).render().asPng())

// 单条目 ICO：ICONDIR(6) + ICONDIRENTRY(16) + PNG 数据
const ico = Buffer.alloc(6 + 16 + png.length)
ico.writeUInt16LE(0, 0)  // reserved
ico.writeUInt16LE(1, 2)  // type: 1 = icon
ico.writeUInt16LE(1, 4)  // count
ico.writeUInt8(SIZE, 6)  // width（0 = 256，此处 48）
ico.writeUInt8(SIZE, 7)  // height
ico.writeUInt8(0, 8)     // colors in palette（0 = 无调色板）
ico.writeUInt8(0, 9)     // reserved
ico.writeUInt16LE(1, 10) // planes
ico.writeUInt16LE(32, 12)// bitCount
ico.writeUInt32LE(png.length, 14) // data size
ico.writeUInt32LE(22, 18)         // data offset（6 + 16）
png.copy(ico, 22)

const out = join(root, 'icon.ico')
writeFileSync(out, ico)
console.log(`${out}: ${SIZE}x${SIZE} png ${png.length}B -> ico ${ico.length}B`)
