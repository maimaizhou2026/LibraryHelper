import { pinyin } from 'pinyin-pro'
import type { BookAggregatedGroup, BorrowRecord, LibrarySource, VerdictType } from '../types/library'

export interface CleanPinyinParts {
  clean: string
  full: string
  first: string
}

const pinyinPartsCache = new Map<string, CleanPinyinParts>()
const volumeNormCache = new Map<string, string>()

const TITLE_SYNONYM_GROUPS: string[][] = [
  ['航海王', '海贼王', 'onepiece'],
]

function getTitleSynonymQueries(cleanText: string): string[] {
  if (!cleanText) return []
  const extra: string[] = []
  for (const group of TITLE_SYNONYM_GROUPS) {
    if (group.some((alias) => cleanText.includes(alias))) {
      for (const alias of group) {
        if (!cleanText.includes(alias)) extra.push(alias)
      }
    }
  }
  return extra
}

const CN_NUM_DIGIT_MAP: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  贰: 2,
  两: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
}

export function parseChineseOrArabicNumber(token: string): number | null {
  if (!token) return null
  if (/^\d+$/.test(token)) return parseInt(token, 10)
  let res = 0
  let cur = 0
  let hasDigit = false
  for (const ch of token) {
    if (ch === '十' || ch === '拾') {
      hasDigit = true
      res += (cur === 0 ? 1 : cur) * 10
      cur = 0
    } else if (ch === '百' || ch === '佰') {
      hasDigit = true
      res += (cur === 0 ? 1 : cur) * 100
      cur = 0
    } else if (CN_NUM_DIGIT_MAP[ch] !== undefined) {
      hasDigit = true
      cur = CN_NUM_DIGIT_MAP[ch]
    } else {
      return null
    }
  }
  return hasDigit ? res + cur : null
}

/**
 * 卷/集/册/部/中文数字归一化（带内存缓存）：
 * 如 "xxx书 卷5" / "xxx书 卷五" / "xxx书 5卷" / "xxx书 五卷" / "xxx书 5集" / "xxx书 五集"
 * 统一归一化为一致的卷集数字表达式，实现互通模糊搜索。
 */
export function normalizeVolumeText(text: string): string {
  if (!text) return ''
  const cached = volumeNormCache.get(text)
  if (cached !== undefined) return cached

  // 1. 先将连续中文数字替换为阿拉伯数字
  let normalized = text
    .toLowerCase()
    .replace(/[一二三四五六七八九十百零〇壹贰叁肆伍陆柒捌玖拾两]+/g, (m) => {
      const num = parseChineseOrArabicNumber(m)
      return num !== null ? String(num) : m
    })

  // 2. 统一 "第?N(卷|集|册|部|辑|回|篇|章)" 与 "(卷|集|册|部|辑|回|篇|章)第?N" -> 统一标记 "vN"
  normalized = normalized
    .replace(/第?\s*(\d+)\s*[卷集册部辑回篇章]/g, 'v$1')
    .replace(/[卷集册部辑回篇章]\s*第?\s*(\d+)/g, 'v$1')
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')

  volumeNormCache.set(text, normalized)
  return normalized
}

/**
 * 过滤书名/查询词中的特殊符号（如 · ： ． “ ” 《 》 — ！ 空格等），只保留中英文与数字
 */
export function stripSpecialSymbols(text: string): string {
  if (!text) return ''
  return text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase()
}

export function getCleanPinyinParts(text: string): CleanPinyinParts {
  if (!text) return { clean: '', full: '', first: '' }
  const cached = pinyinPartsCache.get(text)
  if (cached !== undefined) return cached
  const clean = stripSpecialSymbols(text)
  if (!clean) {
    const empty = { clean: '', full: '', first: '' }
    pinyinPartsCache.set(text, empty)
    return empty
  }
  try {
    const full = pinyin(clean, { toneType: 'none', type: 'array' }).join('').toLowerCase()
    const first = pinyin(clean, { pattern: 'first', toneType: 'none', type: 'array' })
      .join('')
      .toLowerCase()
    const res = { clean, full, first }
    pinyinPartsCache.set(text, res)
    return res
  } catch {
    const fallback = { clean, full: clean, first: clean }
    pinyinPartsCache.set(text, fallback)
    return fallback
  }
}

