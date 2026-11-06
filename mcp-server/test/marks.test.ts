import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import { decodePng, drawMarks, encodePng, pngSize } from "../src/marks.js";

function raster(width: number, height: number): { width: number; height: number; data: Buffer } {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 7) & 255;
    data[i * 4 + 1] = (i * 13) & 255;
    data[i * 4 + 2] = (i * 29) & 255;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** A PNG written with every filter type in turn, RGB (like the game's screenshots, without alpha). */
function filteredRgbPng(r: { width: number; height: number; data: Buffer }): Buffer {
  const bpp = 3;
  const stride = r.width * bpp;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < r.height; y++) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < r.width; x++) r.data.copy(line, x * 3, (y * r.width + x) * 4, (y * r.width + x) * 4 + 3);
    const filter = y % 5;
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i + 1] = (line[i]! - pred) & 255;
    }
    rows.push(out);
    prev = line;
  }
  const png = encodePng(r);
  // Swap the IDAT for the filtered RGB data, and the colour type for RGB.
  const ihdr = Buffer.from(png.subarray(8, 8 + 25));
  ihdr[8 + 9] = 2;
  const body = deflateSync(Buffer.concat(rows));
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); // CRC is not checked by the decoder
  };
  return Buffer.concat([png.subarray(0, 8), chunk("IHDR", ihdr.subarray(8, 21)), chunk("IDAT", body), chunk("IEND", Buffer.alloc(0))]);
}

test("decode undoes every PNG filter and the encoder round-trips", () => {
  const r = raster(23, 17);
  assert.deepEqual(decodePng(encodePng(r)).data, r.data);
  assert.deepEqual(decodePng(filteredRgbPng(r)).data, r.data);
});

test("marks are drawn where they are asked for, the rest of the image stays", () => {
  const r = raster(540, 300);
  const png = drawMarks(encodePng(r), [{ id: 3, x: 100, y: 100 }]);
  const out = decodePng(png);
  assert.equal(out.width, 540);
  const px = (x: number, y: number) => [...out.data.subarray((y * 540 + x) * 4, (y * 540 + x) * 4 + 3)];
  // The label box (red with white text and outline) covers the centre area...
  const centre = px(100, 100);
  assert.ok(String(centre) === "200,30,30" || String(centre) === "255,255,255", `centre is ${centre}`);
  // ...and a far pixel is untouched.
  assert.deepEqual(px(400, 250), [...r.data.subarray((250 * 540 + 400) * 4, (250 * 540 + 400) * 4 + 3)]);
});

test("marks at the edge are clipped instead of failing", () => {
  const png = drawMarks(encodePng(raster(64, 48)), [{ id: 12, x: 0, y: 0 }, { id: 7, x: 63, y: 47 }, { id: 99, x: -50, y: 900 }]);
  assert.equal(decodePng(png).height, 48);
});

test("pngSize reads the header only", () => {
  assert.deepEqual(pngSize(encodePng(raster(31, 9))), { width: 31, height: 9 });
});
