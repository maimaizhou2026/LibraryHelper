<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import {
  X,
  Star,
  MapPin,
  Tag,
  BookOpen,
  Calendar,
  Hash,
  ZoomIn,
  Building2,
  Loader2,
  ShieldCheck,
  CornerDownRight,
  CornerUpLeft,
  RefreshCw,
  Navigation,
} from 'lucide-vue-next'
import type { BorrowRecord, VerdictType } from '../types/library'
import {
  explainCallNo,
  getDaysRemaining,
  getEffectiveRenewCount,
  getMaxRenewLimit,
} from '../utils/search'
import { getLibraryAddressInfo, openLibraryLocationInMap } from '../utils/mapLink'

const props = defineProps<{
  record: BorrowRecord | null
  sameBookHistory: BorrowRecord[]
  mobileMode?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (
    e: 'save',
    id: string,
    patch: Partial<
      Pick<
        BorrowRecord,
        'rating' | 'verdict' | 'tags' | 'note' | 'progress' | 'status' | 'returnDate' | 'dueDate' | 'renewCount'
      >
    >
  ): void
}>()

const rating = ref(0)
const verdict = ref<VerdictType>('')
const tags = ref<string[]>([])
const newTagInput = ref('')
const note = ref('')
const progress = ref(0)
const status = ref<'borrowed' | 'returned'>('returned')

const presetTags = ['睡前绘本', '科幻', '历史', '二刷', '踩雷']

const verdictOptions: Array<{ value: VerdictType; label: string; activeCls: string }> = [
  { value: 'worth_reborrow', label: '👍 值得重借', activeCls: 'bg-emerald-600 text-white border-emerald-600' },
  { value: 'liked', label: '❤️ 推荐喜欢', activeCls: 'bg-teal-600 text-white border-teal-600' },
  { value: 'unfinished', label: '🔖 未读完下次再借', activeCls: 'bg-amber-500 text-white border-amber-500' },
  { value: 'disliked', label: '💣 踩雷别再借', activeCls: 'bg-rose-600 text-white border-rose-600' },
]

const imgLoadFailed = ref(false)
const showFullCover = ref(false)

interface HoldingItem {
  isAvailable: boolean
  isInLibraryReadOnly?: boolean
  stateName: string
  libName: string
  orgLibName?: string
  location: string
  docType?: string
  callNo: string
  barcode: string
  shelfNo: string
  dueDate?: string
  volInfo?: string
  rawShelfMark?: string
  navUrl?: string
}
const holdingLoading = ref(false)
const holdingLoaded = ref(false)
const holdingError = ref('')
const holdingList = ref<HoldingItem[]>([])
const holdingAvailableCount = ref(0)

// 在线续借状态
const renewLoading = ref(false)
const renewFeedback = ref<{ type: 'success' | 'error'; text: string } | null>(null)
const renewNeedCaptcha = ref(false)
const renewCaptchaImage = ref('')
const renewCaptchaCode = ref('')
const renewCaptchaCookie = ref('')
const renewCaptchaPem = ref('')

const currentRenewCount = computed(() =>
  props.record ? getEffectiveRenewCount(props.record) : 0
)
const maxRenewLimit = computed(() =>
  props.record ? getMaxRenewLimit(props.record) : 1
)
const isRenewMaxed = computed(() => currentRenewCount.value >= maxRenewLimit.value)

const isOnlineBook = computed(() =>
  Boolean(props.record?.isOnlineCatalog || props.record?.id?.startsWith('catalog:'))
)
const isUnborrowedOnlineBook = computed(
  () => isOnlineBook.value && props.sameBookHistory.length === 0
)
const effectiveRecordForMeta = computed(() =>
  isOnlineBook.value && props.sameBookHistory.length > 0 ? props.sameBookHistory[0] : props.record
)

