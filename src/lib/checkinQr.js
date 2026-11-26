// A dependency-free QR Version 1-L encoder for the server's seven-character
// event token. Keeping this local avoids sending the short-lived bearer token
// to an image service and avoids adding a supply-chain dependency for one
// deliberately tiny, fixed-capacity payload.

export const CHECKIN_TOKEN_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{7}$/;
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const SIZE = 21;
const DATA_CODEWORDS = 19;
const ERROR_CODEWORDS = 7;

function appendBits(target, value, count) {
  for (let bit = count - 1; bit >= 0; bit -= 1) target.push(((value >>> bit) & 1) !== 0);
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
  return result;
}

function encodeCodewords(token) {
  const bits = [];
  appendBits(bits, 0b0010, 4); // Alphanumeric mode.
  appendBits(bits, token.length, 9); // Version 1-9 character-count width.
  for (let index = 0; index + 1 < token.length; index += 2) {
    appendBits(bits, ALPHANUMERIC.indexOf(token[index]) * 45 + ALPHANUMERIC.indexOf(token[index + 1]), 11);
  }
  if (token.length % 2 === 1) appendBits(bits, ALPHANUMERIC.indexOf(token[token.length - 1]), 6);

  const capacity = DATA_CODEWORDS * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(false);

  const data = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | Number(bits[index + offset]);
    data.push(byte);
  }
  for (let pad = 0; data.length < DATA_CODEWORDS; pad += 1) data.push(pad % 2 === 0 ? 0xec : 0x11);

  const error = reedSolomonRemainder(data, reedSolomonDivisor(ERROR_CODEWORDS));
  return Uint8Array.from([...data, ...error]);
}

function formatBit(value, index) {
  return ((value >>> index) & 1) !== 0;
}

function makeMatrix(codewords) {
  const modules = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const functions = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const setFunction = (x, y, dark) => {
    modules[y][x] = dark;
    functions[y][x] = true;
  };

  // Timing patterns land first; the finder patterns and their separators then
  // overwrite the corners exactly as required by ISO/IEC 18004.
  for (let index = 0; index < SIZE; index += 1) {
    setFunction(6, index, index % 2 === 0);
    setFunction(index, 6, index % 2 === 0);
  }
  for (const [centerX, centerY] of [[3, 3], [SIZE - 4, 3], [3, SIZE - 4]]) {
    for (let y = -4; y <= 4; y += 1) {
      for (let x = -4; x <= 4; x += 1) {
        const targetX = centerX + x;
        const targetY = centerY + y;
        if (targetX < 0 || targetX >= SIZE || targetY < 0 || targetY >= SIZE) continue;
        const distance = Math.max(Math.abs(x), Math.abs(y));
        setFunction(targetX, targetY, distance !== 2 && distance !== 4);
      }
    }
  }

  // Level L (format value 01) with mask 0. Format modules are reserved before
  // payload placement and are not masked with the data modules.
  const formatData = (1 << 3) | 0;
  let remainder = formatData;
  for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const format = ((formatData << 10) | remainder) ^ 0x5412;
  for (let index = 0; index <= 5; index += 1) setFunction(8, index, formatBit(format, index));
  setFunction(8, 7, formatBit(format, 6));
  setFunction(8, 8, formatBit(format, 7));
  setFunction(7, 8, formatBit(format, 8));
  for (let index = 9; index < 15; index += 1) setFunction(14 - index, 8, formatBit(format, index));
  for (let index = 0; index < 8; index += 1) setFunction(SIZE - 1 - index, 8, formatBit(format, index));
  for (let index = 8; index < 15; index += 1) setFunction(8, SIZE - 15 + index, formatBit(format, index));
  setFunction(8, SIZE - 8, true);

  let bitIndex = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < SIZE; vertical += 1) {
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? SIZE - 1 - vertical : vertical;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (functions[y][x]) continue;
        let dark = formatBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
        if ((x + y) % 2 === 0) dark = !dark; // Mask pattern 0.
        modules[y][x] = dark;
        bitIndex += 1;
      }
    }
  }
  return modules;
}

export function makeCheckinQrMatrix(value) {
  const token = String(value || "").trim().toUpperCase();
  if (token.length !== 7) throw new Error("Check-in QR tokens must be seven-character values.");
  if (!TOKEN_PATTERN.test(token)) throw new Error("Check-in QR token uses an unsupported alphabet.");
  return makeMatrix(encodeCodewords(token));
}
