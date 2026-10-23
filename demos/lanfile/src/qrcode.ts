// qrcode —— lean-qr 包装：文本 → QR 位图（1px/模块，含静区）
//
// 依赖顺序：polyfill 先在 globalThis 挂 TextEncoder（运行时引擎无此全局，lean-qr
// 模块顶层就 new TextEncoder）。
//
// 用主入口而非 /nano：主入口带 toImageData()（nano 只有 toCanvas，要 canvas）。
// 主入口的默认 auto 模式表含 shift_jis，其惰性构造器 new TextDecoder('sjis') 超出
// polyfill 的 label 域；这里显式传 modes 把 shift_jis 排除——URL 全 ASCII，
// numeric/alphaNumeric/ascii 即可覆盖，utf8 仅作兜底。
import 'quickwin/lib/polyfill.js'
import { generate, mode } from 'lean-qr'

/** 库生成的位图（1px/模块，RGBA） */
export interface QrImage {
    width: number
    height: number
    data: Uint8ClampedArray
}

const MODES = [mode.numeric, mode.alphaNumeric, mode.ascii, mode.utf8]

/** 文本 → QR 位图；内容异常（超长等）抛错，调用方决定如何降级 */
export function makeQr(text: string, pad = 2): QrImage {
    const bmp = generate(text, { modes: MODES })
    return bmp.toImageData({
        createImageData: (w: number, h: number) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
        }),
        putImageData: () => { /* toImageData 只在 createImageData 里取缓冲，不需要回写 */ },
    }, {
        pad,
        // 默认 off 是透明黑（alpha=0），GDI 的 DDB 不看 alpha，整张会画成黑块；
        // 明写黑白两色，位图直接就是可 BitBlt 的 32bpp 像素。
        on: [0, 0, 0],
        off: [255, 255, 255],
    })
}
