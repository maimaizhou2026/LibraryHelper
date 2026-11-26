/**
 * 浏览器端境内直连中转通道 (Browser -> 阿里云杭州 FC -> 浙图/杭图)
 *
 * 采用 W3C CORS Simple Request (POST + text/plain;charset=UTF-8) 直连杭州函数计算节点，
 * 免除 OPTIONS 预检并彻底绕开香港 Vercel (hkg1) 跨境防火墙阻断。
 */

const DEFAULT_CN_RELAY_URL = 'https://library-relay-rppetguhkz.cn-hangzhou.fcapp.run'
const ZJLIB_ORG_ID = '1916318653650423810'
const ZJLIB_API_BASE = 'https://www.zjlib.cn/bff-api'

export function getCnRelayUrl(): string {
  try {
    const custom = localStorage.getItem('lh_cn_relay_url')?.trim()
    if (custom) return custom
  } catch {
    // ignore storage error
  }
  const envUrl = (import.meta as any).env?.VITE_CN_RELAY_URL
  if (typeof envUrl === 'string' && envUrl.trim()) return envUrl.trim()
  return DEFAULT_CN_RELAY_URL
}

export function shouldPreferCnDirect(): boolean {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname.toLowerCase()
  // 本地开发 (localhost / 127.0.0.1) 默认优先走本地 Vite 插件，线上域名直接走杭州阿里云中转
  if (host === 'localhost' || host === '127.0.0.1') {
    return localStorage.getItem('lh_force_cn_relay') === '1'
  }
  return true
}

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0)
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function base64ToUtf8(b64: string): string {
  if (!b64) return ''
  return new TextDecoder('utf-8').decode(base64ToBytes(b64))
}

export interface RelayUpstreamResponse {
  ok: boolean
  status: number
  headers: Record<string, string>
  setCookies: string[]
  bodyBase64: string
  text: () => string
  json: () => any
  bytes: () => Uint8Array
}

export async function cnRelayFetch(
  targetUrl: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    redirect?: 'follow' | 'manual'
    timeoutMs?: number
  }
): Promise<RelayUpstreamResponse> {
  const relayUrl = getCnRelayUrl()
  const u = new URL(targetUrl)
  const reqHeaders: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, text/html, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
  if (u.hostname.includes('zjlib.cn')) {
    reqHeaders.Origin = 'https://www.zjlib.cn'
    reqHeaders.Referer = 'https://www.zjlib.cn/'
  } else if (u.hostname.includes('zjhzlib.cn')) {
    reqHeaders.Origin = `${u.protocol}//${u.host}`
    reqHeaders.Referer = `${u.protocol}//${u.host}/opac/reader/login`
  }
  if (init?.headers) {
    for (const [k, v] of Object.entries(init.headers)) {
      if (v !== undefined && v !== null) reqHeaders[k] = String(v)
    }
  }

  const payload = JSON.stringify({
    url: targetUrl,
    method: (init?.method || 'GET').toUpperCase(),
    headers: reqHeaders,
    bodyBase64: init?.body ? utf8ToBase64(init.body) : '',
    redirect: init?.redirect || 'follow',
    timeoutMs: init?.timeoutMs || 8500,
  })

  // 使用 text/plain;charset=UTF-8 构造 CORS 简单请求，浏览器直接发送 POST 不触发 OPTIONS 预检
  const resp = await window.fetch(relayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
    },
    body: payload,
  })
  const data = await resp.json()
  if (data?.relayError) {
    throw new Error(data.message || `中转请求失败 (${data.errorCode || 'RELAY_ERR'})`)
  }
  const status = Number(data?.status || 200)
  const bodyBase64 = String(data?.bodyBase64 || '')
  const setCookies = Array.isArray(data?.setCookies) ? data.setCookies.map(String) : []
  const lowerHeaders: Record<string, string> = {}
  if (data?.headers && typeof data.headers === 'object') {
    for (const [k, v] of Object.entries(data.headers)) {
      if (v !== undefined && v !== null) lowerHeaders[k.toLowerCase()] = String(v)
    }
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: lowerHeaders,
    setCookies,
    bodyBase64,
    text: () => base64ToUtf8(bodyBase64),
    json: () => {
      const t = base64ToUtf8(bodyBase64)
      return t ? JSON.parse(t) : {}
    },
    bytes: () => base64ToBytes(bodyBase64),
  }
}

