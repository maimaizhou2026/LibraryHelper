/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, any>, Record<string, any>, any>
  export default component
}

declare module 'sm-crypto' {
  const smCrypto: {
    sm2: {
      doEncrypt: (msg: string, publicKey: string, cipherMode?: number) => string
      doDecrypt: (encryptData: string, privateKey: string, cipherMode?: number) => string
    }
    sm3: (msg: string) => string
    sm4: Record<string, any>
  }
  export default smCrypto
}
