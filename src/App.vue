<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import {
  Search,
  RefreshCw,
  ScanBarcode,
  BookOpen,
  Smartphone,
  Monitor,
  Layers,
  ListFilter,
  Star,
  Clock,
  Repeat,
  Sparkles,
  X,
  ChevronRight,
  Library,
  Calendar,
  Tag,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Image as ImageIcon,
  Globe,
  LogOut,
} from 'lucide-vue-next'
import type { BorrowRecord, SyncMeta, VerdictType, LibrarySource } from './types/library'
import {
  getAllRecords,
  upsertRecords,
  updateRecordUserMeta,
  clearAllRecords,
  clearAllLocalData,
  getSyncMeta,
  saveSyncMeta,
  purgeDemoAndBrokenRecords,
  isDemoOrBrokenRecord,
  batchUpdateCoverUrls,
  clearCoverUrlsByIds,
} from './services/db'
import {
  filterAndSortRecords,
  aggregateRecordsByBook,
  normalizeBookTitle,
  compareTitlesNaturally,
  getSearchRelevanceScore,
  getDaysRemaining,
  explainCallNo,
  parseJsonSafe,
  toThumbnailCoverUrl,
  toHighResCoverUrl,
  isHighResCoverDecoded,
  preloadAndDecodeHighResCover,
  type SortField,
  type SortOrder,
} from './utils/search'
import {
  ZJLIB_BRANCH_CONFIG,
  HZLIB_BRANCH_CONFIG,
  registerMobileMapPicker,
  getPreferredMapProvider,
  setPreferredMapProvider,
  type MapLocationTarget,
  type LibraryPoiInfo,
  type MapProviderOption,
} from './utils/mapLink'
import { apiFetch } from './services/cnCatalogClient'
import versionInfo from '../version.json'
import { DEMO_BORROW_RECORDS } from './data/demoRecords'
import SyncImportModal from './components/SyncImportModal.vue'
import DedupCheckModal from './components/DedupCheckModal.vue'
import RecordDetailDrawer from './components/RecordDetailDrawer.vue'
import BorrowBookCard from './components/BorrowBookCard.vue'
import OnlineCatalogSection from './components/OnlineCatalogSection.vue'

const records = ref<BorrowRecord[]>([])
const syncMeta = ref<SyncMeta>({})
const loading = ref(true)

// UI View Mode: responsive full width vs mobile phone frame simulator on PC
const mobileFrameMode = ref(false)
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024)
const isMobileLayout = computed(() => mobileFrameMode.value || windowWidth.value < 640)

function handleWindowResize() {
  windowWidth.value = window.innerWidth
}
// 默认开启「按书名自动去重」
const autoDedupByTitle = ref(true)

// Modals
const showSyncModal = ref(false)
const showDedupModal = ref(false)
const showLogoutConfirm = ref(false)
const mobileMapPickerState = ref<{
  target: MapLocationTarget
  info: LibraryPoiInfo
  options: MapProviderOption[]
} | null>(null)
const rememberMapChoice = ref(false)

function handleSelectMapProvider(opt: MapProviderOption) {
  if (rememberMapChoice.value) {
    setPreferredMapProvider(opt.id)
  } else {
    setPreferredMapProvider(null)
  }
  mobileMapPickerState.value = null
}
const activeRecord = ref<BorrowRecord | null>(null)
const fullscreenCoverRecord = ref<{
  id?: string
  title: string
  coverUrl: string
  author?: string
  publisher?: string
  isbn?: string
} | null>(null)
const fullscreenActiveSrc = ref('')
const toastMessage = ref('')

function openFullscreenCover(payload: {
  id?: string
  title: string
  coverUrl: string
  author?: string
  publisher?: string
  isbn?: string
}) {
  const thumbUrl = toThumbnailCoverUrl(payload.coverUrl)
  const hdUrl = toHighResCoverUrl(payload.coverUrl)
  fullscreenActiveSrc.value = isHighResCoverDecoded(payload.coverUrl) ? hdUrl : thumbUrl
  fullscreenCoverRecord.value = { ...payload }
  if (fullscreenActiveSrc.value !== hdUrl && hdUrl && hdUrl !== thumbUrl) {
    void preloadAndDecodeHighResCover(payload.coverUrl).then((ok) => {
      if (ok && fullscreenCoverRecord.value?.coverUrl === payload.coverUrl) {
        fullscreenActiveSrc.value = hdUrl
      }
    })
  }
}

// Search & Filter states
const SEARCH_MODE_SESSION_KEY = 'lh_search_mode_v1'
const ONLINE_BRANCH_SESSION_KEY = 'lh_online_branch_v1'
const ONLINE_AVAIL_SESSION_KEY = 'lh_online_avail_v1'
const ONLINE_AUTO_GROUP_SESSION_KEY = 'lh_online_auto_group_v2'
const localSearchInput = ref('')
const localSearchQuery = ref('')
const onlineSearchQuery = ref('')
const searchMode = ref<'local' | 'online'>(
  (typeof sessionStorage !== 'undefined' &&
    (sessionStorage.getItem(SEARCH_MODE_SESSION_KEY) as 'local' | 'online')) ||
    'local'
)
const activeSearchQuery = computed({
  get: () => (searchMode.value === 'online' ? onlineSearchQuery.value : localSearchInput.value),
  set: (val: string) => {
    if (searchMode.value === 'online') {
      onlineSearchQuery.value = val
    } else {
      localSearchInput.value = val
    }
  },
})
const onlineBranch = ref<string>(
  (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(ONLINE_BRANCH_SESSION_KEY)) ||
    'all'
)
const onlineOnlyAvailable = ref<boolean>(
  typeof sessionStorage !== 'undefined' && sessionStorage.getItem(ONLINE_AVAIL_SESSION_KEY) !== null
    ? sessionStorage.getItem(ONLINE_AVAIL_SESSION_KEY) !== '0'
    : true
)
const onlineAutoGroup = ref<boolean>(
  typeof sessionStorage !== 'undefined' &&
    sessionStorage.getItem(ONLINE_AUTO_GROUP_SESSION_KEY) !== null
    ? sessionStorage.getItem(ONLINE_AUTO_GROUP_SESSION_KEY) === '1'
    : false
)
const onlineLoading = ref(false)
const onlineLoadingMore = ref(false)
const onlineSearched = ref(false)
const onlineItems = ref<BorrowRecord[]>([])
const onlineZjTotal = ref(0)
const onlineHzTotal = ref(0)
const onlinePage = ref(1)
const onlineHasMore = ref(false)
const onlineBrokenCovers = ref<Record<string, boolean>>({})
let onlineDebounceTimer: ReturnType<typeof setTimeout> | null = null
let localSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null
let localHistoryTimer: ReturnType<typeof setTimeout> | null = null
let onlineSearchSeq = 0
let localCoverResolveSeq = 0

// 历史搜索记录（搜我的借阅 与 在线搜全馆书库 各自独立，最多保留 10 条，持久化在 localStorage）
const SEARCH_HISTORY_LOCAL_KEY = 'lh_search_history_local_v1'
const SEARCH_HISTORY_ONLINE_KEY = 'lh_search_history_online_v1'
const MAX_SEARCH_HISTORY = 10
const localSearchHistory = ref<string[]>([])
const onlineSearchHistory = ref<string[]>([])
const searchHistory = computed(() =>
  searchMode.value === 'online' ? onlineSearchHistory.value : localSearchHistory.value
)
const showHistoryDropdown = ref(false)

function loadSearchHistory() {
  try {
    const rawLocal = localStorage.getItem(SEARCH_HISTORY_LOCAL_KEY)
    if (rawLocal) {
      const parsed = JSON.parse(rawLocal)
      if (Array.isArray(parsed)) {
        localSearchHistory.value = parsed
          .map((s) => String(s || '').trim())
          .filter(Boolean)
          .slice(0, MAX_SEARCH_HISTORY)
      }
    }
    const rawOnline = localStorage.getItem(SEARCH_HISTORY_ONLINE_KEY)
    if (rawOnline) {
      const parsed = JSON.parse(rawOnline)
      if (Array.isArray(parsed)) {
        onlineSearchHistory.value = parsed
          .map((s) => String(s || '').trim())
          .filter(Boolean)
          .slice(0, MAX_SEARCH_HISTORY)
      }
    }
  } catch {
    localSearchHistory.value = []
    onlineSearchHistory.value = []
  }
}

function saveSearchHistory(keyword: string, targetMode: 'local' | 'online' = searchMode.value) {
  const clean = keyword.trim()
  if (!clean) return
  const listRef = targetMode === 'online' ? onlineSearchHistory : localSearchHistory
  const storageKey =
    targetMode === 'online' ? SEARCH_HISTORY_ONLINE_KEY : SEARCH_HISTORY_LOCAL_KEY
  const next = [clean, ...listRef.value.filter((item) => item !== clean)].slice(0, MAX_SEARCH_HISTORY)
  listRef.value = next
  try {
    localStorage.setItem(storageKey, JSON.stringify(next))
  } catch {
    // ignore storage quota errors
  }
}

function removeSearchHistoryItem(item: string) {
  const isOnline = searchMode.value === 'online'
  const listRef = isOnline ? onlineSearchHistory : localSearchHistory
  const storageKey = isOnline ? SEARCH_HISTORY_ONLINE_KEY : SEARCH_HISTORY_LOCAL_KEY
  listRef.value = listRef.value.filter((x) => x !== item)
  try {
    localStorage.setItem(storageKey, JSON.stringify(listRef.value))
  } catch {
    // ignore
  }
}

function clearSearchHistory() {
  const isOnline = searchMode.value === 'online'
  if (isOnline) onlineSearchHistory.value = []
  else localSearchHistory.value = []
  showHistoryDropdown.value = false
  try {
    localStorage.removeItem(isOnline ? SEARCH_HISTORY_ONLINE_KEY : SEARCH_HISTORY_LOCAL_KEY)
  } catch {
    // ignore
  }
}

