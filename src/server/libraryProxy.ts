import type { Plugin } from 'vite'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import * as cheerio from 'cheerio'
import smCrypto from 'sm-crypto'
import versionInfo from '../../version.json'
import {
  getLibraryAddressInfo,
  getLibraryBranchPriority,
  ZJLIB_BRANCH_CONFIG,
} from '../utils/mapLink'

const DEFAULT_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export interface UpstreamResponse {
  ok: boolean
  status: number
  headers: {
    get: (name: string) => string | null
    getSetCookie: () => string[]
  }
  text: () => Promise<string>
  json: () => Promise<any>
  arrayBuffer: () => Promise<ArrayBuffer>
}

function buildBrowserHeaders(targetUrl: URL, rawHeaders?: Record<string, any>): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_BROWSER_UA,
    Accept: 'application/json, text/plain, text/html, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
  }
  const host = targetUrl.hostname.toLowerCase()
  if (host.includes('zjlib.cn')) {
    headers.Origin = 'https://www.zjlib.cn'
    headers.Referer = 'https://www.zjlib.cn/'
  } else if (host.includes('zjhzlib.cn')) {
    headers.Origin = `${targetUrl.protocol}//${targetUrl.host}`
    headers.Referer = `${targetUrl.protocol}//${targetUrl.host}/opac/reader/login`
  }
  if (rawHeaders) {
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (v !== undefined && v !== null) {
        headers[k] = String(v)
      }
    }
  }
  return headers
}

function decompressBody(buf: Buffer, encoding: string): Buffer {
  const enc = (encoding || '').toLowerCase().trim()
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf)
    if (enc === 'deflate') return zlib.inflateSync(buf)
    if (enc === 'br') return zlib.brotliDecompressSync(buf)
  } catch {
    // return original buffer if decompression fails
  }
  return buf
}

function shouldAllowRelaxedTls(hostname: string): boolean {
  const h = (hostname || '').toLowerCase()
  return h.endsWith('zjhzlib.cn') || h.endsWith('dataesb.com')
}

function isSafePublicHttpUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false
  if (rawUrl.startsWith('/api/covers/zjlib-image?')) return true
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (u.hash.startsWith('#hd=')) {
      try {
        const hdDecoded = decodeURIComponent(u.hash.slice(4))
        if (hdDecoded && !isSafePublicHttpUrl(hdDecoded)) return false
      } catch {
        return false
      }
    }
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (
      !host ||
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return false
    }
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
      return false
    }
    const m172 = host.match(/^172\.(\d+)\./)
    if (m172) {
      const second = Number(m172[1])
      if (second >= 16 && second <= 31) return false
    }
    return true
  } catch {
    return false
  }
}

function getUpstreamRelayConfig(): { relayUrl: string; relaySecret: string } {
  const relayUrl = String(process.env.UPSTREAM_RELAY_URL || '').trim()
  const relaySecret = String(process.env.UPSTREAM_RELAY_SECRET || '').trim()
  return { relayUrl, relaySecret }
}

function shouldRelayHostname(hostname: string): boolean {
  const { relayUrl } = getUpstreamRelayConfig()
  if (!relayUrl) return false
  const h = (hostname || '').toLowerCase()
  return h.endsWith('zjlib.cn') || h.endsWith('zjhzlib.cn') || h.endsWith('dataesb.com')
}

function relayNodeHttpRequest(
  urlStr: string,
  init?: {
    method?: string
    headers?: Record<string, any>
    body?: string | Buffer
    redirect?: 'follow' | 'manual'
    timeoutMs?: number
    relaxTls?: boolean
  }
): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(urlStr)
    const { relayUrl, relaySecret } = getUpstreamRelayConfig()
    const relayTarget = new URL(relayUrl)
    const reqStartAt = Date.now()
    const wrapUpstreamErr = (rawErr: any) => {
      const errObj = rawErr instanceof Error ? rawErr : new Error(String(rawErr || 'Relay Error'))
      return Object.assign(errObj, {
        upstreamHost: targetUrl.hostname,
        upstreamElapsedMs: Date.now() - reqStartAt,
      })
    }

    const method = (init?.method || 'GET').toUpperCase()
    const headers = buildBrowserHeaders(targetUrl, init?.headers)
    const bodyBuf =
      init?.body !== undefined
        ? Buffer.isBuffer(init.body)
          ? init.body
          : Buffer.from(String(init.body), 'utf8')
        : undefined

    const payloadBuf = Buffer.from(
      JSON.stringify({
        url: urlStr,
        method,
        headers,
        bodyBase64: bodyBuf ? bodyBuf.toString('base64') : '',
        redirect: init?.redirect || 'follow',
        timeoutMs: init?.timeoutMs || 8500,
      }),
      'utf8'
    )

    const isHttps = relayTarget.protocol === 'https:'
    const reqFn = isHttps ? https.request : http.request
    const relayHeaders: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(payloadBuf.byteLength),
      Accept: 'application/json',
    }
    if (relaySecret) {
      relayHeaders['X-Relay-Secret'] = relaySecret
    }

    const req = reqFn(
      relayTarget,
      {
        method: 'POST',
        headers: relayHeaders,
        family: 4,
        timeout: (init?.timeoutMs || 8500) + 3000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          try {
            const rawBuf = Buffer.concat(chunks)
            const decodedRelayBuf = decompressBody(
              rawBuf,
              String(res.headers['content-encoding'] || '')
            )
            const relayJson = JSON.parse(decodedRelayBuf.toString('utf8') || '{}')
            if (relayJson && relayJson.relayError) {
              reject(
                wrapUpstreamErr(
                  Object.assign(new Error(String(relayJson.message || '中转请求上游失败')), {
                    code: String(relayJson.errorCode || 'RELAY_UPSTREAM_ERR'),
                  })
                )
              )
              return
            }
            const status = Number(relayJson.status || res.statusCode || 200)
            const setCookieList: string[] = Array.isArray(relayJson.setCookies)
              ? relayJson.setCookies.map((c: any) => String(c))
              : []
            const lowerHeaders: Record<string, string> = {}
            if (relayJson.headers && typeof relayJson.headers === 'object') {
              for (const [hk, hv] of Object.entries(relayJson.headers)) {
                if (hv !== undefined && hv !== null) {
                  lowerHeaders[hk.toLowerCase()] = String(hv)
                }
              }
            }
            const decodedBuf = Buffer.from(String(relayJson.bodyBase64 || ''), 'base64')
            resolve({
              ok: status >= 200 && status < 300,
              status,
              headers: {
                get(name: string) {
                  return lowerHeaders[name.toLowerCase()] ?? null
                },
                getSetCookie() {
                  return setCookieList
                },
              },
              async text() {
                return decodedBuf.toString('utf8')
              },
              async json() {
                const txt = decodedBuf.toString('utf8')
                return txt ? JSON.parse(txt) : {}
              },
              async arrayBuffer() {
                return decodedBuf.buffer.slice(
                  decodedBuf.byteOffset,
                  decodedBuf.byteOffset + decodedBuf.byteLength
                ) as ArrayBuffer
              },
            })
          } catch (parseErr) {
            reject(wrapUpstreamErr(parseErr))
          }
        })
        res.on('error', (e) => reject(wrapUpstreamErr(e)))
      }
    )

    req.on('timeout', () => {
      req.destroy(
        wrapUpstreamErr(
          Object.assign(new Error(`连接境内中转网关超时 (${relayTarget.hostname})`), {
            code: 'ETIMEDOUT',
          })
        )
      )
    })
    req.on('error', (e) => reject(wrapUpstreamErr(e)))
    req.write(payloadBuf)
    req.end()
  })
}

function singleNodeHttpRequest(
  urlStr: string,
  init?: {
    method?: string
    headers?: Record<string, any>
    body?: string | Buffer
    redirect?: 'follow' | 'manual'
    timeoutMs?: number
    relaxTls?: boolean
  },
  redirectCount = 0
): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(urlStr)
    if (redirectCount === 0 && shouldRelayHostname(targetUrl.hostname)) {
      relayNodeHttpRequest(urlStr, init).then(resolve).catch(reject)
      return
    }
    const reqStartAt = Date.now()
    const wrapUpstreamErr = (rawErr: any) => {
      const errObj = rawErr instanceof Error ? rawErr : new Error(String(rawErr || 'Upstream Error'))
      return Object.assign(errObj, {
        upstreamHost: targetUrl.hostname,
        upstreamElapsedMs: Date.now() - reqStartAt,
      })
    }
    const isHttps = targetUrl.protocol === 'https:'
    const method = (init?.method || 'GET').toUpperCase()
    const headers = buildBrowserHeaders(targetUrl, init?.headers)
    const bodyBuf =
      init?.body !== undefined
        ? Buffer.isBuffer(init.body)
          ? init.body
          : Buffer.from(String(init.body), 'utf8')
        : undefined
    if (bodyBuf && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = String(bodyBuf.byteLength)
    }

    const reqFn = isHttps ? https.request : http.request
    const allowRelaxedTls = Boolean(init?.relaxTls) || shouldAllowRelaxedTls(targetUrl.hostname)
    const req = reqFn(
      targetUrl,
      {
        method,
        headers,
        family: 4,
        rejectUnauthorized: !allowRelaxedTls,
        timeout: init?.timeoutMs || 8500,
      },
      (res) => {
        const status = res.statusCode || 200
        const rawSetCookie = res.headers['set-cookie']
        const setCookieList = Array.isArray(rawSetCookie)
          ? rawSetCookie
          : rawSetCookie
            ? [String(rawSetCookie)]
            : []

        // 处理自动重定向（当未指定 redirect: 'manual' 时）
        if (
          init?.redirect !== 'manual' &&
          [301, 302, 303, 307, 308].includes(status) &&
          res.headers.location &&
          redirectCount < 5
        ) {
          res.resume()
          const nextUrl = new URL(res.headers.location, targetUrl).toString()
          const nextMethod = status === 303 ? 'GET' : method
          singleNodeHttpRequest(
            nextUrl,
            {
              ...init,
              method: nextMethod,
              body: nextMethod === 'GET' ? undefined : init?.body,
            },
            redirectCount + 1
          )
            .then(resolve)
            .catch(reject)
          return
        }

        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const rawBuf = Buffer.concat(chunks)
          const decodedBuf = decompressBody(rawBuf, String(res.headers['content-encoding'] || ''))
          const lowerHeaders: Record<string, string> = {}
          for (const [hk, hv] of Object.entries(res.headers)) {
            if (hv !== undefined) {
              lowerHeaders[hk.toLowerCase()] = Array.isArray(hv) ? hv.join(', ') : String(hv)
            }
          }
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: {
              get(name: string) {
                return lowerHeaders[name.toLowerCase()] ?? null
              },
              getSetCookie() {
                return setCookieList
              },
            },
            async text() {
              return decodedBuf.toString('utf8')
            },
            async json() {
              const txt = decodedBuf.toString('utf8')
              return txt ? JSON.parse(txt) : {}
            },
            async arrayBuffer() {
              return decodedBuf.buffer.slice(
                decodedBuf.byteOffset,
                decodedBuf.byteOffset + decodedBuf.byteLength
              ) as ArrayBuffer
            },
          })
        })
        res.on('error', (e) => reject(wrapUpstreamErr(e)))
      }
    )

    req.on('timeout', () => {
      req.destroy(
        wrapUpstreamErr(
          Object.assign(new Error(`连接上游服务器超时 (${targetUrl.hostname})`), {
            code: 'ETIMEDOUT',
          })
        )
      )
    })
    req.on('error', (e) => reject(wrapUpstreamErr(e)))
    if (bodyBuf) {
      req.write(bodyBuf)
    }
    req.end()
  })
}

/**
 * 统一高可用上游请求封装：
 * 1. 使用 Node 原生 https/http（强制 IPv4 + 兼容政务云 SSL 证书链 + 完整浏览器仿真请求头）
 * 2. 支持通过 UPSTREAM_RELAY_URL 境内中转网关突破浙图/杭图境外 IP 防火墙封锁
 * 3. 针对瞬时连接重置或证书异常自动重试，针对黑洞超时 (ETIMEDOUT) 或域名不存在 (ENOTFOUND) 快速失败
 */
async function upstreamFetch(
  urlInput: string | URL,
  init?: {
    method?: string
    headers?: Record<string, any>
    body?: any
    redirect?: 'follow' | 'manual'
    timeoutMs?: number
  }
): Promise<UpstreamResponse> {
  const primaryUrl = String(urlInput)
  let lastError: any = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const isCertErr =
        lastError &&
        /CERT|UNABLE_TO_VERIFY|SELF_SIGNED|TLS/i.test(
          String(lastError?.code || lastError?.message || '')
        )
      return await singleNodeHttpRequest(primaryUrl, {
        ...init,
        relaxTls: attempt > 0 && isCertErr,
      })
    } catch (err: any) {
      lastError = err
      const errCode = String(err?.code || err?.cause?.code || '')
      // 遭遇防火墙黑洞超时 (ETIMEDOUT) 或 DNS 不存在 (ENOTFOUND) 时立即快速失败，避免双倍等待
      if (errCode === 'ETIMEDOUT' || errCode === 'UND_ERR_CONNECT_TIMEOUT' || errCode === 'ENOTFOUND') {
        break
      }
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  }
  throw lastError || new Error(`请求上游失败: ${primaryUrl}`)
}

export interface DiagnosticErrorEntry {
  reqId: string
  timestamp: string
  route: string
  version: string
  region: string
  upstreamHost: string
  errorCode: string
  durationMs: number
  message: string
}

const MAX_DIAGNOSTIC_ERRORS = 30
const recentDiagnosticErrors: DiagnosticErrorEntry[] = []

/**
 * 严格脱敏清洗：剥离任何可能包含读者证号、身份证、手机号、条码、Cookie、Token 或长串凭证的字符
 */
function sanitizeDiagnosticText(raw: string): string {
  if (!raw) return ''
  return String(raw)
    .replace(/(JSESSIONID|token|password|rdPasswd|rdLoginId|account|cookie)\s*[=:]\s*[^\s;&,]+/gi, '$1=[REDACTED]')
    .replace(/\b[A-Za-z0-9+/=_.-]{8,}\b/g, (token) => {
      // 保留常见错误码、系统网络诊断词与已知公共图书馆域名
      if (
        /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|NETWORK_ERROR|TIMEOUT|HTTP_\d+|getaddrinfo|certificate|connected|connection|aborted|timedout)$/i.test(
          token
        ) ||
        /^(www\.zjlib\.cn|my1\.zjhzlib\.cn|opac\.zjhzlib\.cn|book-resource\.dataesb\.com|map\.baidu\.com|image\.baidu\.com)$/i.test(
          token
        )
      ) {
        return token
      }
      return '[REDACTED]'
    })
    .slice(0, 240)
}

function formatUpstreamError(err: any, fallbackTitle: string, req?: any, route?: string): string {
  const code = err?.cause?.code || err?.code || ''
  const rawMsg = err?.cause?.message || err?.message || ''
  const upstreamHost = String(err?.upstreamHost || '')
  const upstreamElapsedMs = Number(err?.upstreamElapsedMs || 0)
  const reqId = String(req?.__reqId || crypto.randomBytes(3).toString('hex'))
  const reqDurationMs = req?.__startAt ? Date.now() - Number(req.__startAt) : upstreamElapsedMs
  const region = process.env.VERCEL_REGION || 'local'
  const targetRoute = String(route || req?.__route || '/api/unknown')

  const detailParts: string[] = []
  if (code) detailParts.push(String(code))
  if (upstreamHost) detailParts.push(upstreamHost)
  if (upstreamElapsedMs > 0) detailParts.push(`${upstreamElapsedMs}ms`)
  const detailSuffix = detailParts.length > 0 ? ` (${detailParts.join(', ')})` : ''
  const diagTag = `[v${versionInfo.version} · ${region}#${reqId}]`

  let userMessage = ''
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || rawMsg.includes('超时')) {
    const isOverseasVercel = Boolean(process.env.VERCEL || process.env.VERCEL_REGION)
    const isLibraryUpstream =
      upstreamHost.endsWith('zjlib.cn') || upstreamHost.endsWith('zjhzlib.cn')
    const hasRelay = Boolean(getUpstreamRelayConfig().relayUrl)
    if (isOverseasVercel && isLibraryUpstream && !hasRelay) {
      userMessage = `${fallbackTitle}：浙图/杭图官方防火墙屏蔽了境外云机房访问${detailSuffix}，请配置境内中转网关 (UPSTREAM_RELAY_URL) 或使用「本地导入/导出」 ${diagTag}`
    } else {
      userMessage = `${fallbackTitle}：连接图书馆官方服务器超时${detailSuffix || ' (TIMEOUT)'}，请稍后重试 ${diagTag}`
    }
  } else if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE') {
    userMessage = `${fallbackTitle}：图书馆服务器重置了连接${detailSuffix}，请稍后重试 ${diagTag}`
  } else if (rawMsg === 'fetch failed') {
    userMessage = `${fallbackTitle}：上游图书馆网络连接失败${detailSuffix || ' (NETWORK_ERROR)'}，请稍后重试 ${diagTag}`
  } else {
    const cleanRaw = sanitizeDiagnosticText(rawMsg)
    userMessage = cleanRaw
      ? `${fallbackTitle}：${cleanRaw}${detailSuffix} ${diagTag}`
      : `${fallbackTitle}${detailSuffix} ${diagTag}`
  }

  const diagEntry: DiagnosticErrorEntry = {
    reqId,
    timestamp: new Date().toISOString(),
    route: targetRoute,
    version: versionInfo.version,
    region,
    upstreamHost: upstreamHost || 'none',
    errorCode: String(code || (err?.statusCode ? `HTTP_${err.statusCode}` : 'ERR_UNKNOWN')),
    durationMs: reqDurationMs,
    message: sanitizeDiagnosticText(rawMsg || fallbackTitle),
  }
  recentDiagnosticErrors.unshift(diagEntry)
  if (recentDiagnosticErrors.length > MAX_DIAGNOSTIC_ERRORS) {
    recentDiagnosticErrors.length = MAX_DIAGNOSTIC_ERRORS
  }
  console.error('[LibraryHelperDiag]', JSON.stringify(diagEntry))

  return userMessage
}

const fetch = upstreamFetch

let coverMemoryCache: Record<string, string> | null = null

const ZJLIB_SM2_PUBLIC_KEY =
  '0482ddef5f3839bc64562d7f88782be9923785a5f05beaa25c9e8932d6591aa50b47f27aa9595f98ff80e88c1751b95bc9554de41874b37cb4b50028e4cf0ac0e1'
const ZJLIB_ORG_ID = '1916318653650423810'
const ZJLIB_API_BASE = 'https://www.zjlib.cn/bff-api'
const COVER_CACHE_FILE = path.resolve(process.cwd(), '.cover-cache.json')
const FALLBACK_COVER_CACHE_FILE = path.join(os.tmpdir(), 'library-helper-cover-cache.json')
const MAX_COVER_CACHE_ENTRIES = 3000
let coverCacheWriteChain: Promise<void> = Promise.resolve()
let coverCacheMtimeMs = 0

function repairCoverUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return ''
  const cleaned = rawUrl
    .trim()
    .replace(/^\/\//, 'https://')
    .replace(/^http:\/\//i, 'https://')
    .replace(/(&f=(?:JPEG|PNG|GIF|WEBP))=240=320(?:\?fmt=auto)?/gi, '$1?w=600&h=820')
  if (cleaned.includes('#hd=')) {
    const [basePart, hdRaw] = cleaned.split('#hd=')
    try {
      const hdDecoded = decodeURIComponent(hdRaw || '')
      if (
        /\.(?:360buyimg\.com|winxuancdn\.com|bookuu\.com)\//i.test(hdDecoded) ||
        /book-resource\.dataesb\.com\/cover\/(?:p|medium)\//i.test(hdDecoded)
      ) {
        return hdDecoded
          .replace(/^http:\/\//i, 'https://')
          .replace(/(\.360buyimg\.com)\/n\d+\/(?:s\d+x\d+_)?/i, '$1/n0/')
      }
    } catch {
      // ignore
    }
    return basePart
  }
  return cleaned
}

function createSafeCacheMap(initial?: Record<string, any>): Record<string, string> {
  const safeMap: Record<string, string> = Object.create(null)
  if (initial && typeof initial === 'object') {
    for (const [k, v] of Object.entries(initial)) {
      const fixed = typeof v === 'string' ? repairCoverUrl(v) : ''
      if (
        k &&
        k !== '__proto__' &&
        k !== 'constructor' &&
        k !== 'prototype' &&
        fixed &&
        isSafePublicHttpUrl(fixed) &&
        !isPlaceholderCoverUrl(fixed)
      ) {
        safeMap[k] = fixed
      }
    }
  }
  return safeMap
}

function setCoverCacheEntry(cache: Record<string, string>, key: string, url: string): void {
  const fixed = repairCoverUrl(url)
  if (
    !key ||
    key === '__proto__' ||
    key === 'constructor' ||
    key === 'prototype' ||
    !isSafePublicHttpUrl(fixed) ||
    isPlaceholderCoverUrl(fixed)
  ) {
    return
  }
  if (!(key in cache)) {
    const keys = Object.keys(cache)
    if (keys.length >= MAX_COVER_CACHE_ENTRIES) {
      const evictCount = Math.max(1, keys.length - MAX_COVER_CACHE_ENTRIES + 50)
      for (let i = 0; i < evictCount; i++) {
        delete cache[keys[i]]
      }
    }
  }
  cache[key] = fixed
}

async function loadCoverCache(): Promise<Record<string, string>> {
  try {
    const st = await fs.stat(COVER_CACHE_FILE)
    if (coverMemoryCache && st.mtimeMs === coverCacheMtimeMs) {
      return coverMemoryCache
    }
    const txt = await fs.readFile(COVER_CACHE_FILE, 'utf8')
    coverMemoryCache = createSafeCacheMap(JSON.parse(txt))
    coverCacheMtimeMs = st.mtimeMs
    return coverMemoryCache!
  } catch {
    if (coverMemoryCache) return coverMemoryCache
  }
  try {
    const fallbackTxt = await fs.readFile(FALLBACK_COVER_CACHE_FILE, 'utf8')
    coverMemoryCache = createSafeCacheMap(JSON.parse(fallbackTxt))
  } catch {
    coverMemoryCache = createSafeCacheMap()
  }
  return coverMemoryCache!
}

async function saveCoverCache(cache: Record<string, string>): Promise<void> {
  coverMemoryCache = cache
  const serialized = JSON.stringify(cache, null, 2)
  coverCacheWriteChain = coverCacheWriteChain.then(async () => {
    const writeAtomically = async (targetPath: string) => {
      const tmpPath = `${targetPath}.${process.pid}.tmp`
      await fs.writeFile(tmpPath, serialized, 'utf8')
      await fs.rename(tmpPath, targetPath)
    }
    try {
      await writeAtomically(COVER_CACHE_FILE)
      const st = await fs.stat(COVER_CACHE_FILE).catch(() => null)
      if (st) coverCacheMtimeMs = st.mtimeMs
    } catch {
      try {
        await writeAtomically(FALLBACK_COVER_CACHE_FILE)
      } catch {
        // ignore write error in read-only environments
      }
    }
  })
  return coverCacheWriteChain
}

function isPlaceholderCoverUrl(url: string): boolean {
  if (!url) return true
  const lower = url.toLowerCase()
  return (
    lower.includes('d9fa61ec5b294296a2a53bfe5a167c91') ||
    lower.includes('fb87c5fae030416d8f9629c56451e355') ||
    lower.includes('5133167f051e4f9a8c8797b35577ef4f') ||
    lower.includes('3593b961f9094da9887a8cbb2105d18c') ||
    lower.includes('fbc18786cafb44babc3b3b666bb0710c') ||
    lower.includes('1a8b6e68853e4278bd05ed5a05844deb') ||
    lower.includes('1196498018,785825342') ||
    lower.includes('1809027890,2934023687') ||
    lower.includes('bigbg.png') ||
    lower.includes('default_book') ||
    lower.includes('no_pic') ||
    lower.includes('nopic') ||
    lower.includes('zanwu') ||
    lower.includes('xinhuapic.oss') ||
    lower.includes('doubanio.com') ||
    lower.includes('openbookscan.com.cn:1235') ||
    lower.includes('=240=320') ||
    lower.endsWith('.null')
  )
}

interface CoverSearchMeta {
  rawTitle: string
  cleanTitle: string
  baseTitle: string
  subSeries: string
  partToken: '' | '全集' | '上' | '中' | '下'
  volNumber: string
  cleanAuthor: string
  cleanPublisher: string
  cleanIsbn: string
}

const COVER_CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9, 拾: 10,
  Ⅰ: 1, Ⅱ: 2, Ⅲ: 3, Ⅳ: 4, Ⅴ: 5, Ⅵ: 6, Ⅶ: 7, Ⅷ: 8, Ⅸ: 9, Ⅹ: 10,
}

const COVER_NUM_TO_CN_PAT: Record<string, string> = {
  '1': '一|壹|Ⅰ|I',
  '2': '二|贰|Ⅱ|II',
  '3': '三|叁|Ⅲ|III',
  '4': '四|肆|Ⅳ|IV',
  '5': '五|伍|Ⅴ|V',
  '6': '六|陆|Ⅵ|VI',
  '7': '七|柒|Ⅶ|VII',
  '8': '八|捌|Ⅷ|VIII',
  '9': '九|玖|Ⅸ|IX',
  '10': '十|拾|Ⅹ|X',
  '11': '十一|拾壹',
  '12': '十二|拾贰',
  '13': '十三|拾叁',
  '14': '十四|拾肆',
  '15': '十五|拾伍',
}

const COVER_ROMAN_TO_NUM: Record<string, string> = {
  I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6', VII: '7', VIII: '8', IX: '9', X: '10',
  Ⅰ: '1', Ⅱ: '2', Ⅲ: '3', Ⅳ: '4', Ⅴ: '5', Ⅵ: '6', Ⅶ: '7', Ⅷ: '8', Ⅸ: '9', Ⅹ: '10',
}

function numberToChineseVolumePattern(volNumStr: string): string {
  if (COVER_NUM_TO_CN_PAT[volNumStr]) return COVER_NUM_TO_CN_PAT[volNumStr]
  const n = parseInt(volNumStr, 10)
  if (!Number.isFinite(n) || n <= 0 || n >= 200) return ''
  const cnDigits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  const capDigits = ['', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
  if (n < 10) return `${cnDigits[n]}|${capDigits[n]}`
  if (n === 10) return '十|拾'
  if (n < 20) {
    const u = n % 10
    return `十${cnDigits[u]}|拾${capDigits[u]}`
  }
  if (n < 100) {
    const tens = Math.floor(n / 10)
    const units = n % 10
    const norm = `${cnDigits[tens]}十${units ? cnDigits[units] : ''}`
    const cap = `${capDigits[tens]}拾${units ? capDigits[units] : ''}`
    return `${norm}|${cap}`
  }
  return ''
}

function parseCoverVolumeToken(raw: string): string {
  const s = String(raw || '').trim().toUpperCase()
  if (!s) return ''
  if (/^\d+$/.test(s)) return String(parseInt(s, 10))
  if (COVER_ROMAN_TO_NUM[s]) return COVER_ROMAN_TO_NUM[s]
  let total = 0
  let cur = 0
  for (const ch of s) {
    if (ch === '十' || ch === '拾') {
      total += (cur || 1) * 10
      cur = 0
    } else if (COVER_CN_DIGITS[ch] !== undefined) {
      cur = COVER_CN_DIGITS[ch]
    }
  }
  const val = total + cur
  return val > 0 ? String(val) : ''
}

function extractCoverSearchMeta(
  rawTitle: string,
  rawAuthor = '',
  rawPublisher = '',
  rawIsbn = ''
): CoverSearchMeta {
  const cleanIsbn = String(rawIsbn || '').replace(/[^0-9Xx]/g, '').toUpperCase()
  const cleanTitle = String(rawTitle || '')
    .replace(/[《》「」【】]/g, ' ')
    .replace(/[．·:：；;，,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const sepParts = String(rawTitle || '')
    .replace(/[《》「」【】]/g, '')
    .split(/[．·:：—(（]/)
    .map((s) => s.trim())
    .filter(Boolean)

  const baseTitle = (sepParts[0] || cleanTitle)
    .replace(
      /\s+(?:上|中|下|全集|全一册|第?[0-9一二三四五六七八九十百壹贰叁肆伍陆柒捌玖拾]+[卷集册部辑篇回]).*$/g,
      ''
    )
    .trim()

  let subSeries = ''
  for (const seg of sepParts.slice(1)) {
    if (/^(?:总集篇|专题书|外传|番外|前传|后传|剧场版|公式书|资料集|设定集)$/.test(seg)) {
      subSeries = seg
      break
    }
  }

  let partToken: '' | '全集' | '上' | '中' | '下' = ''
  if (/(?:^|[\s．·:：,，（(])(?:全集|全一册|大全集|合订本)(?:[\s．·:：,，）)]|$)/.test(rawTitle)) {
    partToken = '全集'
  } else if (/(?:^|[\s．·:：,，（(])上[册卷集部]?(?:[\s．·:：,，）)]|$)/.test(rawTitle)) {
    partToken = '上'
  } else if (/(?:^|[\s．·:：,，（(])中[册卷集部]?(?:[\s．·:：,，）)]|$)/.test(rawTitle)) {
    partToken = '中'
  } else if (/(?:^|[\s．·:：,，（(])下[册卷集部]?(?:[\s．·:：,，）)]|$)/.test(rawTitle)) {
    partToken = '下'
  }

  let volNumber = ''
  const explicitVol =
    String(rawTitle || '').match(
      /[卷集册部辑]\s*第?\s*(\d+|[一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|\b(?:I|II|III|IV|V|VI|VII|VIII|IX|X)\b)/i
    ) ||
    String(rawTitle || '').match(
      /第?\s*(\d+|[一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+)\s*[卷集册部辑]/
    )
  if (explicitVol && explicitVol[1]) {
    volNumber = parseCoverVolumeToken(explicitVol[1])
  } else {
    for (const seg of sepParts.slice(1)) {
      const m = seg.match(
        /^(\d+|[一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|(?:I|II|III|IV|V|VI|VII|VIII|IX|X))(?=\s*[，,．.：:\s]|$)/i
      )
      if (m && m[1]) {
        volNumber = parseCoverVolumeToken(m[1])
        break
      }
    }
  }

  const cleanAuthor =
    String(rawAuthor || '')
      .replace(
        /\[.*?\]|\(.*?\)|（.*?）|原著|主编|编著|改写|著|绘|编|译|撰|[[\]()（）【】「」;；,，/]/g,
        ' '
      )
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')[0] || ''

  const cleanPublisher =
    String(rawPublisher || '')
      .replace(
        /\[.*?\]|\(.*?\)|（.*?）|\d{4}(?:[.\-/年]\d{1,2}(?:[.\-/月]\d{1,2}日?)?)?|[[\]()（）【】「」;；,，/]/g,
        ' '
      )
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')[0] || ''

  return {
    rawTitle,
    cleanTitle,
    baseTitle,
    subSeries,
    partToken,
    volNumber,
    cleanAuthor,
    cleanPublisher,
    cleanIsbn,
  }
}

function normalizeTrustedHdImageUrl(rawUrl: string): string {
  const url = repairCoverUrl(rawUrl)
  if (!url || !isSafePublicHttpUrl(url) || isPlaceholderCoverUrl(url)) return ''
  const isDirectImg =
    /\.(?:jpe?g|png|webp)(?:[?!].*)?$/i.test(url) ||
    /gips\d\.baidu\.com\/it\/u=/i.test(url) ||
    /pic\.rmb\.bdstatic\.com\//i.test(url)
  if (!isDirectImg) return ''

  const trustedHost =
    /\.(?:360buyimg\.com|winxuancdn\.com|bookuu\.com|alicdn\.com|baidu\.com|bdstatic\.com|kfzimg\.com|zdmimg\.com|smzdm\.com|myqcloud\.com|qq\.com|zhimg\.com)\//i.test(
      url
    )
  if (!trustedHost) return ''

  if (url.includes('.360buyimg.com/')) {
    return url.replace(/(\.360buyimg\.com)\/n\d+\/(?:s\d+x\d+_)?/i, '$1/n0/')
  }
  if (url.includes('.winxuancdn.com/')) {
    return url.split('?')[0]
  }
  return url
}

function parseImageDimensionsFromBuffer(buf: Buffer): { width: number; height: number } | null {
  if (!buf || buf.length < 24) return null
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = buf[offset + 1]
      if (marker === 0xff) {
        offset++
        continue
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const segLen = buf.readUInt16BE(offset + 2)
      if (segLen < 2) break
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
      }
      offset += 2 + segLen
    }
  }
  return null
}

interface RawCoverCandidate {
  title: string
  host: string
  w: number
  h: number
  thumbUrl: string
  hdUrl: string
}

function scoreCoverCandidate(cand: RawCoverCandidate, meta: CoverSearchMeta): number {
  const rawCandTitle = String(cand.title || '')
    .replace(/<[^>]+>/g, '')
    .replace(/哪咤/g, '哪吒')
  const normCandTitle = rawCandTitle.toLowerCase()
  const host = String(cand.host || '').toLowerCase()
  const hd = String(cand.hdUrl || '').toLowerCase()

  if (
    /暂无图片|暂无封面|无封面|默认封面|缺货|下架|nopic|no_pic|default_book/.test(normCandTitle) ||
    /电影《|动画电影|剧照|壁纸|表情包|手游|角色立绘|票房/.test(rawCandTitle) ||
    /已消毒|实体仓库|多件更优惠|发货快|可开发票|开具.*发票|图书城|专营店|支持正版|封面有破损|缺页|包退/.test(
      rawCandTitle
    )
  ) {
    return -999
  }

  let score = 0
  const normBase = meta.baseTitle.replace(/哪咤/g, '哪吒').toLowerCase()
  if (normBase && normCandTitle.includes(normBase)) {
    score += 50
  } else {
    score -= 80
  }

  if (meta.subSeries) {
    if (rawCandTitle.includes(meta.subSeries)) {
      score += 55
    } else {
      score -= 120
    }
  } else if (/总集篇|专题书/.test(rawCandTitle)) {
    score -= 75
  }

  if (meta.partToken) {
    if (meta.partToken === '全集') {
      if (/全集|全一册|大全集|合订本/.test(rawCandTitle)) {
        score += 48
      } else if (/系列|全\d*册/.test(rawCandTitle)) {
        score += 18
      } else if (/(?:^|[^上中下])(?:上册|下册|中册|（上）|（下）|\(上\)|\(下\))/.test(rawCandTitle)) {
        score -= 85
      }
    } else if (meta.partToken === '上') {
      if (/上册|（上）|\(上\)|[．·\s]上(?:[\s，,）)]|$)/.test(rawCandTitle)) {
        score += 48
      } else if (/上下/.test(rawCandTitle)) {
        score -= 20
      } else if (/下册|中册|（下）|（中）|\(下\)|\(中\)|全集|全一册/.test(rawCandTitle)) {
        score -= 85
      }
    } else if (meta.partToken === '中') {
      if (/中册|（中）|\(中\)|[．·\s]中(?:[\s，,）)]|$)/.test(rawCandTitle)) {
        score += 48
      } else if (/上册|下册|（上）|（下）|\(上\)|\(下\)|全集|全一册/.test(rawCandTitle)) {
        score -= 85
      }
    } else if (meta.partToken === '下') {
      if (/下册|（下）|\(下\)|[．·\s]下(?:[\s，,）)]|$)/.test(rawCandTitle)) {
        score += 48
      } else if (/上下/.test(rawCandTitle)) {
        score -= 20
      } else if (/上册|中册|（上）|（中）|\(上\)|\(中\)|全集|全一册/.test(rawCandTitle)) {
        score -= 85
      }
    }
  }

  if (meta.volNumber) {
    const vNum = meta.volNumber
    const vCnPat = numberToChineseVolumePattern(vNum)
    const escapedBase = meta.baseTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const subPat = meta.subSeries
      ? `(?:\\s*[.．·:：(\\（【\\[]?\\s*${meta.subSeries})?`
      : ''
    const exactVolRe = new RegExp(
      `(?:${escapedBase}${subPat}\\s*[.．·:：(\\（【\\[]?\\s*0?${vNum}(?:\\D|$)|第\\s*0?${vNum}\\s*[卷集册部辑回篇季]|[卷集册部辑]\\s*0?${vNum}(?:\\D|$)|(?:^|[\\s.．·:：(\\（【\\[])${vNum}(?:\\s*[卷集册部辑]|\\s*$|[，,：:\\s)）】\\]]))` +
        (vCnPat
          ? `|(?:${escapedBase}${subPat}\\s*[.．·:：(\\（【\\[]?\\s*(?:${vCnPat})(?:[)）】\\]：:\\s，,]|$)|第\\s*(?:${vCnPat})\\s*[卷集册部辑回篇季]|[卷集册部辑]\\s*(?:${vCnPat})|[(\\（【\\[](?:${vCnPat})[)）】\\]])`
          : '')
    )
    // 严厉排斥「4本合售 / 1-4 / 1.2.3.4 / 全套 / 套装」等多书书脊立拍图
    const bundleRe =
      /合售|\d+\s*[本册]合|[1一壹]\s*[-~至.、,，]\s*[2二贰3三叁4四肆5五伍6六7七8八9九]|全套|套装|大全集|全\d+[册本]|共[0-9一二三四五六七八九十]+[册本]/
    if (bundleRe.test(rawCandTitle)) {
      score -= 95
    } else if (exactVolRe.test(rawCandTitle)) {
      score += 65
    } else {
      const otherVolMatch = rawCandTitle.match(
        /(?:第\s*(\d+)\s*[卷集册部辑]|[卷集册部辑]\s*(\d+))/
      )
      if (otherVolMatch) {
        const candVol = otherVolMatch[1] || otherVolMatch[2]
        if (candVol && candVol !== vNum) {
          score -= 95
        }
      } else {
        score -= 70
      }
    }
  }

  if (meta.cleanAuthor && meta.cleanAuthor.length >= 2) {
    if (normCandTitle.includes(meta.cleanAuthor.toLowerCase())) {
      score += 35
    }
  }
  if (meta.cleanPublisher && meta.cleanPublisher.length >= 3) {
    const shortPub = meta.cleanPublisher.replace(/出版社|出版公司|出版集团/g, '')
    if (
      normCandTitle.includes(meta.cleanPublisher.toLowerCase()) ||
      (shortPub.length >= 2 && normCandTitle.includes(shortPub.toLowerCase()))
    ) {
      score += 42
    }
  }
  if (meta.cleanIsbn && normCandTitle.includes(meta.cleanIsbn.toLowerCase())) {
    score += 75
  }

  const isBaiduCpsAd =
    cand.thumbUrl.includes('fm=224') ||
    cand.thumbUrl.includes('app=112') ||
    /\/\/t1[345]\.baidu\.com\//i.test(cand.thumbUrl)

  if (
    /京东自营|当当自营|当当网正版|新华书店|文轩|博库|官方旗舰/.test(rawCandTitle) ||
    hd.includes('360buyimg.com') ||
    hd.includes('winxuancdn.com') ||
    host.includes('baike.baidu.com') ||
    host.includes('douban.com')
  ) {
    score += 65
  } else if (
    !isBaiduCpsAd &&
    (host.includes('jd.com') ||
      host.includes('京东') ||
      host.includes('dangdang.com') ||
      host.includes('当当'))
  ) {
    score += 42
  } else if (
    /正版|图书|书籍|出版|连环画/.test(rawCandTitle) ||
    host.includes('kongfz.com') ||
    host.includes('taobao.com') ||
    host.includes('tmall.com') ||
    host.includes('smzdm.com') ||
    host.includes('edu.cn') ||
    host.includes('weread.qq.com') ||
    host.includes('qq.com')
  ) {
    score += 25
  }

  if (/二手|旧书|闲鱼|转转|实拍|九成新|9成新|8成新|绝版旧书/.test(rawCandTitle)) {
    score -= 45
  }
  if (isBaiduCpsAd && !/新华文轩|文轩|博库|官方正版|自营|旗舰/.test(rawCandTitle)) {
    score -= 30
  } else if (cand.thumbUrl.includes('fm=253')) {
    score += 18
  }

  const w = Number(cand.w || 0)
  const h = Number(cand.h || 0)
  if (w > 0 && h > 0) {
    const ratio = h / w
    if (ratio >= 1.12 && ratio <= 1.68) {
      score += 20
    } else if (ratio >= 0.95 && ratio < 1.12) {
      score += 12
    } else if (ratio < 0.8 || ratio > 2.2) {
      score -= 35
    }
    if (w >= 450 && h >= 450) {
      score += 10
    }
  }

  if (cand.hdUrl) {
    score += 12
  }

  return score
}

async function searchInternetBookCover(
  title: string,
  author: string,
  publisher = '',
  isbn = ''
): Promise<string> {
  const meta = extractCoverSearchMeta(title, author, publisher, isbn)
  const normalizedVolTitle = meta.volNumber
    ? `${meta.baseTitle} ${meta.subSeries} 第${meta.volNumber}卷`.replace(/\s+/g, ' ').trim()
    : meta.cleanTitle

  const querySet = new Set<string>()
  // 若存在 ISBN，将「ISBN + 主书名」作为第 1 并发检索词，精准锁定对应单册版本（如《盗墓笔记(叁)》 9787505723856）
  if (meta.cleanIsbn) {
    querySet.add(
      `${meta.cleanIsbn} ${meta.baseTitle} ${meta.subSeries}`.replace(/\s+/g, ' ').trim()
    )
    querySet.add(
      `${normalizedVolTitle} ${meta.cleanAuthor} ${meta.cleanPublisher} 封面`
        .replace(/\s+/g, ' ')
        .trim()
    )
    querySet.add(
      `${meta.cleanTitle} ${meta.cleanAuthor} ${meta.cleanPublisher} 图书封面`
        .replace(/\s+/g, ' ')
        .trim()
    )
  } else {
    querySet.add(
      `${normalizedVolTitle} ${meta.cleanAuthor} ${meta.cleanPublisher} 图书封面`
        .replace(/\s+/g, ' ')
        .trim()
    )
    querySet.add(
      `${meta.cleanTitle} ${meta.cleanAuthor} 书籍封面`
        .replace(/\s+/g, ' ')
        .trim()
    )
  }
  const queries = [...querySet].filter(Boolean).slice(0, 3)

  const primaryQueries = queries.slice(0, 2)
  const fetchBaiduQuery = async (q: string): Promise<RawCoverCandidate[]> => {
    const list: RawCoverCandidate[] = []
    try {
      const bdUrl = `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&fp=result&word=${encodeURIComponent(q)}&pn=0&rn=12`
      const rawTxt = await fetch(bdUrl, {
        headers: {
          Accept: 'text/plain, */*; q=0.01',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `https://image.baidu.com/search/index?tn=baiduimage&word=${encodeURIComponent(q)}`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
        timeoutMs: 6000,
      }).then((r) => r.text())

      try {
        const bdJson = JSON.parse(rawTxt)
        for (const d of bdJson?.data || []) {
          const rawThumb = String(d?.middleURL || d?.thumbURL || d?.hoverURL || '').trim()
          const thumbUrl = repairCoverUrl(rawThumb)
          if (!thumbUrl || isPlaceholderCoverUrl(thumbUrl) || !isSafePublicHttpUrl(thumbUrl)) {
            continue
          }
          const rawObj = String(d?.replaceUrl?.[0]?.ObjURL || d?.replaceUrl?.[0]?.ObjUrl || '').trim()
          const hdUrl = normalizeTrustedHdImageUrl(rawObj)
          list.push({
            title: String(d?.fromPageTitleEnc || d?.fromPageTitle || '').trim(),
            host: String(d?.fromURLHost || d?.replaceUrl?.[0]?.FromURL || '').trim(),
            w: Number(d?.width || 0),
            h: Number(d?.height || 0),
            thumbUrl,
            hdUrl,
          })
        }
      } catch {
        const matches = rawTxt.matchAll(/"(?:thumbURL|middleURL)"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/g)
        for (const m of matches) {
          if (m[1]) {
            const thumbUrl = repairCoverUrl(m[1].replace(/\\\//g, '/'))
            if (thumbUrl && !isPlaceholderCoverUrl(thumbUrl) && isSafePublicHttpUrl(thumbUrl)) {
              list.push({
                title: meta.cleanTitle,
                host: '',
                w: 500,
                h: 667,
                thumbUrl,
                hdUrl: '',
              })
            }
          }
        }
      }
    } catch {
      // ignore single query error
    }
    return list
  }

  const candidateBatches = await Promise.all(primaryQueries.map((q) => fetchBaiduQuery(q)))
  const pooledCandidates: RawCoverCandidate[] = []
  const seenThumbUrls = new Set<string>()
  for (const batch of candidateBatches) {
    for (const c of batch) {
      if (seenThumbUrls.has(c.thumbUrl)) continue
      seenThumbUrls.add(c.thumbUrl)
      pooledCandidates.push(c)
    }
  }

  if (pooledCandidates.length === 0 && queries[2]) {
    const backupBatch = await fetchBaiduQuery(queries[2])
    for (const c of backupBatch) {
      if (!seenThumbUrls.has(c.thumbUrl)) {
        seenThumbUrls.add(c.thumbUrl)
        pooledCandidates.push(c)
      }
    }
  }

  if (pooledCandidates.length > 0) {
    const scored = pooledCandidates
      .map((c) => ({ cand: c, score: scoreCoverCandidate(c, meta) }))
      .filter((x) => x.score > -200)
      .sort((a, b) => b.score - a.score)

    if (scored.length > 0) {
      const best = scored[0].cand
      return best.thumbUrl
    }
  }

  // 引擎 2：必应图片搜索兜底（www.bing.com/images/async，解析标题与原图 murl 进行多级打分）
  for (const q of queries.slice(0, 2)) {
    try {
      const bingUrl = `https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=0&count=10&mmasync=1&cc=cn`
      const html = await fetch(bingUrl, {
        headers: {
          Referer: 'https://cn.bing.com/images/',
        },
        timeoutMs: 6000,
      }).then((r) => r.text())

      const bingCands: RawCoverCandidate[] = []
      const cardMatches = html.matchAll(/m="([^"]+)"/gi)
      for (const m of cardMatches) {
        try {
          const rawJson = (m[1] || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
          const obj = JSON.parse(rawJson)
          const rawTurl = repairCoverUrl(obj?.turl || '')
          const hdMurl = normalizeTrustedHdImageUrl(obj?.murl || '')
          const thumbUrl = hdMurl || rawTurl
          if (!thumbUrl || isPlaceholderCoverUrl(thumbUrl) || !isSafePublicHttpUrl(thumbUrl)) {
            continue
          }
          bingCands.push({
            title: String(obj?.t || obj?.desc || '').trim(),
            host: String(obj?.purl || '').trim(),
            w: 600,
            h: 800,
            thumbUrl,
            hdUrl: hdMurl,
          })
        } catch {
          // ignore malformed card
        }
      }

      if (bingCands.length > 0) {
        const scored = bingCands
          .map((c) => ({ cand: c, score: scoreCoverCandidate(c, meta) }))
          .filter((x) => x.score > -200)
          .sort((a, b) => b.score - a.score)
        if (scored.length > 0) {
          const best = scored[0].cand
          return best.thumbUrl
        }
      }
    } catch {
      // ignore
    }
  }
  return ''
}

function hexToBase64(hexStr: string): string {
  return Buffer.from(hexStr, 'hex').toString('base64')
}

function encryptZjlibPassword(plainText: string): string {
  const hexCipher = smCrypto.sm2.doEncrypt(plainText, ZJLIB_SM2_PUBLIC_KEY, 1)
  return hexToBase64(hexCipher)
}

function encryptHzlibPassword(plainText: string, rawPemKey: string): string {
  const cleanBase64 = rawPemKey.replace(/-----BEGIN PUBLIC KEY-----/g, '').replace(/-----END PUBLIC KEY-----/g, '').replace(/\s+/g, '')
  const wrappedPem = `-----BEGIN PUBLIC KEY-----\n${cleanBase64.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`
  const encrypted = crypto.publicEncrypt(
    {
      key: wrappedPem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(plainText, 'utf8')
  )
  return encrypted.toString('base64')
}

interface RawHzlibRow {
  actionType: string
  barcode: string
  title: string
  isbn: string
  author: string
  callNo: string
  subLibrary: string
  docType: string
  loanDate: string
  dueDate: string
  processDate: string
  bibId: string
  renewCount?: number
}

function parseHzlibRenewListPage(html: string): {
  pdsToken: string
  rowsByBarcode: Map<string, { barcode: string; title: string; loanDate: string; dueDate: string; renewCount: number }>
} {
  const $ = cheerio.load(html)
  const pdsToken = String($('input[name="pdsToken"]').val() || '').trim()
  const rowsByBarcode = new Map<
    string,
    { barcode: string; title: string; loanDate: string; dueDate: string; renewCount: number }
  >()
  const { rows } = parseHzlibTableRows(html)
  for (const r of rows) {
    if (!r.barcode) continue
    rowsByBarcode.set(r.barcode, {
      barcode: r.barcode,
      title: r.title,
      loanDate: r.loanDate,
      dueDate: r.dueDate,
      renewCount: typeof r.renewCount === 'number' && !Number.isNaN(r.renewCount) ? r.renewCount : 0,
    })
  }
  return { pdsToken, rowsByBarcode }
}

function parseHzlibTableRows(html: string): { rows: RawHzlibRow[]; hasNextPage: boolean } {
  const $ = cheerio.load(html)
  const headers: string[] = []
  const rows: RawHzlibRow[] = []

  const table = $('#contentTable').length ? $('#contentTable') : $('table').first()
  table
    .find('tr')
    .first()
    .find('th, td')
    .each((_, el) => {
      const clone = $(el).clone()
      clone.find('select, script, style').remove()
      headers.push(clone.text().replace(/\s+/g, '').trim().toLowerCase())
    })

  table
    .find('tr')
    .slice(1)
    .each((_, row) => {
      const cells = $(row).find('td')
      if (cells.length < 3) return

      const rowMap: Record<string, string> = {}
      let bookrecno = ''

      cells.each((idx, cell) => {
        const header = headers[idx] || `col_${idx}`
        const text = $(cell).text().replace(/\s+/g, ' ').trim()
        rowMap[header] = text
        const link = $(cell).find('a[href*="/book/"]').attr('href')
        if (link) {
          const m = link.match(/\/book\/([0-9a-zA-Z_-]+)/)
          if (m) bookrecno = m[1]
        }
      })

      const title =
        rowMap['题名'] ||
        rowMap['书名'] ||
        rowMap['题名/责任者']?.split('/')[0]?.trim() ||
        ''
      if (!title) return

      const author =
        rowMap['著者'] ||
        rowMap['责任者'] ||
        rowMap['作者'] ||
        (rowMap['题名/责任者']?.includes('/')
          ? rowMap['题名/责任者'].split('/').slice(1).join('/').trim()
          : '') ||
        ''

      rows.push({
        actionType: rowMap['操作类型'] || '',
        barcode: (rowMap['条码号'] || rowMap['图书条码'] || '').trim(),
        title: title.trim(),
        isbn: (rowMap['isbn'] || rowMap['isbn/issn'] || '').trim(),
        author: author.trim(),
        callNo: (rowMap['索书号'] || '').trim(),
        subLibrary:
          (rowMap['馆藏地点'] || rowMap['馆藏地'] || rowMap['所属馆'] || rowMap['借阅地点'] || '').trim() ||
          '杭州图书馆',
        docType: (rowMap['文献类型'] || '').trim(),
        loanDate: (rowMap['借出时间'] || rowMap['借出日期'] || rowMap['借书日期'] || '').slice(0, 10),
        dueDate: (rowMap['应还日期'] || rowMap['应还时间'] || rowMap['到期日期'] || '').slice(0, 10),
        processDate: (
          rowMap['处理时间'] ||
          rowMap['归还日期'] ||
          rowMap['还书日期'] ||
          rowMap['操作日期'] ||
          ''
        ).slice(0, 10),
        bibId: bookrecno,
        renewCount:
          rowMap['续借次数'] !== undefined && rowMap['续借次数'] !== ''
            ? Number(rowMap['续借次数'])
            : undefined,
      })
    })

  const hasNextPage = $('input[name="hasNextPage"]').val() === 'true'
  return { rows, hasNextPage }
}

function buildNormalizedHzlibRecords(
  currentRows: RawHzlibRow[],
  historyRows: RawHzlibRow[],
  renewByBarcode?: Map<string, { barcode: string; title: string; loanDate: string; dueDate: string; renewCount: number }>
) {
  const currentRecords: any[] = []
  // Track active borrows so we can match and skip their corresponding '借书' row in historyLoanList
  const activeBorrowSkipCount = new Map<string, number>()

  for (const r of currentRows) {
    const key = `${r.barcode}:${r.loanDate}`
    activeBorrowSkipCount.set(key, (activeBorrowSkipCount.get(key) || 0) + 1)
    let inferredRenew = 0
    const exactRenewEntry = renewByBarcode?.get(r.barcode)
    if (exactRenewEntry && typeof exactRenewEntry.renewCount === 'number') {
      inferredRenew = exactRenewEntry.renewCount
    } else if (typeof r.renewCount === 'number' && !Number.isNaN(r.renewCount)) {
      inferredRenew = r.renewCount
    } else if (r.loanDate && r.dueDate) {
      const span = Math.round(
        (new Date(r.dueDate).getTime() - new Date(r.loanDate).getTime()) / 86400000
      )
      if (span > 60) inferredRenew = 2
      else if (span > 43) inferredRenew = 1
    }
    currentRecords.push({
      id: `hzlib:${r.barcode}:${r.loanDate || 'current'}`,
      library: 'hzlib',
      subLibrary: r.subLibrary || '杭州图书馆',
      status: 'borrowed',
      title: r.title,
      author: r.author,
      isbn: r.isbn,
      callNo: r.callNo,
      barcode: r.barcode,
      bibId: r.bibId,
      loanDate: r.loanDate,
      dueDate: r.dueDate,
      returnDate: '',
      renewCount: inferredRenew,
      coverUrl: '',
    })
  }

  // Group history rows by barcode to pair '借书' (borrow) and '还书' (return) events
  const byBarcode = new Map<string, RawHzlibRow[]>()
  for (const r of historyRows) {
    const key = r.barcode || r.title
    if (!byBarcode.has(key)) byBarcode.set(key, [])
    byBarcode.get(key)!.push(r)
  }

  const historyRecords: any[] = []

  for (const [barcodeKey, group] of byBarcode.entries()) {
    // historyLoanList is newest-first; reverse so it is chronological (oldest -> newest)
    const chronological = [...group].reverse()
    const pendingBorrows: RawHzlibRow[] = []

    for (const item of chronological) {
      const act = item.actionType
      if (act.includes('借')) {
        const activeKey = `${item.barcode}:${item.processDate}`
        const skipLeft = activeBorrowSkipCount.get(activeKey) || 0
        if (skipLeft > 0) {
          // This '借书' row belongs to one of the currently borrowed books in currentLoanList
          activeBorrowSkipCount.set(activeKey, skipLeft - 1)
          continue
        }
        pendingBorrows.push(item)
      } else if (act.includes('还')) {
        const matchedBorrow = pendingBorrows.shift()
        const loanDate = matchedBorrow?.processDate || item.loanDate || item.processDate
        const returnDate = item.processDate
        historyRecords.push({
          id: `hzlib:${barcodeKey}:${loanDate}:${returnDate}`,
          library: 'hzlib',
          subLibrary: item.subLibrary || matchedBorrow?.subLibrary || '杭州图书馆',
          status: 'returned',
          title: item.title || matchedBorrow?.title || '',
          author: item.author || matchedBorrow?.author || '',
          isbn: item.isbn || matchedBorrow?.isbn || '',
          callNo: item.callNo || matchedBorrow?.callNo || '',
          barcode: item.barcode || matchedBorrow?.barcode || '',
          bibId: item.bibId || matchedBorrow?.bibId || '',
          loanDate,
          dueDate: '',
          returnDate,
          renewCount: 0,
          coverUrl: '',
        })
      }
    }

    // Any remaining unmatched '借书' rows that aren't in currentLoanList
    for (const leftover of pendingBorrows) {
      const isStillBorrowed = currentRecords.some((c) => c.barcode === leftover.barcode)
      if (isStillBorrowed) continue
      historyRecords.push({
        id: `hzlib:${barcodeKey}:${leftover.processDate}:hist`,
        library: 'hzlib',
        subLibrary: leftover.subLibrary || '杭州图书馆',
        status: 'returned',
        title: leftover.title,
        author: leftover.author,
        isbn: leftover.isbn,
        callNo: leftover.callNo,
        barcode: leftover.barcode,
        bibId: leftover.bibId,
        loanDate: leftover.processDate,
        dueDate: '',
        returnDate: '',
        renewCount: 0,
        coverUrl: '',
      })
    }
  }

  // Sort history records newest loanDate first
  historyRecords.sort((a, b) =>
    (b.loanDate || b.returnDate || '').localeCompare(a.loanDate || a.returnDate || '')
  )

  return { currentRecords, historyRecords }
}

const MAX_JSON_BODY_BYTES = 256 * 1024 // 256 KB

async function readJsonBody(req: any): Promise<any> {
  if (req.body && typeof req.body === 'object') {
    return req.body
  }
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > MAX_JSON_BODY_BYTES) {
      throw Object.assign(new Error('请求体过大，已拒绝处理 (最大 256KB)'), { statusCode: 413 })
    }
    return req.body ? JSON.parse(req.body) : {}
  }
  return new Promise((resolve, reject) => {
    let body = ''
    let totalBytes = 0
    let aborted = false
    req.on('data', (chunk: any) => {
      if (aborted) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      totalBytes += buf.byteLength
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        aborted = true
        reject(Object.assign(new Error('请求体过大，已拒绝处理 (最大 256KB)'), { statusCode: 413 }))
        return
      }
      body += buf.toString('utf8')
    })
    req.on('end', () => {
      if (aborted) return
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

// 公开无状态检索/馆藏查询 45 秒微缓存（仅用于 100% 公共书目数据，不含任何用户个人数据）
const PUBLIC_QUERY_CACHE_TTL_MS = 45 * 1000
const MAX_PUBLIC_QUERY_CACHE = 150
const publicQueryCache = new Map<string, { expiresAt: number; payloadJson: string }>()

function getPublicQueryCache(key: string): string | null {
  const hit = publicQueryCache.get(key)
  if (!hit) return null
  if (hit.expiresAt <= Date.now()) {
    publicQueryCache.delete(key)
    return null
  }
  return hit.payloadJson
}

function setPublicQueryCache(key: string, payloadObj: any): string {
  const now = Date.now()
  if (publicQueryCache.size >= MAX_PUBLIC_QUERY_CACHE) {
    for (const [k, v] of publicQueryCache.entries()) {
      if (v.expiresAt <= now) publicQueryCache.delete(k)
    }
    if (publicQueryCache.size >= MAX_PUBLIC_QUERY_CACHE) {
      const oldestKey = publicQueryCache.keys().next().value
      if (oldestKey) publicQueryCache.delete(oldestKey)
    }
  }
  const payloadJson = JSON.stringify(payloadObj)
  publicQueryCache.set(key, {
    expiresAt: now + PUBLIC_QUERY_CACHE_TTL_MS,
    payloadJson,
  })
  return payloadJson
}

// 公网多用户并发限流器（按 IP + 接口类别滑动窗口计数）
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

function getClientIp(req: any): string {
  const h = req?.headers || {}
  // 优先读取 Vercel 边缘网关注入的不可伪造真实 IP 头
  const xvff = h['x-vercel-forwarded-for']
  if (typeof xvff === 'string' && xvff.trim()) {
    return xvff.split(',')[0].trim()
  }
  if (typeof h['x-real-ip'] === 'string' && h['x-real-ip'].trim()) {
    return h['x-real-ip'].trim()
  }
  const xff = h['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim()
  }
  return String(req?.socket?.remoteAddress || '127.0.0.1')
}

function checkRateLimit(req: any, route: string): { allowed: boolean; retryAfterSec: number } {
  if (route === '/api/health' || route === '/api/version') {
    return { allowed: true, retryAfterSec: 0 }
  }
  const now = Date.now()
  if (rateLimitBuckets.size > 5000) {
    for (const [k, v] of rateLimitBuckets.entries()) {
      if (v.resetAt <= now) rateLimitBuckets.delete(k)
    }
  }
  const isAuthRoute =
    route.includes('/sync') ||
    route.includes('/renew') ||
    route.includes('/captcha') ||
    route.includes('/qr')
  const maxPerMinute = isAuthRoute ? 25 : 80
  const bucketKey = `${getClientIp(req)}::${isAuthRoute ? 'auth' : 'query'}`
  const entry = rateLimitBuckets.get(bucketKey)
  if (!entry || entry.resetAt <= now) {
    rateLimitBuckets.set(bucketKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { allowed: true, retryAfterSec: 0 }
  }
  entry.count += 1
  if (entry.count > maxPerMinute) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    }
  }
  return { allowed: true, retryAfterSec: 0 }
}

function applyApiSecurityGuard(req: any, res: any, route: string): boolean {
  const reqId = crypto.randomBytes(3).toString('hex')
  req.__reqId = reqId
  req.__route = route
  req.__startAt = Date.now()
  res.setHeader('X-Request-Id', reqId)
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')

  if ((req.method || 'GET').toUpperCase() === 'POST') {
    const headers = req.headers || {}
    const secFetchSite = String(headers['sec-fetch-site'] || '').toLowerCase()
    if (secFetchSite === 'cross-site') {
      res.statusCode = 403
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, message: '已拦截跨站请求 (CSRF Protection)' }))
      return false
    }
    const origin = String(headers.origin || '').trim()
    const host = String(headers['x-forwarded-host'] || headers.host || '').trim()
    if (origin && host) {
      try {
        const originHost = new URL(origin).host.toLowerCase()
        const targetHost = host.split(',')[0].trim().toLowerCase()
        if (originHost && targetHost && originHost !== targetHost) {
          res.statusCode = 403
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, message: '请求来源域名不匹配，已拒绝访问' }))
          return false
        }
      } catch {
        res.statusCode = 403
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, message: '非法的 Origin 请求头' }))
        return false
      }
    }
  }

  const rate = checkRateLimit(req, route)
  if (!rate.allowed) {
    res.statusCode = 429
    res.setHeader('Retry-After', String(rate.retryAfterSec))
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify({
        ok: false,
        message: `请求过于频繁，请 ${rate.retryAfterSec} 秒后再试`,
      })
    )
    return false
  }

  return true
}

