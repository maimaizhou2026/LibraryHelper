<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  X,
  RefreshCw,
  ShieldCheck,
  AlertCircle,
  QrCode,
  ExternalLink,
  Download,
  Upload,
  FileJson,
  FileSpreadsheet,
  UserCheck,
} from 'lucide-vue-next'
import type { BorrowRecord, SyncMeta } from '../types/library'
import {
  encryptHzlibPasswordClient,
  encryptZjlibPasswordClient,
  loadSavedCredential,
  saveCredentialToStorage,
} from '../utils/cryptoAuth'

async function parseJsonSafe(resp: Response): Promise<any> {
  const text = await resp.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    const preview = text.replace(/\s+/g, ' ').slice(0, 100)
    throw new Error(`接口返回异常 (HTTP ${resp.status})：${preview || '非 JSON 响应'}`)
  }
}

const props = defineProps<{
  open: boolean
  syncMeta: SyncMeta
  totalCount: number
  mobileMode?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (
    e: 'imported',
    payload: {
      records: Array<Partial<BorrowRecord>>
      source: 'zjlib' | 'hzlib' | 'mixed'
      account?: string
      isFullOnlineSync?: boolean
      syncMetaPatch?: Partial<SyncMeta>
    }
  ): void
  (e: 'load-demo'): void
  (e: 'export-json'): void
  (e: 'export-csv'): void
  (e: 'clear-all'): void
}>()

const activeTab = ref<'hzlib' | 'zjlib' | 'backup'>('hzlib')

// 杭州图书馆同步表单
const hzlibAccount = ref('')
const hzlibPassword = ref('')
const hzlibRemember = ref(true)
const hzlibLoading = ref(false)
const hzlibNeedCaptcha = ref(false)
const hzlibCaptchaCode = ref('')
const hzlibCaptchaImage = ref('')
const hzlibCaptchaCookie = ref('')
const hzlibCaptchaPemKey = ref('')

// 浙江图书馆同步表单（默认显示 方式1: 读者证/身份证+密码直连）
const zjlibMode = ref<'account' | 'qr'>('account')
const zjlibToken = ref('')
const zjlibAccount = ref('')
const zjlibPassword = ref('')
const zjlibRemember = ref(true)
const oneClickSyncLoading = ref(false)
const oneClickDoneDialog = ref<{
  title: string
  lines: string[]
} | null>(null)
const zjlibLoading = ref(false)
const zjlibQrType = ref<'wechat' | 'alipay'>('wechat')
const zjlibQrImage = ref('')
const zjlibQrUuid = ref('')
const zjlibQrStatus = ref('')
let zjlibQrTimer: number | null = null

type StatusMsgType = { type: 'success' | 'error' | 'info'; text: string } | null
const hzStatusMsg = ref<StatusMsgType>(null)
const zjStatusMsg = ref<StatusMsgType>(null)
const backupStatusMsg = ref<StatusMsgType>(null)
const backupFileInput = ref<HTMLInputElement | null>(null)

const effectiveHzAccount = computed(() =>
  (props.syncMeta.hzlibAccount || hzlibAccount.value || '').trim()
)
const effectiveZjAccount = computed(() =>
  (props.syncMeta.zjlibAccount || zjlibAccount.value || '').trim()
)

function switchToZjlibTab() {
  activeTab.value = 'zjlib'
  if (zjlibMode.value === 'qr' && !zjlibQrImage.value) {
    startZjlibQr(zjlibQrType.value)
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      stopZjlibQrPoll()
      hzStatusMsg.value = null
      zjStatusMsg.value = null
      backupStatusMsg.value = null
      oneClickDoneDialog.value = null
    } else {
      // 每次打开弹窗时若本地凭据已被退出登录清除，则重置表单输入框
      if (!localStorage.getItem('lh_hzlib_cred')) {
        hzlibAccount.value = ''
        hzlibPassword.value = ''
        hzlibNeedCaptcha.value = false
        hzlibCaptchaCode.value = ''
      }
      if (!localStorage.getItem('lh_zjlib_cred')) {
        zjlibAccount.value = ''
        zjlibPassword.value = ''
      }
      if (!localStorage.getItem('lh_zjlib_token')) {
        zjlibToken.value = ''
      }
      if (activeTab.value === 'zjlib' && zjlibMode.value === 'qr' && !zjlibQrImage.value) {
        startZjlibQr(zjlibQrType.value)
      }
    }
  }
)

function stopZjlibQrPoll() {
  if (zjlibQrTimer) {
    clearInterval(zjlibQrTimer)
    zjlibQrTimer = null
  }
}

async function startZjlibQr(type: 'wechat' | 'alipay' = zjlibQrType.value) {
  stopZjlibQrPoll()
  zjlibQrType.value = type
  zjlibQrImage.value = ''
  zjlibQrStatus.value = '正在生成二维码...'
  try {
    const res = await parseJsonSafe(await fetch(`/api/zjlib/qr?action=create&type=${type}`))
    if (!res.ok) {
      zjlibQrStatus.value = res.message || '获取二维码失败'
      return
    }
    zjlibQrImage.value = res.qrCode
    zjlibQrUuid.value = res.uuid
    zjlibQrStatus.value =
      type === 'wechat' ? '请使用手机微信扫一扫登录浙江图书馆' : '请使用手机支付宝扫一扫登录浙江图书馆'

    zjlibQrTimer = window.setInterval(async () => {
      try {
        const st = await fetch(
          `/api/zjlib/qr?action=status&uuid=${encodeURIComponent(zjlibQrUuid.value)}`
        ).then((r) => parseJsonSafe(r))
        if (st.status === 'SCANNED') {
          zjlibQrStatus.value = '已扫码，请在手机上点击确认授权...'
        } else if (st.status === 'COMPLETE' && st.token) {
          stopZjlibQrPoll()
          zjlibToken.value = st.token
          localStorage.setItem('lh_zjlib_token', st.token)
          zjlibQrStatus.value = '扫码成功！正在自动拉取浙江图书馆借阅记录...'
          await syncZjlibWithToken(st.token)
        }
      } catch {
        // ignore poll error
      }
    }, 2000)
  } catch {
    zjlibQrStatus.value = '获取二维码失败'
  }
}