watch(
  () => props.record,
  (rec, oldRec) => {
    if (!rec) return
    const isNewBook = rec.id !== oldRec?.id
    if (isNewBook) {
      imgLoadFailed.value = false
      showFullCover.value = false
      holdingLoading.value = false
      holdingLoaded.value = false
      holdingError.value = ''
      holdingList.value = []
      holdingAvailableCount.value = 0
      renewLoading.value = false
      renewFeedback.value = null
      renewNeedCaptcha.value = false
      renewCaptchaCode.value = ''
      if (rec.id.startsWith('catalog:')) {
        void fetchLiveHoldingStatus()
      }
    }
    const sourceRec =
      (rec.isOnlineCatalog || rec.id.startsWith('catalog:')) && props.sameBookHistory.length > 0
        ? props.sameBookHistory[0]
        : rec
    rating.value = sourceRec.rating || 0
    verdict.value = sourceRec.verdict || ''
    tags.value = [...(sourceRec.tags || [])]
    note.value = sourceRec.note || ''
    progress.value = sourceRec.progress ?? (sourceRec.status === 'returned' ? 100 : 20)
    status.value = sourceRec.status
  },
  { immediate: true }
)

const displayCallNo = computed(
  () => props.record?.callNo || holdingList.value.find((h) => h.callNo)?.callNo || ''
)
const callNoExplain = computed(() => (displayCallNo.value ? explainCallNo(displayCallNo.value) : ''))

const daysLeft = computed(() =>
  props.record?.status === 'borrowed' && props.record.dueDate ? getDaysRemaining(props.record.dueDate) : null
)

async function fetchLiveHoldingStatus() {
  const rec = props.record
  if (!rec) return
  if (holdingLoaded.value) {
    holdingLoaded.value = false
    return
  }
  holdingLoading.value = true
  holdingError.value = ''
  try {
    const resp = await fetch('/api/holding/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        library: rec.library,
        bibId: rec.bibId,
        isbn: rec.isbn,
        title: rec.title,
        callNo: rec.callNo,
      }),
    }).then((r) => r.json())

    if (!resp.ok) {
      holdingError.value = resp.message || '未能获取到该书实时馆藏信息'
      return
    }
    holdingList.value = resp.holdings || []
    holdingAvailableCount.value = resp.availableCount || 0
    holdingLoaded.value = true
  } catch (e: any) {
    holdingError.value = e?.message || '查询馆藏状态失败'
  } finally {
    holdingLoading.value = false
  }
}

async function handleOnlineRenew() {
  const rec = props.record
  if (!rec) return
  if (renewNeedCaptcha.value && !renewCaptchaCode.value.trim()) {
    renewFeedback.value = { type: 'error', text: '请输入 4 位图形验证码后再点击续借' }
    return
  }

  renewLoading.value = true
  renewFeedback.value = null
  try {
    let account = ''
    let password = ''
    let token = ''
    if (rec.library === 'zjlib') {
      token = localStorage.getItem('lh_zjlib_token') || ''
      const rawZj = localStorage.getItem('lh_zjlib_cred')
      if (rawZj) {
        const parsed = JSON.parse(rawZj)
        account = parsed.account || ''
        password = parsed.password || ''
      }
    } else {
      const rawHz = localStorage.getItem('lh_hzlib_cred')
      if (rawHz) {
        const parsed = JSON.parse(rawHz)
        account = parsed.account || ''
        password = parsed.password || ''
      }
    }

    const resp = await fetch('/api/loan/renew', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        library: rec.library,
        barcode: rec.barcode,
        token,
        account,
        password,
        captchaCode: renewNeedCaptcha.value ? renewCaptchaCode.value.trim() : '',
        captchaSessionCookie: renewNeedCaptcha.value ? renewCaptchaCookie.value : '',
        captchaPemKey: renewNeedCaptcha.value ? renewCaptchaPem.value : '',
      }),
    }).then((r) => r.json())

    if (resp.token) {
      localStorage.setItem('lh_zjlib_token', resp.token)
    }

    if (resp.needCaptcha && resp.captchaImage) {
      renewNeedCaptcha.value = true
      renewCaptchaImage.value = resp.captchaImage
      renewCaptchaCookie.value = resp.sessionCookie || ''
      renewCaptchaPem.value = resp.pemKey || ''
      renewCaptchaCode.value = ''
      renewFeedback.value = { type: 'error', text: resp.message || '请输入图形验证码后重试' }
      return
    }

    renewNeedCaptcha.value = false
    if (resp.ok) {
      renewFeedback.value = { type: 'success', text: resp.message || '在线续借成功！' }
      emit('save', rec.id, {
        dueDate: resp.dueDate || rec.dueDate,
        renewCount: resp.renewCount ?? 1,
      })
    } else {
      renewFeedback.value = { type: 'error', text: resp.message || '续借未成功' }
      if (
        (resp.dueDate && resp.dueDate !== rec.dueDate) ||
        (typeof resp.renewCount === 'number' && resp.renewCount !== rec.renewCount)
      ) {
        emit('save', rec.id, {
          dueDate: resp.dueDate || rec.dueDate,
          renewCount: typeof resp.renewCount === 'number' ? resp.renewCount : rec.renewCount,
        })
      }
    }
  } catch (e: any) {
    renewFeedback.value = { type: 'error', text: e?.message || '在线续借请求失败' }
  } finally {
    renewLoading.value = false
  }
}

