// Windows network adapters, as `Get-NetAdapter` describes them (the MSFT_NetAdapter class on Microsoft Learn):
// which ones are networks of their own, and what kind each is. Like macOS tunnels (tunnels.ts, ADR-0052), a
// virtual adapter carries traffic over a real network rather than being one, so a download bound to it would
// only go round through it: VPNs, Hyper-V and WSL switches, VirtualBox and VMware host adapters, and the Wintun
// adapter Mergelane's own helper adds for System merge.

import type { NetworkInterfaceKind } from './types'

/** The `Get-NetAdapter` fields Mergelane reads (network/interfaces.ts selects exactly these). */
export interface WindowsAdapter {
  Name: string
  InterfaceDescription: string
  /** MSFT_NetAdapter.NdisPhysicalMedium: 1 Wireless LAN, 8 Wireless WAN, 9 Native 802.11, 10 Bluetooth, 14 802.3. */
  NdisPhysicalMedium?: number
  /** "The network adapter emulates a physical network card." */
  Virtual?: boolean
  /** "The interface for the network adapter is provided by a hardware device." */
  HardwareInterface?: boolean
}

// Virtual adapters that can claim to be hardware, by their description (the driver's name, which Windows never
// translates). Ordered roughly by how common they are.
const VIRTUAL_DESCRIPTION =
  /hyper-v|vethernet|wsl|virtualbox|vmware|parallels|wintun|wireguard|tap-windows|tap-nordvpn|openvpn|tailscale|zerotier|nordlynx|expressvpn|protonvpn|surfshark|fortinet|forticlient|anyconnect|globalprotect|pangp|juniper|pulse secure|ivanti|sonicwall|checkpoint|check point|cloudflare warp|mullvad|loopback|teredo|isatap|6to4|kernel debug|mergelane/i

/** Why an adapter is not offered as a network for downloads, or null when it is one. */
export function windowsAdapterHidden(adapter: WindowsAdapter): string | null {
  if (adapter.Virtual === true) return 'a virtual adapter'
  if (VIRTUAL_DESCRIPTION.test(adapter.InterfaceDescription)) return 'a VPN or virtual adapter'
  // Software adapters (VPN clients, virtual switches) have no hardware behind them. A USB-tethered phone does:
  // its adapter is the USB device.
  if (adapter.HardwareInterface === false) return 'not a hardware adapter'
  return null
}

/** The kind of network an adapter is, from its physical medium first and then its description; null when
 * neither tells (network/interfaces.ts then falls back to the adapter's name). */
export function windowsAdapterKind(adapter: WindowsAdapter): NetworkInterfaceKind | null {
  const description = adapter.InterfaceDescription.toLowerCase()
  // Phones tethered over USB: Apple's driver ("Apple Mobile Device Ethernet") and Android's RNDIS or NCM ones
  // ("Remote NDIS based Internet Sharing Device", "UsbNcm Host Device") report 802.3, so they come first.
  if (/apple mobile device|rndis|remote ndis|usbncm|usb ncm|\bncm\b|tether/.test(description))
    return 'usb'
  switch (adapter.NdisPhysicalMedium) {
    case 1:
    case 9:
      return 'wifi'
    case 8:
    case 10:
      // Mobile broadband and Bluetooth tethering have no kind of their own; "other" keeps their names.
      return 'other'
    case 14:
      return /\busb\b/.test(description) ? 'usb' : 'ethernet'
  }
  return null
}