function isPlaceholderCover(url: string): boolean {
  if (!url) return true
  const lower = url.toLowerCase()
  return (
    lower.includes('d9fa61ec5b294296a2a53bfe5a167c91') ||
    lower.includes('fb87c5fae030416d8f9629c56451e355') ||
    lower.includes('5133167f051e4f9a8c8797b35577ef4f') ||
    lower.includes('3593b961f9094da9887a8cbb2105d18c') ||
    lower.includes('fbc18786cafb44babc3b3b666bb0710c') ||
    lower.includes('1a8b6e68853e4278bd05ed5a05844deb') ||
    lower.includes('bigbg.png') ||
    lower.includes('default_book') ||
    lower.includes('no_pic') ||
    lower.includes('nopic') ||
    lower.includes('zanwu') ||
    lower.includes('xinhuapic.oss') ||
    lower.includes('doubanio.com') ||
    lower.endsWith('.null')
  )
}

const HZLIB_CAPTCHA_FIELDS = [
  'returnCode', 'randomCode', 'validateCode', 'vcode', 'checkCode', 'code',
  'verifyCode', 'validCode', 'vercode', 'verCode', 'captcha', 'captchaCode',
  'rand', 'randCode', 'imageCode', 'imgCode', 'authCode', 'securityCode',
  'rdVcode', 'rdValidateCode', 'loginValidateCode', 'loginCode', 'vcodeImg',
  'j_captcha', 'kaptcha', 'inputCode', 'validate', 'vc', 'yzm', 'checkcode',
]

export async function handleHzlibCaptchaDirect(urlStr: string): Promise<any> {
  const u = new URL(urlStr, 'http://localhost')
  const includeImage = u.searchParams.get('mode') !== 'init'
  const loginRes = await cnRelayFetch('https://my1.zjhzlib.cn/opac/reader/login')
  const jsessionMatch = loginRes.setCookies.join('; ').match(/JSESSIONID=[^;]+/)
  const sessionCookie = jsessionMatch ? jsessionMatch[0] : ''

  const pemRes = await cnRelayFetch(
    `https://my1.zjhzlib.cn/opac/certificate/pem?checkCode=${Date.now()}opac`,
    { headers: { Cookie: sessionCookie } }
  )
  const pemKey = pemRes.text()
  if (!includeImage) {
    return { ok: true, sessionCookie, pemKey, captchaImage: '' }
  }
  const vcRes = await cnRelayFetch(
    `https://my1.zjhzlib.cn/opac/validateCodeImage?r=${Math.random()}`,
    { headers: { Cookie: sessionCookie } }
  )
  return {
    ok: true,
    sessionCookie,
    pemKey,
    captchaImage: `data:image/jpeg;base64,${vcRes.bodyBase64}`,
  }
}

interface RawHzRow {
  actionType: string
  barcode: string
  title: string
  isbn: string
  author: string
  callNo: string
  subLibrary: string
  docType: string
  loanDate: string
  dueDate: string
  processDate: string
  bibId: string
  renewCount?: number
}