const HZLIB_CAPTCHA_FIELD_NAMES = [
  'returnCode',
  'randomCode',
  'validateCode',
  'vcode',
  'checkCode',
  'code',
  'verifyCode',
  'validCode',
  'vercode',
  'verCode',
  'captcha',
  'captchaCode',
  'rand',
  'randCode',
  'imageCode',
  'imgCode',
  'authCode',
  'securityCode',
  'rdVcode',
  'rdValidateCode',
  'loginValidateCode',
  'loginCode',
  'vcodeImg',
  'j_captcha',
  'kaptcha',
  'inputCode',
  'validate',
  'vc',
  'yzm',
  'checkcode',
]

async function createHzlibCaptchaSession(ua: string, includeCaptchaImage = true) {
  const loginRes = await fetch('https://my1.zjhzlib.cn/opac/reader/login', {
    headers: { 'User-Agent': ua },
  })
  const setCookies = loginRes.headers.getSetCookie?.() || [loginRes.headers.get('set-cookie') || '']
  const jsessionMatch = setCookies.join('; ').match(/JSESSIONID=[^;]+/)
  const sessionCookie = jsessionMatch ? jsessionMatch[0] : ''

  const pemRes = await fetch(
    `https://my1.zjhzlib.cn/opac/certificate/pem?checkCode=${Date.now()}opac`,
    {
      headers: { 'User-Agent': ua, Cookie: sessionCookie },
    }
  )
  const pemKey = await pemRes.text()

  if (!includeCaptchaImage) {
    return { sessionCookie, pemKey, captchaImage: '' }
  }

  const vcRes = await fetch(
    `https://my1.zjhzlib.cn/opac/validateCodeImage?r=${Math.random()}`,
    {
      headers: { 'User-Agent': ua, Cookie: sessionCookie },
    }
  )
  const vcBuf = Buffer.from(await vcRes.arrayBuffer())
  const captchaImage = `data:image/jpeg;base64,${vcBuf.toString('base64')}`

  return { sessionCookie, pemKey, captchaImage }
}

