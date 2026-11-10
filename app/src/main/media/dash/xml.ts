import { malformed } from './errors'

// A small, strict XML reader for MPDs. MPDs are machine-written, so a reader that refuses
// anything that isn't well-formed loses nothing real and leaves no room for a hostile document:
// no DTDs (so no entity expansion), no external anything, and bounded size, depth and element
// count. Every rule below is from W3C XML 1.0 (Fifth Edition), https://www.w3.org/TR/xml/, and
// Namespaces in XML 1.0, https://www.w3.org/TR/xml-names/; section numbers are theirs.

/** One element: its expanded name, attributes, child elements and the text directly inside it. */
export interface XmlElement {
  /** The namespace the element is in ('' for none): the prefix's binding, or the default
   * namespace when it has no prefix (Namespaces §6.2). */
  ns: string
  /** The local name: the part after the prefix, if there is one. */
  name: string
  /** Unprefixed attributes by name, which are in no namespace (Namespaces §6.2), and prefixed
   * ones as `{namespace}local`. Namespace declarations (xmlns, xmlns:p) aren't included. */
  attrs: Map<string, string>
  children: XmlElement[]
  /** The character data directly inside the element (text and CDATA), references decoded. */
  text: string
}

/** Larger than any real MPD; a SegmentList of 20,000 entries is well under 4 MB. */
export const MAX_XML_CHARS = 16 * 1024 * 1024
const MAX_ELEMENTS = 250_000
const MAX_DEPTH = 64

/** Bound by definition, never declared (Namespaces §3). */
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'

/** Anything outside the Char production (XML §2.2 [2]): controls, unpaired surrogates, FFFE/FFFF. */
const ILLEGAL_CHAR = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u
/** A name, optionally with one prefix (XML §2.3 [5], Namespaces §3 QName), narrowed to letters,
 * digits and `_ . -`, which covers every name the MPD schema and its extensions use. */
const QNAME = /[\p{L}_][\p{L}\p{N}_.-]*(?::[\p{L}_][\p{L}\p{N}_.-]*)?/uy
const SPACE = /[ \t\n]*/y
/** A character or entity reference (XML §4.1 [66], [68]), or a bare `&`, which XML doesn't allow. */
const REFERENCE = /&(?:#([0-9]+);|#x([0-9a-fA-F]+);|(amp|lt|gt|quot|apos);)?/g
/** The only entities a document without a DTD can use (XML §4.6). */
const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  )
}

function decodeReferences(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(
    REFERENCE,
    (whole, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (named !== undefined) return PREDEFINED[named]
      if (decimal === undefined && hex === undefined) {
        throw malformed('it has an “&” that doesn’t start a character or entity reference')
      }
      const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex as string, 16)
      // WFC: Legal Character (XML §4.1).
      if (!isXmlChar(code)) throw malformed(`it refers to a character XML doesn’t allow (${whole})`)
      return String.fromCodePoint(code)
    }
  )
}

function splitName(qname: string): [prefix: string, local: string] {
  const colon = qname.indexOf(':')
  return colon === -1 ? ['', qname] : [qname.slice(0, colon), qname.slice(colon + 1)]
}

interface OpenElement {
  element: XmlElement
  qname: string
  /** Prefix → namespace in scope here; '' is the default namespace. */
  scope: Map<string, string>
}

/**
 * Reads a whole XML document and returns its root element. Throws a {@link DashError} with code
 * 'malformed' at the first thing that isn't well-formed, or that this reader refuses on purpose:
 * a DOCTYPE or other markup declaration, more than {@link MAX_XML_CHARS} characters, more than
 * 64 levels of nesting or more than 250,000 elements.
 */