async function syncZjlibWithToken(tokenValue: string) {
  zjlibLoading.value = true
  try {
    const resp = await fetch('/api/zjlib/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenValue, maxPages: 30 }),
    })
    const data = await parseJsonSafe(resp)
    if (!data.ok) {
      zjStatusMsg.value = { type: 'error', text: data.message || '浙江图书馆同步失败' }
      return
    }
    emit('imported', {
      records: data.records || [],
      source: 'zjlib',
      account: zjlibAccount.value.trim() || props.syncMeta.zjlibAccount || '',
      isFullOnlineSync: true,
    })
    zjStatusMsg.value = {
      type: 'success',
      text: `浙江图书馆同步成功！本次拉取 ${data.records?.length || 0} 条（在借 ${data.summary?.currentCount || 0} 本，历史 ${data.summary?.historyCount || 0} 本），本地超期历史已自动保留`,
    }
  } finally {
    zjlibLoading.value = false
  }
}

onBeforeUnmount(() => {
  stopZjlibQrPoll()
})

// 粘贴/文件导入
onMounted(() => {
  try {
    const hzCred = loadSavedCredential('lh_hzlib_cred')
    hzlibAccount.value = hzCred.account
    hzlibPassword.value = hzCred.password
    hzlibRemember.value = hzCred.remember

    const zjCred = loadSavedCredential('lh_zjlib_cred')
    zjlibAccount.value = zjCred.account
    zjlibPassword.value = zjCred.password
    zjlibRemember.value = zjCred.remember

    const savedZjToken = localStorage.getItem('lh_zjlib_token')
    if (savedZjToken) {
      zjlibToken.value = savedZjToken
    }
  } catch {
    // ignore
  }
})

async function prepareHzlibClientEncryptedPayload(plainPassword: string) {
  if (hzlibNeedCaptcha.value && hzlibCaptchaCookie.value && hzlibCaptchaPemKey.value) {
    return {
      encryptedPassword: encryptHzlibPasswordClient(plainPassword, hzlibCaptchaPemKey.value),
      loginSessionCookie: hzlibCaptchaCookie.value,
    }
  }
  const initResp = await fetch('/api/hzlib/captcha?mode=init')
  const initData = await parseJsonSafe(initResp)
  if (!initData.ok || !initData.pemKey || !initData.sessionCookie) {
    throw new Error(initData.message || '初始化杭州图书馆安全加密会话失败')
  }
  return {
    encryptedPassword: encryptHzlibPasswordClient(plainPassword, initData.pemKey),
    loginSessionCookie: initData.sessionCookie,
  }
}

async function refreshHzlibCaptcha() {
  try {
    const resp = await fetch('/api/hzlib/captcha')
    const data = await parseJsonSafe(resp)
    if (data.ok) {
      hzlibNeedCaptcha.value = true
      hzlibCaptchaImage.value = data.captchaImage || ''
      hzlibCaptchaCookie.value = data.sessionCookie || ''
      hzlibCaptchaPemKey.value = data.pemKey || ''
      hzlibCaptchaCode.value = ''
    }
  } catch {
    // ignore
  }
}

async function handleHzlibOnlineSync() {
  if (!hzlibAccount.value.trim() || !hzlibPassword.value) {
    hzStatusMsg.value = { type: 'error', text: '请填写杭州图书馆读者证号/身份证号和借书密码' }
    return
  }
  if (hzlibNeedCaptcha.value && !hzlibCaptchaCode.value.trim()) {
    hzStatusMsg.value = { type: 'error', text: '请输入 4 位图形验证码' }
    return
  }
  hzlibLoading.value = true
  hzStatusMsg.value = { type: 'info', text: '正在连接杭州图书馆并拉取全量借阅记录...' }
  try {
    saveCredentialToStorage(
      'lh_hzlib_cred',
      hzlibAccount.value,
      hzlibPassword.value,
      hzlibRemember.value
    )

    const { encryptedPassword, loginSessionCookie } = await prepareHzlibClientEncryptedPayload(
      hzlibPassword.value
    )

    const resp = await fetch('/api/hzlib/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: hzlibAccount.value.trim(),
        encryptedPassword,
        loginSessionCookie,
        captchaCode: hzlibNeedCaptcha.value ? hzlibCaptchaCode.value.trim() : '',
        captchaSessionCookie: hzlibNeedCaptcha.value ? hzlibCaptchaCookie.value : '',
        captchaPemKey: hzlibNeedCaptcha.value ? hzlibCaptchaPemKey.value : '',
        maxPages: 30,
      }),
    })
    const data = await parseJsonSafe(resp)
    if (!data.ok) {
      if (data.needCaptcha && data.captchaImage) {
        hzlibNeedCaptcha.value = true
        hzlibCaptchaImage.value = data.captchaImage
        hzlibCaptchaCookie.value = data.sessionCookie || ''
        hzlibCaptchaPemKey.value = data.pemKey || ''
        hzlibCaptchaCode.value = ''
      }
      hzStatusMsg.value = { type: 'error', text: data.message || '杭州图书馆同步失败' }
      return
    }
    hzlibNeedCaptcha.value = false
    hzlibCaptchaCode.value = ''
    if (data.sessionCookie) {
      localStorage.setItem('lh_hzlib_cookie', data.sessionCookie)
    }
    emit('imported', {
      records: data.records || [],
      source: 'hzlib',
      account: hzlibAccount.value.trim(),
      isFullOnlineSync: true,
    })
    hzStatusMsg.value = {
      type: 'success',
      text: `杭州图书馆同步成功！本次拉取 ${data.records?.length || 0} 条（在借 ${data.summary?.currentCount || 0} 本，历史 ${data.summary?.historyCount || 0} 本），本地超期历史已自动保留`,
    }
  } catch (e: any) {
    hzStatusMsg.value = {
      type: 'error',
      text: e?.message || '请求本地代理服务失败，请确认当前处于 npm run dev 本地运行环境',
    }
  } finally {
    hzlibLoading.value = false
  }
}

