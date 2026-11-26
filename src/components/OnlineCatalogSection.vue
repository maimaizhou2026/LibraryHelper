<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  Loader2,
  BookOpen,
  MapPin,
  Search,
  ChevronDown,
  ChevronUp,
  Navigation,
  Copy,
  Check,
  X,
} from 'lucide-vue-next'
import type { BorrowRecord, CatalogHoldingItem } from '../types/library'
import {
  normalizeBookTitle,
  parseJsonSafe,
  prefetchHighResCover,
  toThumbnailCoverUrl,
} from '../utils/search'
import {
  getLibraryAddressInfo,
  getLibraryBranchPriority,
  matchesSelectedBranchOption,
  openLibraryLocationInMap,
} from '../utils/mapLink'
import { apiFetch } from '../services/cnCatalogClient'

interface HoldingPanelState {
  expanded: boolean
  loading: boolean
  loaded: boolean
  error: string
  holdings: CatalogHoldingItem[]
  availableCount: number
  isPreviewSummary?: boolean
}

const props = defineProps<{
  keyword: string
  branch: string
  onlyAvailable: boolean
  loading: boolean
  loadingMore?: boolean
  hasMore?: boolean
  searched: boolean
  items: BorrowRecord[]
  zjTotal: number
  hzTotal: number
  mobileMode: boolean
  brokenCovers: Record<string, boolean>
  localRecords: BorrowRecord[]
}>()

const emit = defineEmits<{
  (e: 'search'): void
  (e: 'load-more'): void
  (
    e: 'zoom-cover',
    payload: {
      id?: string
      title: string
      coverUrl: string
      author?: string
      publisher?: string
      isbn?: string
    }
  ): void
  (e: 'cover-error', id: string): void
}>()

const holdingPanels = reactive<Record<string, HoldingPanelState>>({})
const loadMoreSentinel = ref<HTMLElement | null>(null)
let sentinelObserver: IntersectionObserver | null = null

watch(
  () => [props.loading, props.branch] as const,
  ([isLoading], prev) => {
    if (isLoading || (prev && prev[1] !== props.branch)) {
      for (const key of Object.keys(holdingPanels)) {
        delete holdingPanels[key]
      }
    }
  }
)

onMounted(() => {
  if (typeof IntersectionObserver !== 'undefined') {
    sentinelObserver = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          props.hasMore &&
          !props.loading &&
          !props.loadingMore
        ) {
          emit('load-more')
        }
      },
      { rootMargin: '160px' }
    )
    if (loadMoreSentinel.value) {
      sentinelObserver.observe(loadMoreSentinel.value)
    }
  }
})

watch(loadMoreSentinel, (el, oldEl) => {
  if (sentinelObserver) {
    if (oldEl) sentinelObserver.unobserve(oldEl)
    if (el) sentinelObserver.observe(el)
  }
})

onBeforeUnmount(() => {
  if (sentinelObserver) {
    sentinelObserver.disconnect()
    sentinelObserver = null
  }
})

function matchesSelectedBranch(h: CatalogHoldingItem, branch: string): boolean {
  return matchesSelectedBranchOption(h.libName || '', h.location || '', branch)
}

function prioritizeHoldingsForSelectedBranch(
  list: CatalogHoldingItem[],
  library: 'zjlib' | 'hzlib'
): CatalogHoldingItem[] {
  const hasBranchFilter =
    Boolean(props.branch) &&
    props.branch !== 'all' &&
    props.branch !== 'zjlib:all' &&
    props.branch !== 'hzlib:all'
  return [...list].sort((a, b) => {
    if (hasBranchFilter) {
      const aMatch = matchesSelectedBranch(a, props.branch)
      const bMatch = matchesSelectedBranch(b, props.branch)
      if (aMatch !== bMatch) return Number(bMatch) - Number(aMatch)
    }
    if (a.isAvailable !== b.isAvailable) return Number(b.isAvailable) - Number(a.isAvailable)
    if (Boolean(a.isInLibraryReadOnly) !== Boolean(b.isInLibraryReadOnly)) {
      return Number(Boolean(a.isInLibraryReadOnly)) - Number(Boolean(b.isInLibraryReadOnly))
    }
    const pa = getLibraryBranchPriority(library, a.libName || '', a.location || '')
    const pb = getLibraryBranchPriority(library, b.libName || '', b.location || '')
    if (pa !== pb) return pa - pb
    const aKnown =
      getLibraryAddressInfo({ library, libName: a.libName, location: a.location }).address !==
      '未知地址'
    const bKnown =
      getLibraryAddressInfo({ library, libName: b.libName, location: b.location }).address !==
      '未知地址'
    if (aKnown !== bKnown) return Number(bKnown) - Number(aKnown)
    const libCmp = String(a.libName || '').localeCompare(String(b.libName || ''), 'zh-CN')
    if (libCmp !== 0) return libCmp
    if (Boolean(a.navUrl) !== Boolean(b.navUrl)) {
      return Number(Boolean(b.navUrl)) - Number(Boolean(a.navUrl))
    }
    return String(a.location || '').localeCompare(String(b.location || ''), 'zh-CN')
  })
}
const addressPopover = ref<{
  target: { library?: 'zjlib' | 'hzlib'; libName: string; location?: string }
  name: string
  address: string
  copied: boolean
} | null>(null)

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fallback
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