function parseHzlibDomRows(html: string): { rows: RawHzRow[]; hasNextPage: boolean; pdsToken: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pdsToken = (doc.querySelector('input[name="pdsToken"]') as HTMLInputElement | null)?.value?.trim() || ''
  const hasNextPage = (doc.querySelector('input[name="hasNextPage"]') as HTMLInputElement | null)?.value === 'true'
  const table = doc.querySelector('#contentTable') || doc.querySelector('table')
  if (!table) return { rows: [], hasNextPage: false, pdsToken }

  const trs = Array.from(table.querySelectorAll('tr'))
  const headers = Array.from(trs[0]?.querySelectorAll('th, td') || []).map((el) => {
    const clone = el.cloneNode(true) as HTMLElement
    clone.querySelectorAll('select, script, style').forEach((n) => n.remove())
    return (clone.textContent || '').replace(/\s+/g, '').trim().toLowerCase()
  })

  const rows: RawHzRow[] = []
  for (const tr of trs.slice(1)) {
    const cells = Array.from(tr.querySelectorAll('td'))
    if (cells.length < 3) continue
    const rowMap: Record<string, string> = {}
    let bookrecno = ''
    cells.forEach((cell, idx) => {
      const h = headers[idx] || `col_${idx}`
      rowMap[h] = (cell.textContent || '').replace(/\s+/g, ' ').trim()
      const link = cell.querySelector('a[href*="/book/"]')?.getAttribute('href') || ''
      const m = link.match(/\/book\/([0-9a-zA-Z_-]+)/)
      if (m) bookrecno = m[1]
    })
    const title =
      rowMap['题名'] ||
      rowMap['书名'] ||
      rowMap['题名/责任者']?.split('/')[0]?.trim() ||
      ''
    if (!title) continue
    const author =
      rowMap['著者'] ||
      rowMap['责任者'] ||
      rowMap['作者'] ||
      (rowMap['题名/责任者']?.includes('/')
        ? rowMap['题名/责任者'].split('/').slice(1).join('/').trim()
        : '') ||
      ''
    rows.push({
      actionType: rowMap['操作类型'] || '',
      barcode: (rowMap['条码号'] || rowMap['图书条码'] || '').trim(),
      title: title.trim(),
      isbn: (rowMap['isbn'] || rowMap['isbn/issn'] || '').trim(),
      author: author.trim(),
      callNo: (rowMap['索书号'] || '').trim(),
      subLibrary:
        (rowMap['馆藏地点'] || rowMap['馆藏地'] || rowMap['所属馆'] || rowMap['借阅地点'] || '').trim() ||
        '杭州图书馆',
      docType: (rowMap['文献类型'] || '').trim(),
      loanDate: (rowMap['借出时间'] || rowMap['借出日期'] || rowMap['借书日期'] || '').slice(0, 10),
      dueDate: (rowMap['应还日期'] || rowMap['应还时间'] || rowMap['到期日期'] || '').slice(0, 10),
      processDate: (
        rowMap['处理时间'] || rowMap['归还日期'] || rowMap['还书日期'] || rowMap['操作日期'] || ''
      ).slice(0, 10),
      bibId: bookrecno,
      renewCount:
        rowMap['续借次数'] !== undefined && rowMap['续借次数'] !== ''
          ? Number(rowMap['续借次数'])
          : undefined,
    })
  }
  return { rows, hasNextPage, pdsToken }
}

