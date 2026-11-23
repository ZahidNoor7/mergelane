// Secrets Mergelane keeps on disk (a download's browser sign-in, the news server's password) are sealed with
// Electron's safeStorage: the macOS Keychain, Windows DPAPI. Electron 45 deprecates the synchronous calls and 46
// removes them, so these use the asynchronous ones, which read what the synchronous ones wrote ("Data encrypted
// with safeStorage.encryptString() can be decrypted with safeStorage.decryptStringAsync()", Electron's breaking
// changes, 45.0). main/secrets.ts passes Electron's safeStorage in; the tests pass a stand-in.

/** The parts of Electron's safeStorage used here. */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Uint8Array>
  decryptStringAsync(encrypted: Uint8Array): Promise<{ result: string; shouldReEncrypt: boolean }>
  /** Linux only. */
  getSelectedStorageBackend(): string
}

/** Whether a secret can be written sealed. On Linux without a keyring Electron falls back to a fixed key, which
 * protects nothing, so then nothing is written. */
export async function canSeal(storage: SafeStorageLike, platform: string): Promise<boolean> {
  try {
    if (!(await storage.isAsyncEncryptionAvailable())) return false
  } catch {
    return false
  }
  return !(platform === 'linux' && storage.getSelectedStorageBackend() === 'basic_text')
}

/** `text` sealed; undefined when it can't be: no keychain, or the keychain refused. */
export async function seal(
  storage: SafeStorageLike,
  platform: string,
  text: string
): Promise<Uint8Array | undefined> {
  if (!(await canSeal(storage, platform))) return undefined
  try {
    return await storage.encryptStringAsync(text)
  } catch {
    return undefined
  }
}

export interface Unsealed {
  text: string
  /** Sealed under a key since replaced: seal it again so the next read needn't use the old one. */
  reseal: boolean
}

/** What `sealed` holds; undefined when this keychain can't open it (another login's, a restored profile). */
export async function unseal(
  storage: SafeStorageLike,
  platform: string,
  sealed: Uint8Array
): Promise<Unsealed | undefined> {
  if (!(await canSeal(storage, platform))) return undefined
  try {
    const { result, shouldReEncrypt } = await storage.decryptStringAsync(sealed)
    return { text: result, reseal: shouldReEncrypt }
  } catch {
    return undefined
  }
}
