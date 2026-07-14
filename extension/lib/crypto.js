/**
 * Venice Encryption Module
 * 
 * Handles NaCl secretbox (XSalsa20-Poly1305) encryption/decryption
 * for Venice.ai's IndexedDB data.
 * 
 * Confirmed format:
 * - Algorithm: XSalsa20-Poly1305 (NaCl secretbox)
 * - Key: 32 bytes
 * - Nonce: 24 bytes (prepended to ciphertext)
 * - Auth tag: 16 bytes (Poly1305 MAC, appended to ciphertext)
 */

// Ensure nacl is loaded (from nacl.min.js)
if (typeof nacl === 'undefined') {
  throw new Error('TweetNaCl library not loaded. Include nacl.min.js before crypto.js');
}

export const VeniceCrypto = {
  /**
   * Decrypt Venice encrypted data
   * @param {Object|Uint8Array} encryptedData - Byte object {0: byte, 1: byte, ...} or Uint8Array
   * @param {Uint8Array} keyBytes - 32-byte encryption key
   * @returns {string} Decrypted plaintext (JSON string)
   */
  decrypt(encryptedData, keyBytes) {
    const data = this.toUint8Array(encryptedData);
    const nonce = data.slice(0, 24);
    const ciphertext = data.slice(24);
    
    const decrypted = nacl.secretbox.open(ciphertext, nonce, keyBytes);
    if (!decrypted) {
      throw new Error('Decryption failed - wrong key or corrupted data');
    }
    
    return new TextDecoder().decode(decrypted);
  },
  
  /**
   * Encrypt plaintext for Venice
   * @param {string} plaintext - Data to encrypt (JSON string)
   * @param {Uint8Array} keyBytes - 32-byte encryption key
   * @returns {Object} Byte object in Venice format {0: byte, 1: byte, ...}
   */
  encrypt(plaintext, keyBytes) {
    const nonce = nacl.randomBytes(24);
    const message = new TextEncoder().encode(plaintext);
    const encrypted = nacl.secretbox(message, nonce, keyBytes);
    
    // Combine: nonce + ciphertext (Venice format)
    const combined = new Uint8Array(nonce.length + encrypted.length);
    combined.set(nonce);
    combined.set(encrypted, nonce.length);
    
    return this.toByteObject(combined);
  },
  
  /**
   * Re-encrypt data from old key to new key
   * @param {Object} encryptedData - Venice encrypted byte object
   * @param {Uint8Array} oldKeyBytes - Original encryption key
   * @param {Uint8Array} newKeyBytes - New encryption key
   * @returns {Object} Re-encrypted byte object
   */
  reencrypt(encryptedData, oldKeyBytes, newKeyBytes) {
    const plaintext = this.decrypt(encryptedData, oldKeyBytes);
    return this.encrypt(plaintext, newKeyBytes);
  },
  
  /**
   * Convert Venice byte object to Uint8Array
   * @param {Object|Uint8Array} obj - Byte object {0: byte, 1: byte, ...} or Uint8Array
   * @returns {Uint8Array}
   */
  toUint8Array(obj) {
    if (obj instanceof Uint8Array) return obj;
    
    const length = Object.keys(obj).length;
    const arr = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      arr[i] = obj[i];
    }
    return arr;
  },
  
  /**
   * Convert Uint8Array to Venice byte object format
   * @param {Uint8Array} arr
   * @returns {Object} Byte object {0: byte, 1: byte, ...}
   */
  toByteObject(arr) {
    const obj = {};
    for (let i = 0; i < arr.length; i++) {
      obj[i] = arr[i];
    }
    return obj;
  },
  
  /**
   * Parse Venice's localStorage key format
   * @param {string} keyStr - Comma-separated byte string
   * @returns {Uint8Array} 32-byte key
   */
  parseKeyString(keyStr) {
    return new Uint8Array(keyStr.split(',').map(Number));
  },
  
  /**
   * Serialize key to Venice's localStorage format
   * @param {Uint8Array} keyBytes
   * @returns {string} Comma-separated byte string
   */
  serializeKey(keyBytes) {
    return Array.from(keyBytes).join(',');
  },
  
  /**
   * Generate a new random encryption key
   * @returns {Uint8Array} 32-byte random key
   */
  generateKey() {
    return nacl.randomBytes(32);
  }
};