async function showAndCopyAddress(target: {
  library?: 'zjlib' | 'hzlib'
  libName?: string
  location?: string
}) {
  const info = getLibraryAddressInfo(target)
  const copied = await copyTextToClipboard(info.address)
  addressPopover.value = {
    target: {
      library: target.library,
      libName: target.libName || '',
      location: target.location,
    },
    name: info.name,
    address: info.address,
    copied,
  }
}

function getPanelState(id: string): HoldingPanelState | undefined {
  return holdingPanels[id]
}

async function fetchDetailHoldings(book: BorrowRecord, panel: HoldingPanelState) {
  panel.loading = true
  panel.error = ''
  try {
    const resp = await apiFetch('/api/holding/query', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        library: book.library,
        bibId: book.bibId,
        isbn: book.isbn,
        title: book.title,
        callNo: book.callNo,
      }),
    }).then((r) => parseJsonSafe(r))

    if (!resp.ok) {
      panel.error = resp.message || '未能获取到该书实时馆藏信息'
      return
    }
    panel.holdings = prioritizeHoldingsForSelectedBranch(resp.holdings || [], book.library)
    panel.availableCount = resp.availableCount || 0
    panel.isPreviewSummary = false
    panel.loaded = true
  } catch (e: any) {
    panel.error = e?.message || '查询馆藏状态失败'
  } finally {
    panel.loading = false
  }
}

async function toggleHoldingExpand(book: BorrowRecord) {
  let panel = holdingPanels[book.id]
  if (!panel) {
    const preloaded = Array.isArray(book.holdings)
      ? prioritizeHoldingsForSelectedBranch(book.holdings, book.library)
      : []
    const hasPreloaded = preloaded.length > 0
    panel = {
      expanded: false,
      loading: false,
      loaded: hasPreloaded,
      error: '',
      holdings: preloaded,
      availableCount: hasPreloaded
        ? preloaded.reduce(
            (acc, h) =>
              acc + (h.isPreviewSummary ? h.loanableCount || 0 : h.isAvailable ? 1 : 0),
            0
          )
        : 0,
      isPreviewSummary: hasPreloaded && Boolean(preloaded[0]?.isPreviewSummary),
    }
    holdingPanels[book.id] = panel
  }

  if (panel.expanded) {
    panel.expanded = false
    return
  }

  panel.expanded = true
  if (panel.loaded || panel.loading) return

  await fetchDetailHoldings(book, panel)
}

function getBookAddressInfo(book: BorrowRecord) {
  return getLibraryAddressInfo({
    library: book.library,
    libName: book.subLibrary || (book.library === 'zjlib' ? '浙江图书馆' : '杭州图书馆'),
  })
}

const localHistoryByTitle = computed(() => {
  const map = new Map<string, { count: number; isBorrowed: boolean }>()
  for (const r of props.localRecords) {
    const key = normalizeBookTitle(r.title)
    if (!key) continue
    const prev = map.get(key) || { count: 0, isBorrowed: false }
    prev.count += 1
    if (r.status === 'borrowed') prev.isBorrowed = true
    map.set(key, prev)
  }
  return map
})

function getBorrowStatusBadge(book: BorrowRecord) {
  const key = normalizeBookTitle(book.title)
  const match = localHistoryByTitle.value.get(key)
  if (!match) return null
  if (match.isBorrowed) {
    return {
      text: `⏳ 您当前在借（共借过 ${match.count} 次）`,
      cls: 'bg-amber-100 text-amber-800 border-amber-300 font-semibold',
    }
  }
  return {
    text: `🔁 您曾借阅过 ${match.count} 次`,
    cls: 'bg-purple-100 text-purple-800 border-purple-200 font-semibold',
  }
}
</script>

