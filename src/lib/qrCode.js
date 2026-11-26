// A dependency-free QR encoder for short URLs (byte mode, error-correction
// level M, Versions 1-15, so up to 412 UTF-8 bytes). It draws the invitation
// QR code for the web /get-app page and the invitation emails. Like
// checkinQr.js, it keeps the encoded URL away from third-party image
// services and adds no supply-chain dependency. The layout follows
// ISO/IEC 18004.

const MAX_VERSION = 15;
// Level M per version, index 0 unused.
const ECC_CODEWORDS_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24];
const ERROR_CORRECTION_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10];
const FORMAT_BITS_M = 0;

function getBit(value, index) {
  return ((value >>> index) & 1) !== 0;
}

function multiplyGalois(left, right) {
  let result = 0;
  let value = left;
  let factor = right;
  while (factor > 0) {
    if (factor & 1) result ^= value;
    factor >>>= 1;
    value = (value << 1) ^ ((value >>> 7) * 0x11d);
  }
  return result;
}

function reedSolomonDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let term = 0; term < degree; term += 1) {
      result[term] = multiplyGalois(result[term], root);
      if (term + 1 < degree) result[term] ^= result[term + 1];
    }
    root = multiplyGalois(root, 2);
  }
  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let index = 0; index < result.length; index += 1) {
      result[index] ^= multiplyGalois(divisor[index], factor);
    }
  }
  return [...result];
}

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version) {
  return Math.floor(rawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[version] * ERROR_CORRECTION_BLOCKS[version];
}

function alignmentPositions(version, size) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

function appendBits(target, value, count) {
  for (let bit = count - 1; bit >= 0; bit -= 1) target.push(getBit(value, bit));
}

function encodeData(bytes) {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const countBits = version <= 9 ? 8 : 16;
    const capacity = dataCodewords(version) * 8;
    if (4 + countBits + bytes.length * 8 > capacity) continue;
    const bits = [];
    appendBits(bits, 0b0100, 4); // Byte mode.
    appendBits(bits, bytes.length, countBits);
    for (const byte of bytes) appendBits(bits, byte, 8);
    appendBits(bits, 0, Math.min(4, capacity - bits.length));
    while (bits.length % 8 !== 0) bits.push(false);
    const data = [];
    for (let index = 0; index < bits.length; index += 8) {
      let byte = 0;
      for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | Number(bits[index + offset]);
      data.push(byte);
    }
    for (let pad = 0; data.length < capacity / 8; pad += 1) data.push(pad % 2 === 0 ? 0xec : 0x11);
    return { version, data };
  }
  throw new Error("QR payload is too long.");
}