export function registerLibraryApiMiddlewares(rawServer: {
  middlewares: { use: (route: string, fn: (req: any, res: any, next?: any) => any) => void }
}) {
      const server = {
        middlewares: {
          use(route: string, fn: (req: any, res: any, next?: any) => any) {
            rawServer.middlewares.use(route, async (req: any, res: any, next?: any) => {
              if (!applyApiSecurityGuard(req, res, route)) return
              return await fn(req, res, next)
            })
          },
        },
      }
      server.middlewares.use('/api/version', (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(
          JSON.stringify({
            ok: true,
            version: versionInfo.version,
            updatedAt: versionInfo.updatedAt,
            description: versionInfo.description,
            env: process.env.VERCEL ? 'vercel' : 'local',
            region: process.env.VERCEL_REGION || 'local',
            serverTime: new Date().toISOString(),
          })
        )
      })

      server.middlewares.use('/api/health', async (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        const urlObj = new URL(req.url || '', 'http://localhost')
        const probe = urlObj.searchParams.get('probe') === '1'
        let upstreams: any = undefined
        if (probe) {
          const targets = [
            {
              name: 'zjlib_bff',
              url: 'https://www.zjlib.cn/bff-api/reader-sso-service/portal-pc-api/login/wechat-qr',
              headers: { 'BFF-ORG-ID': ZJLIB_ORG_ID },
            },
            { name: 'hzlib_opac', url: 'https://my1.zjhzlib.cn/opac/reader/login' },
            {
              name: 'dataesb_cover',
              url: 'https://book-resource.dataesb.com/websearch/metares?glc=P1ZJ0571001&cmdACT=getImages&type=0&isbns=9787020002207&callback=cb',
            },
          ]
          upstreams = await Promise.all(
            targets.map(async (t) => {
              const t0 = Date.now()
              try {
                const r = await singleNodeHttpRequest(t.url, {
                  method: 'GET',
                  headers: (t as any).headers,
                  redirect: 'manual',
                  timeoutMs: 6000,
                })
                return {
                  name: t.name,
                  host: new URL(t.url).hostname,
                  ok: r.status > 0 && r.status < 500,
                  status: r.status,
                  latencyMs: Date.now() - t0,
                }
              } catch (e: any) {
                return {
                  name: t.name,
                  host: new URL(t.url).hostname,
                  ok: false,
                  status: 0,
                  latencyMs: Date.now() - t0,
                  errorCode: String(e?.code || 'ERR'),
                }
              }
            })
          )
        }
        res.end(
          JSON.stringify({
            ok: true,
            status: 'healthy',
            version: versionInfo.version,
            region: process.env.VERCEL_REGION || 'local',
            relayConfigured: Boolean(getUpstreamRelayConfig().relayUrl),
            timestamp: new Date().toISOString(),
            recentErrorCount: recentDiagnosticErrors.length,
            ...(probe ? { upstreams, recentErrors: recentDiagnosticErrors } : {}),
          })
        )
      })

      server.middlewares.use('/api/hzlib/latest-cache', (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(
          JSON.stringify({
            ok: false,
            records: [],
            message: 'disabled for multi-user isolation',
          })
        )
      })

      // 0A. 百度地图基层分馆/杭州书房动态 POI 坐标解析与 17 级精准定位跳转 (/api/map/go)
      server.middlewares.use('/api/map/go', async (req, res) => {
        const urlObj = new URL(req.url || '', 'http://localhost')
        const q = (urlObj.searchParams.get('q') || '杭州图书馆').trim()
        const c = urlObj.searchParams.get('c') || '179'
        const fallbackUrl = `https://map.baidu.com/?newmap=1&ie=utf-8&s=${encodeURIComponent(`s&wd=${q}&c=${c}`)}`
        try {
          const apiUrl = `https://map.baidu.com/?newmap=1&reqflag=pcmap&biz=1&from=webmap&da_par=direct&pcevaname=pc4.1&qt=s&da_src=searchBox.button&wd=${encodeURIComponent(q)}&c=${encodeURIComponent(c)}&pn=0&nn=0`
          const r = await fetch(apiUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
          }).then((resp) => resp.json())
          const first = Array.isArray(r?.content) ? r.content[0] : null
          if (first && first.uid && first.x && first.y && first.name) {
            const coordX = (Number(first.x) / 100).toFixed(2)
            const coordY = (Number(first.y) / 100).toFixed(2)
            const poiUrl = `https://map.baidu.com/poi/${encodeURIComponent(first.name)}/@${coordX},${coordY},17z?uid=${encodeURIComponent(first.uid)}&poiShareUid=${encodeURIComponent(first.uid)}&querytype=s&da_src=shareurl&wd=${encodeURIComponent(first.name)}&c=${encodeURIComponent(c)}&info_merge=1&isBizPoi=false`
            res.statusCode = 302
            res.setHeader('Location', poiUrl)
            res.end()
            return
          }
        } catch {
          // ignore and fallback
        }
        res.statusCode = 302
        res.setHeader('Location', fallbackUrl)
        res.end()
      })

      // 0. 杭州图书馆获取图形验证码会话 (/api/hzlib/captcha)
      server.middlewares.use('/api/hzlib/captcha', async (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const urlObj = new URL(req.url || '', 'http://localhost')
          const mode = (urlObj.searchParams.get('mode') || '').trim()
          const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          const bundle = await createHzlibCaptchaSession(ua, mode !== 'init')
          res.end(JSON.stringify({ ok: true, ...bundle }))
        } catch (err: any) {
          res.statusCode = err?.statusCode || 500
          res.end(
            JSON.stringify({
              ok: false,
              reqId: req.__reqId,
              message: formatUpstreamError(err, '获取验证码失败', req, '/api/hzlib/captcha'),
            })
          )
        }
      })

      // 0B-0. 浙江图书馆官方封面动态签名重定向代理（解决 tc-cover-prod.oss 签名 2 小时过期问题）
      server.middlewares.use('/api/covers/zjlib-image', async (req, res) => {
        try {
          const urlObj = new URL(req.url || '', 'http://localhost')
          const isbn = (urlObj.searchParams.get('isbn') || '').replace(/[^0-9Xx]/g, '').toUpperCase()
          const bibId = (urlObj.searchParams.get('bibId') || '').trim()
          if (!isbn && !bibId) {
            res.statusCode = 400
            res.end('Missing isbn or bibId')
            return
          }
          const zjResp: any = await fetch(
            `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/search/getCoverImageByIsbn`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'BFF-ORG-ID': ZJLIB_ORG_ID,
                Origin: 'https://www.zjlib.cn',
                Referer: 'https://www.zjlib.cn/',
              },
              body: JSON.stringify({ isbn, bibId }),
              timeoutMs: 5000,
            }
          ).then((r) => r.json())
          const signedUrl = String(zjResp?.data || '').trim()
          if (zjResp?.code === 200 && signedUrl && isSafePublicHttpUrl(signedUrl)) {
            res.statusCode = 302
            res.setHeader('Cache-Control', 'public, max-age=3600')
            res.setHeader('Location', signedUrl)
            res.end()
            return
          }
        } catch {
          // ignore
        }
        res.statusCode = 404
        res.end('Not Found')
      })

      // 0B. 批量获取图书封面接口：优先图书馆官方接口(dataesb + 浙图) -> 互联网图书封面兜底 (/api/covers/resolve)
      server.middlewares.use('/api/covers/resolve', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false }))
          return
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const body = await readJsonBody(req)
          const forceInternet = Boolean(body.forceInternet)
          const items: Array<{
            id: string
            isbn?: string
            title?: string
            author?: string
            publisher?: string
          }> = Array.isArray(body.items) ? body.items.slice(0, 35) : []
          const cache = await loadCoverCache()
          const resolvedById: Record<string, string> = {}
          const unresolved: Array<{
            id: string
            cleanIsbn: string
            candidateIsbns: string[]
            title: string
            author: string
            publisher: string
            cacheKey: string
            legacyIsbnKey: string
            meta: CoverSearchMeta
          }> = []

          for (const item of items) {
            const cleanIsbn = (item.isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase()
            const title = (item.title || '').trim()
            const author = (item.author || '').trim()
            const publisher = (item.publisher || '').trim()
            const meta = extractCoverSearchMeta(title, author, publisher, cleanIsbn)
            const hasVolOrPart = Boolean(meta.partToken || meta.volNumber)
            const legacyIsbnKey = cleanIsbn ? `isbn:${cleanIsbn}` : ''
            const cacheKey = cleanIsbn
              ? hasVolOrPart
                ? `isbn:${cleanIsbn}:${title}`
                : `isbn:${cleanIsbn}`
              : `title:${title}|${meta.cleanAuthor}|${meta.cleanPublisher}`
            const rawHitUrl =
              cache[cacheKey] ||
              (!hasVolOrPart && legacyIsbnKey ? cache[legacyIsbnKey] : '') ||
              (!hasVolOrPart && cache[`title:${title}`] ? cache[`title:${title}`] : '')
            const hitUrl = rawHitUrl ? repairCoverUrl(rawHitUrl) : ''
            if (
              !forceInternet &&
              hitUrl &&
              !isPlaceholderCoverUrl(hitUrl)
            ) {
              resolvedById[item.id] = hitUrl
            } else {
              unresolved.push({
                id: item.id,
                cleanIsbn,
                candidateIsbns: cleanIsbn ? [cleanIsbn] : [],
                title,
                author,
                publisher,
                cacheKey,
                legacyIsbnKey,
                meta,
              })
            }
          }

          // Step 0: 针对无 ISBN 的借阅记录，或带分卷号但原 ISBN 为多册合订套书 ISBN（如《航海王．幽灵岛．卷五十一》共用套书 ISBN）的记录，通过浙图公开目录检索补全单册精准 ISBN
          const skipDirectLibraryCoverTiers =
            forceInternet || Boolean(process.env.VERCEL || process.env.VERCEL_REGION)
          const missingIsbnItems = (skipDirectLibraryCoverTiers ? [] : unresolved).filter(
            (u) => (!u.cleanIsbn || Boolean(u.meta.volNumber)) && Boolean(u.title)
          )
          if (missingIsbnItems.length > 0) {
            const zjLookupConcurrency = 6
            for (let i = 0; i < missingIsbnItems.length; i += zjLookupConcurrency) {
              const batch = missingIsbnItems.slice(i, i + zjLookupConcurrency)
              await Promise.all(
                batch.map(async (u) => {
                  try {
                    const cleanKw =
                      u.title
                        .replace(/[《》「」【】()（）．·:：；;，,]/g, ' ')
                        .replace(/\b(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|II|III|IV|VI|VII|VIII|IX|\d+)\b/gi, ' ')
                        .replace(/\s+[a-zA-Z\s]+$/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim() || u.title
                    const rawVolPhrase = (
                      u.title.match(
                        /第?\s*[0-9一二三四五六七八九十百壹贰叁肆伍陆柒捌玖拾ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*[卷集册部辑]|[卷集册部辑]\s*[0-9一二三四五六七八九十百壹贰叁肆伍陆柒捌玖拾ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+/
                      ) || ['']
                    )[0].trim()
                    const volDirectKw =
                      rawVolPhrase && u.meta.baseTitle
                        ? [u.meta.baseTitle, u.meta.subSeries, rawVolPhrase]
                            .filter(Boolean)
                            .join(' ')
                            .trim()
                        : ''
                    const kwSet = [...new Set([volDirectKw, cleanKw].filter(Boolean))]
                    const respList = await Promise.all(
                      kwSet.map((kw) =>
                        fetch(`${ZJLIB_API_BASE}/search-admin-service/open-api/search/pageList`, {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json;charset=UTF-8',
                            'BFF-ORG-ID': ZJLIB_ORG_ID,
                            Origin: 'https://www.zjlib.cn',
                            Referer: 'https://www.zjlib.cn/ResultList',
                          },
                          body: JSON.stringify({
                            metadataType: 'work',
                            current: 1,
                            size: 10,
                            query: [
                              {
                                id: 0,
                                key: 'title',
                                value: kw,
                                match: 'phrase_fuzzy',
                                condition: 'and',
                              },
                            ],
                            sortBy: [],
                          }),
                          timeoutMs: 4500,
                        })
                          .then((r) => r.json())
                          .catch(() => null)
                      )
                    )
                    const records: any[] = respList.flatMap((r) => r?.data?.records || [])
                    const scoredRecs = records
                      .map((rec: any) => {
                        const rTitle = String(
                          Array.isArray(rec.title) ? rec.title[0] : rec.title || ''
                        ).trim()
                        const rPub = String(
                          Array.isArray(rec.publisher) ? rec.publisher[0] : rec.publisher || ''
                        ).trim()
                        const rIsbnRaw = Array.isArray(rec.identifierIsbn)
                          ? rec.identifierIsbn[0]
                          : rec.identifierIsbn || ''
                        const rIsbn = String(rIsbnRaw).replace(/[^0-9Xx]/g, '').toUpperCase()
                        if (rIsbn.length < 10) return null
                        const rMeta = extractCoverSearchMeta(rTitle, '', rPub, rIsbn)
                        if (rMeta.baseTitle !== u.meta.baseTitle) return null
                        if (rMeta.subSeries !== u.meta.subSeries) return null
                        let matchScore = 0
                        if (rMeta.baseTitle === u.meta.baseTitle) matchScore += 40
                        if (u.meta.volNumber) {
                          if (rMeta.volNumber === u.meta.volNumber) {
                            matchScore += 60
                            // 优先单行本编目（如《航海王．卷五十一》优于多册共用套书ISBN的《航海王．幽灵岛．11名超新星．卷五十一》）
                            const segCount = rTitle.split(/[．·:：]/).length
                            if (segCount <= 2) matchScore += 18
                          } else if (rMeta.volNumber && rMeta.volNumber !== u.meta.volNumber) {
                            return null
                          }
                        }
                        if (u.meta.partToken && rMeta.partToken === u.meta.partToken) {
                          matchScore += 50
                        }
                        if (matchScore <= 0) return null
                        return { rIsbn, rPub, matchScore }
                      })
                      .filter(Boolean) as Array<{
                      rIsbn: string
                      rPub: string
                      matchScore: number
                    }>
                    scoredRecs.sort((a, b) => b.matchScore - a.matchScore)
                    const orderedIsbns: string[] = []
                    for (const sr of scoredRecs) {
                      if (!orderedIsbns.includes(sr.rIsbn) && orderedIsbns.length < 5) {
                        orderedIsbns.push(sr.rIsbn)
                      }
                      if (!u.publisher && sr.rPub) {
                        u.publisher = sr.rPub
                        u.meta = extractCoverSearchMeta(
                          u.title,
                          u.author,
                          u.publisher,
                          u.cleanIsbn
                        )
                      }
                    }
                    if (u.cleanIsbn && !orderedIsbns.includes(u.cleanIsbn)) {
                      orderedIsbns.push(u.cleanIsbn)
                    }
                    if (orderedIsbns.length > 0) {
                      u.candidateIsbns = orderedIsbns
                    }
                  } catch {
                    // ignore single lookup error
                  }
                })
              )
            }
          }

          // Tier 1: 图创/杭图官方封面中心 (book-resource.dataesb.com)
          const isbnsToQuery = [
            ...new Set(
              (skipDirectLibraryCoverTiers ? [] : unresolved)
                .flatMap((u) => u.candidateIsbns)
                .filter((s) => s.length >= 10)
            ),
          ]
          const isbnCoverMap: Record<string, { url: string; qualityScore: number }> = {}
          if (isbnsToQuery.length > 0) {
            try {
              const url = `https://book-resource.dataesb.com/websearch/metares?glc=P1ZJ0571001&cmdACT=getImages&type=0&isbns=${isbnsToQuery.join(',')}&callback=cb`
              const txt = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeoutMs: 6000,
              }).then((r) => r.text())
              const jsonStr = txt.trim().replace(/^cb\(/, '').replace(/\);?\s*$/, '')
              const parsed = JSON.parse(jsonStr)
              const groupedByIsbn: Record<
                string,
                Array<{ resourceLink: string; hdCoverLink: string; width: number; height: number }>
              > = {}
              const rawEntries: any[] = Array.isArray(parsed.result) ? parsed.result : []
              await Promise.all(
                rawEntries.map(async (entry) => {
                const rawCoverLink = String(entry.coverlink || '').trim()
                if (
                  rawCoverLink &&
                  /bigbg\.png|default_book|book-default|no_pic|nopic|zanwu/i.test(rawCoverLink)
                ) {
                  return
                }
                const link = repairCoverUrl(entry.resourceLink || rawCoverLink || '')
                const hdCoverLink = normalizeTrustedHdImageUrl(rawCoverLink)
                if (
                  entry.isbn &&
                  link &&
                  isSafePublicHttpUrl(link) &&
                  !isPlaceholderCoverUrl(link)
                ) {
                  // 拉取前 4KB 校验真实可访问、非占位图，并直接读取 JPEG/PNG 宽高比以识别多册套书横图
                  try {
                    const probeRes = await fetch(link, {
                      method: 'GET',
                      headers: { Range: 'bytes=0-4095', 'Accept-Encoding': 'identity' },
                      timeoutMs: 4000,
                    })
                    const cRange = String(probeRes.headers.get('content-range') || '')
                    const totalFromRange = cRange.includes('/')
                      ? Number(cRange.split('/')[1] || 0)
                      : 0
                    const len =
                      totalFromRange || Number(probeRes.headers.get('content-length') || 0)
                    const ctype = String(probeRes.headers.get('content-type') || '').toLowerCase()
                    if (
                      probeRes.ok &&
                      (len > 2500 || (len === 0 && ctype.includes('image'))) &&
                      len !== 5687 &&
                      len !== 12177 &&
                      len !== 13498 &&
                      len !== 37458
                    ) {
                      const probeBuf = Buffer.from(await probeRes.arrayBuffer())
                      const dim = parseImageDimensionsFromBuffer(probeBuf)
                      const isbnKey = String(entry.isbn).toUpperCase()
                      if (!groupedByIsbn[isbnKey]) groupedByIsbn[isbnKey] = []
                      groupedByIsbn[isbnKey].push({
                        resourceLink: link,
                        hdCoverLink,
                        width: dim?.width || 0,
                        height: dim?.height || 0,
                      })
                    }
                  } catch {
                    // ignore invalid link
                  }
                }
                })
              )
              for (const [isbnKey, list] of Object.entries(groupedByIsbn)) {
                // 优先选择竖版单书高清封面 (/cover/medium/ 或 /cover/p/ 且高宽比 >= 0.98)，规避无印良品式多册并排套书横图
                const highQualityItem = list.find(
                  (x) =>
                    (x.resourceLink.includes('/cover/medium/') ||
                      x.resourceLink.includes('/cover/p/')) &&
                    (x.width === 0 || x.height >= x.width * 0.98)
                )
                const anyHighQualityItem = list.find(
                  (x) =>
                    x.resourceLink.includes('/cover/medium/') ||
                    x.resourceLink.includes('/cover/p/')
                )
                const externalHd = list.find((x) => Boolean(x.hdCoverLink))?.hdCoverLink || ''
                const thumbItem = list[0]
                if (highQualityItem) {
                  const ratio =
                    highQualityItem.width > 0
                      ? highQualityItem.height / highQualityItem.width
                      : 1.35
                  isbnCoverMap[isbnKey] = {
                    url: highQualityItem.resourceLink,
                    qualityScore: ratio >= 1.12 ? 100 : 88,
                  }
                } else if (
                  externalHd &&
                  /\.(?:360buyimg\.com|winxuancdn\.com|bookuu\.com)\//i.test(externalHd)
                ) {
                  isbnCoverMap[isbnKey] = { url: externalHd, qualityScore: 76 }
                } else if (anyHighQualityItem) {
                  // 横图套书封面（如 540x499 八册并排图）降低优先级，仅在无单册竖图时兜底
                  isbnCoverMap[isbnKey] = {
                    url: anyHighQualityItem.resourceLink,
                    qualityScore: 30,
                  }
                } else if (thumbItem) {
                  isbnCoverMap[isbnKey] = { url: thumbItem.resourceLink, qualityScore: 60 }
                }
              }
            } catch {
              // ignore tier 1 failure
            }
          }

          const needInternetFallback: typeof unresolved = []
          for (const u of unresolved) {
            let bestHit: { url: string; qualityScore: number } | null = null
            for (let idx = 0; idx < u.candidateIsbns.length; idx++) {
              const candIsbn = u.candidateIsbns[idx]
              const hit = isbnCoverMap[candIsbn]
              if (!hit) continue
              // 兼顾 Zjlib 书目匹配顺序（idx 越小越优先）与封面自身竖版单书质量分
              const effectiveScore = hit.qualityScore - idx * 3
              if (!bestHit || effectiveScore > bestHit.qualityScore) {
                bestHit = { url: hit.url, qualityScore: effectiveScore }
              }
            }
            if (bestHit && bestHit.url) {
              const url = bestHit.url
              resolvedById[u.id] = url
              setCoverCacheEntry(cache, u.cacheKey, url)
              if (u.legacyIsbnKey) setCoverCacheEntry(cache, u.legacyIsbnKey, url)
              if (!u.meta.partToken && !u.meta.volNumber) {
                setCoverCacheEntry(cache, `title:${u.title}`, url)
                if (u.candidateIsbns[0]) {
                  setCoverCacheEntry(cache, `isbn:${u.candidateIsbns[0]}`, url)
                }
              }
            } else {
              needInternetFallback.push(u)
            }
          }

          // Tier 2: 互联网图书封面搜索兜底（针对图书馆无封面、“暂无封面”假图或过期链接）
          const concurrency = 6
          for (let i = 0; i < needInternetFallback.length; i += concurrency) {
            const chunk = needInternetFallback.slice(i, i + concurrency)
            await Promise.all(
              chunk.map(async (u) => {
                if (!u.title) return
                const imgUrl = await searchInternetBookCover(
                  u.title,
                  u.author,
                  u.publisher,
                  u.cleanIsbn || u.candidateIsbns[0] || ''
                )
                if (imgUrl && isSafePublicHttpUrl(imgUrl)) {
                  resolvedById[u.id] = imgUrl
                  setCoverCacheEntry(cache, u.cacheKey, imgUrl)
                  if (!u.meta.partToken && !u.meta.volNumber) {
                    setCoverCacheEntry(cache, `title:${u.title}`, imgUrl)
                    if (u.candidateIsbns[0]) {
                      setCoverCacheEntry(cache, `isbn:${u.candidateIsbns[0]}`, imgUrl)
                    }
                  }
                }
              })
            )
          }

          await saveCoverCache(cache)
          res.end(JSON.stringify({ ok: true, covers: resolvedById }))
        } catch (err: any) {
          res.statusCode = err?.statusCode || 500
          res.end(
            JSON.stringify({
              ok: false,
              reqId: req.__reqId,
              message: formatUpstreamError(err, '获取封面失败', req, '/api/covers/resolve'),
            })
          )
        }
      })

      // 0B-2. 双馆全量书目在线检索接口（无需登录，支持浙江图书馆 + 杭州图书馆） (/api/catalog/search)
      const sortHoldingsByPriority = (library: 'zjlib' | 'hzlib', list: any[]) => {
        return [...list].sort((a, b) => {
          if (Boolean(a.isAvailable) !== Boolean(b.isAvailable)) {
            return Number(Boolean(b.isAvailable)) - Number(Boolean(a.isAvailable))
          }
          if (Boolean(a.isInLibraryReadOnly) !== Boolean(b.isInLibraryReadOnly)) {
            return Number(Boolean(a.isInLibraryReadOnly)) - Number(Boolean(b.isInLibraryReadOnly))
          }
          const pa = getLibraryBranchPriority(library, a.libName || '', a.location || '')
          const pb = getLibraryBranchPriority(library, b.libName || '', b.location || '')
          if (pa !== pb) return pa - pb
          const aKnown =
            getLibraryAddressInfo({
              library,
              libName: a.libName || '',
              location: a.location || '',
            }).address !== '未知地址'
          const bKnown =
            getLibraryAddressInfo({
              library,
              libName: b.libName || '',
              location: b.location || '',
            }).address !== '未知地址'
          if (aKnown !== bKnown) return Number(bKnown) - Number(aKnown)
          const libCmp = String(a.libName || '').localeCompare(String(b.libName || ''), 'zh-CN')
          if (libCmp !== 0) return libCmp
          if (Boolean(a.navUrl) !== Boolean(b.navUrl)) {
            return Number(Boolean(b.navUrl)) - Number(Boolean(a.navUrl))
          }
          return String(a.location || '').localeCompare(String(b.location || ''), 'zh-CN')
        })
      }

      server.middlewares.use('/api/catalog/search', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false }))
          return
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const body = await readJsonBody(req)
          const keyword = String(body.keyword || '').trim()
          const branch: string = String(body.branch || body.scope || 'all').trim()
          const onlyAvailable: boolean = body.onlyAvailable !== false
          const autoGroup: boolean = body.autoGroup === true
          const rows = Math.min(Number(body.rows) || 15, 24)
          const page = Math.max(1, Number(body.page) || 1)
          const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

          if (!keyword) {
            res.end(JSON.stringify({ ok: true, items: [], zjTotal: 0, hzTotal: 0, hasMore: false }))
            return
          }

          const searchCacheKey = `search::${keyword.toLowerCase()}::${branch}::${onlyAvailable ? '1' : '0'}::${autoGroup ? '1' : '0'}::${rows}::${page}`
          const cachedSearchJson = getPublicQueryCache(searchCacheKey)
          if (cachedSearchJson) {
            res.end(cachedSearchJson)
            return
          }

          const needZj = branch === 'all' || branch === 'zjlib' || branch.startsWith('zjlib:')
          const needHz = branch === 'all' || branch === 'hzlib' || branch.startsWith('hzlib:')
          const zjTargetDistrict =
            branch.startsWith('zjlib:') && branch !== 'zjlib:all' ? branch.slice(6) : ''
          const hzTargetBranch =
            branch.startsWith('hzlib:') && branch !== 'hzlib:all' ? branch.slice(6) : ''

          const zjDistrictMap: Record<string, string> = ZJLIB_BRANCH_CONFIG.districtIdMap || {}

          const stripSym = (s: string) =>
            (s || '')
              .toLowerCase()
              .replace(/[·．:：,，。！!？?《》〈〉“”"''（）()\[\]【】—\-_\s/\\|]/g, '')

          const cnNumMap: Record<string, number> = {
            零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 两: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
            五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9, 十: 10, 拾: 10,
            上: 1, 中: 2, 下: 3,
          }
          const parseCnToken = (t: string): number => {
            if (/^\d+$/.test(t)) return parseInt(t, 10)
            if (t.length === 1 && cnNumMap[t] !== undefined) return cnNumMap[t]
            let resNum = 0
            let cur = 0
            for (const ch of t) {
              const v = cnNumMap[ch]
              if (v === undefined) return 999
              if (v === 10) {
                resNum += (cur === 0 ? 1 : cur) * 10
                cur = 0
              } else {
                cur = v
              }
            }
            return resNum + cur
          }
          const toNaturalTitleKey = (title: string): string => {
            const clean = (title || '').replace(/^[《「【(\[]+|[》」】)\]]+$/g, '').trim()
            const sepMatch = clean.match(/^([^．.：:—·(（\s]+)(?:[．.：:—·(（\s]+(.*))?$/)
            const seriesPrefix = (sepMatch ? sepMatch[1] : clean).trim()
            const subPart = (sepMatch && sepMatch[2] ? sepMatch[2] : '').trim()
            let subSeriesKey = '00_main'
            if (subPart) {
              const subSeriesMatch = subPart.match(
                /(专题书|总集篇|外传|番外篇?|公式书|设定集|资料集|剧场版|特辑|合订本)/
              )
              if (subSeriesMatch && subSeriesMatch[1]) {
                subSeriesKey = `01_${subSeriesMatch[1]}`
              }
            }
            let volRank = 0
            if (subPart) {
              const explicitVolMatch =
                subPart.match(
                  /(?:[卷集册部辑]\s*第?\s*|(?:vol\.?|v)\s*)(\d+|[零〇一二两三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾]+)/i
                ) ||
                subPart.match(
                  /第?\s*(\d+|[零〇一二两三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾]+)\s*[卷集册部辑]/
                )
              if (explicitVolMatch && explicitVolMatch[1]) {
                const parsed = parseCnToken(explicitVolMatch[1])
                volRank = parsed > 0 ? parsed : 1
              } else {
                const segments = subPart
                  .split(/[．.：:—·(（]+/)
                  .map((s) => s.trim())
                  .filter(Boolean)
                let foundSegVol: number | null = null
                for (const seg of segments) {
                  const m = seg.match(
                    /^(\d+|[零〇一二两三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾]+|[上中下])(?=\s*[，,．.：:\s)）]|$)/
                  )
                  if (m && m[1]) {
                    const parsed = parseCnToken(m[1])
                    if (parsed > 0) {
                      foundSegVol = parsed
                      break
                    }
                  }
                }
                volRank = foundSegVol !== null ? foundSegVol : 1
              }
            }
            const paddedRest = clean
              .replace(/[·．:：,，（）()《》“”"'\s]+/g, ' ')
              .replace(/(\d+|[一二三四五六七八九十百零〇壹贰叁肆伍陆柒捌玖拾上中下]+)/g, (m) =>
                String(parseCnToken(m)).padStart(6, '0')
              )
            const paddedSeries = seriesPrefix.replace(
              /(\d+|[一二三四五六七八九十百零〇壹贰叁肆伍陆柒捌玖拾上中下]+)/g,
              (m) => String(parseCnToken(m)).padStart(6, '0')
            )
            return `${paddedSeries}__${subSeriesKey}__${String(volRank).padStart(6, '0')}__${paddedRest}`
          }

          // 智能拆词：识别 "xxx书 卷5 / 卷五 / 5卷 / 五卷 / 5集 / 五集 / 5" 等卷集标识
          const CN_NUM_CHARS = '一二三四五六七八九十百零〇壹贰叁肆伍陆柒捌玖拾两'
          const extractTitleAndVolume = (raw: string): { baseKeyword: string; targetVolNum: string } => {
            const trimmed = raw.trim()
            const patterns = [
              new RegExp(`(?:^|\\s|[．·:：,，])第?\\s*(\\d+|[${CN_NUM_CHARS}]+)\\s*[卷集册部辑回篇章]$`),
              new RegExp(`(?:^|\\s|[．·:：,，])[卷集册部辑回篇章]\\s*第?\\s*(\\d+|[${CN_NUM_CHARS}]+)$`),
              new RegExp(`\\s+(\\d+|[${CN_NUM_CHARS}]+)$`),
              new RegExp(`第?(\\d+|[${CN_NUM_CHARS}]+)[卷集册部辑回篇章]$`),
              new RegExp(`[卷集册部辑回篇章]第?(\\d+|[${CN_NUM_CHARS}]+)$`),
            ]
            for (const re of patterns) {
              const m = trimmed.match(re)
              if (m && m[1]) {
                const parsed = parseCnToken(m[1])
                if (parsed > 0 && parsed < 10000) {
                  const base = trimmed.slice(0, m.index).replace(/[．·:：,，\s]+$/g, '').trim()
                  if (base.length >= 1) {
                    return { baseKeyword: base, targetVolNum: String(parsed) }
                  }
                }
              }
            }
            return { baseKeyword: trimmed, targetVolNum: '' }
          }

          const extractTitleVolumes = (title: string): string[] => {
            const matches =
              String(title || '').match(
                new RegExp(`\\d+|[${CN_NUM_CHARS}]+`, 'g')
              ) || []
            return matches
              .map((m) => parseCnToken(m))
              .filter((n) => n > 0 && n < 10000)
              .map((n) => String(n))
          }

          const { baseKeyword, targetVolNum } = extractTitleAndVolume(keyword)
          const rawSearchKw = targetVolNum ? baseKeyword : keyword
          // 同义译名映射到图书馆官方正名（如搜 "海贼王" -> "航海王"）
          const searchKw = rawSearchKw
            .replace(/海贼王/g, '航海王')
            .replace(/one\s*piece/gi, '航海王')
          const searchRows = targetVolNum ? Math.max(rows, 36) : rows

          const kwClean = stripSym(searchKw)
          const calcRelevance = (title: string, author: string, isbn: string): number => {
            const tClean = stripSym(title)
            const baseTitle = stripSym(title.split(/[．.·:：，,（(\s]/)[0] || title)
            if (tClean === kwClean) return 0
            if (baseTitle === kwClean) return 5
            if (tClean.startsWith(kwClean)) return 20
            const idx = tClean.indexOf(kwClean)
            if (idx !== -1) return 100 + idx * 3
            if (stripSym(isbn).includes(kwClean)) return 250
            if (stripSym(author).includes(kwClean)) return 300
            return 500
          }

          const zjPromise =
            needZj
              ? (async () => {
                  try {
                    const zjHeaders = {
                      'Content-Type': 'application/json',
                      'BFF-ORG-ID': ZJLIB_ORG_ID,
                      'Accept-Language': 'zh-CN;q=0.9',
                      'User-Agent': ua,
                    }
                    // 并发发起「书名字段优先检索」与「全字段检索」，避免搜《绍宋》被“余绍宋撰”挤到后面
                    const [zjTitleResp, zjFullResp]: any[] = await Promise.all([
                      fetch(`${ZJLIB_API_BASE}/search-admin-service/open-api/search/pageList`, {
                        method: 'POST',
                        headers: zjHeaders,
                        body: JSON.stringify({
                          metadataType: 'work',
                          current: page,
                          size: searchRows,
                          query: [
                            {
                              id: 0,
                              key: 'title',
                              value: searchKw,
                              match: 'phrase_fuzzy',
                              condition: 'and',
                            },
                          ],
                          sortBy: [],
                        }),
                      })
                        .then((r) => r.json())
                        .catch(() => null),
                      fetch(`${ZJLIB_API_BASE}/search-admin-service/open-api/search/pageList`, {
                        method: 'POST',
                        headers: zjHeaders,
                        body: JSON.stringify({
                          metadataType: 'work',
                          current: page,
                          size: Math.min(searchRows, 15),
                          query: [
                            {
                              id: 0,
                              key: '',
                              value: searchKw,
                              match: 'phrase_fuzzy',
                              condition: 'and',
                            },
                          ],
                          sortBy: [],
                        }),
                      })
                        .then((r) => r.json())
                        .catch(() => null),
                    ])

                    const mergedRaw: any[] = []
                    const seenBibIds = new Set<string>()
                    for (const r of [
                      ...(zjTitleResp?.data?.records || []),
                      ...(zjFullResp?.data?.records || []),
                    ]) {
                      const bibId = String(
                        Array.isArray(r.originalId) ? r.originalId[0] : r.originalId || r.id || ''
                      ).trim()
                      if (!bibId || seenBibIds.has(bibId)) continue
                      seenBibIds.add(bibId)
                      mergedRaw.push(r)
                    }

                    const total = Number(
                      zjTitleResp?.data?.total || zjFullResp?.data?.total || mergedRaw.length
                    )
                    const rawCandidates = mergedRaw
                      .map((r: any, idx: number) => {
                        const bibId = String(
                          Array.isArray(r.originalId) ? r.originalId[0] : r.originalId || r.id || ''
                        ).trim()
                        const workId = String(
                          Array.isArray(r.id) ? r.id[0] : r.id || bibId
                        ).trim()
                        const sourceType = Array.isArray(r.sourceType)
                          ? r.sourceType.join(',')
                          : String(r.sourceType || '0')
                        const title = String(
                          Array.isArray(r.title) ? r.title[0] : r.title || ''
                        ).trim()
                        const author = String(
                          Array.isArray(r.creator) ? r.creator[0] : r.creator || ''
                        ).trim()
                        const publisher = String(
                          Array.isArray(r.publisher) ? r.publisher[0] : r.publisher || ''
                        ).trim()
                        const pubDate = String(
                          Array.isArray(r.dateIssue) ? r.dateIssue[0] : r.dateIssue || ''
                        ).trim()
                        const isbn = String(
                          Array.isArray(r.identifierIsbn)
                            ? r.identifierIsbn[0]
                            : r.identifierIsbn || ''
                        ).trim()
                        return {
                          id: `catalog:zjlib:${bibId}`,
                          library: 'zjlib' as const,
                          subLibrary: '浙江图书馆馆藏',
                          bibId,
                          workId,
                          sourceType,
                          title,
                          author,
                          publisher,
                          pubDate,
                          isbn,
                          callNo: '',
                          availableCount: 0,
                          totalHoldings: 0,
                          availableBranches: [] as string[],
                          holdings: [] as any[],
                          _rel: calcRelevance(title, author, isbn),
                          _rawOrder: idx,
                        }
                      })
                      .filter((x) => Boolean(x.title && x.bibId))
                      .sort((a, b) => {
                        if (!autoGroup) return a._rawOrder - b._rawOrder
                        if (a._rel !== b._rel) return a._rel - b._rel
                        return toNaturalTitleKey(a.title).localeCompare(
                          toNaturalTitleKey(b.title),
                          'zh-CN'
                        )
                      })
                      .slice(0, targetVolNum ? 24 : 12)

                    // 并发查询浙图候选书目的实时在馆状态与所属馆区 (resourceList)
                    await Promise.all(
                      rawCandidates.map(async (item) => {
                        try {
                          const resListResp: any = await fetch(
                            `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/search/resourceList`,
                            {
                              method: 'POST',
                              headers: zjHeaders,
                              body: JSON.stringify({
                                id: item.workId,
                                sourceType: item.sourceType,
                              }),
                            }
                          ).then((r) => r.json())
                          const allCopies: any[] = resListResp?.data?.[0] || []
                          const scopedCopies = zjTargetDistrict
                            ? allCopies.filter(
                                (c: any) => String(c.districtId || '') === zjTargetDistrict
                              )
                            : allCopies
                          item.totalHoldings = scopedCopies.length
                          const availCopies = scopedCopies.filter(
                            (c: any) => c.state === 2 || c.state === 16
                          )
                          item.availableCount = availCopies.length
                          const firstCallNo =
                            scopedCopies.find((c: any) => c.callno)?.callno ||
                            allCopies.find((c: any) => c.callno)?.callno ||
                            ''
                          if (firstCallNo) item.callNo = String(firstCallNo).trim()

                          // 为之江馆在馆书目查询层架标中文描述（与 /api/holding/query 一致）
                          const ZHIJIANG_DISTRICT_ID = '1916325141324353538'
                          const shelfPrefixes = [
                            ...new Set(
                              scopedCopies
                                .filter(
                                  (c: any) =>
                                    String(c.districtId || '') === ZHIJIANG_DISTRICT_ID &&
                                    (c.state === 2 || c.state === 16) &&
                                    Boolean(String(c.shelf_mark || '').trim())
                                )
                                .map((c: any) => String(c.shelf_mark || '').trim())
                                .map((sm: string) => {
                                  let prefix = sm
                                  while ((prefix.match(/-/g) || []).length > 6) {
                                    prefix = prefix.slice(0, prefix.lastIndexOf('-'))
                                  }
                                  return prefix
                                })
                            ),
                          ]
                          const shelfDescMap: Record<string, string> = {}
                          if (shelfPrefixes.length > 0) {
                            try {
                              const descResp: any = await fetch(
                                `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/search/get/shelf/description/map`,
                                {
                                  method: 'POST',
                                  headers: zjHeaders,
                                  body: JSON.stringify({
                                    orgId: ZJLIB_ORG_ID,
                                    shelfNoList: shelfPrefixes,
                                  }),
                                }
                              ).then((r) => r.json())
                              if (descResp?.code === 200 && descResp.data) {
                                Object.assign(shelfDescMap, descResp.data)
                              }
                            } catch {
                              // ignore
                            }
                          }

                          const stateNames: Record<number, string> = {
                            1: '编目中',
                            2: '在馆',
                            3: '借出',
                            4: '丢失',
                            16: '在馆(可外借)',
                          }

                          const formattedHoldings = sortHoldingsByPriority(
                            'zjlib',
                            scopedCopies.map((c: any) => {
                              const isAvailable = c.state === 2 || c.state === 16
                              const isInLibraryReadOnly = c.state === 16
                              const isZhijiang = String(c.districtId || '') === ZHIJIANG_DISTRICT_ID
                              const dName = zjDistrictMap[String(c.districtId || '')] || ''
                              const rName = c.local_name || c.lib_name || '浙江图书馆'
                              const effectiveCallNo = String(c.callno || item.callNo || '').trim()
                              const rawShelfMark =
                                isZhijiang && isAvailable ? String(c.shelf_mark || '').trim() : ''
                              let shelfText = rawShelfMark
                              if (rawShelfMark) {
                                let prefix = rawShelfMark
                                while ((prefix.match(/-/g) || []).length > 6) {
                                  prefix = prefix.slice(0, prefix.lastIndexOf('-'))
                                }
                                const baseDesc = shelfDescMap[prefix]
                                if (baseDesc) {
                                  const posNum = parseInt(rawShelfMark.split('-').pop() || '0', 10)
                                  shelfText = posNum > 0 ? `${baseDesc}第${posNum}位` : baseDesc
                                }
                              } else if (rName.includes('立库') || rName.includes('保存本')) {
                                shelfText =
                                  '闭架智能立库：到服务台/检索机凭条码申请机器调阅（馆内阅读）'
                              } else if (rName.includes('闭架')) {
                                shelfText =
                                  '闭架外借书库：到服务台凭索书号/条码请馆员调取（可外借）'
                              } else {
                                shelfText = effectiveCallNo
                              }
                              const navUrl = rawShelfMark
                                ? `https://map.zjlib.cn/h5/library-pc/#/?callno=${encodeURIComponent(effectiveCallNo)}&title=${encodeURIComponent(item.title)}&shelfMark=${encodeURIComponent(rawShelfMark)}&barcode=${encodeURIComponent(c.barcode || '')}&creator=${encodeURIComponent(item.author || '')}&publisher=${encodeURIComponent(item.publisher || '')}`
                                : ''
                              return {
                                isAvailable,
                                isInLibraryReadOnly,
                                stateName:
                                  c.state_name ||
                                  stateNames[Number(c.state)] ||
                                  (isAvailable ? '在馆' : '借出/不可借'),
                                libName: dName ? `浙图·${dName}` : '浙江图书馆',
                                location: rName,
                                callNo: effectiveCallNo,
                                barcode: c.barcode || '',
                                shelfNo: shelfText,
                                rawShelfMark,
                                volInfo: c.vol_info || '',
                                navUrl,
                              }
                            })
                          )

                          item.holdings = formattedHoldings
                          const branchNames = [
                            ...new Set(
                              (formattedHoldings.some((h) => h.isAvailable)
                                ? formattedHoldings.filter((h) => h.isAvailable)
                                : formattedHoldings
                              )
                                .map((h) =>
                                  h.location && h.location !== h.libName
                                    ? `${h.libName}·${h.location}`
                                    : h.libName
                                )
                                .filter(Boolean)
                            ),
                          ]
                          item.availableBranches = branchNames.slice(0, 3)
                          if (branchNames[0]) {
                            item.subLibrary = branchNames[0]
                          }
                        } catch {
                          // ignore single item holding error
                        }
                      })
                    )

                    const items = rawCandidates.filter((item) => {
                      if (zjTargetDistrict && item.totalHoldings <= 0) return false
                      if (onlyAvailable && item.availableCount <= 0) return false
                      return true
                    })
                    return { total, items, rawCount: rawCandidates.length }
                  } catch {
                    return { total: 0, items: [], rawCount: 0 }
                  }
                })()
              : Promise.resolve({ total: 0, items: [], rawCount: 0 })

          const hzPromise =
            needHz
              ? (async () => {
                  try {
                    const cleanKw = searchKw
                      .replace(/[．·：:，,（）()《》“”"']/g, ' ')
                      .replace(/\s+/g, ' ')
                      .trim()
                    const curlibParam =
                      hzTargetBranch && /^\d{4}$/.test(hzTargetBranch) && hzTargetBranch !== '1900' && hzTargetBranch !== '0900' && hzTargetBranch !== '1800'
                        ? `&curlibcode=${encodeURIComponent(hzTargetBranch)}`
                        : ''
                    const hzSearchRows = Math.max(searchRows, 20)
                    const html = await fetch(
                      `https://my1.zjhzlib.cn/opac/search?q=${encodeURIComponent(cleanKw || searchKw)}&searchWay=&scWay=dim&rows=${hzSearchRows}&page=${page}&sortWay=score&sortOrder=desc&hasholding=1${curlibParam}`,
                      { headers: { 'User-Agent': ua } }
                    ).then((r) => r.text())
                    const $ = cheerio.load(html)
                    const totalMatch = html.match(
                      /检索到\s*<strong[^>]*>\s*([\d,]+)\s*<\/strong>|检索到\s*[:：]?\s*([\d,]+)\s*条|共\s*([\d,]+)\s*条/
                    )
                    const rawItems: any[] = []
                    $('.bookmetaTD').each((_, td) => {
                      const $td = $(td)
                      const $tr = $td.closest('tr')
                      const bibId = String(
                        $td.find('.bookmeta').attr('bookrecno') ||
                          $tr.find('.bookcover_img').attr('bookrecno') ||
                          ''
                      ).trim()
                      const title = $td
                        .find('.bookmetaTitle a')
                        .first()
                        .text()
                        .replace(/\s+/g, ' ')
                        .trim()
                      if (!title || !bibId) return
                      const author = $td
                        .find('.author-link')
                        .first()
                        .text()
                        .replace(/\s+/g, ' ')
                        .trim()
                      const publisher = $td
                        .find('.publisher-link')
                        .first()
                        .text()
                        .replace(/\s+/g, ' ')
                        .trim()
                      const fullText = $td.text().replace(/\s+/g, ' ')
                      const pubDateMatch = fullText.match(/出版日期:\s*([0-9.-]+)/)
                      const pubDate = pubDateMatch ? pubDateMatch[1] : ''
                      const callNo = $td
                        .find('.callnosSpan')
                        .first()
                        .text()
                        .replace(/\s+/g, ' ')
                        .trim()
                      const isbn = String(
                        $tr.find('.bookcover_img').attr('isbn') ||
                          $td.find('.expressServiceTab').attr('express_isbn') ||
                          ''
                      ).trim()
                      rawItems.push({
                        id: `catalog:hzlib:${bibId}`,
                        library: 'hzlib' as const,
                        subLibrary: '杭州图书馆馆藏',
                        bibId,
                        title,
                        author,
                        publisher,
                        pubDate,
                        isbn,
                        callNo,
                        availableCount: 0,
                        totalHoldings: 0,
                        availableBranches: [] as string[],
                        holdings: [] as any[],
                        _rel: calcRelevance(title, author, isbn),
                      })
                    })

                    // 单次批量请求 /opac/book/holdingPreviews 获取杭图所有书目的分馆与在馆可借状态
                    if (rawItems.length > 0) {
                      try {
                        const recnos = rawItems.map((x) => x.bibId).join(',')
                        const prevRes: any = await fetch(
                          `https://my1.zjhzlib.cn/opac/book/holdingPreviews?bookrecnos=${encodeURIComponent(recnos)}&curLibcodes=&return_fmt=json`,
                          { headers: { 'User-Agent': ua } }
                        ).then((r) => r.json())
                        const previewsMap: Record<string, any[]> = prevRes?.previews || {}

                        const matchHzBranch = (p: any): boolean => {
                          if (!hzTargetBranch) return true
                          const curlib = String(p.curlib || '')
                          const curlocalName = String(p.curlocalName || '')
                          const curlibName = String(p.curlibName || '')
                          if (hzTargetBranch === '0000') {
                            if (curlib !== '0000' && curlib !== '0001') return false
                            const externalThemes = [
                              '少儿分馆',
                              '生活主题',
                              '环保分馆',
                              '佛学分馆',
                              '科技分馆',
                              '动漫分馆',
                              '茶文化',
                              '钢琴',
                              '宋韵',
                              '国医',
                              '城市学',
                              '棋院',
                              '电影',
                              '盲文',
                              '西泠',
                              '版本馆',
                              '财商',
                              '运动分馆',
                              '微图',
                            ]
                            return !externalThemes.some((kw) => curlocalName.includes(kw))
                          }
                          if (hzTargetBranch === 'local:少儿分馆') {
                            return (
                              curlocalName.includes('少儿分馆') ||
                              curlibName.includes('少年儿童') ||
                              curlib === '0100' ||
                              curlib === '0101'
                            )
                          }
                          if (hzTargetBranch === 'local:其他主题分馆') {
                            const otherThemes = [
                              '宋韵',
                              '国医',
                              '城市学',
                              '棋院',
                              '电影',
                              '盲文',
                              '西泠',
                              '版本馆',
                              '财商',
                              '运动分馆',
                            ]
                            return otherThemes.some(
                              (kw) => curlocalName.includes(kw) || curlibName.includes(kw)
                            )
                          }
                          if (hzTargetBranch.startsWith('local:')) {
                            const targetTheme = hzTargetBranch.slice(6)
                            return (
                              curlocalName.includes(targetTheme) || curlibName.includes(targetTheme)
                            )
                          }
                          if (hzTargetBranch === '1900') {
                            return ['1900', '1901', '1000', '1001'].includes(curlib)
                          }
                          if (hzTargetBranch === '0900') {
                            return ['0900', '0901'].includes(curlib)
                          }
                          if (hzTargetBranch === '1800') {
                            return ['1800', '1801'].includes(curlib)
                          }
                          if (/^\d{4}$/.test(hzTargetBranch)) {
                            return curlib.startsWith(hzTargetBranch.slice(0, 2))
                          }
                          return (
                            curlibName.includes(hzTargetBranch) ||
                            curlocalName.includes(hzTargetBranch)
                          )
                        }

                        for (const item of rawItems) {
                          const list: any[] = previewsMap[item.bibId] || []
                          const scoped = list.filter(matchHzBranch)
                          let totalCopies = 0
                          let availCopies = 0
                          const previewHoldings: any[] = []
                          for (const p of scoped) {
                            const cCount = Number(p.copycount || 1)
                            const lCount =
                              p.loanableCount !== undefined && p.loanableCount !== null
                                ? Number(p.loanableCount)
                                : p.state === 2
                                  ? cCount
                                  : 0
                            totalCopies += cCount
                            availCopies += lCount
                            const libName = String(p.curlibName || '杭州图书馆').trim()
                            const location = String(p.curlocalName || libName).trim()
                            const pCallNo = String(p.callno || item.callNo || '').trim()
                            if (!item.callNo && pCallNo) {
                              item.callNo = pCallNo
                            }
                            previewHoldings.push({
                              isAvailable: lCount > 0,
                              isInLibraryReadOnly: false,
                              isPreviewSummary: true,
                              copyCount: cCount,
                              loanableCount: lCount,
                              stateName: lCount > 0 ? `在馆 ${lCount}/${cCount} 册` : `${cCount} 册均借出`,
                              libName,
                              location,
                              callNo: pCallNo,
                              barcode: '',
                              shelfNo: pCallNo || location,
                              navUrl: '',
                            })
                          }
                          const sortedPreviewHoldings = sortHoldingsByPriority(
                            'hzlib',
                            previewHoldings
                          )
                          item.holdings = sortedPreviewHoldings
                          item.totalHoldings = totalCopies
                          item.availableCount = availCopies
                          const branchNames = [
                            ...new Set(
                              (sortedPreviewHoldings.some((h) => h.isAvailable)
                                ? sortedPreviewHoldings.filter((h) => h.isAvailable)
                                : sortedPreviewHoldings
                              )
                                .map((h) =>
                                  h.location && h.location !== h.libName
                                    ? `${h.libName}·${h.location}`
                                    : h.libName
                                )
                                .filter(Boolean)
                            ),
                          ]
                          item.availableBranches = branchNames.slice(0, 3)
                          if (item.availableBranches[0]) {
                            item.subLibrary = item.availableBranches[0]
                          }
                        }
                      } catch {
                        // ignore holdingPreviews failure
                      }
                    }

                    const items = rawItems.filter((item) => {
                      if (hzTargetBranch && item.totalHoldings <= 0) return false
                      if (onlyAvailable && item.availableCount <= 0) return false
                      return true
                    })
                    const rawTotalStr = totalMatch
                      ? (totalMatch[1] || totalMatch[2] || totalMatch[3] || '').replace(/,/g, '')
                      : ''
                    const total = rawTotalStr ? Number(rawTotalStr) : rawItems.length
                    return { total, items, rawCount: rawItems.length, pageSize: hzSearchRows }
                  } catch {
                    return { total: 0, items: [], rawCount: 0, pageSize: 20 }
                  }
                })()
              : Promise.resolve({ total: 0, items: [], rawCount: 0, pageSize: 20 })

          const [zjRes, hzRes] = await Promise.all([zjPromise, hzPromise])
          let combined = [...zjRes.items, ...hzRes.items].map((it, idx) => ({
            ...it,
            _rawOrder: idx,
          }))

          // 若用户输入了目标卷/集编号（如 "5卷" / "卷五"），优先过滤只保留命中该卷号的书；若 0 命中则兜底保留主书名结果
          if (targetVolNum) {
            const volMatched = combined.filter((item) =>
              extractTitleVolumes(item.title).includes(targetVolNum)
            )
            if (volMatched.length > 0) {
              combined = volMatched
            }
          }

          if (autoGroup) {
            combined.sort((a, b) => {
              if (a._rel !== b._rel) return a._rel - b._rel
              const natCmp = toNaturalTitleKey(a.title).localeCompare(
                toNaturalTitleKey(b.title),
                'zh-CN'
              )
              if (natCmp !== 0) return natCmp
              if ((b.availableCount > 0) !== (a.availableCount > 0)) {
                return Number(b.availableCount > 0) - Number(a.availableCount > 0)
              }
              return 0
            })
          }

          const zjPageLimit = targetVolNum ? 24 : 12
          const zjHasMore = needZj && zjRes.rawCount >= zjPageLimit && page * zjPageLimit < zjRes.total
          const hzPageSize = hzRes.pageSize || 20
          const hzHasMore = needHz && hzRes.rawCount >= hzPageSize && page * hzPageSize < hzRes.total
          const hasMore = (zjHasMore || hzHasMore) && combined.length > 0 && page < 15

          res.end(
            setPublicQueryCache(searchCacheKey, {
              ok: true,
              page,
              hasMore,
              zjTotal: zjRes.total,
              hzTotal: hzRes.total,
              items: combined,
            })
          )
        } catch (err: any) {
          res.statusCode = err?.statusCode || 500
          res.end(
            JSON.stringify({
              ok: false,
              reqId: req.__reqId,
              message: formatUpstreamError(err, '在线检索馆藏出错', req, '/api/catalog/search'),
            })
          )
        }
      })

      // 0C. 实时馆藏状态与架位查询接口 (/api/holding/query)
      server.middlewares.use('/api/holding/query', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false }))
          return
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const body = await readJsonBody(req)
          const library: 'zjlib' | 'hzlib' = body.library || 'hzlib'
          let bibId: string = String(body.bibId || '').trim()
          const isbn: string = String(body.isbn || '').trim()
          const title: string = String(body.title || '').trim()
          const callNo: string = String(body.callNo || '').trim()
          const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          const holdingCacheKey = `holding::${library}::${bibId}::${isbn}::${callNo}::${title}`
          const cachedHoldingJson = getPublicQueryCache(holdingCacheKey)
          if (cachedHoldingJson) {
            res.end(cachedHoldingJson)
            return
          }

          if (library === 'hzlib') {
            // If bibId is missing, search by ISBN, callNo, or title on my1.zjhzlib.cn/opac/search
            if (!bibId && (isbn || callNo || title)) {
              const cleanTitle = title.replace(/[．·：:，,（）()《》“”"']/g, ' ').replace(/\s+/g, ' ').trim()
              const candidates: Array<{ way: string; q: string }> = []
              if (isbn) candidates.push({ way: 'isbn', q: isbn })
              if (callNo) candidates.push({ way: 'callno', q: callNo })
              if (cleanTitle) candidates.push({ way: '', q: cleanTitle })
              if (title) candidates.push({ way: 'title', q: title })

              for (const cand of candidates) {
                try {
                  const searchHtml = await fetch(
                    `https://my1.zjhzlib.cn/opac/search?q=${encodeURIComponent(cand.q)}&searchWay=${cand.way}&scWay=dim`,
                    { headers: { 'User-Agent': ua } }
                  ).then((r) => r.text())
                  const m = searchHtml.match(/(?:bookDetail\(|bookSimpleDetailDiv_|\/opac\/book\/)(\d+)/)
                  if (m && m[1]) {
                    bibId = m[1]
                    break
                  }
                } catch {
                  // try next candidate
                }
              }
            }

            if (!bibId) {
              res.end(JSON.stringify({ ok: false, message: '未找到该书在杭州图书馆的书目编号' }))
              return
            }

            const hRes: any = await fetch(
              `https://my1.zjhzlib.cn/opac/api/holding/${encodeURIComponent(bibId)}?limitLibcodes=&isCluster=false`,
              { headers: { 'User-Agent': ua } }
            ).then((r) => r.json())

            const holdings = (hRes.holdingList || [])
              .map((item: any) => {
                const stateObj = hRes.holdStateMap?.[String(item.state)]
                const isAvailable = item.state === 2
                const curLibName = hRes.libcodeMap?.[item.curlib] || '杭州图书馆'
                const orgLibName =
                  item.orglib && item.orglib !== item.curlib
                    ? hRes.libcodeMap?.[item.orglib] || ''
                    : ''
                const roomName = hRes.localMap?.[item.curlocal] || item.curlocal || '外借借阅区'
                const docType = hRes.pBCtypeMap?.[String(item.cirtype)]?.name || ''
                const isInLibraryReadOnly = docType.includes('在馆阅览')
                const rawShelf = String(item.shelfno || item.memoinfo || '').trim()
                const effectiveCallNo = String(item.callno || callNo || '').trim()
                const shelfNo = rawShelf
                  ? effectiveCallNo
                    ? `${rawShelf} · ${effectiveCallNo}`
                    : rawShelf
                  : effectiveCallNo
                const loanWork = hRes.loanWorkMap?.[String(item.barcode || '')]
                const dueDate =
                  item.state === 3 && loanWork?.returnDate
                    ? new Date(Number(loanWork.returnDate) + 8 * 3600 * 1000)
                        .toISOString()
                        .slice(0, 10)
                    : ''

                return {
                  isAvailable,
                  isInLibraryReadOnly,
                  stateName:
                    stateObj?.stateName ||
                    (item.state === 2 ? '在馆' : item.state === 3 ? '借出' : '其他状态'),
                  libName: curLibName,
                  orgLibName,
                  location: roomName,
                  docType,
                  callNo: effectiveCallNo,
                  barcode: item.barcode || '',
                  shelfNo,
                  dueDate,
                  volInfo: item.volInfo || '',
                  navUrl: '',
                  isMainLib: item.curlib === '0000',
                }
              })
            const sortedHzHoldings = sortHoldingsByPriority('hzlib', holdings)
            holdings.splice(0, holdings.length, ...sortedHzHoldings)

            res.end(
              setPublicQueryCache(holdingCacheKey, {
                ok: true,
                library: 'hzlib',
                bibId,
                officialUrl: `https://my1.zjhzlib.cn/opac/book/${encodeURIComponent(bibId)}`,
                totalCount: holdings.length,
                availableCount: holdings.filter((h: any) => h.isAvailable).length,
                holdings,
              })
            )
            return
          }

          // 浙江图书馆馆藏查询
          const zjHeaders = {
            'Content-Type': 'application/json',
            'BFF-ORG-ID': ZJLIB_ORG_ID,
            'Accept-Language': 'zh-CN;q=0.9',
            'User-Agent': ua,
          }
          const workResp: any = await fetch(
            `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/search/getWorkById`,
            {
              method: 'POST',
              headers: zjHeaders,
              body: JSON.stringify({ bibliosId: bibId, orgId: ZJLIB_ORG_ID }),
            }
          ).then((r) => r.json())

          const workRecord = workResp?.data?.record
          const workId = Array.isArray(workRecord?.id) ? workRecord.id[0] : workRecord?.id || bibId
          const sourceTypeArr = Array.isArray(workRecord?.sourceType)
            ? workRecord.sourceType
            : workRecord?.sourceType
              ? [workRecord.sourceType]
              : ['0']

          const resListResp: any = await fetch(
            `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/search/resourceList`,
            {
              method: 'POST',
              headers: zjHeaders,
              body: JSON.stringify({ id: workId, sourceType: sourceTypeArr.join(',') }),
            }
          ).then((r) => r.json())

          const rawList: any[] = resListResp?.data?.[0] || []
          const ZHIJIANG_DISTRICT_ID = '1916325141324353538'

          // 调用浙图官方层架标翻译接口 get/shelf/description/map（仅针对当前位于之江馆区且在馆的有效层架标）
          const shelfPrefixes = [
            ...new Set(
              rawList
                .filter(
                  (item: any) =>
                    String(item.districtId || '') === ZHIJIANG_DISTRICT_ID &&
                    (item.state === 2 || item.state === 16) &&
                    Boolean(String(item.shelf_mark || '').trim())
                )
                .map((item: any) => String(item.shelf_mark || '').trim())
                .map((sm: string) => {
                  let prefix = sm
                  while ((prefix.match(/-/g) || []).length > 6) {
                    const idx = prefix.lastIndexOf('-')
                    prefix = prefix.slice(0, idx)
                  }
                  return prefix
                })
            ),
          ]
          const shelfDescMap: Record<string, string> = {}
          if (shelfPrefixes.length > 0) {
            try {
              const descResp: any = await fetch(
                `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/search/get/shelf/description/map`,
                {
                  method: 'POST',
                  headers: zjHeaders,
                  body: JSON.stringify({
                    orgId: ZJLIB_ORG_ID,
                    shelfNoList: shelfPrefixes,
                  }),
                }
              ).then((r) => r.json())
              if (descResp?.code === 200 && descResp.data) {
                Object.assign(shelfDescMap, descResp.data)
              }
            } catch {
              // ignore shelf description error
            }
          }

          const districtMap: Record<string, string> = ZJLIB_BRANCH_CONFIG.districtIdMap || {}
          const creatorStr = Array.isArray(workRecord?.creator)
            ? workRecord.creator.join(',')
            : String(workRecord?.creator || '')
          const publisherStr = Array.isArray(workRecord?.publisher)
            ? workRecord.publisher.join(',')
            : String(workRecord?.publisher || '')
          const bookTitle = Array.isArray(workRecord?.title)
            ? workRecord.title[0]
            : String(workRecord?.title || title || '')

          const stateNames: Record<number, string> = {
            1: '编目中',
            2: '在馆',
            3: '借出',
            4: '丢失',
            16: '在馆(可外借)',
          }
          const holdings = rawList
            .map((item: any) => {
              const isAvailable = item.state === 2 || item.state === 16
              const isInLibraryReadOnly = item.state === 16
              const isZhijiang = String(item.districtId || '') === ZHIJIANG_DISTRICT_ID
              const districtName = districtMap[String(item.districtId || '')] || ''
              const roomName = item.local_name || item.lib_name || item.location_name || '浙江图书馆'
              const effectiveCallNo = String(item.callno || callNo || '').trim()
              // 严格遵循浙图官方校验：仅当当前所属馆区为「之江馆区」且在馆(state 2/16)时，shelf_mark 才有效（排除跨馆归还到曙光路馆的残留旧架标）
              const rawShelfMark =
                isZhijiang && isAvailable ? String(item.shelf_mark || '').trim() : ''
              let shelfText = rawShelfMark
              if (rawShelfMark) {
                let prefix = rawShelfMark
                while ((prefix.match(/-/g) || []).length > 6) {
                  prefix = prefix.slice(0, prefix.lastIndexOf('-'))
                }
                const baseDesc = shelfDescMap[prefix]
                if (baseDesc) {
                  const posNum = parseInt(rawShelfMark.split('-').pop() || '0', 10)
                  shelfText = posNum > 0 ? `${baseDesc}第${posNum}位` : baseDesc
                }
              } else if (roomName.includes('立库') || roomName.includes('保存本')) {
                shelfText = '闭架智能立库：到服务台/检索机凭条码申请机器调阅（馆内阅读）'
              } else if (roomName.includes('闭架')) {
                shelfText = '闭架外借书库：到服务台凭索书号/条码请馆员调取（可外借）'
              } else {
                shelfText = effectiveCallNo
              }
              const navUrl = rawShelfMark
                ? `https://map.zjlib.cn/h5/library-pc/#/?callno=${encodeURIComponent(effectiveCallNo)}&title=${encodeURIComponent(bookTitle)}&shelfMark=${encodeURIComponent(rawShelfMark)}&barcode=${encodeURIComponent(item.barcode || '')}&creator=${encodeURIComponent(creatorStr)}&publisher=${encodeURIComponent(publisherStr)}`
                : ''
              return {
                isAvailable,
                isInLibraryReadOnly,
                stateName:
                  item.state_name ||
                  stateNames[Number(item.state)] ||
                  (isAvailable ? '在馆' : '借出/不可借'),
                libName: districtName ? `浙图·${districtName}` : '浙江图书馆',
                location: roomName,
                callNo: effectiveCallNo,
                barcode: item.barcode || '',
                shelfNo: shelfText,
                rawShelfMark,
                volInfo: item.vol_info || '',
                navUrl,
              }
            })
            const sortedZjHoldings = sortHoldingsByPriority('zjlib', holdings)
            holdings.splice(0, holdings.length, ...sortedZjHoldings)

          const primaryNavHolding =
            holdings.find((h) => h.isAvailable && h.navUrl) || holdings.find((h) => h.navUrl)

          res.end(
            setPublicQueryCache(holdingCacheKey, {
              ok: true,
              library: 'zjlib',
              bibId,
              officialUrl: `https://www.zjlib.cn/search/book?id=${encodeURIComponent(bibId)}`,
              primaryNavUrl: primaryNavHolding?.navUrl || '',
              primaryShelfNo: primaryNavHolding?.shelfNo || '',
              totalCount: holdings.length,
              availableCount: holdings.filter((h) => h.isAvailable).length,
              holdings,
            })
          )
        } catch (err: any) {
          res.statusCode = err?.statusCode || 500
          res.end(
            JSON.stringify({
              ok: false,
              reqId: req.__reqId,
              message: formatUpstreamError(err, '查询馆藏状态失败', req, '/api/holding/query'),
            })
          )
        }
      })

      // 0D. 在线续借接口（支持浙江图书馆与杭州图书馆） (/api/loan/renew)
      server.middlewares.use('/api/loan/renew', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, message: 'Method Not Allowed' }))
          return
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const body = await readJsonBody(req)
          const library: 'zjlib' | 'hzlib' = body.library || 'zjlib'
          const barcode: string = String(body.barcode || '').trim()
          const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

          if (!barcode) {
            res.end(JSON.stringify({ ok: false, message: '该图书缺少条码号，无法发起在线续借' }))
            return
          }

          // 1. 浙江图书馆在线续借
          if (library === 'zjlib') {
            let token: string = String(body.token || '').trim()
            const account: string = String(body.account || '').trim()
            const password: string = String(body.password || '')
            const encryptedPasswordInput: string = String(body.encryptedPassword || '').trim()

            if (!token && account && (encryptedPasswordInput || password)) {
              const encryptedPassword =
                encryptedPasswordInput || encryptZjlibPassword(password)
              const loginResp: any = await fetch(
                `${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/login`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'BFF-ORG-ID': ZJLIB_ORG_ID,
                    'Accept-Language': 'zh-CN;q=0.9',
                    'User-Agent': ua,
                  },
                  body: JSON.stringify({ account, password: encryptedPassword, type: 1 }),
                }
              ).then((r) => r.json())
              if (loginResp?.code === 200 && loginResp.data) {
                token = loginResp.data
              } else {
                res.end(
                  JSON.stringify({
                    ok: false,
                    message: loginResp?.desc || '浙江图书馆未登录或密码有误，请先在「导入/更新记录」中登录浙图',
                  })
                )
                return
              }
            }

            if (!token) {
              res.end(
                JSON.stringify({
                  ok: false,
                  message: '未检测到浙江图书馆登录态，请先在「导入/更新记录」中保存浙图账号或扫码登录',
                })
              )
              return
            }

            const zjHeaders = {
              'Content-Type': 'application/json',
              'BFF-ORG-ID': ZJLIB_ORG_ID,
              'Accept-Language': 'zh-CN;q=0.9',
              'BFF-USER-TOKEN': token,
              Cookie: `userToken=${token}; bffUserToken=${token}`,
              'User-Agent': ua,
            }

            // 获取读者卡号 readerCardNo
            let readerCardNo = account
            try {
              const uInfo: any = await fetch(
                `${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/enc/user-info`,
                { headers: zjHeaders }
              ).then((r) => r.json())
              if (uInfo?.code === 200 && uInfo.data) {
                readerCardNo =
                  uInfo.data.plaintextCardNum ||
                  uInfo.data.plaintextIdCard ||
                  uInfo.data.plaintextMobilePhone ||
                  readerCardNo
              }
            } catch {
              // ignore
            }

            const renewResp: any = await fetch(
              `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/myOrder/batch/renew`,
              {
                method: 'POST',
                headers: zjHeaders,
                body: JSON.stringify({
                  barcodeList: [barcode],
                  channel: 3,
                  readerCardNo,
                }),
              }
            ).then((r) => r.json())

            if (
              renewResp?.code === 401 &&
              account &&
              (encryptedPasswordInput || password) &&
              body.token
            ) {
              // Token expired, retry with account/password login once
              const encryptedPassword =
                encryptedPasswordInput || encryptZjlibPassword(password)
              const loginResp: any = await fetch(
                `${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/login`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'BFF-ORG-ID': ZJLIB_ORG_ID,
                    'Accept-Language': 'zh-CN;q=0.9',
                    'User-Agent': ua,
                  },
                  body: JSON.stringify({ account, password: encryptedPassword, type: 1 }),
                }
              ).then((r) => r.json())
              if (loginResp?.code === 200 && loginResp.data) {
                token = loginResp.data
                zjHeaders['BFF-USER-TOKEN'] = token
                zjHeaders.Cookie = `userToken=${token}; bffUserToken=${token}`
              }
            }

            const msgItem = renewResp?.data?.circulateMsgVOList?.[0]
            const isSuccess =
              renewResp?.code === 200 &&
              (msgItem?.code === '2000080021' || String(msgItem?.message || '').includes('成功'))

            // 拉取最新在借列表以获取更新后的 dueDate 和 renewCount
            let newDueDate = ''
            let newRenewCount = 1
            try {
              const curResp: any = await fetch(
                `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/myLoans/current-loan`,
                {
                  method: 'POST',
                  headers: zjHeaders,
                  body: JSON.stringify({ haveRegister: 1 }),
                }
              ).then((r) => r.json())
              const matched = (curResp?.data || []).find((x: any) => x.barcode === barcode)
              if (matched) {
                newDueDate = (matched.dueDate || '').slice(0, 10)
                newRenewCount = Math.max(Number(matched.renewCount || 0), 1)
              }
            } catch {
              // ignore
            }

            res.end(
              JSON.stringify({
                ok: isSuccess,
                token,
                dueDate: newDueDate,
                renewCount: newRenewCount,
                message:
                  msgItem?.message ||
                  renewResp?.desc ||
                  renewResp?.message ||
                  (isSuccess ? '浙江图书馆续借成功！' : '续借失败（每本图书最多可续借 1 次）'),
              })
            )
            return
          }

          // 2. 杭州图书馆在线续借
          const account: string = String(body.account || '').trim()
          const password: string = String(body.password || '')
          const encryptedPasswordInput: string = String(body.encryptedPassword || '').trim()
          const clientSessionCookie: string = String(body.sessionCookie || body.cookie || '').trim()
          const loginSessionCookie: string = String(body.loginSessionCookie || '').trim()
          const captchaCode: string = String(body.captchaCode || '').trim()
          const captchaSessionCookie: string = String(body.captchaSessionCookie || '').trim()
          const captchaPemKey: string = String(body.captchaPemKey || '').trim()

          if (!clientSessionCookie && (!account || (!encryptedPasswordInput && !password))) {
            res.end(
              JSON.stringify({
                ok: false,
                message: '未检测到当前浏览器的杭州图书馆账号凭证，请先在「导入/更新记录」中登录并勾选保存',
              })
            )
            return
          }

          let sessionCookie = clientSessionCookie
          let renewListHtml = ''

          // 仅尝试复用当前客户端传入的杭图登录会话获取 renewList（绝不跨用户共享）
          if (sessionCookie && !captchaCode) {
            const testResp = await fetch(
              'https://my1.zjhzlib.cn/opac/loan/renewList?page=1&rows=100',
              { headers: { Cookie: sessionCookie, 'User-Agent': ua }, redirect: 'manual' }
            )
            if (testResp.status === 200) {
              const testHtml = await testResp.text()
              if (!testHtml.includes('id="loginForm"') && testHtml.includes('name="pdsToken"')) {
                renewListHtml = testHtml
              } else {
                sessionCookie = ''
              }
            } else {
              sessionCookie = ''
            }
          }

          if (!sessionCookie) {
            let pemKey = ''
            let encryptedPwd = encryptedPasswordInput
            if (captchaCode && captchaSessionCookie && (encryptedPwd || captchaPemKey)) {
              sessionCookie = captchaSessionCookie
              pemKey = captchaPemKey
            } else if (encryptedPwd && (loginSessionCookie || captchaSessionCookie)) {
              sessionCookie = loginSessionCookie || captchaSessionCookie
            } else {
              if (!password) {
                res.end(
                  JSON.stringify({
                    ok: false,
                    message: '杭州图书馆登录会话已过期，请在「导入/更新记录」中重新登录同步',
                  })
                )
                return
              }
              const loginPageResp = await fetch('https://my1.zjhzlib.cn/opac/reader/login', {
                headers: { 'User-Agent': ua },
              })
              const setCookies = loginPageResp.headers.getSetCookie?.() || [
                loginPageResp.headers.get('set-cookie') || '',
              ]
              const jsessionMatch = setCookies.join('; ').match(/JSESSIONID=[^;]+/)
              sessionCookie = jsessionMatch ? jsessionMatch[0] : ''

              const pemResp = await fetch(
                `https://my1.zjhzlib.cn/opac/certificate/pem?checkCode=${Date.now()}opac`,
                { headers: { 'User-Agent': ua, Cookie: sessionCookie } }
              )
              pemKey = await pemResp.text()
            }

            if (!encryptedPwd) {
              encryptedPwd = encryptHzlibPassword(password, pemKey)
            }
            const formData = new URLSearchParams()
            formData.set('vToken', '')
            formData.set('rdLoginId', account)
            formData.set('p', '')
            formData.set('rdPasswd', encryptedPwd)
            formData.set('returnUrl', '')
            formData.set('password', '')
            if (captchaCode) {
              for (const fieldName of HZLIB_CAPTCHA_FIELD_NAMES) {
                formData.set(fieldName, captchaCode)
              }
            }

            const loginResp = await fetch('https://my1.zjhzlib.cn/opac/reader/doLogin', {
              method: 'POST',
              redirect: 'manual',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: sessionCookie,
                'User-Agent': ua,
                Referer: 'https://my1.zjhzlib.cn/opac/reader/login',
              },
              body: formData.toString(),
            })
            const loginCookies = loginResp.headers.getSetCookie?.() || [
              loginResp.headers.get('set-cookie') || '',
            ]
            const newSessionMatch = loginCookies.join('; ').match(/JSESSIONID=[^;]+/)
            if (newSessionMatch) sessionCookie = newSessionMatch[0]

            if (loginResp.status === 200) {
              const loginHtml = await loginResp.text()
              if (loginHtml.includes('id="loginForm"')) {
                const nextCaptcha = await createHzlibCaptchaSession(ua)
                res.end(
                  JSON.stringify({
                    ok: false,
                    needCaptcha: true,
                    ...nextCaptcha,
                    message: '杭图续借需输入 4 位图形验证码，请在下方输入验证码后再次点击续借：',
                  })
                )
                return
              }
            }

            const curResp0 = await fetch(
              'https://my1.zjhzlib.cn/opac/loan/renewList?page=1&rows=100',
              { headers: { Cookie: sessionCookie, 'User-Agent': ua } }
            )
            renewListHtml = await curResp0.text()
          }

          const { pdsToken, rowsByBarcode: beforeMap } = parseHzlibRenewListPage(renewListHtml)
          const beforeRow = beforeMap.get(barcode)
          const beforeDueDate = beforeRow?.dueDate || ''
          const beforeRenewCount = beforeRow?.renewCount ?? 0

          // 调用杭图图创 OPAC 真实续借提交接口 /opac/loan/doRenew（必须携带 pdsToken）
          const renewParams = new URLSearchParams()
          if (pdsToken) renewParams.set('pdsToken', pdsToken)
          renewParams.set('barcodeList', barcode)
          renewParams.set('furl', '/opac/loan/renewList')
          renewParams.set('renewAll', '')
          const renewResp = await fetch('https://my1.zjhzlib.cn/opac/loan/doRenew', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Cookie: sessionCookie,
              'User-Agent': ua,
              Referer: 'https://my1.zjhzlib.cn/opac/loan/renewList',
            },
            body: renewParams.toString(),
          })
          const renewText = await renewResp.text()
          const $renew = cheerio.load(renewText)
          const promptBox = $renew('#page_content #content').length
            ? $renew('#page_content #content').clone()
            : $renew('#content').clone()
          promptBox.find('script, style, input, button').remove()
          const promptText = promptBox
            .text()
            .replace(/\s+/g, ' ')
            .replace(/^操作提示\s*[:：]?\s*/, '')
            .trim()

          // 重新拉取 renewList 核对该书最新应还日期与官方续借次数
          const curResp = await fetch(
            'https://my1.zjhzlib.cn/opac/loan/renewList?page=1&rows=100',
            { headers: { Cookie: sessionCookie, 'User-Agent': ua } }
          )
          const afterHtml = await curResp.text()
          const { rowsByBarcode: afterMap } = parseHzlibRenewListPage(afterHtml)
          const matchedRow = afterMap.get(barcode)
          const newDueDate = matchedRow?.dueDate || beforeDueDate
          const updatedRenewCount =
            matchedRow && typeof matchedRow.renewCount === 'number'
              ? matchedRow.renewCount
              : beforeRenewCount

          let isSuccess = false
          let msg = ''
          if (
            (newDueDate && beforeDueDate && newDueDate > beforeDueDate) ||
            updatedRenewCount > beforeRenewCount ||
            (promptText.includes('成功') &&
              !promptText.includes('对不起') &&
              !promptText.includes('失败') &&
              !promptText.includes('不能'))
          ) {
            isSuccess = true
            msg = promptText
              ? `✅ ${promptText}（最新应还日期：${newDueDate}，已续借 ${updatedRenewCount}/2 次）`
              : `✅ 续借成功！应还日期已延长至：${newDueDate}（已续借 ${updatedRenewCount}/2 次）`
          } else {
            msg =
              promptText ||
              '当前暂无法续借（杭图规定：借期内最多续借2次，或距到期日尚早/文献类型不支持续借）'
          }

          res.end(
            JSON.stringify({
              ok: isSuccess,
              sessionCookie,
              dueDate: newDueDate,
              renewCount: updatedRenewCount,
              message: msg,
            })
          )
        } catch (err: any) {
          res.statusCode = err?.statusCode || 500
          res.end(
            JSON.stringify({
              ok: false,
              reqId: req.__reqId,
              message: formatUpstreamError(err, '在线续借请求失败', req, '/api/loan/renew'),
            })
          )
        }
      })

      // 1A. 浙江图书馆获取微信/支付宝登录二维码 (/api/zjlib/qr)
      server.middlewares.use('/api/zjlib/qr', async (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const urlObj = new URL(req.url || '', 'http://localhost')
          const action = urlObj.searchParams.get('action') || 'create'
          const type = urlObj.searchParams.get('type') || 'wechat'
          const uuid = urlObj.searchParams.get('uuid') || ''
          const headers = {
            'BFF-ORG-ID': ZJLIB_ORG_ID,
            'Accept-Language': 'zh-CN;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          }

          if (action === 'status' && uuid) {
            const stResp = await fetch(
              `${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/qr/status?uuid=${encodeURIComponent(uuid)}`,
              { headers }
            )
            const stJson: any = await stResp.json()
            res.end(
              JSON.stringify({
                ok: stJson.code === 200,
                status: stJson.data?.status || '',
                token: stJson.data?.status === 'COMPLETE' ? stJson.data?.data || '' : '',
                message: stJson.desc || '',
              })
            )
            return
          }

          const endpoint =
            type === 'alipay'
              ? `${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/login/zfb-qr`
              : `${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/login/wechat-qr`
          const qrResp = await fetch(endpoint, { headers })
          const qrJson: any = await qrResp.json()
          if (qrJson.code !== 200 || !qrJson.data) {
            res.end(JSON.stringify({ ok: false, message: qrJson.desc || '获取二维码失败' }))
            return
          }
          const qrCode =
            type === 'wechat' && !String(qrJson.data.qrCode).startsWith('data:')
              ? `data:image/png;base64,${qrJson.data.qrCode}`
              : qrJson.data.qrCode
          res.end(
            JSON.stringify({
              ok: true,
              uuid: qrJson.data.uuid,
              qrCode,
              type,
            })
          )
        } catch (err: any) {
          res.statusCode = err?.statusCode || 500
          res.end(
            JSON.stringify({
              ok: false,
              reqId: req.__reqId,
              message: formatUpstreamError(err, '获取浙图二维码出错', req, '/api/zjlib/qr'),
            })
          )
        }
      })

      // 1. 浙江图书馆同步接口 (/api/zjlib/sync)
      server.middlewares.use('/api/zjlib/sync', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, message: 'Method Not Allowed' }))
          return
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const body = await readJsonBody(req)
          let token: string = (body.token || '').trim()
          const account: string = (body.account || '').trim()
          const password: string = body.password || ''
          const encryptedPasswordInput: string = String(body.encryptedPassword || '').trim()
          const maxPages: number = Math.min(Number(body.maxPages) || 20, 50)

          if (!token && account && (encryptedPasswordInput || password)) {
            const encryptedPassword =
              encryptedPasswordInput || encryptZjlibPassword(password)
            const loginResp = await fetch(`${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/login`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'BFF-ORG-ID': ZJLIB_ORG_ID,
                'Accept-Language': 'zh-CN;q=0.9',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              },
              body: JSON.stringify({
                account,
                password: encryptedPassword,
                type: 1,
              }),
            })
            const loginData: any = await loginResp.json()
            if (loginData.code !== 200 || !loginData.data) {
              res.end(
                JSON.stringify({
                  ok: false,
                  message:
                    loginData.desc ||
                    loginData.message ||
                    '浙江图书馆账号或密码错误（您也可以直接切换上方「微信/支付宝扫码」一键登录同步）',
                })
              )
              return
            }
            token = loginData.data
          }

          if (!token) {
            res.end(JSON.stringify({ ok: false, message: '请提供浙江图书馆 BFF-USER-TOKEN 或账号密码' }))
            return
          }

          const headers = {
            'Content-Type': 'application/json',
            'BFF-ORG-ID': ZJLIB_ORG_ID,
            'Accept-Language': 'zh-CN;q=0.9',
            'BFF-USER-TOKEN': token,
            Cookie: `userToken=${token}; bffUserToken=${token}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          }

          // Fetch current loans
          const curResp = await fetch(
            `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/myLoans/current-loan`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({ haveRegister: 1 }),
            }
          )
          const curJson: any = await curResp.json()
          if (curJson.code !== 200) {
            res.end(
              JSON.stringify({
                ok: false,
                message: curJson.message || curJson.desc || 'Token 已失效或无权限，请重新扫码或登录获取',
              })
            )
            return
          }

          const normalized: any[] = []
          for (const item of curJson.data || []) {
            normalized.push({
              library: 'zjlib',
              subLibrary: item.newBook ? '浙图·网借新书' : item.cirTypeName || '浙江图书馆',
              status: 'borrowed',
              title: item.title || '',
              author: item.author || '',
              isbn: item.isbn || '',
              callNo: item.callNo || '',
              barcode: item.barcode || '',
              bibId: item.bibId || '',
              loanDate: (item.loanDate || '').slice(0, 10),
              dueDate: (item.dueDate || '').slice(0, 10),
              returnDate: '',
              renewCount: Number(item.renewCount || 0),
              coverUrl: isPlaceholderCoverUrl(item.coverUrl || '') ? '' : item.coverUrl,
            })
          }

          // Fetch history loans page by page
          let current = 1
          const size = 100
          let total = 0
          while (current <= maxPages) {
            const hisResp = await fetch(
              `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/myLoans/history-loan`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  startDate: '',
                  endDate: '',
                  sortDesc: true,
                  sortColumns: 'loanDate',
                  searchValue: '',
                  newBook: null,
                  size,
                  current,
                  haveRegister: 1,
                }),
              }
            )
            const hisJson: any = await hisResp.json()
            if (hisJson.code !== 200 || !hisJson.data) break
            const records = hisJson.data.records || []
            total = Number(hisJson.data.total || 0)
            for (const item of records) {
              normalized.push({
                library: 'zjlib',
                subLibrary: item.newBook ? '浙图·网借新书' : item.cirTypeName || '浙江图书馆',
                status: 'returned',
                title: item.title || '',
                author: item.author || '',
                isbn: item.isbn || '',
                callNo: item.callNo || '',
                barcode: item.barcode || '',
                bibId: item.bibId || '',
                loanDate: (item.loanDate || '').slice(0, 10),
                dueDate: (item.dueDate || '').slice(0, 10),
                returnDate: (item.createTime || item.returnDate || '').slice(0, 10),
                renewCount: 0,
                coverUrl: isPlaceholderCoverUrl(item.coverUrl || '') ? '' : item.coverUrl,
              })
            }
            if (records.length < size || normalized.length >= total + (curJson.data?.length || 0)) {
              break
            }
            current++
          }

          res.end(
            JSON.stringify({
              ok: true,
              token,
              records: normalized,
              summary: {
                currentCount: (curJson.data || []).length,
                historyCount: normalized.length - (curJson.data || []).length,
              },
            })
          )
        } catch (err: any) {
          res.statusCode = err?.statusCode || 500
          res.end(
            JSON.stringify({
              ok: false,
              reqId: req.__reqId,
              message: formatUpstreamError(err, '同步浙江图书馆出错', req, '/api/zjlib/sync'),
            })
          )
        }
      })

      // 2. 杭州图书馆同步接口 (/api/hzlib/sync)
      server.middlewares.use('/api/hzlib/sync', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, message: 'Method Not Allowed' }))
          return
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const body = await readJsonBody(req)
          const account: string = (body.account || '').trim()
          const password: string = body.password || ''
          const encryptedPasswordInput: string = String(body.encryptedPassword || '').trim()
          let sessionCookie: string = (body.cookie || '').trim()
          const loginSessionCookie: string = String(body.loginSessionCookie || '').trim()
          const captchaCode: string = (body.captchaCode || '').trim()
          const captchaSessionCookie: string = (body.captchaSessionCookie || '').trim()
          const captchaPemKey: string = (body.captchaPemKey || '').trim()
          const maxPages: number = Math.min(Number(body.maxPages) || 20, 50)

          const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

          if (!sessionCookie) {
            if (!account || (!encryptedPasswordInput && !password)) {
              res.end(JSON.stringify({ ok: false, message: '请输入杭州图书馆读者证号/身份证号与密码' }))
              return
            }
            let pemKey = ''
            let encryptedPwd = encryptedPasswordInput
            if (captchaCode && captchaSessionCookie && (encryptedPwd || captchaPemKey)) {
              sessionCookie = captchaSessionCookie
              pemKey = captchaPemKey
            } else if (encryptedPwd && (loginSessionCookie || captchaSessionCookie)) {
              sessionCookie = loginSessionCookie || captchaSessionCookie
            } else {
              const loginPageResp = await fetch('https://my1.zjhzlib.cn/opac/reader/login', {
                headers: { 'User-Agent': ua },
              })
              const setCookies = loginPageResp.headers.getSetCookie?.() || [
                loginPageResp.headers.get('set-cookie') || '',
              ]
              const jsessionMatch = setCookies.join('; ').match(/JSESSIONID=[^;]+/)
              sessionCookie = jsessionMatch ? jsessionMatch[0] : ''

              const pemResp = await fetch(
                `https://my1.zjhzlib.cn/opac/certificate/pem?checkCode=${Date.now()}opac`,
                {
                  headers: { 'User-Agent': ua, Cookie: sessionCookie },
                }
              )
              pemKey = await pemResp.text()
            }

            if (!encryptedPwd) {
              encryptedPwd = encryptHzlibPassword(password, pemKey)
            }

            const formData = new URLSearchParams()
            formData.set('vToken', '')
            formData.set('rdLoginId', account)
            formData.set('p', '')
            formData.set('rdPasswd', encryptedPwd)
            formData.set('returnUrl', '')
            formData.set('password', '')
            if (captchaCode) {
              for (const fieldName of HZLIB_CAPTCHA_FIELD_NAMES) {
                formData.set(fieldName, captchaCode)
              }
            }

            const loginResp = await fetch('https://my1.zjhzlib.cn/opac/reader/doLogin', {
              method: 'POST',
              redirect: 'manual',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: sessionCookie,
                'User-Agent': ua,
                Referer: 'https://my1.zjhzlib.cn/opac/reader/login',
              },
              body: formData.toString(),
            })

            const loginCookies = loginResp.headers.getSetCookie?.() || [loginResp.headers.get('set-cookie') || '']
            const newSessionMatch = loginCookies.join('; ').match(/JSESSIONID=[^;]+/)
            if (newSessionMatch) {
              sessionCookie = newSessionMatch[0]
            }

            // If status is 200 and still on login page, extract error tip
            if (loginResp.status === 200) {
              const loginHtml = await loginResp.text()
              if (loginHtml.includes('id="loginForm"')) {
                const $ = cheerio.load(loginHtml)
                const errText =
                  $('#tipForlogin').text().trim() ||
                  $('.form label[style*="red"]').text().trim() ||
                  '账号或密码不正确，请确认杭图读者证/身份证号及借书密码'
                const nextCaptcha = await createHzlibCaptchaSession(ua)
                res.end(
                  JSON.stringify({
                    ok: false,
                    needCaptcha: true,
                    ...nextCaptcha,
                    message: errText.includes('验证码')
                      ? '触发杭图图形验证码校验（原因：该证号前一次密码校验未通过，杭图后台自动开启了验证码保护）。请确认您的借书密码，并输入下方 4 位验证码重试：'
                      : `${errText}（提示：输错 1 次密码后杭图后台会要求校验图形验证码，请确认密码并填写下方验证码重试）`,
                  })
                )
                return
              }
            }
          }

          // Fetch all pages of currentLoanList (rows=100)
          const rawCurrentRows: RawHzlibRow[] = []
          let curPage = 1
          while (curPage <= 10) {
            const curResp = await fetch(
              `https://my1.zjhzlib.cn/opac/loan/currentLoanList?page=${curPage}&rows=100`,
              {
                headers: {
                  Cookie: sessionCookie,
                  'User-Agent': ua,
                },
              }
            )
            const curHtml = await curResp.text()
            if (curHtml.includes('id="loginForm"')) {
              res.end(
                JSON.stringify({ ok: false, message: '杭州图书馆登录态无效或已过期，请检查账号密码' })
              )
              return
            }
            const parsedCur = parseHzlibTableRows(curHtml)
            rawCurrentRows.push(...parsedCur.rows)
            if (!parsedCur.hasNextPage || parsedCur.rows.length === 0) break
            curPage++
          }

          // Fetch renewList to obtain official exact renewCount for currently borrowed books
          let renewByBarcode = new Map<
            string,
            { barcode: string; title: string; loanDate: string; dueDate: string; renewCount: number }
          >()
          try {
            const renewResp = await fetch(
              'https://my1.zjhzlib.cn/opac/loan/renewList?page=1&rows=100',
              {
                headers: {
                  Cookie: sessionCookie,
                  'User-Agent': ua,
                },
              }
            )
            const renewHtml = await renewResp.text()
            renewByBarcode = parseHzlibRenewListPage(renewHtml).rowsByBarcode
          } catch {
            // fallback to date-span estimation if renewList fails
          }

          // Fetch all pages of historyLoanList (rows=100, using hasNextPage)
          const rawHistoryRows: RawHzlibRow[] = []
          let hisPage = 1
          while (hisPage <= maxPages) {
            const hisResp = await fetch(
              `https://my1.zjhzlib.cn/opac/loan/historyLoanList?page=${hisPage}&rows=100`,
              {
                headers: {
                  Cookie: sessionCookie,
                  'User-Agent': ua,
                },
              }
            )
            const hisHtml = await hisResp.text()
            const parsedHis = parseHzlibTableRows(hisHtml)
            rawHistoryRows.push(...parsedHis.rows)
            if (!parsedHis.hasNextPage || parsedHis.rows.length === 0) break
            hisPage++
          }

          const { currentRecords, historyRecords } = buildNormalizedHzlibRecords(
            rawCurrentRows,
            rawHistoryRows,
            renewByBarcode
          )
          const allRecords = [...currentRecords, ...historyRecords]

          res.end(
            JSON.stringify({
              ok: true,
              sessionCookie,
              records: allRecords,
              summary: {
                currentCount: currentRecords.length,
                historyCount: historyRecords.length,
              },
            })
          )
        } catch (err: any) {
          res.statusCode = err?.statusCode || 500
          res.end(
            JSON.stringify({
              ok: false,
              reqId: req.__reqId,
              message: formatUpstreamError(err, '同步杭州图书馆出错', req, '/api/hzlib/sync'),
            })
          )
        }
      })
}

