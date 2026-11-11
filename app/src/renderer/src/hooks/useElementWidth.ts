import { useCallback, useRef, useState } from 'react'

/** Measures an element's width as it changes: pass the ref to the element, read the width. Zero
 * until the first measurement. */
export function useElementWidth(): [(node: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect()
    if (!node) return
    observer.current = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0))
    observer.current.observe(node)
  }, [])
  return [ref, width]
}
