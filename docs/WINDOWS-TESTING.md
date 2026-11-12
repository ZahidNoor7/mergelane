# Testing Mergelane on Windows

Claude builds everything on the owner's Mac and can't run Windows code. So Windows is tested in two places
(ADR-0054, `docs/WINDOWS-PLAN.md`, "How Windows is tested"):

- **On the Mac:** unit tests with recorded Windows data, Go cross-builds for `windows/amd64` and `windows/arm64`,
  and the Windows test kit's own tests.
- **On the owner's Windows laptop:** the Windows test kit. The owner runs it and pastes its report back into the
  chat.

## The Windows test kit

### What it does on the laptop

- Reads which Windows, which chip (x64 or arm64) and which Smart App Control setting the PC has. Read only.
- Notes the names, sizes and dates of the files in the Downloads folder before and after, to prove the tests never
  write there. It opens nothing.
- Runs Mergelane's Go test programs that the PC's chip can run, after checking that each one is the file that was
  built (SHA-256).
- Writes `report.txt` in the kit folder and copies it to the clipboard.

What it never does: it needs no administrator rights (it stops if it has them), changes no settings, installs
nothing, and writes nothing outside its own folder. The test programs use the TEMP folder and clean up after
themselves. `scripts/windows/kit.test.mjs` checks the script for commands that would change the system.

### Build it (on the Mac)

```sh
node scripts/windows/kit.mjs
```

This writes `dist/windows-kit/` and `dist/mergelane-windows-kit.zip` (both ignored by git). Options:
`--arch x64` or `--arch arm64` to build one chip only, `--out <dir>` for another folder, `--no-zip`. The builder
replaces only a folder that is empty or an earlier kit.

### Run it (on the laptop)

1. Copy `mergelane-windows-kit.zip` to the laptop, for example with a USB stick or a cloud drive.
2. Right-click the zip, choose **Extract All…**, and extract it (for example to the Desktop).
3. In the extracted `windows-kit` folder, double-click **Run test kit.cmd**. Not "Run as administrator".
   If Windows warns about the file first, choose to run it ("Run", or "More info" and then "Run anyway"): the kit
   isn't signed, so Windows doesn't know it yet.
4. Wait for **Done**. The report is on the clipboard and in `report.txt`.
5. Paste the report into the chat. Press a key to close the window.
6. To remove the kit, delete the folder (and the zip).

### Read the report (on the Mac)

Save the pasted text to a file, or pipe it:

```sh
node scripts/windows/report.mjs report.txt
pbpaste | node scripts/windows/report.mjs
```

It prints, in plain words: the Windows version and chip, Smart App Control, whether Downloads stayed unchanged,
each test program's result, and the coverage of the Windows-only Go files (`*_windows.go`). Exit code 0 means
everything that must pass passed; 1 means something failed or Downloads changed; 2 means no readable report.

### Adding Go packages

`GO_PACKAGES` in `scripts/windows/kit.mjs` lists the daemon packages the kit runs. Add a package once it builds
for Windows. Give it `until: 'W<n>'` while its tests aren't expected to pass on Windows yet; remove `until` when
that milestone lands, and from then on a failure fails the run.

### Known limits

- **Smart App Control On** blocks unsigned programs, the kit's included, with no way round it (ADR-0053). The
  report says so.
- **No `-race` on Windows:** the race detector needs cgo, which the cross-build leaves off. `go test -race` keeps
  running on the Mac.
- **x64 programs on an arm64 PC** run only on Windows 11 (emulation); on Windows 10 on Arm the kit skips them.
- **The PowerShell script is checked statically on the Mac**, not run, until PowerShell 7 is installed here
  (the owner's decision). Its first real run is on the laptop.
