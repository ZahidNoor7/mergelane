// macOS virtual tunnel interfaces, told by their names (ADR-0052). They carry traffic over a real network
// rather than being one, so Mergelane never offers them as networks for its downloads:
// - utun: user tunnels, made by VPN apps (Network Extension), iCloud Private Relay, and mergelane-daemon's
//   own for system merge;
// - ipsec: the built-in IKEv2 and IPsec VPN clients;
// - ppp: PPP links (L2TP, dial-up);
// - gif and stf: IPv6-in-IPv4 and 6to4 tunnels;
// - tun and tap: third-party tunnel drivers.

const MAC_TUNNEL = /^(utun|ipsec|ppp|gif|stf|tun|tap)\d+$/

/** Whether a macOS device name (en0, utun3) is a tunnel rather than a network of its own. */
export function isMacTunnel(device: string): boolean {
  return MAC_TUNNEL.test(device)
}
