#!/usr/bin/env bash
#
# Rebuild the scroll film's frame sets from the masters in frames-src/.
#
# The masters are 1280x720 JPEGs at ~22 kB each — roughly 0.2 bits per pixel.
# At that bitrate the encoder spends its budget on the silhouette and gives up
# on everything flat, so each frame arrives with 8x8 DCT blocking baked in: the
# dawn sky steps, and the candlelit interior — which is nearly all near-black
# gradient — breaks into visible tiles. The page then magnifies exactly that,
# because a 1280px plate covering a 1512px viewport on a 2x display is a ~2.4x
# upscale. Blocks get upscaled into blocks.
#
# So the artifacts have to come out *before* the picture is enlarged:
#
#   uspp     deblocks in the DCT domain — re-encodes each 8x8 block at many
#            shifted offsets and averages, so the block grid, which does not
#            survive being moved, cancels while real edges reinforce. This is
#            the step that does the actual work.
#   16-bit   everything after the deblock runs in gbrp16. Deband and lanczos
#            both accumulate rounding, and in near-black that rounding *is* the
#            banding we just removed.
#   deband   rebuilds the smooth ramps uspp leaves slightly terraced, dithering
#            across a wide radius so dark gradients resolve instead of stepping.
#   lanczos  one clean resample to the delivery size, with full chroma
#            interpolation — the masters are 4:2:0, so chroma is half-res and
#            the default upsampler smears the lantern and candle edges.
#   unsharp  a light pass to pay back what the browser's own upscale costs; it
#            resamples soft, and this is cheaper than fighting it at runtime.
#
# Output is WebP with sharp-yuv (better 4:2:0 downsampling, which matters for
# the warm highlights) at method 6 (slowest search, smallest file).
#
# Two sets, because a phone should not pull a desktop sequence:
#   hd  1920x1080, every frame        — the plate the browser upscales least
#   sm  1280x720,  every other frame  — native master resolution, no upscale
#
# The masters are NOT kept in the tree — only the encoded output under
# public/frames/ ships. They are still in git history, as the JPEGs this film
# used to be served from, and restore byte-identical:
#
#   mkdir -p frontend/frames-src
#   for n in $(seq -w 1 150); do
#     git show 52c235d:frontend/public/frames/hd/$n.jpg > frontend/frames-src/$n.jpg
#   done
#
# 52c235d is the last commit that shipped them. Note this is the *selected* 150
# frames only; the original 300-frame export those were sampled from is gone, so
# the film cannot be re-cut at a finer temporal sampling than it already has.
#
# Usage: ./scripts/build-frames.sh        (from frontend/, after restoring above)

set -euo pipefail
cd "$(dirname "$0")/.."

SRC=frames-src
OUT=public/frames
JOBS=$(nproc 2>/dev/null || echo 4)

command -v ffmpeg >/dev/null || { echo "need ffmpeg" >&2; exit 1; }
command -v magick >/dev/null || { echo "need imagemagick" >&2; exit 1; }
[ -d "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

# Artifact removal. Runs at the master's own resolution — deblocking after an
# upscale would just be smoothing enlarged blocks.
CLEAN="format=yuv444p,uspp=4:5,format=gbrp16,\
deband=1thr=0.012:2thr=0.012:3thr=0.012:range=32:blur=1"
SCALE_FLAGS="lanczos+accurate_rnd+full_chroma_int"

# $1 out dir  $2 width  $3 height  $4 webp quality  $5 frame step
build_set() {
  local dir=$1 w=$2 h=$3 q=$4 step=$5
  rm -rf "$OUT/$dir"
  mkdir -p "$OUT/$dir"

  local frames=()
  for ((n = 1; n <= 150; n += step)); do frames+=("$n"); done
  # the painter brackets around the target frame, so the last one must exist
  [ "${frames[-1]}" -ne 150 ] && frames+=(150)

  printf '%s\n' "${frames[@]}" | xargs -P "$JOBS" -I{} bash -c '
    n=$(printf "%03d" "{}")
    tmp=$(mktemp --suffix=.png)
    trap "rm -f $tmp" EXIT
    ffmpeg -v error -y -i "'"$SRC"'/$n.jpg" \
      -vf "'"$CLEAN"',scale='"$w"':'"$h"':flags='"$SCALE_FLAGS"',unsharp=5:5:0.5:5:5:0,format=rgb24" \
      "$tmp"
    magick "$tmp" -quality '"$q"' \
      -define webp:method=6 -define webp:use-sharp-yuv=1 \
      "'"$OUT/$dir"'/$n.webp"
  '

  echo "  $dir: $(ls "$OUT/$dir" | wc -l) frames, $(du -sh "$OUT/$dir" | cut -f1)"
}

echo "rebuilding frames from $SRC ($JOBS jobs)"
build_set hd 1920 1080 76 1
build_set sm 1280 720  76 2
echo "done — $(du -sh $OUT | cut -f1) total"
