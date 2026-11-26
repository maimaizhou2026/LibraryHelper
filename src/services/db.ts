import type { BorrowRecord, SyncMeta } from '../types/library'

const DB_NAME = 'LibraryHelperDB'
const DB_VERSION = 1
const STORE_RECORDS = 'borrow_records'
const STORE_META = 'sync_meta'
const LOCAL_NOTES_BACKUP_KEY = 'lh_user_annotations_backup_v1'

type UserAnnotationSnapshot = Pick<
  BorrowRecord,
  'rating' | 'verdict' | 'tags' | 'note' | 'progress'
>

function getLocalAnnotationsBackup(): Record<string, UserAnnotationSnapshot> {
  try {
    const raw = localStorage.getItem(LOCAL_NOTES_BACKUP_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveLocalAnnotationBackup(title: string, data: UserAnnotationSnapshot): void {
  try {
    const key = (title || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase()
    if (!key) return
    const map = getLocalAnnotationsBackup()
    map[key] = {
      rating: Number(data.rating || 0),
      verdict: data.verdict || '',
      tags: Array.isArray(data.tags) ? [...data.tags].map(String) : [],
      note: String(data.note || ''),
      progress: Number(data.progress || 0),
    }
    localStorage.setItem(LOCAL_NOTES_BACKUP_KEY, JSON.stringify(map))
  } catch {
    // ignore
  }
}

function sanitizeCoverUrl(rawUrl: string): string {
  const trimmed = String(rawUrl || '')
    .trim()
    .replace(/^http:\/\//i, 'https://')
    .replace(/(&f=(?:JPEG|PNG|GIF|WEBP))=240=320(?:\?fmt=auto)?/gi, '$1?w=600&h=820')
  if (!trimmed) return ''
  const lower = trimmed.toLowerCase()
  if (
    lower.includes('openbookscan.com.cn:1235') ||
    lower.includes('d9fa61ec5b294296a2a53bfe5a167c91') ||
    lower.includes('fb87c5fae030416d8f9629c56451e355') ||
    lower.includes('bigbg.png') ||
    lower.includes('default_book') ||
    lower.includes('no_pic') ||
    lower.includes('nopic') ||
    lower.includes('zanwu')
  ) {
    return ''
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : ''
}

/**
 * 剥离 Vue 3 响应式 Proxy，确保传入 IndexedDB store.put() 的对象 100% 是纯 JS 对象与纯数组，防止 DataCloneError
 */
export function toPlainRecord(rec: BorrowRecord): BorrowRecord {
  return {
    id: String(rec.id || ''),
    library: rec.library === 'hzlib' ? 'hzlib' : 'zjlib',
    subLibrary: String(rec.subLibrary || ''),
    account: String(rec.account || ''),
    status: rec.status === 'borrowed' ? 'borrowed' : 'returned',
    title: String(rec.title || ''),
    author: String(rec.author || ''),
    isbn: String(rec.isbn || ''),
    callNo: String(rec.callNo || ''),
    barcode: String(rec.barcode || ''),
    bibId: String(rec.bibId || ''),
    loanDate: String(rec.loanDate || ''),
    dueDate: String(rec.dueDate || ''),
    returnDate: String(rec.returnDate || ''),
    renewCount: Number(rec.renewCount || 0),
    coverUrl: sanitizeCoverUrl(rec.coverUrl || ''),
    rating: Number(rec.rating || 0),
    verdict: rec.verdict || '',
    tags: Array.isArray(rec.tags) ? [...rec.tags].map(String) : [],
    note: String(rec.note || ''),
    progress: Number(rec.progress ?? (rec.status === 'returned' ? 100 : 20)),
    updatedAt: Number(rec.updatedAt || Date.now()),
  }
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' })
        store.createIndex('library', 'library', { unique: false })
        store.createIndex('status', 'status', { unique: false })
        store.createIndex('loanDate', 'loanDate', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function buildRecordId(raw: Partial<BorrowRecord>): string {
  const lib = raw.library || 'zjlib'
  const cleanTitle = (raw.title || '').trim()
  const barcode = (raw.barcode || '').trim()
  const loanDate = (raw.loanDate || '').trim().slice(0, 10)
  if (barcode && loanDate) {
    return `${lib}:${barcode}:${loanDate}`
  }
  if (barcode) {
    return `${lib}:${barcode}:${cleanTitle}`
  }
  return `${lib}:${cleanTitle}:${loanDate || 'unknown'}`
}

export async function getAllRecords(): Promise<BorrowRecord[]> {
  const db = await openDB()
  const backupMap = getLocalAnnotationsBackup()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readonly')
    const store = tx.objectStore(STORE_RECORDS)
    const req = store.getAll()
    req.onsuccess = () => {
      const list = ((req.result || []) as BorrowRecord[]).map((rec) => {
        const normKey = (rec.title || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase()
        const backup = backupMap[normKey]
        if (
          backup &&
          !rec.rating &&
          !rec.verdict &&
          (!rec.tags || rec.tags.length === 0) &&
          !rec.note
        ) {
          return toPlainRecord({
            ...rec,
            rating: backup.rating || rec.rating,
            verdict: backup.verdict || rec.verdict,
            tags: backup.tags?.length ? [...backup.tags] : rec.tags || [],
            note: backup.note || rec.note,
            progress: backup.progress ?? rec.progress,
          })
        }
        return toPlainRecord(rec)
      })
      list.sort((a, b) => (b.loanDate || '').localeCompare(a.loanDate || ''))
      resolve(list)
    }
    req.onerror = () => reject(req.error)
  })
}

export function isDemoOrBrokenRecord(rec: Partial<BorrowRecord>): boolean {
  const bc = (rec.barcode || '').trim()
  // Demo records have synthetic barcodes ZJ0xxxxxxx or HZ0xxxxxxx
  if (/^(ZJ0|HZ0)\d{7}$/.test(bc)) return true
  // Broken records from old parser where both loanDate and returnDate were empty
  if (!rec.loanDate && !rec.returnDate && !rec.dueDate) return true
  return false
}

export async function purgeDemoAndBrokenRecords(): Promise<number> {
  const all = await getAllRecords()
  const toDelete = all.filter((r) => isDemoOrBrokenRecord(r)).map((r) => r.id)
  if (toDelete.length === 0) return 0
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite')
    const store = tx.objectStore(STORE_RECORDS)
    for (const id of toDelete) {
      store.delete(id)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  return toDelete.length
}

export async function upsertRecords(
  incomingList: Array<Partial<BorrowRecord>>,
  options: {
    keepDemo?: boolean
    source?: 'zjlib' | 'hzlib' | 'mixed'
    account?: string
    isFullOnlineSync?: boolean
  } = {}
): Promise<{ added: number; updated: number; retainedExpired: number; total: number }> {
  // If incoming records are real user records, remove demo & broken records first
  const isIncomingDemo = incomingList.some((r) => /^(ZJ0|HZ0)\d{7}$/.test((r.barcode || '').trim()))
  if (!isIncomingDemo && !options.keepDemo) {
    await purgeDemoAndBrokenRecords()
  }

  const existing = await getAllRecords()
  const existingMap = new Map<string, BorrowRecord>()
  const activeBorrowByBarcode = new Map<string, BorrowRecord>()
  const annotationBackup = getLocalAnnotationsBackup()
  const cleanOptionAccount = (options.account || '').trim()

  for (const rec of existing) {
    existingMap.set(rec.id, rec)
    if (rec.barcode && rec.status === 'borrowed') {
      activeBorrowByBarcode.set(`${rec.library}:${rec.barcode}`, rec)
    }
    if (rec.rating || rec.verdict || (rec.tags && rec.tags.length > 0) || rec.note) {
      saveLocalAnnotationBackup(rec.title, {
        rating: rec.rating,
        verdict: rec.verdict,
        tags: rec.tags || [],
        note: rec.note || '',
        progress: rec.progress || 0,
      })
    }
  }

  let added = 0
  let updated = 0
  const toSave: BorrowRecord[] = []
  const touchedIds = new Set<string>()
  const incomingBorrowedBarcodes = new Set<string>()

  for (const item of incomingList) {
    if (!item.title) continue
    const id = item.id || buildRecordId(item)
    const lib = item.library || 'zjlib'
    const bc = (item.barcode || '').trim()
    if (item.status === 'borrowed' && bc) {
      incomingBorrowedBarcodes.add(`${lib}:${bc}`)
    }
    const prev =
      existingMap.get(id) ||
      (bc ? activeBorrowByBarcode.get(`${lib}:${bc}`) : undefined)

    if (prev) {
      updated++
      const targetId = prev.id || id
      touchedIds.add(targetId)
      const merged: BorrowRecord = {
        ...prev,
        id: targetId,
        library: item.library || prev.library,
        subLibrary: item.subLibrary || prev.subLibrary,
        account: (item.account || cleanOptionAccount || prev.account || '').trim(),
        status: item.status || prev.status,
        title: item.title.trim(),
        author: (item.author ?? prev.author ?? '').trim(),
        isbn: (item.isbn || prev.isbn || '').trim(),
        callNo: (item.callNo || prev.callNo || '').trim(),
        barcode: (item.barcode || prev.barcode || '').trim(),
        bibId: (item.bibId || prev.bibId || '').trim(),
        loanDate: (item.loanDate || prev.loanDate || '').slice(0, 10),
        dueDate: (item.dueDate || prev.dueDate || '').slice(0, 10),
        returnDate: (item.returnDate || prev.returnDate || '').slice(0, 10),
        renewCount: item.renewCount ?? prev.renewCount ?? 0,
        coverUrl: item.coverUrl || prev.coverUrl || '',
        // Preserve user annotations unless explicitly provided
        rating: item.rating !== undefined ? item.rating : prev.rating,
        verdict: item.verdict !== undefined ? item.verdict : prev.verdict,
        tags: item.tags && item.tags.length > 0 ? item.tags : prev.tags || [],
        note: item.note !== undefined && item.note !== '' ? item.note : prev.note || '',
        progress:
          item.progress !== undefined
            ? item.progress
            : item.status === 'returned' && prev.progress === 0
              ? 100
              : prev.progress,
        updatedAt: Date.now(),
      }
      existingMap.set(targetId, merged)
      toSave.push(merged)
    } else {
      added++
      touchedIds.add(id)
      const normTitleKey = item.title.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase()
      const savedAnnot = annotationBackup[normTitleKey]
      const created: BorrowRecord = {
        id,
        library: item.library || 'zjlib',
        subLibrary: item.subLibrary || (item.library === 'hzlib' ? '杭州图书馆' : '浙江图书馆'),
        account: (item.account || cleanOptionAccount || '').trim(),
        status: item.status || 'returned',
        title: item.title.trim(),
        author: (item.author || '').trim(),
        isbn: (item.isbn || '').trim(),
        callNo: (item.callNo || '').trim(),
        barcode: (item.barcode || '').trim(),
        bibId: (item.bibId || '').trim(),
        loanDate: (item.loanDate || '').slice(0, 10),
        dueDate: (item.dueDate || '').slice(0, 10),
        returnDate: (item.returnDate || '').slice(0, 10),
        renewCount: item.renewCount ?? 0,
        coverUrl: item.coverUrl || '',
        rating: item.rating ?? savedAnnot?.rating ?? 0,
        verdict: item.verdict ?? savedAnnot?.verdict ?? '',
        tags: item.tags ?? savedAnnot?.tags ?? [],
        note: item.note ?? savedAnnot?.note ?? '',
        progress:
          item.progress ??
          savedAnnot?.progress ??
          (item.status === 'returned' ? 100 : 20),
        updatedAt: Date.now(),
      }
      existingMap.set(id, created)
      toSave.push(created)
    }
  }

  // 处理同账号下因图书馆服务器年限过期而未再返回的历史记录：
  // 1. 永久保留在本地 IndexedDB 中，绝不删除
  // 2. 若旧记录尚未标记 account，自动补齐为当前同馆同步账号
  // 3. 若本次为在线全量同步，且本地某条旧记录仍为 borrowed 但已不在服务器当前在借列表中，自动闭合为 returned
  let retainedExpired = 0
  const targetSource = options.source
  if (targetSource === 'zjlib' || targetSource === 'hzlib') {
    for (const rec of existing) {
      if (rec.library !== targetSource) continue
      if (touchedIds.has(rec.id)) continue
      const isSameOrUnboundAccount =
        !rec.account || !cleanOptionAccount || rec.account === cleanOptionAccount
      if (!isSameOrUnboundAccount) continue

      retainedExpired++
      let needUpdate = false
      const patched: BorrowRecord = { ...rec }
      if (!patched.account && cleanOptionAccount) {
        patched.account = cleanOptionAccount
        needUpdate = true
      }
      if (
        options.isFullOnlineSync &&
        patched.status === 'borrowed' &&
        (!patched.barcode || !incomingBorrowedBarcodes.has(`${targetSource}:${patched.barcode}`))
      ) {
        patched.status = 'returned'
        if (patched.progress < 100) patched.progress = 100
        needUpdate = true
      }
      if (needUpdate) {
        patched.updatedAt = Date.now()
        existingMap.set(patched.id, patched)
        toSave.push(patched)
      }
    }
  }

  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite')
    const store = tx.objectStore(STORE_RECORDS)
    for (const rec of toSave) {
      store.put(toPlainRecord(rec))
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })

  return { added, updated, retainedExpired, total: existingMap.size }
}

export async function updateRecordUserMeta(
  id: string,
  patch: Partial<
    Pick<
      BorrowRecord,
      'rating' | 'verdict' | 'tags' | 'note' | 'progress' | 'status' | 'returnDate' | 'dueDate' | 'renewCount'
    >
  >
): Promise<BorrowRecord | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite')
    const store = tx.objectStore(STORE_RECORDS)
    const getReq = store.get(id)
    getReq.onsuccess = () => {
      const existing = getReq.result as BorrowRecord | undefined
      if (!existing) {
        resolve(null)
        return
      }
      const cleanPatch: Partial<BorrowRecord> = {
        ...patch,
        tags: patch.tags !== undefined ? [...patch.tags].map(String) : existing.tags,
      }
      const updated: BorrowRecord = toPlainRecord({
        ...existing,
        ...cleanPatch,
        updatedAt: Date.now(),
      })
      store.put(updated)
      saveLocalAnnotationBackup(updated.title, {
        rating: updated.rating,
        verdict: updated.verdict,
        tags: updated.tags || [],
        note: updated.note || '',
        progress: updated.progress || 0,
      })
      tx.oncomplete = () => resolve(updated)
    }
    getReq.onerror = () => reject(getReq.error)
  })
}

export async function deleteRecordById(id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite')
    tx.objectStore(STORE_RECORDS).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function clearAllRecords(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite')
    tx.objectStore(STORE_RECORDS).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function clearAllLocalData(): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_RECORDS, STORE_META], 'readwrite')
    tx.objectStore(STORE_RECORDS).clear()
    tx.objectStore(STORE_META).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  try {
    localStorage.removeItem(LOCAL_NOTES_BACKUP_KEY)
  } catch {
    // ignore
  }
}

export async function getSyncMeta(): Promise<SyncMeta> {
  const db = await openDB()
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_META, 'readonly')
    const req = tx.objectStore(STORE_META).get('sync_meta')
    req.onsuccess = () => resolve(req.result?.value || {})
    req.onerror = () => resolve({})
  })
}

