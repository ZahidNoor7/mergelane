import { describe, expect, it } from 'vitest'
import {
  ELEVATION_CANCELED,
  WINDOWS_HELPER_PIPE,
  elevationOutcome,
  elevationScript,
  encodedCommand,
  powershellString,
  userSidFromWhoami,
  windowsArgument,
  windowsHelperBinary
} from './windowsHelper'

describe('the helper on Windows', () => {
  it('is installed in Program Files, and answers on its pipe', () => {
    expect(windowsHelperBinary()).toBe('C:\\Program Files\\Mergelane\\mergelane-daemon.exe')
    expect(windowsHelperBinary('D:\\Programs\\')).toBe(
      'D:\\Programs\\Mergelane\\mergelane-daemon.exe'
    )
    expect(WINDOWS_HELPER_PIPE).toBe('\\\\.\\pipe\\mergelane-daemon')
  })

  it('reads the user’s own SID from whoami, and nothing else', () => {
    expect(
      userSidFromWhoami('"desktop-7\\ana","S-1-5-21-1004336348-1177238915-682003330-1001"\r\n')
    ).toBe('S-1-5-21-1004336348-1177238915-682003330-1001')
    expect(userSidFromWhoami('"azuread\\ana","S-1-12-1-1-2-3-4"')).toBe('S-1-12-1-1-2-3-4')
    for (const output of [
      '',
      '"x","S-1-1-0"',
      '"x","S-1-5-32-545"',
      '"x","S-1-5-18"',
      'whoami: error'
    ]) {
      expect(userSidFromWhoami(output)).toBeNull()
    }
  })

  it('quotes arguments as CommandLineToArgvW reads them back', () => {
    expect(windowsArgument('install')).toBe('install')
    expect(windowsArgument('')).toBe('""')
    expect(windowsArgument('C:\\Users\\Ana Lee\\AppData\\mergelane-daemon.exe')).toBe(
      '"C:\\Users\\Ana Lee\\AppData\\mergelane-daemon.exe"'
    )
    // Backslashes before a quote, and before the closing quote, are doubled; others stay.
    expect(windowsArgument('a "b"')).toBe('"a \\"b\\""')
    expect(windowsArgument('C:\\a b\\')).toBe('"C:\\a b\\\\"')
    expect(windowsArgument('x\\\\"y z')).toBe('"x\\\\\\\\\\"y z"')
    expect(powershellString("it's")).toBe("'it''s'")
  })

  it('starts the helper elevated, waits, and passes its exit code on', () => {
    const script = elevationScript("C:\\Users\\O'Neil\\x.exe", [
      'install',
      '--report',
      'C:\\Temp\\a b.txt'
    ])
    expect(script).toContain(
      "Start-Process -FilePath 'C:\\Users\\O''Neil\\x.exe' -ArgumentList 'install --report \"C:\\Temp\\a b.txt\"' -Verb RunAs -WindowStyle Hidden -Wait -PassThru"
    )
    expect(script).toContain('exit $p.ExitCode')
    expect(script).toContain(
      `if ($e.NativeErrorCode -eq ${ELEVATION_CANCELED}) { exit ${ELEVATION_CANCELED} }`
    )
  })

  it('encodes the script as UTF-16LE base64 for -EncodedCommand', () => {
    expect(encodedCommand('ab')).toBe('YQBiAA==')
    expect(atob(encodedCommand('é'))).toBe('\u00e9\u0000')
    expect(atob(encodedCommand('😀'))).toBe('=Ø\u0000Þ')
  })

  it('reads what an elevated run came to', () => {
    expect(elevationOutcome(0, 'ok\n', '')).toEqual({ ok: true, canceled: false, reason: '' })
    expect(elevationOutcome(ELEVATION_CANCELED, null, '')).toEqual({
      ok: false,
      canceled: true,
      reason: 'canceled'
    })
    expect(elevationOutcome(1, 'error: install: wintun.dll is missing\n', '').reason).toBe(
      'install: wintun.dll is missing'
    )
    expect(elevationOutcome(1, null, 'Start-Process : file not found\n  at line 1').reason).toBe(
      'Start-Process : file not found at line 1'
    )
    expect(elevationOutcome(0, null, '').reason).toBe('the helper didn’t say whether it finished.')
    expect(elevationOutcome(5, '', '').reason).toBe('the helper ended with code 5.')
    expect(elevationOutcome(null, null, '').reason).toBe('the helper ended with code unknown.')
  })
})
