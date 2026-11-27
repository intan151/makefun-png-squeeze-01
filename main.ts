// Squeeze screenshots into the smallest PNG, losslessly.
//
// One program answers all 8 instances of a set in one run: each instance is
// a 1280x720 RGBA screenshot at /input/<id>/image.png; the answer is written
// as /output/<id>/image.png (bit depth 8, non-interlaced, only the chunks
// IHDR, PLTE, tRNS, IDAT, IEND, at most 4 MiB), every pixel exact.
//
// Method (Node 22, built-in modules only; deterministic: no clock, no random,
// no network, no files outside /bot, /input, /output, /tmp):
//   1. decode the input PNG to RGBA;
//   2. analyse it (opaque? grey? at most 256 colours? a single transparent key?);
//   3. screen the lossless forms the image can take (palette by count and by
//      luminance; grey / grey+alpha / RGB / RGBA, with a tRNS key when one
//      applies) under several per-row filter choices (fixed filters, the
//      minimum-sum and fewest-pairs heuristics, and per-row brute force),
//      weighing each by a zlib level-6 stream, as the competition's own scale
//      compressor does;
//   4. re-deflate the winning filtered data three ways and keep the smallest:
//      zlib level 9 (default and filtered strategies) and an optimal-parsing
//      DEFLATE encoder (shortest-path parse over hash-chain matches, iterated
//      Huffman lengths, block splitting) written for this entry;
//   5. write the PNG with the winning stream.
//
// The repository holds only this file (plus LICENSE and the claim file).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG codec
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decode a PNG (bit depth 8, colour types 0, 2, 3, 4, 6) to RGBA.
function decodePng(bytes) {
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('cut chunk');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) throw new Error('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`${type} CRC`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      if (len !== 13) throw new Error('bad IHDR');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], interlace: data[12] };
      if (header.depth !== 8 || !Object.hasOwn(CHANNELS, header.colourType) || header.interlace !== 0) {
        throw new Error('unsupported IHDR');
      }
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      throw new Error(`unexpected chunk ${type}`);
    }
  }
  if (!ended || idat.length === 0) throw new Error('no IEND/IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT length');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error('bad filter');
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ------------------------------------------------------------------ filters
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

// ------------------------------------------------------------- image forms
function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

// The one fully transparent value the image may key by tRNS instead of an
// alpha channel: every pixel opaque or that exact value at alpha 0, and no
// opaque pixel of the same value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

// The raw data of an image of `samples`, each row behind its filter byte, by
// `choice`: a filter type (0-4) for every row, or 'minsum', 'pairs' or 'brute'.
function filtered(samples, width, height, bpp, choice, raw = new Uint8Array(height * (width * bpp + 1))) {
  const stride = width * bpp;
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') cost = pairsOf(trial[t], seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

const FILTERS = Object.freeze({
  palette: Object.freeze([0]),
  paletteByLuminance: Object.freeze([0, 'minsum', 'brute']),
  // No fixed filters 1, 2, 4: the per-row minimum-sum choice already picks the
  // best fixed filter per row by the same heuristic, so a single fixed filter
  // for the whole image never beat it on the practice set, and skipping the
  // three extra level-6 screen runs keeps the 60-second wall budget safe.
  channels: Object.freeze([0, 'minsum', 'pairs', 'brute']),
});

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [['count', FILTERS.palette], ['luminance', FILTERS.paletteByLuminance]]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// The screen's winner for an image: its form, filter choice and filtered
// data, weighed by a zlib level-6 stream; the first on a tie.
function screen(rgba, width, height) {
  let best = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, new Uint8Array(size));
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) best = { form, choice, data, bytes };
    }
  }
  return best;
}

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ------------------------------------------- optimal-parsing DEFLATE (zopfli-lite)
// A DEFLATE encoder that beats zlib level 9 on screenshot data by a few
// percent: hash-chain match finding (with a run shortcut for flat areas),
// a shortest-path (optimal) parse over the matches, iterated Huffman code
// lengths seeded from a greedy lazy parse, and fixed-size block splitting.
// Deterministic: every choice is a function of the input bytes alone.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenSym(len) {
  let lo = 0, hi = 28;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1; }
  return lo;
}
function distSym(dist) {
  let lo = 0, hi = 29;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (DIST_BASE[mid] <= dist) lo = mid; else hi = mid - 1; }
  return lo;
}

