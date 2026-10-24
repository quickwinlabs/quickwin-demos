// server —— HttpServer 路由：列表页 / 流式下载 / 裸 PUT 上传
//
// 路由：
//   GET  /          手机端列表页（内联 CSS/JS，无外链资源）：文件链接 + 上传区
//   GET  /f/<id>    流式下载（64KB 块）；单区间 Range（手机浏览器预览视频必需）；
//                   Content-Disposition 带 RFC 5987 filename*（中文文件名不乱码）
//   PUT  /up?name=<相对路径>   手机→电脑上传：req.body（ReadableStream）直接管道
//                   写盘，不整包缓冲，GB 级安全。页面端用 fetch PUT（File 作 body），
//                   甩开 multipart 解析——两端都是自己的，无兼容包袱。
import { PtrArrayBuffer } from 'quickwin/lib/ffi/ctype.js'
import 'quickwin/lib/polyfill.js'   // URL / URLSearchParams / TextEncoder（上传路径解析、写配置）
import { createServer } from 'quickwin/lib/http-server.js'
import type { ServerHandler } from 'quickwin/lib/http-server.js'
import * as shares from './shares.js'
import * as wfile from './wfile.js'

const CHUNK = 65536

export let uploadDir = ''   // 启动时 setUploadDir 注入（配置里的 uploads，缺省 exe 同级）；
                            // UI 上换目录也会再次注入，server 立即改走新目录

export function setUploadDir(dir: string): void {
    uploadDir = dir
    wfile.mkdirs(uploadDir)
}

// ── 小工具 ──

function fmtSize(n: number): string {
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
    return n + ' B'
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Content-Disposition：ASCII 回退 + RFC 5987 filename*（非 ASCII 保真） */
function disposition(name: string): string {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name)
}

/** 上传相对路径清洗：拒绝对路径/盘符/..；段间统一反斜杠。非法 → '' */
function sanitizeRel(raw: string): string {
    if (!raw || raw.startsWith('/') || raw.startsWith('\\')) return ''
    const parts = raw.split(/[\\/]+/).filter((p) => p !== '' && p !== '.')
    if (parts.length === 0) return ''
    for (const p of parts) {
        if (p === '..' || /^[a-zA-Z]:$/.test(p)) return ''
    }
    return parts.join('\\')
}

// ── 列表页 ──

