# Mergelane's NSIS hooks (W4, ADR-0058); electron-builder picks up build/installer.nsh.

# .torrent and .nzb files can be opened with Mergelane, as one choice among others, as on macOS (LSHandlerRank
# Alternate). Each gets Mergelane's own ProgID under the current user's classes, and that ProgID is added to the
# extension's OpenWithProgids list, which puts Mergelane in Open with without changing the default app (Microsoft
# Learn: "How to Include an Application in the Open With Dialog Box"). The shell is then told associations changed
# (SHChangeNotify with SHCNE_ASSOCCHANGED, as "File Types" asks). magnet: links are not registered: a per-user
# handler would take them from a torrent app installed for all users (ADR-0058).
!macro mergelaneOpenWith EXT NAME
  WriteRegStr HKCU "Software\Classes\Mergelane.${EXT}" "" "${NAME}"
  WriteRegStr HKCU "Software\Classes\Mergelane.${EXT}\DefaultIcon" "" "$appExe,0"
  WriteRegStr HKCU "Software\Classes\Mergelane.${EXT}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "Mergelane.${EXT}" ""
!macroend

!macro customInstall
  !insertmacro mergelaneOpenWith torrent "Torrent file"
  !insertmacro mergelaneOpenWith nzb "NZB file"
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

# On a real uninstall (not the old version an update removes first), take out what Mergelane wrote under the
# current user: the Open with entries above, the browsers' native messaging keys and the manifests they point to
# (ADR-0056), the mergelane:// link handler, and the Open at login entry, which Electron names after the app's
# AppUserModelId. Each is Mergelane's own; another app's entries are not touched. The app's settings and downloads
# stay, as electron-builder's one-click uninstaller leaves app data by default. The uninstaller tells the shell
# about the association change itself.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Classes\.torrent\OpenWithProgids" "Mergelane.torrent"
    DeleteRegKey HKCU "Software\Classes\Mergelane.torrent"
    DeleteRegValue HKCU "Software\Classes\.nzb\OpenWithProgids" "Mergelane.nzb"
    DeleteRegKey HKCU "Software\Classes\Mergelane.nzb"
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\io.github.zahidnoor7.mergelane"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\io.github.zahidnoor7.mergelane"
    DeleteRegKey HKCU "Software\Mozilla\NativeMessagingHosts\io.github.zahidnoor7.mergelane"
    RMDir /r "$APPDATA\Mergelane\NativeMessagingHosts"
    DeleteRegKey HKCU "Software\Classes\mergelane"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.zahidnoor7.mergelane"
  ${endIf}
!macroend
