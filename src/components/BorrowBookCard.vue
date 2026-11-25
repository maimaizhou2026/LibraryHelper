<script setup lang="ts">
import { computed } from 'vue'
import {
  BookOpen,
  Clock,
  Calendar,
  Star,
  ChevronRight,
  Layers,
  CornerDownRight,
  CornerUpLeft,
} from 'lucide-vue-next'
import type { BorrowRecord, LibrarySource, VerdictType } from '../types/library'
import {
  explainCallNo,
  getDaysRemaining,
  getEffectiveRenewCount,
  getMaxRenewLimit,
} from '../utils/search'

const props = defineProps<{
  record: BorrowRecord
  libraries?: LibrarySource[]
  repeatCount: number
  setVolumeCount?: number
  mobileMode: boolean
  coverBroken: boolean
}>()

const emit = defineEmits<{
  (e: 'select', record: BorrowRecord): void
  (e: 'zoom-cover', payload: { title: string; coverUrl: string }): void
  (e: 'cover-error', id: string): void
}>()

const displayLibraries = computed<LibrarySource[]>(() =>
  props.libraries && props.libraries.length > 0 ? props.libraries : [props.record.library]
)

const daysLeft = computed(() =>
  props.record.status === 'borrowed' && props.record.dueDate
    ? getDaysRemaining(props.record.dueDate)
    : null
)

const currentRenewCount = computed(() => getEffectiveRenewCount(props.record))
const maxRenewLimit = computed(() => getMaxRenewLimit(props.record))

const verdictInfo = computed(() => {
  const v: VerdictType = props.record.verdict
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
})

const hasUserAnnotations = computed(
  () =>
    Boolean(props.record.verdict) ||
    (props.record.rating || 0) > 0 ||
    Boolean(props.record.tags && props.record.tags.length > 0) ||
    Boolean(props.record.note)
)

function handleCoverClick() {
  if (props.record.coverUrl && !props.coverBroken) {
    emit('zoom-cover', { title: props.record.title, coverUrl: props.record.coverUrl })
  } else {
    emit('select', props.record)
  }
}
</script>