export async function handleHzlibSyncDirect(body: any): Promise<any> {
  const account = String(body.account || '').trim()
  const encryptedPwd = String(body.encryptedPassword || '').trim()
  let sessionCookie = String(body.cookie || '').trim()
  const loginSessionCookie = String(body.loginSessionCookie || '').trim()
  const captchaCode = String(body.captchaCode || '').trim()
  const captchaSessionCookie = String(body.captchaSessionCookie || '').trim()
  const maxPages = Math.min(Number(body.maxPages) || 20, 50)

  if (!sessionCookie) {
    sessionCookie = captchaCode && captchaSessionCookie ? captchaSessionCookie : loginSessionCookie
    const formData = new URLSearchParams()
    formData.set('vToken', '')
    formData.set('rdLoginId', account)
    formData.set('p', '')
    formData.set('rdPasswd', encryptedPwd)
    formData.set('returnUrl', '')
    formData.set('password', '')
    if (captchaCode) {
      for (const f of HZLIB_CAPTCHA_FIELDS) formData.set(f, captchaCode)
    }
    const loginResp = await cnRelayFetch('https://my1.zjhzlib.cn/opac/reader/doLogin', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: sessionCookie,
        Referer: 'https://my1.zjhzlib.cn/opac/reader/login',
      },
      body: formData.toString(),
    })
    const newMatch = loginResp.setCookies.join('; ').match(/JSESSIONID=[^;]+/)
    if (newMatch) sessionCookie = newMatch[0]

    if (loginResp.status === 200) {
      const loginHtml = loginResp.text()
      if (loginHtml.includes('id="loginForm"')) {
        const doc = new DOMParser().parseFromString(loginHtml, 'text/html')
        const errText =
          doc.querySelector('#tipForlogin')?.textContent?.trim() ||
          doc.querySelector('.form label[style*="red"]')?.textContent?.trim() ||
          '账号或密码不正确，请确认杭图读者证/身份证号及借书密码'
        const nextCaptcha = await handleHzlibCaptchaDirect('/api/hzlib/captcha')
        return {
          ok: false,
          needCaptcha: true,
          ...nextCaptcha,
          message: errText.includes('验证码')
            ? '触发杭图图形验证码校验，请确认借书密码并输入下方 4 位验证码重试：'
            : `${errText}（提示：输错 1 次密码后杭图会要求校验图形验证码，请填写下方验证码重试）`,
        }
      }
    }
  }

  const rawCurrentRows: RawHzRow[] = []
  for (let p = 1; p <= 10; p++) {
    const curResp = await cnRelayFetch(
      `https://my1.zjhzlib.cn/opac/loan/currentLoanList?page=${p}&rows=100`,
      { headers: { Cookie: sessionCookie } }
    )
    const curHtml = curResp.text()
    if (curHtml.includes('id="loginForm"')) {
      return { ok: false, message: '杭州图书馆登录态无效或已过期，请检查账号密码' }
    }
    const parsed = parseHzlibDomRows(curHtml)
    rawCurrentRows.push(...parsed.rows)
    if (!parsed.hasNextPage || parsed.rows.length === 0) break
  }

  const renewByBarcode = new Map<string, number>()
  try {
    const renewResp = await cnRelayFetch(
      'https://my1.zjhzlib.cn/opac/loan/renewList?page=1&rows=100',
      { headers: { Cookie: sessionCookie } }
    )
    for (const r of parseHzlibDomRows(renewResp.text()).rows) {
      if (r.barcode && typeof r.renewCount === 'number' && !Number.isNaN(r.renewCount)) {
        renewByBarcode.set(r.barcode, r.renewCount)
      }
    }
  } catch {
    // ignore
  }

  const rawHistoryRows: RawHzRow[] = []
  for (let p = 1; p <= maxPages; p++) {
    const hisResp = await cnRelayFetch(
      `https://my1.zjhzlib.cn/opac/loan/historyLoanList?page=${p}&rows=100`,
      { headers: { Cookie: sessionCookie } }
    )
    const parsed = parseHzlibDomRows(hisResp.text())
    rawHistoryRows.push(...parsed.rows)
    if (!parsed.hasNextPage || parsed.rows.length === 0) break
  }

  const currentRecords: any[] = []
  const activeBorrowSkipCount = new Map<string, number>()
  for (const r of rawCurrentRows) {
    const key = `${r.barcode}:${r.loanDate}`
    activeBorrowSkipCount.set(key, (activeBorrowSkipCount.get(key) || 0) + 1)
    const exactRenew = renewByBarcode.get(r.barcode)
    let inferredRenew = exactRenew !== undefined ? exactRenew : r.renewCount || 0
    if (exactRenew === undefined && r.loanDate && r.dueDate) {
      const span = Math.round((new Date(r.dueDate).getTime() - new Date(r.loanDate).getTime()) / 86400000)
      if (span > 60) inferredRenew = 2
      else if (span > 43) inferredRenew = 1
    }
    currentRecords.push({
      id: `hzlib:${r.barcode}:${r.loanDate || 'current'}`,
      library: 'hzlib',
      subLibrary: r.subLibrary || '杭州图书馆',
      status: 'borrowed',
      title: r.title,
      author: r.author,
      isbn: r.isbn,
      callNo: r.callNo,
      barcode: r.barcode,
      bibId: r.bibId,
      loanDate: r.loanDate,
      dueDate: r.dueDate,
      returnDate: '',
      renewCount: inferredRenew,
      coverUrl: '',
    })
  }

  const byBarcode = new Map<string, RawHzRow[]>()
  for (const r of rawHistoryRows) {
    const key = r.barcode || r.title
    if (!byBarcode.has(key)) byBarcode.set(key, [])
    byBarcode.get(key)!.push(r)
  }

  const historyRecords: any[] = []
  for (const [barcodeKey, group] of byBarcode.entries()) {
    const chronological = [...group].reverse()
    const pendingBorrows: RawHzRow[] = []
    for (const item of chronological) {
      if (item.actionType.includes('借')) {
        const activeKey = `${item.barcode}:${item.processDate}`
        const skipLeft = activeBorrowSkipCount.get(activeKey) || 0
        if (skipLeft > 0) {
          activeBorrowSkipCount.set(activeKey, skipLeft - 1)
          continue
        }
        pendingBorrows.push(item)
      } else if (item.actionType.includes('还')) {
        const matchedBorrow = pendingBorrows.shift()
        const loanDate = matchedBorrow?.processDate || item.loanDate || item.processDate
        const returnDate = item.processDate
        historyRecords.push({
          id: `hzlib:${barcodeKey}:${loanDate}:${returnDate}`,
          library: 'hzlib',
          subLibrary: item.subLibrary || matchedBorrow?.subLibrary || '杭州图书馆',
          status: 'returned',
          title: item.title || matchedBorrow?.title || '',
          author: item.author || matchedBorrow?.author || '',
          isbn: item.isbn || matchedBorrow?.isbn || '',
          callNo: item.callNo || matchedBorrow?.callNo || '',
          barcode: item.barcode || matchedBorrow?.barcode || '',
          bibId: item.bibId || matchedBorrow?.bibId || '',
          loanDate,
          dueDate: '',
          returnDate,
          renewCount: 0,
          coverUrl: '',
        })
      }
    }
    for (const leftover of pendingBorrows) {
      if (currentRecords.some((c) => c.barcode === leftover.barcode)) continue
      historyRecords.push({
        id: `hzlib:${barcodeKey}:${leftover.processDate}:hist`,
        library: 'hzlib',
        subLibrary: leftover.subLibrary || '杭州图书馆',
        status: 'returned',
        title: leftover.title,
        author: leftover.author,
        isbn: leftover.isbn,
        callNo: leftover.callNo,
        barcode: leftover.barcode,
        bibId: leftover.bibId,
        loanDate: leftover.processDate,
        dueDate: '',
        returnDate: '',
        renewCount: 0,
        coverUrl: '',
      })
    }
  }
  historyRecords.sort((a, b) =>
    (b.loanDate || b.returnDate || '').localeCompare(a.loanDate || a.returnDate || '')
  )

  return {
    ok: true,
    sessionCookie,
    records: [...currentRecords, ...historyRecords],
    summary: { currentCount: currentRecords.length, historyCount: historyRecords.length },
  }
}

