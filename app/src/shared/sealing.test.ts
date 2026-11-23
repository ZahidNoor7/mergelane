import { describe, expect, it } from 'vitest'
import { canSeal, seal, unseal, type SafeStorageLike } from './sealing'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A stand-in for Electron's safeStorage: "seals" by prefixing, and can be told to fail. */
function storage(
  options: {
    available?: boolean | 'throws'
    backend?: string
    encryptFails?: boolean
    decryptFails?: boolean
    shouldReEncrypt?: boolean
  } = {}
): SafeStorageLike & { encrypted: string[] } {
  const encrypted: string[] = []
  return {
    encrypted,
    isAsyncEncryptionAvailable: async () => {
      if (options.available === 'throws') throw new Error('keychain locked')
      return options.available ?? true
    },
    encryptStringAsync: async (plainText) => {
      if (options.encryptFails) throw new Error('refused')
      encrypted.push(plainText)
      return encoder.encode(`sealed:${plainText}`)
    },
    decryptStringAsync: async (bytes) => {
      if (options.decryptFails) throw new Error('not ours')
      return {
        result: decoder.decode(bytes).replace(/^sealed:/, ''),
        shouldReEncrypt: options.shouldReEncrypt ?? false
      }
    },
    getSelectedStorageBackend: () => options.backend ?? 'unknown'
  }
}

describe('canSeal', () => {
  it('is yes with a keychain, on macOS and Windows', async () => {
    expect(await canSeal(storage(), 'darwin')).toBe(true)
    expect(await canSeal(storage(), 'win32')).toBe(true)
  })

  it('is no without one, or when asking fails', async () => {
    expect(await canSeal(storage({ available: false }), 'darwin')).toBe(false)
    expect(await canSeal(storage({ available: 'throws' }), 'darwin')).toBe(false)
  })

  it('is no on Linux with only the fixed-key fallback, yes with a real keyring', async () => {
    expect(await canSeal(storage({ backend: 'basic_text' }), 'linux')).toBe(false)
    expect(await canSeal(storage({ backend: 'gnome_libsecret' }), 'linux')).toBe(true)
    // The backend is only asked about on Linux.
    expect(await canSeal(storage({ backend: 'basic_text' }), 'darwin')).toBe(true)
  })
})

describe('seal and unseal', () => {
  it('round-trips a secret', async () => {
    const keychain = storage()
    const sealed = await seal(keychain, 'darwin', 'hunter2')
    // What the keychain gave back, untouched (never the secret itself).
    expect(decoder.decode(sealed)).toBe('sealed:hunter2')
    expect(await unseal(keychain, 'darwin', sealed!)).toEqual({ text: 'hunter2', reseal: false })
  })

  it('writes nothing it cannot seal', async () => {
    const none = storage({ available: false })
    expect(await seal(none, 'darwin', 'hunter2')).toBeUndefined()
    expect(none.encrypted).toEqual([])
    expect(await seal(storage({ backend: 'basic_text' }), 'linux', 'hunter2')).toBeUndefined()
  })

  it('gives up quietly when the keychain refuses', async () => {
    expect(await seal(storage({ encryptFails: true }), 'darwin', 'hunter2')).toBeUndefined()
  })

  it('opens nothing another keychain sealed, or with no keychain', async () => {
    const sealed = encoder.encode('sealed:hunter2')
    expect(await unseal(storage({ decryptFails: true }), 'darwin', sealed)).toBeUndefined()
    expect(await unseal(storage({ available: false }), 'darwin', sealed)).toBeUndefined()
  })

  it('says when the key has been replaced, so the secret is sealed again', async () => {
    const sealed = encoder.encode('sealed:hunter2')
    expect(await unseal(storage({ shouldReEncrypt: true }), 'win32', sealed)).toEqual({
      text: 'hunter2',
      reseal: true
    })
  })
})
