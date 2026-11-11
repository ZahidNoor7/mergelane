import type { FileType } from '@shared/downloadFilters'
import { Disc3, File, FileArchive, FileText, Film, Image, Music, Package } from 'lucide-react'

/** Each file type's icon, as a download's file icon and the type filter's chips show it. */
export const FILE_TYPE_ICON: Record<FileType | 'other', typeof File> = {
  doc: FileText,
  image: Image,
  video: Film,
  audio: Music,
  archive: FileArchive,
  disk: Disc3,
  app: Package,
  other: File
}
