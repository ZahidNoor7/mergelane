import {
  installSteps,
  pickPath,
  type BrowsersReport,
  type BrowserState,
  type ExtensionSaved
} from '@shared/browsers'
import { CAPTURE_TYPES, MIN_SIZES, type MinSize } from '@shared/captureRules'
import { cn } from 'cn'
import {
  Check,
  Compass,
  Copy,
  ExternalLink,
  FolderOpen,
  Globe,
  Puzzle,
  RefreshCw
} from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { formatWhen, toDisplayPath } from '../utils/format'
import { SettingRow, SettingsGroup } from './settingsParts'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'

// Settings › Browser extensions, from the final design (prototype.html, ExtensionSettings and
// BrowserRow), for an extension loaded by hand (docs/DECISIONS.md ADR-0038): without a Chrome Web
// Store listing, macOS's Chrome-family browsers only take it through Developer mode's "Load
// unpacked", and release Firefox only as a temporary add-on. So the design's Install, Update and
// Uninstall buttons become a guide, and the browsers say honestly what they need.

/** "12 min ago", "today 08:55", or the date: formatWhen mid-sentence. */
const when = (time: number): string =>
  formatWhen(time, Date.now()).replace(/^(Just now|Today|Yesterday)/, (word) => word.toLowerCase())

function status(browser: BrowserState, shipped: string | null): string {
  if (browser.notYet) return browser.notYet
  if (!browser.found) return 'Not on this Mac. Install it, then scan again.'
  const { contact } = browser
  if (contact) {
    const version = contact.extension ? `, extension ${contact.extension}` : ''
    const stale =
      contact.extension && shipped && contact.extension !== shipped
        ? ` Restart ${browser.short} to use ${shipped}.`
        : ''
    return `Reached Mergelane ${when(contact.at)}${version}.${stale}`
  }
  if (!browser.extensionFolder) return 'The extension isn’t in this copy of Mergelane.'
  return browser.kind === 'firefox'
    ? 'Load the extension as a temporary add-on, after each Firefox restart.'
    : 'Load the extension once, by hand.'
}

/** "Scanned 12 min ago. The extension has reached Mergelane." */
function scannedText(report: BrowsersReport): string {
  return `Scanned ${when(report.scannedAt)}. ${
    report.extensionConnected
      ? 'The extension has reached Mergelane.'
      : 'No browser’s extension has reached Mergelane yet.'
  }`
}

function BrowserRow({
  browser,
  shipped,
  onInstall
}: {
  browser: BrowserState
  shipped: string | null
  onInstall: (browser: BrowserState) => void
}): React.JSX.Element {
  const Icon = browser.id === 'safari' ? Compass : Globe
  const dim = Boolean(browser.notYet) || !browser.found
  const ready = !dim && browser.extensionFolder !== null
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule py-3 last:border-b-0">
      <span
        aria-hidden
        className={cn(
          'inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-sunken text-ink-2 shadow-[inset_0_0_0_1px_var(--border)]',
          dim && 'opacity-55'
        )}
      >
        <Icon className="size-[18px]" strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <p className="text-[13.5px] font-[620]">{browser.name}</p>
        <p
          className={cn(
            'max-w-[60ch] text-[12.5px] leading-snug',
            dim ? 'text-ink-3' : 'text-ink-2'
          )}
        >
          {status(browser, shipped)}
        </p>
      </div>
      {ready &&
        (browser.contact ? (
          <Button variant="ghost" size="sm" onClick={() => onInstall(browser)}>
            Install again…
          </Button>
        ) : (
          <Button size="sm" onClick={() => onInstall(browser)}>
            <Puzzle aria-hidden />
            Install…
          </Button>
        ))}
    </li>
  )
}

/** What the guide shows: a browser, and the extension saved for it (or why it couldn't be). */
interface Guide {
  browser: BrowserState
  saved: ExtensionSaved
}