<template>
  <div
    class="bg-white rounded-2xl border border-slate-200/90 hover:border-teal-500/70 hover:shadow-md transition cursor-pointer group"
    :class="mobileMode ? 'p-4' : 'py-3 px-4'"
    @click="emit('select', record)"
  >
    <!-- ==================== 移动端排版（手机预览框 或 手机屏幕 < 640px）：左大图 + 右侧环绕信息 + 底部浅灰时间导航栏 ==================== -->
    <div v-if="mobileMode">
      <!-- 上半区：左侧放大立体封面 + 右侧结构化字段环绕 -->
      <div class="flex items-start gap-4">
        <!-- 大尺寸封面图 -->
        <div
          class="w-[106px] h-[146px] rounded-xl overflow-hidden shrink-0 border border-slate-200/90 bg-gradient-to-br from-teal-700 via-teal-800 to-slate-900 flex flex-col items-center justify-center text-white text-center shadow-md relative cursor-zoom-in"
          title="点击全屏查看封面"
          @click.stop="handleCoverClick"
        >
          <img
            v-if="record.coverUrl && !coverBroken"
            :src="record.coverUrl"
            :alt="record.title"
            loading="lazy"
            referrerpolicy="no-referrer"
            class="w-full h-full object-cover"
            @error="emit('cover-error', record.id)"
          />
          <template v-else>
            <BookOpen class="w-5 h-5 text-teal-300/80 mb-1.5 shrink-0" />
            <span class="text-xs font-bold leading-snug line-clamp-4 px-2">
              {{ record.title }}
            </span>
          </template>
        </div>

        <!-- 右侧文字环绕区 -->
        <div class="flex-1 min-w-0 space-y-1">
          <h3 class="text-[16px] font-extrabold text-slate-900 leading-snug line-clamp-2">
            {{ record.title }}
          </h3>
          <p class="text-[13px] text-slate-500 truncate">
            {{ record.author || '未知著者' }}
          </p>

          <div class="pt-1.5 space-y-1 text-[12px] leading-relaxed">
            <div class="flex items-baseline gap-2">
              <span class="text-slate-500 shrink-0">所属馆</span>
              <div class="flex flex-wrap items-center gap-1 min-w-0">
                <span
                  v-for="lib in displayLibraries"
                  :key="lib"
                  class="font-medium"
                  :class="lib === 'zjlib' ? 'text-indigo-700' : 'text-teal-700'"
                >
                  {{ lib === 'zjlib' ? '浙图' : '杭图' }}
                </span>
                <span class="text-slate-500 truncate">· {{ record.subLibrary }}</span>
              </div>
            </div>

            <div class="flex items-baseline gap-2">
              <span class="text-slate-500 shrink-0">条码号</span>
              <span class="font-mono text-slate-600 truncate">{{ record.barcode || '—' }}</span>
            </div>

            <div class="flex items-baseline gap-2">
              <span class="text-slate-500 shrink-0">索书号</span>
              <span class="font-mono text-slate-600 truncate">
                {{ record.callNo || '—' }}
              </span>
            </div>

            <div class="flex items-baseline gap-2">
              <span class="text-slate-500 shrink-0">状　态</span>
              <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0">
                <span
                  v-if="record.status === 'borrowed'"
                  class="font-bold text-emerald-600 whitespace-nowrap"
                >
                  在借中
                  <template v-if="daysLeft !== null">
                    ({{ daysLeft >= 0 ? `剩${daysLeft}天` : `超期${Math.abs(daysLeft)}天` }})
                  </template>
                </span>
                <span v-else class="font-bold text-teal-600 whitespace-nowrap">已归还</span>

                <span
                  v-if="record.status === 'borrowed'"
                  class="px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap"
                  :class="
                    currentRenewCount > 0
                      ? 'bg-sky-50 text-sky-700 border border-sky-200'
                      : 'bg-slate-100 text-slate-600'
                  "
                >
                  续借 {{ currentRenewCount }}/{{ maxRenewLimit }} 次
                </span>
                <span
                  v-if="repeatCount > 1"
                  class="px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 text-[10px] font-semibold whitespace-nowrap"
                >
                  借过{{ repeatCount }}次
                </span>
                <span
                  v-else-if="setVolumeCount && setVolumeCount > 1"
                  class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] whitespace-nowrap"
                >
                  套装{{ setVolumeCount }}册
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 下半区：复刻参考图浅灰圆角时间栏 + 右侧立体圆钮 -->
      <div
        class="mt-3.5 bg-slate-50 rounded-2xl px-4 py-2.5 flex items-center justify-between border border-slate-100"
      >
        <div class="space-y-1 text-[13px]">
          <div class="flex items-center gap-2">
            <CornerDownRight class="w-4 h-4 text-emerald-500 shrink-0" />
            <span class="text-slate-600 font-medium">借阅时间</span>
            <span class="text-slate-500 font-mono pl-1">{{ record.loanDate || '—' }}</span>
          </div>
          <div class="flex items-center gap-2">
            <CornerUpLeft class="w-4 h-4 text-emerald-500 shrink-0" />
            <template v-if="record.status === 'borrowed'">
              <span class="text-slate-600 font-medium">应还时间</span>
              <span class="text-amber-700 font-mono font-semibold pl-1">
                {{ record.dueDate || '—' }}
              </span>
            </template>
            <template v-else>
              <span class="text-slate-600 font-medium">归还时间</span>
              <span class="text-slate-500 font-mono pl-1">{{ record.returnDate || '已还' }}</span>
            </template>
          </div>
        </div>

        <!-- 右侧立体圆形导航/详情按钮 -->
        <div
          class="w-13 h-13 rounded-full bg-white shadow-md border border-slate-100 flex flex-col items-center justify-center text-emerald-600 group-hover:scale-105 transition shrink-0"
        >
          <Layers class="w-5 h-5 text-emerald-500" />
          <span class="text-[11px] font-semibold text-slate-700 mt-0.5">详情</span>
        </div>
      </div>

      <!-- 个人标记 / 评分 / 标签 / 笔记回显条 -->
      <div v-if="hasUserAnnotations" class="mt-2.5 pt-2 border-t border-slate-100 space-y-1.5">
        <div class="flex flex-wrap items-center gap-1.5">
          <span
            v-if="verdictInfo"
            class="px-2 py-0.5 rounded-md text-[11px] border"
            :class="verdictInfo.cls"
          >
            {{ verdictInfo.text }}
          </span>
          <span
            v-if="record.rating > 0"
            class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[11px] font-medium"
          >
            <Star class="w-3 h-3 fill-amber-400 text-amber-400" />
            {{ record.rating }}.0
          </span>
          <span
            v-for="t in record.tags"
            :key="t"
            class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[11px]"
          >
            #{{ t }}
          </span>
        </div>
        <p
          v-if="record.note"
          class="text-xs text-slate-600 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-100 line-clamp-2"
        >
          📝 {{ record.note }}
        </p>
      </div>
    </div>

    <!-- ==================== PC 端宽屏排版（保持当前紧凑横向卡片样式） ==================== -->
    <div v-else class="flex items-center gap-3.5">
      <!-- Book Cover Image -->
      <div
        class="w-22 h-30 rounded-xl overflow-hidden shrink-0 border border-slate-200/90 bg-gradient-to-br from-teal-700 via-teal-800 to-slate-900 flex flex-col items-center justify-center text-white text-center shadow-xs relative cursor-zoom-in"
        title="点击放大查看封面"
        @click.stop="handleCoverClick"
      >
        <img
          v-if="record.coverUrl && !coverBroken"
          :src="record.coverUrl"
          :alt="record.title"
          loading="lazy"
          referrerpolicy="no-referrer"
          class="w-full h-full object-cover transition group-hover:scale-103"
          @error="emit('cover-error', record.id)"
        />
        <template v-else>
          <BookOpen class="w-4 h-4 text-teal-300/80 mb-1 shrink-0" />
          <span class="text-[10px] font-bold leading-tight line-clamp-3 px-1.5">
            {{ record.title }}
          </span>
        </template>
      </div>

      <!-- Right Content -->
      <div class="space-y-1.5 flex-1 min-w-0">
        <div class="flex flex-wrap items-center gap-1.5">
          <span
            v-for="lib in displayLibraries"
            :key="lib"
            class="px-2 py-0.5 rounded-md text-[11px] font-semibold"
            :class="
              lib === 'zjlib'
                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200/60'
                : 'bg-teal-50 text-teal-700 border border-teal-200/60'
            "
          >
            {{ lib === 'zjlib' ? '🏛️ 浙江图书馆' : '📚 杭州图书馆' }}
          </span>
          <span class="text-xs text-slate-500 truncate">{{ record.subLibrary }}</span>

          <span
            v-if="record.status === 'borrowed'"
            class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800 flex items-center gap-1"
          >
            <Clock class="w-3 h-3" />
            在借
            <template v-if="daysLeft !== null">
              ·
              <span :class="daysLeft <= 5 ? 'text-rose-600 font-bold' : ''">
                {{ daysLeft >= 0 ? `剩 ${daysLeft} 天` : `超期 ${Math.abs(daysLeft)} 天` }}
              </span>
            </template>
          </span>
          <span v-else class="px-2 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-600">
            已还
          </span>

          <span
            v-if="record.status === 'borrowed'"
            class="px-2 py-0.5 rounded-full text-[11px] font-medium"
            :class="
              currentRenewCount > 0
                ? 'bg-sky-50 text-sky-700 border border-sky-200'
                : 'bg-slate-100 text-slate-600'
            "
          >
            已续借 {{ currentRenewCount }}/{{ maxRenewLimit }} 次
          </span>

          <span
            v-if="repeatCount > 1"
            class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-purple-100 text-purple-800"
          >
            🔁 借过 {{ repeatCount }} 次
          </span>
          <span
            v-else-if="setVolumeCount && setVolumeCount > 1"
            class="px-2 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-600"
          >
            套装 {{ setVolumeCount }} 册
          </span>
        </div>

        <!-- Book Title & Author -->
        <div class="flex items-baseline gap-2 flex-wrap">
          <h3 class="text-base font-bold text-slate-900 group-hover:text-teal-700 transition">
            《{{ record.title }}》
          </h3>
          <span class="text-xs text-slate-500">{{ record.author }}</span>
        </div>

        <!-- Dates & CallNo -->
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          <span class="flex items-center gap-1">
            <Calendar class="w-3.5 h-3.5 text-slate-400" />
            借出：{{ record.loanDate || '—' }}
          </span>
          <span
            v-if="record.status === 'borrowed' && record.dueDate"
            class="text-amber-700 font-medium"
          >
            应还：{{ record.dueDate }}
          </span>
          <span v-else-if="record.returnDate">
            归还：{{ record.returnDate }}
          </span>
          <span v-if="record.callNo" class="font-mono text-slate-600">
            索书号：{{ record.callNo }}
            <span class="text-[11px] text-slate-400 font-sans">
              ({{ explainCallNo(record.callNo) }})
            </span>
          </span>
        </div>

        <!-- Verdict, Rating, Tags & Notes -->
        <div v-if="hasUserAnnotations" class="pt-0.5 flex flex-wrap items-center gap-1.5">
          <span
            v-if="verdictInfo"
            class="px-2 py-0.5 rounded-md text-[11px] border"
            :class="verdictInfo.cls"
          >
            {{ verdictInfo.text }}
          </span>
          <span
            v-if="record.rating > 0"
            class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[11px] font-medium"
          >
            <Star class="w-3 h-3 fill-amber-400 text-amber-400" />
            {{ record.rating }}.0
          </span>
          <span
            v-for="t in record.tags"
            :key="t"
            class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[11px]"
          >
            #{{ t }}
          </span>
        </div>

        <p
          v-if="record.note"
          class="text-xs text-slate-600 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-100 line-clamp-2"
        >
          📝 {{ record.note }}
        </p>
      </div>

      <!-- Right Chevron & Progress -->
      <div class="flex flex-col items-end justify-between shrink-0 self-stretch">
        <ChevronRight class="w-4 h-4 text-slate-300 group-hover:text-teal-600 transition" />
        <div v-if="record.status === 'borrowed'" class="text-right mt-2">
          <div class="text-[10px] text-slate-400">阅读进度 {{ record.progress || 0 }}%</div>
          <div class="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden mt-0.5">
            <div
              class="h-full bg-teal-600 rounded-full"
              :style="{ width: `${record.progress || 0}%` }"
            ></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
