import smCrypto from 'sm-crypto'

const ZJLIB_SM2_PUBLIC_KEY =
  '0482ddef5f3839bc64562d7f88782be9923785a5f05beaa25c9e8932d6591aa50b47f27aa9595f98ff80e88c1751b95bc9554de41874b37cb4b50028e4cf0ac0e1'

const LOCAL_OBFUSCATION_KEY = 'LibraryHelper::LocalCredShield::v1'

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '')
  const binary = atob(clean)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

function hexToBase64(hexStr: string): string {
  const clean = hexStr.length % 2 ? `0${hexStr}` : hexStr
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16)
  }
  return bytesToBase64(bytes)
}

/**
 * 浏览器端浙江图书馆密码 SM2 加密（输出 Base64 密文，服务端可直接透传给浙图网关）
 */
export function encryptZjlibPasswordClient(plainText: string): string {
  if (!plainText) return ''
  const hexCipher = smCrypto.sm2.doEncrypt(plainText, ZJLIB_SM2_PUBLIC_KEY, 1)
  return hexToBase64(hexCipher)
}

function readDerLength(bytes: Uint8Array, offset: number): { length: number; nextOffset: number } {
  const first = bytes[offset]
  if ((first & 0x80) === 0) {
    return { length: first, nextOffset: offset + 1 }
  }
  const numBytes = first & 0x7f
  let len = 0
  for (let i = 0; i < numBytes; i++) {
    len = (len << 8) | bytes[offset + 1 + i]
  }
  return { length: len, nextOffset: offset + 1 + numBytes }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex ? BigInt(`0x${hex}`) : 0n
}

function parseRsaPublicKeyPem(rawPemKey: string): { n: bigint; e: bigint; keyByteLen: number } {
  const cleanBase64 = rawPemKey
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  const der = base64ToBytes(cleanBase64)

  const integers: Uint8Array[] = []
  function walkDer(buf: Uint8Array, start: number, end: number) {
    let pos = start
    while (pos < end) {
      const tag = buf[pos++]
      const { length, nextOffset } = readDerLength(buf, pos)
      pos = nextOffset
      const valStart = pos
      const valEnd = pos + length
      if (tag === 0x30) {
        // SEQUENCE
        walkDer(buf, valStart, valEnd)
      } else if (tag === 0x03) {
        // BIT STRING (skip 1 unused-bits byte)
        walkDer(buf, valStart + 1, valEnd)
      } else if (tag === 0x02) {
        // INTEGER
        let intBytes = buf.subarray(valStart, valEnd)
        while (intBytes.length > 1 && intBytes[0] === 0x00) {
          intBytes = intBytes.subarray(1)
        }
        integers.push(intBytes)
      }
      pos = valEnd
    }
  }

  walkDer(der, 0, der.length)
  if (integers.length < 2) {
    throw new Error('无效的杭州图书馆 RSA 公钥格式')
  }
  const modBytes = integers[integers.length - 2]
  const expBytes = integers[integers.length - 1]
  return {
    n: bytesToBigInt(modBytes),
    e: bytesToBigInt(expBytes),
    keyByteLen: modBytes.length,
  }
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % mod
    }
    e >>= 1n
    b = (b * b) % mod
  }
  return result
}

/**
 * 浏览器端杭州图书馆密码 RSA-PKCS1-v1.5 公钥加密（输出 Base64 密文，与 Node crypto.publicEncrypt 完全兼容）
 */
export function encryptHzlibPasswordClient(plainText: string, rawPemKey: string): string {
  if (!plainText || !rawPemKey) return ''
  const { n, e, keyByteLen } = parseRsaPublicKeyPem(rawPemKey)
  const msgBytes = new TextEncoder().encode(plainText)
  if (msgBytes.length > keyByteLen - 11) {
    throw new Error('密码长度超出 RSA 密钥上限')
  }

  // PKCS#1 v1.5 Type 2 padding: 0x00 || 0x02 || PS (non-zero random) || 0x00 || M
  const psLen = keyByteLen - 3 - msgBytes.length
  const padded = new Uint8Array(keyByteLen)
  padded[0] = 0x00
  padded[1] = 0x02

  const randBuf = new Uint8Array(psLen)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(randBuf)
  } else {
    for (let i = 0; i < psLen; i++) randBuf[i] = Math.floor(Math.random() * 255) + 1
  }
  for (let i = 0; i < psLen; i++) {
    let byte = randBuf[i]
    while (byte === 0) {
      byte = Math.floor(Math.random() * 255) + 1
    }
    padded[2 + i] = byte
  }
  padded[2 + psLen] = 0x00
  padded.set(msgBytes, 3 + psLen)

  const m = bytesToBigInt(padded)
  const c = modPow(m, e, n)
  const cipherHex = c.toString(16).padStart(keyByteLen * 2, '0')
  return hexToBase64(cipherHex)
}

/**
 * 浏览器本地凭证混淆编码（避免在 localStorage 中直接裸露明文 password 字段）
 */
export function encodeLocalSecret(plainText: string): string {
  if (!plainText) return ''
  const textBytes = new TextEncoder().encode(plainText)
  const keyBytes = new TextEncoder().encode(LOCAL_OBFUSCATION_KEY)
  const out = new Uint8Array(textBytes.length)
  for (let i = 0; i < textBytes.length; i++) {
    out[i] = textBytes[i] ^ keyBytes[i % keyBytes.length] ^ ((i * 31) & 0xff)
  }
  return `v1:${bytesToBase64(out)}`
}

export function decodeLocalSecret(encoded: string): string {
  if (!encoded) return ''
  if (!encoded.startsWith('v1:')) return encoded
  try {
    const raw = base64ToBytes(encoded.slice(3))
    const keyBytes = new TextEncoder().encode(LOCAL_OBFUSCATION_KEY)
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) {
      out[i] = raw[i] ^ keyBytes[i % keyBytes.length] ^ ((i * 31) & 0xff)
    }
    return new TextDecoder().decode(out)
  } catch {
    return ''
  }
}

export interface StoredLibraryCredential {
  account: string
  password: string
  remember: boolean
}

export function loadSavedCredential(storageKey: string): StoredLibraryCredential {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return { account: '', password: '', remember: true }
    const parsed = JSON.parse(raw)
    const account = String(parsed.account || '').trim()
    const password = parsed.cipherSecret
      ? decodeLocalSecret(String(parsed.cipherSecret))
      : String(parsed.password || '')
    const remember = parsed.remember !== undefined ? Boolean(parsed.remember) : Boolean(password)
    // 自动迁移旧版明文 password 存储为混淆格式
    if (parsed.password && !parsed.cipherSecret) {
      saveCredentialToStorage(storageKey, account, password, remember)
    }
    return { account, password, remember }
  } catch {
    return { account: '', password: '', remember: true }
  }
}

export function saveCredentialToStorage(
  storageKey: string,
  account: string,
  password: string,
  remember: boolean
): void {
  const cleanAccount = account.trim()
  if (remember && password) {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        account: cleanAccount,
        cipherSecret: encodeLocalSecret(password),
        remember: true,
      })
    )
  } else {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        account: cleanAccount,
        cipherSecret: '',
        remember: false,
      })
    )
  }
}
