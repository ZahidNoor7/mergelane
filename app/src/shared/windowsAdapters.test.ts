import { describe, expect, it } from 'vitest'
import { windowsAdapterHidden, windowsAdapterKind, type WindowsAdapter } from './windowsAdapters'

// Shaped like `Get-NetAdapter | Select-Object Name, InterfaceDescription, NdisPhysicalMedium, Virtual,
// HardwareInterface | ConvertTo-Json`, with the drivers' own descriptions.
const adapter = (
  InterfaceDescription: string,
  fields: Partial<WindowsAdapter> = {}
): WindowsAdapter => ({
  Name: 'Adapter',
  InterfaceDescription,
  NdisPhysicalMedium: 14,
  Virtual: false,
  HardwareInterface: true,
  ...fields
})

describe('windowsAdapterHidden', () => {
  it('offers real adapters, tethered phones included', () => {
    for (const real of [
      adapter('Intel(R) Wi-Fi 6 AX201 160MHz', { NdisPhysicalMedium: 9 }),
      adapter('Realtek PCIe GbE Family Controller'),
      adapter('Apple Mobile Device Ethernet'),
      adapter('Remote NDIS based Internet Sharing Device'),
      adapter('UsbNcm Host Device'),
      adapter('Bluetooth Device (Personal Area Network)', { NdisPhysicalMedium: 10 }),
      adapter('Qualcomm Snapdragon X65 5G Modem', { NdisPhysicalMedium: 8 }),
      // Older drivers leave the flags out entirely.
      adapter('Realtek USB GbE Family Controller', {
        Virtual: undefined,
        HardwareInterface: undefined
      })
    ]) {
      expect(windowsAdapterHidden(real), real.InterfaceDescription).toBeNull()
    }
  })

  it('hides virtual adapters, by their flags or their driver', () => {
    expect(windowsAdapterHidden(adapter('Some new switch', { Virtual: true }))).toBe(
      'a virtual adapter'
    )
    expect(windowsAdapterHidden(adapter('Some VPN client', { HardwareInterface: false }))).toBe(
      'not a hardware adapter'
    )
    for (const description of [
      'Hyper-V Virtual Ethernet Adapter',
      'vEthernet (WSL)',
      'VirtualBox Host-Only Ethernet Adapter',
      'VMware Virtual Ethernet Adapter for VMnet8',
      'WireGuard Tunnel',
      'Wintun Userspace Tunnel',
      'TAP-Windows Adapter V9',
      'Tailscale Tunnel',
      'ZeroTier Virtual Port',
      'Fortinet SSL VPN Virtual Ethernet Adapter',
      'Cisco AnyConnect Secure Mobility Client Virtual Miniport Adapter for Windows x64',
      'PANGP Virtual Ethernet Adapter Secure',
      'Microsoft KM-TEST Loopback Adapter',
      'Mergelane'
    ]) {
      expect(windowsAdapterHidden(adapter(description)), description).toBe(
        'a VPN or virtual adapter'
      )
    }
  })
})

describe('windowsAdapterKind', () => {
  it('reads the physical medium', () => {
    expect(
      windowsAdapterKind(adapter('Intel(R) Wi-Fi 6E AX211 160MHz', { NdisPhysicalMedium: 9 }))
    ).toBe('wifi')
    expect(windowsAdapterKind(adapter('Old card', { NdisPhysicalMedium: 1 }))).toBe('wifi')
    expect(windowsAdapterKind(adapter('Intel(R) Ethernet Connection (16) I219-LM'))).toBe(
      'ethernet'
    )
    expect(
      windowsAdapterKind(
        adapter('Bluetooth Device (Personal Area Network)', { NdisPhysicalMedium: 10 })
      )
    ).toBe('other')
    expect(
      windowsAdapterKind(adapter('Generic Mobile Broadband Adapter', { NdisPhysicalMedium: 8 }))
    ).toBe('other')
  })

  it('knows a phone or a USB adapter, though both report 802.3', () => {
    for (const description of [
      'Apple Mobile Device Ethernet',
      'Remote NDIS based Internet Sharing Device #2',
      'UsbNcm Host Device',
      'Realtek USB GbE Family Controller'
    ]) {
      expect(windowsAdapterKind(adapter(description)), description).toBe('usb')
    }
  })

  it('says nothing when neither the medium nor the description tells', () => {
    expect(windowsAdapterKind(adapter('Something', { NdisPhysicalMedium: 0 }))).toBeNull()
    expect(windowsAdapterKind(adapter('Something', { NdisPhysicalMedium: undefined }))).toBeNull()
  })
})