export async function handleZjlibQrDirect(urlStr: string): Promise<any> {
  const u = new URL(urlStr, 'http://localhost')
  const action = u.searchParams.get('action') || 'create'
  const type = u.searchParams.get('type') || 'wechat'
  const uuid = u.searchParams.get('uuid') || ''
  const headers = { 'BFF-ORG-ID': ZJLIB_ORG_ID }

  if (action === 'status' && uuid) {
    const stJson = (
      await cnRelayFetch(
        `${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/qr/status?uuid=${encodeURIComponent(uuid)}`,
        { headers }
      )
    ).json()
    return {
      ok: stJson.code === 200,
      status: stJson.data?.status || '',
      token: stJson.data?.status === 'COMPLETE' ? stJson.data?.data || '' : '',
      message: stJson.desc || '',
    }
  }

  const endpoint =
    type === 'alipay'
      ? `${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/login/zfb-qr`
      : `${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/login/wechat-qr`
  const qrJson = (await cnRelayFetch(endpoint, { headers })).json()
  if (qrJson.code !== 200 || !qrJson.data) {
    return { ok: false, message: qrJson.desc || '获取二维码失败' }
  }
  const qrCode =
    type === 'wechat' && !String(qrJson.data.qrCode).startsWith('data:')
      ? `data:image/png;base64,${qrJson.data.qrCode}`
      : qrJson.data.qrCode
  return { ok: true, uuid: qrJson.data.uuid, qrCode, type }
}

