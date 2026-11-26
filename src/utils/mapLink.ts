import zjlibConfigRaw from '../../addr/zjlib_branches.json'
import hzlibConfigRaw from '../../addr/hzlib_branches.json'

export interface BranchDropdownOption {
  value: string
  label: string
  districtId?: string
  matchKeywords: string[]
}

export interface BranchVenueConfig {
  id: string
  category: string
  name: string
  aliases: string[]
  address: string
  uid?: string
  x?: number
  y?: number
  cityCode: number
  priority: number
}

export interface LibraryBranchesJsonConfig {
  library: 'zjlib' | 'hzlib'
  groupLabel: string
  officialUrl: string
  dropdownOptions: BranchDropdownOption[]
  districtIdMap?: Record<string, string>
  mainCenterRooms?: string[]
  branches: BranchVenueConfig[]
}

export const ZJLIB_BRANCH_CONFIG = zjlibConfigRaw as LibraryBranchesJsonConfig
export const HZLIB_BRANCH_CONFIG = hzlibConfigRaw as LibraryBranchesJsonConfig

export interface MapLocationTarget {
  library?: 'zjlib' | 'hzlib'
  libName: string
  location?: string
}

export interface LibraryPoiInfo {
  /** 百度地图标准 POI 名称 */
  name: string
  /** 官方详细门牌地址 */
  address: string
  /** 百度地图唯一 POI UID（存在时可直接 17 级比例尺锁定建筑） */
  uid?: string
  /** 百度地图墨卡托坐标 X (原始值，拼接 @x,y 时除以 100) */
  x?: number
  /** 百度地图墨卡托坐标 Y (原始值，拼接 @x,y 时除以 100) */
  y?: number
  /** 城市代码（杭州 179，湖州 294） */
  cityCode: number
  /** 检索关键词兜底 */
  query: string
}

export type MapProviderId = 'amap' | 'baidu' | 'apple' | 'tencent'

export interface MapProviderOption {
  id: MapProviderId
  name: string
  desc: string
  badge: string
  url: string
}

const PREFERRED_MAP_STORAGE_KEY = 'lh_preferred_map_provider_v1'

type MobileMapPickerCallback = (
  target: MapLocationTarget,
  info: LibraryPoiInfo,
  options: MapProviderOption[]
) => void

let mobileMapPickerCallback: MobileMapPickerCallback | null = null

export function registerMobileMapPicker(cb: MobileMapPickerCallback | null): void {
  mobileMapPickerCallback = cb
}

export function getPreferredMapProvider(): MapProviderId | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const val = localStorage.getItem(PREFERRED_MAP_STORAGE_KEY)
    if (val === 'amap' || val === 'baidu' || val === 'apple' || val === 'tencent') {
      return val
    }
  } catch {
    // ignore
  }
  return null
}

export function setPreferredMapProvider(provider: MapProviderId | null): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (!provider) {
      localStorage.removeItem(PREFERRED_MAP_STORAGE_KEY)
    } else {
      localStorage.setItem(PREFERRED_MAP_STORAGE_KEY, provider)
    }
  } catch {
    // ignore
  }
}

export function isIosPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const platform = (navigator as any).platform || ''
  return (
    /iPhone|iPad|iPod/i.test(ua) ||
    (platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1)
  )
}

export function isMobileDeviceEnv(forceMobileMode?: boolean): boolean {
  if (forceMobileMode) return true
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(ua) || isIosPlatform()
}

export function getCleanMapSearchText(info: LibraryPoiInfo): string {
  if (info.address && info.address !== '未知地址') {
    return `${info.name} ${info.address}`.replace(/\s+/g, ' ').trim()
  }
  return (info.query || info.name || '杭州图书馆').replace(/\s+/g, ' ').trim()
}

/**
 * 将 addr/zjlib_branches.json 与 addr/hzlib_branches.json 构建为内存索引
 */
const ALL_BRANCH_VENUES: Map<string, BranchVenueConfig> = new Map()
for (const b of ZJLIB_BRANCH_CONFIG.branches) {
  ALL_BRANCH_VENUES.set(b.id, b)
}
for (const b of HZLIB_BRANCH_CONFIG.branches) {
  ALL_BRANCH_VENUES.set(b.id, b)
}

const BRANCH_DROPDOWN_KEYWORDS: Map<string, string[]> = new Map()
for (const opt of [
  ...ZJLIB_BRANCH_CONFIG.dropdownOptions,
  ...HZLIB_BRANCH_CONFIG.dropdownOptions,
]) {
  if (opt.matchKeywords && opt.matchKeywords.length > 0) {
    BRANCH_DROPDOWN_KEYWORDS.set(opt.value, opt.matchKeywords)
  }
}