// Length-limited Huffman code lengths (tree + zlib-style overflow limiting).
function huffmanLengths(freq, maxLen) {
  const n = freq.length;
  const lengths = new Int32Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  syms.sort((a, b) => freq[a] - freq[b] || a - b);
  const nodes = [];
  for (const s of syms) nodes.push({ f: freq[s], s, l: -1, r: -1 });
  const internal = [];
  let li = 0, ii = 0;
  const takeSmallest = () => {
    const a = li < nodes.length ? nodes[li] : null;
    const b = ii < internal.length ? internal[ii] : null;
    if (b === null || (a !== null && a.f <= b.f)) { li++; return a; }
    ii++; return b;
  };
  while ((nodes.length - li) + (internal.length - ii) > 1) {
    const a = takeSmallest();
    const b = takeSmallest();
    internal.push({ f: a.f + b.f, s: -1, l: a, r: b });
  }
  const root = internal.length ? internal[internal.length - 1] : nodes[0];
  const stack = [[root, 0]];
  const depth = new Int32Array(n);
  let maxD = 0;
  while (stack.length) {
    const [nd, d] = stack.pop();
    if (nd.s >= 0) { depth[nd.s] = d; if (d > maxD) maxD = d; }
    else { stack.push([nd.l, d + 1]); stack.push([nd.r, d + 1]); }
  }
  if (maxD <= maxLen) { for (const s of syms) lengths[s] = depth[s]; return lengths; }
  const blCount = new Int32Array(maxLen + 1);
  let overflow = 0;
  for (const s of syms) {
    if (depth[s] > maxLen) { overflow++; blCount[maxLen]++; }
    else blCount[depth[s]]++;
  }
  do {
    let bits = maxLen - 1;
    while (blCount[bits] === 0) bits--;
    blCount[bits]--;
    blCount[bits + 1] += 2;
    blCount[maxLen]--;
    overflow -= 2;
  } while (overflow > 0);
  const byFreqDesc = [...syms].sort((a, b) => freq[b] - freq[a] || a - b);
  let k = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    for (let j = 0; j < blCount[bits]; j++) lengths[byFreqDesc[k++]] = bits;
  }
  return lengths;
}

function canonicalCodes(lengths) {
  const n = lengths.length;
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Int32Array(maxLen + 1);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Int32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l > 0) codes[i] = nextCode[l]++;
  }
  return codes;
}

class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.bit = 0; this.acc = 0; }
  write(code, len) {
    this.acc |= code << this.bit;
    this.bit += len;
    while (this.bit >= 8) {
      this.buf[this.pos++] = this.acc & 0xff;
      this.acc >>>= 8;
      this.bit -= 8;
    }
  }
  writeHuff(code, len) {
    let rev = 0;
    for (let i = 0; i < len; i++) { rev = (rev << 1) | ((code >> i) & 1); }
    this.write(rev, len);
  }
  flush() {
    if (this.bit > 0) { this.buf[this.pos++] = this.acc & 0xff; this.acc = 0; this.bit = 0; }
    return this.buf.subarray(0, this.pos);
  }
}

const DEF_CHAIN = 96;
const DEF_NICE = 48;
const MAX_CAND = 6;

function hash3(d, i) {
  const x = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
  return ((x * 0x9e3779b1) >>> 16) & 0xffff;
}

