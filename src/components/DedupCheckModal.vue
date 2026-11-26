<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import {
  X,
  ScanBarcode,
  Search,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Camera,
  StopCircle,
  BookOpen,
} from 'lucide-vue-next'
import type { BorrowRecord } from '../types/library'
import { checkBookDuplicate, prefetchHighResCover, toThumbnailCoverUrl } from '../utils/search'

const props = defineProps<{
  open: boolean
  records: BorrowRecord[]
  mobileMode?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'select-record', record: BorrowRecord): void
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
}>()

const inputQuery = ref('')
const scanning = ref(false)
const scanError = ref('')
const videoEl = ref<HTMLVideoElement | null>(null)
const brokenCovers = ref<Set<string>>(new Set())
let mediaStream: MediaStream | null = null
let scanTimer: number | null = null

const checkResult = computed(() => checkBookDuplicate(props.records, inputQuery.value))

function verdictBadge(v: string) {
  switch (v) {
    case 'worth_reborrow':
      return { text: '👍 值得重借', cls: 'bg-emerald-100 text-emerald-800' }
    case 'liked':
      return { text: '❤️ 推荐喜欢', cls: 'bg-teal-100 text-teal-800' }
    case 'unfinished':
      return { text: '🔖 未读完下次再借', cls: 'bg-amber-100 text-amber-800' }
    case 'disliked':
      return { text: '💣 踩雷别借', cls: 'bg-rose-100 text-rose-800 font-bold' }
    default:
      return null
  }
}

async function startBarcodeScan() {
  scanError.value = ''
  if (!navigator.mediaDevices?.getUserMedia) {
    scanError.value = '当前浏览器环境不支持直接调用摄像头，可手动输入书名或 ISBN 后4位'
    return
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    })
    scanning.value = true
    setTimeout(() => {
      if (videoEl.value && mediaStream) {
        videoEl.value.srcObject = mediaStream
        videoEl.value.play()
      }
    }, 50)

    const BarcodeDetectorCtor = (window as any).BarcodeDetector
    if (BarcodeDetectorCtor) {
      const detector = new BarcodeDetectorCtor({ formats: ['ean_13', 'ean_8', 'code_128'] })
      scanTimer = window.setInterval(async () => {
        if (!videoEl.value) return
        try {
          const codes = await detector.detect(videoEl.value)
          if (codes && codes.length > 0 && codes[0].rawValue) {
            inputQuery.value = codes[0].rawValue
            stopBarcodeScan()
          }
        } catch {
          // ignore frame error
        }
      }, 400)
    } else {
      scanError.value = '提示：当前桌面浏览器未内置 BarcodeDetector，手机 Chrome/Edge 可直接识别 ISBN 条形码'
    }
  } catch (e: any) {
    scanError.value = '无法开启摄像头：' + (e?.message || '权限被拒绝或设备无摄像头')
    scanning.value = false
  }
}

function stopBarcodeScan() {
  if (scanTimer) {
    clearInterval(scanTimer)
    scanTimer = null
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop())
    mediaStream = null
  }
  scanning.value = false
}

