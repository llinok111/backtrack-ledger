/**
 * PNG stat probe.
 *
 * The image viewer on this machine is not reliable for visual confirmation, so
 * screenshots are verified by decoding them instead: dimensions, distinct
 * colours, brightness bands and the presence of specific accent colours prove
 * that a chart actually rendered rather than leaving an empty panel.
 *
 * Usage: node scripts/png-probe.js <file.png>
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');

function decode(file) {
  const buffer = fs.readFileSync(file);
  const signature = buffer.subarray(0, 8).toString('hex');

  if (signature !== '89504e470d0a1a0a') {
    throw new Error('Not a PNG');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) {
        throw new Error('Interlaced PNG is not supported');
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + length;
  }

  if (bitDepth !== 8) {
    throw new Error(`Unsupported bit depth ${bitDepth}`);
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) {
    throw new Error(`Unsupported colour type ${colorType}`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  let position = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[position];
    position += 1;
    const line = raw.subarray(position, position + stride);
    position += stride;
    const out = pixels.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const value = line[x];

      let result;

      switch (filter) {
        case 0:
          result = value;
          break;
        case 1:
          result = value + a;
          break;
        case 2:
          result = value + b;
          break;
        case 3:
          result = value + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          result = value + predictor;
          break;
        }
        default:
          throw new Error(`Unknown filter ${filter}`);
      }

      out[x] = result & 0xff;
    }
  }

  return {width, height, channels, pixels};
}

function probe(file) {
  const {width, height, channels, pixels} = decode(file);
  const stride = width * channels;
  const colors = new Set();
  const accent = {crimson: 0, safe: 0, warn: 0};

  let total = 0;
  const bands = new Array(8).fill(0).map(() => ({sum: 0, count: 0, nonBg: 0}));
  const background = [26, 26, 26];

  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const index = y * stride + x * channels;
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];

      colors.add((r << 16) | (g << 8) | b);

      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const band = Math.min(7, Math.floor((y / height) * 8));
      bands[band].sum += luminance;
      bands[band].count += 1;

      const isBg =
        Math.abs(r - background[0]) < 6 &&
        Math.abs(g - background[1]) < 6 &&
        Math.abs(b - background[2]) < 6;

      if (!isBg) {
        bands[band].nonBg += 1;
      }

      // Match the palette used by the workbench.
      if (r > 190 && r < 240 && g > 5 && g < 45 && b > 40 && b < 85) accent.crimson += 1;
      if (r > 40 && r < 90 && g > 150 && g < 200 && b > 90 && b < 140) accent.safe += 1;
      if (r > 230 && g > 190 && b < 70) accent.warn += 1;

      total += 1;
    }
  }

  console.log(`file        ${file}`);
  console.log(`size        ${width} x ${height}`);
  console.log(`sampled     ${total} px`);
  console.log(`colors      ${colors.size}`);
  console.log('');

  bands.forEach((band, index) => {
    const mean = band.sum / band.count;
    const nonBgPct = ((band.nonBg / band.count) * 100).toFixed(1);
    console.log(
      `band ${index}      mean=${mean.toFixed(1).padStart(6)}  nonBg=${nonBgPct.padStart(5)}%`
    );
  });

  console.log('');
  console.log(`accent      crimson=${accent.crimson} safe=${accent.safe} warn=${accent.warn}`);

  const emptyBands = bands.filter((band) => band.nonBg / band.count < 0.005).length;

  console.log('');
  console.log(`verdict     ${colors.size < 10 ? 'BLANK' : emptyBands > 4 ? 'SPARSE' : 'CONTENT'}`);

  return {width, height, colors: colors.size, bands, accent, emptyBands};
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/png-probe.js <file.png>');
    process.exit(1);
  }
  probe(file);
}

module.exports = {probe, decode};
