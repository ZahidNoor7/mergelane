import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { words } from '../platformWords'

/** If macOS refuses to pin connections to one network (IP_BOUND_IF), everything leaves through the
 * default route — only worth saying once there's a second network that won't get used. */
export function NetworkBindingDialog(): React.JSX.Element {
  const networkCount = useAppStore((store) => store.interfaces.length)
  const [supported, setSupported] = useState(true)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    window.mergelane.deviceBindingSupported().then(setSupported, () => {})
  }, [])

  return (
    <AlertDialog
      open={!supported && !dismissed && networkCount > 1}
      onOpenChange={(open) => {
        if (!open) setDismissed(true)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Only your default network can be used</AlertDialogTitle>
          <AlertDialogDescription>
            Mergelane couldn&apos;t send connections through a specific network on{' '}
            {words().thisComputer}, so every connection will go through your default network. The
            others will show no ping and won&apos;t add speed. Quitting and reopening Mergelane may
            fix this; if it doesn&apos;t, please report it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction>Got it</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
