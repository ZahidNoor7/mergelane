import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Marks <html> with the Liquid Glass look (data-glass="tinted") and with data-solid when the glass
 * is drawn solid, for main.css's Liquid Glass rules. Other themes ignore both. */
export function useGlassAttributes(): void {
  const glassLook = useAppStore((store) => store.glassLook)
  const solidGlass = useAppStore((store) => store.solidGlass)
  useEffect(() => {
    const root = document.documentElement
    if (glassLook === 'tinted') root.setAttribute('data-glass', 'tinted')
    else root.removeAttribute('data-glass')
    root.toggleAttribute('data-solid', solidGlass)
  }, [glassLook, solidGlass])
}
