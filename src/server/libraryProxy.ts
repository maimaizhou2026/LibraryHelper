import type { Plugin } from 'vite'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as cheerio from 'cheerio'
import smCrypto from 'sm-crypto'
import {
  getLibraryAddressInfo,
  getLibraryBranchPriority,
  ZJLIB_BRANCH_CONFIG,
} from '../utils/mapLink'

let latestHzlibSyncCache: { records: any[]; syncedAt: string } | null = null
let lastHzlibSessionCookie = ''
let coverMemoryCache: Record<string, string> | null = null

const ZJLIB_SM2_PUBLIC_KEY =
  '0482ddef5f3839bc64562d7f88782be9923785a5f05beaa25c9e8932d6591aa50b47f27aa9595f98ff80e88c1751b95bc9554de41874b37cb4b50028e4cf0ac0e1'
const ZJLIB_ORG_ID = '1916318653650423810'
const ZJLIB_API_BASE = 'https://www.zjlib.cn/bff-api'
const COVER_CACHE_FILE = path.resolve(process.cwd(), '.cover-cache.json')
const FALLBACK_COVER_CACHE_FILE = path.join(os.tmpdir(), 'library-helper-cover-cache.json')

async function loadCoverCache(): Promise<Record<string, string>> {
  if (coverMemoryCache) return coverMemoryCache
  try {
    const txt = await fs.readFile(COVER_CACHE_FILE, 'utf8')
    coverMemoryCache = JSON.parse(txt) || {}
  } catch {
    try {
      const fallbackTxt = await fs.readFile(FALLBACK_COVER_CACHE_FILE, 'utf8')
      coverMemoryCache = JSON.parse(fallbackTxt) || {}
    } catch {
      coverMemoryCache = {}
    }
  }
  return coverMemoryCache!
}

