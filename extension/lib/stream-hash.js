/**
 * Small incremental SHA-256 implementation for browser Blob streams.
 * WebCrypto's digest API is one-shot; large Venice source stores need a
 * bounded-memory fallback that still produces a standard SHA-256 digest.
 */
(function initializeVeniceStreamHash(globalScope) {
  'use strict';

  const ROUND_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  const INITIAL_STATE = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];

  function rotateRight(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  class IncrementalSha256 {
    constructor() {
      this.state = new Uint32Array(INITIAL_STATE);
      this.block = new Uint8Array(64);
      this.blockLength = 0;
      this.bytesHashed = 0;
      this.finished = false;
      this.schedule = new Uint32Array(64);
    }

    update(input) {
      if (this.finished) throw new Error('SHA-256 digest has already been finalized.');
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      this.bytesHashed += bytes.byteLength;
      let offset = 0;

      if (this.blockLength) {
        const needed = 64 - this.blockLength;
        const take = Math.min(needed, bytes.length);
        this.block.set(bytes.subarray(0, take), this.blockLength);
        this.blockLength += take;
        offset += take;
        if (this.blockLength === 64) {
          this.processBlock(this.block);
          this.blockLength = 0;
        }
      }

      while (offset + 64 <= bytes.length) {
        this.processBlock(bytes.subarray(offset, offset + 64));
        offset += 64;
      }

      if (offset < bytes.length) {
        this.block.set(bytes.subarray(offset), this.blockLength);
        this.blockLength += bytes.length - offset;
      }
      return this;
    }

    processBlock(block) {
      const w = this.schedule;
      for (let index = 0; index < 16; index += 1) {
        const offset = index * 4;
        w[index] = (
          (block[offset] << 24) |
          (block[offset + 1] << 16) |
          (block[offset + 2] << 8) |
          block[offset + 3]
        ) >>> 0;
      }
      for (let index = 16; index < 64; index += 1) {
        const x = w[index - 15];
        const y = w[index - 2];
        const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
        const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
        w[index] = (w[index - 16] + sigma0 + w[index - 7] + sigma1) >>> 0;
      }

      let [a, b, c, d, e, f, g, h] = this.state;
      for (let index = 0; index < 64; index += 1) {
        const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = (h + sigma1 + choice + ROUND_CONSTANTS[index] + w[index]) >>> 0;
        const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sigma0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      this.state[0] = (this.state[0] + a) >>> 0;
      this.state[1] = (this.state[1] + b) >>> 0;
      this.state[2] = (this.state[2] + c) >>> 0;
      this.state[3] = (this.state[3] + d) >>> 0;
      this.state[4] = (this.state[4] + e) >>> 0;
      this.state[5] = (this.state[5] + f) >>> 0;
      this.state[6] = (this.state[6] + g) >>> 0;
      this.state[7] = (this.state[7] + h) >>> 0;
    }

    digest() {
      if (this.finished) throw new Error('SHA-256 digest has already been finalized.');
      this.finished = true;
      const bitLength = this.bytesHashed * 8;
      const high = Math.floor(bitLength / 0x100000000);
      const low = bitLength >>> 0;

      this.block[this.blockLength] = 0x80;
      this.blockLength += 1;
      if (this.blockLength > 56) {
        this.block.fill(0, this.blockLength);
        this.processBlock(this.block);
        this.blockLength = 0;
      }
      this.block.fill(0, this.blockLength, 56);
      this.block[56] = (high >>> 24) & 0xff;
      this.block[57] = (high >>> 16) & 0xff;
      this.block[58] = (high >>> 8) & 0xff;
      this.block[59] = high & 0xff;
      this.block[60] = (low >>> 24) & 0xff;
      this.block[61] = (low >>> 16) & 0xff;
      this.block[62] = (low >>> 8) & 0xff;
      this.block[63] = low & 0xff;
      this.processBlock(this.block);

      const output = new Uint8Array(32);
      this.state.forEach((word, index) => {
        const offset = index * 4;
        output[offset] = (word >>> 24) & 0xff;
        output[offset + 1] = (word >>> 16) & 0xff;
        output[offset + 2] = (word >>> 8) & 0xff;
        output[offset + 3] = word & 0xff;
      });
      return output;
    }

    digestHex() {
      return Array.from(this.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  }

  const api = Object.freeze({ IncrementalSha256 });
  globalScope.VeniceStreamHash = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
