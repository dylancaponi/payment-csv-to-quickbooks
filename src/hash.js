// Stable 64-bit FNV-1a hash over UTF-8 bytes, returned as 16 lowercase hex
// characters. Used for deterministic FITIDs: the same source row always gets
// the same id, so re-importing a file does not create duplicates.

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

let encoder = null;
function utf8(s) {
  if (!encoder) encoder = new TextEncoder();
  return encoder.encode(s);
}

export function fnv1a64(str) {
  let h = OFFSET;
  const bytes = utf8(str);
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}
