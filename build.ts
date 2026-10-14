// 构建链：多 demo 版（唯一入口：npm run build）
//   扫描 demos/*/src/main.ts，每个 demo 依次走三阶段：
//   stage 1: TypeScript Compiler API —— 类型检查 + emit 到 .tsc-out/<name>/main.js
//            （const enum 在此内联为数字，esbuild 不解析 .d.ts，gui.WindowStyle.* 等枚举
//             引用靠这一步变成字面量）。自定义 resolveModuleNames 把 quickwin/* 钉在包内
//             .js 上：外来 JS 弱推断、不进语义检查，避免包内源码与本项目 tsconfig 干扰。
//   stage 2: esbuild —— bundle 成自包含 ESM 单文件（gui/std/os/ffi 等为运行时模块，external）
//   stage 3: embed —— brotli 压缩后追加进 exe 尾部（[exe][js][u32 len]["QWBR"]，
//            同主仓 scripts/embed-js.mjs 格式）
//
//   注：exe 图标盖章（resedit，见 icon.svg/icon.ico/scripts/gen-icon.mjs）曾实现于此，
//   因无签名 exe 被 Defender 云端 ML 误报（Trojan:Win32/Sabsik.TE.A!ml）暂缓；
//   资产与工具保留，待代码签名（如 SignPath OSS）落地后可恢复。
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
import ts from 'typescript'

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

// ── 共享：TS 编译器配置 ──
console.log('[1/3] tsc ...')
const cfg = ts.readConfigFile('tsconfig.json', ts.sys.readFile)
if (cfg.error) {
    console.error(ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n'))
    process.exit(1)
}
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, '.')
const options: ts.CompilerOptions = { ...parsed.options, allowJs: true }

function makeHost(): ts.CompilerHost {
    const host = ts.createCompilerHost(options)
    host.resolveModuleNames = (moduleNames, containingFile) =>
        moduleNames.map((name) => {
            if (name.startsWith('quickwin/')) {
                // 钉在包内 .js 上（name 自带 .js 后缀）；allowJs 下外来 JS 只做弱推断、不做语义检查
                return {
                    resolvedFileName: join('node_modules', name),
                    extension: ts.Extension.Js,
                    isExternalLibraryImport: true,
                }
            }
            return ts.resolveModuleName(name, containingFile, options, host).resolvedModule
        })
    return host
}

function tscOne(demo: string): string {
    const root = join(DEMOS_DIR, demo)
    const entryTs = join(root, 'src', 'main.ts')
    // 每个 demo 独立 program，避免跨 demo 的模块解析干扰
    const rootNames = [entryTs, 'node_modules/quickwin/quickwin.d.ts']
    const host = makeHost()
    const program = ts.createProgram(rootNames, options, host)
    const ownDiagnostics = ts
        .getPreEmitDiagnostics(program)
        .filter((d) => !d.file || d.file.fileName.replace(/\\/g, '/').includes('/demos/'))
    if (ownDiagnostics.length > 0) {
        console.error(ts.formatDiagnosticsWithColorAndContext(ownDiagnostics, {
            getCanonicalFileName: (f) => f,
            getCurrentDirectory: () => process.cwd(),
            getNewLine: () => '\n',
        }))
        throw new Error(`tsc failed for ${demo}`)
    }
    const emitResult = program.emit()
    if (emitResult.emitSkipped) throw new Error(`tsc: emit skipped for ${demo}`)
    // tsc 保持相对 rootDir 的路径 → .tsc-out/<demo>/src/main.js
    const entryJs = join('.tsc-out', demo, 'src', 'main.js')
    if (!existsSync(entryJs)) throw new Error(`tsc did not emit ${entryJs}`)
    return entryJs
}

for (const d of demos) tscOne(d)

// ── stage 2/3: esbuild bundle + brotli embed ──
console.log('[2/3] esbuild ...')
const RUNTIME_MODULES = ['gui', 'std', 'os', 'sock', 'win', 'ffi', 'wolfssl', 'brotli']
const EXE_SRC = 'node_modules/quickwin/qwin-nowasm-x86.exe'   // 无 WASM 最小体积；x86 兼容 XP
rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })

for (const d of demos) {
    const entryJs = join('.tsc-out', d, 'src', 'main.js')
    const jsOut = join('dist', `${d}.js`)
    const exeOut = join('dist', `${d}.exe`)
    const result = await build({
        entryPoints: [entryJs],
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

    console.log('[3/3] embed ...')
    const exe = readFileSync(EXE_SRC)
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

// ── stage 4: 组装 dist-pages ──
console.log('[4/4] pages ...')
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
