# quickwin-demos

基于 [quickwin](https://github.com/quickwinlabs/quickwin) 的桌面实用工具合集 —— TypeScript 写、
一个 `.exe` 交。每次 push 由 GitHub Actions 构建单文件 exe 并部署
[GitHub Pages](https://quickwinlabs.github.io/quickwin-demos/) 下载页。

## 目录结构

```
demo.d/
├── demos/                    # 每个 demo 一个目录
│   └── deskmon/
│       ├── src/              # TypeScript 源码（入口固定为 main.ts）
│       │   ├── main.ts
│       │   └── icons.ts
│       ├── screenshots/      # 页面用截图
│       │   ├── win11.png
│       │   ├── win7.png
│       │   └── xp.png
│       └── page.html         # 详情页模板（构建时复制到 pages/<name>/index.html）
├── pages/                    # 聚合首页（手写，加 demo 时改这里）
│   ├── index.html
│   └── .nojekyll
├── build.ts                  # 构建链：遍历 demos/*，产出 dist/<name>.exe + dist-pages/
├── dist/                     # 构建产物（不入库，由 .gitignore 忽略）
├── dist-pages/               # 组装后的 GitHub Pages 上传根（不入库）
├── tsconfig.json
├── package.json
└── .github/workflows/ci.yml
```

## 新增 demo

1. 新建目录 `demos/<name>/`，里面放 `src/main.ts`（入口文件名固定）、
   可选的 `src/` 其它文件、`screenshots/`、`page.html`
2. `pages/index.html` 加一张卡片，链接到 `href="<name>/"`
3. `npm run build` 会自动：
   - `tsc`（noEmit 类型检查，覆盖 `demos/` 全部 .ts）通过后，遍历 `demos/*/src/main.ts`
     依次 esbuild → brotli embed，产出 `dist/<name>.exe`
   - 复制 `pages/index.html`、各 `demos/<name>/page.html`（→ `dist-pages/<name>/index.html`）、
     `screenshots/`、`dist/<name>.exe` 到 `dist-pages/`
4. push 触发 CI，GitHub Pages 部署 `dist-pages/`

## 构建链

`npm run build` = `tsc && node build.ts`。类型检查由 tsc 独立完成（tsconfig 已 `noEmit`，
只报错、不产出 JS），`build.ts` 只负责打包与产物组装：

1. **esbuild**：bundle 成自包含 ESM 单文件，`gui` / `std` / `os` / `ffi` 等运行时模块 `external`
   （QuickJS 运行时提供的原生模块，保留 `import` 语句由 runtime 解析）。`const enum` 内联由
   esbuild 自己完成（`quickwin/constants` 是真 `.ts` 源，可见定义即内联为字面量），无需 tsc emit 中转
2. **embed**：brotli 压缩后追加到 `qwin-nowasm-x86.exe` 尾部，尾部结构
   `[exe][js][u32 len]["QWBR"]`（同主仓 `scripts/embed-js.mjs` 格式）
3. **pages**：组装 `dist-pages/`

## 运行

```bash
npm install
npm run build
# 产物：dist/<name>.exe（单文件，Windows XP+ 32 位）
```

## 许可

各 demo 源码遵循 quickwin 主仓许可（见 <https://github.com/quickwinlabs/quickwin/blob/main/LICENSE>）。
个别 demo 可能引入第三方资源（如 deskmon 的 Vitals 图标，GPL-3.0），
以各 demo 目录内的注释和页面声明为准。
