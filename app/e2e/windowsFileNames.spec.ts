import { expect, test } from '@playwright/test'
import { sanitizeFileName } from '../src/main/download/paths'

// Windows' file-name rules, checked here on any computer (W1). From Microsoft Learn, "Naming Files, Paths, and
// Namespaces": the reserved characters < > : " / \ | ? *, control characters, the reserved device names (also
// with an extension, and the superscript-digit COM and LPT ones), and no trailing dot or space.

test.describe('file names on Windows @smoke', () => {
  test('replaces the characters Windows reserves', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.zip', 'win32')).toBe('a_b_c_d_e_f_g_h.zip')
    expect(sanitizeFileName('dir\\sub/file.txt', 'win32')).toBe('dir_sub_file.txt')
    expect(sanitizeFileName('tab\there.txt', 'win32')).toBe('tab_here.txt')
  })

  test('keeps clear of device names, also with an extension', () => {
    for (const name of ['CON', 'prn.txt', 'Aux.tar.gz', 'NUL', 'com1.log', 'LPT9', 'COM¹']) {
      expect(sanitizeFileName(name, 'win32'), name).toBe(`_${name}`)
    }
    expect(sanitizeFileName('console.txt', 'win32')).toBe('console.txt')
    expect(sanitizeFileName('com10.txt', 'win32')).toBe('com10.txt')
  })

  test('drops trailing dots and spaces, and names an empty result', () => {
    expect(sanitizeFileName('report. . ', 'win32')).toBe('report')
    expect(sanitizeFileName('...', 'win32')).toBe('download')
    expect(sanitizeFileName(' . ', 'win32')).toBe('download')
  })

  test('leaves macOS names as they were', () => {
    expect(sanitizeFileName('a:b?.zip', 'darwin')).toBe('a:b?.zip')
    expect(sanitizeFileName('CON', 'darwin')).toBe('CON')
  })
})
