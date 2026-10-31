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
import * as texts from './texts.js'
import * as wfile from './wfile.js'

const CHUNK = 65536
const TEXT_MAX = 64 * 1024   // 共享文字上限（64KB），超出返回 413

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
        '<li><label><input type="checkbox" class="dl" data-id="' + e.id
        + '" data-rel="' + esc(e.rel) + '"></label>'
        + '<a href="/f/' + e.id + '">' + esc(e.rel) + '</a><span>' + fmtSize(e.size) + '</span></li>'
    ).join('')
    const listBody = items.length > 0
        ? '<ul>' + lis + '</ul>'
        : '<p class="empty">电脑端还没有共享文件——但你现在就可以往下面传。</p>'
    // 当前文字直出首屏：无 JS / 轮询失败（如 IE 无 fetch）时也能看到内容
    const curText = texts.get().text
    const curTs = texts.get().ts
    const textBody = curText
        ? esc(curText)
        : '<span class="empty">（暂无文字）</span>'
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
.dlbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:4px;font-size:14px}
.dlbar button{width:auto;padding:7px 16px;font-size:13px;margin-top:0}
li input[type=checkbox]{margin-right:4px;vertical-align:middle}
.tbox{white-space:pre-wrap;word-break:break-word;background:#f7f7f8;border:1px solid #eee;border-radius:8px;padding:10px;min-height:40px;max-height:180px;overflow:auto;font-size:14px;line-height:1.5}
.tbox .empty{padding:0;text-align:left}
textarea{width:100%;box-sizing:border-box;margin:8px 0 0;padding:8px;border:1px solid #ccc;border-radius:8px;font:inherit;resize:vertical}
</style>
</head>
<body>
<h2>lanfile</h2>
<p class="sub">同一 Wi-Fi 内的文件直传 · 不经外网</p>
<div class="card">
  <b>文字同步</b>
  <p class="hint">电脑端「文字」页签里的内容，这里实时同步（只保留最新一条）</p>
  <div id="tcur" class="tbox">${textBody}</div>
  <button id="tcopy" disabled>复制</button>
  <textarea id="tsend" rows="3" maxlength="60000" placeholder="输入要发送到电脑的文字"></textarea>
  <button id="tgo">发送到电脑</button>
  <div id="tstatus"></div>
</div>
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
  ${items.length > 0 ? '<div class="dlbar"><label><input type="checkbox" id="selall">全选</label><button id="dlsel" disabled>下载选中</button></div>' : ''}
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
// 批量下载：勾选 → 逐个 <a download> 触发（浏览器询问"允许下载多个文件"）
var boxes = [].slice.call(document.querySelectorAll('input.dl'))
var selAll = document.getElementById('selall')
var dlSel = document.getElementById('dlsel')
function refreshSel() {
  var on = boxes.filter(function (b) { return b.checked })
  dlSel.disabled = on.length === 0
  selAll.checked = boxes.length > 0 && on.length === boxes.length
}
if (boxes.length) {
  boxes.forEach(function (b) { b.onchange = refreshSel })
  selAll.onchange = function () {
    boxes.forEach(function (b) { b.checked = selAll.checked })
    refreshSel()
  }
  dlSel.onclick = function () {
    boxes.filter(function (b) { return b.checked }).forEach(function (b) {
      var a = document.createElement('a')
      a.href = '/f/' + b.getAttribute('data-id')
      a.download = b.getAttribute('data-rel') || ''
      document.body.appendChild(a)
      a.click()
      a.remove()
    })
  }
  refreshSel()
}
// 文字同步：桌面「文字」页签与这里共用最新一条（GET 轮询 / PUT 发送）
var tcur = document.getElementById('tcur')
var tcopy = document.getElementById('tcopy')
var tsend = document.getElementById('tsend')
var tgo = document.getElementById('tgo')
var tstatus = document.getElementById('tstatus')
var tts = ${curTs}
function renderText(t) {
  if (t === '') {
    tcur.innerHTML = '<span class="empty">（暂无文字）</span>'
    tcopy.disabled = true
  } else {
    tcur.textContent = t
    tcopy.disabled = false
  }
}
function applyText(j) {
  tts = j.ts || 0
  renderText(typeof j.text === 'string' ? j.text : '')
}
function pollText() {
  if (document.hidden) return
  fetch('t?since=' + tts, { cache: 'no-store' })
    .then(function (r) { return r.status === 204 ? null : r.json() })
    .then(function (j) { if (j) applyText(j) })
    .catch(function () { /* 网络抖动忽略 */ })
}
tgo.onclick = function () {
  var v = tsend.value
  if (!v) { tstatus.textContent = '先输入文字'; return }
  tgo.disabled = true
  tstatus.textContent = '发送中…'
  fetch('t', { method: 'PUT', body: v })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
    .then(function (j) {
      applyText(j)
      tstatus.textContent = '已发送'
      tsend.value = ''
    })
    .catch(function (e) { tstatus.textContent = '发送失败：' + e.message })
    .then(function () { tgo.disabled = false })
}
tcopy.onclick = function () {
  var t = tcur.textContent || ''
  if (!t) return
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t)
      .then(function () { tstatus.textContent = '已复制' })
      .catch(function () { fallbackCopy(t) })
  } else {
    fallbackCopy(t)
  }
}
function fallbackCopy(t) {
  var ta = document.createElement('textarea')
  ta.value = t
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  var ok = false
  try { ok = document.execCommand('copy') } catch (e) { ok = false }
  document.body.removeChild(ta)
  tstatus.textContent = ok ? '已复制' : '复制失败，请长按选择'
}
pollText()
setInterval(pollText, 2000)
document.addEventListener('visibilitychange', function () { if (!document.hidden) pollText() })
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

// ── 共享文字 ──

function textResponse(): Response {
    return new Response(JSON.stringify(texts.get()), {
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    })
}

/** PUT /t：body 为 UTF-8 纯文本，超限 413；成功后返回最新 {text, ts} */
async function putText(req: Request): Promise<Response> {
    if (!req.body) return new Response('no body', { status: 400 })
    const reader = req.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value || value.length === 0) continue
            total += value.length
            if (total > TEXT_MAX) {
                try { await reader.cancel() } catch { /* 尽力关闭 */ }
                return new Response('too large', { status: 413 })
            }
            chunks.push(value)
        }
    } catch {
        return new Response('read failed', { status: 500 })
    }
    const all = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { all.set(c, off); off += c.length }
    const st = texts.set(new TextDecoder('utf-8').decode(all))
    return new Response(JSON.stringify(st), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    })
}

// ── 路由 ──

export function buildHandler(): ServerHandler {
    return async (req) => {
        try {
            const u = new URL(req.url, 'http://lanfile/')
            const path = u.pathname
            if (req.method === 'GET' || req.method === 'HEAD') {
                if (path === '/' || path === '') return listHtml()
                if (path === '/t') {
                    const since = u.searchParams.get('since')
                    if (since !== null && Number(since) === texts.get().ts) {
                        return new Response(null, {
                            status: 204,
                            headers: { 'Cache-Control': 'no-store' },
                        })
                    }
                    return textResponse()
                }
                const m = /^\/f\/(\d+)$/.exec(path)
                if (m) return download(parseInt(m[1], 10),
                    req.headers.get('range'), req.method === 'HEAD')
            }
            if (req.method === 'PUT' && (path === '/up' || path === '/up/')) {
                return await upload(u.searchParams.get('name'), req)
            }
            if (req.method === 'PUT' && path === '/t') {
                return await putText(req)
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