function buildPoiInfoFromVenue(venue: BranchVenueConfig): LibraryPoiInfo {
  return {
    name: venue.name,
    address: venue.address,
    uid: venue.uid,
    x: venue.x,
    y: venue.y,
    cityCode: venue.cityCode,
    query: `${venue.name} ${venue.address}`,
  }
}

function buildPoiInfo(id: string): LibraryPoiInfo {
  const venue = ALL_BRANCH_VENUES.get(id)
  if (!venue) {
    return {
      name: '杭州图书馆',
      address: '未知地址',
      cityCode: 179,
      query: '杭州图书馆',
    }
  }
  return buildPoiInfoFromVenue(venue)
}

/**
 * 解析馆藏所属图书馆与借阅室名称，返回精确的场馆名称、详细门牌地址及百度地图 POI 坐标信息
 * 数据源来自 addr/zjlib_branches.json 与 addr/hzlib_branches.json
 */
export function getLibraryAddressInfo(target: MapLocationTarget): LibraryPoiInfo {
  let lib = (target.libName || '').trim()
  let loc = (target.location || '').trim()
  // 若调用方将 "馆名·分馆/阅览室" 拼接在 libName 中且未传 location，则自动拆分
  if (!loc && /[·•]/.test(lib)) {
    const parts = lib
      .split(/[·•]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length >= 2) {
      loc = parts[parts.length - 1]
      lib = parts.slice(0, parts.length - 1).join('·')
    }
  }
  const combined = `${lib} ${loc}`

  // 1. 浙江图书馆 5 大馆区（从 addr/zjlib_branches.json 匹配）
  for (const venue of ZJLIB_BRANCH_CONFIG.branches) {
    if (venue.aliases.some((alias) => combined.includes(alias))) {
      return buildPoiInfoFromVenue(venue)
    }
  }
  if (combined.includes('其他馆区')) {
    // 兼容 "浙图·其他馆区·仙居县朱溪镇分馆" 放在 libName 或 location 的情况
    const branchName =
      loc ||
      lib
        .replace(/^.*其他馆区[·\s]*/g, '')
        .trim()
    if (branchName && branchName !== '浙图·其他馆区' && branchName !== '其他馆区') {
      const cleanBranch = branchName.replace(/^浙江图书馆[·\s]*|^浙图[·\s]*/g, '').trim()
      const prefix = target.library === 'hzlib' ? '杭图' : '浙图'
      const query = cleanBranch.startsWith(prefix) ? cleanBranch : `${prefix} ${cleanBranch}`
      return {
        name: cleanBranch,
        address: '未知地址',
        cityCode: 179,
        query,
      }
    }
    return {
      name: '浙江图书馆其他馆区',
      address: '未知地址',
      cityCode: 179,
      query: '浙江图书馆',
    }
  }
  if (lib.includes('浙江图书馆') || lib.startsWith('浙图')) {
    return buildPoiInfo('zj_zhijiang')
  }

  // 2. 杭州图书馆直属独立主题馆与共建馆（从 addr/hzlib_branches.json 匹配）
  for (const venue of HZLIB_BRANCH_CONFIG.branches) {
    if (
      (venue.category === '直属主题分馆' || venue.category === '共建分馆') &&
      venue.aliases.some((alias) => combined.includes(alias))
    ) {
      return buildPoiInfoFromVenue(venue)
    }
  }

  // 3. 杭州图书馆市民中心总馆内部各借阅室/中心
  if (lib === '杭州图书馆' || lib === '杭州地区图书馆' || lib === '杭州市图书馆事业基金会') {
    const mainRooms = HZLIB_BRANCH_CONFIG.mainCenterRooms || []
    const isMainCenterRoom =
      !loc ||
      mainRooms.some((room) => loc.includes(room))
    if (isMainCenterRoom) {
      return buildPoiInfo('hz_main')
    }

    // 杭州图书馆直属微图或外部服务点（如：杭州市少年宫微图、西湖文化广场微图）
    const cleanLoc = loc
      .replace(/（.*?）|\(.*?\)/g, '')
      .replace(/微图$|外借$|借阅室$|调拨点$|流通点$/g, '')
      .trim()
    const query = cleanLoc.startsWith('杭图') || cleanLoc.startsWith('杭州')
      ? cleanLoc
      : `杭图 ${cleanLoc}`
    return {
      name: cleanLoc || '杭州图书馆',
      address: '未知地址',
      cityCode: 179,
      query,
    }
  }

  // 4. 杭州各区、县（市）图书馆总馆（非基层分馆）
  if (!lib.includes('分馆')) {
    for (const venue of HZLIB_BRANCH_CONFIG.branches) {
      if (venue.category === '区县总馆' && venue.aliases.some((alias) => lib.includes(alias))) {
        return buildPoiInfoFromVenue(venue)
      }
    }
  }

  for (const venue of HZLIB_BRANCH_CONFIG.branches) {
    if (venue.category === '其他分馆' && venue.aliases.some((alias) => lib.includes(alias))) {
      return buildPoiInfoFromVenue(venue)
    }
  }

  // 5. 各区县图书馆下属街道/社区分馆、杭州书房、邻里阅读空间（如：滨江区图书馆分馆 · 网易蜗牛读书馆）
  const cleanLoc = loc
    .replace(/^[（(].*?[）)]/g, '')
    .replace(/（.*?）|\(.*?\)/g, '')
    .replace(/微图$|外借$|借阅室$|调拨点$|流通点$/g, '')
    .trim()

  if (cleanLoc) {
    const query =
      cleanLoc.startsWith('杭图') || cleanLoc.startsWith('杭州')
        ? cleanLoc
        : `杭图 ${cleanLoc}`.replace(/\s+/g, ' ').trim()
    return {
      name: cleanLoc,
      address: '未知地址',
      cityCode: 179,
      query,
    }
  }

  return buildPoiInfo('hz_main')
}

