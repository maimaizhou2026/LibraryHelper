export type LibrarySource = 'zjlib' | 'hzlib'

export type BorrowStatus = 'borrowed' | 'returned'

export type VerdictType =
  | ''
  | 'worth_reborrow' // 值得重借
  | 'liked'          // 推荐/喜欢
  | 'unfinished'     // 未读完下次再借
  | 'disliked'       // 踩雷不看

export interface CatalogHoldingItem {
  libName: string
  orgLibName?: string
  location: string
  shelfNo?: string
  rawShelfMark?: string
  navUrl?: string
  callNo: string
  barcode: string
  stateName: string
  isAvailable: boolean
  isInLibraryReadOnly?: boolean
  docType?: string
  volInfo?: string
  dueDate?: string
  isPreviewSummary?: boolean
  copyCount?: number
  loanableCount?: number
}

export interface BorrowRecord {
  id: string
  library: LibrarySource
  subLibrary: string
  /** 该条借阅记录归属的读者证号/身份证号/账号 */
  account?: string
  status: BorrowStatus
  title: string
  author: string
  isbn: string
  callNo: string
  barcode: string
  bibId: string
  loanDate: string
  dueDate: string
  returnDate: string
  renewCount: number
  coverUrl: string
  // 用户本地增强字段（同步更新时自动保留）
  rating: number // 0 ~ 5
  verdict: VerdictType
  tags: string[]
  note: string
  progress: number // 0 ~ 100
  updatedAt: number
  // 在线全馆书目检索扩展字段
  isOnlineCatalog?: boolean
  rawOrder?: number
  publisher?: string
  pubDate?: string
  availableCount?: number
  totalHoldings?: number
  availableBranches?: string[]
  holdings?: CatalogHoldingItem[]
}

export interface BookAggregatedGroup {
  normKey: string
  title: string
  author: string
  isbn: string
  callNo: string
  coverUrl: string
  libraries: LibrarySource[]
  totalBorrows: number
  isCurrentlyBorrowed: boolean
  latestLoanDate: string
  verdict: VerdictType
  rating: number
  tags: string[]
  note: string
  records: BorrowRecord[]
}

export interface SyncMeta {
  zjlibLastSync?: string
  hzlibLastSync?: string
  zjlibAccount?: string
  hzlibAccount?: string
  zjlibCount?: number
  hzlibCount?: number
}
