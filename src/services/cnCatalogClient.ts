/**
 * 浏览器端境内直连：全馆书库检索 (/api/catalog/search)、实时馆藏 (/api/holding/query)、
 * 官方封面补全 (/api/covers/resolve) 及统一 apiFetch 分发器
 */

import {
  getLibraryAddressInfo,
  getLibraryBranchPriority,
  ZJLIB_BRANCH_CONFIG,
} from '../utils/mapLink'
import {
  cnRelayFetch,
  cnRelayPipeline,
  handleHzlibCaptchaDirect,
  handleHzlibSyncDirect,
  handleLoanRenewDirect,
  handleZjlibQrDirect,
  handleZjlibSyncDirect,
  shouldPreferCnDirect,
} from './cnRelayClient'

const ZJLIB_ORG_ID = '1916318653650423810'
const ZJLIB_API_BASE = 'https://www.zjlib.cn/bff-api'
const ZHIJIANG_DISTRICT_ID = '1916325141324353538'
const COVER_LOCAL_CACHE_KEY = 'lh_client_cover_cache_v1'

const clientQueryCache = new Map<string, { expiresAt: number; data: any }>()
const clientCoverCache = new Map<string, string>()
const zhijiangShelfDescCache = new Map<string, string>()
let localCoverCacheLoaded = false

function ensureLocalCoverCacheLoaded(): void {
  if (localCoverCacheLoaded || typeof localStorage === 'undefined') return
  localCoverCacheLoaded = true
  try {
    const raw = localStorage.getItem(COVER_LOCAL_CACHE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (parsed?.covers && typeof parsed.covers === 'object') {
      for (const [k, v] of Object.entries(parsed.covers)) {
        if (typeof v === 'string' && v) clientCoverCache.set(k, v)
      }
    }
  } catch {
    // ignore storage parse error
  }
}

function persistLocalCoverCache(): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (clientCoverCache.size > 600) {
      const keys = Array.from(clientCoverCache.keys())
      for (let i = 0; i < keys.length - 500; i++) {
        clientCoverCache.delete(keys[i])
      }
    }
    const coversObj: Record<string, string> = {}
    for (const [k, v] of clientCoverCache.entries()) {
      coversObj[k] = v
    }
    localStorage.setItem(COVER_LOCAL_CACHE_KEY, JSON.stringify({ covers: coversObj }))
  } catch {
    // ignore quota error
  }
}

function getClientCache(key: string): any | null {
  const hit = clientQueryCache.get(key)
  if (!hit) return null
  if (hit.expiresAt <= Date.now()) {
    clientQueryCache.delete(key)
    return null
  }
  return hit.data
}

function setClientCache(key: string, data: any): any {
  if (clientQueryCache.size > 120) {
    const firstKey = clientQueryCache.keys().next().value
    if (firstKey) clientQueryCache.delete(firstKey)
  }
  clientQueryCache.set(key, { expiresAt: Date.now() + 45000, data })
  return data
}

function sortHoldingsByPriority(library: 'zjlib' | 'hzlib', list: any[]): any[] {
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
      getLibraryAddressInfo({ library, libName: a.libName || '', location: a.location || '' }).address !==
      '未知地址'
    const bKnown =
      getLibraryAddressInfo({ library, libName: b.libName || '', location: b.location || '' }).address !==
      '未知地址'
    if (aKnown !== bKnown) return Number(bKnown) - Number(aKnown)
    const libCmp = String(a.libName || '').localeCompare(String(b.libName || ''), 'zh-CN')
    if (libCmp !== 0) return libCmp
    if (Boolean(a.navUrl) !== Boolean(b.navUrl)) {
      return Number(Boolean(b.navUrl)) - Number(Boolean(b.navUrl))
    }
    return String(a.location || '').localeCompare(String(b.location || ''), 'zh-CN')
  })
}

const CN_NUM_MAP: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 两: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9, 十: 10, 拾: 10,
  上: 1, 中: 2, 下: 3,
}