function interleaveWithErrorCorrection(version, data) {
  const blocks = ERROR_CORRECTION_BLOCKS[version];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (rawCodewords % blocks);
  const shortLength = Math.floor(rawCodewords / blocks);
  const divisor = reedSolomonDivisor(eccLength);
  const assembled = [];
  for (let index = 0, offset = 0; index < blocks; index += 1) {
    const length = shortLength - eccLength + (index < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    const ecc = reedSolomonRemainder(block, divisor);
    if (index < shortBlocks) block.push(0);
    assembled.push([...block, ...ecc]);
  }
  const result = [];
  for (let column = 0; column < assembled[0].length; column += 1) {
    assembled.forEach((block, index) => {
      // Short blocks carry a placeholder in the column the long blocks fill.
      if (column !== shortLength - eccLength || index >= shortBlocks) result.push(block[column]);
    });
  }
  return result;
}

const MASK_COUNT = 8;

// A switch, not a table of functions: the PR1815 read-RPC drift scanner treats
// a call through a computed alias as a possible hidden .rpc() call.
function maskApplies(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
];

// The four ISO/IEC 18004 penalty rules; the mask with the lowest score wins.
function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const lines = [];
  for (let index = 0; index < size; index += 1) {
    lines.push(modules[index]);
    lines.push(modules.map((row) => row[index]));
  }
  for (const line of lines) {
    let run = 1;
    for (let index = 1; index <= size; index += 1) {
      if (index < size && line[index] === line[index - 1]) {
        run += 1;
      } else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    for (let index = 0; index + 11 <= size; index += 1) {
      if (FINDER_LIKE.some((pattern) => pattern.every((dark, offset) => line[index + offset] === dark))) score += 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) dark += 1;
      if (x + 1 < size && y + 1 < size) {
        const color = modules[y][x];
        if (modules[y][x + 1] === color && modules[y + 1][x] === color && modules[y + 1][x + 1] === color) score += 3;
      }
    }
  }
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

function buildMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const functions = Array.from({ length: size }, () => Array(size).fill(false));
  const setFunction = (x, y, dark) => {
    modules[y][x] = dark;
    functions[y][x] = true;
  };

  for (let index = 0; index < size; index += 1) {
    setFunction(6, index, index % 2 === 0);
    setFunction(index, 6, index % 2 === 0);
  }
  for (const [centerX, centerY] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let y = -4; y <= 4; y += 1) {
      for (let x = -4; x <= 4; x += 1) {
        const targetX = centerX + x;
        const targetY = centerY + y;
        if (targetX < 0 || targetX >= size || targetY < 0 || targetY >= size) continue;
        const distance = Math.max(Math.abs(x), Math.abs(y));
        setFunction(targetX, targetY, distance !== 2 && distance !== 4);
      }
    }
  }
  const alignments = alignmentPositions(version, size);
  const last = alignments.length - 1;
  alignments.forEach((centerY, row) => {
    alignments.forEach((centerX, column) => {
      // The three corners already hold finder patterns.
      if ((row === 0 && column === 0) || (row === 0 && column === last) || (row === last && column === 0)) return;
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -2; x <= 2; x += 1) setFunction(centerX + x, centerY + y, Math.max(Math.abs(x), Math.abs(y)) !== 1);
      }
    });
  });

  const formatData = (FORMAT_BITS_M << 3) | mask;
  let remainder = formatData;
  for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const format = ((formatData << 10) | remainder) ^ 0x5412;
  for (let index = 0; index <= 5; index += 1) setFunction(8, index, getBit(format, index));
  setFunction(8, 7, getBit(format, 6));
  setFunction(8, 8, getBit(format, 7));
  setFunction(7, 8, getBit(format, 8));
  for (let index = 9; index < 15; index += 1) setFunction(14 - index, 8, getBit(format, index));
  for (let index = 0; index < 8; index += 1) setFunction(size - 1 - index, 8, getBit(format, index));
  for (let index = 8; index < 15; index += 1) setFunction(8, size - 15 + index, getBit(format, index));
  setFunction(8, size - 8, true);

  if (version >= 7) {
    let versionRemainder = version;
    for (let index = 0; index < 12; index += 1) versionRemainder = (versionRemainder << 1) ^ ((versionRemainder >>> 11) * 0x1f25);
    const versionBits = (version << 12) | versionRemainder;
    for (let index = 0; index < 18; index += 1) {
      const dark = getBit(versionBits, index);
      const near = size - 11 + (index % 3);
      const far = Math.floor(index / 3);
      setFunction(near, far, dark);
      setFunction(far, near, dark);
    }
  }

  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? size - 1 - vertical : vertical;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (functions[y][x]) continue;
        let dark = bitIndex < codewords.length * 8 && getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
        if (maskApplies(mask, x, y)) dark = !dark;
        modules[y][x] = dark;
        bitIndex += 1;
      }
    }
  }
  return modules;
}

/** Returns the module matrix (rows of booleans, true = dark) for `text`. */
export function makeQrMatrix(text) {
  const value = String(text ?? "");
  if (!value) throw new Error("QR payload is empty.");
  const { version, data } = encodeData(new TextEncoder().encode(value));
  const codewords = interleaveWithErrorCorrection(version, data);
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < MASK_COUNT; mask += 1) {
    const candidate = buildMatrix(version, codewords, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export const QR_QUIET_ZONE = 4;

/** SVG path data for the dark modules, offset by the four-module quiet zone. */
export function qrSvgPath(matrix) {
  return matrix.flatMap((row, y) => row.map((dark, x) => (
    dark ? `M${x + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h1v1h-1z` : ""
  ))).join("");
}