export async function handleZjlibSyncDirect(body: any): Promise<any> {
  let token = String(body.token || '').trim()
  const account = String(body.account || '').trim()
  const encryptedPassword = String(body.encryptedPassword || '').trim()
  const maxPages = Math.min(Number(body.maxPages) || 20, 50)

  if (!token && account && encryptedPassword) {
    const loginData = (
      await cnRelayFetch(`${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'BFF-ORG-ID': ZJLIB_ORG_ID },
        body: JSON.stringify({ account, password: encryptedPassword, type: 1 }),
      })
    ).json()
    if (loginData.code !== 200 || !loginData.data) {
      return {
        ok: false,
        message:
          loginData.desc ||
          loginData.message ||
          '浙江图书馆账号或密码错误（您也可以直接切换上方「微信/支付宝扫码」一键登录同步）',
      }
    }
    token = loginData.data
  }

  if (!token) {
    return { ok: false, message: '请提供浙江图书馆登录凭证或账号密码' }
  }

  const headers = {
    'Content-Type': 'application/json',
    'BFF-ORG-ID': ZJLIB_ORG_ID,
    'BFF-USER-TOKEN': token,
    Cookie: `userToken=${token}; bffUserToken=${token}`,
  }

  const curJson = (
    await cnRelayFetch(`${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/myLoans/current-loan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ haveRegister: 1 }),
    })
  ).json()
  if (curJson.code !== 200) {
    return { ok: false, message: curJson.message || curJson.desc || 'Token 已失效，请重新登录' }
  }

  const normalized: any[] = []
  for (const item of curJson.data || []) {
    normalized.push({
      library: 'zjlib',
      subLibrary: item.newBook ? '浙图·网借新书' : item.cirTypeName || '浙江图书馆',
      status: 'borrowed',
      title: item.title || '',
      author: item.author || '',
      isbn: item.isbn || '',
      callNo: item.callNo || '',
      barcode: item.barcode || '',
      bibId: item.bibId || '',
      loanDate: (item.loanDate || '').slice(0, 10),
      dueDate: (item.dueDate || '').slice(0, 10),
      returnDate: '',
      renewCount: Number(item.renewCount || 0),
      coverUrl: isPlaceholderCover(item.coverUrl || '') ? '' : item.coverUrl,
    })
  }

  for (let current = 1; current <= maxPages; current++) {
    const hisJson = (
      await cnRelayFetch(`${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/myLoans/history-loan`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          startDate: '',
          endDate: '',
          sortDesc: true,
          sortColumns: 'loanDate',
          searchValue: '',
          newBook: null,
          size: 100,
          current,
          haveRegister: 1,
        }),
      })
    ).json()
    if (hisJson.code !== 200 || !hisJson.data) break
    const records = hisJson.data.records || []
    const total = Number(hisJson.data.total || 0)
    for (const item of records) {
      normalized.push({
        library: 'zjlib',
        subLibrary: item.newBook ? '浙图·网借新书' : item.cirTypeName || '浙江图书馆',
        status: 'returned',
        title: item.title || '',
        author: item.author || '',
        isbn: item.isbn || '',
        callNo: item.callNo || '',
        barcode: item.barcode || '',
        bibId: item.bibId || '',
        loanDate: (item.loanDate || '').slice(0, 10),
        dueDate: (item.dueDate || '').slice(0, 10),
        returnDate: (item.createTime || item.returnDate || '').slice(0, 10),
        renewCount: 0,
        coverUrl: isPlaceholderCover(item.coverUrl || '') ? '' : item.coverUrl,
      })
    }
    if (records.length < 100 || normalized.length >= total + (curJson.data?.length || 0)) break
  }

  return {
    ok: true,
    token,
    records: normalized,
    summary: {
      currentCount: (curJson.data || []).length,
      historyCount: normalized.length - (curJson.data || []).length,
    },
  }
}