export function parseXml(input: string): XmlElement {
  if (input.length > MAX_XML_CHARS) throw malformed('it is larger than 16 MB')
  // A byte order mark isn't part of the document (XML §4.3.3).
  const unmarked = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const illegal = ILLEGAL_CHAR.exec(unmarked)
  if (illegal) {
    const code = (illegal[0].codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')
    throw malformed(`it contains a character XML doesn’t allow (U+${code})`)
  }
  // End-of-line handling (XML §2.11): CRLF and lone CR are read as LF.
  const source = unmarked.replace(/\r\n?/g, '\n')

  const stack: OpenElement[] = []
  let root: XmlElement | undefined
  let elementCount = 0

  const readName = (at: number, context: string): string => {
    QNAME.lastIndex = at
    const match = QNAME.exec(source)
    if (!match) throw malformed(`it has ${context} without a valid name`)
    return match[0]
  }
  const skipSpace = (at: number): number => {
    SPACE.lastIndex = at
    SPACE.exec(source)
    return SPACE.lastIndex
  }
  const skipPast = (terminator: string, from: number, what: string): number => {
    const end = source.indexOf(terminator, from)
    if (end === -1) throw malformed(`it has ${what} that never ends`)
    return end + terminator.length
  }

  const addText = (raw: string): void => {
    const open = stack.at(-1)
    if (!open) {
      // Only white space may sit outside the root element (XML §2.1 [1], [27]).
      if (/\S/.test(raw)) throw malformed('it has text outside the root element')
      return
    }
    // CharData may not contain "]]>" (XML §2.4 [14]).
    if (raw.includes(']]>')) throw malformed('it has “]]>” in text')
    open.element.text += decodeReferences(raw)
  }

  const readStartTag = (at: number): number => {
    const qname = readName(at, 'a tag')
    let cursor = at + qname.length
    const raw: [name: string, value: string][] = []
    let selfClosing = false
    for (;;) {
      const before = cursor
      cursor = skipSpace(cursor)
      if (source.startsWith('/>', cursor)) {
        selfClosing = true
        cursor += 2
        break
      }
      if (source[cursor] === '>') {
        cursor += 1
        break
      }
      // Attributes are separated from the name and each other by white space (XML §3.1 [40]).
      if (cursor === before || cursor >= source.length) {
        throw malformed(`its <${qname}> tag isn’t closed properly`)
      }
      const name = readName(cursor, `an attribute on <${qname}>`)
      cursor = skipSpace(cursor + name.length)
      if (source[cursor] !== '=') throw malformed(`attribute ${name} on <${qname}> has no value`)
      cursor = skipSpace(cursor + 1)
      const quote = source[cursor]
      if (quote !== '"' && quote !== "'") {
        throw malformed(`attribute ${name} on <${qname}> isn’t quoted`)
      }
      const close = source.indexOf(quote, cursor + 1)
      if (close === -1) throw malformed(`attribute ${name} on <${qname}> is never closed`)
      const value = source.slice(cursor + 1, close)
      // AttValue (XML §3.1 [10]) can't hold a literal "<".
      if (value.includes('<')) throw malformed(`attribute ${name} on <${qname}> contains “<”`)
      // WFC: Unique Att Spec (XML §3.1).
      if (raw.some(([seen]) => seen === name)) {
        throw malformed(`<${qname}> has attribute ${name} twice`)
      }
      // Attribute-value normalization for CDATA attributes (XML §3.3.3): literal white space
      // becomes a space, then references are replaced (so &#10; stays a line feed).
      raw.push([name, decodeReferences(value.replace(/[\t\n]/g, ' '))])
      cursor = close + 1
    }

    const parent = stack.at(-1)
    const inherited = parent?.scope ?? new Map([['xml', XML_NAMESPACE]])
    let scope = inherited
    for (const [name, value] of raw) {
      if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue
      const prefix = name === 'xmlns' ? '' : name.slice('xmlns:'.length)
      // Namespaces §3: xml is bound only to its own name and xmlns never declared; §5: a
      // prefix can't be undeclared in Namespaces 1.0 (only the default can, with xmlns="").
      if (prefix === 'xmlns' || (prefix === 'xml') !== (value === XML_NAMESPACE)) {
        throw malformed(`<${qname}> declares a reserved namespace prefix`)
      }
      if (prefix !== '' && value === '') throw malformed(`<${qname}> undeclares prefix ${prefix}`)
      if (scope === inherited) scope = new Map(inherited)
      scope.set(prefix, value)
    }

    const namespaceOf = (prefix: string, of: string): string => {
      const bound = scope.get(prefix)
      // Namespace constraint: Prefix Declared (Namespaces §5).
      if (bound === undefined)
        throw malformed(`${of} uses prefix ${prefix}, which is never declared`)
      return bound
    }
    const [prefix, local] = splitName(qname)
    const element: XmlElement = {
      ns: prefix === '' ? (scope.get('') ?? '') : namespaceOf(prefix, `<${qname}>`),
      name: local,
      attrs: new Map(),
      children: [],
      text: ''
    }
    for (const [name, value] of raw) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue
      const [attrPrefix, attrLocal] = splitName(name)
      const key =
        attrPrefix === '' ? name : `{${namespaceOf(attrPrefix, `attribute ${name}`)}}${attrLocal}`
      // Namespace constraint: Attributes Unique (Namespaces §6.3), on expanded names.
      if (element.attrs.has(key)) throw malformed(`<${qname}> has attribute ${key} twice`)
      element.attrs.set(key, value)
    }

    if (++elementCount > MAX_ELEMENTS) throw malformed('it has more than 250,000 elements')
    if (!parent) {
      if (root) throw malformed('it has more than one root element')
      root = element
    } else {
      if (stack.length >= MAX_DEPTH) throw malformed('it nests elements more than 64 deep')
      parent.element.children.push(element)
    }
    if (!selfClosing) stack.push({ element, qname, scope })
    return cursor
  }

  const readEndTag = (at: number): number => {
    const qname = readName(at, 'an end tag')
    const cursor = skipSpace(at + qname.length)
    if (source[cursor] !== '>') throw malformed(`its </${qname}> tag isn’t closed properly`)
    const open = stack.pop()
    // WFC: Element Type Match (XML §3 [39]).
    if (!open) throw malformed(`it has a </${qname}> that closes nothing`)
    if (open.qname !== qname) throw malformed(`<${open.qname}> is closed by </${qname}>`)
    return cursor + 1
  }

  let at = 0
  while (at < source.length) {
    const lt = source.indexOf('<', at)
    if (lt === -1) {
      addText(source.slice(at))
      break
    }
    if (lt > at) addText(source.slice(at, lt))
    if (source.startsWith('<!--', lt)) {
      at = skipPast('-->', lt + 4, 'a comment')
    } else if (source.startsWith('<?', lt)) {
      // The XML declaration and processing instructions carry nothing an MPD needs.
      at = skipPast('?>', lt + 2, 'a processing instruction')
    } else if (source.startsWith('<![CDATA[', lt)) {
      const end = skipPast(']]>', lt + 9, 'a CDATA section')
      const open = stack.at(-1)
      if (!open) throw malformed('it has a CDATA section outside the root element')
      open.element.text += source.slice(lt + 9, end - 3)
      at = end
    } else if (source.startsWith('<!', lt)) {
      // DOCTYPE and other declarations: refused, so no entity can be defined or expanded.
      throw malformed('it has a DOCTYPE or other declaration, which an MPD doesn’t use')
    } else if (source.startsWith('</', lt)) {
      at = readEndTag(lt + 2)
    } else {
      at = readStartTag(lt + 1)
    }
  }
  const unclosed = stack.at(-1)
  if (unclosed) throw malformed(`its <${unclosed.qname}> element is never closed`)
  if (!root) throw malformed('it has no root element')
  return root
}