export async function saveSyncMeta(patch: Partial<SyncMeta>): Promise<SyncMeta> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite')
    const store = tx.objectStore(STORE_META)
    const getReq = store.get('sync_meta')
    let next: SyncMeta = { ...patch }
    getReq.onsuccess = () => {
      const current: SyncMeta = (getReq.result && getReq.result.value) || {}
      next = { ...current, ...patch }
      store.put({ key: 'sync_meta', value: next })
    }
    tx.oncomplete = () => resolve(next)
    tx.onerror = () => reject(tx.error)
  })
}
export async function batchUpdateCoverUrls(coverMap: Record<string, string>): Promise<number> {
  const entries = Object.entries(coverMap).filter(([, url]) => Boolean(url))
  if (entries.length === 0) return 0
  const db = await openDB()
  let updatedCount = 0
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite')
    const store = tx.objectStore(STORE_RECORDS)
    for (const [id, coverUrl] of entries) {
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const rec = getReq.result as BorrowRecord | undefined
        if (rec && rec.coverUrl !== coverUrl) {
          rec.coverUrl = coverUrl
          store.put(rec)
          updatedCount++
        }
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  return updatedCount
}

export async function clearCoverUrlsByIds(ids: string[]): Promise<number> {
  const validIds = ids.filter(Boolean)
  if (validIds.length === 0) return 0
  const db = await openDB()
  let clearedCount = 0
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite')
    const store = tx.objectStore(STORE_RECORDS)
    for (const id of validIds) {
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const rec = getReq.result as BorrowRecord | undefined
        if (rec && rec.coverUrl) {
          rec.coverUrl = ''
          store.put(rec)
          clearedCount++
        }
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  return clearedCount
}