async function selectHistoryKeyword(item: string) {
  activeSearchQuery.value = item
  showHistoryDropdown.value = false
  saveSearchHistory(item, searchMode.value)
  if (searchMode.value === 'online') {
    await nextTick()
    if (onlineDebounceTimer) {
      clearTimeout(onlineDebounceTimer)
      onlineDebounceTimer = null
    }
    void runOnlineCatalogSearch()
  } else {
    if (localSearchDebounceTimer) {
      clearTimeout(localSearchDebounceTimer)
      localSearchDebounceTimer = null
    }
    localSearchQuery.value = item
  }
}

function handleSearchEnter() {
  const kw = activeSearchQuery.value.trim()
  if (kw) {
    saveSearchHistory(kw, searchMode.value)
  }
  showHistoryDropdown.value = false
  if (searchMode.value === 'online') {
    void runOnlineCatalogSearch()
  } else {
    if (localSearchDebounceTimer) {
      clearTimeout(localSearchDebounceTimer)
      localSearchDebounceTimer = null
    }
    localSearchQuery.value = localSearchInput.value
  }
}

function handleSearchInputBlur() {
  setTimeout(() => {
    showHistoryDropdown.value = false
  }, 180)
}

const filterLibrary = ref<'all' | LibrarySource>('all')
const filterStatus = ref<'all' | 'borrowed' | 'returned'>('all')
const filterMark = ref<string>('all')
const filterYear = ref('')
const onlyMultiBorrowed = ref(false)

const filterVerdict = computed<'all' | VerdictType>(() => {
  if (filterMark.value.startsWith('verdict:')) {
    return filterMark.value.slice(8) as VerdictType
  }
  return 'all'
})

const filterTag = computed<string>(() => {
  if (filterMark.value.startsWith('tag:')) {
    return filterMark.value.slice(4)
  }
  return ''
})
// 分类浏览时默认按借阅时间倒序（且在借排最前）；用户输入搜索词时自动切换为按书名排序
const sortField = ref<SortField>('loanDate')
const sortOrder = ref<SortOrder>('desc')

// 本地搜索输入：打字停顿满 1 秒 (1000ms) 后才执行搜索，继续打字则重置计时器不触发搜索
watch(localSearchInput, (newVal) => {
  if (localSearchDebounceTimer) {
    clearTimeout(localSearchDebounceTimer)
    localSearchDebounceTimer = null
  }
  if (!newVal.trim()) {
    localSearchQuery.value = ''
    return
  }
  localSearchDebounceTimer = setTimeout(() => {
    localSearchDebounceTimer = null
    localSearchQuery.value = newVal
  }, 1000)
})

watch(localSearchQuery, (newVal, oldVal) => {
  if (localHistoryTimer) clearTimeout(localHistoryTimer)
  const trimmed = newVal.trim()
  if (trimmed.length >= 2) {
    localHistoryTimer = setTimeout(() => {
      if (localSearchQuery.value.trim() === trimmed) {
        saveSearchHistory(trimmed, 'local')
      }
    }, 500)
  }
  const hasNew = Boolean(trimmed)
  const hadOld = Boolean(oldVal?.trim())
  if (hasNew && !hadOld) {
    sortField.value = 'title'
    sortOrder.value = 'asc'
  } else if (!hasNew && hadOld) {
    sortField.value = 'loanDate'
    sortOrder.value = 'desc'
  }
})

// 在线搜索输入：打字过程不自动触发搜索，仅在清空输入框时重置结果（等用户按回车或点击「在线搜索」按钮才搜索）
watch(onlineSearchQuery, (newVal) => {
  if (onlineDebounceTimer) clearTimeout(onlineDebounceTimer)
  const trimmed = newVal.trim()
  if (!trimmed) {
    onlineItems.value = []
    onlineSearched.value = false
    onlineLoadingMore.value = false
    onlinePage.value = 1
    onlineHasMore.value = false
  }
})

function switchSearchMode(mode: 'local' | 'online') {
  searchMode.value = mode
  showHistoryDropdown.value = false
  try {
    sessionStorage.setItem(SEARCH_MODE_SESSION_KEY, mode)
  } catch {
    // ignore
  }
}

function handleOnlineBranchChange() {
  try {
    sessionStorage.setItem(ONLINE_BRANCH_SESSION_KEY, onlineBranch.value)
  } catch {
    // ignore
  }
  if (onlineSearched.value && onlineSearchQuery.value.trim()) {
    void runOnlineCatalogSearch()
  }
}

function toggleOnlineOnlyAvailable() {
  onlineOnlyAvailable.value = !onlineOnlyAvailable.value
  try {
    sessionStorage.setItem(ONLINE_AVAIL_SESSION_KEY, onlineOnlyAvailable.value ? '1' : '0')
  } catch {
    // ignore
  }
  if (onlineSearched.value && onlineSearchQuery.value.trim()) {
    void runOnlineCatalogSearch()
  }
}

function toggleOnlineAutoGroup() {
  onlineAutoGroup.value = !onlineAutoGroup.value
  try {
    sessionStorage.setItem(ONLINE_AUTO_GROUP_SESSION_KEY, onlineAutoGroup.value ? '1' : '0')
  } catch {
    // ignore
  }
  if (onlineSearched.value && onlineSearchQuery.value.trim()) {
    void runOnlineCatalogSearch()
  }
}

/**
 * 「先快后大」封面分批切片器：首屏前 4 本极速优先返回，后续每 12 本合并为一批
 */
function buildFastFirstCoverBatches<T>(list: T[]): T[][] {
  if (!list || list.length === 0) return []
  const batches: T[][] = []
  const firstBatch = list.slice(0, 4)
  if (firstBatch.length > 0) batches.push(firstBatch)
  for (let i = 4; i < list.length; i += 12) {
    batches.push(list.slice(i, i + 12))
  }
  return batches
}

async function resolveOnlineItemsCovers(targetList: BorrowRecord[], currentSeq: number) {
  if (!targetList || targetList.length === 0) return
  const batches = buildFastFirstCoverBatches(targetList)
  for (const batch of batches) {
    if (currentSeq !== onlineSearchSeq) return
    try {
      const coverRes = await apiFetch('/api/covers/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: batch.map((b) => ({
            id: b.id,
            isbn: b.isbn,
            title: b.title,
            author: b.author,
            publisher: b.publisher || '',
          })),
        }),
      }).then((r) => parseJsonSafe(r))
      if (currentSeq !== onlineSearchSeq) return
      if (coverRes?.ok && coverRes.covers) {
        const covers: Record<string, string> = coverRes.covers
        const byNormTitle = new Map<string, string>()
        for (const bItem of batch) {
          const cov = covers[bItem.id]
          if (cov) {
            const normT = normalizeBookTitle(bItem.title)
            if (normT) byNormTitle.set(normT, cov)
          }
        }
        let updated = false
        for (const b of onlineItems.value) {
          const nextCov =
            covers[b.id] ||
            (!b.coverUrl ? byNormTitle.get(normalizeBookTitle(b.title)) : '')
          if (nextCov && b.coverUrl !== nextCov) {
            b.coverUrl = nextCov
            updated = true
          }
        }
        if (updated) {
          onlineItems.value = [...onlineItems.value]
        }
      }
    } catch {
      // ignore single batch error
    }
  }
}

async function runOnlineCatalogSearch() {
  if (onlineDebounceTimer) {
    clearTimeout(onlineDebounceTimer)
    onlineDebounceTimer = null
  }
  const kw = onlineSearchQuery.value.trim()
  if (!kw) {
    onlineItems.value = []
    onlineSearched.value = false
    onlineLoadingMore.value = false
    onlinePage.value = 1
    onlineHasMore.value = false
    return
  }
  const currentSeq = ++onlineSearchSeq
  saveSearchHistory(kw, 'online')
  showHistoryDropdown.value = false
  onlineLoading.value = true
  onlineLoadingMore.value = false
  onlinePage.value = 1
  onlineHasMore.value = false
  try {
    const resp = await apiFetch('/api/catalog/search', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: kw,
        branch: onlineBranch.value,
        onlyAvailable: onlineOnlyAvailable.value,
        autoGroup: onlineAutoGroup.value,
        rows: 15,
        page: 1,
      }),
    }).then((r) => parseJsonSafe(r))
    if (currentSeq !== onlineSearchSeq) return
    if (resp?.ok) {
      onlineSearched.value = true
      onlineZjTotal.value = resp.zjTotal || 0
      onlineHzTotal.value = resp.hzTotal || 0
      onlineHasMore.value = Boolean(resp.hasMore)
      const nowIso = new Date().toISOString()
      const mapped = mapCatalogItems(resp.items || [], nowIso, 0)
      const normalizedList = onlineAutoGroup.value
        ? sortOnlineCatalogItems(mapped, kw)
        : mapped
      onlineItems.value = normalizedList
      // 小批量渐进异步补全在线搜索结果封面（每 6 本实时上屏）
      if (normalizedList.length > 0) {
        void resolveOnlineItemsCovers(normalizedList, currentSeq)
      }
    }
  } catch (err: any) {
    if (currentSeq === onlineSearchSeq) {
      onlineSearched.value = false
      showToast(err?.message || '在线检索图书馆书目失败，请稍后重试')
    }
  } finally {
    if (currentSeq === onlineSearchSeq) {
      onlineLoading.value = false
    }
  }
}

