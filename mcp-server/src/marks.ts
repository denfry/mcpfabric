/**
 * Set-of-Mark screenshots: numbered labels drawn onto the PNG at the screen position of each mob or
 * player the mod reports, so a vision model can say "attack #3" and the legend maps #3 to its uuid.
 * Self-contained: a minimal PNG decoder/encoder (8-bit RGB/RGBA, non-interlaced, which is what the
 * game writes) on node:zlib and a 3x5 bitmap font for digits and '#'.
 */
import { deflateSync, inflateSync } from "node:zlib";

export interface Mark {
  /** The number drawn. */
  id: number;
  /** Pixel position in the image (the entity's centre). */
  x: number;
  y: number;
}

interface Raster {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Width and height from the IHDR chunk, without decoding the image. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export function decodePng(png: Buffer): Raster {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      colorType = body[9]!;
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) throw new Error("unsupported PNG format");
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * bpp]!;
      out[o + 1] = line[x * bpp + 1]!;
      out[o + 2] = line[x * bpp + 2]!;
      out[o + 3] = bpp === 4 ? line[x * bpp + 3]! : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}

export function encodePng(r: Raster): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.width, 0);
  ihdr.writeUInt32BE(r.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const stride = r.width * 4;
  const raw = Buffer.alloc((stride + 1) * r.height);
  for (let y = 0; y < r.height; y++) r.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); // filter 0
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** 3x5 glyphs, one string of 15 bits per character, row by row. */
const FONT: Record<string, string> = {
  "0": "111101101101111",
  "1": "010110010010111",
  "2": "111001111100111",
  "3": "111001111001111",
  "4": "101101111001001",
  "5": "111100111001111",
  "6": "111100111101111",
  "7": "111001001001001",
  "8": "111101111101111",
  "9": "111101111001111",
  "#": "101111101111101",
};

function fill(r: Raster, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let y = Math.max(0, y0); y < Math.min(r.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(r.width, x0 + w); x++) {
      const o = (y * r.width + x) * 4;
      r.data[o] = rgb[0];
      r.data[o + 1] = rgb[1];
      r.data[o + 2] = rgb[2];
      r.data[o + 3] = 255;
    }
  }
}

/** Draws "#n" in a box centred on each mark; the scale follows the image size. */
export function drawMarks(png: Buffer, marks: Mark[]): Buffer {
  const r = decodePng(png);
  const s = Math.max(2, Math.round(Math.min(r.width, r.height) / 270)); // pixel size of one font dot
  for (const m of marks) {
    const text = `#${m.id}`;
    const w = (text.length * 4 + 1) * s;
    const h = 7 * s;
    const x0 = Math.round(m.x - w / 2);
    const y0 = Math.round(m.y - h / 2);
    fill(r, x0 - s, y0 - s, w + 2 * s, h + 2 * s, [255, 255, 255]); // outline
    fill(r, x0, y0, w, h, [200, 30, 30]);
    [...text].forEach((ch, i) => {
      const glyph = FONT[ch]!;
      for (let gy = 0; gy < 5; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          if (glyph[gy * 3 + gx] === "1") fill(r, x0 + s + (i * 4 + gx) * s, y0 + s + gy * s, s, s, [255, 255, 255]);
        }
      }
    });
  }
  return encodePng(r);
}