onBeforeUnmount(() => {
  stopBarcodeScan()
})
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex justify-center bg-slate-900/60 backdrop-blur-xs"
    :class="mobileMode ? 'items-end p-0' : 'items-end sm:items-center p-0 sm:p-4'"
    @click.self="stopBarcodeScan(); emit('close')"
  >
    <div
      class="w-full bg-white shadow-2xl border border-slate-200 max-h-[90vh] flex flex-col overflow-hidden"
      :class="mobileMode ? 'max-w-[420px] rounded-t-2xl' : 'max-w-xl rounded-t-2xl sm:rounded-2xl'"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-4 bg-gradient-to-r from-amber-500 to-orange-600 text-white">
        <h2 class="text-base sm:text-lg font-bold flex items-center gap-2">
          <ScanBarcode class="w-5 h-5" />
          现场借书
        </h2>
        <button
          class="p-1.5 rounded-lg hover:bg-white/15 transition cursor-pointer"
          @click="stopBarcodeScan(); emit('close')"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <div class="p-5 overflow-y-auto space-y-4 flex-1">
        <!-- Search / Scan Input -->
        <div class="flex gap-2">
          <div class="relative flex-1">
            <Search class="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              v-model="inputQuery"
              type="text"
              autofocus
              placeholder="输入书名/拼音/ISBN条形码"
              class="w-full pl-9 pr-8 py-2.5 rounded-xl border-2 border-amber-400 focus:border-orange-500 text-sm focus:outline-none"
            />
            <button
              v-if="inputQuery"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
              @click="inputQuery = ''"
            >
              <X class="w-4 h-4" />
            </button>
          </div>
          <button
            v-if="!scanning"
            class="px-3.5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium flex items-center gap-1.5 shrink-0 cursor-pointer"
            @click="startBarcodeScan"
          >
            <Camera class="w-4 h-4" />
            扫 ISBN
          </button>
          <button
            v-else
            class="px-3.5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-medium flex items-center gap-1.5 shrink-0 cursor-pointer"
            @click="stopBarcodeScan"
          >
            <StopCircle class="w-4 h-4" />
            关闭相机
          </button>
        </div>

        <!-- Camera Preview -->
        <div v-if="scanning" class="rounded-xl overflow-hidden bg-black relative">
          <video ref="videoEl" class="w-full h-48 object-cover" playsinline muted></video>
          <div class="absolute inset-x-8 top-1/2 h-0.5 bg-amber-400 shadow-[0_0_8px_#f59e0b]"></div>
          <div class="p-2 text-center text-xs text-white/90 bg-slate-900/80">
            请将图书背面的 ISBN 条形码对准取景框中央
          </div>
        </div>
        <p v-if="scanError" class="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
          {{ scanError }}
        </p>

        <!-- Result Area -->
        <div v-if="checkResult.state === 'idle'" class="space-y-3">
          <p class="text-xs text-slate-500 text-center">
            👆 输入书名或扫描 ISBN 条码，立即比对您在【浙江图书馆】与【杭州图书馆】的全部借阅历史
          </p>

          <!-- ISBN 码实拍样例图与说明卡片 -->
          <div class="p-3.5 rounded-2xl bg-slate-50 border border-slate-200/90 space-y-2.5">
            <div class="flex items-center justify-between gap-2 flex-nowrap">
              <span class="text-xs font-bold text-slate-700 whitespace-nowrap shrink-0">
                📌 什么是图书 ISBN 码？
              </span>
              <span
                class="text-[11px] text-amber-700 bg-amber-100/80 px-2 py-0.5 rounded-full font-medium whitespace-nowrap shrink-0"
              >
                位于图书封底（背面）下方
              </span>
            </div>
            <div class="rounded-xl overflow-hidden border border-slate-200 bg-white p-2 flex flex-col items-center">
              <img
                src="/isbn-sample-photo.jpg"
                alt="ISBN条形码示例"
                loading="lazy"
                decoding="async"
                class="max-h-44 w-auto object-contain rounded-lg"
              />
            </div>
            <p class="text-[11px] text-slate-500 leading-relaxed">
              请认准图书背面印有 <code class="font-mono text-slate-700 font-semibold">ISBN 978-7-...</code> 的 <strong>13 位数字条形码</strong>（注：不是图书馆贴在书皮上的馆内条码）。
            </p>
          </div>
        </div>

        <!-- 🟢 NEVER BORROWED -->
        <div
          v-else-if="checkResult.state === 'never_borrowed'"
          class="p-5 rounded-2xl bg-emerald-50 border-2 border-emerald-300 text-center space-y-2"
        >
          <CheckCircle2 class="w-10 h-10 text-emerald-600 mx-auto" />
          <div class="text-base font-bold text-emerald-900">
            ✅ 从未借阅过「{{ checkResult.query }}」
          </div>
          <p class="text-xs text-emerald-700">
            在您本地的浙江图书馆与杭州图书馆记录中均未检索到该书，可以放心借阅！
          </p>
        </div>

        <!-- 🔴 CURRENTLY BORROWED OR 🟡 PREVIOUSLY BORROWED -->
        <div v-else class="space-y-3">
          <div class="space-y-2">
            <div
              v-for="group in checkResult.matchedGroups"
              :key="group.normKey"
              class="p-3 rounded-xl border border-slate-200 hover:border-teal-400 bg-white shadow-2xs transition cursor-pointer flex items-start gap-3"
              @click="emit('select-record', group.records[0])"
            >
              <!-- Cover Thumbnail -->
              <div
                class="w-14 h-20 rounded-lg overflow-hidden shrink-0 border border-slate-200 bg-gradient-to-br from-teal-700 to-slate-800 flex items-center justify-center text-white text-center"
                :class="group.coverUrl && !brokenCovers.has(group.normKey) ? 'cursor-zoom-in' : ''"
                :title="group.coverUrl && !brokenCovers.has(group.normKey) ? '点击放大查看高清封面' : undefined"
                @mouseenter="group.coverUrl && !brokenCovers.has(group.normKey) && prefetchHighResCover(group.coverUrl)"
                @click.stop="
                  group.coverUrl &&
                  !brokenCovers.has(group.normKey) &&
                  emit('zoom-cover', {
                    id: group.records[0]?.id,
                    title: group.title,
                    coverUrl: group.coverUrl,
                    author: group.author,
                    publisher: group.records[0]?.publisher,
                    isbn: group.isbn,
                  })
                "
              >
                <img
                  v-if="group.coverUrl && !brokenCovers.has(group.normKey)"
                  :src="toThumbnailCoverUrl(group.coverUrl, 140, 200)"
                  :alt="group.title"
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  class="w-full h-full object-cover"
                  @error="brokenCovers.add(group.normKey)"
                />
                <BookOpen v-else class="w-4 h-4 text-teal-200" />
              </div>

              <div class="flex-1 min-w-0 space-y-1">
                <div class="flex items-start justify-between gap-2">
                  <div class="font-bold text-sm text-slate-900 break-words leading-snug">
                    《{{ group.title }}》
                  </div>
                  <span
                    class="px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0"
                    :class="
                      group.isCurrentlyBorrowed
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-slate-100 text-slate-600'
                    "
                  >
                    {{ group.isCurrentlyBorrowed ? '⏳ 当前在借' : `✅ 借过${group.totalBorrows}次` }}
                  </span>
                </div>
                <div class="text-xs text-slate-500 truncate">{{ group.author }}</div>

                <div class="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span
                    v-for="lib in group.libraries"
                    :key="lib"
                    class="px-1.5 py-0.5 rounded text-[11px] font-medium"
                    :class="
                      lib === 'zjlib'
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'bg-teal-50 text-teal-700'
                    "
                  >
                    {{ lib === 'zjlib' ? '🏛️ 浙图' : '📚 杭图' }}
                  </span>
                  <span>最近借阅：{{ group.latestLoanDate }}</span>
                </div>

                <div
                  v-if="group.verdict || group.tags?.length"
                  class="pt-0.5 flex flex-wrap items-center gap-1.5"
                >
                  <span
                    v-if="verdictBadge(group.verdict)"
                    class="px-2 py-0.5 rounded-md text-[11px]"
                    :class="verdictBadge(group.verdict)?.cls"
                  >
                    {{ verdictBadge(group.verdict)?.text }}
                  </span>
                  <span
                    v-for="tag in group.tags"
                    :key="tag"
                    class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[11px]"
                  >
                    #{{ tag }}
                  </span>
                </div>
                <p v-if="group.note" class="text-xs text-slate-600 bg-slate-50 px-2.5 py-1 rounded-lg">
                  📝 {{ group.note }}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
