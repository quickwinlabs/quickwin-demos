// timer-shim.ts —— 供 esbuild `--inject` 使用的定时器 shim。
//
// 为什么需要它（顺序坑，务必保留注释）：
// React 调度器在**模块初始化**时就把定时器抓成常量：
//     x2 = typeof setTimeout=="function" ? setTimeout : null    // 之后靠 x2(Qf,0) 触发首次 commit
// 而 `react` / `react-reconciler` 的模块体在 bundle 里排在 `lib/polyfill.js` **之前** ——
// esbuild 的模块排序不受入口 import 顺序控制（`import 'quickwin/lib/polyfill.js'` 写第一行也没用）。
// 于是 x2 抓到的是 null，首次 commit 在 `x2(Qf,0)` 处抛错，被 reconciler 的错误边界接住、
// 打成 console.log —— 无控制台的 exe 里 console.log 静默丢弃，
// 最终表现是「窗口开了、标题正常，但一个子窗都不建」。
//
// `--inject` 会把本文件作为**依赖**插进每个引用了未声明标识符的模块顶部，esbuild 还把本模块体
// 包成惰性 thunk 并在引用方模块开头调用，于是这些导出必然先于引用它们的模块体求值。
// 顺带把「任何库在自身初始化时抓裸标识符 setTimeout」的情况一并修好。
//
// 两个约定：
//   1. 本文件里不要写任何顶层副作用（尤其不要 `import 'quickwin/lib/polyfill.js'`）——
//      惰性 thunk 会把顶层语句推迟到调用点，副作用 import 的时机不可控。
//   2. globalThis 层面的定时器兜底仍由 lib/polyfill.js 负责（它同时管 TextEncoder / URL / window）；
//      本文件只管「让裸标识符有值」。两边都桥接到 os.setTimeout，实现等价、无冲突。
import * as os from 'os'

type Callback = (...args: unknown[]) => void
type SetTimeoutFn = (fn: Callback, ms?: number, ...args: unknown[]) => number
type ClearTimeoutFn = (id: number) => void

export const setTimeout: SetTimeoutFn = (fn, ms, ...args) => os.setTimeout(() => fn(...args), ms ?? 0)

export const clearTimeout: ClearTimeoutFn = (id) => os.clearTimeout(id)