let serverlessRoutes: Array<{ route: string; fn: (req: any, res: any, next?: any) => any }> | null =
  null

/**
 * 供 Vercel Serverless Functions (`api/[...path].ts`) 或独立 Node HTTP Server 直接分发的请求处理器
 */
export async function handleLibraryApiRequest(req: any, res: any): Promise<void> {
  if (!serverlessRoutes) {
    const list: Array<{ route: string; fn: (req: any, res: any, next?: any) => any }> = []
    registerLibraryApiMiddlewares({
      middlewares: {
        use(route: string, fn: (req: any, res: any, next?: any) => any) {
          list.push({ route, fn })
        },
      },
    })
    serverlessRoutes = list
  }
  const fullUrl = req.url || '/'
  const qIndex = fullUrl.indexOf('?')
  const pathname = qIndex >= 0 ? fullUrl.slice(0, qIndex) : fullUrl
  const search = qIndex >= 0 ? fullUrl.slice(qIndex) : ''

  for (const item of serverlessRoutes) {
    if (pathname === item.route || pathname.startsWith(item.route + '/')) {
      const subPath = pathname.slice(item.route.length) || '/'
      req.url = subPath + search
      await item.fn(req, res, () => {})
      return
    }
  }

  res.statusCode = 404
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ ok: false, message: `Unknown API route: ${pathname}` }))
}

export function librarySyncProxyPlugin(): Plugin {
  return {
    name: 'library-sync-proxy',
    configureServer(server) {
      registerLibraryApiMiddlewares(server)
    },
    configurePreviewServer(server) {
      registerLibraryApiMiddlewares(server)
    },
  }
}
