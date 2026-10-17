// 构建链：多 demo 版（唯一入口：npm run build = tsc && node build.ts）
//   类型检查交给 npm 脚本里的 tsc（tsconfig.json 已 noEmit，不产出任何 JS）：
//   覆盖 demos/ 全部 .ts，报错即中止；本脚本只做打包与产物组装：
//   stage 1: esbuild —— 直接 bundle demos/*/src/main.ts 成自包含 ESM 单文件（gui/std/os/ffi
//            等运行时模块 external）。const enum 内联由 esbuild 自己完成（constants.ts 是
//            真 .ts 源，≥0.21 可见定义即内联为字面量），无需 tsc emit 中转。
//   stage 2: embed —— brotli 压缩后追加进 exe 尾部（[exe][js][u32 len]["QWBR"]，
//            同主仓 scripts/embed-js.mjs 格式）
//   stage 3: pages —— 组装 dist-pages/
//
//   注：exe 图标盖章（resedit，见 demos/<name>/icon.ico 与 scripts/gen-icon.mjs）曾因无签名 exe
//   被 Defender 云端 ML 误报（Trojan:Win32/Sabsik.TE.A!ml）而暂缓；2026-10-17 用当年发布的原始
//   字节在 win11 CI 镜像复测（现代定义库 + 实时保护开 + MOTW 扫描/执行）未再触发，故恢复。
//   仍建议尽早落地代码签名（如 SignPath OSS）以降低机器学习侧的信誉风险。
//
//   同时组装 GitHub Pages：
//     dist-pages/                       ← _pages 上传根
//       index.html                      ← 从 pages/index.html 复制
//       .nojekyll
//       <name>/
//         index.html                    ← 从 demos/<name>/page.html 复制
//         screenshots/*.png             ← 从 demos/<name>/screenshots/ 复制
//       <name>.exe                      ← 从 dist/<name>.exe 复制
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, cpSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { brotliCompressSync, constants as zc } from 'node:zlib'
import { build } from 'esbuild'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'

// ── 枚举 demos ──
const DEMOS_DIR = 'demos'
if (!existsSync(DEMOS_DIR)) {
    console.error(`no ${DEMOS_DIR}/ directory`)
    process.exit(1)
}
const demos = readdirSync(DEMOS_DIR).filter((n) => {
    const p = join(DEMOS_DIR, n)
    return statSync(p).isDirectory() && existsSync(join(p, 'src', 'main.ts'))
})
if (demos.length === 0) {
    console.error(`no demos found under ${DEMOS_DIR}/*/src/main.ts`)
    process.exit(1)
}
console.log(`found demos: ${demos.join(', ')}`)

// ── stage 1/2: esbuild bundle + brotli embed ──
console.log('[1/3] esbuild ...')
const RUNTIME_MODULES = ['gui', 'std', 'os', 'sock', 'win', 'ffi', 'wolfssl', 'brotli']
const EXE_SRC = 'node_modules/quickwin/qwin-nowasm-x86.exe'   // 无 WASM 最小体积；x86 兼容 XP
rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })

for (const d of demos) {
    // 直接从 .ts 源打包（esbuild 原生支持 TS；const enum 内联、.js→.ts 回退解析都由它完成）
    const entryTs = join(DEMOS_DIR, d, 'src', 'main.ts')
    const jsOut = join('dist', `${d}.js`)
    const exeOut = join('dist', `${d}.exe`)
    const result = await build({
        entryPoints: [entryTs],
        bundle: true,
        format: 'esm',          // 产物保留 `import * as gui from "gui"`；CJS 会在运行时报 Dynamic require
        outfile: jsOut,
        external: RUNTIME_MODULES,
        target: 'es2020',
        legalComments: 'none',
        write: false,
    })
    const jsBytes = result.outputFiles![0].contents
    writeFileSync(jsOut, jsBytes)

    console.log('[2/3] embed ...')
    let exe = readFileSync(EXE_SRC)
    const iconPath = join(DEMOS_DIR, d, 'icon.ico')
    if (existsSync(iconPath)) {
        // resedit 盖图标；必须在嵌 JS 前——resedit 重写 PE 不保留尾部数据
        const plainLen = exe.length
        const pe = NtExecutable.from(exe)
        const res = NtExecutableResource.from(pe)
        const iconFile = Data.IconFile.from(readFileSync(iconPath))
        Resource.IconGroupEntry.replaceIconsForResource(
            res.entries,
            101,       // RT_ICON_GROUP ID（底座无现成图标，资源不存在时自动追加）
            1033,      // en-US
            iconFile.icons.map((i) => i.data),
        )
        res.outputResource(pe)
        exe = Buffer.from(pe.generate())
        console.log(`  icon: ${iconPath} (${iconFile.icons.length} item, +${exe.length - plainLen}B)`)
    }
    const packed = brotliCompressSync(jsBytes, {
        params: {
            [zc.BROTLI_PARAM_MODE]: zc.BROTLI_MODE_TEXT,
            [zc.BROTLI_PARAM_QUALITY]: zc.BROTLI_MAX_QUALITY,
            [zc.BROTLI_PARAM_LGWIN]: zc.BROTLI_MAX_WINDOW_BITS,
        },
    })
    const out = Buffer.alloc(exe.length + packed.length + 8)
    exe.copy(out, 0)
    packed.copy(out, exe.length)
    out.writeUInt32LE(packed.length, exe.length + packed.length)
    out.write('QWBR', exe.length + packed.length + 4, 'ascii')
    writeFileSync(exeOut, out)
    console.log(`  ${d}: ${EXE_SRC} + ${jsBytes.length}B js -> brotli ${packed.length}B -> ${exeOut} (${out.length}B)`)
}

// ── stage 3: 组装 dist-pages ──
console.log('[3/3] pages ...')
const PAGES_SRC = 'pages'
const PAGES_OUT = 'dist-pages'
rmSync(PAGES_OUT, { recursive: true, force: true })
mkdirSync(PAGES_OUT, { recursive: true })

// 首页 + .nojekyll
if (existsSync(PAGES_SRC)) {
    cpSync(PAGES_SRC, PAGES_OUT, { recursive: true })
}
// 每个 demo 详情页 + 截图 + exe
for (const d of demos) {
    const outDir = join(PAGES_OUT, d)
    mkdirSync(outDir, { recursive: true })
    const pageSrc = join(DEMOS_DIR, d, 'page.html')
    if (existsSync(pageSrc)) {
        copyFileSync(pageSrc, join(outDir, 'index.html'))
    } else {
        console.warn(`  skip ${pageSrc} (missing)`)
    }
    const shotsSrc = join(DEMOS_DIR, d, 'screenshots')
    if (existsSync(shotsSrc)) {
        cpSync(shotsSrc, join(outDir, 'screenshots'), { recursive: true })
    }
    copyFileSync(join('dist', `${d}.exe`), join(PAGES_OUT, `${d}.exe`))
    console.log(`  ${PAGES_OUT}/${d}/ (page.html + screenshots + ${d}.exe)`)
}