function mapCatalogItems(rawList: any[], nowIso: string, baseOrder = 0): BorrowRecord[] {
  return (rawList || []).map((item: any, idx: number) => ({
    id: item.id,
    library: item.library,
    subLibrary:
      item.subLibrary || (item.library === 'zjlib' ? '浙江图书馆馆藏' : '杭州图书馆馆藏'),
    status: 'returned',
    title: item.title || '',
    author: item.author || '',
    isbn: item.isbn || '',
    callNo: item.callNo || '',
    barcode: '',
    bibId: item.bibId || '',
    loanDate: '',
    dueDate: '',
    returnDate: '',
    renewCount: 0,
    coverUrl: '',
    rating: 0,
    verdict: '',
    tags: [],
    note: '',
    progress: 0,
    updatedAt: nowIso,
    isOnlineCatalog: true,
    rawOrder: baseOrder + idx,
    publisher: item.publisher || '',
    pubDate: item.pubDate || '',
    availableCount: Number(item.availableCount || 0),
    totalHoldings: Number(item.totalHoldings || 0),
    availableBranches: Array.isArray(item.availableBranches) ? item.availableBranches : [],
    holdings: Array.isArray(item.holdings) ? item.holdings : [],
  }))
}

function sortOnlineCatalogItems(list: BorrowRecord[], rawQuery: string): BorrowRecord[] {
  return [...list].sort((a, b) => {
    const tierA = Math.floor(getSearchRelevanceScore(a, rawQuery) / 100)
    const tierB = Math.floor(getSearchRelevanceScore(b, rawQuery) / 100)
    if (tierA !== tierB) return tierA - tierB
    const natCmp = compareTitlesNaturally(a.title, b.title)
    if (natCmp !== 0) return natCmp
    const availA = (a.availableCount || 0) > 0 ? 1 : 0
    const availB = (b.availableCount || 0) > 0 ? 1 : 0
    if (availA !== availB) return availB - availA
    return 0
  })
}

async function loadMoreOnlineCatalog() {
  const kw = onlineSearchQuery.value.trim()
  if (!kw || onlineLoading.value || onlineLoadingMore.value || !onlineHasMore.value) return
  const currentSeq = onlineSearchSeq
  const nextPage = onlinePage.value + 1
  onlineLoadingMore.value = true
  try {
    const resp = await apiFetch('/api/catalog/search', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: kw,
        branch: onlineBranch.value,
        onlyAvailable: onlineOnlyAvailable.value,
        autoGroup: onlineAutoGroup.value,
        rows: 15,
        page: nextPage,
      }),
    }).then((r) => parseJsonSafe(r))
    if (currentSeq !== onlineSearchSeq) return
    if (resp?.ok) {
      onlinePage.value = nextPage
      onlineHasMore.value = Boolean(resp.hasMore)
      const existingIds = new Set(onlineItems.value.map((x) => x.id))
      const prevLen = onlineItems.value.length
      const nextItems = mapCatalogItems(
        resp.items || [],
        new Date().toISOString(),
        prevLen
      ).filter((x) => !existingIds.has(x.id))
      if (nextItems.length > 0) {
        const appended = [...onlineItems.value, ...nextItems]
        const sorted = onlineAutoGroup.value
          ? sortOnlineCatalogItems(appended, kw)
          : appended
        // 判断是否有新页项被归位插入到了原有列表中间/前面（仅在开启「自动归类」时触发）
        const didReorderExisting =
          onlineAutoGroup.value &&
          sorted.slice(0, prevLen).some((item, idx) => item.id !== appended[idx]?.id)

        if (didReorderExisting) {
          // 记录当前视口内锚点卡片的位置，重排后立即补偿滚动偏移，防止界面跳动与闪烁
          let anchorId = ''
          let anchorOldTop = 0
          const cardEls = document.querySelectorAll<HTMLElement>('[data-book-id]')
          for (const el of cardEls) {
            const rect = el.getBoundingClientRect()
            if (rect.bottom > 80 && rect.top < window.innerHeight) {
              anchorId = el.getAttribute('data-book-id') || ''
              anchorOldTop = rect.top
              break
            }
          }
          onlineItems.value = sorted
          await nextTick()
          if (anchorId) {
            const newAnchorEl = document.querySelector<HTMLElement>(
              `[data-book-id="${CSS.escape(anchorId)}"]`
            )
            if (newAnchorEl) {
              const delta = newAnchorEl.getBoundingClientRect().top - anchorOldTop
              if (Math.abs(delta) > 1) {
                window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior })
              }
            }
          }
          showToast(`已加载 ${nextItems.length} 本新书目，并按系列卷号顺序自动归位`)
        } else {
          onlineItems.value = sorted
        }
        void resolveOnlineItemsCovers(nextItems, currentSeq)
      }
    }
  } catch {
    // ignore
  } finally {
    if (currentSeq === onlineSearchSeq) {
      onlineLoadingMore.value = false
    }
  }
}

// 封面补全状态与加载失败记录
const brokenCoverIds = ref<Set<string>>(new Set())
const retriedInternetCoverIds = new Set<string>()
const resolvingCovers = ref(false)
const coverProgressText = ref('')
let coverResolveTaskRunning = false
let coverResolvePendingRerun = false

function isBadOrPlaceholderCoverUrl(url?: string): boolean {
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
    lower.includes('tc-cover-prod.oss') ||
    lower.includes('xinhuapic.oss') ||
    lower.includes('doubanio.com') ||
    lower.includes('openbookscan.com.cn:1235') ||
    lower.includes('=240=320') ||
    lower.endsWith('.null')
  )
}

function showToast(msg: string) {
  toastMessage.value = msg
  setTimeout(() => {
    if (toastMessage.value === msg) toastMessage.value = ''
  }, 3500)
}

const COVER_SCHEMA_V6_KEY = 'lh_cover_schema_v6'

function needsCoverUpgrade(url?: string): boolean {
  if (isBadOrPlaceholderCoverUrl(url)) return true
  const s = String(url || '')
  return s.includes('#hd=')
}

async function resolveMissingBookCovers() {
  const mySeq = ++localCoverResolveSeq
  if (coverResolveTaskRunning) {
    coverResolvePendingRerun = true
    return
  }
  const clearedIds: string[] = []
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(COVER_SCHEMA_V6_KEY) !== '1') {
      localStorage.setItem(COVER_SCHEMA_V6_KEY, '1')
      for (const r of records.value) {
        if (
          r.coverUrl &&
          (r.coverUrl.includes('#hd=') ||
            (!r.isbn && r.coverUrl.includes('baidu.com')) ||
            r.title.includes('航海王'))
        ) {
          r.coverUrl = ''
          clearedIds.push(r.id)
        }
      }
    }
  } catch {
    // ignore
  }
  // First clear any known placeholder or expired OSS URLs so they get replaced with real internet covers
  for (const r of records.value) {
    if (r.coverUrl && isBadOrPlaceholderCoverUrl(r.coverUrl)) {
      r.coverUrl = ''
      clearedIds.push(r.id)
    }
  }
  if (clearedIds.length > 0) {
    void clearCoverUrlsByIds(clearedIds)
    records.value = [...records.value]
  }
  // 针对当前可见渲染批次中缺失封面或仍为早期 220x220 kaicai 低清缩略图的记录按需升级
  const currentVisibleRecords = autoDedupByTitle.value
    ? visibleAggregatedBooks.value.map((g) => g.records[0])
    : visibleFilteredRecords.value
  const missing = currentVisibleRecords.filter((r) => needsCoverUpgrade(r.coverUrl))
  if (missing.length === 0) return

  coverResolveTaskRunning = true
  resolvingCovers.value = true
  try {
    const batches = buildFastFirstCoverBatches(missing)
    let resolvedCount = 0
    let processedCount = 0
    for (const batch of batches) {
      if (mySeq !== localCoverResolveSeq) break
      processedCount += batch.length
      coverProgressText.value = `正在智能匹配图书封面 (${Math.min(processedCount, missing.length)}/${missing.length})...`
      const resp = await apiFetch('/api/covers/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: batch.map((r) => ({
            id: r.id,
            isbn: r.isbn,
            title: r.title,
            author: r.author,
            publisher: r.publisher || '',
          })),
        }),
      }).then((r) => parseJsonSafe(r))
      if (mySeq !== localCoverResolveSeq) break

      if (resp?.ok && resp.covers) {
        const covers: Record<string, string> = resp.covers
        const count = Object.keys(covers).length
        if (count > 0) {
          resolvedCount += count
          const expandedCovers: Record<string, string> = { ...covers }
          const titleCoverMap = new Map<string, string>()
          for (const bItem of batch) {
            const cov = covers[bItem.id]
            if (cov) {
              const normT = normalizeBookTitle(bItem.title)
              if (normT) titleCoverMap.set(normT, cov)
            }
          }
          for (const rec of records.value) {
            const directCov = covers[rec.id]
            const sameTitleCov = titleCoverMap.get(normalizeBookTitle(rec.title))
            const nextCov = directCov || sameTitleCov
            if (nextCov) {
              rec.coverUrl = nextCov
              expandedCovers[rec.id] = nextCov
            }
          }
          await batchUpdateCoverUrls(expandedCovers)
          records.value = [...records.value]
        }
      }
    }
    if (resolvedCount > 0) {
      coverProgressText.value = `已为您自动补全 ${resolvedCount} 本图书封面`
      setTimeout(() => {
        coverProgressText.value = ''
      }, 3000)
    } else {
      coverProgressText.value = ''
    }
  } catch {
    coverProgressText.value = ''
  } finally {
    resolvingCovers.value = false
    coverResolveTaskRunning = false
    if (coverResolvePendingRerun) {
      coverResolvePendingRerun = false
      void nextTick(() => {
        void resolveMissingBookCovers()
      })
    }
  }
}

