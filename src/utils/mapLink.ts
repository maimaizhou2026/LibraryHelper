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

/**
 * 打开图书馆地图定位：
 * - PC端：直接打开百度地图 17 级比例尺精准建筑定位页
 * - 移动端真机：调用系统默认地图软件 (geo: URI)
 */
export function openLibraryLocationInMap(
  target: MapLocationTarget,
  _isMobileMode?: boolean
): void {
  const info = getLibraryAddressInfo(target)
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
  const isRealMobileDevice = /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(ua)

  if (isRealMobileDevice) {
    // 手机真机端：优先通过标准 geo: 协议唤起手机系统默认地图 App（高德/百度/腾讯/苹果地图）
    const encoded = encodeURIComponent(`${info.name} ${info.address}`)
    window.location.href = `geo:0,0?q=${encoded}`
    return
  }

  const pcBaiduMapUrl = getBaiduMapUrl(target)
  window.open(pcBaiduMapUrl, '_blank', 'noopener')
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
