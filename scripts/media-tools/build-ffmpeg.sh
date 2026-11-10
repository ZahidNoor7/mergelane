#!/usr/bin/env bash
# Builds Mergelane's own FFmpeg from FFmpeg's official source release (ADR-0028, docs/MEDIA-TOOLS.md).
#
#   scripts/media-tools/build-ffmpeg.sh <ffmpeg-X.Y.Z.tar.xz> <output dir>
#
# The tarball must already be verified: fetch.mjs checks its pinned SHA-256 before calling this.
#
# Mergelane only joins and rewraps audio and video it has downloaded, always with stream copy
# (app/src/main/media/mux: `-c copy`, `-protocol_whitelist file`, `-format_whitelist`). So this
# build has no encoders, only the few decoders stream copy needs to read stream parameters, no
# network, no devices, and no outside libraries except macOS's own zlib and system frameworks.
# Its only protocols are file (the media) and pipe (the module reads `-progress pipe:1` on stdout;
# inputs stay limited to file by `-protocol_whitelist file`). It is not configured with
# --enable-gpl or --enable-version3, so the program is licensed LGPL version 2.1 or later. Its
# exact Corresponding Source is the tarball plus this script.
#
# Keep the component lists in step with app/src/main/media/mux/run.ts (INPUT_DEMUXERS, MUXER_ARGS,
# and the -progress pipe in buildArgs).
set -euo pipefail

TARBALL=${1:?usage: build-ffmpeg.sh <ffmpeg-X.Y.Z.tar.xz> <output dir>}
OUT=${2:?usage: build-ffmpeg.sh <ffmpeg-X.Y.Z.tar.xz> <output dir>}

[ "$(uname -s)" = Darwin ] || { echo "build-ffmpeg.sh: macOS only" >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "build-ffmpeg.sh: Apple silicon (arm64) only" >&2; exit 1; }

# Containers we read (mov covers mp4/m4a, matroska covers webm) and write.
DEMUXERS=mov,mpegts,matroska,aac,mp3,ac3,eac3
MUXERS=mp4,matroska
# Parsers let stream copy find frame boundaries and stream parameters without decoding.
PARSERS=h264,hevc,av1,vp8,vp9,aac,aac_latm,ac3,mpegaudio,opus,flac,vorbis
# No encoders, but a few decoders: stream copy still reads the first frames to learn what the
# container doesn't say (an ADTS or MPEG-TS AAC track's sample rate, a VP9 track's pixel format,
# which the MP4 muxer needs for its vpcC box). They decode a frame or two and never re-encode.
DECODERS=aac,aac_latm,mp3,ac3,eac3,opus,flac,vorbis,vp9
# The muxers pull in aac_adtstoasc and vp9_superframe themselves (configure's *_muxer_select);
# extract_extradata helps when a TS input carries its headers only in-band.
BSFS=aac_adtstoasc,vp9_superframe,extract_extradata

WORK=$(mktemp -d "${TMPDIR:-/tmp}/mergelane-ffmpeg-build.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
tar -xJf "$TARBALL" -C "$WORK"
SRC=$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'ffmpeg-*' | head -1)
[ -n "$SRC" ] || { echo "build-ffmpeg.sh: no ffmpeg-* folder in $TARBALL" >&2; exit 1; }

cd "$SRC"
export MACOSX_DEPLOYMENT_TARGET=27.0
./configure \
  --arch=arm64 --target-os=darwin --cc=clang \
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
make -j"$(sysctl -n hw.ncpu)" ffmpeg

# The build must not have picked up anything that changes the licence.
CONF=$(./ffmpeg -hide_banner -buildconf)
if grep -qE -- '--enable-(gpl|version3|nonfree)' <<<"$CONF"; then
  echo "build-ffmpeg.sh: configuration would make FFmpeg GPL or nonfree" >&2
  exit 1
fi
./ffmpeg -hide_banner -L | grep -q 'GNU Lesser General Public' || {
  echo "build-ffmpeg.sh: FFmpeg does not report the LGPL" >&2
  exit 1
}

mkdir -p "$OUT"
install -m 0755 ffmpeg "$OUT/ffmpeg"
echo "built $OUT/ffmpeg: $(./ffmpeg -hide_banner -version | head -1)"