// Up to MAX_CAND (len, dist) candidates per position, on the Pareto frontier
// (no other match beats one on both length and distance).
function findCandidates(d, maxChain = DEF_CHAIN, niceLen = DEF_NICE, runSkip = 64) {
  const N = d.length;
  const candLen = new Int16Array(N * MAX_CAND);
  const candDist = new Int32Array(N * MAX_CAND);
  const candN = new Uint8Array(N);
  if (N < 4) return { candLen, candDist, candN };
  const head = new Int32Array(65536).fill(-1);
  const prev = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (i + 2 < N) {
      const h = hash3(d, i);
      prev[i] = head[h];
      head[h] = i;
    }
  }
  const runLen = new Int32Array(N + 1);
  for (let i = N - 1; i >= 0; i--) runLen[i] = d[i] === d[i + 1] ? runLen[i + 1] + 1 : 1;
  for (let i = 0; i + 2 < N; i++) {
    if (i > 0) {
      const rl = Math.min(258, runLen[i - 1] - 1, N - i);
      if (rl >= 3) {
        candLen[i * MAX_CAND] = rl;
        candDist[i * MAX_CAND] = 1;
        candN[i] = 1;
        if (rl >= runSkip) continue;
      }
    }
    const h = hash3(d, i);
    let p = prev[i];
    let steps = 0;
    const list = [];
    if (candN[i] > 0) list.push([candLen[i * MAX_CAND], candDist[i * MAX_CAND]]);
    const maxPossible = Math.min(258, N - i);
    while (p >= 0 && p >= i - 32768 && steps < maxChain) {
      steps++;
      let len = 0;
      const maxLen = Math.min(maxPossible, N - p);
      while (len < maxLen && d[p + len] === d[i + len]) len++;
      if (len >= 3) {
        const dist = i - p;
        let dup = -1;
        for (let k = 0; k < list.length; k++) if (list[k][0] === len) { dup = k; break; }
        if (dup >= 0) { if (dist < list[dup][1]) list[dup][1] = dist; }
        else list.push([len, dist]);
        if (len >= niceLen || len >= maxPossible) break;
      }
      p = prev[p];
    }
    if (list.length) {
      const byLen = new Map();
      for (const [L, D] of list) {
        const e = byLen.get(L);
        if (e === undefined || D < e) byLen.set(L, D);
      }
      const sorted = [...byLen.entries()].sort((a, b) => b[0] - a[0]);
      const frontier = [];
      let bestDist = Infinity;
      for (const [L, D] of sorted) {
        if (D < bestDist) { frontier.push([L, D]); bestDist = D; }
      }
      const keep = Math.min(MAX_CAND, frontier.length);
      candN[i] = keep;
      for (let k = 0; k < keep; k++) {
        candLen[i * MAX_CAND + k] = frontier[k][0];
        candDist[i * MAX_CAND + k] = frontier[k][1];
      }
    }
  }
  return { candLen, candDist, candN };
}

const INF = 1e18;

function optimalParse(d, cand, llCost, distCost) {
  const N = d.length;
  const costs = new Float64Array(N + 1).fill(INF);
  const choiceLen = new Int32Array(N + 1);
  const choiceDist = new Int32Array(N + 1);
  costs[0] = 0;
  const { candLen, candDist, candN } = cand;
  for (let i = 0; i < N; i++) {
    const c = costs[i];
    if (c === INF) continue;
    const lc = c + llCost[d[i]];
    if (lc < costs[i + 1]) { costs[i + 1] = lc; choiceLen[i + 1] = 1; choiceDist[i + 1] = 0; }
    const n = candN[i];
    for (let k = 0; k < n; k++) {
      const L = candLen[i * MAX_CAND + k];
      const D = candDist[i * MAX_CAND + k];
      if (L < 3 || i + L > N) continue;
      const ls = lenSym(L);
      const ds = distSym(D);
      const mc = c + llCost[257 + ls] + LEN_EXTRA[ls] + distCost[ds] + DIST_EXTRA[ds];
      if (mc < costs[i + L]) { costs[i + L] = mc; choiceLen[i + L] = L; choiceDist[i + L] = D; }
    }
  }
  const seq = [];
  let p = N;
  while (p > 0) {
    const L = choiceLen[p];
    if (L === 1) { seq.push(d[p - 1]); p -= 1; }
    else if (L > 1) { seq.push([L, choiceDist[p]]); p -= L; }
    else throw new Error('optimalParse: unreachable position ' + p);
  }
  seq.reverse();
  return { seq, cost: costs[N] };
}