export function getPinyinSearchString(text: string): string {
  const parts = getCleanPinyinParts(text)
  return `${parts.clean} ${parts.full} ${parts.first}`
}

export function normalizeBookTitle(title: string): string {
  if (!title) return ''
  return title
    .replace(/^[《「【(\[]+|[》」】)\]]+$/g, '')
    .replace(/[（(][^)）]*(?:精装|平装|全彩|彩图|注音|典藏|礼赠|原书第\d+版|第\d+版)[^)）]*[)）]/g, '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    .toLowerCase()
    .trim()
}

export function normalizeIsbn(isbn: string): string {
  return (isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase()
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  贰: 2,
  两: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
}
const CN_UNITS: Record<string, number> = {
  十: 10,
  拾: 10,
  百: 100,
  佰: 100,
  千: 1000,
  仟: 1000,
}

export function chineseNumToInt(cn: string): number {
  if (!cn) return NaN
  if (/^\d+$/.test(cn)) return parseInt(cn, 10)
  if (cn === '上') return 1
  if (cn === '中') return 2
  if (cn === '下') return 3
  let total = 0
  let current = 0
  for (const ch of cn) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch]
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch]
      if (current === 0) current = 1
      total += current * unit
      current = 0
    } else {
      return NaN
    }
  }
  return total + current
}

const naturalSortKeyCache = new Map<string, string>()

/**
 * 构建支持「同名系列聚拢 + 中文/阿拉伯卷号自然序（如 卷1、卷2...卷10、卷55、壹/贰/叁/4/伍）」的排序键
 */
