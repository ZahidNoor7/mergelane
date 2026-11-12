# Accessibility on Windows: the checklist (W6)

Run once on the Windows laptop before the Windows 1.0, and again after a change to the interface. Note each step
as passed, or what went wrong, and paste the list into the chat. The Mac's accessibility work (Phase 4) is the
reference; this checks that Windows' own tools see the same app.

## Narrator

Turn it on and off with **Windows logo key + Ctrl + Enter** (or Settings › Accessibility › Narrator).

1. Open Mergelane. Narrator says the window's name, "Mergelane".
2. Press Tab through the sidebar: every item is read by name (Downloads, Networks, Settings…), and the current
   one is said to be selected.
3. In Downloads, Tab to a download: its name, state and progress are read. Its buttons (pause, resume, remove)
   are read by what they do, not as "button".
4. Open **New download** (Ctrl+N): the dialog is announced, focus is inside it, Esc closes it, and focus goes back
   where it was.
5. In Networks, each network's name and kind are read; System merge's switch says whether it is on.
6. Install the helper (if it isn't): Windows' administrator prompt appears; after it, Narrator reads the new
   state. A refusal (a VPN on) is read out.
7. A finished download's notification is read by Narrator.

## Keyboard only

Unplug or ignore the mouse.

1. Every control in the sidebar, Downloads, Networks and Settings is reachable with Tab and Shift+Tab, in reading
   order, with a visible focus ring.
2. Space and Enter activate buttons and switches; arrow keys move within lists, menus and the quality picker.
3. Esc closes every dialog and menu, and focus returns to what opened it.
4. The shortcuts work with Ctrl: Ctrl+, opens Settings, Ctrl+N a new download.
5. The window's own buttons (minimize, maximize, close) at the top right can be reached as Windows allows
   (Alt+Space opens the window menu).

## Contrast and size

1. **Contrast themes:** Settings › Accessibility › Contrast themes, or Left Alt + Left Shift + Print Screen to
   toggle one (Microsoft Learn, "Contrast themes"). Every text, icon, focus ring and border stays visible, and no
   text sits on a picture or a glass effect without a solid background.
2. **Transparency effects off** (Settings › Accessibility › Visual effects): the Liquid Glass theme turns solid.
3. **Animation effects off** (same place): no sliding or springing motion remains; changes appear at once or fade.
4. **Text size** at 150% (Settings › Accessibility › Text size): nothing is cut off or overlaps; the window can
   still be resized down to its minimum.
5. **Display scale** at 150% and 200% (Settings › System › Display): the window, its icons and the title-bar
   buttons stay sharp and in place.