async function handleZjlibOnlineSync() {
  if (zjlibMode.value === 'account' && (!zjlibAccount.value.trim() || !zjlibPassword.value)) {
    zjStatusMsg.value = { type: 'error', text: '请填写浙江图书馆账号和密码' }
    return
  }
  zjlibLoading.value = true
  zjStatusMsg.value = { type: 'info', text: '正在连接浙江图书馆并拉取当前在借与历史借阅数据...' }
  try {
    saveCredentialToStorage(
      'lh_zjlib_cred',
      zjlibAccount.value,
      zjlibPassword.value,
      zjlibRemember.value
    )
    const encryptedPassword = encryptZjlibPasswordClient(zjlibPassword.value)
    const resp = await fetch('/api/zjlib/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: '',
        account: zjlibAccount.value.trim(),
        encryptedPassword,
        maxPages: 30,
      }),
    })
    const data = await parseJsonSafe(resp)
    if (!data.ok) {
      zjStatusMsg.value = { type: 'error', text: data.message || '浙江图书馆同步失败' }
      return
    }
    if (data.token) {
      zjlibToken.value = data.token
      localStorage.setItem('lh_zjlib_token', data.token)
    }
    emit('imported', {
      records: data.records || [],
      source: 'zjlib',
      account: zjlibAccount.value.trim(),
      isFullOnlineSync: true,
    })
    zjStatusMsg.value = {
      type: 'success',
      text: `浙江图书馆同步成功！本次拉取 ${data.records?.length || 0} 条（在借 ${data.summary?.currentCount || 0} 本，历史 ${data.summary?.historyCount || 0} 本），本地超期历史已自动保留`,
    }
  } catch (e: any) {
    zjStatusMsg.value = {
      type: 'error',
      text: e?.message || '同步浙江图书馆失败',
    }
  } finally {
    zjlibLoading.value = false
  }
}

