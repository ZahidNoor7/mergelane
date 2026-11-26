// The SHA-256 a site publishes for a file (docs/plans/2026-11-new-features-plan.md, feature 4;
// ADR-0081): what tells the same file offered from another site. Pure, so it is unit-tested on its own.
//
// - Repr-Digest (RFC 9530) is a Structured Field Dictionary, `sha-256=:<base64>:`, "applied to the
//   entire selected representation data": a range response's still says the whole file's, which is
//   what Mergelane's 1 KiB probe gets.
// - Digest (RFC 3230, SHA-256 added by RFC 5843) is "obsoleted" by RFC 9530 and was implemented
//   inconsistently, so it is taken only when it says SHA-256 and decodes to a digest's 32 bytes, or
//   to its 64 hex characters (as RFC 5843's own example does).

const HEX = /^[0-9a-f]{64}$/i

/** 32 bytes of base64, or base64 of the 64 hex characters, as lowercase hex; else undefined. */
function sha256Of(base64: string): string | undefined {
  let text: string
  try {
    text = atob(base64.trim())
  } catch {
    return undefined
  }
  if (text.length === 32) {
    return [...text].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  }
  return HEX.test(text) ? text.toLowerCase() : undefined
}

/** A dictionary's or a list's members, split at the top level's commas. */
const members = (value: string): string[] =>
  value
    .split(',')
    .map((member) => member.trim())
    .filter(Boolean)

/** The SHA-256 the headers give the whole file, as lowercase hex; undefined when none does. */
export function publishedSha256(headers: {
  reprDigest?: string | null
  digest?: string | null
}): string | undefined {
  for (const member of members(headers.reprDigest ?? '')) {
    const match = /^sha-256=:([A-Za-z0-9+/=]+):/.exec(member)
    if (match) {
      const found = sha256Of(match[1])
      if (found) return found
    }
  }
  for (const member of members(headers.digest ?? '')) {
    const equals = member.indexOf('=')
    if (equals <= 0 || member.slice(0, equals).trim().toLowerCase() !== 'sha-256') continue
    const found = sha256Of(member.slice(equals + 1))
    if (found) return found
  }
  return undefined
}

/**
 * The SHA-256 a `.sha256` file beside the download gives it, as lowercase hex. The common forms:
 * the digest alone; `<digest>  <name>` (sha256sum, possibly `*<name>`); `SHA256 (<name>) = <digest>`
 * (BSD). Where lines name files, only this file's line counts.
 */
export function sha256FromFile(text: string, fileName: string): string | undefined {
  for (const raw of text.split(/\r?\n/).slice(0, 200)) {
    const line = raw.trim()
    if (!line) continue
    const bsd = /^SHA256 \((.+)\) = ([0-9a-f]{64})$/i.exec(line)
    if (bsd) {
      if (bsd[1] === fileName) return bsd[2].toLowerCase()
      continue
    }
    const gnu = /^([0-9a-f]{64})(?:\s+\*?(.+))?$/i.exec(line)
    if (gnu && (gnu[2] === undefined || gnu[2].trim() === fileName)) return gnu[1].toLowerCase()
  }
  return undefined
}