function InstallGuide({
  guide,
  onChooseFolder,
  onClose
}: {
  guide: Guide | null
  onChooseFolder: () => void
  onClose: () => void
}): React.JSX.Element {
  const homeDir = useAppStore((store) => store.homeDir)
  const [copied, setCopied] = useState<'path' | 'page' | null>(null)
  const browser = guide?.browser ?? null
  const steps = browser ? installSteps(browser) : []
  const copy = (text: string, what: 'path' | 'page'): void => {
    void navigator.clipboard.writeText(text).then(
      () => setCopied(what),
      () => {}
    )
  }
  const folder = guide?.saved.ok ? guide.saved.folder : null
  const pick = browser && folder ? pickPath({ ...browser, extensionFolder: folder }) : null
  /** The step where the browser asks for the folder (or Firefox's manifest.json). */
  const pickStep = browser?.kind === 'firefox' ? 2 : 3
  return (
    <Dialog
      open={guide !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(null)
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        {browser && guide && (
          <>
            <DialogHeader>
              <DialogTitle>Add Mergelane to {browser.short}</DialogTitle>
              <DialogDescription>
                {browser.kind === 'firefox'
                  ? 'Firefox only keeps an extension that Mozilla hasn’t signed until it quits.'
                  : `Until the extension is in the Chrome Web Store, ${browser.short} takes it from a folder on your Mac. Mergelane keeps that folder up to date.`}
              </DialogDescription>
            </DialogHeader>
            {!guide.saved.ok ? (
              <div className="flex flex-col items-start gap-2.5">
                <p role="alert" className="text-[13px] leading-[1.5] text-destructive">
                  {guide.saved.message}
                </p>
                <Button variant="secondary" size="sm" onClick={onChooseFolder}>
                  <FolderOpen aria-hidden />
                  Choose another folder…
                </Button>
              </div>
            ) : (
              <ol
                aria-label="Steps"
                className="flex list-decimal flex-col gap-2.5 pl-5 text-[13px]"
              >
                {steps.map((step, index) => (
                  <li key={step} className="pl-1 leading-[1.5]">
                    <span>{step}</span>
                    {index === 0 && folder && (
                      <div className="mt-1.5 flex min-w-0 flex-col items-start gap-2">
                        <code className="max-w-full rounded-[6px] bg-sunken px-1.5 py-0.5 font-mono text-[12px] [overflow-wrap:anywhere]">
                          {toDisplayPath(folder, homeDir)}
                        </code>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void window.mergelane.revealExtension(browser.id)}
                          >
                            <FolderOpen aria-hidden />
                            Show in Finder
                          </Button>
                        </div>
                      </div>
                    )}
                    {index === 1 && browser.extensionsPage && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <code className="rounded-[6px] bg-sunken px-1.5 py-0.5 font-mono text-[12px]">
                          {browser.extensionsPage}
                        </code>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copy(browser.extensionsPage ?? '', 'page')}
                        >
                          <Copy aria-hidden />
                          {copied === 'page' ? 'Copied' : 'Copy'}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void window.mergelane.openBrowser(browser.id)}
                        >
                          <ExternalLink aria-hidden />
                          Open {browser.short}
                        </Button>
                      </div>
                    )}
                    {index === pickStep && pick && (
                      <div className="mt-1.5 flex flex-col items-start gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => copy(pick, 'path')}>
                          <Copy aria-hidden />
                          {copied === 'path' ? 'Copied' : 'Copy path'}
                        </Button>
                        <p className="text-[12.5px] leading-[1.5] text-ink-2">
                          To go straight to it in the window that opens, press ⌘⇧G, paste the path
                          and press Return.
                        </p>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {guide.saved.ok && (
              <p className="text-[12.5px] leading-[1.5] text-ink-2">
                The extension’s icon turns on once {browser.short} reaches Mergelane. After
                Mergelane updates, restart {browser.short} to use the new version of the extension.
              </p>
            )}
            <DialogFooter showCloseButton />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function ExtensionSettings(): React.JSX.Element {
  const homeDir = useAppStore((store) => store.homeDir)
  const [report, setReport] = useState<BrowsersReport | null>(null)
  const [scanning, setScanning] = useState(true)
  const [guide, setGuide] = useState<Guide | null>(null)

  const load = useCallback(() => {
    window.mergelane.browsers().then(
      (next) => {
        setReport(next)
        setScanning(false)
      },
      () => setScanning(false)
    )
  }, [])
  useEffect(load, [load])
  const scan = (): void => {
    setScanning(true)
    load()
  }
  /** Saves the extension where the user keeps it, then guides loading it from there. */
  const install = async (browser: BrowserState): Promise<void> => {
    const saved = await window.mergelane
      .saveExtension(browser.id)
      .catch((error: unknown): ExtensionSaved => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }))
    setGuide({ browser, saved })
  }
  /** Asks where to save the extension; with a guide open, saves it there and carries on. */
  const chooseFolder = async (): Promise<void> => {
    const chosen = await window.mergelane.chooseExtensionLocation().catch(() => null)
    if (!chosen) return
    load()
    if (guide) await install(guide.browser)
  }

  const browsers = report?.browsers ?? []
  const onMac = browsers.filter((each) => each.found && !each.notYet)
  const elsewhere = browsers.filter((each) => !each.found || each.notYet)

  return (
    <>
      <SettingsGroup
        title="Browsers on this Mac"
        description="The Mergelane extension hands downloads from your browser to Mergelane, so they use every network."
        aside={
          <Button variant="secondary" size="sm" disabled={scanning} onClick={scan}>
            <RefreshCw aria-hidden className={cn(scanning && 'motion-safe:animate-spin')} />
            {scanning ? 'Looking…' : 'Scan again'}
          </Button>
        }
      >
        {report && (
          <SettingRow
            label="Save the extension in"
            hint={
              <>
                <span className="font-mono text-[12px] text-foreground [overflow-wrap:anywhere]">
                  {toDisplayPath(report.extensionLocation, homeDir)}
                </span>
                <br />
                Mergelane saves it here when you install, and keeps it up to date. Your browser
                loads it from here, so leave it in place.
              </>
            }
          >
            <Button type="button" size="sm" variant="secondary" onClick={() => void chooseFolder()}>
              <FolderOpen data-icon="inline-start" />
              Change…
            </Button>
          </SettingRow>
        )}
        {onMac.length > 0 ? (
          <ul aria-label="Browsers on this Mac" className="flex flex-col">
            {onMac.map((browser) => (
              <BrowserRow
                key={browser.id}
                browser={browser}
                shipped={report?.extensionVersion ?? null}
                onInstall={(chosen) => void install(chosen)}
              />
            ))}
          </ul>
        ) : (
          <p className="py-3 text-[12.5px] text-ink-2">
            {scanning ? 'Looking in Applications…' : 'No supported browser is on this Mac.'}
          </p>
        )}
        <p role="status" className="border-t border-rule py-2.5 text-[12px] text-ink-3">
          {scanning || !report ? 'Looking in Applications…' : scannedText(report)}
        </p>
      </SettingsGroup>

      {elsewhere.length > 0 && (
        <SettingsGroup title="Also supported, or coming">
          <ul aria-label="Other browsers" className="flex flex-col">
            {elsewhere.map((browser) => (
              <BrowserRow
                key={browser.id}
                browser={browser}
                shipped={report?.extensionVersion ?? null}
                onInstall={(chosen) => void install(chosen)}
              />
            ))}
          </ul>
        </SettingsGroup>
      )}

      <CaptureRulesGroup />

      <InstallGuide
        guide={guide}
        onChooseFolder={() => void chooseFolder()}
        onClose={() => setGuide(null)}
      />
    </>
  )
}

/** The design's "What the extension does": one set of rules for every browser (ADR-0039). Mergelane
 * applies them to each download; the extension reads whether sending is on and whether to list a
 * page's videos. */
function CaptureRulesGroup(): React.JSX.Element {
  const rules = useAppStore((store) => store.captureRules)
  const setRules = useAppStore((store) => store.setCaptureRules)
  const captureId = useId()
  const videoId = useId()
  const off = !rules.capture
  return (
    <SettingsGroup
      title="What the extension does"
      description="The same in every browser with the extension. Mergelane checks each download against these."
    >
      <SettingRow
        label="Send downloads to Mergelane"
        hint="Off, every browser keeps its downloads. Each browser’s extension can also be paused from its own menu."
        htmlFor={captureId}
      >
        <Switch
          id={captureId}
          checked={rules.capture}
          onCheckedChange={(capture) => setRules({ capture })}
        />
      </SettingRow>
      <SettingRow label="Only files larger than" hint="Smaller files stay with the browser.">
        <ToggleGroup
          aria-label="Only files larger than"
          disabled={off}
          value={[rules.minSize]}
          onValueChange={(values) => {
            if (values[0] !== undefined) setRules({ minSize: values[0] as MinSize })
          }}
        >
          {MIN_SIZES.map((size) => (
            <ToggleGroupItem key={size.id} value={size.id}>
              {size.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
      <div className="flex flex-col gap-2.5 border-b border-rule py-3 last:border-b-0">
        <div className="flex flex-col gap-0.5">
          <span className="text-[13.5px] font-[600]">File types</span>
          <p className="max-w-[60ch] text-[12.5px] leading-[1.5] text-ink-2">
            Mergelane takes only the types you pick, and files of a type it doesn’t know. Torrents,
            news files and video links always come.
          </p>
        </div>
        <div role="group" aria-label="File types" className="flex flex-wrap gap-1.5">
          {CAPTURE_TYPES.map((type) => {
            const on = rules.types.includes(type.id)
            return (
              <button
                key={type.id}
                type="button"
                aria-pressed={on}
                disabled={off}
                onClick={() =>
                  setRules({
                    types: on
                      ? rules.types.filter((each) => each !== type.id)
                      : [...rules.types, type.id]
                  })
                }
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-[580] transition-colors duration-100 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50',
                  on
                    ? 'bg-selected text-foreground shadow-[inset_0_0_0_1px_var(--color-accent)]'
                    : 'text-ink-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover'
                )}
              >
                {on && <Check aria-hidden className="size-3.5" strokeWidth={2.5} />}
                {type.label}
              </button>
            )
          })}
        </div>
      </div>
      <SettingRow
        label="List the videos on a page"
        hint="In the extension’s menu, with how many on its icon: on YouTube and pages that play HLS or DASH video."
        htmlFor={videoId}
      >
        <Switch
          id={videoId}
          checked={rules.videoButton}
          disabled={off}
          onCheckedChange={(videoButton) => setRules({ videoButton })}
        />
      </SettingRow>
    </SettingsGroup>
  )
}