async function handleOneClickSyncAll() {
  const hasHz = Boolean(hzlibAccount.value.trim() && hzlibPassword.value)
  const hasZj = Boolean(zjlibAccount.value.trim() && zjlibPassword.value)
  if (!hasHz && !hasZj) {
    const msg = {
      type: 'error' as const,
      text: '请先至少在一个图书馆填写账号与密码后再点击「一键同步」',
    }
    if (activeTab.value === 'hzlib') hzStatusMsg.value = msg
    else zjStatusMsg.value = msg
    return
  }
  oneClickSyncLoading.value = true
  if (hasHz) hzStatusMsg.value = { type: 'info', text: '正在同步杭州图书馆借阅记录...' }
  if (hasZj) zjStatusMsg.value = { type: 'info', text: '正在同步浙江图书馆借阅记录...' }
  const successLines: string[] = []
  const errorLines: string[] = []

  try {
    const tasks: Promise<void>[] = []
    if (hasHz) {
      tasks.push(
        (async () => {
          hzlibLoading.value = true
          try {
            saveCredentialToStorage(
              'lh_hzlib_cred',
              hzlibAccount.value,
              hzlibPassword.value,
              hzlibRemember.value
            )
            const { encryptedPassword, loginSessionCookie } =
              await prepareHzlibClientEncryptedPayload(hzlibPassword.value)
            const resp = await fetch('/api/hzlib/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                account: hzlibAccount.value.trim(),
                encryptedPassword,
                loginSessionCookie,
                captchaCode: hzlibNeedCaptcha.value ? hzlibCaptchaCode.value.trim() : '',
                captchaSessionCookie: hzlibNeedCaptcha.value ? hzlibCaptchaCookie.value : '',
                captchaPemKey: hzlibNeedCaptcha.value ? hzlibCaptchaPemKey.value : '',
                maxPages: 30,
              }),
            })
            const data = await parseJsonSafe(resp)
            if (!data.ok) {
              if (data.needCaptcha && data.captchaImage) {
                hzlibNeedCaptcha.value = true
                hzlibCaptchaImage.value = data.captchaImage
                hzlibCaptchaCookie.value = data.sessionCookie || ''
                hzlibCaptchaPemKey.value = data.pemKey || ''
                hzlibCaptchaCode.value = ''
                activeTab.value = 'hzlib'
              }
              const errText = data.message || '同步失败'
              hzStatusMsg.value = { type: 'error', text: errText }
              errorLines.push(`杭州图书馆：${errText}`)
              return
            }
            hzlibNeedCaptcha.value = false
            hzlibCaptchaCode.value = ''
            if (data.sessionCookie) {
              localStorage.setItem('lh_hzlib_cookie', data.sessionCookie)
            }
            emit('imported', {
              records: data.records || [],
              source: 'hzlib',
              account: hzlibAccount.value.trim(),
              isFullOnlineSync: true,
            })
            const okText = `杭州图书馆同步成功！共获取 ${data.records?.length || 0} 条记录（在借 ${data.summary?.currentCount || 0} 本，历史 ${data.summary?.historyCount || 0} 本）`
            hzStatusMsg.value = { type: 'success', text: okText }
            successLines.push(
              `杭州图书馆：获取 ${data.records?.length || 0} 条（在借 ${data.summary?.currentCount || 0} 本，历史 ${data.summary?.historyCount || 0} 本）`
            )
          } catch (e: any) {
            const errText = e?.message || '请求失败'
            hzStatusMsg.value = { type: 'error', text: errText }
            errorLines.push(`杭州图书馆：${errText}`)
          } finally {
            hzlibLoading.value = false
          }
        })()
      )
    }

    if (hasZj) {
      tasks.push(
        (async () => {
          zjlibLoading.value = true
          try {
            saveCredentialToStorage(
              'lh_zjlib_cred',
              zjlibAccount.value,
              zjlibPassword.value,
              zjlibRemember.value
            )
            const encryptedPassword = encryptZjlibPasswordClient(zjlibPassword.value)
            const resp = await fetch('/api/zjlib/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                token: '',
                account: zjlibAccount.value.trim(),
                encryptedPassword,
                maxPages: 30,
              }),
            })
            const data = await parseJsonSafe(resp)
            if (!data.ok) {
              const errText = data.message || '同步失败'
              zjStatusMsg.value = { type: 'error', text: errText }
              errorLines.push(`浙江图书馆：${errText}`)
              return
            }
            if (data.token) {
              zjlibToken.value = data.token
              localStorage.setItem('lh_zjlib_token', data.token)
            }
            emit('imported', {
              records: data.records || [],
              source: 'zjlib',
              account: zjlibAccount.value.trim(),
              isFullOnlineSync: true,
            })
            const okText = `浙江图书馆同步成功！共获取 ${data.records?.length || 0} 条记录（在借 ${data.summary?.currentCount || 0} 本，历史 ${data.summary?.historyCount || 0} 本）`
            zjStatusMsg.value = { type: 'success', text: okText }
            successLines.push(
              `浙江图书馆：获取 ${data.records?.length || 0} 条（在借 ${data.summary?.currentCount || 0} 本，历史 ${data.summary?.historyCount || 0} 本）`
            )
          } catch (e: any) {
            const errText = e?.message || '请求失败'
            zjStatusMsg.value = { type: 'error', text: errText }
            errorLines.push(`浙江图书馆：${errText}`)
          } finally {
            zjlibLoading.value = false
          }
        })()
      )
    }

    await Promise.all(tasks)

    if (successLines.length > 0 && errorLines.length === 0) {
      oneClickDoneDialog.value = {
        title: '一键同步完成',
        lines: successLines,
      }
    } else if (successLines.length > 0 && errorLines.length > 0) {
      oneClickDoneDialog.value = {
        title: '部分图书馆同步完成',
        lines: [...successLines, ...errorLines],
      }
    }
  } finally {
    oneClickSyncLoading.value = false
  }
}

function triggerBackupFileSelect() {
  backupStatusMsg.value = null
  backupFileInput.value?.click()
}

