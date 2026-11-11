import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Listens for the links main finds on the clipboard as the user switches to Mergelane, with
 * "Offer links I copy" on (ADR-0043); CopiedLinkOffer.tsx shows them. Mounted once, in App. */
export function useCopiedLinks(): void {
  const offerCopiedLink = useAppStore((store) => store.offerCopiedLink)
  useEffect(() => window.mergelane.onCopiedLink(offerCopiedLink), [offerCopiedLink])
}
