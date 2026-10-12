// deskmon 构建链（唯一入口：npm run build）
//   stage 1: TypeScript Compiler API —— 类型检查 + emit 到 .tsc-out（const enum 在此内联为
//            数字，esbuild 不解析 .d.ts，gui.WindowStyle.* 等枚举引用靠这一步变成字面量）。
//            自定义 resolveModuleNames 把 quickwin/* 钉在包内 .js（而非 .ts 源）上：
//            外来 JS 弱推断、不进语义检查，避免包内源码与本项目 tsconfig 相互干扰。
//   stage 2: esbuild —— bundle 成自包含 ESM 单文件（gui/std/os/ffi 等为运行时模块，external）
//   stage 3: embed —— brotli 压缩后追加进 exe 尾部（[exe][js][u32 len]["QWBR"]，同主仓 scripts/embed-js.mjs 格式）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants as zc } from 'node:zlib'
import { build } from 'esbuild'
import ts from 'typescript'

// ── stage 1: tsc（Compiler API）──
console.log('[1/3] tsc ...')
const cfg = ts.readConfigFile('tsconfig.json', ts.sys.readFile)
if (cfg.error) {
    console.error(ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n'))
    process.exit(1)
}
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, '.')
const options: ts.CompilerOptions = { ...parsed.options, allowJs: true }

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

const rootNames = [...parsed.fileNames, 'node_modules/quickwin/quickwin.d.ts']
const program = ts.createProgram(rootNames, options, host)
// 只让本项目源码的错误阻塞构建；外来依赖即使有噪音也不拦（emit 照常，const enum 内联不受影响）
const ownDiagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => !d.file || d.file.fileName.replace(/\\/g, '/').includes('/src/'))
if (ownDiagnostics.length > 0) {
    console.error(ts.formatDiagnosticsWithColorAndContext(ownDiagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
    }))
    process.exit(1)
}
const emitResult = program.emit()
if (emitResult.emitSkipped) {
    console.error('tsc: emit skipped')
    process.exit(1)
}

// ── stage 2: esbuild bundle ──
console.log('[2/3] esbuild ...')
// QuickJS 运行时提供的原生模块（bundle 保留 import 语句，运行时由 runtime 解析）
const RUNTIME_MODULES = ['gui', 'std', 'os', 'sock', 'win', 'ffi', 'wolfssl', 'brotli']
const js = await build({
    entryPoints: ['.tsc-out/deskmon.js'],
    bundle: true,
    format: 'esm',          // 产物保留 `import * as gui from "gui"`；CJS 格式会在运行时报 Dynamic require
    outfile: 'dist/deskmon.js',
    external: RUNTIME_MODULES,
    target: 'es2020',
    legalComments: 'none',
    write: false,
})
const jsBytes = js.outputFiles![0].contents
mkdirSync('dist', { recursive: true })   // dist/ 不入库，干净 checkout 里不存在
writeFileSync('dist/deskmon.js', jsBytes)

// ── stage 3: brotli + embed ──
console.log('[3/3] embed ...')
const exeSrc = 'node_modules/quickwin/qwin-nowasm-x86.exe'   // 无 WASM 最小体积；x86 兼容 XP
const exeOut = 'dist/deskmon.exe'
const exe = readFileSync(exeSrc)
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
console.log(`done: ${exeSrc} + ${jsBytes.length}B js -> brotli ${packed.length}B -> ${exeOut} (${out.length}B)`)
