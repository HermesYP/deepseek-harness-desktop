/**
 * Raster comparison for parity frames (lane V).
 *
 * WHY THIS EXISTS: `compare-parity.mjs` decided "visual parity" by whether two
 * PNG files had equal SHA-256 bytes. Equal bytes prove *something* when they are
 * equal, but unequal bytes were reported as `dom-identical` with the note
 * "raster differs (expected across engines)" — an assumption, not a measurement.
 * Two different rasterizers (Chromium vs WebView2) will essentially never agree
 * byte-for-byte even when they render the same layout, so the only verdict the
 * old comparison could produce on real evidence was the assumption. And DOM
 * equality was never visual parity, yet the report read as if it were.
 *
 * This module measures instead of assuming:
 *   - PNGs are decoded and compared per pixel.
 *   - The result is a bounded difference ratio (fraction of pixels differing
 *     beyond a per-channel tolerance) plus a mean absolute difference.
 *   - Regions that are legitimately nondeterministic (a live clock, a spinner,
 *     a caret) are declared as EXPLICIT masks with a reason and a region. Only
 *     masked regions are excluded, and every mask is recorded in the report.
 *   - A comparison that could not decode its inputs FAILS; it never silently
 *     degrades to "assume equal".
 *
 * PNG decoding uses Node's own zlib over the standard IHDR/IDAT scanline
 * format. Only the colour types the capture harness actually emits are
 * supported (8-bit truecolour with and without alpha, and 8-bit greyscale);
 * anything else fails loudly rather than being approximated.
 */

import { readFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'

/** Bytes per pixel for a supported PNG colour type. */
const CHANNELS = new Map([
  [0, 1], // greyscale
  [2, 3], // truecolour
  [4, 2], // greyscale + alpha
  [6, 4], // truecolour + alpha
])

/**
 * Decode an 8-bit PNG into raw RGBA pixels.
 *
 * @param {Buffer} bytes File contents.
 * @param {string} label Name used in error messages.
 * @returns {{width: number, height: number, data: Buffer}} Decoded raster.
 */
export function decodePng(bytes, label = 'png') {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error(`${label}: not a PNG (bad signature)`)
  }
  let offset = 8
  let width
  let height
  let bitDepth
  let colorType
  let interlace
  const idat = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
      interlace = body[12]
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (width === undefined || height === undefined) throw new Error(`${label}: no IHDR chunk`)
  if (bitDepth !== 8) throw new Error(`${label}: unsupported bit depth ${bitDepth} (only 8-bit is decoded)`)
  if (interlace !== 0) throw new Error(`${label}: interlaced PNG is not supported`)
  const channels = CHANNELS.get(colorType)
  if (channels === undefined) throw new Error(`${label}: unsupported colour type ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * 4)
  // Scanlines are filtered independently; the filter byte precedes each row.
  let previous = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const line = Buffer.from(raw.subarray(cursor, cursor + stride))
    cursor += stride
    unfilter(filter, line, previous, channels)
    for (let x = 0; x < width; x += 1) {
      const from = x * channels
      const to = (y * width + x) * 4
      if (channels === 1) {
        pixels[to] = line[from]; pixels[to + 1] = line[from]; pixels[to + 2] = line[from]; pixels[to + 3] = 255
      } else if (channels === 2) {
        pixels[to] = line[from]; pixels[to + 1] = line[from]; pixels[to + 2] = line[from]; pixels[to + 3] = line[from + 1]
      } else if (channels === 3) {
        pixels[to] = line[from]; pixels[to + 1] = line[from + 1]; pixels[to + 2] = line[from + 2]; pixels[to + 3] = 255
      } else {
        pixels[to] = line[from]; pixels[to + 1] = line[from + 1]; pixels[to + 2] = line[from + 2]; pixels[to + 3] = line[from + 3]
      }
    }
    previous = line
  }
  return { width, height, data: pixels }
}

/**
 * Reverse one PNG scanline filter in place.
 *
 * @param {number} filter The filter type byte.
 * @param {Buffer} line The scanline, filtered in place.
 * @param {Buffer} previous The already-unfiltered previous scanline.
 * @param {number} channels Bytes per pixel.
 */
function unfilter(filter, line, previous, channels) {
  for (let i = 0; i < line.length; i += 1) {
    const left = i >= channels ? line[i - channels] : 0
    const up = previous[i] ?? 0
    const upLeft = i >= channels ? (previous[i - channels] ?? 0) : 0
    switch (filter) {
      case 0: break
      case 1: line[i] = (line[i] + left) & 0xff; break
      case 2: line[i] = (line[i] + up) & 0xff; break
      case 3: line[i] = (line[i] + ((left + up) >> 1)) & 0xff; break
      case 4: line[i] = (line[i] + paeth(left, up, upLeft)) & 0xff; break
      default: throw new Error(`unsupported PNG filter type ${filter}`)
    }
  }
}

/** PNG Paeth predictor. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * A nondeterministic region excluded from a comparison.
 *
 * Every mask requires a `reason`: an unexplained mask is how a real regression
 * gets hidden, so the comparison reports them all.
 *
 * @typedef {object} RasterMask
 * @property {string} reason Why this region cannot be compared.
 * @property {number} x Left edge in pixels.
 * @property {number} y Top edge in pixels.
 * @property {number} width Region width in pixels.
 * @property {number} height Region height in pixels.
 */

/**
 * Compare two decoded rasters.
 *
 * @param {object} left Reference raster.
 * @param {object} right Port raster.
 * @param {object} [options] Comparison tolerances.
 * @param {number} [options.channelTolerance] Per-channel delta treated as equal.
 * @param {RasterMask[]} [options.masks] Regions excluded from the comparison.
 * @returns {object} Measurement: sizes, ratios, and per-mask accounting.
 */
export function compareRasters(left, right, options = {}) {
  const channelTolerance = options.channelTolerance ?? 8
  const masks = options.masks ?? []
  if (left.width !== right.width || left.height !== right.height) {
    return {
      comparable: false,
      reason: `dimensions differ: ${left.width}x${left.height} vs ${right.width}x${right.height}`,
    }
  }
  const totalPixels = left.width * left.height
  let compared = 0
  let differing = 0
  let masked = 0
  let absoluteSum = 0
  let maxDelta = 0
  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      if (masks.some(mask => x >= mask.x && x < mask.x + mask.width && y >= mask.y && y < mask.y + mask.height)) {
        masked += 1
        continue
      }
      compared += 1
      const at = (y * left.width + x) * 4
      let worst = 0
      for (let channel = 0; channel < 4; channel += 1) {
        worst = Math.max(worst, Math.abs(left.data[at + channel] - right.data[at + channel]))
      }
      absoluteSum += worst
      maxDelta = Math.max(maxDelta, worst)
      if (worst > channelTolerance) differing += 1
    }
  }
  return {
    comparable: true,
    width: left.width,
    height: left.height,
    totalPixels,
    comparedPixels: compared,
    maskedPixels: masked,
    differingPixels: differing,
    differingRatio: compared === 0 ? 0 : differing / compared,
    meanAbsoluteDelta: compared === 0 ? 0 : absoluteSum / compared,
    maxAbsoluteDelta: maxDelta,
    channelTolerance,
    masks,
  }
}

/**
 * Decode and compare two PNG files.
 *
 * @param {string} leftPath Reference frame.
 * @param {string} rightPath Port frame.
 * @param {object} [options] Same options as compareRasters, plus `masks`.
 * @returns {Promise<object>} Measurement, or a `comparable: false` result.
 */
export async function comparePngFiles(leftPath, rightPath, options = {}) {
  const [leftBytes, rightBytes] = await Promise.all([readFile(leftPath), readFile(rightPath)])
  const left = decodePng(leftBytes, leftPath)
  const right = decodePng(rightBytes, rightPath)
  return compareRasters(left, right, options)
}
