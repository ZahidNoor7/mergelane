/**
 * The app's themes (ADR-0034), as in the owner's final design
 * (design-system/mergelane/redesign/prototype.html, ML_THEMES). Each theme is a handful of seed colours for
 * light and for dark; every other colour is derived from them in CSS (assets/main.css), so a theme
 * reaches every surface, line, control and chart.
 *
 * Shared by both processes: the renderer writes the seeds as CSS (theme/themeCss.ts), and the main
 * process paints the window background with the theme's ground so it never flashes another colour.
 */

/** One mode's seeds. Percentages tune how strongly the ink shows through for lines and text. */
export interface ThemeSeeds {
  /** Behind the window (the prototype's page). */
  desk: string
  /** The window's own ground, behind the sidebar. */
  window: string
  sidebar: string
  /** Ink on the sidebar when it differs from the content ink (a dark sidebar in light mode). */
  sidebarInk?: string
  sidebarCard: string
  /** The sidebar is dark even in light mode, so its switches get dark-mode thumbs. */
  sidebarDark?: boolean
  bg: string
  card: string
  text: string
  accent: string
  /** Glyphs and text drawn on the accent. */
  accentOn: string
  /** The accent when used as text or an icon, where it differs from the accent fill. */
  accentInk?: string
  wifi: string
  usb: string
  ethernet: string
  /** Glyphs drawn on a network colour. */
  netOn: string
  line?: string
  lineSubtle?: string
  lineStrong?: string
  ink2?: string
  ink3?: string
}

export interface Theme {
  id: string
  name: string
  description: string
  light: ThemeSeeds
  dark: ThemeSeeds
}

