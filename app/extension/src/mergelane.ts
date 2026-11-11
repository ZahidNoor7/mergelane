import { api } from './api'
import {
  BRIDGE_API,
  BRIDGE_DEADLINE_MS,
  NATIVE_HOST,
  type BridgeAddRequest,
  type BridgeMessage,
  type BridgeReply
} from '../../src/shared/browserBridge'
import type { BrowserContext, BrowserCookie } from '../../src/shared/types'

// Native messaging (docs/BROWSER-BRIDGE.md): the browser starts Mergelane's small host for each
// message, and it relays the message to the app. Nothing listens on a network port.

export type Reach = 'ok' | 'closed' | 'update'

/** One message to Mergelane, or null when the host is missing, failed, or took longer than
 * `timeoutMs`. */
async function call(message: BridgeMessage, timeoutMs: number): Promise<BridgeReply | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      api.runtime.sendNativeMessage(NATIVE_HOST, message) as Promise<BridgeReply>,
      new Promise<null>((resolve) => {
        timer = setTimeout(resolve, timeoutMs, null)
      })
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function reachOf(reply: BridgeReply | null): Reach {
  if (!reply || !reply.ok || !('app' in reply) || reply.app !== 'mergelane') {
    return reply && !reply.ok && 'error' in reply && reply.error === 'unsupported'
      ? 'update'
      : 'closed'
  }
  return 'api' in reply && reply.api === BRIDGE_API ? 'ok' : 'update'
}

export async function reach(): Promise<Reach> {
  return reachOf(await call({ type: 'ping' }, 3000))
}

/** Mergelane will take the download once confirmed (see BridgeReply's token). */
export interface Handoff {
  token: string
}

/** kept: Mergelane said no, or took too long. closed: Mergelane isn't running. */
export async function send(request: BridgeAddRequest): Promise<Handoff | 'kept' | 'closed'> {
  // Past Mergelane's own deadline: Mergelane answers nothing once this has given up.
  const reply = await call({ type: 'add', request }, BRIDGE_DEADLINE_MS + 4000)
  if (reply === null) return 'kept'
  if (reply.ok && 'token' in reply) return { token: reply.token }
  if (!reply.ok && 'error' in reply && reply.error === 'unavailable') return 'closed'
  return 'kept'
}

export async function confirm({ token }: Handoff): Promise<boolean> {
  const reply = await call({ type: 'confirm', token }, 3000)
  return reply?.ok === true
}

/** Firefox names its containers and private windows; Chrome's incognito store is "1". */
export function storeOf(source: {
  incognito: boolean
  cookieStoreId?: string
}): string | undefined {
  return source.cookieStoreId ?? (source.incognito ? '1' : undefined)
}

type IsolatedCookie = chrome.cookies.Cookie & { firstPartyDomain?: string }

function hostOf(url: string | undefined): string[] {
  try {
    return url ? [new URL(url).hostname] : []
  } catch {
    return []
  }
}

/** Cookies for where the download starts and where its redirects end; Mergelane sends each request
 * only the ones that match it. */
export async function browserContext(
  urls: readonly (string | undefined)[],
  storeId: string | undefined,
  referer: string | undefined
): Promise<BrowserContext> {
  const cookies = new Map<string, BrowserCookie>()
  const hosts = [...urls, referer].flatMap(hostOf)
  for (const url of new Set(urls)) {
    if (!url || !/^https?:/i.test(url)) continue
    const found = await api.cookies
      .getAll({ url, storeId })
      // Firefox with first-party isolation on refuses without firstPartyDomain. null reads every
      // site's copy, so only those kept for the download's own site or its page's are used.
      // Chrome refuses the key, so it's only tried second.
      .catch(async () => {
        const all = (await api.cookies.getAll({
          url,
          storeId,
          firstPartyDomain: null
        } as chrome.cookies.GetAllDetails)) as IsolatedCookie[]
        return all.filter(({ firstPartyDomain: site }) => {
          return !site || hosts.some((host) => host === site || host.endsWith(`.${site}`))
        })
      })
      .catch(() => [])
    for (const { name, value, domain, hostOnly, path, secure } of found) {
      cookies.set(`${domain}\n${path}\n${name}`, { name, value, domain, hostOnly, path, secure })
    }
  }
  return {
    cookies: [...cookies.values()],
    ...(referer && /^https?:/i.test(referer) && { referer }),
    userAgent: navigator.userAgent,
    name: browserName()
  }
}

function browserName(): string {
  const agent = navigator.userAgent
  if (/Firefox\//.test(agent)) return 'Firefox'
  if (/Edg\//.test(agent)) return 'Edge'
  if (/OPR\//.test(agent)) return 'Opera'
  if (/Vivaldi\//.test(agent)) return 'Vivaldi'
  if ('brave' in navigator) return 'Brave'
  return 'Chrome'
}

/** Only ever on a click: the host starts Mergelane if it isn't running, and waits for it. */
export async function wake(): Promise<boolean> {
  return reachOf(await call({ type: 'wake' }, 15_000)) === 'ok'
}
