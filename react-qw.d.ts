// react-qw 的 <w> 元素类型声明（让本仓的 .tsx 能直接写 <w type="STATIC">）。
//
// 快速说明为什么这里要再声明一次：quickwin 包内 lib/react-qw/jsx.d.ts 已经有同名增强，
// 但那份 `declare module 'react'` 是按 jsx.d.ts 自身的位置解析 'react' 的。本仓把 quickwin
// 软链成主仓的工作树（node_modules/quickwin -> ../../dist/quickwin），TS 解引用软链后
// 真实路径落在主仓里，'react' 于是解析到主仓自己的 @types/react —— 增强写在了本仓用不到
// 的那一份上。在本仓声明一次后两边都成立；换成正式发布包（quickwin 在 node_modules 内）
// 时两份增强落到同一个 @types/react，声明完全相同，合并不冲突。
import type { WIntrinsicProps } from 'quickwin/lib/react-qw/jsx.js'

declare module 'react' {
    namespace JSX {
        interface IntrinsicElements {
            w: WIntrinsicProps
        }
    }
}
