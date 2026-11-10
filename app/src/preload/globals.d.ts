import type { MergelaneApi } from './index'

declare global {
  interface Window {
    mergelane: MergelaneApi
  }
}