function parseCnToken(t: string): number {
  if (/^\d+$/.test(t)) return parseInt(t, 10)
  if (t.length === 1 && CN_NUM_MAP[t] !== undefined) return CN_NUM_MAP[t]
  let resNum = 0
  let cur = 0
  for (const ch of t) {
    const v = CN_NUM_MAP[ch]
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

function toNaturalTitleKey(title: string): string {
  const clean = (title || '').replace(/^[《「【(\[]+|[》」】)\]]+$/g, '').trim()
  const sepMatch = clean.match(/^([^．.：:—·(（\s]+)(?:[．.：:—·(（\s]+(.*))?$/)
  const seriesPrefix = (sepMatch ? sepMatch[1] : clean).trim()
  const subPart = (sepMatch && sepMatch[2] ? sepMatch[2] : '').trim()
  let subSeriesKey = '00_main'
  if (subPart) {
    const m = subPart.match(/(专题书|总集篇|外传|番外篇?|公式书|设定集|资料集|剧场版|特辑|合订本)/)
    if (m && m[1]) subSeriesKey = `01_${m[1]}`
  }
  let volRank = 0
  if (subPart) {
    const explicit =
      subPart.match(
        /(?:[卷集册部辑]\s*第?\s*|(?:vol\.?|v)\s*)(\d+|[零〇一二两三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾]+)/i
      ) ||
      subPart.match(/第?\s*(\d+|[零〇一二两三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾]+)\s*[卷集册部辑]/)
    if (explicit && explicit[1]) {
      const p = parseCnToken(explicit[1])
      volRank = p > 0 ? p : 1
    }
  }
  const paddedRest = clean
    .replace(/[·．:：,，（）()《》“”"'\s]+/g, ' ')
    .replace(/(\d+|[一二三四五六七八九十百零〇壹贰叁肆伍陆柒捌玖拾上中下]+)/g, (m) =>
      String(parseCnToken(m)).padStart(6, '0')
    )
  return `${seriesPrefix}__${subSeriesKey}__${String(volRank).padStart(6, '0')}__${paddedRest}`
}

function extractZhijiangShelfPrefixes(copies: any[]): string[] {
  return [
    ...new Set(
      copies
        .filter(
          (c: any) =>
            String(c.districtId || '') === ZHIJIANG_DISTRICT_ID &&
            (c.state === 2 || c.state === 16) &&
            Boolean(String(c.shelf_mark || '').trim())
        )
        .map((c: any) => {
          let prefix = String(c.shelf_mark || '').trim()
          while ((prefix.match(/-/g) || []).length > 6) {
            prefix = prefix.slice(0, prefix.lastIndexOf('-'))
          }
          return prefix
        })
    ),
  ]
}

async function fetchZhijiangShelfDescMap(shelfPrefixes: string[]): Promise<Record<string, string>> {
  const shelfDescMap: Record<string, string> = {}
  const uncached: string[] = []
  for (const p of shelfPrefixes) {
    if (zhijiangShelfDescCache.has(p)) {
      shelfDescMap[p] = zhijiangShelfDescCache.get(p)!
    } else {
      uncached.push(p)
    }
  }
  if (uncached.length === 0) return shelfDescMap
  try {
    const descResp = (
      await cnRelayFetch(
        `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/search/get/shelf/description/map`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'BFF-ORG-ID': ZJLIB_ORG_ID },
          body: JSON.stringify({ orgId: ZJLIB_ORG_ID, shelfNoList: uncached }),
        }
      )
    ).json()
    if (descResp?.code === 200 && descResp.data) {
      for (const [k, v] of Object.entries(descResp.data)) {
        if (typeof v === 'string' && v) {
          zhijiangShelfDescCache.set(k, v)
          shelfDescMap[k] = v
        }
      }
    }
  } catch {
    // ignore
  }
  return shelfDescMap
}

/**
 * 按需翻译之江馆层架标：仅在用户点击展开某本浙图书的馆藏列表时触发
 */
export async function translateHoldingsZhijiangShelves(holdings: any[]): Promise<void> {
  if (!Array.isArray(holdings) || holdings.length === 0) return
  const prefixes = [
    ...new Set(
      holdings
        .filter((h) => Boolean(h.rawShelfMark))
        .map((h) => {
          let p = String(h.rawShelfMark || '').trim()
          while ((p.match(/-/g) || []).length > 6) {
            p = p.slice(0, p.lastIndexOf('-'))
          }
          return p
        })
    ),
  ]
  if (prefixes.length === 0) return
  const descMap = await fetchZhijiangShelfDescMap(prefixes)
  for (const h of holdings) {
    const raw = String(h.rawShelfMark || '').trim()
    if (!raw) continue
    let p = raw
    while ((p.match(/-/g) || []).length > 6) {
      p = p.slice(0, p.lastIndexOf('-'))
    }
    const baseDesc = descMap[p]
    if (baseDesc) {
      const posNum = parseInt(raw.split('-').pop() || '0', 10)
      h.shelfNo = posNum > 0 ? `${baseDesc}第${posNum}位` : baseDesc
    }
  }
}

function formatZjlibCopiesWithDescMap(
  copies: any[],
  shelfDescMap: Record<string, string>,
  bookTitle: string,
  fallbackCallNo: string,
  creatorStr: string,
  publisherStr: string
): any[] {
  const zjDistrictMap: Record<string, string> = ZJLIB_BRANCH_CONFIG.districtIdMap || {}
  const stateNames: Record<number, string> = {
    1: '编目中', 2: '在馆', 3: '借出', 4: '丢失', 16: '在馆(可外借)',
  }

  return sortHoldingsByPriority(
    'zjlib',
    copies.map((c: any) => {
      const isAvailable = c.state === 2 || c.state === 16
      const isInLibraryReadOnly = c.state === 16
      const isZhijiang = String(c.districtId || '') === ZHIJIANG_DISTRICT_ID
      const dName = zjDistrictMap[String(c.districtId || '')] || ''
      const rName = c.local_name || c.lib_name || c.location_name || '浙江图书馆'
      const effectiveCallNo = String(c.callno || fallbackCallNo || '').trim()
      const rawShelfMark = isZhijiang && isAvailable ? String(c.shelf_mark || '').trim() : ''
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
        } else {
          shelfText = effectiveCallNo || rawShelfMark
        }
      } else if (rName.includes('立库') || rName.includes('保存本')) {
        shelfText = '闭架智能立库：到服务台/检索机凭条码申请机器调阅（馆内阅读）'
      } else if (rName.includes('闭架')) {
        shelfText = '闭架外借书库：到服务台凭索书号/条码请馆员调取（可外借）'
      } else {
        shelfText = effectiveCallNo
      }
      const navUrl = rawShelfMark
        ? `https://map.zjlib.cn/h5/library-pc/#/?callno=${encodeURIComponent(effectiveCallNo)}&title=${encodeURIComponent(bookTitle)}&shelfMark=${encodeURIComponent(rawShelfMark)}&barcode=${encodeURIComponent(c.barcode || '')}&creator=${encodeURIComponent(creatorStr)}&publisher=${encodeURIComponent(publisherStr)}`
        : ''
      return {
        isAvailable,
        isInLibraryReadOnly,
        stateName:
          c.state_name || stateNames[Number(c.state)] || (isAvailable ? '在馆' : '借出/不可借'),
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
}

export async function handleCatalogSearchDirect(body: any): Promise<any> {
  const keyword = String(body.keyword || '').trim()
  const branch = String(body.branch || body.scope || 'all').trim()
  const onlyAvailable = body.onlyAvailable !== false
  const autoGroup = body.autoGroup === true
  const rows = Math.min(Number(body.rows) || 15, 24)
  const page = Math.max(1, Number(body.page) || 1)

  if (!keyword) {
    return { ok: true, items: [], zjTotal: 0, hzTotal: 0, hasMore: false }
  }
  const cacheKey = `search::${keyword.toLowerCase()}::${branch}::${onlyAvailable ? '1' : '0'}::${autoGroup ? '1' : '0'}::${rows}::${page}`
  const cached = getClientCache(cacheKey)
  if (cached) return cached

  const needZj = branch === 'all' || branch === 'zjlib' || branch.startsWith('zjlib:')
  const needHz = branch === 'all' || branch === 'hzlib' || branch.startsWith('hzlib:')
  const zjTargetDistrict =
    branch.startsWith('zjlib:') && branch !== 'zjlib:all' ? branch.slice(6) : ''
  const hzTargetBranch =
    branch.startsWith('hzlib:') && branch !== 'hzlib:all' ? branch.slice(6) : ''

  const stripSym = (s: string) =>
    (s || '')
      .toLowerCase()
      .replace(/[·．:：,，。！!？?《》〈〉“”"''（）()\[\]【】—\-_\s/\\|]/g, '')

  const CN_NUM_CHARS = '一二三四五六七八九十百零〇壹贰叁肆伍陆柒捌玖拾两'
  let baseKeyword = keyword
  let targetVolNum = ''
  const volPatterns = [
    new RegExp(`(?:^|\\s|[．·:：,，])第?\\s*(\\d+|[${CN_NUM_CHARS}]+)\\s*[卷集册部辑回篇章]$`),
    new RegExp(`(?:^|\\s|[．·:：,，])[卷集册部辑回篇章]\\s*第?\\s*(\\d+|[${CN_NUM_CHARS}]+)$`),
    new RegExp(`\\s+(\\d+|[${CN_NUM_CHARS}]+)$`),
    new RegExp(`第?(\\d+|[${CN_NUM_CHARS}]+)[卷集册部辑回篇章]$`),
    new RegExp(`[卷集册部辑回篇章]第?(\\d+|[${CN_NUM_CHARS}]+)$`),
  ]
  for (const re of volPatterns) {
    const m = keyword.match(re)
    if (m && m[1]) {
      const parsed = parseCnToken(m[1])
      if (parsed > 0 && parsed < 10000) {
        const b = keyword.slice(0, m.index).replace(/[．·:：,，\s]+$/g, '').trim()
        if (b.length >= 1) {
          baseKeyword = b
          targetVolNum = String(parsed)
          break
        }
      }
    }
  }

  const searchKw = (targetVolNum ? baseKeyword : keyword)
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

  const cleanKw = searchKw.replace(/[．·：:，,（）()《》“”"']/g, ' ').replace(/\s+/g, ' ').trim()
  const curlibParam =
    hzTargetBranch && /^\d{4}$/.test(hzTargetBranch) && !['1900', '0900', '1800'].includes(hzTargetBranch)
      ? `&curlibcode=${encodeURIComponent(hzTargetBranch)}`
      : ''
  const hzSearchRows = Math.max(searchRows, 20)
  const zjCandidateLimit = targetVolNum ? 24 : 12

  // 按「关键词 + 页码 + 杭图底层分馆参数」缓存原始流水线数据：切换「只看有书 / 自动归类 / 浙图各馆区 / 杭图主题馆」时 0 阿里云调用
  const rawPipeCacheKey = `pipe::${searchKw.toLowerCase()}::${page}::${zjCandidateLimit}::${curlibParam}`
  let pipelineData: any = getClientCache(rawPipeCacheKey)
  if (
    pipelineData &&
    ((needZj && !pipelineData.zjFetched) || (needHz && !pipelineData.hzFetched))
  ) {
    pipelineData = null
  }

  if (!pipelineData) {
    try {
      const pRes = await cnRelayPipeline({
        mode: 'search_pipeline',
        needZj,
        needHz,
        searchKw,
        cleanKw: cleanKw || searchKw,
        page,
        searchRows,
        hzSearchRows,
        curlibParam,
        zjCandidateLimit,
      })
      if (pRes?.ok && pRes.pipeline) {
        pipelineData = {
          ...pRes,
          zjFetched: needZj,
          hzFetched: needHz,
        }
        setClientCache(rawPipeCacheKey, pipelineData)
      }
    } catch {
      // fallback to multi-call if relay worker not yet upgraded
    }
  }

  const zjPromise = needZj
    ? (async () => {
        try {
          let mergedRaw: any[] = []
          let total = 0
          const copiesByWorkId = new Map<string, any[]>()

          if (pipelineData?.zj) {
            mergedRaw = pipelineData.zj.records || []
            total = Number(pipelineData.zj.total || mergedRaw.length)
            const mapObj = pipelineData.zj.copiesByWorkId || {}
            for (const [wid, list] of Object.entries(mapObj)) {
              copiesByWorkId.set(wid, Array.isArray(list) ? list : [])
            }
          } else {
            const zjHeaders = { 'Content-Type': 'application/json', 'BFF-ORG-ID': ZJLIB_ORG_ID }
            const zjTitleResp = await cnRelayFetch(
              `${ZJLIB_API_BASE}/search-admin-service/open-api/search/pageList`,
              {
                method: 'POST',
                headers: zjHeaders,
                body: JSON.stringify({
                  metadataType: 'work',
                  current: page,
                  size: searchRows,
                  query: [{ id: 0, key: 'title', value: searchKw, match: 'phrase_fuzzy', condition: 'and' }],
                  sortBy: [],
                }),
              }
            )
              .then((r) => r.json())
              .catch(() => null)
            const titleRecords: any[] = zjTitleResp?.data?.records || []
            let zjFullResp: any = null
            if (titleRecords.length < 6) {
              zjFullResp = await cnRelayFetch(
                `${ZJLIB_API_BASE}/search-admin-service/open-api/search/pageList`,
                {
                  method: 'POST',
                  headers: zjHeaders,
                  body: JSON.stringify({
                    metadataType: 'work',
                    current: page,
                    size: Math.min(searchRows, 15),
                    query: [{ id: 0, key: '', value: searchKw, match: 'phrase_fuzzy', condition: 'and' }],
                    sortBy: [],
                  }),
                }
              )
                .then((r) => r.json())
                .catch(() => null)
            }
            const seenBibIds = new Set<string>()
            for (const r of [...titleRecords, ...(zjFullResp?.data?.records || [])]) {
              const bibId = String(Array.isArray(r.originalId) ? r.originalId[0] : r.originalId || r.id || '').trim()
              if (!bibId || seenBibIds.has(bibId)) continue
              seenBibIds.add(bibId)
              mergedRaw.push(r)
            }
            total = Number(zjTitleResp?.data?.total || zjFullResp?.data?.total || mergedRaw.length)
          }

          const rawCandidates = mergedRaw
            .map((r: any, idx: number) => {
              const bibId = String(Array.isArray(r.originalId) ? r.originalId[0] : r.originalId || r.id || '').trim()
              const workId = String(Array.isArray(r.id) ? r.id[0] : r.id || bibId).trim()
              const sourceType = Array.isArray(r.sourceType) ? r.sourceType.join(',') : String(r.sourceType || '0')
              const title = String(Array.isArray(r.title) ? r.title[0] : r.title || '').trim()
              const author = String(Array.isArray(r.creator) ? r.creator[0] : r.creator || '').trim()
              const publisher = String(Array.isArray(r.publisher) ? r.publisher[0] : r.publisher || '').trim()
              const pubDate = String(Array.isArray(r.dateIssue) ? r.dateIssue[0] : r.dateIssue || '').trim()
              const isbn = String(Array.isArray(r.identifierIsbn) ? r.identifierIsbn[0] : r.identifierIsbn || '').trim()
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
              return toNaturalTitleKey(a.title).localeCompare(toNaturalTitleKey(b.title), 'zh-CN')
            })
            .slice(0, zjCandidateLimit)

          if (!pipelineData?.zj) {
            const zjHeaders = { 'Content-Type': 'application/json', 'BFF-ORG-ID': ZJLIB_ORG_ID }
            const concurrency = 6
            for (let i = 0; i < rawCandidates.length; i += concurrency) {
              const chunk = rawCandidates.slice(i, i + concurrency)
              await Promise.all(
                chunk.map(async (item) => {
                  try {
                    const resListResp = (
                      await cnRelayFetch(
                        `${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/search/resourceList`,
                        {
                          method: 'POST',
                          headers: zjHeaders,
                          body: JSON.stringify({ id: item.workId, sourceType: item.sourceType }),
                        }
                      )
                    ).json()
                    copiesByWorkId.set(item.workId, resListResp?.data?.[0] || [])
                  } catch {
                    copiesByWorkId.set(item.workId, [])
                  }
                })
              )
            }
          }

          // 搜索列表阶段不再预调 get/shelf/description/map（改为用户点击展开该书馆藏时按需翻译，省 1 次调用）
          for (const item of rawCandidates) {
            const rawCopies = copiesByWorkId.get(item.workId) || []
            const scopedCopies = zjTargetDistrict
              ? rawCopies.filter((c: any) => String(c.districtId || '') === zjTargetDistrict)
              : rawCopies
            item.totalHoldings = scopedCopies.length
            item.availableCount = scopedCopies.filter((c: any) => c.state === 2 || c.state === 16).length
            const firstCallNo = scopedCopies.find((c: any) => c.callno)?.callno || ''
            if (firstCallNo) item.callNo = String(firstCallNo).trim()
            const formattedHoldings = formatZjlibCopiesWithDescMap(
              scopedCopies,
              {},
              item.title,
              item.callNo,
              item.author,
              item.publisher
            )
            item.holdings = formattedHoldings
            const branchNames = [
              ...new Set(
                (formattedHoldings.some((h) => h.isAvailable)
                  ? formattedHoldings.filter((h) => h.isAvailable)
                  : formattedHoldings
                )
                  .map((h) => (h.location && h.location !== h.libName ? `${h.libName}·${h.location}` : h.libName))
                  .filter(Boolean)
              ),
            ]
            item.availableBranches = branchNames.slice(0, 3)
            if (branchNames[0]) item.subLibrary = branchNames[0]
          }

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

  const hzPromise = needHz
    ? (async () => {
        try {
          let html = ''
          let previewsMap: Record<string, any[]> = {}
          let pipelineTotal = 0

          if (pipelineData?.hz) {
            html = String(pipelineData.hz.html || '')
            previewsMap = pipelineData.hz.previews || {}
            pipelineTotal = Number(pipelineData.hz.total || 0)
          } else {
            html = (
              await cnRelayFetch(
                `https://my1.zjhzlib.cn/opac/search?q=${encodeURIComponent(cleanKw || searchKw)}&searchWay=&scWay=dim&rows=${hzSearchRows}&page=${page}&sortWay=score&sortOrder=desc&hasholding=1${curlibParam}`
              )
            ).text()
          }

          const doc = new DOMParser().parseFromString(html, 'text/html')
          const totalMatch = html.match(
            /检索到\s*<strong[^>]*>\s*([\d,]+)\s*<\/strong>|检索到\s*[:：]?\s*([\d,]+)\s*条|共\s*([\d,]+)\s*条/
          )
          const rawItems: any[] = []
          doc.querySelectorAll('.bookmetaTD').forEach((td) => {
            const tr = td.closest('tr')
            const bibId = String(
              td.querySelector('.bookmeta')?.getAttribute('bookrecno') ||
                tr?.querySelector('.bookcover_img')?.getAttribute('bookrecno') ||
                ''
            ).trim()
            const title = (td.querySelector('.bookmetaTitle a')?.textContent || '').replace(/\s+/g, ' ').trim()
            if (!title || !bibId) return
            const author = (td.querySelector('.author-link')?.textContent || '').replace(/\s+/g, ' ').trim()
            const publisher = (td.querySelector('.publisher-link')?.textContent || '').replace(/\s+/g, ' ').trim()
            const fullText = (td.textContent || '').replace(/\s+/g, ' ')
            const pubDate = fullText.match(/出版日期:\s*([0-9.-]+)/)?.[1] || ''
            const callNo = (td.querySelector('.callnosSpan')?.textContent || '').replace(/\s+/g, ' ').trim()
            const isbn = String(
              tr?.querySelector('.bookcover_img')?.getAttribute('isbn') ||
                td.querySelector('.expressServiceTab')?.getAttribute('express_isbn') ||
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

          if (rawItems.length > 0) {
            try {
              if (!pipelineData?.hz) {
                const recnos = rawItems.map((x) => x.bibId).join(',')
                const prevRes = (
                  await cnRelayFetch(
                    `https://my1.zjhzlib.cn/opac/book/holdingPreviews?bookrecnos=${encodeURIComponent(recnos)}&curLibcodes=&return_fmt=json`
                  )
                ).json()
                previewsMap = prevRes?.previews || {}
              }
              const matchHzBranch = (p: any): boolean => {
                if (!hzTargetBranch) return true
                const curlib = String(p.curlib || '')
                const curlocalName = String(p.curlocalName || '')
                const curlibName = String(p.curlibName || '')
                if (hzTargetBranch === '0000') {
                  if (curlib !== '0000' && curlib !== '0001') return false
                  const ext = ['少儿分馆', '生活主题', '环保分馆', '佛学分馆', '科技分馆', '动漫分馆', '茶文化', '钢琴', '宋韵', '国医', '城市学', '棋院', '电影', '盲文', '西泠', '版本馆', '财商', '运动分馆', '微图']
                  return !ext.some((kw) => curlocalName.includes(kw))
                }
                if (hzTargetBranch === 'local:少儿分馆') {
                  return curlocalName.includes('少儿分馆') || curlibName.includes('少年儿童') || curlib === '0100' || curlib === '0101'
                }
                if (hzTargetBranch === 'local:其他主题分馆') {
                  const other = ['宋韵', '国医', '城市学', '棋院', '电影', '盲文', '西泠', '版本馆', '财商', '运动分馆']
                  return other.some((kw) => curlocalName.includes(kw) || curlibName.includes(kw))
                }
                if (hzTargetBranch.startsWith('local:')) {
                  const targetTheme = hzTargetBranch.slice(6)
                  return curlocalName.includes(targetTheme) || curlibName.includes(targetTheme)
                }
                if (hzTargetBranch === '1900') return ['1900', '1901', '1000', '1001'].includes(curlib)
                if (hzTargetBranch === '0900') return ['0900', '0901'].includes(curlib)
                if (hzTargetBranch === '1800') return ['1800', '1801'].includes(curlib)
                if (/^\d{4}$/.test(hzTargetBranch)) return curlib.startsWith(hzTargetBranch.slice(0, 2))
                return curlibName.includes(hzTargetBranch) || curlocalName.includes(hzTargetBranch)
              }

              for (const item of rawItems) {
                const scoped = (previewsMap[item.bibId] || []).filter(matchHzBranch)
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
                  if (!item.callNo && pCallNo) item.callNo = pCallNo
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
                const sorted = sortHoldingsByPriority('hzlib', previewHoldings)
                item.holdings = sorted
                item.totalHoldings = totalCopies
                item.availableCount = availCopies
                const branchNames = [
                  ...new Set(
                    (sorted.some((h) => h.isAvailable) ? sorted.filter((h) => h.isAvailable) : sorted)
                      .map((h) => (h.location && h.location !== h.libName ? `${h.libName}·${h.location}` : h.libName))
                      .filter(Boolean)
                  ),
                ]
                item.availableBranches = branchNames.slice(0, 3)
                if (item.availableBranches[0]) item.subLibrary = item.availableBranches[0]
              }
            } catch {
              // ignore preview error
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
          return {
            total: pipelineTotal || (rawTotalStr ? Number(rawTotalStr) : rawItems.length),
            items,
            rawCount: rawItems.length,
            pageSize: hzSearchRows,
          }
        } catch {
          return { total: 0, items: [], rawCount: 0, pageSize: 20 }
        }
      })()
    : Promise.resolve({ total: 0, items: [], rawCount: 0, pageSize: 20 })

  const [zjRes, hzRes] = await Promise.all([zjPromise, hzPromise])
  let combined = [...zjRes.items, ...hzRes.items].map((it, idx) => ({ ...it, _rawOrder: idx }))

  if (targetVolNum) {
    const volRe = new RegExp(`\\d+|[${CN_NUM_CHARS}]+`, 'g')
    const volMatched = combined.filter((item) => {
      const tokens = String(item.title || '').match(volRe) || []
      return tokens.some((m) => String(parseCnToken(m)) === targetVolNum)
    })
    if (volMatched.length > 0) combined = volMatched
  }

  if (autoGroup) {
    combined.sort((a, b) => {
      if (a._rel !== b._rel) return a._rel - b._rel
      const natCmp = toNaturalTitleKey(a.title).localeCompare(toNaturalTitleKey(b.title), 'zh-CN')
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

  return setClientCache(cacheKey, {
    ok: true,
    page,
    hasMore,
    zjTotal: zjRes.total,
    hzTotal: hzRes.total,
    items: combined,
  })
}

export async function handleHoldingQueryDirect(body: any): Promise<any> {
  const library: 'zjlib' | 'hzlib' = body.library || 'hzlib'
  let bibId = String(body.bibId || '').trim()
  const isbn = String(body.isbn || '').trim()
  const title = String(body.title || '').trim()
  const callNo = String(body.callNo || '').trim()
  const cacheKey = `holding::${library}::${bibId}::${isbn}::${callNo}::${title}`
  const cached = getClientCache(cacheKey)
  if (cached) return cached

  if (library === 'hzlib') {
    if (!bibId && (isbn || callNo || title)) {
      const cleanTitle = title.replace(/[．·：:，,（）()《》“”"']/g, ' ').replace(/\s+/g, ' ').trim()
      const candidates: Array<{ way: string; q: string }> = []
      if (isbn) candidates.push({ way: 'isbn', q: isbn })
      if (callNo) candidates.push({ way: 'callno', q: callNo })
      if (cleanTitle) candidates.push({ way: '', q: cleanTitle })
      if (title) candidates.push({ way: 'title', q: title })
      for (const cand of candidates) {
        try {
          const html = (
            await cnRelayFetch(
              `https://my1.zjhzlib.cn/opac/search?q=${encodeURIComponent(cand.q)}&searchWay=${cand.way}&scWay=dim`
            )
          ).text()
          const m = html.match(/(?:bookDetail\(|bookSimpleDetailDiv_|\/opac\/book\/)(\d+)/)
          if (m && m[1]) {
            bibId = m[1]
            break
          }
        } catch {
          // ignore
        }
      }
    }
    if (!bibId) return { ok: false, message: '未找到该书在杭州图书馆的书目编号' }

    const hRes = (
      await cnRelayFetch(
        `https://my1.zjhzlib.cn/opac/api/holding/${encodeURIComponent(bibId)}?limitLibcodes=&isCluster=false`
      )
    ).json()
    const holdings = sortHoldingsByPriority(
      'hzlib',
      (hRes.holdingList || []).map((item: any) => {
        const stateObj = hRes.holdStateMap?.[String(item.state)]
        const isAvailable = item.state === 2
        const curLibName = hRes.libcodeMap?.[item.curlib] || '杭州图书馆'
        const orgLibName =
          item.orglib && item.orglib !== item.curlib ? hRes.libcodeMap?.[item.orglib] || '' : ''
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
            ? new Date(Number(loanWork.returnDate) + 8 * 3600 * 1000).toISOString().slice(0, 10)
            : ''
        return {
          isAvailable,
          isInLibraryReadOnly,
          stateName:
            stateObj?.stateName || (item.state === 2 ? '在馆' : item.state === 3 ? '借出' : '其他状态'),
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
    )
    return setClientCache(cacheKey, {
      ok: true,
      library: 'hzlib',
      bibId,
      officialUrl: `https://my1.zjhzlib.cn/opac/book/${encodeURIComponent(bibId)}`,
      totalCount: holdings.length,
      availableCount: holdings.filter((h: any) => h.isAvailable).length,
      holdings,
    })
  }

  // 浙江图书馆馆藏查询
  const zjHeaders = { 'Content-Type': 'application/json', 'BFF-ORG-ID': ZJLIB_ORG_ID }
  const workResp = (
    await cnRelayFetch(`${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/search/getWorkById`, {
      method: 'POST',
      headers: zjHeaders,
      body: JSON.stringify({ bibliosId: bibId, orgId: ZJLIB_ORG_ID }),
    })
  ).json()
  const workRecord = workResp?.data?.record
  const workId = Array.isArray(workRecord?.id) ? workRecord.id[0] : workRecord?.id || bibId
  const sourceTypeArr = Array.isArray(workRecord?.sourceType)
    ? workRecord.sourceType
    : workRecord?.sourceType
      ? [workRecord.sourceType]
      : ['0']
  const resListResp = (
    await cnRelayFetch(`${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/search/resourceList`, {
      method: 'POST',
      headers: zjHeaders,
      body: JSON.stringify({ id: workId, sourceType: sourceTypeArr.join(',') }),
    })
  ).json()
  const rawList: any[] = resListResp?.data?.[0] || []
  const creatorStr = Array.isArray(workRecord?.creator)
    ? workRecord.creator.join(',')
    : String(workRecord?.creator || '')
  const publisherStr = Array.isArray(workRecord?.publisher)
    ? workRecord.publisher.join(',')
    : String(workRecord?.publisher || '')
  const bookTitle = Array.isArray(workRecord?.title)
    ? workRecord.title[0]
    : String(workRecord?.title || title || '')
  const shelfDescMap = await fetchZhijiangShelfDescMap(extractZhijiangShelfPrefixes(rawList))
  const holdings = formatZjlibCopiesWithDescMap(rawList, shelfDescMap, bookTitle, callNo, creatorStr, publisherStr)
  const primaryNavHolding =
    holdings.find((h) => h.isAvailable && h.navUrl) || holdings.find((h) => h.navUrl)

  return setClientCache(cacheKey, {
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
}

export async function handleCoversResolveDirect(body: any): Promise<any> {
  ensureLocalCoverCacheLoaded()
  const forceInternet = Boolean(body.forceInternet)
  const items: Array<{ id: string; isbn?: string; title?: string; author?: string; publisher?: string }> =
    Array.isArray(body.items) ? body.items.slice(0, 35) : []
  const resolvedById: Record<string, string> = {}
  const unresolved: typeof items = []
  let cacheUpdated = false

  for (const it of items) {
    const cleanIsbn = String(it.isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase()
    const key = cleanIsbn ? `isbn:${cleanIsbn}:${it.title || ''}` : `title:${it.title || ''}`
    if (!forceInternet && clientCoverCache.has(key)) {
      resolvedById[it.id] = clientCoverCache.get(key)!
    } else {
      unresolved.push(it)
    }
  }

  // 封面查询直接交由 Vercel 服务端 /api/covers/resolve（优先命中服务端 .cover-cache.json 缓存，未命中则搜百度/必应图源，0 阿里云函数消耗）
  const stillMissing = unresolved.filter((u) => !resolvedById[u.id])
  if (stillMissing.length > 0) {
    try {
      const resp = await window.fetch('/api/covers/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: stillMissing, forceInternet }),
      })
      const data = await resp.json()
      if (data?.ok && data.covers) {
        for (const [id, url] of Object.entries(data.covers)) {
          if (typeof url === 'string' && url) {
            resolvedById[id] = url
            const item = stillMissing.find((x) => x.id === id)
            if (item) {
              const cleanIsbn = String(item.isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase()
              const key = cleanIsbn ? `isbn:${cleanIsbn}:${item.title || ''}` : `title:${item.title || ''}`
              clientCoverCache.set(key, url)
              cacheUpdated = true
            }
          }
        }
      }
    } catch {
      // ignore fallback error
    }
  }

  if (cacheUpdated) {
    persistLocalCoverCache()
  }
  return { ok: true, covers: resolvedById }
}

function toJsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

async function dispatchDirectApi(urlStr: string, init?: RequestInit): Promise<Response> {
  const qIdx = urlStr.indexOf('?')
  const pathname = qIdx >= 0 ? urlStr.slice(0, qIdx) : urlStr
  const bodyObj =
    init?.body && typeof init.body === 'string' ? JSON.parse(init.body || '{}') : {}

  try {
    if (pathname === '/api/hzlib/captcha') {
      return toJsonResponse(await handleHzlibCaptchaDirect(urlStr))
    }
    if (pathname === '/api/hzlib/sync') {
      return toJsonResponse(await handleHzlibSyncDirect(bodyObj))
    }
    if (pathname === '/api/zjlib/qr') {
      return toJsonResponse(await handleZjlibQrDirect(urlStr))
    }
    if (pathname === '/api/zjlib/sync') {
      return toJsonResponse(await handleZjlibSyncDirect(bodyObj))
    }
    if (pathname === '/api/loan/renew') {
      return toJsonResponse(await handleLoanRenewDirect(bodyObj))
    }
    if (pathname === '/api/catalog/search') {
      return toJsonResponse(await handleCatalogSearchDirect(bodyObj))
    }
    if (pathname === '/api/holding/query') {
      return toJsonResponse(await handleHoldingQueryDirect(bodyObj))
    }
    if (pathname === '/api/covers/resolve') {
      return toJsonResponse(await handleCoversResolveDirect(bodyObj))
    }
  } catch (err: any) {
    return toJsonResponse(
      {
        ok: false,
        message: err?.message || '连接境内图书馆中转服务出错，请稍后重试',
      },
      200
    )
  }
  return window.fetch(urlStr, init)
}

/**
 * 统一前端 API 请求入口：
 * - 线上环境 (book.rouroulib.cn 等)：直接由用户浏览器通过杭州阿里云函数计算访问浙图/杭图，全程国内直连
 * - 本地开发环境 (localhost)：优先走本地 Vite 代理，若失败自动回退至杭州阿里云直连通道
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (shouldPreferCnDirect()) {
    return dispatchDirectApi(input, init)
  }
  try {
    const res = await window.fetch(input, init)
    if (res.ok) return res
    return dispatchDirectApi(input, init)
  } catch {
    return dispatchDirectApi(input, init)
  }
}