async function handleBackupFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  backupStatusMsg.value = { type: 'info', text: `正在读取并核对备份文件「${file.name}」的账号信息...` }
  try {
    const rawText = await file.text()
    const parsed = JSON.parse(rawText)
    const list: Array<Partial<BorrowRecord>> = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.records)
        ? parsed.records
        : []

    if (list.length === 0) {
      backupStatusMsg.value = {
        type: 'error',
        text: '导入失败：备份文件中未找到有效的借阅记录数据',
      }
      return
    }

    // 提取备份文件中的账号签名信息
    let fileHzAccount = String(
      parsed?.accounts?.hzlibAccount || parsed?.syncMeta?.hzlibAccount || ''
    ).trim()
    let fileZjAccount = String(
      parsed?.accounts?.zjlibAccount || parsed?.syncMeta?.zjlibAccount || ''
    ).trim()
    for (const r of list) {
      const acc = String(r.account || '').trim()
      if (!acc) continue
      if (!fileHzAccount && r.library === 'hzlib') fileHzAccount = acc
      if (!fileZjAccount && r.library === 'zjlib') fileZjAccount = acc
    }

    const localHz = effectiveHzAccount.value
    const localZj = effectiveZjAccount.value
    const hasLocalData = props.totalCount > 0 && Boolean(localHz || localZj)

    // 1. 若备份文件既无账号签名，本地也未填写任何账号，要求先填写或登录账号再导入
    if (!fileHzAccount && !fileZjAccount && !localHz && !localZj) {
      backupStatusMsg.value = {
        type: 'error',
        text: '账号核对未通过：该备份文件未包含账号标识，且当前本地未填写任何读者账号。请先在「杭州图书馆同步」或「浙江图书馆同步」中填写您的账号后再导入。',
      }
      return
    }

    // 2. 若本地已有数据或已填写账号，严格校验备份文件中的账号与当前账号是否一致
    const conflicts: string[] = []
    if (fileHzAccount && localHz && fileHzAccount !== localHz) {
      conflicts.push(`杭州图书馆备份账号（${fileHzAccount}）与当前账号（${localHz}）不一致`)
    }
    if (fileZjAccount && localZj && fileZjAccount !== localZj) {
      conflicts.push(`浙江图书馆备份账号（${fileZjAccount}）与当前账号（${localZj}）不一致`)
    }
    // 若备份文件只含某一个馆的账号，而本地只绑定了另一个馆的不同账号，也核对是否存在跨人混入
    if (
      hasLocalData &&
      conflicts.length === 0 &&
      ((fileHzAccount && !localHz && localZj && fileHzAccount !== localZj) ||
        (fileZjAccount && !localZj && localHz && fileZjAccount !== localHz))
    ) {
      const fileAcc = fileHzAccount || fileZjAccount
      const curAcc = localHz || localZj
      conflicts.push(`备份文件所属账号（${fileAcc}）与当前本地已登录账号（${curAcc}）不一致`)
    }

    if (conflicts.length > 0) {
      backupStatusMsg.value = {
        type: 'error',
        text: `账号核对失败：${conflicts.join('；')}！为防止不同读者的借阅记录混淆，已拒绝导入。若需切换账号，请先点击主页右上角「退出登录」后再导入。`,
      }
      return
    }

    // 账号核对通过：为导入记录补齐账号标识并增量合并入库
    const finalHzAcc = fileHzAccount || localHz
    const finalZjAcc = fileZjAccount || localZj
    const stampedRecords = list.map((r) => ({
      ...r,
      account:
        r.account ||
        (r.library === 'hzlib' ? finalHzAcc : r.library === 'zjlib' ? finalZjAcc : ''),
    }))

    const syncMetaPatch: Partial<SyncMeta> = {}
    if (finalHzAcc) syncMetaPatch.hzlibAccount = finalHzAcc
    if (finalZjAcc) syncMetaPatch.zjlibAccount = finalZjAcc
    if (parsed?.syncMeta?.hzlibLastSync && !props.syncMeta.hzlibLastSync) {
      syncMetaPatch.hzlibLastSync = parsed.syncMeta.hzlibLastSync
    }
    if (parsed?.syncMeta?.zjlibLastSync && !props.syncMeta.zjlibLastSync) {
      syncMetaPatch.zjlibLastSync = parsed.syncMeta.zjlibLastSync
    }

    if (finalHzAcc && !hzlibAccount.value) hzlibAccount.value = finalHzAcc
    if (finalZjAcc && !zjlibAccount.value) zjlibAccount.value = finalZjAcc

    emit('imported', {
      records: stampedRecords,
      source: 'mixed',
      syncMetaPatch,
    })

    const verifiedAccText = [
      finalHzAcc ? `杭图 ${finalHzAcc}` : '',
      finalZjAcc ? `浙图 ${finalZjAcc}` : '',
    ]
      .filter(Boolean)
      .join(' / ')
    backupStatusMsg.value = {
      type: 'success',
      text: `账号核对通过（${verifiedAccText || '已绑定当前账号'}）！成功导入合并 ${stampedRecords.length} 条记录，本地历史记录与读书笔记均已完整保留。`,
    }
  } catch (err: any) {
    backupStatusMsg.value = {
      type: 'error',
      text: `解析备份文件失败：请确认上传的是有效的 JSON 备份文件（${err?.message || '格式错误'}）`,
    }
  }
}