async function reloadFromDB() {
  loading.value = true
  try {
    let list = await getAllRecords()
    // If DB still contains old demo records or broken empty-date records, clean them up
    if (list.some((r) => isDemoOrBrokenRecord(r))) {
      const hasReal = list.some((r) => !isDemoOrBrokenRecord(r))
      if (hasReal) {
        await purgeDemoAndBrokenRecords()
        list = await getAllRecords()
      }
    }
    const firstInitKey = 'lh_initialized_demo_v1'
    if (list.length === 0 && !localStorage.getItem(firstInitKey)) {
      await upsertRecords(DEMO_BORROW_RECORDS, { keepDemo: true })
      localStorage.setItem(firstInitKey, '1')
      list = await getAllRecords()
      showToast('已为您载入浙图+杭图演示借阅数据，可直接体验拼音/书名秒搜与借书查重！')
    }
    records.value = list
    syncMeta.value = await getSyncMeta()
    resolveMissingBookCovers()
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  window.addEventListener('resize', handleWindowResize)
  registerMobileMapPicker((target, info, options) => {
    rememberMapChoice.value = Boolean(getPreferredMapProvider())
    mobileMapPickerState.value = { target, info, options }
  })
  loadSearchHistory()
  reloadFromDB()
  if (typeof IntersectionObserver !== 'undefined') {
    localSentinelObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMoreLocalItems.value && searchMode.value === 'local') {
          loadMoreLocalItems()
        }
      },
      { rootMargin: '240px' }
    )
    if (localLoadMoreSentinel.value) {
      localSentinelObserver.observe(localLoadMoreSentinel.value)
    }
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleWindowResize)
  registerMobileMapPicker(null)
  if (localSentinelObserver) {
    localSentinelObserver.disconnect()
    localSentinelObserver = null
  }
})

// Map normalized title -> total borrow count
const borrowCountMap = computed(() => {
  const datesByTitle = new Map<string, Set<string>>()
  for (const r of records.value) {
    const k = normalizeBookTitle(r.title)
    if (!k) continue
    if (!datesByTitle.has(k)) datesByTitle.set(k, new Set())
    datesByTitle.get(k)!.add(r.loanDate || r.id)
  }
  const m = new Map<string, number>()
  for (const [k, dateSet] of datesByTitle.entries()) {
    m.set(k, dateSet.size)
  }
  return m
})

const filteredRecords = computed(() =>
  filterAndSortRecords(
    records.value,
    {
      query: localSearchQuery.value,
      library: filterLibrary.value,
      status: filterStatus.value,
      verdict: filterVerdict.value,
      tag: filterTag.value,
      year: filterYear.value,
      onlyMultiBorrowed: onlyMultiBorrowed.value,
      sortField: sortField.value,
      sortOrder: sortOrder.value,
    },
    borrowCountMap.value
  )
)

const aggregatedBooks = computed(() => aggregateRecordsByBook(filteredRecords.value))

const displayedCount = computed(() =>
  autoDedupByTitle.value ? aggregatedBooks.value.length : filteredRecords.value.length
)

const LOCAL_PAGE_SIZE = 36
const localVisibleLimit = ref(LOCAL_PAGE_SIZE)
const localLoadMoreSentinel = ref<HTMLElement | null>(null)
let localSentinelObserver: IntersectionObserver | null = null

watch(localLoadMoreSentinel, (el, oldEl) => {
  if (localSentinelObserver) {
    if (oldEl) localSentinelObserver.unobserve(oldEl)
    if (el) localSentinelObserver.observe(el)
  }
})

const visibleAggregatedBooks = computed(() =>
  aggregatedBooks.value.slice(0, localVisibleLimit.value)
)
const visibleFilteredRecords = computed(() =>
  filteredRecords.value.slice(0, localVisibleLimit.value)
)
const hasMoreLocalItems = computed(() => displayedCount.value > localVisibleLimit.value)

function loadMoreLocalItems() {
  if (!hasMoreLocalItems.value) return
  localVisibleLimit.value += LOCAL_PAGE_SIZE
  void nextTick(() => {
    void resolveMissingBookCovers()
  })
}

watch(
  [
    localSearchQuery,
    filterLibrary,
    filterStatus,
    filterMark,
    filterYear,
    onlyMultiBorrowed,
    sortField,
    sortOrder,
    autoDedupByTitle,
  ],
  () => {
    localVisibleLimit.value = LOCAL_PAGE_SIZE
    void nextTick(() => {
      void resolveMissingBookCovers()
    })
  }
)

const isAllRecordsSelected = computed(
  () =>
    filterLibrary.value === 'all' &&
    filterStatus.value === 'all' &&
    filterMark.value === 'all' &&
    !filterYear.value &&
    !onlyMultiBorrowed.value
)

function selectAllRecordsCard() {
  filterLibrary.value = 'all'
  filterStatus.value = 'all'
  filterMark.value = 'all'
  filterYear.value = ''
  onlyMultiBorrowed.value = false
  if (!localSearchQuery.value.trim()) {
    sortField.value = 'loanDate'
    sortOrder.value = 'desc'
  }
}

function selectCategoryCard(lib: 'all' | LibrarySource, status: 'all' | 'borrowed' = 'all') {
  filterLibrary.value = lib
  filterStatus.value = status
  if (!localSearchQuery.value.trim()) {
    sortField.value = 'loanDate'
    sortOrder.value = 'desc'
  }
}

function handleSortFieldChange() {
  if (sortField.value === 'title' || sortField.value === 'library' || sortField.value === 'dueDate') {
    sortOrder.value = 'asc'
  } else {
    sortOrder.value = 'desc'
  }
}

function toggleSortOrder() {
  sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
}

async function markCoverBroken(id: string) {
  brokenCoverIds.value.add(id)
  if (retriedInternetCoverIds.has(id)) return
  retriedInternetCoverIds.add(id)
  const target = records.value.find((r) => r.id === id)
  if (!target) return
  try {
    const resp = await apiFetch('/api/covers/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        forceInternet: true,
        items: [
          {
            id: target.id,
            isbn: target.isbn,
            title: target.title,
            author: target.author,
            publisher: target.publisher || '',
          },
        ],
      }),
    }).then((r) => parseJsonSafe(r))
    const newUrl = resp?.covers?.[id]
    if (newUrl && newUrl !== target.coverUrl) {
      await batchUpdateCoverUrls({ [id]: newUrl })
      target.coverUrl = newUrl
      brokenCoverIds.value.delete(id)
      records.value = [...records.value]
    }
  } catch {
    // ignore
  }
}

async function markOnlineCoverBroken(id: string) {
  onlineBrokenCovers.value[id] = true
  if (retriedInternetCoverIds.has(id)) return
  retriedInternetCoverIds.add(id)
  const target = onlineItems.value.find((r) => r.id === id)
  if (!target) return
  try {
    const resp = await apiFetch('/api/covers/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        forceInternet: true,
        items: [
          {
            id: target.id,
            isbn: target.isbn,
            title: target.title,
            author: target.author,
            publisher: target.publisher || '',
          },
        ],
      }),
    }).then((r) => parseJsonSafe(r))
    const newUrl = resp?.covers?.[id]
    if (newUrl && newUrl !== target.coverUrl) {
      target.coverUrl = newUrl
      delete onlineBrokenCovers.value[id]
      onlineItems.value = [...onlineItems.value]
    }
  } catch {
    // ignore
  }
}

// Statistics
const isDemoDataMode = computed(
  () => records.value.length > 0 && records.value.every((r) => isDemoOrBrokenRecord(r))
)

const stats = computed(() => {
  const total = records.value.length
  const zjlibCount = records.value.filter((r) => r.library === 'zjlib').length
  const hzlibCount = records.value.filter((r) => r.library === 'hzlib').length
  const borrowedList = records.value.filter((r) => r.status === 'borrowed')
  const soonDueCount = borrowedList.filter((r) => {
    const d = getDaysRemaining(r.dueDate)
    return d !== null && d <= 7
  }).length
  const uniqueBooks = new Set(records.value.map((r) => normalizeBookTitle(r.title))).size
  return {
    total,
    zjlibCount,
    hzlibCount,
    borrowedCount: borrowedList.length,
    soonDueCount,
    uniqueBooks,
  }
})

// Available years & popular tags
const availableYears = computed(() => {
  const years = new Set<string>()
  for (const r of records.value) {
    const y = (r.loanDate || '').slice(0, 4)
    if (/^\d{4}$/.test(y)) years.add(y)
  }
  return Array.from(years).sort((a, b) => b.localeCompare(a))
})