/**
 * 将图书馆馆区与内部借阅室名称清洗为适合地图检索的真实物理场馆地址关键词
 */
export function getLibraryMapQuery(target: MapLocationTarget): string {
  return getLibraryAddressInfo(target).query
}

/**
 * 生成百度地图 PC 端精准定位 URL：
 * - 若已知精确 POI UID 与墨卡托坐标 (x, y)，直接生成 17 级比例尺建筑锁定 URL (`/poi/{name}/@{x},{y},17z?uid={uid}`)
 * - 若为基层社区分馆/邻里阅读空间，走本地代理 `/api/map/go` 实时解析百度地图首个匹配 POI 并 302 跳转至 17 级建筑页
 */
export function getBaiduMapUrl(target: MapLocationTarget): string {
  const info = getLibraryAddressInfo(target)
  if (info.uid && info.x && info.y) {
    const coordX = (info.x / 100).toFixed(2)
    const coordY = (info.y / 100).toFixed(2)
    return `https://map.baidu.com/poi/${encodeURIComponent(info.name)}/@${coordX},${coordY},17z?uid=${info.uid}&poiShareUid=${info.uid}&querytype=s&da_src=shareurl&wd=${encodeURIComponent(info.name)}&c=${info.cityCode}&info_merge=1&isBizPoi=false`
  }
  return `/api/map/go?q=${encodeURIComponent(info.query)}&c=${info.cityCode}`
}

export function getMobileMapProviderOptions(target: MapLocationTarget): MapProviderOption[] {
  const info = getLibraryAddressInfo(target)
  const keyword = getCleanMapSearchText(info)
  const encodedKw = encodeURIComponent(keyword)
  const cityName = info.cityCode === 294 ? '湖州' : '杭州'
  const cityAdcode = info.cityCode === 294 ? '330500' : '330100'

  const amapUrl = `https://uri.amap.com/search?keyword=${encodedKw}&city=${cityAdcode}&view=map&src=LibraryHelper&coordinate=gaode&callnative=1`
  const baiduUrl = getBaiduMapUrl(target)
  const appleUrl = `https://maps.apple.com/?q=${encodedKw}`
  const tencentUrl = `https://apis.map.qq.com/uri/v1/search?keyword=${encodedKw}&region=${encodeURIComponent(cityName)}&referer=LibraryHelper`

  const list: MapProviderOption[] = [
    {
      id: 'amap',
      name: '高德地图',
      desc: '自动唤起高德 App 或打开移动网页导航',
      badge: '常用推荐',
      url: amapUrl,
    },
    {
      id: 'baidu',
      name: '百度地图',
      desc: '精准锁定图书馆场馆建筑点位',
      badge: '精准建筑',
      url: baiduUrl,
    },
  ]

  if (isIosPlatform()) {
    list.push({
      id: 'apple',
      name: '苹果地图 (Apple Maps)',
      desc: '直接唤起 iPhone / iPad 系统自带地图',
      badge: 'iOS原生',
      url: appleUrl,
    })
  } else {
    list.push({
      id: 'apple',
      name: '苹果 / 系统地图',
      desc: 'iOS 唤起自带苹果地图，其他设备打开通用地图页',
      badge: '系统直达',
      url: appleUrl,
    })
  }

  list.push({
    id: 'tencent',
    name: '腾讯地图',
    desc: '微信生态内兼容性好，支持直接查看路线',
    badge: '微信友好',
    url: tencentUrl,
  })

  return list
}