function toggleTag(t: string) {
  if (tags.value.includes(t)) {
    tags.value = tags.value.filter((x) => x !== t)
  } else {
    tags.value.push(t)
  }
  triggerSave()
}

function addCustomTag() {
  const clean = newTagInput.value.trim().replace(/^#/, '')
  if (!clean) return
  if (!tags.value.includes(clean)) {
    tags.value.push(clean)
    triggerSave()
  }
  newTagInput.value = ''
}

function toggleVerdict(v: VerdictType) {
  verdict.value = verdict.value === v ? '' : v
  triggerSave()
}

function setRating(r: number) {
  rating.value = rating.value === r ? 0 : r
  triggerSave()
}

function triggerSave() {
  if (!props.record || isUnborrowedOnlineBook.value) return
  const targetId = effectiveRecordForMeta.value?.id || props.record.id
  emit('save', targetId, {
    rating: rating.value,
    verdict: verdict.value,
    tags: [...tags.value],
    note: note.value,
    progress: progress.value,
    status: status.value,
  })
}

function handleClose() {
  triggerSave()
  emit('close')
}
</script>

<template>
  <div
    v-if="record"
    class="fixed inset-0 z-50 flex justify-center bg-slate-900/60 backdrop-blur-xs"
    :class="mobileMode ? 'items-end p-0' : 'items-end sm:items-center p-0 sm:p-4'"
    @click.self="handleClose"
  >
    <div
      class="w-full bg-white shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col overflow-hidden"
      :class="mobileMode ? 'max-w-[420px] rounded-t-3xl' : 'max-w-xl rounded-t-2xl sm:rounded-2xl'"
    >
      <!-- ==================== 移动端专属头部与信息环绕版式 ==================== -->
      <div v-if="mobileMode" class="p-4 border-b border-slate-100 bg-white space-y-3">
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-start gap-3.5 min-w-0 flex-1">
            <!-- 左侧大封面 -->
            <div
              class="w-[104px] h-[142px] rounded-xl overflow-hidden shrink-0 border border-slate-200 shadow-md bg-gradient-to-br from-teal-700 to-slate-800 flex items-center justify-center text-white relative group cursor-zoom-in"
              title="点击查看全屏大图"
              @click="record.coverUrl && !imgLoadFailed ? (showFullCover = true) : null"
            >
              <img
                v-if="record.coverUrl && !imgLoadFailed"
                :src="record.coverUrl"
                :alt="record.title"
                referrerpolicy="no-referrer"
                class="w-full h-full object-cover"
                @error="imgLoadFailed = true"
              />
              <span v-else class="text-xs font-bold leading-tight line-clamp-5 p-2 text-center">
                {{ record.title }}
              </span>
              <div
                v-if="record.coverUrl && !imgLoadFailed"
                class="absolute inset-x-0 bottom-0 bg-slate-900/65 text-white text-[10px] py-1 flex items-center justify-center gap-1"
              >
                <ZoomIn class="w-3 h-3" />
                <span>点击放大</span>
              </div>
            </div>

            <!-- 右侧结构化字段环绕 -->
            <div class="flex-1 min-w-0 space-y-1">
              <h3 class="text-[16px] font-extrabold text-slate-900 leading-snug">
                {{ record.title }}
              </h3>
              <p class="text-[12px] text-slate-500 truncate">{{ record.author || '未知著者' }}</p>

              <div class="pt-1 space-y-1 text-[12px]">
                <div class="flex items-baseline gap-2">
                  <span class="text-slate-400 shrink-0">所属馆</span>
                  <span
                    class="font-semibold truncate"
                    :class="record.library === 'zjlib' ? 'text-indigo-700' : 'text-teal-700'"
                  >
                    {{ record.library === 'zjlib' ? '浙图' : '杭图' }} · {{ record.subLibrary }}
                  </span>
                </div>
                <div class="flex items-baseline gap-2">
                  <span class="text-slate-400 shrink-0">条码号</span>
                  <span class="font-mono text-slate-700 truncate">{{ record.barcode || '—' }}</span>
                </div>
                <div class="flex items-baseline gap-2">
                  <span class="text-slate-400 shrink-0">索书号</span>
                  <span class="font-mono text-slate-700 truncate">{{ displayCallNo || '—' }}</span>
                </div>
                <div v-if="record.isbn" class="flex items-baseline gap-2">
                  <span class="text-slate-400 shrink-0">ISBN号</span>
                  <span class="font-mono text-slate-600 truncate">{{ record.isbn }}</span>
                </div>
                <div class="flex items-baseline gap-2">
                  <span class="text-slate-400 shrink-0">状　态</span>
                  <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0">
                    <span
                      v-if="isUnborrowedOnlineBook"
                      class="font-bold shrink-0 whitespace-nowrap text-slate-500"
                    >
                      未借阅过
                    </span>
                    <span
                      v-else
                      class="font-bold shrink-0 whitespace-nowrap"
                      :class="status === 'borrowed' ? 'text-amber-600' : 'text-emerald-600'"
                    >
                      {{ status === 'borrowed' ? '在借中' : '已归还' }}
                    </span>
                    <span
                      v-if="!isUnborrowedOnlineBook && status === 'borrowed'"
                      class="px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0 whitespace-nowrap"
                      :class="
                        currentRenewCount > 0
                          ? 'bg-sky-50 text-sky-700 border border-sky-200'
                          : 'bg-slate-100 text-slate-600'
                      "
                    >
                      续借 {{ currentRenewCount }}/{{ maxRenewLimit }} 次
                    </span>
                    <span v-if="callNoExplain" class="text-[11px] text-teal-700 break-words">
                      · {{ callNoExplain }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <button
            class="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 transition cursor-pointer shrink-0"
            @click="handleClose"
          >
            <X class="w-5 h-5" />
          </button>
        </div>

        <!-- 移动端浅灰圆角时间框（未借阅过的在线书目隐藏） -->
        <div
          v-if="!isUnborrowedOnlineBook"
          class="bg-slate-50 rounded-2xl px-3.5 py-2.5 flex items-center justify-between border border-slate-100 text-xs"
        >
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <CornerDownRight class="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <span class="text-slate-600 font-medium">借阅时间</span>
              <span class="text-slate-700 font-mono">{{ effectiveRecordForMeta?.loanDate || '—' }}</span>
            </div>
            <div class="flex items-center gap-2">
              <CornerUpLeft class="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <template v-if="status === 'borrowed'">
                <span class="text-slate-600 font-medium">应还时间</span>
                <span class="text-amber-700 font-mono font-semibold">
                  {{ effectiveRecordForMeta?.dueDate || '—' }}
                  <template v-if="daysLeft !== null">
                    ({{ daysLeft >= 0 ? `剩${daysLeft}天` : `超期${Math.abs(daysLeft)}天` }})
                  </template>
                </span>
              </template>
              <template v-else>
                <span class="text-slate-600 font-medium">归还时间</span>
                <span class="text-slate-700 font-mono">{{ effectiveRecordForMeta?.returnDate || '已还' }}</span>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- ==================== PC 端宽屏头部版式 ==================== -->
      <div
        v-else
        class="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-3 bg-slate-50"
      >
        <div class="flex items-start gap-4 min-w-0">
          <!-- Larger Book Cover Thumbnail (Click to open full-screen lightbox) -->
          <div
            class="w-24 h-34 sm:w-28 sm:h-40 rounded-xl overflow-hidden shrink-0 border border-slate-200 shadow-sm bg-gradient-to-br from-teal-700 to-slate-800 flex items-center justify-center text-white relative group cursor-zoom-in"
            title="点击查看全屏大图"
            @click="record.coverUrl && !imgLoadFailed ? (showFullCover = true) : null"
          >
            <img
              v-if="record.coverUrl && !imgLoadFailed"
              :src="record.coverUrl"
              :alt="record.title"
              referrerpolicy="no-referrer"
              class="w-full h-full object-cover transition group-hover:scale-105"
              @error="imgLoadFailed = true"
            />
            <span v-else class="text-xs font-bold leading-tight line-clamp-5 p-2 text-center">
              {{ record.title }}
            </span>
            <div
              v-if="record.coverUrl && !imgLoadFailed"
              class="absolute inset-x-0 bottom-0 bg-slate-900/65 text-white text-[10px] py-1 flex items-center justify-center gap-1 opacity-90 group-hover:opacity-100 transition"
            >
              <ZoomIn class="w-3 h-3" />
              <span>点击放大</span>
            </div>
          </div>

          <div class="space-y-1.5 min-w-0 pt-0.5">
            <div class="flex flex-wrap items-center gap-1.5">
              <span
                class="px-2 py-0.5 rounded-md text-xs font-semibold"
                :class="
                  record.library === 'zjlib'
                    ? 'bg-indigo-100 text-indigo-800'
                    : 'bg-teal-100 text-teal-800'
                "
              >
                {{ record.library === 'zjlib' ? '🏛️ 浙江图书馆' : '📚 杭州图书馆' }}
              </span>
              <span class="text-xs text-slate-500">{{ record.subLibrary }}</span>
              <span
                v-if="isUnborrowedOnlineBook"
                class="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-200/80 text-slate-600"
              >
                未借阅过
              </span>
              <span
                v-else
                class="px-2 py-0.5 rounded-full text-xs font-medium"
                :class="
                  status === 'borrowed'
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-emerald-100 text-emerald-800'
                "
              >
                {{ status === 'borrowed' ? '⏳ 当前在借' : '✅ 已归还' }}
              </span>
            </div>
            <h3 class="text-base sm:text-lg font-bold text-slate-900">《{{ record.title }}》</h3>
            <p class="text-xs text-slate-600">{{ record.author || '未知著者' }}</p>
          </div>
        </div>
        <button
          class="p-1.5 rounded-lg hover:bg-slate-200 text-slate-500 transition cursor-pointer"
          @click="handleClose"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <!-- Body -->
      <div :class="mobileMode ? 'p-4 overflow-y-auto space-y-4 flex-1' : 'p-5 overflow-y-auto space-y-5 flex-1'">
        <!-- PC 端 Metadata Grid (移动端已在顶部环绕展示) -->
        <div
          v-if="!mobileMode"
          class="grid grid-cols-3 gap-2.5 bg-slate-50 p-3.5 rounded-xl border border-slate-200/80 text-xs"
        >
          <template v-if="!isUnborrowedOnlineBook">
            <div>
              <div class="text-slate-400 flex items-center gap-1">
                <Calendar class="w-3.5 h-3.5" /> 借出日期
              </div>
              <div class="font-semibold text-slate-800 mt-0.5">{{ effectiveRecordForMeta?.loanDate || '—' }}</div>
            </div>
            <div v-if="status === 'borrowed'">
              <div class="text-slate-400">应还日期</div>
              <div class="font-semibold text-amber-700 mt-0.5">
                {{ effectiveRecordForMeta?.dueDate || '—' }}
                <span v-if="daysLeft !== null" class="text-[11px]">
                  ({{ daysLeft >= 0 ? `剩 ${daysLeft} 天` : `已超期 ${Math.abs(daysLeft)} 天` }})
                </span>
              </div>
            </div>
            <div v-else>
              <div class="text-slate-400">归还日期</div>
              <div class="font-semibold text-slate-800 mt-0.5">{{ effectiveRecordForMeta?.returnDate || '已还' }}</div>
            </div>
          </template>
          <div>
            <div class="text-slate-400 flex items-center gap-1">
              <BookOpen class="w-3.5 h-3.5" /> 索书号
            </div>
            <div class="font-mono font-semibold text-slate-800 mt-0.5">{{ displayCallNo || '—' }}</div>
          </div>
          <div>
            <div class="text-slate-400 flex items-center gap-1">
              <Hash class="w-3.5 h-3.5" /> ISBN
            </div>
            <div class="font-mono text-slate-700 mt-0.5">{{ record.isbn || '—' }}</div>
          </div>
          <div v-if="!isUnborrowedOnlineBook">
            <div class="text-slate-400">图书条码号</div>
            <div class="font-mono text-slate-700 mt-0.5">{{ record.barcode || '—' }}</div>
          </div>
          <div v-if="!isUnborrowedOnlineBook && status === 'borrowed'">
            <div class="text-slate-400">当前续借次数</div>
            <div class="font-semibold text-sky-700 mt-0.5">
              已续借 {{ currentRenewCount }} / {{ maxRenewLimit }} 次
            </div>
          </div>
          <div v-if="callNoExplain">
            <div class="text-slate-400">中图法架位解读</div>
            <div class="text-teal-700 font-medium mt-0.5">{{ callNoExplain }}</div>
          </div>
        </div>

        <!-- Quick External Links -->
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="px-3.5 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold flex items-center gap-1.5 shadow-2xs transition cursor-pointer"
            @click="fetchLiveHoldingStatus"
          >
            <Loader2 v-if="holdingLoading" class="w-3.5 h-3.5 animate-spin" />
            <Building2 v-else class="w-3.5 h-3.5" />
            {{ holdingLoaded ? '收起馆藏状态' : '查看馆藏状态' }}
          </button>
          <button
            v-if="!isUnborrowedOnlineBook && status === 'borrowed'"
            type="button"
            :disabled="renewLoading || isRenewMaxed"
            class="px-3.5 py-2 rounded-xl text-white text-xs font-semibold flex items-center gap-1.5 shadow-2xs transition"
            :class="
              isRenewMaxed
                ? 'bg-slate-300 text-slate-600 cursor-not-allowed'
                : 'bg-amber-500 hover:bg-amber-600 cursor-pointer disabled:opacity-50'
            "
            @click="handleOnlineRenew"
          >
            <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': renewLoading }" />
            {{
              renewLoading
                ? '正在续借...'
                : isRenewMaxed
                  ? `已达续借上限 (${currentRenewCount}/${maxRenewLimit})`
                  : `在线续借 (${currentRenewCount}/${maxRenewLimit})`
            }}
          </button>
        </div>

        <!-- 在线续借验证码与结果反馈面板 -->
        <div
          v-if="renewNeedCaptcha"
          class="p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-between gap-2.5"
        >
          <img
            v-if="renewCaptchaImage"
            :src="renewCaptchaImage"
            alt="验证码"
            class="h-8 w-20 rounded border border-amber-300 bg-white object-contain shrink-0"
          />
          <input
            v-model="renewCaptchaCode"
            type="text"
            maxlength="4"
            placeholder="输入4位验证码"
            class="flex-1 px-2.5 py-1.5 rounded-lg border border-amber-400 bg-white text-xs focus:outline-none"
            @keyup.enter="handleOnlineRenew"
          />
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold shrink-0 cursor-pointer"
            @click="handleOnlineRenew"
          >
            确认续借
          </button>
        </div>
        <div
          v-if="renewFeedback"
          class="p-3 rounded-xl text-xs border"
          :class="
            renewFeedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800 font-medium'
              : 'bg-rose-50 border-rose-200 text-rose-700'
          "
        >
          {{ renewFeedback.text }}
        </div>

        <!-- Live Holding Status Panel -->
        <div
          v-if="holdingError"
          class="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700"
        >
          {{ holdingError }}
        </div>
        <div
          v-if="holdingLoaded"
          class="rounded-xl border border-teal-200 bg-teal-50/40 overflow-hidden text-xs"
        >
          <div class="px-3.5 py-2.5 bg-teal-100/70 border-b border-teal-200 flex items-center justify-between">
            <span class="font-bold text-teal-950">
              📍 实时馆藏明细（共 {{ holdingList.length }} 册，当前在馆
              <span class="text-emerald-700 font-extrabold">{{ holdingAvailableCount }}</span> 册）
            </span>
            <span class="text-[11px] text-teal-700">优先展示「在馆」图书</span>
          </div>
          <div v-if="holdingList.length === 0" class="p-4 text-center text-slate-500">
            暂未查询到该书的实时馆藏架位记录（可能是悦读直送或线上书库书目）
          </div>
          <div v-else class="max-h-60 overflow-y-auto divide-y divide-slate-200/70 bg-white">
            <div
              v-for="(h, idx) in holdingList"
              :key="idx"
              class="px-3.5 py-2.5 flex items-start justify-between gap-2.5 hover:bg-slate-50"
            >
              <div class="space-y-1 min-w-0 flex-1">
                <div class="font-semibold text-slate-800 flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 text-left hover:text-teal-700 hover:underline cursor-pointer group/map transition"
                    :title="`点击在${mobileMode ? '地图软件' : '百度地图'}定位：${getLibraryAddressInfo(h).name}（${getLibraryAddressInfo(h).address}）`"
                    @click.stop="openLibraryLocationInMap(h, mobileMode)"
                  >
                    <span>{{ h.libName }}</span>
                    <span v-if="h.location && h.location !== h.libName" class="text-teal-700">
                      · {{ h.location }}
                    </span>
                    <Navigation
                      class="w-3 h-3 text-teal-600 shrink-0 opacity-75 group-hover/map:opacity-100"
                    />
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

                <!-- 具体架位 / 3D 导航位置信息行 -->
                <div
                  v-if="h.shelfNo"
                  class="flex flex-wrap items-center gap-1.5 text-[11px]"
                >
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
                    class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold shadow-2xs transition"
                  >
                    <MapPin class="w-3 h-3" />
                    3D书架导航
                  </a>
                </div>

                <div class="text-[11px] text-slate-500 font-mono flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span
                    v-if="
                      (h.callNo || record.callNo) &&
                      (!h.shelfNo || !h.shelfNo.includes(h.callNo || record.callNo || ''))
                    "
                  >
                    索书号：{{ h.callNo || record.callNo }} ·
                  </span>
                  <span v-if="h.barcode">条码：{{ h.barcode }}</span>
                  <span v-if="h.volInfo">· 卷册：{{ h.volInfo }}</span>
                  <span v-if="h.dueDate" class="text-amber-700 font-sans">· 应还：{{ h.dueDate }}</span>
                </div>
              </div>
              <div class="flex items-center gap-1.5 shrink-0 pt-0.5">
                <span
                  class="px-2 py-0.5 rounded-full text-[11px] font-semibold shrink-0"
                  :class="
                    h.isInLibraryReadOnly
                      ? 'bg-amber-100 text-amber-800'
                      : h.isAvailable
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-slate-100 text-slate-500'
                  "
                >
                  {{
                    h.isInLibraryReadOnly
                      ? `🟡 ${h.stateName || '馆内阅览'}`
                      : h.isAvailable
                        ? '🟢 在馆'
                        : h.stateName
                  }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Same-Book Multi-Borrow Alert -->
        <div
          v-if="sameBookHistory.length > 1"
          class="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs space-y-1.5"
        >
          <div class="font-semibold text-amber-900">
            🔁 这本书您一共借阅过 {{ sameBookHistory.length }} 次：
          </div>
          <div
            v-for="item in sameBookHistory"
            :key="item.id"
            class="flex items-center justify-between text-amber-800"
          >
            <span>
              {{ item.loanDate }} · {{ item.library === 'zjlib' ? '浙江图书馆' : '杭州图书馆' }}（{{ item.subLibrary }}）
            </span>
            <span>{{ item.status === 'borrowed' ? '当前在借' : `归还于 ${item.returnDate || '历史'}` }}</span>
          </div>
        </div>

        <!-- 个人阅读评价、进度、标签与笔记（仅针对借阅过的图书展示，未借阅过的在线书目隐藏） -->
        <template v-if="!isUnborrowedOnlineBook">
          <!-- Verdict & Rating -->
          <div class="space-y-3 border-t border-slate-200 pt-4">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold text-slate-700">借阅结论标记（下次查重时优先提醒）</span>
              <!-- Star Rating -->
              <div class="flex items-center gap-1">
                <button
                  v-for="n in 5"
                  :key="n"
                  class="p-0.5 cursor-pointer"
                  @click="setRating(n)"
                >
                  <Star
                    class="w-4 h-4 transition"
                    :class="n <= rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300'"
                  />
                </button>
              </div>
            </div>

            <div :class="mobileMode ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-4 gap-2'">
              <button
                v-for="opt in verdictOptions"
                :key="opt.value"
                class="px-2.5 py-2 rounded-xl border text-xs font-medium transition cursor-pointer text-center"
                :class="
                  verdict === opt.value
                    ? opt.activeCls
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                "
                @click="toggleVerdict(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>

          <!-- Reading Progress -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs">
              <span class="font-semibold text-slate-700">当前阅读进度</span>
              <span class="font-bold text-teal-700">{{ progress }}%</span>
            </div>
            <input
              v-model.number="progress"
              type="range"
              min="0"
              max="100"
              step="5"
              class="w-full accent-teal-600 cursor-pointer"
              @change="triggerSave"
            />
          </div>

          <!-- Tags -->
          <div class="space-y-2">
            <label class="block text-xs font-semibold text-slate-700 flex items-center gap-1">
              <Tag class="w-3.5 h-3.5" /> 个人分类标签（支持搜索筛选）
            </label>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="pt in presetTags"
                :key="pt"
                class="px-2.5 py-1 rounded-full text-xs transition cursor-pointer"
                :class="
                  tags.includes(pt)
                    ? 'bg-teal-600 text-white font-medium'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                "
                @click="toggleTag(pt)"
              >
                #{{ pt }}
              </button>
              <span
                v-for="custom in tags.filter((t) => !presetTags.includes(t))"
                :key="custom"
                class="px-2.5 py-1 rounded-full text-xs bg-teal-600 text-white font-medium flex items-center gap-1 cursor-pointer"
                @click="toggleTag(custom)"
              >
                #{{ custom }} ×
              </span>
            </div>
            <div class="flex gap-2 pt-1">
              <input
                v-model="newTagInput"
                type="text"
                placeholder="输入自定义标签回车添加..."
                class="flex-1 px-3 py-1.5 rounded-xl border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-teal-500"
                @keyup.enter="addCustomTag"
              />
              <button
                class="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium cursor-pointer"
                @click="addCustomTag"
              >
                添加标签
              </button>
            </div>
          </div>

          <!-- Personal Reading Note -->
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-slate-700">
              读书笔记 / 借阅备注（支持全文检索）
            </label>
            <textarea
              v-model="note"
              rows="3"
              placeholder="记录孩子喜不喜欢、哪个译本更好、或者读到第几章..."
              class="w-full p-3 rounded-xl border border-slate-300 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              @blur="triggerSave"
            ></textarea>
          </div>
        </template>
      </div>

      <!-- Footer（未借阅过的在线书目隐藏） -->
      <div
        v-if="!isUnborrowedOnlineBook"
        class="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2"
      >
        <div class="text-[11px] text-slate-500 flex items-center gap-1.5">
          <ShieldCheck class="w-4 h-4 text-teal-600 shrink-0" />
          <span>阅读标记、评分、标签与笔记已自动持久化存储在本地 IndexedDB</span>
        </div>
        <button
          class="px-5 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs sm:text-sm font-semibold cursor-pointer shrink-0"
          @click="handleClose"
        >
          保存并关闭
        </button>
      </div>
    </div>

    <!-- Full-Screen Cover Lightbox (Click blank area to close) -->
    <div
      v-if="showFullCover && record.coverUrl"
      class="fixed inset-0 z-[80] bg-slate-950/88 backdrop-blur-xs flex flex-col items-center justify-center p-6 cursor-zoom-out"
      @click="showFullCover = false"
    >
      <img
        :src="record.coverUrl"
        :alt="record.title"
        referrerpolicy="no-referrer"
        class="max-w-full max-h-[80vh] rounded-2xl shadow-2xl object-contain border border-white/15"
      />
      <div class="mt-4 text-center space-y-1">
        <div class="text-white font-bold text-sm sm:text-base">《{{ record.title }}》</div>
        <div class="text-slate-400 text-xs">点击任意空白位置返回详情页</div>
      </div>
    </div>
  </div>
</template>
