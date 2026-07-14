import path from 'node:path';

export function decodeBinaryPayload(value) {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return Buffer.from(value);
  if (typeof value === 'string') {
    const match = /^data:[^;,]+;base64,(.*)$/s.exec(value);
    return Buffer.from(match ? match[1] : value, 'base64');
  }
  if (!value || typeof value !== 'object') return null;
  if (typeof value.encoded === 'string') {
    const bytes = decodeBinaryPayload(value.encoded);
    const offset = Number(value.byteOffset || 0);
    const length = Number.isFinite(Number(value.length)) ? Number(value.length) : bytes.length - offset;
    return bytes.subarray(offset, offset + length);
  }
  const keys = Object.keys(value).filter((key) => /^\d+$/.test(key)).map(Number).sort((a, b) => a - b);
  return keys.length ? Buffer.from(keys.map((key) => value[key])) : null;
}

function jpegDimensions(bytes) {
  let offset = 2;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > bytes.length) break;
    if (startOfFrame.has(marker)) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    offset += length + 2;
  }
  return {};
}

function webpDimensions(bytes) {
  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return {};
}

const EXTENSIONS = {
  '.png': ['image/png', 'image'], '.jpg': ['image/jpeg', 'image'], '.jpeg': ['image/jpeg', 'image'], '.webp': ['image/webp', 'image'],
  '.gif': ['image/gif', 'image'], '.avif': ['image/avif', 'image'], '.mp4': ['video/mp4', 'video'], '.mov': ['video/quicktime', 'video'],
  '.webm': ['video/webm', 'video'], '.mp3': ['audio/mpeg', 'audio'], '.wav': ['audio/wav', 'audio'], '.m4a': ['audio/mp4', 'audio'],
  '.aac': ['audio/aac', 'audio'], '.flac': ['audio/flac', 'audio'], '.ogg': ['audio/ogg', 'audio'], '.pdf': ['application/pdf', 'file']
};

const EQUIVALENT_EXTENSIONS = new Map([
  ['.jpg', new Set(['.jpg', '.jpeg'])],
  ['.jpeg', new Set(['.jpg', '.jpeg'])]
]);

export function mediaExtensionsMatch(current, detected) {
  const normalizedCurrent = String(current || '').toLowerCase();
  const normalizedDetected = String(detected || '').toLowerCase();
  return normalizedCurrent === normalizedDetected || EQUIVALENT_EXTENSIONS.get(normalizedCurrent)?.has(normalizedDetected) || false;
}

export function correctMediaFileExtension(fileName, detectedExtension) {
  const value = String(fileName || '').trim();
  if (!value || !detectedExtension) return value || null;
  const match = /\.[a-z0-9][a-z0-9+-]{0,11}$/i.exec(value);
  if (!match) return value;
  return mediaExtensionsMatch(match[0], detectedExtension) ? value : `${value.slice(0, -match[0].length)}${detectedExtension}`;
}

function isoBaseMedia(bytes, fileName, mimeHint) {
  if (bytes.length < 12 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') return null;
  const extension = path.extname(fileName).toLowerCase();
  const hintedMime = String(mimeHint || '').toLowerCase();
  const brands = [bytes.subarray(8, 12).toString('ascii')];
  for (let offset = 16; offset + 4 <= Math.min(bytes.length, 64); offset += 4) brands.push(bytes.subarray(offset, offset + 4).toString('ascii'));
  if (brands.some((brand) => /^(?:avif|avis)$/.test(brand))) return { extension: '.avif', mimeType: 'image/avif', kind: 'image' };
  if (hintedMime.startsWith('audio/') || ['.m4a', '.m4b', '.m4p', '.aac'].includes(extension) || brands.some((brand) => /^M4[ABP] $/.test(brand))) {
    return { extension: extension === '.aac' ? '.aac' : '.m4a', mimeType: extension === '.aac' ? 'audio/aac' : 'audio/mp4', kind: 'audio' };
  }
  if (extension === '.mov' || brands.includes('qt  ')) return { extension: '.mov', mimeType: 'video/quicktime', kind: 'video' };
  return { extension: '.mp4', mimeType: 'video/mp4', kind: 'video' };
}

export function inspectMediaSignature(value, fileName = '', mimeHint = '') {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: '.png', mimeType: 'image/png', kind: 'image', ...(bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : {}) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return { extension: '.jpg', mimeType: 'image/jpeg', kind: 'image', ...jpegDimensions(bytes) };
  if (bytes.length >= 10 && bytes.subarray(0, 6).toString('ascii').startsWith('GIF8')) return { extension: '.gif', mimeType: 'image/gif', kind: 'image', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { extension: '.webp', mimeType: 'image/webp', kind: 'image', ...webpDimensions(bytes) };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return { extension: '.wav', mimeType: 'audio/wav', kind: 'audio' };
  if (bytes.subarray(0, 4).toString('ascii') === 'fLaC') return { extension: '.flac', mimeType: 'audio/flac', kind: 'audio' };
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return { extension: '.mp3', mimeType: 'audio/mpeg', kind: 'audio' };
  if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return { extension: '.ogg', mimeType: 'audio/ogg', kind: 'audio' };
  const isoMedia = isoBaseMedia(bytes, fileName, mimeHint);
  if (isoMedia) return isoMedia;
  if (bytes.subarray(0, 4).toString('ascii') === '%PDF') return { extension: '.pdf', mimeType: 'application/pdf', kind: 'file' };
  return null;
}

export function inspectMedia(value, fileName = '', mimeHint = '') {
  const detected = inspectMediaSignature(value, fileName, mimeHint);
  if (detected) return detected;
  const extension = path.extname(fileName).toLowerCase();
  const hinted = Object.entries(EXTENSIONS).find(([, [mimeType]]) => mimeType === String(mimeHint).toLowerCase());
  const [mimeType, kind] = EXTENSIONS[extension] || hinted?.[1] || ['application/octet-stream', 'file'];
  return { extension: extension || hinted?.[0] || '.bin', mimeType, kind };
}