export function getTitleNaturalSortKey(title: string): string {
  if (!title) return ''
  const cached = naturalSortKeyCache.get(title)
  if (cached !== undefined) return cached

  const clean = title.replace(/^[《「【(\[]+|[》」】)\]]+$/g, '').trim()
  const withPaddedNums = clean
    .replace(
      /(?:第|卷|册|辑|部|篇|[．.：:·\s])([零〇一二两三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾]+|[上中下])(?=[卷册辑部篇章节回，,．.：:\s]|$)/g,
      (full, cnPart) => {
        const n = chineseNumToInt(cnPart)
        if (Number.isNaN(n)) return full
        const prefix = full.slice(0, full.length - cnPart.length)
        return prefix + String(n).padStart(6, '0')
      }
    )
    .replace(/\d+/g, (m) => m.padStart(6, '0'))

  // 提取主书名（系列名）以便同系列图书严密聚拢在一起
  const sepMatch = clean.match(/^([^．.：:—·(（\s]+)(?:[．.：:—·(（\s]+(.*))?$/)
  const rawSeriesPrefix = (sepMatch ? sepMatch[1] : clean).trim()
  const subPart = (sepMatch && sepMatch[2] ? sepMatch[2] : '').trim()
  const seriesPrefix = withPaddedNums.split(/[．.：:—·(（\s]/)[0].trim()

  // 识别独立衍生子系列（如「专题书」「总集篇」等单独聚合，不混入正传 00_main 卷号序列）
  let subSeriesKey = '00_main'
  if (subPart) {
    const subSeriesMatch = subPart.match(
      /(专题书|总集篇|外传|番外篇?|公式书|设定集|资料集|剧场版|特辑|合订本)/
    )
    if (subSeriesMatch && subSeriesMatch[1]) {
      subSeriesKey = `01_${subSeriesMatch[1]}`
    }
  }

  // 提取系列卷/集序号：纯主书名=0；副标题无前导集数（如“石猴出世...”)=1；带显式数字则取对应数字
  let volRank = 0
  if (subPart) {
    // 优先级1：全副标题扫描显式「卷/集/册/部/辑」编号（跨过中间子书名，如 "砂之国．卷十三"、"幽灵岛．卷五十一"）
    const explicitVolMatch =
      subPart.match(
        /(?:[卷集册部辑]\s*第?\s*|(?:vol\.?|v)\s*)(\d+|[零〇一二两三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾]+)/i
      ) ||
      subPart.match(
        /第?\s*(\d+|[零〇一二两三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾]+)\s*[卷集册部辑]/
      )
    if (explicitVolMatch && explicitVolMatch[1]) {
      const parsed = chineseNumToInt(explicitVolMatch[1])
      volRank = !Number.isNaN(parsed) && parsed >= 0 ? parsed : 1
    } else {
      // 优先级2：各分隔子段开头直接跟独立数字/中文数字（如 "15，玉兔精"、"叁"）
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
          const parsed = chineseNumToInt(m[1])
          if (!Number.isNaN(parsed) && parsed > 0) {
            foundSegVol = parsed
            break
          }
        }
      }
      // 优先级3：无集数副标题视同第 1 本
      volRank = foundSegVol !== null ? foundSegVol : 1
    }
  } else {
    const tailVolMatch = rawSeriesPrefix.match(
      /(?:第|[卷集册部辑])\s*(\d+|[零〇一二两三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾]+)\s*[卷集册部辑]?$/
    )
    if (tailVolMatch && tailVolMatch[1]) {
      const parsed = chineseNumToInt(tailVolMatch[1])
      if (!Number.isNaN(parsed) && parsed > 0) volRank = parsed
    }
  }

  let seriesPy = ''
  try {
    seriesPy = pinyin(seriesPrefix, { toneType: 'none', type: 'array' }).join('').toLowerCase()
  } catch {
    seriesPy = seriesPrefix.toLowerCase()
  }

  const volStr = String(volRank).padStart(6, '0')
  const key = `${seriesPy}__${seriesPrefix}__${subSeriesKey}__${volStr}__${withPaddedNums}`
  naturalSortKeyCache.set(title, key)
  return key
}

export function compareTitlesNaturally(titleA: string, titleB: string): number {
  const keyA = getTitleNaturalSortKey(titleA)
  const keyB = getTitleNaturalSortKey(titleB)
  return keyA.localeCompare(keyB, 'zh-CN')
}

export type SortField = 'title' | 'loanDate' | 'library' | 'dueDate' | 'rating'
export type SortOrder = 'asc' | 'desc'

export interface SearchFilterOptions {
  query: string
  library: 'all' | LibrarySource
  status: 'all' | 'borrowed' | 'returned'
  verdict: 'all' | VerdictType
  tag: string
  year: string
  onlyMultiBorrowed: boolean
  sortField: SortField
  sortOrder: SortOrder
}

export function buildRecordSearchBlob(rec: BorrowRecord): string {
  const titleParts = getCleanPinyinParts(rec.title)
  const authorParts = getCleanPinyinParts(rec.author)
  const normVolTitle = normalizeVolumeText(rec.title)
  const normVolFlat = normVolTitle.replace(/v(\d+)/g, '$1')
  const natKey = getTitleNaturalSortKey(rec.title)
  const natParts = natKey.split('__')
  const seriesClean = stripSpecialSymbols(natParts[1] || '')
  const subSeriesPart = natParts[2] || '00_main'
  const extractedVol = parseInt(natParts[3] || '0', 10)
  const seriesVolShortcuts =
    seriesClean && extractedVol > 0 && subSeriesPart === '00_main'
      ? [`${seriesClean}v${extractedVol}`, `${seriesClean}${extractedVol}`]
      : []
  const synTerms = getTitleSynonymQueries(titleParts.clean)
  const synParts = synTerms.flatMap((s) => {
    const p = getCleanPinyinParts(s)
    const extraVol =
      extractedVol > 0 ? [`${s}v${extractedVol}`, `${s}${extractedVol}`] : []
    return [s, p.full, p.first, ...extraVol]
  })
  const base = [
    rec.title,
    titleParts.clean,
    normVolTitle,
    normVolFlat,
    ...seriesVolShortcuts,
    titleParts.full,
    titleParts.first,
    ...synParts,
    rec.author,
    authorParts.clean,
    authorParts.full,
    authorParts.first,
    rec.isbn,
    normalizeIsbn(rec.isbn),
    rec.callNo,
    rec.barcode,
    rec.subLibrary,
    rec.library === 'zjlib' ? '浙江图书馆 浙图' : '杭州图书馆 杭图',
    ...(rec.tags || []),
    rec.note || '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return base
}

/**
 * 计算搜索结果匹配优先级分数（越小越靠前）：
 * 0~99: 书名完全精确匹配（含拼音/首字母完全一致）
 * 100~199: 书名首字/前缀匹配（名称首字对应上的排在前面）
 * 200~299: 书名中间包含匹配（位置越靠前分数越小）
 * 300~399: 作者首字/包含匹配
 * 400+: 其他字段（索书号、分馆、标签、笔记）匹配
 */
export function getSearchRelevanceScore(rec: BorrowRecord, rawQuery: string): number {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return 0
  const cleanQ = stripSpecialSymbols(q) || q
  const normVolQ = normalizeVolumeText(q)
  const normVolFlatQ = normVolQ.replace(/v(\d+)/g, '$1')
  const titleParts = getCleanPinyinParts(rec.title)
  const normVolTitle = normalizeVolumeText(rec.title)
  const normVolFlatTitle = normVolTitle.replace(/v(\d+)/g, '$1')
  const authorParts = getCleanPinyinParts(rec.author)

  // 1. 书名完全精确匹配
  if (
    titleParts.clean === cleanQ ||
    titleParts.full === cleanQ ||
    titleParts.first === cleanQ
  ) {
    return 0
  }
  if (
    normVolQ &&
    (normVolTitle === normVolQ || normVolFlatTitle === normVolFlatQ)
  ) {
    return 10
  }

  // 2. 书名首字/前缀匹配（如搜“哈利”/“hlbt”/“halibote”，《哈利·波特...》首字对应上）
  if (titleParts.clean.startsWith(cleanQ)) {
    return 100 + Math.min(titleParts.clean.length, 80)
  }
  if (
    normVolQ &&
    (normVolTitle.startsWith(normVolQ) || normVolFlatTitle.startsWith(normVolFlatQ))
  ) {
    return 110 + Math.min(normVolTitle.length, 80)
  }
  if (titleParts.first.startsWith(cleanQ)) {
    return 120 + Math.min(titleParts.clean.length, 80)
  }
  if (titleParts.full.startsWith(cleanQ)) {
    return 140 + Math.min(titleParts.clean.length, 80)
  }

  // 2.5 同义译名匹配（如搜“海贼王 / hzw / haizeiwang”匹配《航海王》）
  const synAliases = getTitleSynonymQueries(titleParts.clean)
  for (const alias of synAliases) {
    const aliasParts = getCleanPinyinParts(alias)
    if (
      aliasParts.clean === cleanQ ||
      aliasParts.full === cleanQ ||
      aliasParts.first === cleanQ
    ) {
      return 150
    }
    if (
      cleanQ.startsWith(aliasParts.clean) ||
      cleanQ.startsWith(aliasParts.first) ||
      cleanQ.startsWith(aliasParts.full)
    ) {
      return 160
    }
  }

  // 3. 书名包含匹配（按出现位置越靠前越优先）
  const cnIdx = titleParts.clean.indexOf(cleanQ)
  if (cnIdx !== -1) {
    return 200 + Math.min(cnIdx * 2, 80)
  }
  if (normVolQ) {
    const nvIdx = normVolTitle.indexOf(normVolQ)
    if (nvIdx !== -1) return 210 + Math.min(nvIdx * 2, 80)
    const nfIdx = normVolFlatTitle.indexOf(normVolFlatQ)
    if (nfIdx !== -1) return 220 + Math.min(nfIdx * 2, 80)
  }
  const firstIdx = titleParts.first.indexOf(cleanQ)
  if (firstIdx !== -1) {
    return 230 + Math.min(firstIdx * 2, 60)
  }
  const fullIdx = titleParts.full.indexOf(cleanQ)
  if (fullIdx !== -1) {
    return 260 + Math.min(fullIdx, 39)
  }

  // 4. 作者匹配
  if (
    authorParts.clean.startsWith(cleanQ) ||
    authorParts.first.startsWith(cleanQ) ||
    authorParts.full.startsWith(cleanQ)
  ) {
    return 300
  }
  if (
    authorParts.clean.includes(cleanQ) ||
    authorParts.first.includes(cleanQ) ||
    authorParts.full.includes(cleanQ)
  ) {
    return 350
  }

  return 400
}

export function filterAndSortRecords(
  records: BorrowRecord[],
  options: SearchFilterOptions,
  borrowCountByNormTitle?: Map<string, number>
): BorrowRecord[] {
  const tokens = options.query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  const filtered = records.filter((rec) => {
    if (options.library !== 'all' && rec.library !== options.library) return false
    if (options.status !== 'all' && rec.status !== options.status) return false
    if (options.verdict !== 'all' && rec.verdict !== options.verdict) return false
    if (options.tag && !(rec.tags || []).includes(options.tag)) return false
    if (options.year && !(rec.loanDate || '').startsWith(options.year)) return false
    if (options.onlyMultiBorrowed && borrowCountByNormTitle) {
      const key = normalizeBookTitle(rec.title)
      if ((borrowCountByNormTitle.get(key) || 1) < 2) return false
    }

    if (tokens.length > 0) {
      const blob = buildRecordSearchBlob(rec)
      for (const tk of tokens) {
        const cleanTk = stripSpecialSymbols(tk)
        const normTk = normalizeVolumeText(tk)
        const normFlatTk = normTk.replace(/v(\d+)/g, '$1')
        if (
          !blob.includes(tk) &&
          (!cleanTk || !blob.includes(cleanTk)) &&
          (!normTk || !blob.includes(normTk)) &&
          (!normFlatTk || !blob.includes(normFlatTk))
        ) {
          return false
        }
      }
    }
    return true
  })

  const hasQuery = tokens.length > 0

  return filtered.sort((a, b) => {
    // 当用户输入搜索词时，默认优先把精确匹配、书名首字匹配的排在前面
    if (hasQuery) {
      const scoreA = getSearchRelevanceScore(a, options.query)
      const scoreB = getSearchRelevanceScore(b, options.query)
      const tierA = Math.floor(scoreA / 100)
      const tierB = Math.floor(scoreB / 100)
      if (tierA !== tierB) return tierA - tierB
      // 按书名排序时，同匹配层级内交由下面的 compareTitlesNaturally（系列+卷号自然序）决定，不被书名长短打断
      if (options.sortField !== 'title' && scoreA !== scoreB) return scoreA - scoreB
    } else {
      // 分类列表浏览时：始终把「当前在借」的图书排在最前面，然后再排「已归还」的图书
      if (a.status === 'borrowed' && b.status !== 'borrowed') return -1
      if (a.status !== 'borrowed' && b.status === 'borrowed') return 1
    }

    const dir = options.sortOrder === 'asc' ? 1 : -1
    switch (options.sortField) {
      case 'title': {
        const cmp = compareTitlesNaturally(a.title, b.title)
        if (cmp !== 0) return cmp * dir
        return (b.loanDate || '').localeCompare(a.loanDate || '')
      }
      case 'library': {
        const libA = `${a.library === 'zjlib' ? '浙江图书馆' : '杭州图书馆'}_${a.subLibrary || ''}`
        const libB = `${b.library === 'zjlib' ? '浙江图书馆' : '杭州图书馆'}_${b.subLibrary || ''}`
        const cmp = libA.localeCompare(libB, 'zh-CN')
        if (cmp !== 0) return cmp * dir
        return compareTitlesNaturally(a.title, b.title)
      }
      case 'dueDate': {
        if (a.status === 'borrowed' && b.status !== 'borrowed') return -1
        if (a.status !== 'borrowed' && b.status === 'borrowed') return 1
        const cmp = (a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99')
        if (cmp !== 0) return cmp * dir
        return compareTitlesNaturally(a.title, b.title)
      }
      case 'rating': {
        const cmp = (a.rating || 0) - (b.rating || 0)
        if (cmp !== 0) return cmp * dir
        return compareTitlesNaturally(a.title, b.title)
      }
      case 'loanDate':
      default: {
        const cmp = (a.loanDate || '').localeCompare(b.loanDate || '')
        if (cmp !== 0) return cmp * dir
        // 借阅时间相同时：内部按图书馆聚合在一起，同馆内按书名及卷1,卷2自然序排列
        if (a.library !== b.library) {
          return a.library.localeCompare(b.library, 'zh-CN')
        }
        const subCmp = (a.subLibrary || '').localeCompare(b.subLibrary || '', 'zh-CN')
        if (subCmp !== 0) return subCmp
        return compareTitlesNaturally(a.title, b.title)
      }
    }
  })
}

export function aggregateRecordsByBook(records: BorrowRecord[]): BookAggregatedGroup[] {
  const map = new Map<string, BookAggregatedGroup>()

  for (const rec of records) {
    const normTitle = normalizeBookTitle(rec.title) || rec.id
    const existing = map.get(normTitle)
    if (!existing) {
      map.set(normTitle, {
        normKey: normTitle,
        title: rec.title,
        author: rec.author,
        isbn: rec.isbn,
        callNo: rec.callNo,
        coverUrl: rec.coverUrl,
        libraries: [rec.library],
        totalBorrows: 1,
        isCurrentlyBorrowed: rec.status === 'borrowed',
        latestLoanDate: rec.loanDate,
        verdict: rec.verdict,
        rating: rec.rating,
        tags: [...(rec.tags || [])],
        note: rec.note,
        records: [rec],
      })
    } else {
      existing.totalBorrows += 1
      if (!existing.libraries.includes(rec.library)) {
        existing.libraries.push(rec.library)
      }
      if (rec.status === 'borrowed') {
        existing.isCurrentlyBorrowed = true
      }
      if ((rec.loanDate || '') > (existing.latestLoanDate || '')) {
        existing.latestLoanDate = rec.loanDate
      }
      if (!existing.isbn && rec.isbn) existing.isbn = rec.isbn
      if (!existing.callNo && rec.callNo) existing.callNo = rec.callNo
      if (!existing.coverUrl && rec.coverUrl) existing.coverUrl = rec.coverUrl
      if (!existing.verdict && rec.verdict) existing.verdict = rec.verdict
      if ((rec.rating || 0) > existing.rating) existing.rating = rec.rating
      if (!existing.note && rec.note) existing.note = rec.note
      for (const t of rec.tags || []) {
        if (!existing.tags.includes(t)) existing.tags.push(t)
      }
      existing.records.push(rec)
    }
  }

  return Array.from(map.values())
}

export interface DedupCheckResult {
  query: string
  state: 'idle' | 'never_borrowed' | 'currently_borrowed' | 'previously_borrowed'
  matchedGroups: BookAggregatedGroup[]
}

export function checkBookDuplicate(records: BorrowRecord[], rawInput: string): DedupCheckResult {
  const q = rawInput.trim()
  if (!q) {
    return { query: '', state: 'idle', matchedGroups: [] }
  }

  // 复用主搜索与排序逻辑：自动过滤特殊符号、精确/首字匹配优先、同系列按卷1,卷2自然排序
  const sortedMatches = filterAndSortRecords(records, {
    query: q,
    library: 'all',
    status: 'all',
    verdict: 'all',
    tag: '',
    year: '',
    onlyMultiBorrowed: false,
    sortField: 'title',
    sortOrder: 'asc',
  })

  if (sortedMatches.length === 0) {
    return { query: q, state: 'never_borrowed', matchedGroups: [] }
  }

  // 按书名自动去重合并，并将当前在借的卷册优先排在前面，同状态按自然卷号排序
  const matchedGroups = aggregateRecordsByBook(sortedMatches).sort((a, b) => {
    if (a.isCurrentlyBorrowed !== b.isCurrentlyBorrowed) {
      return Number(b.isCurrentlyBorrowed) - Number(a.isCurrentlyBorrowed)
    }
    return 0
  })
  const hasCurrent = matchedGroups.some((g) => g.isCurrentlyBorrowed)

  return {
    query: q,
    state: hasCurrent ? 'currently_borrowed' : 'previously_borrowed',
    matchedGroups,
  }
}

const CLC_MAP: Record<string, string> = {
  A: '马克思主义/列宁主义',
  B: '哲学、宗教、心理学',
  C: '社会科学总论',
  D: '政治、法律',
  E: '军事',
  F: '经济、商业管理',
  G: '文化、教育、体育',
  H: '语言、文字、外语',
  I: '文学（小说/散文/儿童文学）',
  J: '艺术（绘画/绘本/音乐/设计）',
  K: '历史、地理、传记',
  N: '自然科学总论',
  O: '数理科学和化学',
  P: '天文学、地球科学',
  Q: '生物科学',
  R: '医药、卫生、健康',
  S: '农业科学',
  T: '工业技术 / 计算机(TP)',
  U: '交通运输',
  V: '航空、航天',
  X: '环境科学、安全科学',
  Z: '综合性图书',
}

export function explainCallNo(callNo: string): string {
  if (!callNo) return ''
  const clean = callNo.trim().toUpperCase()
  if (clean.startsWith('TP')) return '计算机与自动化技术类 (TP)'
  if (clean.startsWith('I287')) return '中国儿童文学/少儿绘本 (I287)'
  if (clean.startsWith('I247')) return '中国当代小说 (I247)'
  const firstChar = clean.charAt(0)
  return CLC_MAP[firstChar] ? `${CLC_MAP[firstChar]} (${firstChar}类)` : `中图分类 ${firstChar}区`
}

export function getDaysRemaining(dueDate: string): number | null {
  if (!dueDate) return null
  const due = new Date(`${dueDate.slice(0, 10)}T23:59:59`)
  if (Number.isNaN(due.getTime())) return null
  const now = new Date()
  return Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

/**
 * 计算当前在借图书的已续借次数：
 * - 杭州图书馆官方规则：普通图书基础借期 40 天，可续借 2 次，每次延长 15 天（40天=0次，55天=1次，70天=2次）
 * - 浙江图书馆官方规则：基础借期 30 天，可续借 1 次，每次延长 30 天（30天=0次，60天=1次）
 */
export function getEffectiveRenewCount(rec: BorrowRecord): number {
  if (rec.status === 'borrowed' && rec.loanDate && rec.dueDate) {
    const start = new Date(`${rec.loanDate.slice(0, 10)}T00:00:00`).getTime()
    const end = new Date(`${rec.dueDate.slice(0, 10)}T00:00:00`).getTime()
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      const spanDays = Math.round((end - start) / 86400000)
      if (rec.library === 'hzlib') {
        if (spanDays > 60) return 2
        if (spanDays > 43) return 1
        return 0
      }
      if (rec.library === 'zjlib') {
        if (rec.renewCount && rec.renewCount > 0) return rec.renewCount
        if (spanDays > 35) return 1
        return 0
      }
    }
  }
  return rec.renewCount || 0
}

export function getMaxRenewLimit(rec: Pick<BorrowRecord, 'library'>): number {
  return rec.library === 'hzlib' ? 2 : 1
}