// Greedy lazy parse (zlib-style): longest match, but a literal when the next
// position starts a longer match. Seeds the DP costs: a DP seeded from fixed
// Huffman costs overvalues far matches (all distances cost 5 bits there).
function lazyParse(d, cand) {
  const N = d.length;
  const { candLen, candDist, candN } = cand;
  const seq = [];
  let i = 0;
  const longestAt = (p) => (p < N && candN[p] > 0 ? candLen[p * MAX_CAND] : 0);
  while (i < N) {
    const L1 = longestAt(i);
    if (L1 >= 3) {
      const L2 = longestAt(i + 1);
      if (L2 > L1) { seq.push(d[i]); i++; continue; }
      seq.push([L1, candDist[i * MAX_CAND]]);
      i += L1;
    } else { seq.push(d[i]); i++; }
  }
  return seq;
}

function lengthsOfSeq(seq) {
  const llFreq = new Int32Array(288);
  const distFreq = new Int32Array(30);
  for (const s of seq) {
    if (typeof s === 'number') llFreq[s]++;
    else { llFreq[257 + lenSym(s[0])]++; distFreq[distSym(s[1])]++; }
  }
  llFreq[256]++;
  if (distFreq.every((x) => x === 0)) distFreq[0] = 1;
  return { llLen: huffmanLengths(llFreq, 15), distLen: huffmanLengths(distFreq, 15) };
}

