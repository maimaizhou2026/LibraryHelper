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
const ZJLIB_ORG_ID = '1916318653650423810'
const ZJLIB_API_BASE = 'https://www.zjlib.cn/bff-api'
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

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
    const sendJson = (obj) => {
      const rawJson = Buffer.from(JSON.stringify(obj), 'utf8')
      const acceptEnc = String(req.headers['accept-encoding'] || '').toLowerCase()
      if (acceptEnc.includes('gzip') && rawJson.byteLength > 1024) {
        const gz = zlib.gzipSync(rawJson)
        res.setHeader('Content-Encoding', 'gzip')
        res.setHeader('Content-Length', String(gz.byteLength))
        res.statusCode = 200
        res.end(gz)
        return
      }
      res.setHeader('Content-Length', String(rawJson.byteLength))
      res.statusCode = 200
      res.end(rawJson)
    }

    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')

      // 模式 A：双馆在线搜索极速一体流水线（1 次函数调用完成：浙图检索 + 浙图各书在馆复本 + 杭图检索 + 杭图在馆预览）
      if (body.mode === 'search_pipeline') {
        const searchKw = String(body.searchKw || '').trim()
        const cleanKw = String(body.cleanKw || searchKw).trim()
        const page = Math.max(1, Number(body.page) || 1)
        const searchRows = Math.min(Number(body.searchRows) || 15, 36)
        const hzSearchRows = Math.min(Number(body.hzSearchRows) || 20, 36)
        const curlibParam = String(body.curlibParam || '')
        const zjLimit = Math.min(Number(body.zjCandidateLimit) || 12, 24)

        const zjHeaders = {
          'User-Agent': DEFAULT_UA,
          'Content-Type': 'application/json',
          'BFF-ORG-ID': ZJLIB_ORG_ID,
          Origin: 'https://www.zjlib.cn',
          Referer: 'https://www.zjlib.cn/',
        }

        const zjTask = body.needZj
          ? (async () => {
              try {
                const postZjJson = async (url, payload) => {
                  const r = await forwardToLibrary(url, {
                    method: 'POST',
                    headers: zjHeaders,
                    bodyBase64: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
                    timeoutMs: 6500,
                  })
                  return JSON.parse(Buffer.from(r.bodyBase64, 'base64').toString('utf8') || '{}')
                }

                const zjTitleResp = await postZjJson(
                  `${ZJLIB_API_BASE}/search-admin-service/open-api/search/pageList`,
                  {
                    metadataType: 'work',
                    current: page,
                    size: searchRows,
                    query: [{ id: 0, key: 'title', value: searchKw, match: 'phrase_fuzzy', condition: 'and' }],
                    sortBy: [],
                  }
                ).catch(() => null)

                const titleRecords = zjTitleResp?.data?.records || []
                let zjFullResp = null
                if (titleRecords.length < 6) {
                  zjFullResp = await postZjJson(
                    `${ZJLIB_API_BASE}/search-admin-service/open-api/search/pageList`,
                    {
                      metadataType: 'work',
                      current: page,
                      size: Math.min(searchRows, 15),
                      query: [{ id: 0, key: '', value: searchKw, match: 'phrase_fuzzy', condition: 'and' }],
                      sortBy: [],
                    }
                  ).catch(() => null)
                }

                const mergedRaw = []
                const seenBibIds = new Set()
                for (const r of [...titleRecords, ...(zjFullResp?.data?.records || [])]) {
                  const bibId = String(Array.isArray(r.originalId) ? r.originalId[0] : r.originalId || r.id || '').trim()
                  if (!bibId || seenBibIds.has(bibId)) continue
                  seenBibIds.add(bibId)
                  mergedRaw.push(r)
                }

                const total = Number(zjTitleResp?.data?.total || zjFullResp?.data?.total || mergedRaw.length)
                const candidates = mergedRaw.slice(0, zjLimit)
                const copiesByWorkId = {}

                await Promise.all(
                  candidates.map(async (r) => {
                    const bibId = String(Array.isArray(r.originalId) ? r.originalId[0] : r.originalId || r.id || '').trim()
                    const workId = String(Array.isArray(r.id) ? r.id[0] : r.id || bibId).trim()
                    const sourceType = Array.isArray(r.sourceType) ? r.sourceType.join(',') : String(r.sourceType || '0')
                    if (!workId) return
                    try {
                      const resList = await postZjJson(
                        `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/search/resourceList`,
                        { id: workId, sourceType }
                      )
                      copiesByWorkId[workId] = resList?.data?.[0] || []
                    } catch {
                      copiesByWorkId[workId] = []
                    }
                  })
                )
                return { total, records: mergedRaw, copiesByWorkId }
              } catch {
                return { total: 0, records: [], copiesByWorkId: {} }
              }
            })()
          : Promise.resolve({ total: 0, records: [], copiesByWorkId: {} })

        const hzTask = body.needHz
          ? (async () => {
              try {
                const searchUrl = `https://my1.zjhzlib.cn/opac/search?q=${encodeURIComponent(cleanKw || searchKw)}&searchWay=&scWay=dim&rows=${hzSearchRows}&page=${page}&sortWay=score&sortOrder=desc&hasholding=1${curlibParam}`
                const searchRes = await forwardToLibrary(searchUrl, {
                  method: 'GET',
                  headers: { 'User-Agent': DEFAULT_UA },
                  timeoutMs: 6500,
                })
                const fullHtml = Buffer.from(searchRes.bodyBase64, 'base64').toString('utf8')
                const totalMatch = fullHtml.match(
                  /检索到\s*<strong[^>]*>\s*([\d,]+)\s*<\/strong>|检索到\s*[:：]?\s*([\d,]+)\s*条|共\s*([\d,]+)\s*条/
                )
                const rawTotalStr = totalMatch
                  ? (totalMatch[1] || totalMatch[2] || totalMatch[3] || '').replace(/,/g, '')
                  : ''

                const recnoMatches = [...fullHtml.matchAll(/bookrecno="(\d+)"/g)].map((m) => m[1])
                const uniqueRecnos = [...new Set(recnoMatches)]
                let previews = {}
                if (uniqueRecnos.length > 0) {
                  try {
                    const prevUrl = `https://my1.zjhzlib.cn/opac/book/holdingPreviews?bookrecnos=${encodeURIComponent(uniqueRecnos.join(','))}&curLibcodes=&return_fmt=json`
                    const prevRes = await forwardToLibrary(prevUrl, {
                      method: 'GET',
                      headers: { 'User-Agent': DEFAULT_UA },
                      timeoutMs: 5500,
                    })
                    const prevJson = JSON.parse(Buffer.from(prevRes.bodyBase64, 'base64').toString('utf8') || '{}')
                    previews = prevJson?.previews || {}
                  } catch {
                    // ignore preview error
                  }
                }
                // 仅截取包含 .bookmetaTD 的表格主体片段，剥离首尾冗余脚本样式以节省 75% 流量
                const tableStart = fullHtml.indexOf('<table class="resultTable')
                const tableEnd = fullHtml.lastIndexOf('</table>')
                const slimHtml =
                  tableStart >= 0 && tableEnd > tableStart
                    ? fullHtml.slice(tableStart, tableEnd + 8)
                    : fullHtml
                return {
                  total: rawTotalStr ? Number(rawTotalStr) : uniqueRecnos.length,
                  html: slimHtml,
                  previews,
                }
              } catch {
                return { total: 0, html: '', previews: {} }
              }
            })()
          : Promise.resolve({ total: 0, html: '', previews: {} })

        const [zj, hz] = await Promise.all([zjTask, hzTask])
        sendJson({ ok: true, pipeline: true, zj, hz })
        return
      }

      // 模式 B：杭图登录加密会话一键初始化（1 次函数调用完成：login 获取 JSESSIONID + certificate/pem 公钥 + 可选验证码）
      if (body.mode === 'hzlib_init') {
        const includeImage = Boolean(body.includeImage)
        const loginRes = await forwardToLibrary('https://my1.zjhzlib.cn/opac/reader/login', {
          method: 'GET',
          headers: { 'User-Agent': DEFAULT_UA },
        })
        const jsessionMatch = (loginRes.setCookies || []).join('; ').match(/JSESSIONID=[^;]+/)
        const sessionCookie = jsessionMatch ? jsessionMatch[0] : ''
        const pemRes = await forwardToLibrary(
          `https://my1.zjhzlib.cn/opac/certificate/pem?checkCode=${Date.now()}opac`,
          { method: 'GET', headers: { 'User-Agent': DEFAULT_UA, Cookie: sessionCookie } }
        )
        const pemKey = Buffer.from(pemRes.bodyBase64, 'base64').toString('utf8')
        let captchaImage = ''
        if (includeImage) {
          const vcRes = await forwardToLibrary(
            `https://my1.zjhzlib.cn/opac/validateCodeImage?r=${Math.random()}`,
            { method: 'GET', headers: { 'User-Agent': DEFAULT_UA, Cookie: sessionCookie } }
          )
          captchaImage = `data:image/jpeg;base64,${vcRes.bodyBase64}`
        }
        sendJson({ ok: true, pipeline: true, sessionCookie, pemKey, captchaImage })
        return
      }

      const result = await forwardToLibrary(String(body.url || ''), body)
      sendJson(result)
    } catch (err) {
      sendJson({
        relayError: true,
        errorCode: String(err?.code || 'RELAY_ERR'),
        message: String(err?.message || 'Relay request failed'),
      })
    }
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[LibraryHelper CN Relay] Listening on http://0.0.0.0:${PORT}`)
})
