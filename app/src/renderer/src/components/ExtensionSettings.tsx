import { installSteps, type BrowsersReport, type BrowserState } from '@shared/browsers'
import { cn } from 'cn'
import { Compass, Copy, FolderOpen, Globe, Puzzle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { formatWhen } from '../utils/format'
import { SettingsGroup } from './settingsParts'
import { Button } from './ui/button'
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

function status(browser: BrowserState): string {
  if (browser.notYet) return browser.notYet
  if (!browser.found) return 'Not on this Mac. Install it, then scan again.'
  if (!browser.extensionFolder) return 'The extension isn’t in this copy of Mergelane.'
  return browser.kind === 'firefox'
    ? 'Load the extension as a temporary add-on, after each Firefox restart.'
    : 'Load the extension once, by hand.'
}

/** "Scanned 12 min ago. The extension has reached Mergelane." */
function scannedText(report: BrowsersReport): string {
  const when = formatWhen(report.scannedAt, Date.now()).replace(
    /^(Just now|Today|Yesterday)/,
    (word) => word.toLowerCase()
  )
  return `Scanned ${when}. ${
    report.extensionConnected
      ? 'The extension has reached Mergelane.'
      : 'No browser’s extension has reached Mergelane yet.'
  }`
}

function BrowserRow({
  browser,
  onInstall
}: {
  browser: BrowserState
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
          {status(browser)}
        </p>
      </div>
      {ready && (
        <Button size="sm" onClick={() => onInstall(browser)}>
          <Puzzle aria-hidden />
          Install…
        </Button>
      )}
    </li>
  )
}

function InstallGuide({
  browser,
  onClose
}: {
  browser: BrowserState | null
  onClose: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const steps = browser ? installSteps(browser) : []
  return (
    <Dialog
      open={browser !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false)
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        {browser && (
          <>
            <DialogHeader>
              <DialogTitle>Add Mergelane to {browser.short}</DialogTitle>
              <DialogDescription>
                {browser.kind === 'firefox'
                  ? 'Firefox only keeps an extension that Mozilla hasn’t signed until it quits.'
                  : `Until the extension is in the Chrome Web Store, ${browser.short} takes it from a folder on your Mac. Mergelane keeps that folder up to date.`}
              </DialogDescription>
            </DialogHeader>
            <ol aria-label="Steps" className="flex list-decimal flex-col gap-2.5 pl-5 text-[13px]">
              {steps.map((step, index) => (
                <li key={step} className="pl-1 leading-[1.5]">
                  <span>{step}</span>
                  {index === 0 && (
                    <div className="mt-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void window.mergelane.revealExtension(browser.id)}
                      >
                        <FolderOpen aria-hidden />
                        Show in Finder
                      </Button>
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
                        onClick={() => {
                          void navigator.clipboard.writeText(browser.extensionsPage ?? '').then(
                            () => setCopied(true),
                            () => {}
                          )
                        }}
                      >
                        <Copy aria-hidden />
                        {copied ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
            <p className="text-[12.5px] leading-[1.5] text-ink-2">
              The extension’s icon turns on once {browser.short} reaches Mergelane. After Mergelane
              updates, restart {browser.short} to use the new version of the extension.
            </p>
            <DialogFooter showCloseButton />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function ExtensionSettings(): React.JSX.Element {
  const [report, setReport] = useState<BrowsersReport | null>(null)
  const [scanning, setScanning] = useState(true)
  const [guide, setGuide] = useState<BrowserState | null>(null)

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
        {onMac.length > 0 ? (
          <ul aria-label="Browsers on this Mac" className="flex flex-col">
            {onMac.map((browser) => (
              <BrowserRow key={browser.id} browser={browser} onInstall={setGuide} />
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
              <BrowserRow key={browser.id} browser={browser} onInstall={setGuide} />
            ))}
          </ul>
        </SettingsGroup>
      )}

      <InstallGuide browser={guide} onClose={() => setGuide(null)} />
    </>
  )
}