export async function handleLoanRenewDirect(body: any): Promise<any> {
  const library: 'zjlib' | 'hzlib' = body.library || 'zjlib'
  const barcode = String(body.barcode || '').trim()
  if (!barcode) return { ok: false, message: '该图书缺少条码号，无法发起在线续借' }

  if (library === 'zjlib') {
    let token = String(body.token || '').trim()
    const account = String(body.account || '').trim()
    const encryptedPassword = String(body.encryptedPassword || '').trim()
    if (!token && account && encryptedPassword) {
      const loginResp = (
        await cnRelayFetch(`${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'BFF-ORG-ID': ZJLIB_ORG_ID },
          body: JSON.stringify({ account, password: encryptedPassword, type: 1 }),
        })
      ).json()
      if (loginResp?.code === 200 && loginResp.data) token = loginResp.data
    }
    if (!token) return { ok: false, message: '未检测到浙江图书馆登录态，请先在「导入/更新记录」中登录' }

    const zjHeaders = {
      'Content-Type': 'application/json',
      'BFF-ORG-ID': ZJLIB_ORG_ID,
      'BFF-USER-TOKEN': token,
      Cookie: `userToken=${token}; bffUserToken=${token}`,
    }
    let readerCardNo = account
    try {
      const uInfo = (
        await cnRelayFetch(`${ZJLIB_API_BASE}/reader-sso-service/portal-pc-api/enc/user-info`, {
          headers: zjHeaders,
        })
      ).json()
      if (uInfo?.code === 200 && uInfo.data) {
        readerCardNo =
          uInfo.data.plaintextCardNum ||
          uInfo.data.plaintextIdCard ||
          uInfo.data.plaintextMobilePhone ||
          readerCardNo
      }
    } catch {
      // ignore
    }
    const renewResp = (
      await cnRelayFetch(`${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/myOrder/batch/renew`, {
        method: 'POST',
        headers: zjHeaders,
        body: JSON.stringify({ barcodeList: [barcode], channel: 3, readerCardNo }),
      })
    ).json()
    const msgItem = renewResp?.data?.circulateMsgVOList?.[0]
    const isSuccess =
      renewResp?.code === 200 &&
      (msgItem?.code === '2000080021' || String(msgItem?.message || '').includes('成功'))
    let newDueDate = ''
    let newRenewCount = 1
    try {
      const curResp = (
        await cnRelayFetch(`${ZJLIB_API_BASE}/portal-admin-service/portal-pc-api/myLoans/current-loan`, {
          method: 'POST',
          headers: zjHeaders,
          body: JSON.stringify({ haveRegister: 1 }),
        })
      ).json()
      const matched = (curResp?.data || []).find((x: any) => x.barcode === barcode)
      if (matched) {
        newDueDate = (matched.dueDate || '').slice(0, 10)
        newRenewCount = Math.max(Number(matched.renewCount || 0), 1)
      }
    } catch {
      // ignore
    }
    return {
      ok: isSuccess,
      token,
      dueDate: newDueDate,
      renewCount: newRenewCount,
      message:
        msgItem?.message ||
        renewResp?.desc ||
        (isSuccess ? '浙江图书馆续借成功！' : '续借失败（每本图书最多可续借 1 次）'),
    }
  }

  // 杭州图书馆在线续借
  const account = String(body.account || '').trim()
  const encryptedPwd = String(body.encryptedPassword || '').trim()
  let sessionCookie = String(body.sessionCookie || body.cookie || '').trim()
  const loginSessionCookie = String(body.loginSessionCookie || '').trim()
  const captchaCode = String(body.captchaCode || '').trim()
  const captchaSessionCookie = String(body.captchaSessionCookie || '').trim()
  let renewListHtml = ''

  if (sessionCookie && !captchaCode) {
    const testResp = await cnRelayFetch(
      'https://my1.zjhzlib.cn/opac/loan/renewList?page=1&rows=100',
      { headers: { Cookie: sessionCookie }, redirect: 'manual' }
    )
    if (testResp.status === 200) {
      const html = testResp.text()
      if (!html.includes('id="loginForm"') && html.includes('name="pdsToken"')) {
        renewListHtml = html
      } else {
        sessionCookie = ''
      }
    } else {
      sessionCookie = ''
    }
  }

  if (!sessionCookie) {
    sessionCookie = captchaCode && captchaSessionCookie ? captchaSessionCookie : loginSessionCookie
    const formData = new URLSearchParams()
    formData.set('vToken', '')
    formData.set('rdLoginId', account)
    formData.set('p', '')
    formData.set('rdPasswd', encryptedPwd)
    formData.set('returnUrl', '')
    formData.set('password', '')
    if (captchaCode) {
      for (const f of HZLIB_CAPTCHA_FIELDS) formData.set(f, captchaCode)
    }
    const loginResp = await cnRelayFetch('https://my1.zjhzlib.cn/opac/reader/doLogin', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: sessionCookie,
        Referer: 'https://my1.zjhzlib.cn/opac/reader/login',
      },
      body: formData.toString(),
    })
    const newMatch = loginResp.setCookies.join('; ').match(/JSESSIONID=[^;]+/)
    if (newMatch) sessionCookie = newMatch[0]
    if (loginResp.status === 200 && loginResp.text().includes('id="loginForm"')) {
      const nextCaptcha = await handleHzlibCaptchaDirect('/api/hzlib/captcha')
      return {
        ok: false,
        needCaptcha: true,
        ...nextCaptcha,
        message: '杭图续借需输入 4 位图形验证码，请在下方输入验证码后再次点击续借：',
      }
    }
    renewListHtml = (
      await cnRelayFetch('https://my1.zjhzlib.cn/opac/loan/renewList?page=1&rows=100', {
        headers: { Cookie: sessionCookie },
      })
    ).text()
  }

  const beforeParsed = parseHzlibDomRows(renewListHtml)
  const beforeRow = beforeParsed.rows.find((r) => r.barcode === barcode)
  const beforeDueDate = beforeRow?.dueDate || ''
  const beforeRenewCount = beforeRow?.renewCount ?? 0

  const renewParams = new URLSearchParams()
  if (beforeParsed.pdsToken) renewParams.set('pdsToken', beforeParsed.pdsToken)
  renewParams.set('barcodeList', barcode)
  renewParams.set('furl', '/opac/loan/renewList')
  renewParams.set('renewAll', '')
  const renewResp = await cnRelayFetch('https://my1.zjhzlib.cn/opac/loan/doRenew', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: sessionCookie,
      Referer: 'https://my1.zjhzlib.cn/opac/loan/renewList',
    },
    body: renewParams.toString(),
  })
  const doc = new DOMParser().parseFromString(renewResp.text(), 'text/html')
  const promptEl = doc.querySelector('#page_content #content') || doc.querySelector('#content')
  let promptText = ''
  if (promptEl) {
    const clone = promptEl.cloneNode(true) as HTMLElement
    clone.querySelectorAll('script, style, input, button').forEach((n) => n.remove())
    promptText = (clone.textContent || '')
      .replace(/\s+/g, ' ')
      .replace(/^操作提示\s*[:：]?\s*/, '')
      .trim()
  }

  const afterParsed = parseHzlibDomRows(
    (
      await cnRelayFetch('https://my1.zjhzlib.cn/opac/loan/renewList?page=1&rows=100', {
        headers: { Cookie: sessionCookie },
      })
    ).text()
  )
  const afterRow = afterParsed.rows.find((r) => r.barcode === barcode)
  const newDueDate = afterRow?.dueDate || beforeDueDate
  const updatedRenewCount = afterRow?.renewCount ?? beforeRenewCount
  const isSuccess =
    (newDueDate && beforeDueDate && newDueDate > beforeDueDate) ||
    updatedRenewCount > beforeRenewCount ||
    (promptText.includes('成功') && !promptText.includes('对不起') && !promptText.includes('失败') && !promptText.includes('不能'))

  return {
    ok: isSuccess,
    sessionCookie,
    dueDate: newDueDate,
    renewCount: updatedRenewCount,
    message: isSuccess
      ? promptText
        ? `✅ ${promptText}（最新应还日期：${newDueDate}，已续借 ${updatedRenewCount}/2 次）`
        : `✅ 续借成功！应还日期已延长至：${newDueDate}（已续借 ${updatedRenewCount}/2 次）`
      : promptText || '当前暂无法续借（借期内最多续借2次，或距到期日尚早）',
  }
}
