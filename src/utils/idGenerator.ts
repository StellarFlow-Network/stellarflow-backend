import { randomBytes } from "crypto";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_BYTES = 6;
const RANDOM_BYTES = 10;

let lastTimestamp = 0;
let lastEntropy = new Uint8Array(RANDOM_BYTES);

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (let i = 0; i < bytes.length; i += 1) {
    value = (value << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      output += CROCKFORD_BASE32[(value >>> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    output += CROCKFORD_BASE32[(value << (5 - bits)) & 0x1f];
  }

  return output;
}

function encodeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new TypeError("Timestamp must be a non-negative finite number");
  }

  const timeBuffer = new Uint8Array(TIME_BYTES);

  for (let i = TIME_BYTES - 1; i >= 0; i -= 1) {
    timeBuffer[i] = timestamp & 0xff;
    timestamp = timestamp >>> 8;
  }

  return encodeBase32(timeBuffer).padStart(10, "0");
}

function encodeRandom(bytes: Uint8Array): string {
  return encodeBase32(bytes).padStart(16, "0");
}

function incrementEntropy(entropy: Uint8Array): void {
  for (let index = entropy.length - 1; index >= 0; index -= 1) {
    if (entropy[index] !== 0xff) {
      entropy[index] += 1;
      return;
    }
    entropy[index] = 0;
  }
}

export function generateSortableLogId(): string {
  let timestamp = Date.now();
  if (timestamp <= lastTimestamp) {
    timestamp = lastTimestamp;
    incrementEntropy(lastEntropy);
  } else {
    lastTimestamp = timestamp;
    lastEntropy = randomBytes(RANDOM_BYTES);
  }

  return `${encodeTime(timestamp)}${encodeRandom(lastEntropy)}`;
}