export function openMapUrlSafely(url: string): void {
  if (!url || typeof window === 'undefined') return
  // iOS Safari 对 https://maps.apple.com Universal Link 使用 location.href 最稳定，不会留下空白新标签页
  if (url.startsWith('https://maps.apple.com/')) {
    window.location.href = url
    return
  }
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/**
 * 打开图书馆地图定位：
 * - PC端（Windows / macOS）：直接在新标签页打开百度地图 17 级比例尺精准建筑定位页
 * - 移动端（iOS / Android / 手机预览框）：弹出地图软件选择面板（或按已记住的偏好直接打开）
 */
export function openLibraryLocationInMap(
  target: MapLocationTarget,
  isMobileMode?: boolean,
  forceShowPicker = false
): void {
  const info = getLibraryAddressInfo(target)
  if (isMobileDeviceEnv(isMobileMode)) {
    const options = getMobileMapProviderOptions(target)
    const savedProvider = !forceShowPicker ? getPreferredMapProvider() : null
    if (savedProvider) {
      const matched = options.find((o) => o.id === savedProvider) || options[0]
      if (matched) {
        openMapUrlSafely(matched.url)
        return
      }
    }
    if (mobileMapPickerCallback) {
      mobileMapPickerCallback(target, info, options)
      return
    }
    // 兜底：若未注册弹窗回调，使用全端兼容的高德 https Universal Link
    openMapUrlSafely(options[0].url)
    return
  }

  const pcBaiduMapUrl = getBaiduMapUrl(target)
  openMapUrlSafely(pcBaiduMapUrl)
}

/**
 * 根据下拉框选中的分馆值（如 zjlib:1916325141324353538 或 hzlib:local:少儿分馆）判断馆藏项是否归属该分馆
 */
export function matchesSelectedBranchOption(
  libName: string,
  location: string,
  branchValue: string
): boolean {
  if (!branchValue || branchValue === 'all' || branchValue === 'zjlib:all' || branchValue === 'hzlib:all') {
    return false
  }
  const keywords = BRANCH_DROPDOWN_KEYWORDS.get(branchValue)
  if (!keywords || keywords.length === 0) return false
  const text = `${libName || ''} ${location || ''}`
  return keywords.some((kw) => text.includes(kw))
}

/**
 * 统一馆区优先级权重（越小越靠前）：
 * - 浙图：曙光路(1) > 之江开架(2) > 之江立库(3) > 大学路/孤山路/嘉业堂(4) > 其他馆区(5)
 * - 杭图：市民中心总馆(1) > 外迁直属主题分馆(2) > 各区县总馆(3) > 基层社区/街道分馆(4)
 */
export function getLibraryBranchPriority(
  library: 'zjlib' | 'hzlib',
  libName: string,
  location = ''
): number {
  const full = `${libName} ${location}`
  if (library === 'zjlib') {
    if (full.includes('曙光路')) return 1
    if (full.includes('之江')) {
      return location.includes('立库') || location.includes('保存本') ? 3 : 2
    }
    for (const venue of ZJLIB_BRANCH_CONFIG.branches) {
      if (venue.aliases.some((alias) => full.includes(alias))) {
        return venue.priority
      }
    }
    return 5
  }

  // hzlib：先识别外迁直属主题分馆（避免因 libName === '杭州图书馆' 被误归入总馆级别 1）
  for (const venue of HZLIB_BRANCH_CONFIG.branches) {
    if (
      (venue.category === '直属主题分馆' || venue.category === '共建分馆') &&
      venue.aliases.some((alias) => full.includes(alias))
    ) {
      return venue.priority
    }
  }
  const mainRooms = HZLIB_BRANCH_CONFIG.mainCenterRooms || []
  if (
    mainRooms.some((kw) => full.includes(kw)) ||
    libName === '杭州图书馆' ||
    libName.startsWith('杭州图书馆·')
  ) {
    return 1
  }
  if (libName.includes('分馆')) {
    return 4
  }
  return 3
}
