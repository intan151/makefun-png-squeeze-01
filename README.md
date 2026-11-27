[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/intan151/makefun-png-squeeze-01/rank.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/intan151/makefun-png-squeeze-01/reward.svg)](https://make.fun/c/png-squeeze-01-run-20261127)

# Squeeze Screenshots into the Smallest PNG

Entry for the [Squeeze screenshots into the smallest PNG](https://make.fun/c/png-squeeze-01-run-20261127) bounty on [make.fun](https://make.fun).

## What it does

`main.ts` (Node 22, built-in modules only) losslessly recompresses each
1280×720 RGBA screenshot of a set of 8 into the smallest PNG it can, in one
run of under 60 seconds:

1. Decodes the input PNG to RGBA.
2. Screens the lossless forms the image can take — palette (by count and by
   luminance) when it has at most 256 colours; grey / grey+alpha / RGB / RGBA
   otherwise, with a tRNS key when a single transparent value applies — under
   several per-row filter choices (unfiltered, minimum-sum, fewest-pairs, and
   per-row brute force), weighing each by a zlib level-6 stream.
3. Re-deflates the winning filtered data three ways and keeps the smallest:
   zlib level 9 (default and filtered strategies) and an optimal-parsing
   DEFLATE encoder (shortest-path parse over hash-chain matches, iterated
   Huffman lengths, block splitting) written for this entry.
4. Writes a valid PNG (bit depth 8, only IHDR / PLTE / tRNS / IDAT / IEND),
   then self-checks that it decodes back to exactly the screenshot's pixels.

Deterministic: no clock, no random, no network — the two graded executions
write the same bytes.

## Practice score

716,819 / 1,000,000 on the kit's practice set (house baseline fixed-paeth:
420,399; scale: 666,667), verified with the kit's own `grade-local`.

## Run

```sh
node main.ts   # reads /input/<id>/image.png, writes /output/<id>/image.png
```
