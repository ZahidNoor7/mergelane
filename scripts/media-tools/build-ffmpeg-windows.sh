#!/usr/bin/env bash
# Builds Mergelane's own FFmpeg for Windows on the Mac (W3, ADR-0057, docs/MEDIA-TOOLS.md): the same LGPL
# configuration as build-ffmpeg.sh, cross-compiled with llvm-mingw, with zlib built from its own pinned source and
# linked in statically.
#
#   scripts/media-tools/build-ffmpeg-windows.sh <ffmpeg-X.Y.Z.tar.xz> <output dir> <x64|arm64> \
#       <llvm-mingw-...-macos-universal.tar.xz> <zlib-X.Y.Z.tar.gz>
#
# Every archive must already be verified: fetch.mjs checks their pinned SHA-256s (tools-windows-<arch>.json)
# before calling this. The program is written as <output dir>/ffmpeg.exe.
#
# The component lists are build-ffmpeg.sh's, word for word (fetch.test.mjs checks they stay the same): stream copy
# only, files and pipes only, no network, no devices. Not configured with --enable-gpl or --enable-version3, so
# the program is licensed LGPL version 2.1 or later. Its exact Corresponding Source is the three archives plus
# this script.
#
# A Windows program can't run here, so where build-ffmpeg.sh asks the program, this reads the configuration
# FFmpeg wrote (config.h) and the DLLs the program imports.
set -euo pipefail

usage='usage: build-ffmpeg-windows.sh <ffmpeg.tar.xz> <output dir> <x64|arm64> <llvm-mingw.tar.xz> <zlib.tar.gz>'
TARBALL=${1:?$usage}
OUT=${2:?$usage}
ARCH=${3:?$usage}
TOOLCHAIN=${4:?$usage}
ZLIB=${5:?$usage}

# x64's hand-written assembly needs nasm, a tool this Mac doesn't have; stream copy decodes almost nothing, so it is
# left out rather than another tool installed. arm64's assembly is built by clang itself, as on the Mac.
case "$ARCH" in
  x64) TRIPLE=x86_64-w64-mingw32 FFARCH=x86_64 ASM=--disable-x86asm ;;
  arm64) TRIPLE=aarch64-w64-mingw32 FFARCH=aarch64 ASM= ;;
  *) echo "build-ffmpeg-windows.sh: the chip must be x64 or arm64, not $ARCH" >&2; exit 2 ;;
esac
[ "$(uname -s)" = Darwin ] || { echo "build-ffmpeg-windows.sh: runs on macOS (llvm-mingw's macOS build)" >&2; exit 1; }
# The build changes folder, so the output folder is made and resolved first.
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

# The same lists as build-ffmpeg.sh.
DEMUXERS=mov,mpegts,matroska,aac,mp3,ac3,eac3
MUXERS=mp4,matroska
PARSERS=h264,hevc,av1,vp8,vp9,aac,aac_latm,ac3,mpegaudio,opus,flac,vorbis
DECODERS=aac,aac_latm,mp3,ac3,eac3,opus,flac,vorbis,vp9
BSFS=aac_adtstoasc,vp9_superframe,extract_extradata

WORK=$(mktemp -d "${TMPDIR:-/tmp}/mergelane-ffmpeg-windows.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
JOBS=$(sysctl -n hw.ncpu)

echo "unpacking llvm-mingw"
tar -xJf "$TOOLCHAIN" -C "$WORK"
TC=$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'llvm-mingw-*' | head -1)
[ -n "$TC" ] || { echo "build-ffmpeg-windows.sh: no llvm-mingw-* folder in $TOOLCHAIN" >&2; exit 1; }
export PATH="$TC/bin:$PATH"
command -v "$TRIPLE-clang" >/dev/null || { echo "build-ffmpeg-windows.sh: $TRIPLE-clang is not in $TC/bin" >&2; exit 1; }

echo "building zlib for $TRIPLE"
tar -xzf "$ZLIB" -C "$WORK"
ZSRC=$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'zlib-*' | head -1)
[ -n "$ZSRC" ] || { echo "build-ffmpeg-windows.sh: no zlib-* folder in $ZLIB" >&2; exit 1; }
ZPREFIX="$WORK/zlib-prefix"
mkdir -p "$ZPREFIX/include" "$ZPREFIX/lib"
# zlib's own makefile for MinGW (win32/Makefile.gcc), with the toolchain's prefix; the static library only.
make -C "$ZSRC" -f win32/Makefile.gcc PREFIX="$TRIPLE-" -j"$JOBS" libz.a
cp "$ZSRC/zlib.h" "$ZSRC/zconf.h" "$ZPREFIX/include/"
cp "$ZSRC/libz.a" "$ZPREFIX/lib/"

echo "configuring FFmpeg for Windows $ARCH"
tar -xJf "$TARBALL" -C "$WORK"
SRC=$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'ffmpeg-*' | head -1)
[ -n "$SRC" ] || { echo "build-ffmpeg-windows.sh: no ffmpeg-* folder in $TARBALL" >&2; exit 1; }
cd "$SRC"
./configure \
  --enable-cross-compile --target-os=mingw32 --arch="$FFARCH" \
  --cross-prefix="$TRIPLE-" --cc="$TRIPLE-clang" ${ASM:+"$ASM"} \
  --extra-cflags="-I$ZPREFIX/include" --extra-ldflags="-L$ZPREFIX/lib -static" \
  --extra-version=mergelane \
  --disable-everything --disable-autodetect --disable-network \
  --disable-doc --disable-debug --disable-ffplay --disable-ffprobe --disable-avdevice --disable-swscale \
  --enable-zlib \
  --enable-protocol=file,pipe \
  --enable-demuxer="$DEMUXERS" \
  --enable-muxer="$MUXERS" \
  --enable-parser="$PARSERS" \
  --enable-decoder="$DECODERS" \
  --enable-bsf="$BSFS"

# Refuse a configuration that would make the program GPL, GPL version 3 or non-free.
for flag in CONFIG_GPL CONFIG_VERSION3 CONFIG_NONFREE; do
  grep -q "^#define $flag 0\$" config.h || {
    echo "build-ffmpeg-windows.sh: config.h does not say $flag 0: the program would not be LGPL" >&2
    exit 1
  }
done
grep -q '^#define CONFIG_ZLIB 1$' config.h || { echo "build-ffmpeg-windows.sh: zlib was not found" >&2; exit 1; }

make -j"$JOBS" ffmpeg.exe
[ -f ffmpeg.exe ] || { echo "build-ffmpeg-windows.sh: make did not write ffmpeg.exe" >&2; exit 1; }

# The program must need only Windows' own DLLs: no MinGW, C++ or zlib DLL that Mergelane doesn't ship.
IMPORTS=$(llvm-objdump -p ffmpeg.exe | awk '/DLL Name:/ {print tolower($3)}' | sort -u)
echo "ffmpeg.exe imports: $(tr '\n' ' ' <<<"$IMPORTS")"
while read -r dll; do
  case "$dll" in
    kernel32.dll | user32.dll | advapi32.dll | bcrypt.dll | shell32.dll | ole32.dll | ws2_32.dll | api-ms-win-*.dll) ;;
    *) echo "build-ffmpeg-windows.sh: ffmpeg.exe needs $dll, which Windows doesn't have" >&2; exit 1 ;;
  esac
done <<<"$IMPORTS"

mkdir -p "$OUT"
install -m 0755 ffmpeg.exe "$OUT/ffmpeg.exe"
echo "built $OUT/ffmpeg.exe for Windows $ARCH ($(grep -m1 'FFMPEG_CONFIGURATION' config.h | cut -c1-60)...)"