<template>
  <div class="space-y-3">
    <!-- Loading 状态 -->
    <div
      v-if="loading"
      class="bg-white rounded-2xl border border-slate-200 p-10 text-center space-y-2"
    >
      <Loader2 class="w-7 h-7 text-indigo-600 animate-spin mx-auto" />
      <div class="text-sm font-semibold text-slate-700">
        正在实时检索书目并核验各分馆在馆状态...
      </div>
    </div>

    <!-- 未输入关键词引导 -->
    <div
      v-else-if="!keyword.trim()"
      class="bg-white rounded-2xl border border-slate-200 p-8 text-center space-y-2"
    >
      <Search class="w-8 h-8 text-indigo-400 mx-auto" />
      <div class="text-sm font-bold text-slate-700">
        输入书名、作者或 ISBN，直接在线检索浙江图书馆与杭州图书馆全馆藏书
      </div>
      <p class="text-xs text-slate-500">
        支持自动比对您的历史借阅账本（防止重复借书），并可一键查看各馆区在馆状态、百度地图位置与之江馆 3D 书架导航
      </p>
    </div>

    <!-- 无结果 -->
    <div
      v-else-if="searched && items.length === 0"
      class="bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500"
    >
      {{
        onlyAvailable
          ? `未在所选馆区找到当前「在馆可借」的「${keyword}」相关图书（可点击上方关闭“只看有书”查看已借出馆藏）`
          : `未在所选馆区检索到与「${keyword}」相关的馆藏书目`
      }}
    </div>

    <!-- 结果列表 -->
    <div v-else class="grid grid-cols-1 gap-3">
      <div
        v-for="book in items"
        :key="book.id"
        :data-book-id="book.id"
        class="bg-white rounded-2xl border border-slate-200/90 hover:border-teal-500/60 hover:shadow-md transition p-4"
      >
        <!-- 上半区：左侧封面大图 + 右侧核心字段（高度与封面齐平，消除左下角留白） -->
        <div class="flex items-start gap-3.5">
          <!-- 封面 -->
          <div
            class="rounded-xl overflow-hidden shrink-0 border border-slate-200/90 bg-gradient-to-br from-indigo-700 via-teal-800 to-slate-900 flex flex-col items-center justify-center text-white text-center shadow-md select-none"
            :class="[
              mobileMode ? 'w-[100px] h-[138px]' : 'w-24 h-32',
              book.coverUrl && !brokenCovers[book.id] ? 'cursor-zoom-in' : '',
            ]"
            :title="book.coverUrl && !brokenCovers[book.id] ? '点击全屏查看封面' : undefined"
            @mouseenter="book.coverUrl && !brokenCovers[book.id] && prefetchHighResCover(book.coverUrl)"
            @click="
              book.coverUrl &&
              !brokenCovers[book.id] &&
              emit('zoom-cover', {
                id: book.id,
                title: book.title,
                coverUrl: book.coverUrl,
                author: book.author,
                publisher: book.publisher,
                isbn: book.isbn,
              })
            "
          >
            <img
              v-if="book.coverUrl && !brokenCovers[book.id]"
              :src="toThumbnailCoverUrl(book.coverUrl)"
              :alt="book.title"
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              class="w-full h-full object-cover"
              @error="emit('cover-error', book.id)"
            />
            <template v-else>
              <BookOpen class="w-5 h-5 text-teal-300/80 mb-1.5 shrink-0" />
              <span class="text-xs font-bold leading-snug line-clamp-4 px-2">
                {{ book.title }}
              </span>
            </template>
          </div>

          <!-- 右侧书目详细信息（全字段 select-text 可划选复制） -->
          <div class="flex-1 min-w-0 space-y-1.5 select-text">
            <!-- 1. 书名 -->
            <h3 class="text-[15px] sm:text-base font-extrabold text-slate-900 leading-snug line-clamp-2">
              {{ book.title }}
            </h3>

            <!-- 2. 所属图书馆 + 在馆册数 + 本地借阅状态 -->
            <div class="flex flex-wrap items-center gap-1.5">
              <span
                class="px-2 py-0.5 rounded-md text-[11px] font-semibold"
                :class="
                  book.library === 'zjlib'
                    ? 'bg-indigo-50 text-indigo-700 border border-indigo-200/60'
                    : 'bg-teal-50 text-teal-700 border border-teal-200/60'
                "
              >
                {{ book.library === 'zjlib' ? '🏛️ 浙江图书馆' : '📚 杭州图书馆' }}
                <template v-if="book.subLibrary"> · {{ book.subLibrary }}</template>
              </span>

              <span
                v-if="(book.availableCount || 0) > 0"
                class="px-2 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-800 border border-emerald-300 font-semibold whitespace-nowrap"
              >
                在馆 {{ book.availableCount }}/{{ book.totalHoldings || book.availableCount }} 册
              </span>
              <span
                v-else-if="(book.totalHoldings || 0) > 0"
                class="px-2 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-500 border border-slate-200 whitespace-nowrap"
              >
                馆藏 {{ book.totalHoldings }} 册均借出
              </span>

              <span
                v-if="getBorrowStatusBadge(book)"
                class="px-2 py-0.5 rounded-full text-[11px] border whitespace-nowrap"
                :class="getBorrowStatusBadge(book)!.cls"
              >
                {{ getBorrowStatusBadge(book)!.text }}
              </span>
              <span
                v-else
                class="px-2 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-600 border border-slate-200 whitespace-nowrap"
              >
                未借阅过
              </span>
            </div>

            <!-- 核心字段：索书号 + 著者 -->
            <div class="pt-0.5 space-y-1 text-[12px] leading-relaxed">
              <div class="flex items-baseline gap-2">
                <span class="text-slate-500 shrink-0 w-11">索书号</span>
                <span class="font-mono text-teal-700 font-medium break-all">
                  {{ book.callNo || '—' }}
                </span>
              </div>

              <div class="flex items-baseline gap-2">
                <span class="text-slate-500 shrink-0 w-11">著　者</span>
                <span class="text-slate-700 line-clamp-2 break-words">{{ book.author || '未知' }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 中部全宽精简信息条：地址 + 出版社/ISBN（充分利用整行宽度，支持划选复制） -->
        <div class="mt-2.5 pt-2 border-t border-slate-100 space-y-1 text-[12px] leading-relaxed select-text">
          <div class="flex items-baseline gap-1.5 flex-wrap">
            <span class="text-slate-500 shrink-0">地址：</span>
            <span class="text-slate-700 break-all">{{ getBookAddressInfo(book).address }}</span>
            <button
              type="button"
              class="inline-flex items-center gap-0.5 text-teal-700 hover:text-teal-900 hover:underline font-medium cursor-pointer select-none"
              @click="
                openLibraryLocationInMap(
                  { library: book.library, libName: book.subLibrary },
                  mobileMode
                )
              "
            >
              <Navigation class="w-3 h-3" />
              地图
            </button>
            <button
              v-if="getBookAddressInfo(book).address !== '未知地址'"
              type="button"
              class="inline-flex items-center gap-0.5 text-indigo-700 hover:text-indigo-900 hover:underline font-medium cursor-pointer select-none"
              @click="
                showAndCopyAddress({
                  library: book.library,
                  libName: book.subLibrary,
                })
              "
            >
              <Copy class="w-3 h-3" />
              地址
            </button>
          </div>

          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-slate-600">
            <span>
              <span class="text-slate-500">出版：</span>
              {{ book.publisher || '—' }}{{ book.pubDate ? ` (${book.pubDate})` : '' }}
            </span>
            <span v-if="book.isbn">
              <span class="text-slate-500">ISBN：</span>
              <span class="font-mono">{{ book.isbn }}</span>
            </span>
          </div>
        </div>

        <!-- 下半区：底部触发栏（默认收缩隐藏各分馆状态，点击在下方展开） -->
        <div class="mt-3">
          <button
            type="button"
            class="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 hover:bg-teal-50/80 border border-slate-200/80 hover:border-teal-300 flex items-center justify-between gap-2 text-xs font-semibold text-teal-700 transition cursor-pointer select-none"
            @click="toggleHoldingExpand(book)"
          >
            <span class="inline-flex items-center gap-1.5">
              <MapPin class="w-3.5 h-3.5 shrink-0" />
              查看各分馆在馆状态 / 地图位置 / 3D书架导航
            </span>
            <span class="inline-flex items-center gap-1 text-[11px] text-slate-500 shrink-0">
              <Loader2 v-if="getPanelState(book.id)?.loading" class="w-3.5 h-3.5 animate-spin text-teal-600" />
              <ChevronUp v-else-if="getPanelState(book.id)?.expanded" class="w-4 h-4 text-teal-600" />
              <ChevronDown v-else class="w-4 h-4 text-slate-400" />
            </span>
          </button>

          <!-- 展开后的内联各分馆实时馆藏列表 -->
          <div v-if="getPanelState(book.id)?.expanded" class="mt-2 select-text">
            <div
              v-if="getPanelState(book.id)?.loading"
              class="p-4 rounded-xl border border-slate-200 bg-slate-50 text-center text-xs text-slate-500 flex items-center justify-center gap-2"
            >
              <Loader2 class="w-4 h-4 animate-spin text-teal-600" />
              正在查询各分馆实时馆藏状态与架位...
            </div>

            <div
              v-else-if="getPanelState(book.id)?.error"
              class="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700"
            >
              {{ getPanelState(book.id)?.error }}
            </div>

            <div
              v-else-if="getPanelState(book.id)?.loaded"
              class="rounded-xl border border-teal-200 bg-teal-50/40 overflow-hidden text-xs"
            >
              <div class="px-3.5 py-2 bg-teal-100/70 border-b border-teal-200 flex items-center justify-between gap-2 flex-wrap">
                <span class="font-bold text-teal-950">
                  📍 实时馆藏明细（共
                  {{
                    getPanelState(book.id)!.isPreviewSummary
                      ? book.totalHoldings || getPanelState(book.id)!.holdings.length
                      : getPanelState(book.id)!.holdings.length
                  }}
                  册，当前在馆
                  <span class="text-emerald-700 font-extrabold">
                    {{ getPanelState(book.id)!.availableCount }}
                  </span>
                  册）
                </span>
                <div class="flex items-center gap-2">
                  <button
                    v-if="getPanelState(book.id)!.isPreviewSummary"
                    type="button"
                    class="px-2 py-0.5 rounded-md bg-white hover:bg-teal-600 text-teal-700 hover:text-white border border-teal-300 text-[11px] font-semibold transition cursor-pointer select-none"
                    @click="fetchDetailHoldings(book, getPanelState(book.id)!)"
                  >
                    加载已借阅图书应还时间
                  </button>
                  <span class="text-[11px] text-teal-700">总馆与在馆优先</span>
                </div>
              </div>

              <div
                v-if="getPanelState(book.id)!.holdings.length === 0"
                class="p-4 text-center text-slate-500 bg-white"
              >
                暂未查询到该书的实时馆藏架位记录（可能是悦读直送或线上书库书目）
              </div>

              <div v-else class="max-h-72 overflow-y-auto divide-y divide-slate-200/70 bg-white">
                <div
                  v-for="(h, idx) in getPanelState(book.id)!.holdings"
                  :key="idx"
                  class="px-3.5 py-2.5 flex items-start justify-between gap-2.5 hover:bg-slate-50"
                >
                  <div class="space-y-1 min-w-0 flex-1">
                    <div class="font-semibold text-slate-800 flex items-center gap-1.5 flex-wrap">
                      <span>{{ h.libName }}</span>
                      <span v-if="h.location && h.location !== h.libName" class="text-teal-700">
                        · {{ h.location }}
                      </span>
                      <button
                        type="button"
                        class="inline-flex items-center gap-0.5 text-[11px] text-teal-700 hover:text-teal-900 hover:underline font-medium cursor-pointer select-none"
                        :title="`点击在${mobileMode ? '地图软件' : '百度地图'}定位：${getLibraryAddressInfo(h).name}（${getLibraryAddressInfo(h).address}）`"
                        @click="openLibraryLocationInMap(h, mobileMode)"
                      >
                        <Navigation class="w-3 h-3" />
                        地图
                      </button>
                      <button
                        v-if="getLibraryAddressInfo({ library: book.library, libName: h.libName, location: h.location }).address !== '未知地址'"
                        type="button"
                        class="inline-flex items-center gap-0.5 text-[11px] text-indigo-700 hover:text-indigo-900 hover:underline font-medium cursor-pointer select-none"
                        title="查看详细地址并自动复制到剪贴板"
                        @click="showAndCopyAddress({ library: book.library, libName: h.libName, location: h.location })"
                      >
                        <Copy class="w-3 h-3" />
                        地址
                      </button>
                      <span
                        v-if="h.docType"
                        class="px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 text-[10px] font-normal"
                      >
                        {{ h.docType }}
                      </span>
                      <span v-if="h.orgLibName" class="text-[11px] text-slate-400 font-normal">
                        (所属馆：{{ h.orgLibName }})
                      </span>
                    </div>

                    <div v-if="h.shelfNo" class="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span
                        class="font-medium font-mono"
                        :class="
                          h.navUrl
                            ? 'text-indigo-700 font-semibold font-sans'
                            : h.shelfNo.includes('闭架')
                              ? 'text-amber-700 font-sans'
                              : 'text-slate-700'
                        "
                      >
                        {{ h.shelfNo.includes('闭架') ? `📦 ${h.shelfNo}` : `📍 位置: ${h.shelfNo}` }}
                      </span>
                      <a
                        v-if="h.navUrl"
                        :href="h.navUrl"
                        target="_blank"
                        rel="noopener"
                        class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold shadow-2xs transition select-none"
                      >
                        <MapPin class="w-3 h-3" />
                        3D书架导航
                      </a>
                    </div>

                    <div class="text-[11px] text-slate-500 font-mono flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span
                        v-if="
                          (h.callNo || book.callNo) &&
                          (!h.shelfNo || !h.shelfNo.includes(h.callNo || book.callNo || ''))
                        "
                      >
                        索书号：{{ h.callNo || book.callNo }} ·
                      </span>
                      <span v-if="h.barcode">条码：{{ h.barcode }}</span>
                      <span v-if="h.volInfo">· 卷册：{{ h.volInfo }}</span>
                      <span v-if="h.dueDate" class="text-amber-700 font-sans">· 应还：{{ h.dueDate }}</span>
                    </div>
                  </div>

                  <div class="flex items-center gap-1.5 shrink-0 pt-0.5 select-none">
                    <span
                      class="px-2 py-0.5 rounded-full text-[11px] font-semibold shrink-0 whitespace-nowrap"
                      :class="
                        h.isInLibraryReadOnly
                          ? 'bg-amber-100 text-amber-800'
                          : h.isAvailable
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-slate-100 text-slate-500'
                      "
                    >
                      {{ h.stateName || (h.isAvailable ? '在馆' : '已借出') }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 滚动触底自动加载下一页 / 手动加载更多 -->
      <div ref="loadMoreSentinel" class="pt-1 pb-3 text-center">
        <div
          v-if="loadingMore"
          class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-slate-200 text-xs text-slate-600 shadow-2xs"
        >
          <Loader2 class="w-3.5 h-3.5 animate-spin text-indigo-600" />
          正在加载更多馆藏书目...
        </div>
        <button
          v-else-if="hasMore"
          type="button"
          class="px-4 py-2 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-xs font-semibold text-indigo-700 transition cursor-pointer shadow-2xs"
          @click="emit('load-more')"
        >
          加载更多书目
        </button>
        <span v-else-if="items.length > 0" class="text-[11px] text-slate-400">
          已加载当前全部检索结果
        </span>
      </div>
    </div>

    <!-- 图书馆详细地址浮层 + 自动复制提示 -->
    <div
      v-if="addressPopover"
      class="fixed inset-0 z-50 bg-slate-900/35 backdrop-blur-[1px] flex items-center justify-center p-4"
      @click="addressPopover = null"
    >
      <div
        class="w-full max-w-sm bg-white rounded-2xl shadow-xl border border-slate-200 p-4 space-y-2.5"
        @click.stop
      >
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-1.5 text-sm font-bold text-slate-900">
            <MapPin class="w-4 h-4 text-teal-600 shrink-0" />
            <span>{{ addressPopover.name }}</span>
          </div>
          <button
            type="button"
            class="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer"
            @click="addressPopover = null"
          >
            <X class="w-4 h-4" />
          </button>
        </div>
        <p class="text-xs text-slate-700 bg-slate-50 rounded-xl p-3 border border-slate-200/80 select-text break-all leading-relaxed">
          {{ addressPopover.address }}
        </p>
        <div class="flex items-center justify-between text-xs pt-0.5">
          <span
            v-if="addressPopover.copied"
            class="inline-flex items-center gap-1 text-emerald-700 font-semibold"
          >
            <Check class="w-3.5 h-3.5" />
            已自动复制到剪贴板
          </span>
          <span v-else class="text-slate-500">请长按或划选上方地址复制</span>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg border border-teal-200 bg-teal-50 hover:bg-teal-100 text-teal-700 font-semibold cursor-pointer"
              @click="
                const t = addressPopover.target;
                addressPopover = null;
                openLibraryLocationInMap(t, true, true);
              "
            >
              切换地图打开
            </button>
            <button
              type="button"
              class="px-3 py-1 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-semibold cursor-pointer"
              @click="addressPopover = null"
            >
              知道了
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
