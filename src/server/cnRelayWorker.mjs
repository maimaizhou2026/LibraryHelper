/**
 * 浙杭借书搭子 (LibraryHelper) - 境内轻量中转网关 (Zero-Dependency Node.js Worker)
 *
 * 用途：解决浙江图书馆 (www.zjlib.cn) 与杭州图书馆 (my1.zjhzlib.cn) 屏蔽境外/香港云机房 IP (如 Vercel hkg1) 的问题。
 * 支持环境：
 *   1. 阿里云函数计算 FC 3.0（推荐：选「华东1-杭州」、Web 函数、Node.js 20，自带免费额度与 *.cn-hangzhou.fcapp.run 公网 HTTPS 域名，免备案）
 *   2. 腾讯云云函数 SCF（选「华东-上海」、Web 函数、Node.js 18+）
 *   3. 本地电脑 / 家庭软路由 / 国内轻量云直接运行：node src/server/cnRelayWorker.mjs（可配合 cloudflared tunnel 免费穿透）
 *
 * 环境变量（可选）：
 *   - PORT / FC_SERVER_PORT / SCF_RUNTIME_PORT：监听端口（默认 9000）
 *   - RELAY_SECRET：中转鉴权密钥（与 Vercel 环境变量 UPSTREAM_RELAY_SECRET 保持一致）
 */

import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'

const PORT = Number(process.env.FC_SERVER_PORT || process.env.SCF_RUNTIME_PORT || process.env.PORT || 9000)
const RELAY_SECRET = String(process.env.RELAY_SECRET || process.env.UPSTREAM_RELAY_SECRET || '').trim()

function isAllowedLibraryHost(hostname) {
  const h = String(hostname || '').toLowerCase()
  return (
    h === 'www.zjlib.cn' ||
    h.endsWith('.zjlib.cn') ||
    h === 'my1.zjhzlib.cn' ||
    h.endsWith('.zjhzlib.cn') ||
    h === 'book-resource.dataesb.com' ||
    h.endsWith('.dataesb.com')
  )
}

function isAllowedCallerOrigin(originHeader) {
  const origin = String(originHeader || '').trim().toLowerCase()
  if (!origin) return true
  try {
    const h = new URL(origin).hostname.toLowerCase()
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === 'book.rouroulib.cn' ||
      h.endsWith('.rouroulib.cn') ||
      h.endsWith('.vercel.app')
    )
  } catch {
    return false
  }
}

function decompressBuffer(buf, encoding) {
  const enc = String(encoding || '').toLowerCase().trim()
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf)
    if (enc === 'deflate') return zlib.inflateSync(buf)
    if (enc === 'br') return zlib.brotliDecompressSync(buf)
  } catch {
    // ignore decompression error
  }
  return buf
}

function forwardToLibrary(urlStr, options, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(urlStr)
    if (!isAllowedLibraryHost(targetUrl.hostname)) {
      reject(Object.assign(new Error(`Forbidden target host: ${targetUrl.hostname}`), { code: 'EFORBIDDEN' }))
      return
    }

    const isHttps = targetUrl.protocol === 'https:'
    const reqFn = isHttps ? https.request : http.request
    const method = String(options.method || 'GET').toUpperCase()
    const headers = { ...(options.headers || {}) }
    delete headers.host
    delete headers.Host
    delete headers['content-length']
    delete headers['Content-Length']

    const bodyBuf = options.bodyBase64 ? Buffer.from(String(options.bodyBase64), 'base64') : null
    if (bodyBuf && bodyBuf.byteLength > 0) {
      headers['Content-Length'] = String(bodyBuf.byteLength)
    }

    const req = reqFn(
      targetUrl,
      {
        method,
        headers,
        family: 4,
        rejectUnauthorized: false,
        timeout: Number(options.timeoutMs) || 8500,
      },
      (res) => {
        const status = res.statusCode || 200
        const rawSetCookie = res.headers['set-cookie']
        const setCookies = Array.isArray(rawSetCookie)
          ? rawSetCookie
          : rawSetCookie
            ? [String(rawSetCookie)]
            : []

        if (
          options.redirect !== 'manual' &&
          [301, 302, 303, 307, 308].includes(status) &&
          res.headers.location &&
          redirectCount < 5
        ) {
          res.resume()
          const nextUrl = new URL(res.headers.location, targetUrl).toString()
          const nextMethod = status === 303 ? 'GET' : method
          forwardToLibrary(
            nextUrl,
            {
              ...options,
              method: nextMethod,
              bodyBase64: nextMethod === 'GET' ? '' : options.bodyBase64,
            },
            redirectCount + 1
          )
            .then(resolve)
            .catch(reject)
          return
        }

        const chunks = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const rawBuf = Buffer.concat(chunks)
          const decodedBuf = decompressBuffer(rawBuf, res.headers['content-encoding'])
          const cleanHeaders = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined && k.toLowerCase() !== 'content-encoding') {
              cleanHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
            }
          }
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: cleanHeaders,
            setCookies,
            bodyBase64: decodedBuf.toString('base64'),
          })
        })
        res.on('error', reject)
      }
    )

    req.on('timeout', () => {
      req.destroy(Object.assign(new Error(`Upstream timeout: ${targetUrl.hostname}`), { code: 'ETIMEDOUT' }))
    })
    req.on('error', reject)
    if (bodyBuf && bodyBuf.byteLength > 0) {
      req.write(bodyBuf)
    }
    req.end()
  })
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'GET') {
    res.statusCode = 200
    res.end(
      JSON.stringify({
        ok: true,
        service: 'LibraryHelper CN Relay Worker',
        timestamp: new Date().toISOString(),
      })
    )
    return
  }

  if (req.method !== 'POST') {
    res.statusCode = 405
    res.end(JSON.stringify({ relayError: true, errorCode: 'METHOD_NOT_ALLOWED', message: 'POST required' }))
    return
  }

  if (!isAllowedCallerOrigin(req.headers.origin)) {
    res.statusCode = 403
    res.end(JSON.stringify({ relayError: true, errorCode: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' }))
    return
  }

  if (RELAY_SECRET) {
    const incomingSecret = String(req.headers['x-relay-secret'] || '').trim()
    if (incomingSecret !== RELAY_SECRET) {
      res.statusCode = 403
      res.end(JSON.stringify({ relayError: true, errorCode: 'FORBIDDEN', message: 'Invalid X-Relay-Secret' }))
      return
    }
  }

  const chunks = []
  req.on('data', (c) => chunks.push(Buffer.from(c)))
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const result = await forwardToLibrary(String(body.url || ''), body)
      res.statusCode = 200
      res.end(JSON.stringify(result))
    } catch (err) {
      res.statusCode = 200
      res.end(
        JSON.stringify({
          relayError: true,
          errorCode: String(err?.code || 'RELAY_ERR'),
          message: String(err?.message || 'Relay request failed'),
        })
      )
    }
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[LibraryHelper CN Relay] Listening on http://0.0.0.0:${PORT}`)
})
