import { safeStorage } from 'electron'
import { canSeal, seal, unseal, type Unsealed } from '../shared/sealing'

// Electron's safeStorage behind shared/sealing.ts, with what is sealed kept as base64 text for the JSON files.

/** Whether secrets can be written sealed on this computer. */
export const canSealHere = (): Promise<boolean> => canSeal(safeStorage, process.platform)

/** `text` sealed, as base64; undefined when it can't be. */
export async function sealText(text: string): Promise<string | undefined> {
  const sealed = await seal(safeStorage, process.platform, text)
  return sealed && Buffer.from(sealed).toString('base64')
}

/** What base64 `sealed` holds; undefined when it can't be opened here. */
export const unsealText = (sealed: string): Promise<Unsealed | undefined> =>
  unseal(safeStorage, process.platform, Buffer.from(sealed, 'base64'))