export const THEMES = [
  {
    id: 'porcelain',
    name: 'Porcelain',
    description: 'Cool grey-blue with a cobalt accent. The default.',
    light: {
      desk: '#DDE3E9',
      window: '#E4E9EE',
      sidebar: '#EBF0F4',
      sidebarCard: '#FFFFFF',
      bg: '#FBFCFD',
      card: '#FFFFFF',
      text: '#101B22',
      accent: '#2853C7',
      accentOn: '#FFFFFF',
      wifi: '#9140B8',
      usb: '#5A8605',
      ethernet: '#00857B',
      netOn: '#FFFFFF'
    },
    dark: {
      desk: '#070B0E',
      window: '#0C1216',
      sidebar: '#11191E',
      sidebarCard: '#1E2930',
      bg: '#151D22',
      card: '#1B252B',
      text: '#E5EDF1',
      accent: '#86A8FF',
      accentOn: '#0C1216',
      wifi: '#C98CF0',
      usb: '#8CC43A',
      ethernet: '#2EC2B2',
      netOn: '#0C1216'
    }
  },
  {
    id: 'sandstone',
    name: 'Sandstone',
    description: 'Warm paper and stone, with a wine accent.',
    light: {
      desk: '#E4DCCF',
      window: '#EBE4D9',
      sidebar: '#F1EADF',
      sidebarCard: '#FFFDF9',
      bg: '#FCFAF6',
      card: '#FFFFFF',
      text: '#241C14',
      accent: '#8E2C55',
      accentOn: '#FFFFFF',
      wifi: '#4E5BD0',
      usb: '#5E8A05',
      ethernet: '#0B8292',
      netOn: '#FFFFFF'
    },
    dark: {
      desk: '#0C0A08',
      window: '#13110E',
      sidebar: '#1A1612',
      sidebarCard: '#28221C',
      bg: '#1E1A16',
      card: '#26211C',
      text: '#F1EAE0',
      accent: '#F08DB5',
      accentOn: '#1E1A16',
      wifi: '#8E99F5',
      usb: '#8CC43A',
      ethernet: '#3BC0CF',
      netOn: '#14110E'
    }
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Neutral grey, a dark sidebar and a signal-orange accent.',
    light: {
      desk: '#D7D7DA',
      window: '#E1E1E4',
      sidebar: '#1C1C1F',
      sidebarInk: '#EDEDEF',
      sidebarCard: '#2C2C31',
      sidebarDark: true,
      bg: '#FAFAFA',
      card: '#FFFFFF',
      text: '#18181B',
      accent: '#C2410C',
      accentOn: '#FFFFFF',
      wifi: '#6D4AE0',
      usb: '#3F8F1F',
      ethernet: '#0782A6',
      netOn: '#FFFFFF'
    },
    dark: {
      desk: '#060607',
      window: '#0D0D0F',
      sidebar: '#111113',
      sidebarCard: '#232327',
      bg: '#18181B',
      card: '#1F1F23',
      text: '#EDEDEF',
      accent: '#FB923C',
      accentOn: '#18181B',
      wifi: '#9D85F5',
      usb: '#6CC04A',
      ethernet: '#38BDF8',
      netOn: '#111113'
    }
  },
  {
    id: 'sage',
    name: 'Sage',
    description: 'Soft green-grey with a pine accent. Easy on the eyes.',
    light: {
      desk: '#D9E3DC',
      window: '#E1E9E3',
      sidebar: '#E4EDE6',
      sidebarCard: '#F8FBF9',
      bg: '#FAFCFA',
      card: '#FFFFFF',
      text: '#12201A',
      accent: '#2F6B4F',
      accentOn: '#FFFFFF',
      wifi: '#6A52CC',
      usb: '#B23C7E',
      ethernet: '#2563C9',
      netOn: '#FFFFFF'
    },
    dark: {
      desk: '#070C0A',
      window: '#0C1310',
      sidebar: '#101915',
      sidebarCard: '#1D2A23',
      bg: '#141E19',
      card: '#1A2620',
      text: '#E3EFE8',
      accent: '#6FCF9E',
      accentOn: '#0E1612',
      wifi: '#A08EF2',
      usb: '#E77DB8',
      ethernet: '#6FA0F5',
      netOn: '#0E1612'
    }
  },
  {
    id: 'dusk',
    name: 'Dusk',
    description: 'Deep indigo sidebar, lavender grounds, a berry accent.',
    light: {
      desk: '#DEDBEA',
      window: '#E6E3F0',
      sidebar: '#28233D',
      sidebarInk: '#EEEAF8',
      sidebarCard: '#3A3456',
      sidebarDark: true,
      bg: '#FBFAFE',
      card: '#FFFFFF',
      text: '#1C1830',
      accent: '#B0257A',
      accentOn: '#FFFFFF',
      wifi: '#4C6EF5',
      usb: '#5C940D',
      ethernet: '#0C8599',
      netOn: '#FFFFFF'
    },
    dark: {
      desk: '#08070D',
      window: '#0E0C16',
      sidebar: '#15121F',
      sidebarCard: '#241F36',
      bg: '#191626',
      card: '#201C30',
      text: '#ECE8F7',
      accent: '#F28AC6',
      accentOn: '#191626',
      wifi: '#8DA2FF',
      usb: '#94D82D',
      ethernet: '#3BC9DB',
      netOn: '#15121F'
    }
  },
  {
    id: 'liquid',
    name: 'Liquid Glass',
    description: 'macOS 27: layered glass in soft, low-glare tones, a calm blue, SF Pro.',
    light: {
      desk: '#F7FAFF',
      window: '#F2F5FB',
      sidebar: '#F4F6FB',
      sidebarCard: '#FFFFFF',
      bg: '#F7F9FD',
      card: '#FFFFFF',
      text: '#262A33',
      accent: '#2F6FDB',
      accentOn: '#FFFFFF',
      accentInk: '#2C6BD6',
      wifi: '#6550E8',
      usb: '#0B8F7A',
      ethernet: '#D9541F',
      netOn: '#FFFFFF',
      ink2: '82%',
      ink3: '70%'
    },
    dark: {
      desk: '#05070E',
      window: '#0C0F18',
      sidebar: '#141824',
      sidebarCard: '#1A1F2C',
      bg: '#0F131C',
      card: '#161B26',
      text: '#E4E7EE',
      accent: '#2F6FDB',
      accentOn: '#FFFFFF',
      accentInk: '#7FB0FF',
      wifi: '#9C8CFF',
      usb: '#36D6BC',
      ethernet: '#FF8A5C',
      netOn: '#0A0C14',
      ink2: '82%',
      ink3: '70%'
    }
  },
  {
    id: 'contrast',
    name: 'High contrast',
    description: 'Black and white, strongest lines, a pure blue accent.',
    light: {
      desk: '#CCCCCC',
      window: '#DEDEDE',
      sidebar: '#F2F2F2',
      sidebarCard: '#FFFFFF',
      bg: '#FFFFFF',
      card: '#FFFFFF',
      text: '#000000',
      accent: '#0039C6',
      accentOn: '#FFFFFF',
      wifi: '#7A1FB8',
      usb: '#2B6E00',
      ethernet: '#006C80',
      netOn: '#FFFFFF',
      line: '48%',
      lineSubtle: '30%',
      lineStrong: '72%',
      ink2: '90%',
      ink3: '82%'
    },
    dark: {
      desk: '#000000',
      window: '#000000',
      sidebar: '#0A0A0A',
      sidebarCard: '#1A1A1A',
      bg: '#000000',
      card: '#0D0D0D',
      text: '#FFFFFF',
      accent: '#7DB1FF',
      accentOn: '#000000',
      wifi: '#D19BFF',
      usb: '#8BE05A',
      ethernet: '#4FD8F0',
      netOn: '#000000',
      line: '50%',
      lineSubtle: '34%',
      lineStrong: '72%',
      ink2: '90%',
      ink3: '82%'
    }
  }
] as const satisfies readonly Theme[]

export type ThemeId = (typeof THEMES)[number]['id']

export const DEFAULT_THEME_ID: ThemeId = 'porcelain'

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value)
}

/** The theme with this id, or the default for an unknown one (a theme removed in a later version). */
export function themeById(id: unknown): (typeof THEMES)[number] {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]
}

/** The window's background before the page paints: the theme's content ground for the mode. */
export function windowBackground(themeId: unknown, dark: boolean): string {
  const theme = themeById(themeId)
  return dark ? theme.dark.bg : theme.light.bg
}

/** A saved light/dark choice, or undefined for anything else. 'system' is Auto: follow the Mac. */
export function validThemeSource(value: unknown): 'system' | 'light' | 'dark' | undefined {
  return value === 'system' || value === 'light' || value === 'dark' ? value : undefined
}