const popularTags = computed(() => {
  const counts = new Map<string, number>()
  for (const r of records.value) {
    for (const t of r.tags || []) {
      counts.set(t, (counts.get(t) || 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }))
})

const sameBookHistoryForActive = computed(() => {
  if (!activeRecord.value) return []
  const norm = normalizeBookTitle(activeRecord.value.title)
  return records.value.filter((r) => normalizeBookTitle(r.title) === norm)
})

function resetAllFilters() {
  if (localSearchDebounceTimer) {
    clearTimeout(localSearchDebounceTimer)
    localSearchDebounceTimer = null
  }
  localSearchInput.value = ''
  localSearchQuery.value = ''
  filterLibrary.value = 'all'
  filterStatus.value = 'all'
  filterMark.value = 'all'
  filterYear.value = ''
  onlyMultiBorrowed.value = false
}

const hasActiveFilters = computed(
  () =>
    Boolean(localSearchQuery.value.trim()) ||
    filterLibrary.value !== 'all' ||
    filterStatus.value !== 'all' ||
    filterMark.value !== 'all' ||
    Boolean(filterYear.value) ||
    onlyMultiBorrowed.value
)

let importQueue: Promise<void> = Promise.resolve()

async function handleImported(payload: {
  records: Array<Partial<BorrowRecord>>
  source: 'zjlib' | 'hzlib' | 'mixed'
  account?: string
  isFullOnlineSync?: boolean
  syncMetaPatch?: Partial<SyncMeta>
}) {
  const task = importQueue.then(async () => {
    const res = await upsertRecords(payload.records, {
      source: payload.source,
      account: payload.account,
      isFullOnlineSync: payload.isFullOnlineSync,
    })
    const nowStr = new Date().toLocaleString('zh-CN', { hour12: false })
    if (payload.source === 'zjlib') {
      await saveSyncMeta({
        zjlibLastSync: nowStr,
        ...(payload.account ? { zjlibAccount: payload.account.trim() } : {}),
      })
    } else if (payload.source === 'hzlib') {
      await saveSyncMeta({
        hzlibLastSync: nowStr,
        ...(payload.account ? { hzlibAccount: payload.account.trim() } : {}),
      })
    } else if (payload.syncMetaPatch) {
      await saveSyncMeta(payload.syncMetaPatch)
    }
    await reloadFromDB()
    const retainedHint =
      res.retainedExpired > 0 ? `，保留本地早期历史 ${res.retainedExpired} 条` : ''
    showToast(
      `同步完成：新增 ${res.added} 条，更新 ${res.updated} 条${retainedHint}，当前共 ${res.total} 条记录`
    )
  })
  // 保证即使前一个任务异常也不阻断后续入库队列
  importQueue = task.catch(() => {})
  return task
}

async function handleLoadDemo() {
  const res = await upsertRecords(DEMO_BORROW_RECORDS, { keepDemo: true })
  await reloadFromDB()
  showSyncModal.value = false
  showToast(`已载入双馆演示数据（新增 ${res.added} 条，合并 ${res.updated} 条）`)
}

async function handleSaveRecordMeta(
  id: string,
  patch: Partial<
    Pick<
      BorrowRecord,
      'rating' | 'verdict' | 'tags' | 'note' | 'progress' | 'status' | 'returnDate' | 'dueDate' | 'renewCount'
    >
  >
) {
  const updated = await updateRecordUserMeta(id, patch)
  if (updated) {
    const idx = records.value.findIndex((r) => r.id === id)
    if (idx !== -1) records.value[idx] = updated
    if (activeRecord.value?.id === id) activeRecord.value = updated

    // 同步更新同名图书的标记、分类标签、评分和笔记，确保去重聚合视图与流水视图完全一致
    const normKey = normalizeBookTitle(updated.title)
    const sharedPatch = {
      rating: updated.rating,
      verdict: updated.verdict,
      tags: updated.tags,
      note: updated.note,
    }
    for (let i = 0; i < records.value.length; i++) {
      const r = records.value[i]
      if (r.id !== id && normalizeBookTitle(r.title) === normKey) {
        const synced = await updateRecordUserMeta(r.id, sharedPatch)
        if (synced) records.value[i] = synced
      }
    }
    records.value = [...records.value]
  }
}

async function handleClearAll() {
  if (!confirm('确定要清空本地数据库中的所有借阅记录吗？')) return
  await clearAllRecords()
  await reloadFromDB()
  showSyncModal.value = false
  showToast('已清空本地借阅记录')
}

async function handleConfirmLogout() {
  await clearAllLocalData()
  try {
    localStorage.removeItem('lh_hzlib_cred')
    localStorage.removeItem('lh_hzlib_cookie')
    localStorage.removeItem('lh_zjlib_cred')
    localStorage.removeItem('lh_zjlib_token')
    localStorage.removeItem(SEARCH_HISTORY_LOCAL_KEY)
    localStorage.removeItem(SEARCH_HISTORY_ONLINE_KEY)
    localStorage.setItem('lh_initialized_demo_v1', '1')
    localStorage.setItem('lh_first_init_done_v1', '1')
    sessionStorage.removeItem('lh_search_mode_v1')
    sessionStorage.removeItem('lh_online_branch_v1')
    sessionStorage.removeItem('lh_online_avail_v1')
  } catch {
    // ignore
  }
  records.value = []
  syncMeta.value = {}
  localSearchHistory.value = []
  onlineSearchHistory.value = []
  localSearchQuery.value = ''
  onlineSearchQuery.value = ''
  searchMode.value = 'local'
  filterLibrary.value = 'all'
  filterStatus.value = 'all'
  filterMark.value = 'all'
  filterYear.value = ''
  onlyMultiBorrowed.value = false
  onlineItems.value = []
  onlineSearched.value = false
  activeRecord.value = null
  showSyncModal.value = false
  showLogoutConfirm.value = false
  showToast('已退出登录并清除本地所有数据')
}

function handleExportJson() {
  let savedHzAccount = syncMeta.value.hzlibAccount || ''
  let savedZjAccount = syncMeta.value.zjlibAccount || ''
  try {
    if (!savedHzAccount) {
      const rawHz = localStorage.getItem('lh_hzlib_cred')
      if (rawHz) savedHzAccount = String(JSON.parse(rawHz)?.account || '').trim()
    }
    if (!savedZjAccount) {
      const rawZj = localStorage.getItem('lh_zjlib_cred')
      if (rawZj) savedZjAccount = String(JSON.parse(rawZj)?.account || '').trim()
    }
  } catch {
    // ignore
  }
  for (const r of records.value) {
    if (!savedHzAccount && r.library === 'hzlib' && r.account) savedHzAccount = r.account
    if (!savedZjAccount && r.library === 'zjlib' && r.account) savedZjAccount = r.account
  }
  const exportedRecords = records.value.map((r) => ({
    ...r,
    account:
      r.account ||
      (r.library === 'hzlib' ? savedHzAccount : r.library === 'zjlib' ? savedZjAccount : ''),
  }))
  const data = {
    app: 'LibraryHelper',
    version: versionInfo.version,
    exportedAt: new Date().toISOString(),
    accounts: {
      hzlibAccount: savedHzAccount,
      zjlibAccount: savedZjAccount,
    },
    syncMeta: {
      ...syncMeta.value,
      hzlibAccount: savedHzAccount || syncMeta.value.hzlibAccount,
      zjlibAccount: savedZjAccount || syncMeta.value.zjlibAccount,
    },
    total: records.value.length,
    records: exportedRecords,
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `浙杭借阅记录备份_${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  showToast('已导出 JSON 备份文件')
}

function handleExportCsv() {
  const headers = [
    '所属馆',
    '分馆/借阅室',
    '状态',
    '书名',
    '作者',
    'ISBN',
    '索书号',
    '条码号',
    '借出日期',
    '应还日期',
    '归还日期',
    '评分',
    '评价标记',
    '标签',
    '读书笔记',
  ]
  const rows = records.value.map((r) => [
    r.library === 'zjlib' ? '浙江图书馆' : '杭州图书馆',
    r.subLibrary,
    r.status === 'borrowed' ? '当前在借' : '已归还',
    r.title,
    r.author,
    r.isbn,
    r.callNo,
    r.barcode,
    r.loanDate,
    r.dueDate,
    r.returnDate,
    String(r.rating || ''),
    r.verdict,
    (r.tags || []).join('|'),
    (r.note || '').replace(/\r?\n/g, ' '),
  ])
  const csvContent =
    '\uFEFF' +
    [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell || '').replace(/"/g, '""')}"`).join(','))
      .join('\n')
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `浙杭借阅记录表_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  showToast('已导出 CSV 表格文件')
}

function verdictLabel(v: VerdictType) {
  switch (v) {
    case 'worth_reborrow':
      return { text: '👍 值得重借', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
    case 'liked':
      return { text: '❤️ 推荐喜欢', cls: 'bg-teal-50 text-teal-700 border-teal-200' }
    case 'unfinished':
      return { text: '🔖 未读完下次再借', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
    case 'disliked':
      return { text: '💣 踩雷别借', cls: 'bg-rose-50 text-rose-700 border-rose-200 font-semibold' }
    default:
      return null
  }
}

function getRepeatCount(title: string): number {
  return borrowCountMap.value.get(normalizeBookTitle(title)) || 1
}
</script>

<template>
  <div class="min-h-screen overflow-y-scroll bg-slate-100 text-slate-900 flex flex-col">
    <!-- Top Dev / Preview Toolbar -->
    <div class="bg-slate-900 text-slate-200 px-4 py-2 text-xs flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span
          class="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono border border-slate-700"
          :title="versionInfo.description"
        >
          v{{ versionInfo.version }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="px-2.5 py-1 rounded-lg flex items-center gap-1.5 transition cursor-pointer"
          :class="
            !mobileFrameMode
              ? 'bg-teal-600 text-white font-medium'
              : 'bg-slate-800 text-slate-400 hover:text-white'
          "
          @click="mobileFrameMode = false"
        >
          <Monitor class="w-3.5 h-3.5" />
          PC 宽屏视图
        </button>
        <button
          class="px-2.5 py-1 rounded-lg flex items-center gap-1.5 transition cursor-pointer"
          :class="
            mobileFrameMode
              ? 'bg-teal-600 text-white font-medium'
              : 'bg-slate-800 text-slate-400 hover:text-white'
          "
          @click="mobileFrameMode = true"
        >
          <Smartphone class="w-3.5 h-3.5" />
          手机端预览框 (412px)
        </button>
      </div>
    </div>

    <!-- Toast Notification -->
    <div
      v-if="toastMessage"
      class="fixed top-12 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-2xl bg-slate-900/95 text-white text-xs sm:text-sm shadow-xl border border-slate-700 flex items-center gap-2"
    >
      <Sparkles class="w-4 h-4 text-amber-400 shrink-0" />
      <span>{{ toastMessage }}</span>
    </div>

    <!-- Main App Container (Supports Phone Frame Simulator on PC) -->
    <div
      class="flex-1 mx-auto w-full transition-all duration-300"
      :class="
        mobileFrameMode
          ? 'max-w-[420px] my-4 rounded-[36px] border-[8px] border-slate-800 shadow-2xl bg-slate-50 overflow-hidden flex flex-col'
          : 'max-w-5xl px-3 sm:px-6 py-4 sm:py-6'
      "
    >
      <div :class="mobileFrameMode ? 'p-3.5 overflow-y-auto flex-1 space-y-4' : 'space-y-5'">
        <!-- Hero Header Card -->
        <header
          class="rounded-2xl bg-gradient-to-br from-teal-700 via-teal-800 to-slate-900 text-white shadow-lg space-y-3.5"
          :class="isMobileLayout ? 'p-3.5' : 'p-6'"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <Library class="w-6 h-6 text-teal-300 shrink-0" />
              <h1 class="font-extrabold tracking-tight" :class="isMobileLayout ? 'text-lg' : 'text-xl'">
                浙杭借书搭子
              </h1>
            </div>

            <div class="flex items-center gap-1.5 shrink-0">
              <button
                v-if="isDemoDataMode"
                class="px-3 py-1.5 rounded-xl bg-amber-500/25 hover:bg-rose-500/85 text-amber-100 hover:text-white font-semibold flex items-center justify-center gap-1.5 border border-amber-300/40 transition cursor-pointer whitespace-nowrap"
                :class="isMobileLayout ? 'text-xs' : 'text-sm'"
                @click="handleConfirmLogout"
              >
                <LogOut class="w-3.5 h-3.5" />
                [测试数据] 退出登录
              </button>
              <template v-else>
                <button
                  class="px-3 py-1.5 rounded-xl bg-white/15 hover:bg-white/25 text-white font-semibold flex items-center justify-center gap-1.5 border border-white/20 transition cursor-pointer whitespace-nowrap"
                  :class="isMobileLayout ? 'text-xs' : 'text-sm'"
                  @click="showSyncModal = true"
                >
                  <RefreshCw class="w-3.5 h-3.5" />
                  {{ records.length > 0 ? '更新记录' : '导入记录' }}
                </button>
                <button
                  v-if="records.length > 0"
                  class="px-2.5 py-1.5 rounded-xl bg-white/10 hover:bg-rose-500/80 text-white/95 hover:text-white font-medium flex items-center justify-center gap-1 border border-white/20 transition cursor-pointer whitespace-nowrap"
                  :class="isMobileLayout ? 'text-xs' : 'text-sm'"
                  @click="showLogoutConfirm = true"
                >
                  <LogOut class="w-3.5 h-3.5" />
                  退出登录
                </button>
              </template>
            </div>
          </div>

          <!-- Stats Strip (4 Buttons: 第一行不换行，统一显示“X 册”) -->
          <div class="grid grid-cols-4 pt-1" :class="isMobileLayout ? 'gap-1.5' : 'gap-2.5'">
            <button
              class="rounded-xl text-left transition cursor-pointer min-w-0"
              :class="[
                isMobileLayout ? 'px-2 py-2' : 'p-3',
                isAllRecordsSelected
                  ? 'bg-teal-500/40 ring-2 ring-teal-300 shadow-inner'
                  : 'bg-white/10 hover:bg-white/15',
              ]"
              @click="selectAllRecordsCard"
            >
              <div
                class="text-teal-200 whitespace-nowrap"
                :class="isMobileLayout ? 'text-[11px]' : 'text-xs'"
              >
                累计借阅
              </div>
              <div
                class="font-extrabold mt-0.5 whitespace-nowrap"
                :class="isMobileLayout ? 'text-sm' : 'text-xl'"
              >
                {{ stats.total }} <span class="text-[11px] font-normal opacity-80">册</span>
              </div>
            </button>
            <button
              class="rounded-xl text-left transition cursor-pointer min-w-0"
              :class="[
                isMobileLayout ? 'px-2 py-2' : 'p-3',
                filterLibrary === 'zjlib'
                  ? 'bg-indigo-500/40 ring-2 ring-indigo-300'
                  : 'bg-white/10 hover:bg-white/15',
              ]"
              @click="selectCategoryCard(filterLibrary === 'zjlib' ? 'all' : 'zjlib', 'all')"
            >
              <div
                class="text-indigo-200 whitespace-nowrap"
                :class="isMobileLayout ? 'text-[11px]' : 'text-xs'"
              >
                <span v-if="!isMobileLayout">🏛️ </span>浙江图书馆
              </div>
              <div
                class="font-extrabold mt-0.5 whitespace-nowrap"
                :class="isMobileLayout ? 'text-sm' : 'text-xl'"
              >
                {{ stats.zjlibCount }} <span class="text-[11px] font-normal opacity-80">册</span>
              </div>
            </button>
            <button
              class="rounded-xl text-left transition cursor-pointer min-w-0"
              :class="[
                isMobileLayout ? 'px-2 py-2' : 'p-3',
                filterLibrary === 'hzlib'
                  ? 'bg-teal-500/40 ring-2 ring-teal-300'
                  : 'bg-white/10 hover:bg-white/15',
              ]"
              @click="selectCategoryCard(filterLibrary === 'hzlib' ? 'all' : 'hzlib', 'all')"
            >
              <div
                class="text-emerald-200 whitespace-nowrap"
                :class="isMobileLayout ? 'text-[11px]' : 'text-xs'"
              >
                <span v-if="!isMobileLayout">📚 </span>杭州图书馆
              </div>
              <div
                class="font-extrabold mt-0.5 whitespace-nowrap"
                :class="isMobileLayout ? 'text-sm' : 'text-xl'"
              >
                {{ stats.hzlibCount }} <span class="text-[11px] font-normal opacity-80">册</span>
              </div>
            </button>
            <button
              class="rounded-xl text-left transition cursor-pointer min-w-0"
              :class="[
                isMobileLayout ? 'px-2 py-2' : 'p-3',
                filterStatus === 'borrowed'
                  ? 'bg-amber-500/40 ring-2 ring-amber-300'
                  : 'bg-white/10 hover:bg-white/15',
              ]"
              @click="selectCategoryCard(filterLibrary, filterStatus === 'borrowed' ? 'all' : 'borrowed')"
            >
              <div
                class="text-amber-200 whitespace-nowrap"
                :class="isMobileLayout ? 'text-[11px]' : 'text-xs'"
              >
                <span v-if="!isMobileLayout">⏳ </span>当前在借
              </div>
              <div
                class="font-extrabold mt-0.5 whitespace-nowrap"
                :class="isMobileLayout ? 'text-sm' : 'text-xl'"
              >
                {{ stats.borrowedCount }} <span class="text-[11px] font-normal opacity-80">册</span>
              </div>
            </button>
          </div>
        </header>

        <!-- Search & Filter Panel -->
        <section class="bg-white rounded-2xl p-3.5 sm:p-4 shadow-xs border border-slate-200/90 space-y-3">
          <!-- 搜索范围切换：搜我的借阅 vs 在线搜双馆书库 -->
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="inline-flex rounded-xl bg-slate-100 p-1 border border-slate-200 text-xs">
              <button
                type="button"
                class="px-3 py-1.5 rounded-lg flex items-center gap-1.5 font-semibold focus:outline-none select-none transition-colors cursor-pointer"
                :class="
                  searchMode === 'local'
                    ? 'bg-white text-teal-700 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                "
                @click="switchSearchMode('local')"
              >
                📚 搜我的借阅 ({{ stats.total }}册)
              </button>
              <button
                type="button"
                class="px-3 py-1.5 rounded-lg flex items-center gap-1.5 font-semibold focus:outline-none select-none transition-colors cursor-pointer"
                :class="
                  searchMode === 'online'
                    ? 'bg-indigo-600 text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                "
                @click="switchSearchMode('online')"
              >
                🌐 在线搜浙图/杭图全馆书库
              </button>
            </div>
          </div>

          <!-- Instant Search Input -->
          <div class="relative">
            <Search class="w-5 h-5 text-teal-600 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              v-model="activeSearchQuery"
              type="text"
              :placeholder="
                searchMode === 'online'
                  ? '输入书名、作者或 ISBN，在线检索浙江图书馆与杭州图书馆全馆藏书...'
                  : '搜书名、作者、拼音首字母(如 st 搜三体)、ISBN、索书号、分馆或笔记...'
              "
              class="w-full pl-11 pr-24 py-3 rounded-xl bg-slate-50 border border-slate-300 focus:bg-white focus:border-teal-600 focus:ring-2 focus:ring-teal-500/20 text-sm transition focus:outline-none"
              @focus="showHistoryDropdown = true"
              @click="showHistoryDropdown = true"
              @blur="handleSearchInputBlur"
              @keyup.enter="handleSearchEnter"
            />
            <div class="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
              <button
                v-if="activeSearchQuery"
                class="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 cursor-pointer"
                @click="
                  if (searchMode === 'online') {
                    onlineSearchQuery = '';
                    onlineItems = [];
                    onlineSearched = false;
                    onlineLoadingMore = false;
                    onlinePage = 1;
                    onlineHasMore = false;
                  } else {
                    if (localSearchDebounceTimer) {
                      clearTimeout(localSearchDebounceTimer);
                      localSearchDebounceTimer = null;
                    }
                    localSearchInput = '';
                    localSearchQuery = '';
                  }
                "
              >
                <X class="w-4 h-4" />
              </button>
              <button
                v-if="searchMode === 'online'"
                type="button"
                class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold cursor-pointer transition"
                @click="runOnlineCatalogSearch"
              >
                在线搜索
              </button>
              <span
                v-else
                class="px-2 py-0.5 rounded-md bg-teal-50 text-teal-700 text-xs font-semibold"
              >
                {{ displayedCount }} {{ autoDedupByTitle ? '本' : '条' }}
              </span>
            </div>

            <!-- 历史搜索记录下拉框（最多保留 10 条） -->
            <div
              v-if="showHistoryDropdown && searchHistory.length > 0"
              class="absolute left-0 right-0 top-full mt-1.5 z-40 bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden text-xs"
              @mousedown.prevent
            >
              <div class="px-3.5 py-2 bg-slate-50 border-b border-slate-100 flex items-center justify-between text-slate-500">
                <span class="font-semibold flex items-center gap-1.5">
                  <Clock class="w-3.5 h-3.5 text-teal-600" />
                  最近搜索记录（{{ searchHistory.length }}/10）
                </span>
                <button
                  type="button"
                  class="text-[11px] text-rose-500 hover:text-rose-700 font-medium cursor-pointer"
                  @click="clearSearchHistory"
                >
                  清空历史
                </button>
              </div>
              <div class="max-h-60 overflow-y-auto divide-y divide-slate-100">
                <div
                  v-for="item in searchHistory"
                  :key="item"
                  class="px-3.5 py-2 hover:bg-teal-50/60 flex items-center justify-between gap-2 cursor-pointer transition group"
                  @click="selectHistoryKeyword(item)"
                >
                  <div class="flex items-center gap-2 min-w-0 flex-1">
                    <Search class="w-3.5 h-3.5 text-slate-400 group-hover:text-teal-600 shrink-0" />
                    <span class="text-slate-700 group-hover:text-teal-800 font-medium truncate">
                      {{ item }}
                    </span>
                  </div>
                  <button
                    type="button"
                    class="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer shrink-0"
                    title="删除此条搜索记录"
                    @click.stop="removeSearchHistoryItem(item)"
                  >
                    <X class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div
            v-if="coverProgressText"
            class="text-[11px] text-teal-700 bg-teal-50 px-2.5 py-1 rounded-full inline-flex items-center gap-1"
          >
            <ImageIcon class="w-3 h-3 animate-pulse" />
            <span>{{ coverProgressText }}</span>
          </div>

          <!-- Filter Pills Row (仅在「搜我的借阅」模式下显示) -->
          <div v-if="searchMode === 'local'" class="min-h-[34px] flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-1.5">
              <!-- Library Filter -->
              <select
                v-model="filterLibrary"
                class="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-xs font-medium text-slate-700 cursor-pointer"
              >
                <option value="all">全部图书馆</option>
                <option value="zjlib">🏛️ 仅看浙江图书馆</option>
                <option value="hzlib">📚 仅看杭州图书馆</option>
              </select>

              <!-- Status Filter -->
              <select
                v-model="filterStatus"
                class="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-xs font-medium text-slate-700 cursor-pointer"
              >
                <option value="all">全部状态</option>
                <option value="borrowed">⏳ 当前在借</option>
                <option value="returned">✅ 已归还历史</option>
              </select>

              <!-- Verdict Filter -->
              <select
                v-model="filterMark"
                class="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-xs font-medium text-slate-700 cursor-pointer"
              >
                <option value="all">全部评价标记</option>
                <option value="verdict:worth_reborrow">👍 值得重借</option>
                <option value="verdict:liked">❤️ 推荐喜欢</option>
                <option value="verdict:unfinished">🔖 未读完下次再借</option>
                <option value="verdict:disliked">💣 踩雷别借</option>
                <option
                  v-for="item in popularTags"
                  :key="item.tag"
                  :value="'tag:' + item.tag"
                >
                  🏷️ #{{ item.tag }} ({{ item.count }})
                </option>
              </select>

              <!-- Year Filter -->
              <select
                v-model="filterYear"
                class="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-xs font-medium text-slate-700 cursor-pointer"
              >
                <option value="">全部年份</option>
                <option v-for="y in availableYears" :key="y" :value="y">{{ y }} 年</option>
              </select>

              <!-- Multi-borrow toggle -->
              <button
                class="px-2.5 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1 transition cursor-pointer"
                :class="
                  onlyMultiBorrowed
                    ? 'bg-amber-50 border-amber-300 text-amber-800'
                    : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                "
                @click="onlyMultiBorrowed = !onlyMultiBorrowed"
              >
                <Repeat class="w-3.5 h-3.5" />
                借过≥2次
              </button>
            </div>

            <!-- Sort Field + Asc/Desc + Auto-Dedup Toggle -->
            <div class="flex flex-wrap items-center gap-1.5">
              <select
                v-model="sortField"
                class="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-xs font-medium text-slate-700 cursor-pointer"
                @change="handleSortFieldChange"
              >
                <option value="title">📖 按书名排序 (同系列卷1,2...)</option>
                <option value="loanDate">📅 按借阅时间排序</option>
                <option value="library">🏛️ 按图书馆/分馆排序</option>
                <option value="dueDate">⏳ 按在借应还日期排序</option>
                <option value="rating">⭐ 按个人评分排序</option>
              </select>

              <!-- Asc / Desc Toggle -->
              <button
                class="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs font-medium text-slate-700 flex items-center gap-1 transition cursor-pointer"
                :title="sortOrder === 'asc' ? '当前升序，点击切换倒序' : '当前倒序，点击切换升序'"
                @click="toggleSortOrder"
              >
                <ArrowUp v-if="sortOrder === 'asc'" class="w-3.5 h-3.5 text-teal-600" />
                <ArrowDown v-else class="w-3.5 h-3.5 text-amber-600" />
                <span>{{ sortOrder === 'asc' ? '升序' : '倒序' }}</span>
              </button>

              <!-- Auto Deduplicate by Book Title Toggle -->
              <div class="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-100 text-xs">
                <button
                  class="px-2 py-1 rounded-md flex items-center gap-1 transition cursor-pointer"
                  :class="
                    autoDedupByTitle
                      ? 'bg-white text-teal-700 shadow-2xs font-semibold'
                      : 'text-slate-500'
                  "
                  @click="autoDedupByTitle = true"
                >
                  <Layers class="w-3.5 h-3.5" />
                  书名去重({{ aggregatedBooks.length }})
                </button>
                <button
                  class="px-2 py-1 rounded-md flex items-center gap-1 transition cursor-pointer"
                  :class="
                    !autoDedupByTitle
                      ? 'bg-white text-teal-700 shadow-2xs font-semibold'
                      : 'text-slate-500'
                  "
                  @click="autoDedupByTitle = false"
                >
                  <ListFilter class="w-3.5 h-3.5" />
                  全部流水({{ filteredRecords.length }})
                </button>
              </div>

              <!-- Reset button (placed at the very end of all options) -->
              <button
                v-if="hasActiveFilters"
                class="px-2.5 py-1.5 rounded-lg text-xs text-rose-600 hover:bg-rose-50 font-medium cursor-pointer"
                @click="resetAllFilters"
              >
                重置筛选
              </button>
            </div>
          </div>

          <!-- 在线检索范围栏（固定在搜索卡片同一位置与同一行高，避免切换模式时面板高度跳动） -->
          <div
            v-else
            class="min-h-[34px] flex flex-wrap items-center justify-between gap-2 text-xs"
          >
            <div class="flex flex-wrap items-center gap-1.5">
              <!-- 分馆下拉框（与「搜我的借阅」一致的下拉排版） -->
              <select
                v-model="onlineBranch"
                class="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-xs font-medium text-slate-700 cursor-pointer"
                @change="handleOnlineBranchChange"
              >
                <option value="all">全部图书馆 (浙图+杭图)</option>
                <optgroup :label="ZJLIB_BRANCH_CONFIG.groupLabel">
                  <option
                    v-for="opt in ZJLIB_BRANCH_CONFIG.dropdownOptions"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </option>
                </optgroup>
                <optgroup :label="HZLIB_BRANCH_CONFIG.groupLabel">
                  <option
                    v-for="opt in HZLIB_BRANCH_CONFIG.dropdownOptions"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </option>
                </optgroup>
              </select>

              <!-- 默认过滤不在馆书籍开关 -->
              <button
                type="button"
                class="px-2.5 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1 focus:outline-none select-none transition-colors cursor-pointer whitespace-nowrap"
                :class="
                  onlineOnlyAvailable
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                    : 'bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100'
                "
                @click="toggleOnlineOnlyAvailable"
              >
                {{ onlineOnlyAvailable ? '🟢 只看有书' : '⚪ 只看有书' }}
              </button>

              <!-- 自动归类开关（默认关闭：按图书馆接口返回原序展示；开启：同系列按卷号归位排序） -->
              <button
                type="button"
                class="px-2.5 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1 focus:outline-none select-none transition-colors cursor-pointer whitespace-nowrap"
                :class="
                  onlineAutoGroup
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                    : 'bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100'
                "
                title="开启时按同系列与卷号顺序自动归类；关闭时按图书馆官方接口返回的原始顺序展示"
                @click="toggleOnlineAutoGroup"
              >
                {{ onlineAutoGroup ? '🟢 自动归类' : '⚪ 自动归类' }}
              </button>
            </div>

            <div v-if="onlineSearched && !onlineLoading && onlineSearchQuery.trim()" class="text-slate-600">
              当前已加载 <span class="font-bold text-emerald-700">{{ onlineItems.length }}</span> 本 · 馆藏总命中：浙图
              <span class="font-bold text-indigo-700">{{ onlineZjTotal }}</span> 条 / 杭图
              <span class="font-bold text-teal-700">{{ onlineHzTotal }}</span> 条
            </div>
          </div>

        </section>

        <!-- ==================== 在线搜浙图/杭图全馆书库视图 ==================== -->
        <OnlineCatalogSection
          v-show="searchMode === 'online'"
          :branch="onlineBranch"
          :only-available="onlineOnlyAvailable"
          :keyword="onlineSearchQuery"
          :loading="onlineLoading"
          :loading-more="onlineLoadingMore"
          :has-more="onlineHasMore"
          :searched="onlineSearched"
          :items="onlineItems"
          :zj-total="onlineZjTotal"
          :hz-total="onlineHzTotal"
          :mobile-mode="isMobileLayout"
          :broken-covers="onlineBrokenCovers"
          :local-records="records"
          @search="runOnlineCatalogSearch"
          @load-more="loadMoreOnlineCatalog"
          @zoom-cover="openFullscreenCover"
          @cover-error="markOnlineCoverBroken"
        />

        <!-- Empty State -->
        <div
          v-if="searchMode === 'local' && filteredRecords.length === 0"
          class="bg-white rounded-2xl p-10 text-center border border-slate-200 space-y-3"
        >
          <BookOpen class="w-10 h-10 text-slate-300 mx-auto" />
          <div class="text-sm font-semibold text-slate-700">
            没有找到匹配的借阅记录
          </div>
          <p class="text-xs text-slate-500">
            <template v-if="hasActiveFilters">
              当前筛选条件下无匹配结果，试试放宽关键词或重置筛选条件
            </template>
            <template v-else>
              本地暂无借阅数据，您可以点击下方按钮同步浙江图书馆/杭州图书馆记录，或载入演示数据
            </template>
          </p>
          <div class="flex justify-center gap-2 pt-1">
            <button
              v-if="hasActiveFilters"
              class="px-4 py-2 rounded-xl bg-teal-600 text-white text-xs font-medium cursor-pointer"
              @click="resetAllFilters"
            >
              重置所有筛选
            </button>
            <button
              class="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-medium cursor-pointer"
              @click="showSyncModal = true"
            >
              导入/同步借阅记录
            </button>
          </div>
        </div>

        <!-- MODE 1: DEDUPLICATED BY BOOK TITLE (DEFAULT) -->
        <section v-else-if="searchMode === 'local' && autoDedupByTitle" class="space-y-2.5">
          <BorrowBookCard
            v-for="group in visibleAggregatedBooks"
            :key="group.normKey"
            :record="{
              ...group.records[0],
              coverUrl: group.coverUrl || group.records[0].coverUrl,
              callNo: group.callNo || group.records[0].callNo,
              verdict: group.verdict || group.records[0].verdict,
              rating: group.rating || group.records[0].rating,
              tags: group.tags?.length ? group.tags : group.records[0].tags,
              note: group.note || group.records[0].note,
            }"
            :libraries="group.libraries"
            :repeat-count="getRepeatCount(group.title)"
            :set-volume-count="group.totalBorrows"
            :mobile-mode="isMobileLayout"
            :cover-broken="brokenCoverIds.has(group.records[0].id)"
            @select="(r) => (activeRecord = r)"
            @zoom-cover="openFullscreenCover"
            @cover-error="markCoverBroken"
          />
          <div
            v-if="hasMoreLocalItems"
            ref="localLoadMoreSentinel"
            class="pt-2 pb-4 flex justify-center"
          >
            <button
              type="button"
              class="px-5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-teal-50 hover:border-teal-500 text-xs font-semibold text-slate-700 shadow-2xs transition cursor-pointer"
              @click="loadMoreLocalItems"
            >
              已显示 {{ visibleAggregatedBooks.length }} / {{ aggregatedBooks.length }} 本 · 加载更多
            </button>
          </div>
        </section>

        <!-- MODE 2: ALL TIMELINE RECORDS LIST -->
        <section v-else-if="searchMode === 'local'" class="space-y-2.5">
          <BorrowBookCard
            v-for="rec in visibleFilteredRecords"
            :key="rec.id"
            :record="rec"
            :repeat-count="getRepeatCount(rec.title)"
            :mobile-mode="isMobileLayout"
            :cover-broken="brokenCoverIds.has(rec.id)"
            @select="(r) => (activeRecord = r)"
            @zoom-cover="openFullscreenCover"
            @cover-error="markCoverBroken"
          />
          <div
            v-if="hasMoreLocalItems"
            ref="localLoadMoreSentinel"
            class="pt-2 pb-4 flex justify-center"
          >
            <button
              type="button"
              class="px-5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-teal-50 hover:border-teal-500 text-xs font-semibold text-slate-700 shadow-2xs transition cursor-pointer"
              @click="loadMoreLocalItems"
            >
              已显示 {{ visibleFilteredRecords.length }} / {{ filteredRecords.length }} 条 · 加载更多
            </button>
          </div>
        </section>
      </div>
    </div>

    <!-- Modals -->
    <SyncImportModal
      :open="showSyncModal"
      :sync-meta="syncMeta"
      :total-count="records.length"
      :mobile-mode="isMobileLayout"
      @close="showSyncModal = false"
      @imported="handleImported"
      @load-demo="handleLoadDemo"
      @export-json="handleExportJson"
      @export-csv="handleExportCsv"
      @clear-all="handleClearAll"
    />

    <DedupCheckModal
      :open="showDedupModal"
      :records="records"
      :mobile-mode="isMobileLayout"
      @close="showDedupModal = false"
      @zoom-cover="openFullscreenCover"
      @select-record="
        (rec) => {
          showDedupModal = false
          activeRecord = rec
        }
      "
    />

    <RecordDetailDrawer
      :record="activeRecord"
      :same-book-history="sameBookHistoryForActive"
      :mobile-mode="isMobileLayout"
      @close="activeRecord = null"
      @save="handleSaveRecordMeta"
    />

    <!-- Full-Screen Cover Preview Modal from List (Click anywhere on blank area to close) -->
    <div
      v-if="fullscreenCoverRecord"
      class="fixed inset-0 z-[80] bg-slate-950/88 backdrop-blur-xs flex flex-col items-center justify-center p-6 cursor-zoom-out"
      @click="fullscreenCoverRecord = null"
    >
      <div class="relative flex items-center justify-center max-w-full max-h-[80vh]">
        <img
          :src="fullscreenActiveSrc || toThumbnailCoverUrl(fullscreenCoverRecord.coverUrl)"
          :alt="fullscreenCoverRecord.title"
          decoding="sync"
          referrerpolicy="no-referrer"
          class="w-auto h-[72vh] max-w-[88vw] max-h-[80vh] rounded-2xl shadow-2xl object-contain border border-white/15 bg-slate-900 select-none"
        />
      </div>
      <div class="mt-4 text-center space-y-1">
        <div class="text-white font-bold text-sm sm:text-base">
          《{{ fullscreenCoverRecord.title }}》
        </div>
        <div class="text-slate-400 text-xs">点击任意空白位置返回列表</div>
      </div>
    </div>

    <!-- 退出登录确认弹窗 -->
    <div
      v-if="showLogoutConfirm"
      class="fixed inset-0 z-[85] bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4"
      @click="showLogoutConfirm = false"
    >
      <div
        class="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-200 p-5 space-y-3"
        @click.stop
      >
        <div class="flex items-center gap-2 text-base font-bold text-slate-900">
          <LogOut class="w-5 h-5 text-rose-600 shrink-0" />
          <span>确认退出登录</span>
        </div>
        <p class="text-xs sm:text-sm text-slate-600 leading-relaxed">
          退出登录将清除本地存储的所有信息。
        </p>
        <div class="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            class="px-4 py-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-semibold cursor-pointer"
            @click="showLogoutConfirm = false"
          >
            取消
          </button>
          <button
            type="button"
            class="px-4 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold cursor-pointer"
            @click="handleConfirmLogout"
          >
            确认退出
          </button>
        </div>
      </div>
    </div>

    <!-- 移动端地图软件选择底部面板 (兼容 iOS / Android / 微信内浏览器) -->
    <div
      v-if="mobileMapPickerState"
      class="fixed inset-0 z-[90] bg-slate-900/55 backdrop-blur-[1px] flex items-end sm:items-center justify-center p-0 sm:p-4"
      @click="mobileMapPickerState = null"
    >
      <div
        class="w-full max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 p-4 sm:p-5 space-y-3.5"
        @click.stop
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="text-sm sm:text-base font-bold text-slate-900 truncate">
              📍 导航前往：{{ mobileMapPickerState.info.name }}
            </div>
            <div
              v-if="mobileMapPickerState.info.address && mobileMapPickerState.info.address !== '未知地址'"
              class="text-xs text-slate-500 mt-0.5 select-text break-all"
            >
              {{ mobileMapPickerState.info.address }}
            </div>
          </div>
          <button
            type="button"
            class="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer shrink-0"
            @click="mobileMapPickerState = null"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <div class="space-y-2">
          <a
            v-for="opt in mobileMapPickerState.options"
            :key="opt.id"
            :href="opt.url"
            :target="opt.url.startsWith('https://maps.apple.com/') ? '_self' : '_blank'"
            rel="noopener noreferrer"
            class="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-200 hover:border-teal-500 hover:bg-teal-50/50 active:bg-teal-50 transition cursor-pointer select-none"
            @click="handleSelectMapProvider(opt)"
          >
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-bold text-slate-900">{{ opt.name }}</span>
                <span class="px-1.5 py-0.5 rounded-md bg-teal-50 text-teal-700 border border-teal-200 text-[10px] font-semibold">
                  {{ opt.badge }}
                </span>
              </div>
              <div class="text-[11px] text-slate-500 mt-0.5 truncate">
                {{ opt.desc }}
              </div>
            </div>
            <ChevronRight class="w-4 h-4 text-slate-400 shrink-0" />
          </a>
        </div>

        <div class="flex items-center justify-between pt-1 border-t border-slate-100 text-xs">
          <label class="inline-flex items-center gap-1.5 text-slate-600 cursor-pointer select-none">
            <input
              v-model="rememberMapChoice"
              type="checkbox"
              class="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            <span>记住我的选择，下次直接打开</span>
          </label>
          <button
            type="button"
            class="px-3 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium cursor-pointer"
            @click="mobileMapPickerState = null"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