function costsOf(llLen, distLen) {
  const llCost = new Float64Array(288);
  for (let s = 0; s < 288; s++) llCost[s] = llLen[s] > 0 ? llLen[s] : INF;
  const distCost = new Float64Array(30);
  for (let s = 0; s < 30; s++) distCost[s] = distLen[s] > 0 ? distLen[s] : INF;
  return { llCost, distCost };
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function emitBlock(w, d, isLast, opts) {
  const cand = findCandidates(d, opts.maxChain, opts.niceLen, opts.runSkip);
  const lazySeq = lazyParse(d, cand);
  let { llLen, distLen } = lengthsOfSeq(lazySeq);
  let { llCost, distCost } = costsOf(llLen, distLen);
  let seq = lazySeq;
  const ITERS = opts.iters;
  for (let it = 0; it < ITERS; it++) {
    const r = optimalParse(d, cand, llCost, distCost);
    seq = r.seq;
    ({ llLen, distLen } = lengthsOfSeq(seq));
    ({ llCost, distCost } = costsOf(llLen, distLen));
  }
  const costOf = (sq) => {
    let c = llLen[256];
    for (const s of sq) {
      if (typeof s === 'number') c += llLen[s];
      else {
        const ls = lenSym(s[0]), ds = distSym(s[1]);
        c += llLen[257 + ls] + LEN_EXTRA[ls] + distLen[ds] + DIST_EXTRA[ds];
      }
    }
    return c;
  };
  if (costOf(lazySeq) < costOf(seq)) {
    seq = lazySeq;
    ({ llLen, distLen } = lengthsOfSeq(seq));
  }
  let hlit = 29; // field value: covers symbols 0..(hlit+256)
  while (hlit > 0 && llLen[256 + hlit] === 0) hlit--;
  let hdist = 29;
  while (hdist > 0 && distLen[hdist] === 0) hdist--;
  const nLit = 257 + hlit;
  const nDist = 1 + hdist;
  const lens = new Int32Array(nLit + nDist);
  for (let i = 0; i < nLit; i++) lens[i] = llLen[i];
  for (let i = 0; i < nDist; i++) lens[nLit + i] = distLen[i];
  const clSeq = [];
  {
    let i = 0;
    while (i < lens.length) {
      const v = lens[i];
      if (v === 0) {
        let run = 0;
        while (i + run < lens.length && lens[i + run] === 0 && run < 138) run++;
        if (run >= 3) {
          if (run <= 10) { clSeq.push([17, 3, run - 3]); i += run; }
          else { const take = Math.min(run, 138); clSeq.push([18, 7, take - 11]); i += take; }
        } else { for (let k = 0; k < run; k++) clSeq.push([0, 0, 0]); i += run; }
      } else {
        clSeq.push([v, 0, 0]); i++;
        let run = 0;
        while (i + run < lens.length && lens[i + run] === v && run < 6) run++;
        while (run >= 3) {
          const take = Math.min(run, 6);
          clSeq.push([16, 2, take - 3]); i += take; run -= take;
        }
      }
    }
  }
  const clFreq = new Int32Array(19);
  for (const [s] of clSeq) clFreq[s]++;
  let clLen = huffmanLengths(clFreq, 7);
  {
    let used = 0;
    for (let s = 0; s < 19; s++) if (clLen[s] > 0) used++;
    if (used === 1) {
      for (let s = 0; s < 19; s++) if (clLen[s] === 0) { clLen[s] = 1; break; }
    }
  }
  let hclen = 15; // field value: sends hclen + 4 lengths
  while (hclen > 0 && clLen[CL_ORDER[hclen + 3]] === 0) hclen--;
  const clCode = canonicalCodes(clLen);
  const llCode = canonicalCodes(llLen);
  const distCode = canonicalCodes(distLen);
  w.write(isLast ? 1 : 0, 1);
  w.write(2, 2); // BTYPE = dynamic
  w.write(hlit, 5);
  w.write(hdist, 5);
  w.write(hclen, 4);
  for (let k = 0; k < hclen + 4; k++) w.write(clLen[CL_ORDER[k]], 3);
  for (const [s, eb, ev] of clSeq) {
    w.writeHuff(clCode[s], clLen[s]);
    if (eb) w.write(ev, eb);
  }
  for (const s of seq) {
    if (typeof s === 'number') w.writeHuff(llCode[s], llLen[s]);
    else {
      const ls = lenSym(s[0]);
      w.writeHuff(llCode[257 + ls], llLen[257 + ls]);
      if (LEN_EXTRA[ls]) w.write(s[0] - LEN_BASE[ls], LEN_EXTRA[ls]);
      const ds = distSym(s[1]);
      w.writeHuff(distCode[ds], distLen[ds]);
      if (DIST_EXTRA[ds]) w.write(s[1] - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  w.writeHuff(llCode[256], llLen[256]);
}

// Optimal-parse DEFLATE of `data` as one zlib stream.
function optimalDeflate(data, opts = {}) {
  const o = { block: 500000, iters: 2, maxChain: DEF_CHAIN, niceLen: DEF_NICE, runSkip: 64, ...opts };
  const w = new BitWriter(data.length + 4096);
  const nBlocks = Math.max(1, Math.ceil(data.length / o.block));
  for (let b = 0; b < nBlocks; b++) {
    const chunk = data.subarray(b * o.block, Math.min(data.length, (b + 1) * o.block));
    emitBlock(w, chunk, b === nBlocks - 1, o);
  }
  const body = w.flush();
  const out = new Uint8Array(body.length + 6);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(body, 2);
  const ad = adler32(data);
  out[out.length - 4] = (ad >>> 24) & 0xff;
  out[out.length - 3] = (ad >>> 16) & 0xff;
  out[out.length - 2] = (ad >>> 8) & 0xff;
  out[out.length - 1] = ad & 0xff;
  return out;
}

// ---------------------------------------------------------------------- main
// Effort is budgeted by work, not by the clock: the optimal parser's chain
// depth follows the filtered data's size, so the same input always takes the
// same path (the two graded executions must match byte for byte).
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const { width, height, rgba } = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const best = screen(rgba, width, height);
  const data = best.data;
  const z9a = deflateSync(data, { level: 9, memLevel: 9 });
  const z9b = deflateSync(data, { level: 9, memLevel: 9, strategy: constants.Z_FILTERED });
  const opt = optimalDeflate(data, data.length <= 3000000
    ? { maxChain: 96, niceLen: 48 }
    : { maxChain: 64, niceLen: 32 });
  let idat = z9a;
  if (z9b.length < idat.length) idat = z9b;
  if (opt.length < idat.length) idat = opt;
  const png = pngOfForm(width, height, best.form, idat);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), png);
  // Self-check gate: the written answer must decode back to exactly the
  // screenshot's pixels (a wrong byte here would score 0 on the instance).
  // This only verifies; it never changes the output bytes.
  const check = decodePng(new Uint8Array(readFileSync(join(O, id, 'image.png'))));
  if (check.width !== width || check.height !== height || check.rgba.length !== rgba.length) {
    throw new Error(`${id}: self-check size mismatch`);
  }
  for (let i = 0; i < rgba.length; i++) {
    if (check.rgba[i] !== rgba[i]) throw new Error(`${id}: self-check pixel mismatch at byte ${i}`);
  }
}
