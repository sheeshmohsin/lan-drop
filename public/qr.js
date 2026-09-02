// Minimal QR code generator (byte mode, ECC level M, versions 1-6, mask 0).
// Self-contained so the app works with no internet access on the LAN.
// window.qrMatrix(text) -> 2D boolean array (true = dark module), or null if too long.
(() => {
  'use strict';

  // Per-version tables for versions 1..6 (index 0 unused).
  const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172];
  const ECC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16];
  const NUM_BLOCKS_M = [0, 1, 1, 1, 2, 2, 4];
  const ALIGN_POS = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];
  const ECL_M_FORMAT_BITS = 0;
  const MASK = 0;

  // --- GF(256) Reed-Solomon (polynomial 0x11D) ---
  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  function rsGenerator(degree) {
    const coefs = new Array(degree).fill(0);
    coefs[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        coefs[j] = gfMul(coefs[j], root);
        if (j + 1 < degree) coefs[j] ^= coefs[j + 1];
      }
      root = gfMul(root, 2);
    }
    return coefs;
  }

  function rsRemainder(data, generator) {
    const result = new Array(generator.length).fill(0);
    for (const byte of data) {
      const factor = byte ^ result.shift();
      result.push(0);
      for (let i = 0; i < generator.length; i++) {
        result[i] ^= gfMul(generator[i], factor);
      }
    }
    return result;
  }

  // --- codeword construction ---
  function buildCodewords(bytes, version) {
    const totalCw = TOTAL_CODEWORDS[version];
    const eccLen = ECC_PER_BLOCK_M[version];
    const numBlocks = NUM_BLOCKS_M[version];
    const dataCw = totalCw - eccLen * numBlocks;

    // Bit stream: mode 0100, 8-bit count, data, terminator, pad bytes.
    const bits = [];
    const push = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    push(4, 4);
    push(bytes.length, 8);
    for (const b of bytes) push(b, 8);
    const capacity = dataCw * 8;
    if (bits.length > capacity) return null;
    push(0, Math.min(4, capacity - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
    }

    // Split into blocks, append ECC, interleave.
    const numShort = numBlocks - (totalCw % numBlocks);
    const shortLen = Math.floor(totalCw / numBlocks) - eccLen;
    const generator = rsGenerator(eccLen);
    const blocks = [];
    for (let b = 0, off = 0; b < numBlocks; b++) {
      const len = shortLen + (b < numShort ? 0 : 1);
      const block = data.slice(off, off + len);
      off += len;
      blocks.push({ data: block, ecc: rsRemainder(block, generator) });
    }
    const out = [];
    for (let i = 0; i <= shortLen; i++) {
      for (let b = 0; b < numBlocks; b++) {
        if (i < blocks[b].data.length) out.push(blocks[b].data[i]);
      }
    }
    for (let i = 0; i < eccLen; i++) {
      for (let b = 0; b < numBlocks; b++) out.push(blocks[b].ecc[i]);
    }
    return out;
  }

  // --- matrix drawing ---
  function drawMatrix(codewords, version) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => {
      modules[y][x] = dark;
      isFunction[y][x] = true;
    };

    // Timing patterns.
    for (let i = 0; i < size; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    // Finder patterns with separators.
    const drawFinder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) continue;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, dist !== 2 && dist !== 4);
        }
      }
    };
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    // Alignment patterns (skip corners that overlap finders).
    const positions = ALIGN_POS[version];
    for (let i = 0; i < positions.length; i++) {
      for (let j = 0; j < positions.length; j++) {
        const last = positions.length - 1;
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            set(positions[i] + dx, positions[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    // Format information (ECC M + mask 0), both copies + dark module.
    const formatData = (ECL_M_FORMAT_BITS << 3) | MASK;
    let rem = formatData;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fmt = ((formatData << 10) | rem) ^ 0x5412;
    const fbit = (i) => ((fmt >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, fbit(i));
    set(8, 7, fbit(6));
    set(8, 8, fbit(7));
    set(7, 8, fbit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, fbit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, fbit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, fbit(i));
    set(8, size - 8, true); // always-dark module

    // Zigzag data placement.
    let bitIndex = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (isFunction[y][x] || bitIndex >= totalBits) continue;
          modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }
      }
    }

    // Apply mask 0 to non-function modules.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && (x + y) % 2 === 0) modules[y][x] = !modules[y][x];
      }
    }
    return modules;
  }

  function qrMatrix(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    for (let version = 1; version <= 6; version++) {
      const codewords = buildCodewords(bytes, version);
      if (codewords) return drawMatrix(codewords, version);
    }
    return null;
  }

  if (typeof window !== 'undefined') window.qrMatrix = qrMatrix;
  if (typeof module !== 'undefined') module.exports = { qrMatrix };
})();