async function saveCoverCache(cache: Record<string, string>): Promise<void> {
  coverMemoryCache = cache
  try {
    await fs.writeFile(COVER_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8')
  } catch {
    try {
      await fs.writeFile(FALLBACK_COVER_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8')
    } catch {
      // ignore write error in read-only environments
    }
  }
}

function isPlaceholderCoverUrl(url: string): boolean {
  if (!url) return true
  return (
    url.includes('5133167f051e4f9a8c8797b35577ef4f') ||
    url.includes('3593b961f9094da9887a8cbb2105d18c') ||
    url.includes('fbc18786cafb44babc3b3b666bb0710c') ||
    url.includes('1a8b6e68853e4278bd05ed5a05844deb') ||
    url.includes('tc-cover-prod.oss') ||
    url.includes('xinhuapic.oss') ||
    url.includes('doubanio.com') ||
    url.endsWith('.null')
  )
}

async function searchInternetBookCover(title: string, author: string): Promise<string> {
  const cleanTitle = title.replace(/[《》「」【】]/g, ' ').trim()
  const cleanAuthor = author.replace(/\[.*?\]|\(.*?\)|（.*?）|著|绘|编|译/g, ' ').trim()
  const queries = [
    `${cleanTitle} ${cleanAuthor} 图书封面`.trim(),
    `${cleanTitle} 书籍封面`.trim(),
  ]
  for (const q of queries) {
    try {
      const bdUrl = `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&fp=result&word=${encodeURIComponent(q)}&pn=0&rn=5`
      const bdJson: any = await fetch(bdUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://image.baidu.com/',
        },
      }).then((r) => r.json())
      const candidates = (bdJson?.data || []).filter(
        (d: any) =>
          (d?.thumbURL || d?.middleURL) &&
          !isPlaceholderCoverUrl(String(d?.thumbURL || d?.middleURL || ''))
      )
      if (candidates.length > 0) {
        const chosen = candidates[0]
        return String(chosen.thumbURL || chosen.middleURL).replace(/^http:\/\//i, 'https://')
      }
    } catch {
      // ignore and try next query
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

async function readJsonBody(req: any): Promise<any> {
  if (req.body && typeof req.body === 'object') {
    return req.body
  }
  if (typeof req.body === 'string') {
    return req.body ? JSON.parse(req.body) : {}
  }
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: any) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
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

async function createHzlibCaptchaSession(ua: string) {
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

export function registerLibraryApiMiddlewares(server: {
  middlewares: { use: (route: string, fn: (req: any, res: any, next?: any) => any) => void }
}) {
      server.middlewares.use('/api/health', (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(
          JSON.stringify({
            ok: true,
            status: 'healthy',
            timestamp: new Date().toISOString(),
          })
        )
      })

      server.middlewares.use('/api/hzlib/latest-cache', (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(
          JSON.stringify({
            ok: Boolean(latestHzlibSyncCache),
            ...(latestHzlibSyncCache || { records: [] }),
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
      server.middlewares.use('/api/hzlib/captcha', async (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          const bundle = await createHzlibCaptchaSession(ua)
          res.end(JSON.stringify({ ok: true, ...bundle }))
        } catch (err: any) {
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, message: err?.message || '获取验证码失败' }))
        }
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
          const items: Array<{ id: string; isbn?: string; title?: string; author?: string }> =
            Array.isArray(body.items) ? body.items.slice(0, 35) : []
          const cache = await loadCoverCache()
          const resolvedById: Record<string, string> = {}
          const unresolved: Array<{
            id: string
            cleanIsbn: string
            title: string
            author: string
            cacheKey: string
          }> = []

          for (const item of items) {
            const cleanIsbn = (item.isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase()
            const title = (item.title || '').trim()
            const author = (item.author || '').trim()
            const cacheKey = cleanIsbn ? `isbn:${cleanIsbn}` : `title:${title}`
            if (!forceInternet && cache[cacheKey] && !isPlaceholderCoverUrl(cache[cacheKey])) {
              resolvedById[item.id] = cache[cacheKey]
            } else {
              unresolved.push({ id: item.id, cleanIsbn, title, author, cacheKey })
            }
          }

          // Tier 1: 图创/杭图官方封面中心 (book-resource.dataesb.com)
          const isbnsToQuery = [
            ...new Set(
              (forceInternet ? [] : unresolved)
                .map((u) => u.cleanIsbn)
                .filter((s) => s.length >= 10)
            ),
          ]
          const isbnCoverMap: Record<string, string> = {}
          if (isbnsToQuery.length > 0) {
            try {
              const url = `https://book-resource.dataesb.com/websearch/metares?glc=P1ZJ0571001&cmdACT=getImages&type=0&isbns=${isbnsToQuery.join(',')}&callback=cb`
              const txt = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
              }).then((r) => r.text())
              const jsonStr = txt.replace(/^cb\(/, '').replace(/\);?\s*$/, '')
              const parsed = JSON.parse(jsonStr)
              for (const entry of parsed.result || []) {
                const link = entry.resourceLink || entry.coverlink || ''
                if (entry.isbn && link && !isPlaceholderCoverUrl(link)) {
                  // 校验返回的链接是否真实可访问且非“暂无封面”占位图(13498 / 37458 / <=2500 bytes)
                  try {
                    const headRes = await fetch(link, { method: 'HEAD' })
                    const len = Number(headRes.headers.get('content-length') || 0)
                    if (
                      headRes.ok &&
                      len > 2500 &&
                      len !== 13498 &&
                      len !== 37458
                    ) {
                      isbnCoverMap[String(entry.isbn).toUpperCase()] = link
                    }
                  } catch {
                    // ignore invalid link
                  }
                }
              }
            } catch {
              // ignore tier 1 failure
            }
          }

          const needInternetFallback: typeof unresolved = []
          for (const u of unresolved) {
            if (u.cleanIsbn && isbnCoverMap[u.cleanIsbn]) {
              const url = isbnCoverMap[u.cleanIsbn]
              resolvedById[u.id] = url
              cache[u.cacheKey] = url
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
                const imgUrl = await searchInternetBookCover(u.title, u.author)
                if (imgUrl) {
                  resolvedById[u.id] = imgUrl
                  cache[u.cacheKey] = imgUrl
                }
              })
            )
          }

          await saveCoverCache(cache)
          res.end(JSON.stringify({ ok: true, covers: resolvedById }))
        } catch (err: any) {
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, message: err?.message || '获取封面失败' }))
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
          const rows = Math.min(Number(body.rows) || 15, 24)
          const page = Math.max(1, Number(body.page) || 1)
          const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

          if (!keyword) {
            res.end(JSON.stringify({ ok: true, items: [], zjTotal: 0, hzTotal: 0, hasMore: false }))
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
                      .map((r: any) => {
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
                        }
                      })
                      .filter((x) => Boolean(x.title && x.bibId))
                      .sort((a, b) => {
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
          let combined = [...zjRes.items, ...hzRes.items]

          // 若用户输入了目标卷/集编号（如 "5卷" / "卷五"），优先过滤只保留命中该卷号的书；若 0 命中则兜底保留主书名结果
          if (targetVolNum) {
            const volMatched = combined.filter((item) =>
              extractTitleVolumes(item.title).includes(targetVolNum)
            )
            if (volMatched.length > 0) {
              combined = volMatched
            }
          }

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

          const zjPageLimit = targetVolNum ? 24 : 12
          const zjHasMore = needZj && zjRes.rawCount >= zjPageLimit && page * zjPageLimit < zjRes.total
          const hzPageSize = hzRes.pageSize || 20
          const hzHasMore = needHz && hzRes.rawCount >= hzPageSize && page * hzPageSize < hzRes.total
          const hasMore = (zjHasMore || hzHasMore) && combined.length > 0 && page < 15

          res.end(
            JSON.stringify({
              ok: true,
              page,
              hasMore,
              zjTotal: zjRes.total,
              hzTotal: hzRes.total,
              items: combined,
            })
          )
        } catch (err: any) {
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, message: err?.message || '在线检索馆藏出错' }))
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
              JSON.stringify({
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
            JSON.stringify({
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
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, message: err?.message || '查询馆藏状态失败' }))
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

            if (!token && account && password) {
              const encryptedPassword = encryptZjlibPassword(password)
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

            if (renewResp?.code === 401 && account && password && body.token) {
              // Token expired, retry with account/password login once
              const encryptedPassword = encryptZjlibPassword(password)
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
          const captchaCode: string = String(body.captchaCode || '').trim()
          const captchaSessionCookie: string = String(body.captchaSessionCookie || '').trim()
          const captchaPemKey: string = String(body.captchaPemKey || '').trim()

          if (!lastHzlibSessionCookie && (!account || !password)) {
            res.end(
              JSON.stringify({
                ok: false,
                message: '未检测到本地保存的杭州图书馆账号密码，请先在「导入/更新记录」中登录并勾选保存',
              })
            )
            return
          }

          let sessionCookie = lastHzlibSessionCookie
          let renewListHtml = ''

          // 先尝试复用缓存的杭图登录会话获取 renewList（同时包含 pdsToken 与精确续借次数）
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
            if (captchaCode && captchaSessionCookie && captchaPemKey) {
              sessionCookie = captchaSessionCookie
              pemKey = captchaPemKey
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
                { headers: { 'User-Agent': ua, Cookie: sessionCookie } }
              )
              pemKey = await pemResp.text()
            }

            const encryptedPwd = encryptHzlibPassword(password, pemKey)
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

            lastHzlibSessionCookie = sessionCookie
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
              dueDate: newDueDate,
              renewCount: updatedRenewCount,
              message: msg,
            })
          )
        } catch (err: any) {
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, message: err?.message || '在线续借请求失败' }))
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
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, message: err?.message || '获取浙图二维码出错' }))
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
          const maxPages: number = Math.min(Number(body.maxPages) || 20, 50)

          if (!token && account && password) {
            const encryptedPassword = encryptZjlibPassword(password)
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
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, message: err?.message || '同步浙江图书馆出错' }))
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
          let sessionCookie: string = (body.cookie || '').trim()
          const captchaCode: string = (body.captchaCode || '').trim()
          const captchaSessionCookie: string = (body.captchaSessionCookie || '').trim()
          const captchaPemKey: string = (body.captchaPemKey || '').trim()
          const maxPages: number = Math.min(Number(body.maxPages) || 20, 50)

          const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

          if (!sessionCookie) {
            if (!account || !password) {
              res.end(JSON.stringify({ ok: false, message: '请输入杭州图书馆读者证号/身份证号与密码' }))
              return
            }
            let pemKey = ''
            if (captchaCode && captchaSessionCookie && captchaPemKey) {
              sessionCookie = captchaSessionCookie
              pemKey = captchaPemKey
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

            const encryptedPwd = encryptHzlibPassword(password, pemKey)

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
            lastHzlibSessionCookie = sessionCookie

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
          latestHzlibSyncCache = {
            records: allRecords,
            syncedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
          }

          res.end(
            JSON.stringify({
              ok: true,
              records: allRecords,
              summary: {
                currentCount: currentRecords.length,
                historyCount: historyRecords.length,
              },
            })
          )
        } catch (err: any) {
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, message: err?.message || '同步杭州图书馆出错' }))
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
