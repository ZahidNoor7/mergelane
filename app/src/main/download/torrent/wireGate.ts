import type { Torrent, Wire } from 'webtorrent'

// Per peer, whether Mergelane uploads to it and whether it downloads from it, and how fast it
// sends: what upload routing and upload limits need (ADR-0041), without patching webtorrent further.
//
// webtorrent's documented API has none of this: its only upload control is `uploadLimit`, for a
// whole client (one per download here), on every network at once. So these hooks wrap, on one
// torrent and its wires only, methods of webtorrent 3.0.21's Torrent and bittorrent-protocol
// 5.0.9's Wire that are internal (read from their source; they're not in either README). Both
// versions are pinned (package-lock, patches/webtorrent+3.0.21.patch); check these on an upgrade.
//
// - Not uploading to a peer is keeping it choked (BEP 3): it may not request, and webtorrent's
//   rechoke gives its upload slots only to the peers that may be uploaded to.
// - Not downloading from a peer is never requesting from it, and saying so (uninterested). It is
//   still told what we have, so it can ask.
// - A block for a peer goes out once the upload limits allow it (Limits.takeUpload).

/** The parts of a webtorrent Torrent these hooks wrap or call (torrent.js; all internal). */
interface EngineTorrent {
  wires: Wire[]
  /** Asks one peer for blocks, when it isn't choking us. */
  _updateWire(wire: Wire): unknown
  /** Tells one peer whether we're interested in what it has. */
  _updateWireInterest(wire: Wire): void
  /** Every RECHOKE_INTERVAL (10 s): unchokes the best peers, one at random, chokes the rest. */
  _rechoke(): void
  /** Asks every peer for blocks again. */
  _update(): void
}

export interface WireRules {
  mayUpload(wire: Wire): boolean
  mayDownload(wire: Wire): boolean
}

/** Puts `rules` in force on `torrent`: right after client.add, before any peer connects. */
export function gateTorrent(torrent: Torrent, rules: WireRules): void {
  const engine = torrent as unknown as EngineTorrent
  const updateWire = engine._updateWire.bind(engine)
  engine._updateWire = (wire) => (rules.mayDownload(wire) ? updateWire(wire) : false)
  const updateInterest = engine._updateWireInterest.bind(engine)
  engine._updateWireInterest = (wire) =>
    rules.mayDownload(wire) ? updateInterest(wire) : wire.uninterested()
  const rechoke = engine._rechoke.bind(engine)
  engine._rechoke = () => {
    // The ranking sees only the peers that may be uploaded to, so none of the others takes a slot.
    const wires = engine.wires
    for (const wire of wires) if (!rules.mayUpload(wire)) wire.choke()
    engine.wires = wires.filter((wire) => rules.mayUpload(wire))
    try {
      rechoke()
    } finally {
      engine.wires = wires
    }
  }
}

/**
 * Puts `rules` in force on one peer, as it connects ('wire', before webtorrent sets it up): it is
 * unchoked only when it may be uploaded to (webtorrent unchokes a peer the moment it says it's
 * interested), and each block it's sent waits the `hold` ms the upload limits ask.
 */
export function gateWire(wire: Wire, rules: WireRules, hold: (bytes: number) => number): void {
  const unchoke = wire.unchoke.bind(wire)
  wire.unchoke = () => {
    if (rules.mayUpload(wire)) unchoke()
  }
  const piece = wire.piece.bind(wire)
  wire.piece = (index, offset, buffer) => {
    const wait = hold(buffer.length)
    if (wait <= 0) return piece(index, offset, buffer)
    // Held blocks keep their order: each waits at least as long as the one before (a bucket's
    // debt only grows with what's taken).
    setTimeout(() => {
      if (wire.destroyed) return
      // Choked meanwhile: as a choke does with what's asked (BEP 6), refused rather than sent.
      if (wire.amChoking) {
        if (wire.hasFast) wire.reject(index, offset, buffer.length)
        return
      }
      piece(index, offset, buffer)
    }, wait)
  }
}

/** The rules changed for `wire` (routing, or its network's part in this download): choked or
 * offered a slot now, and interest said again. The next rechoke settles the slots. */
export function regate(
  torrent: Torrent,
  wire: Wire,
  rules: WireRules,
  changed: { upload: boolean; download: boolean }
): void {
  const engine = torrent as unknown as EngineTorrent
  if (changed.upload) {
    if (!rules.mayUpload(wire)) wire.choke()
    else if (wire.peerInterested && !wire.isSeeder) wire.unchoke()
  }
  if (changed.download) {
    engine._updateWireInterest(wire)
    if (rules.mayDownload(wire)) engine._update()
  }
}
