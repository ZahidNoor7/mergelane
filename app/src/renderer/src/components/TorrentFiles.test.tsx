import type { TorrentFileEntry, TorrentPieceState } from '@shared/types'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TorrentFileList, TorrentFiles } from './TorrentFiles'

const KB = 1024
// The design's FILM_PACK, smaller.
const FILES = [
  { path: 'open-film-pack/01-meadow.mkv', length: 400 * KB },
  { path: 'open-film-pack/02-harbour.mkv', length: 300 * KB },
  { path: 'open-film-pack/extras/making-of.mp4', length: 200 * KB },
  { path: 'open-film-pack/extras/subtitles/en.srt', length: 2 * KB },
  { path: 'open-film-pack/extras/subtitles/fr.srt', length: 2 * KB },
  { path: 'open-film-pack/README.txt', length: KB }
]

/** The list as New download holds it: its own choice, kept as it changes. */
function Chooser({
  done,
  onSkipped
}: {
  done?: number[]
  onSkipped?: (s: number[]) => void
}): React.JSX.Element {
  const [skipped, setSkipped] = useState<number[]>([])
  return (
    <TorrentFileList
      files={FILES}
      skipped={skipped}
      done={done}
      onChange={(next) => {
        setSkipped(next)
        onSkipped?.(next)
      }}
    />
  )
}

const box = (name: string): HTMLElement => screen.getByRole('checkbox', { name })
const summary = (): string =>
  screen.getByRole('group', { name: 'Files' }).querySelector('[aria-live]')!.textContent ?? ''

describe('choosing a torrent’s files', () => {
  it('lists the top files, then each folder, and says how many are chosen and their size', () => {
    render(<Chooser />)
    const list = screen.getByRole('list', { name: 'Files in this torrent' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      '01-meadow.mkv400.0 KB',
      '02-harbour.mkv300.0 KB',
      'README.txt1.0 KB',
      'extras',
      'making-of.mp4200.0 KB',
      'extras/subtitles',
      'en.srt2.0 KB',
      'fr.srt2.0 KB'
    ])
    expect(summary()).toBe('6 of 6 files, 905.0 KB')
  })

  it('a file, a folder or all of them at once, with the total as it goes', async () => {
    const skips: number[][] = []
    render(<Chooser onSkipped={(next) => skips.push(next)} />)
    await userEvent.click(box('README.txt'))
    expect(skips.at(-1)).toEqual([5])
    expect(summary()).toBe('5 of 6 files, 904.0 KB')
    await userEvent.click(box('Folder extras/subtitles'))
    expect(skips.at(-1)).toEqual([3, 4, 5])
    expect(box('All files').getAttribute('aria-checked')).toBe('mixed')
    await userEvent.click(box('Folder extras/subtitles'))
    expect(skips.at(-1)).toEqual([5])
    await userEvent.click(box('All files'))
    expect(skips.at(-1)).toEqual([])
    expect(box('All files').getAttribute('aria-checked')).toBe('true')
  })

  it('Videos only skips the rest', async () => {
    const skips: number[][] = []
    render(<Chooser onSkipped={(next) => skips.push(next)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Videos only' }))
    expect(skips.at(-1)).toEqual([3, 4, 5])
    expect(summary()).toBe('3 of 6 files, 900.0 KB')
    expect(screen.getAllByText('Skipped')).toHaveLength(3)
  })

  it('asks for one at least when none is left', async () => {
    render(<Chooser />)
    await userEvent.click(box('All files'))
    expect(screen.getByRole('alert').textContent).toBe('Choose at least one file.')
    expect(summary()).toBe('0 of 6 files, 0 B')
  })

  it('offers no Videos only where there is nothing to tell apart', () => {
    render(
      <TorrentFileList files={[{ path: 'a.iso', length: KB }]} skipped={[]} onChange={() => {}} />
    )
    expect(screen.queryByRole('button', { name: 'Videos only' })).toBeNull()
    expect(summary()).toBe('1 of 1 file, 1.0 KB')
  })

  it('as it runs: how far each is, one downloaded stays, unticking all leaves it', async () => {
    const skips: number[][] = []
    render(
      <Chooser done={[400 * KB, 150 * KB, 0, 0, 0, 0]} onSkipped={(next) => skips.push(next)} />
    )
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.getByText('50%')).toBeTruthy()
    expect(box('01-meadow.mkv').hasAttribute('data-disabled')).toBe(true)
    await userEvent.click(box('All files'))
    expect(skips.at(-1)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('a running torrent’s files', () => {
  const entries: TorrentFileEntry[] = FILES.map((file) => ({ ...file, chosen: true }))
  const piece = (index: number, status: TorrentPieceState['status']): TorrentPieceState =>
    ({
      index,
      kind: 'torrent',
      rangeStart: index * 400 * KB,
      rangeEnd: (index + 1) * 400 * KB - 1,
      bytesDownloaded: 0,
      provisionalBytes: 0,
      status
    }) as unknown as TorrentPieceState
  const torrentFiles = vi.fn<(id: string) => Promise<TorrentFileEntry[]>>(() =>
    Promise.resolve(entries)
  )
  const chooseTorrentFiles = vi.fn<(id: string, chosen: number[]) => Promise<void>>(() =>
    Promise.resolve()
  )

  beforeEach(() => {
    window.mergelane = {
      ...window.mergelane,
      torrentFiles,
      chooseTorrentFiles
    } as unknown as typeof window.mergelane
  })
  afterEach(() => vi.clearAllMocks())

  async function show(selected?: number[]): Promise<void> {
    render(<TorrentFiles downloadId="t" pieces={[piece(0, 'completed')]} selected={selected} />)
    await act(async () => {})
  }

  it('asks main for a new choice, and says what pieces of a skipped file still come', async () => {
    await show()
    expect(torrentFiles).toHaveBeenCalledWith('t')
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.getByText(/Pieces it shares with a chosen file are/)).toBeTruthy()
    await userEvent.click(box('README.txt'))
    expect(chooseTorrentFiles).toHaveBeenCalledWith('t', [0, 1, 2, 3, 4])
  })

  it('shows main’s choice, refuses none at all, and says why main refused', async () => {
    await show([0])
    expect(screen.getAllByText('Skipped')).toHaveLength(5)
    chooseTorrentFiles.mockImplementationOnce(() =>
      Promise.reject(new Error('Not enough disk space for the files you added'))
    )
    await userEvent.click(box('README.txt'))
    expect(screen.getByRole('alert').textContent).toBe(
      'Not enough disk space for the files you added'
    )
  })

  it('keeps at least one file', async () => {
    torrentFiles.mockImplementationOnce(() =>
      Promise.resolve([
        { path: 'Set/a.bin', length: KB, chosen: true },
        { path: 'Set/b.bin', length: KB, chosen: true }
      ])
    )
    render(<TorrentFiles downloadId="t" pieces={[]} selected={[1]} />)
    await act(async () => {})
    await userEvent.click(box('b.bin'))
    expect(chooseTorrentFiles).not.toHaveBeenCalled()
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(
      'Choose at least one file.'
    )
  })

  it('shows nothing until main has answered, and nothing late', async () => {
    let answer: (entries: TorrentFileEntry[]) => void = () => {}
    torrentFiles.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const { unmount, container } = render(
      <TorrentFiles downloadId="t" pieces={[]} selected={undefined} />
    )
    expect(container.textContent).toBe('')
    unmount()
    await act(async () => answer(entries))
  })
})