function listHtml(): Response {
    const items = shares.all()
    const lis = items.map((e) =>
        '<li><a href="/f/' + e.id + '">' + esc(e.rel) + '</a><span>' + fmtSize(e.size) + '</span></li>'
    ).join('')
    const listBody = items.length > 0
        ? '<ul>' + lis + '</ul>'
        : '<p class="empty">电脑端还没有共享文件——但你现在就可以往下面传。</p>'
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>lanfile</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0 auto;max-width:640px;padding:16px;color:#222}
h2{margin:8px 0 4px} .sub{color:#888;font-size:13px;margin:0 0 16px}
.card{border:1px solid #ddd;border-radius:10px;padding:14px;margin-bottom:16px}
.hint{font-size:13px;color:#666;margin:6px 0}
input[type=file]{width:100%;margin:4px 0}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:15px;margin-top:8px}
button:disabled{background:#9db8e8}
#status{font-size:13px;margin-top:8px;color:#444;white-space:pre-line}
ul{list-style:none;padding:0;margin:0}
li{display:flex;justify-content:space-between;gap:12px;padding:10px 2px;border-bottom:1px solid #eee}
li span{color:#888;white-space:nowrap}
a{color:#2563eb;text-decoration:none;word-break:break-all}
.empty{color:#999;font-size:14px;text-align:center;padding:18px 0}
</style>
</head>
<body>
<h2>lanfile</h2>
<p class="sub">同一 Wi-Fi 内的文件直传 · 不经外网</p>
<div class="card">
  <b>发送到电脑</b>
  <p class="hint">选择文件（安卓可整文件夹；iPhone 支持多选照片）</p>
  <input type="file" id="fpick" multiple>
  <input type="file" id="dpick" webkitdirectory multiple>
  <button id="send" disabled>开始上传</button>
  <div id="status"></div>
</div>
<div class="card">
  <b>从电脑接收</b>
  ${listBody}
</div>
<script>
var fp = document.getElementById('fpick')
var dp = document.getElementById('dpick')
var btn = document.getElementById('send')
var st = document.getElementById('status')
var queue = []
function collect() {
  queue = [].slice.call(fp.files).concat([].slice.call(dp.files))
  btn.disabled = queue.length === 0
  st.textContent = queue.length ? '已选 ' + queue.length + ' 个文件' : ''
}
fp.onchange = dp.onchange = collect
btn.onclick = function () {
  btn.disabled = true
  var i = 0, fail = 0
  function next() {
    if (i >= queue.length) {
      st.textContent = '完成：' + (queue.length - fail) + ' 成功' + (fail ? '，' + fail + ' 失败' : '')
      fp.value = dp.value = ''
      collect()
      return
    }
    var f = queue[i]
    st.textContent = '上传中 (' + (i + 1) + '/' + queue.length + ')：' + f.name
    var rel = (f.webkitRelativePath && f.webkitRelativePath) || f.name
    fetch('up?name=' + encodeURIComponent(rel), { method: 'PUT', body: f })
      .then(function (r) { if (!r.ok) fail++; i++; next() })
      .catch(function () { fail++; i++; next() })
  }
  next()
}
</script>
</body>
</html>`
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

// ── 下载 ──

function download(id: number, range: string | null, headOnly: boolean): Response {
    const e = shares.get(id)
    if (!e) return new Response('not found', { status: 404 })
    const fd = wfile.openRead(e.abs)
    if (!fd) return new Response('cannot open', { status: 404 })
    const size = e.size

    let start = 0, end = size - 1, partial = false
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
    if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') {          // bytes=-N：末尾 N 字节
            const n = parseInt(m[2], 10)
            start = size > n ? size - n : 0
            end = size - 1
        } else {
            start = parseInt(m[1], 10)
            end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1)
        }
        if (size === 0 || start >= size || start > end) {
            wfile.close(fd)
            return new Response('range not satisfiable', {
                status: 416,
                headers: { 'Content-Range': 'bytes */' + size },
            })
        }
        partial = true
    }
    const len = end - start + 1

    const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': disposition(e.rel),
        'Accept-Ranges': 'bytes',
        'Content-Length': String(len),
    }
    if (partial) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size

    if (headOnly) {
        wfile.close(fd)
        return new Response(null, { status: partial ? 206 : 200, headers })
    }
    if (len === 0) {
        wfile.close(fd)
        return new Response(null, { status: partial ? 206 : 200, headers })
    }

    if (start > 0) wfile.seek(fd, start)
    let pos = start
    let closed = false
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (closed || pos > end) {
                controller.close()
                return
            }
            const want = Math.min(CHUNK, end - pos + 1)
            const buf = new PtrArrayBuffer(want)
            const n = wfile.read(fd, buf, want)
            if (n <= 0) {
                closed = true
                wfile.close(fd)
                controller.close()
                return
            }
            pos += n
            // n < want 时按实际读取数截断（尾块）
            controller.enqueue(n === want
                ? new Uint8Array(buf)
                : new Uint8Array(buf.slice(0, n)))
        },
        cancel() {
            if (!closed) {
                closed = true
                wfile.close(fd)   // 客户端断开/中止：立即释放句柄
            }
        },
    })
    return new Response(body, { status: partial ? 206 : 200, headers })
}

// ── 上传 ──

async function upload(name: string | null, req: Request): Promise<Response> {
    const rel = sanitizeRel(name ?? '')
    if (rel === '') return new Response('bad name', { status: 400 })
    if (!req.body) return new Response('no body', { status: 400 })
    const abs = uploadDir + '\\' + rel
    const dir = abs.slice(0, abs.lastIndexOf('\\'))
    try { wfile.mkdirs(dir) } catch { /* open 时再报错 */ }
    const fd = wfile.openWrite(abs)
    if (!fd) return new Response('cannot write', { status: 500 })
    const reader = req.body.getReader()
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value || value.length === 0) continue
            const u8: Uint8Array = value
            let off = 0
            while (off < u8.byteLength) {
                const buf = new PtrArrayBuffer(u8.byteLength - off)
                new Uint8Array(buf).set(u8.subarray(off))
                const n = wfile.write(fd, buf, buf.byteLength)
                if (n <= 0) throw new Error('write failed')
                off += n
            }
        }
    } catch (e) {
        try { wfile.close(fd); wfile.removeFile(abs) } catch { /* 半截文件清理，尽力 */ }
        return new Response('upload failed', { status: 500 })
    }
    wfile.close(fd)
    return new Response('ok', { status: 201 })
}

// ── 路由 ──

export function buildHandler(): ServerHandler {
    return async (req) => {
        try {
            const u = new URL(req.url, 'http://lanfile/')
            const path = u.pathname
            if (req.method === 'GET' || req.method === 'HEAD') {
                if (path === '/' || path === '') return listHtml()
                const m = /^\/f\/(\d+)$/.exec(path)
                if (m) return download(parseInt(m[1], 10),
                    req.headers.get('range'), req.method === 'HEAD')
            }
            if (req.method === 'PUT' && (path === '/up' || path === '/up/')) {
                return await upload(u.searchParams.get('name'), req)
            }
            return new Response('not found', { status: 404 })
        } catch (e) {
            return new Response('error: ' + String(e), { status: 500 })
        }
    }
}

export function startServer(port: number): { port: number; fallback: boolean } {
    const server = createServer(buildHandler())
    let real = server.listen(port) === 0 ? port : -1
    let fallback = false
    if (real < 0) {
        // 端口被占（多半是另一个 lanfile）→ 系统分配
        if (server.listen(0) === 0) {
            real = server.address()?.port ?? -1
            fallback = true
        }
    }
    if (real < 0) throw new Error('listen failed')
    return { port: real, fallback }
}