</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex justify-center bg-slate-900/60 backdrop-blur-xs"
    :class="mobileMode ? 'items-end p-0' : 'items-end sm:items-center p-0 sm:p-4'"
    @click.self="stopZjlibQrPoll(); emit('close')"
  >
    <div
      class="w-full bg-white shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col overflow-hidden"
      :class="mobileMode ? 'max-w-[420px] rounded-t-3xl' : 'max-w-xl rounded-t-2xl sm:rounded-2xl'"
    >
      <!-- Header -->
      <div class="flex items-center justify-between gap-2 px-5 py-4 bg-gradient-to-r from-teal-700 to-emerald-700 text-white">
        <div class="min-w-0">
          <h2 class="text-base sm:text-lg font-bold flex items-center gap-2 truncate">
            <RefreshCw class="w-5 h-5 shrink-0" />
            <span class="truncate">导入与更新个人借阅记录</span>
          </h2>
          <p class="text-xs text-teal-100 mt-0.5 truncate">
            所有借阅数据与笔记 100% 存储在您本地
          </p>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            :disabled="oneClickSyncLoading"
            class="px-3 py-1.5 rounded-xl bg-white/20 hover:bg-white/30 disabled:opacity-60 border border-white/30 text-xs font-bold text-white flex items-center gap-1.5 transition cursor-pointer shadow-xs whitespace-nowrap"
            title="自动同步已填写用户名和密码的图书馆"
            @click="handleOneClickSyncAll"
          >
            <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': oneClickSyncLoading }" />
            {{ oneClickSyncLoading ? '同步中...' : '一键同步' }}
          </button>
          <button
            class="p-1.5 rounded-lg hover:bg-white/15 transition cursor-pointer"
            @click="stopZjlibQrPoll(); emit('close')"
          >
            <X class="w-5 h-5" />
          </button>
        </div>
      </div>

      <!-- Tabs (杭州图书馆同步 / 浙江图书馆同步 / 本地导入导出) -->
      <div class="grid grid-cols-3 border-b border-slate-200 bg-slate-50 text-xs sm:text-sm font-medium">
        <button
          class="py-3 px-1.5 border-b-2 transition cursor-pointer text-center whitespace-nowrap truncate"
          :class="
            activeTab === 'hzlib'
              ? 'border-teal-600 text-teal-700 bg-white font-semibold'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          "
          @click="stopZjlibQrPoll(); activeTab = 'hzlib'"
        >
          📚 杭州图书馆同步
        </button>
        <button
          class="py-3 px-1.5 border-b-2 transition cursor-pointer text-center whitespace-nowrap truncate"
          :class="
            activeTab === 'zjlib'
              ? 'border-teal-600 text-teal-700 bg-white font-semibold'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          "
          @click="switchToZjlibTab"
        >
          🏛️ 浙江图书馆同步
        </button>
        <button
          class="py-3 px-1.5 border-b-2 transition cursor-pointer text-center whitespace-nowrap truncate"
          :class="
            activeTab === 'backup'
              ? 'border-teal-600 text-teal-700 bg-white font-semibold'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          "
          @click="stopZjlibQrPoll(); activeTab = 'backup'"
        >
          💾 本地导入/导出
        </button>
      </div>

      <!-- Body (先展示登录操作控件，进度与说明放下方) -->
      <div class="p-5 overflow-y-auto space-y-4 flex-1">
        <!-- TAB 1: 杭州图书馆 -->
        <div v-if="activeTab === 'hzlib'" class="space-y-4">
          <!-- 1. 登录表单控件在上 -->
          <div class="grid grid-cols-1 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-700 mb-1">读者证号 / 二代身份证号</label>
              <input
                v-model="hzlibAccount"
                type="text"
                placeholder="输入杭图读者证号或身份证号"
                class="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-700 mb-1">借书密码</label>
              <input
                v-model="hzlibPassword"
                type="password"
                placeholder="默认常为生日6/8位(如850105)或身份证后6位"
                class="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>
          </div>

          <!-- 图形验证码区域（当触发杭图验证码保护或用户主动开启时展示） -->
          <div
            v-if="hzlibNeedCaptcha"
            class="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex flex-wrap items-center justify-between gap-3"
          >
            <div class="flex items-center gap-3">
              <img
                v-if="hzlibCaptchaImage"
                :src="hzlibCaptchaImage"
                alt="验证码"
                title="点击刷新验证码"
                class="h-9 w-24 rounded border border-amber-300 bg-white object-contain cursor-pointer"
                @click="refreshHzlibCaptcha"
              />
              <button
                type="button"
                class="text-xs text-amber-800 underline cursor-pointer"
                @click="refreshHzlibCaptcha"
              >
                看不清？换一张
              </button>
            </div>
            <div class="flex items-center gap-2 flex-1 min-w-[180px]">
              <input
                v-model="hzlibCaptchaCode"
                type="text"
                maxlength="4"
                placeholder="输入左侧 4 位验证码"
                class="w-full px-3 py-1.5 rounded-lg border border-amber-400 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                @keyup.enter="handleHzlibOnlineSync"
              />
            </div>
          </div>

          <div class="flex items-center justify-between gap-3">
            <label class="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer whitespace-nowrap">
              <input v-model="hzlibRemember" type="checkbox" class="rounded text-teal-600" />
              记住密码
            </label>
            <button
              :disabled="hzlibLoading"
              class="px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium flex items-center gap-1.5 transition cursor-pointer whitespace-nowrap shrink-0"
              @click="handleHzlibOnlineSync"
            >
              <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': hzlibLoading }" />
              {{ hzlibLoading ? '同步中...' : '同步记录' }}
            </button>
          </div>

          <!-- 2. 进度状态与提示信息在下 -->
          <div
            v-if="hzStatusMsg"
            class="p-3 rounded-xl text-xs sm:text-sm flex items-start gap-2 border"
            :class="{
              'bg-emerald-50 border-emerald-200 text-emerald-800': hzStatusMsg.type === 'success',
              'bg-rose-50 border-rose-200 text-rose-800': hzStatusMsg.type === 'error',
              'bg-sky-50 border-sky-200 text-sky-800': hzStatusMsg.type === 'info',
            }"
          >
            <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
            <span>{{ hzStatusMsg.text }}</span>
          </div>

          <div class="p-3.5 rounded-xl bg-teal-50/70 border border-teal-200/80 text-xs text-slate-700 space-y-2">
            <div class="font-semibold text-teal-900 flex items-center gap-2">
              <span>杭州图书馆</span>
              <a
                href="https://www.zjhzlib.cn/"
                target="_blank"
                rel="noopener"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white hover:bg-teal-600 text-teal-700 hover:text-white border border-teal-300 text-[11px] font-semibold transition"
              >
                <ExternalLink class="w-3 h-3" />
                官网
              </a>
            </div>
            <div v-if="syncMeta.hzlibLastSync" class="text-[11px] text-teal-700">
              上次同步：{{ syncMeta.hzlibLastSync }}
            </div>
            <p class="text-[11px] text-slate-600 pt-0.5 leading-relaxed">
              💡 <strong>密码小提示</strong>：若未单独修改过杭图密码，默认借书密码通常是<strong>出生年月日（如 850105 或 19850105）</strong>或<strong>身份证后 6 位</strong>。若忘记密码可在「浙里办 / 杭州城市大脑」App 的杭州图书馆服务中重置。
            </p>
          </div>
        </div>

        <!-- TAB 2: 浙江图书馆 -->
        <div v-if="activeTab === 'zjlib'" class="space-y-4">
          <!-- 1. 登录方式切换与登录控件在上（只保留方式1和方式2，默认显示方式2：微信/支付宝登录） -->
          <div class="grid grid-cols-2 gap-2">
            <button
              class="px-2 py-1.5 rounded-lg text-[11px] sm:text-xs font-medium transition cursor-pointer text-center whitespace-nowrap truncate"
              :class="
                zjlibMode === 'account'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              "
              @click="stopZjlibQrPoll(); zjlibMode = 'account'"
            >
              方式1：读者证/身份证+密码直连
            </button>
            <button
              class="px-2 py-1.5 rounded-lg text-[11px] sm:text-xs font-medium transition cursor-pointer flex items-center justify-center gap-1 whitespace-nowrap truncate"
              :class="
                zjlibMode === 'qr'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              "
              @click="zjlibMode = 'qr'; startZjlibQr('wechat')"
            >
              <QrCode class="w-3.5 h-3.5 shrink-0" />
              方式2：微信/支付宝登录
            </button>
          </div>

          <!-- 微信/支付宝扫码同步 -->
          <div v-if="zjlibMode === 'qr'" class="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-col items-center space-y-3">
            <div class="flex gap-2">
              <button
                class="px-3 py-1 rounded-lg text-xs font-medium cursor-pointer transition"
                :class="
                  zjlibQrType === 'wechat'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-white border border-slate-200 text-slate-600'
                "
                @click="startZjlibQr('wechat')"
              >
                💬 微信扫码登录
              </button>
              <button
                class="px-3 py-1 rounded-lg text-xs font-medium cursor-pointer transition"
                :class="
                  zjlibQrType === 'alipay'
                    ? 'bg-sky-600 text-white'
                    : 'bg-white border border-slate-200 text-slate-600'
                "
                @click="startZjlibQr('alipay')"
              >
                💙 支付宝扫码登录
              </button>
            </div>
            <div class="w-44 h-44 rounded-xl bg-white border border-slate-200 p-2 flex items-center justify-center">
              <img
                v-if="zjlibQrImage"
                :src="zjlibQrImage"
                alt="浙图登录二维码"
                class="w-full h-full object-contain"
              />
              <span v-else class="text-xs text-slate-400">正在加载二维码...</span>
            </div>
            <div class="text-xs font-medium text-indigo-800">{{ zjlibQrStatus }}</div>
          </div>

          <!-- 方式1：读者证/身份证+密码直连 -->
          <div v-else class="space-y-3">
            <div class="grid grid-cols-1 gap-3">
              <div>
                <label class="block text-xs font-medium text-slate-700 mb-1">浙图账号（读者证/身份证/手机号）</label>
                <input
                  v-model="zjlibAccount"
                  type="text"
                  placeholder="请输入浙江图书馆账号"
                  class="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-700 mb-1">登录密码</label>
                <input
                  v-model="zjlibPassword"
                  type="password"
                  placeholder="请输入密码"
                  class="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>
            <div class="flex items-center justify-between gap-3">
              <label class="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer whitespace-nowrap">
                <input v-model="zjlibRemember" type="checkbox" class="rounded text-indigo-600" />
                记住密码
              </label>
              <button
                :disabled="zjlibLoading"
                class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium flex items-center gap-1.5 transition cursor-pointer whitespace-nowrap shrink-0"
                @click="handleZjlibOnlineSync"
              >
                <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': zjlibLoading }" />
                {{ zjlibLoading ? '同步中...' : '同步记录' }}
              </button>
            </div>
          </div>

          <!-- 2. 进度状态与提示信息在下 -->
          <div
            v-if="zjStatusMsg"
            class="p-3 rounded-xl text-xs sm:text-sm flex items-start gap-2 border"
            :class="{
              'bg-emerald-50 border-emerald-200 text-emerald-800': zjStatusMsg.type === 'success',
              'bg-rose-50 border-rose-200 text-rose-800': zjStatusMsg.type === 'error',
              'bg-sky-50 border-sky-200 text-sky-800': zjStatusMsg.type === 'info',
            }"
          >
            <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
            <span>{{ zjStatusMsg.text }}</span>
          </div>

          <div class="p-3.5 rounded-xl bg-indigo-50/70 border border-indigo-200/80 text-xs text-slate-700 space-y-2">
            <div class="font-semibold text-indigo-900 flex items-center gap-2">
              <span>浙江图书馆</span>
              <a
                href="https://www.zjlib.cn/"
                target="_blank"
                rel="noopener"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white hover:bg-indigo-600 text-indigo-700 hover:text-white border border-indigo-300 text-[11px] font-semibold transition"
              >
                <ExternalLink class="w-3 h-3" />
                官网
              </a>
            </div>
            <div v-if="syncMeta.zjlibLastSync" class="text-[11px] text-indigo-700">
              上次同步：{{ syncMeta.zjlibLastSync }}
            </div>
            <p v-if="zjlibMode === 'qr'" class="text-[11px] text-slate-600 pt-0.5 leading-relaxed">
              支持手机微信或支付宝直接扫码授权，扫码确认后将自动拉取您在浙江图书馆的当前在借与全部历史借阅记录。
            </p>
            <p v-else class="text-[11px] text-slate-600 pt-0.5 leading-relaxed">
              💡 <strong>密码小提示</strong>：若未单独修改过浙图密码，初始密码通常是<strong>身份证号后 6 位</strong>或<strong>出生年月日（如 19900101）</strong>。若忘记密码可在浙江图书馆官网登录页点击「忘记密码」通过绑定手机号重置。
            </p>
          </div>
        </div>

        <!-- TAB 3: 本地导入/导出（含账号一致性核对与永久历史备份） -->
        <div v-if="activeTab === 'backup'" class="space-y-4">
          <!-- 当前本地绑定账号核对卡片 -->
          <div class="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
            <div class="font-semibold text-slate-800 flex items-center justify-between gap-2">
              <span class="flex items-center gap-1.5">
                <UserCheck class="w-4 h-4 text-teal-600 shrink-0" />
                本地绑定账号
              </span>
              <span class="px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200 font-semibold">
                本地共 {{ totalCount }} 册
              </span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-0.5 text-[11px] text-slate-600">
              <div class="px-2.5 py-1.5 rounded-lg bg-white border border-slate-200/80 flex items-center justify-between">
                <span>📚 杭图账号：</span>
                <span class="font-mono font-semibold text-slate-800">
                  {{ effectiveHzAccount || '未绑定' }}
                </span>
              </div>
              <div class="px-2.5 py-1.5 rounded-lg bg-white border border-slate-200/80 flex items-center justify-between">
                <span>🏛️ 浙图账号：</span>
                <span class="font-mono font-semibold text-slate-800">
                  {{ effectiveZjAccount || '未绑定' }}
                </span>
              </div>
            </div>
            <p class="text-[11px] text-slate-500 leading-relaxed">
              💡 图书馆服务器通常仅保留近期借阅记录。建议定期导出 JSON 备份文件
            </p>
          </div>

          <!-- 1. 导出记录到本地 -->
          <div class="p-4 rounded-xl bg-white border border-slate-200 space-y-3">
            <div class="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
              <Download class="w-4 h-4 text-teal-600 shrink-0" />
              导出本地记录备份（含账号信息、评价标签与读书笔记）
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                type="button"
                :disabled="totalCount === 0"
                class="px-3.5 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
                @click="emit('export-json')"
              >
                <FileJson class="w-4 h-4 shrink-0" />
                导出 JSON 完整备份 ({{ totalCount }}册)
              </button>
              <button
                type="button"
                :disabled="totalCount === 0"
                class="px-3.5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 border border-slate-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
                @click="emit('export-csv')"
              >
                <FileSpreadsheet class="w-4 h-4 shrink-0 text-emerald-600" />
                导出 CSV 表格 (Excel可开)
              </button>
            </div>
          </div>

          <!-- 2. 从本地备份文件导入（强制核对账号信息） -->
          <div class="p-4 rounded-xl bg-white border border-slate-200 space-y-3">
            <div class="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
              <Upload class="w-4 h-4 text-indigo-600 shrink-0" />
              导入本地 JSON 备份记录
            </div>
            <input
              ref="backupFileInput"
              type="file"
              accept=".json,application/json"
              class="hidden"
              @change="handleBackupFileChange"
            />
            <button
              type="button"
              class="w-full py-3 px-4 rounded-xl border-2 border-dashed border-indigo-200 hover:border-indigo-400 bg-indigo-50/40 hover:bg-indigo-50/80 text-indigo-700 text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer"
              @click="triggerBackupFileSelect"
            >
              <Upload class="w-4 h-4 shrink-0" />
              选择本地 JSON 备份文件并核对账号导入
            </button>
            <p class="text-[11px] text-slate-500 leading-relaxed">
              🔒 导入时将自动核对备份文件中的读者账号与当前本地绑定账号是否一致；核对通过后将与本地现有记录增量去重合并，不会覆盖或丢失任何已有历史记录与笔记。
            </p>
          </div>

          <!-- 状态提示 -->
          <div
            v-if="backupStatusMsg"
            class="p-3 rounded-xl text-xs sm:text-sm flex items-start gap-2 border"
            :class="{
              'bg-emerald-50 border-emerald-200 text-emerald-800': backupStatusMsg.type === 'success',
              'bg-rose-50 border-rose-200 text-rose-800': backupStatusMsg.type === 'error',
              'bg-sky-50 border-sky-200 text-sky-800': backupStatusMsg.type === 'info',
            }"
          >
            <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
            <span class="leading-relaxed">{{ backupStatusMsg.text }}</span>
          </div>
        </div>
      </div>

      <!-- 一键更新完成提示弹窗 -->
      <div
        v-if="oneClickDoneDialog"
        class="fixed inset-0 z-[60] bg-slate-900/45 backdrop-blur-[1px] flex items-center justify-center p-4"
        @click="oneClickDoneDialog = null"
      >
        <div
          class="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-200 p-5 space-y-3"
          @click.stop
        >
          <div class="flex items-center gap-2 text-base font-bold text-teal-800">
            <ShieldCheck class="w-5 h-5 text-emerald-600 shrink-0" />
            <span>{{ oneClickDoneDialog.title }}</span>
          </div>
          <div class="space-y-1.5 text-xs text-slate-700 bg-emerald-50/70 border border-emerald-200 rounded-xl p-3">
            <p v-for="(line, idx) in oneClickDoneDialog.lines" :key="idx" class="leading-relaxed">
              {{ line }}
            </p>
          </div>
          <div class="flex justify-end pt-1">
            <button
              type="button"
              class="px-4 py-1.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold cursor-pointer"
              @click="oneClickDoneDialog = null"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
