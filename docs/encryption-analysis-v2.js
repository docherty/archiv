/**
 * Venice.ai Deep Encryption Analysis Script (V2)
 * 
 * The simple AES-GCM attempts failed, so Venice is using something more sophisticated.
 * Possible approaches:
 * 1. Key derivation (PBKDF2, HKDF) before encryption
 * 2. Different library (libsodium/NaCl, tweetnacl)
 * 3. Custom format with headers
 * 4. Additional authenticated data (AAD)
 * 
 * This script will investigate further.
 */

(async function deepAnalyzeVeniceEncryption() {
  console.log('🔐 Venice Deep Encryption Analysis (V2)');
  console.log('='.repeat(60));
  
  // Get key and sample data
  const keyStr = localStorage.getItem('encryptionKey');
  const keyBytes = new Uint8Array(keyStr.split(',').map(Number));
  
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('venice-db-encrypted', 210);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  
  const tx = db.transaction(['messages', 'conversations', '_encryptionSettings'], 'readonly');
  
  const messages = await new Promise((resolve) => {
    const req = tx.objectStore('messages').getAll();
    req.onsuccess = () => resolve(req.result);
  });
  
  const encSettings = await new Promise((resolve) => {
    const req = tx.objectStore('_encryptionSettings').getAll();
    req.onsuccess = () => resolve(req.result);
  });
  
  console.log('\n📋 Encryption Settings:');
  console.log(JSON.stringify(encSettings, null, 2));
  
  const sample = messages[0];
  const encData = sample.__encryptedData;
  const encBytes = new Uint8Array(Object.keys(encData).length);
  for (let i = 0; i < encBytes.length; i++) {
    encBytes[i] = encData[i];
  }
  
  console.log('\n📊 Sample Analysis:');
  console.log(`  Message ID: ${sample.id}`);
  console.log(`  Encrypted length: ${encBytes.length} bytes`);
  console.log(`  First 32 bytes: ${Array.from(encBytes.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
  
  // =========================================
  // APPROACH 1: Look for Dexie-encrypted patterns
  // =========================================
  
  console.log('\n🔍 Checking for Dexie-encrypted library patterns...');
  
  // Dexie-encrypted typically uses:
  // - tweetnacl's secretbox (XSalsa20-Poly1305)
  // - or AES-GCM with specific formatting
  
  // XSalsa20-Poly1305 uses 24-byte nonce
  if (encBytes.length > 40) {
    console.log('  Trying XSalsa20-Poly1305 (24-byte nonce)...');
    // Would need tweetnacl library to test
  }
  
  // =========================================
  // APPROACH 2: Check for key derivation
  // =========================================
  
  console.log('\n🔍 Testing key derivation approaches...');
  
  // Try PBKDF2 with various salts
  async function tryPBKDF2(password, salt, iterations = 100000) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      password,
      'PBKDF2',
      false,
      ['deriveKey']
    );
    
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }
  
  // Try using first N bytes of encrypted data as salt
  for (const saltLen of [8, 12, 16]) {
    try {
      const salt = encBytes.slice(0, saltLen);
      const derivedKey = await tryPBKDF2(keyBytes, salt, 100000);
      
      // Try decrypting rest with derived key
      const nonce = encBytes.slice(saltLen, saltLen + 12);
      const ciphertext = encBytes.slice(saltLen + 12);
      
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce },
        derivedKey,
        ciphertext
      );
      
      console.log(`  ✅ SUCCESS with PBKDF2 (${saltLen}-byte salt)!`);
      console.log(`  Decrypted: ${new TextDecoder().decode(decrypted).substring(0, 100)}`);
    } catch (e) {
      // Silent fail, try next
    }
  }
  
  // =========================================
  // APPROACH 3: Search Venice's code for encryption
  // =========================================
  
  console.log('\n🔍 Searching for encryption in Venice code...');
  
  // Look through loaded scripts
  const scripts = Array.from(document.querySelectorAll('script[src]'));
  console.log(`  Found ${scripts.length} external scripts`);
  
  // Search for crypto-related globals
  const cryptoKeywords = ['encrypt', 'decrypt', 'cipher', 'aes', 'gcm', 'nacl', 'sodium', 'tweetnacl', 'dexie'];
  
  console.log('\n  Checking window for crypto-related objects...');
  for (const key of Object.keys(window)) {
    const lower = key.toLowerCase();
    if (cryptoKeywords.some(kw => lower.includes(kw))) {
      console.log(`    Found: window.${key}`);
    }
  }
  
  // =========================================
  // APPROACH 4: Check if Dexie is present
  // =========================================
  
  console.log('\n🔍 Checking for Dexie (IndexedDB library)...');
  
  if (typeof Dexie !== 'undefined') {
    console.log('  ✅ Dexie is present globally');
    console.log(`  Version: ${Dexie.version}`);
  } else {
    console.log('  Dexie not found globally (may be module-scoped)');
  }
  
  // =========================================
  // APPROACH 5: Examine the encryption settings more closely
  // =========================================
  
  console.log('\n🔍 Examining _encryptionSettings...');
  
  if (encSettings && encSettings.length > 0) {
    const settings = encSettings[0];
    console.log('  Settings object:', settings);
    
    if (settings.settings) {
      console.log('  Encryption per table:');
      for (const [table, mode] of Object.entries(settings.settings)) {
        console.log(`    ${table}: ${mode}`);
      }
    }
    
    if (settings.keyChangeDetection) {
      console.log(`  Key change detection: ${settings.keyChangeDetection}`);
    }
  }
  
  // =========================================
  // APPROACH 6: Try to intercept encryption
  // =========================================
  
  console.log('\n🔍 Setting up crypto.subtle interception...');
  
  const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  
  crypto.subtle.encrypt = async function(algorithm, key, data) {
    console.log('🔒 Intercepted encrypt call:', {
      algorithm: algorithm.name || algorithm,
      ivLength: algorithm.iv?.length,
      dataLength: data.byteLength
    });
    return originalEncrypt(algorithm, key, data);
  };
  
  crypto.subtle.decrypt = async function(algorithm, key, data) {
    console.log('🔓 Intercepted decrypt call:', {
      algorithm: algorithm.name || algorithm,
      ivLength: algorithm.iv?.length,
      dataLength: data.byteLength
    });
    return originalDecrypt(algorithm, key, data);
  };
  
  console.log('  Interception active. Try creating/viewing a chat to see calls.');
  
  // =========================================
  // APPROACH 7: Check the __encryptedData more carefully
  // =========================================
  
  console.log('\n🔍 Analyzing multiple encrypted samples...');
  
  for (let i = 0; i < Math.min(3, messages.length); i++) {
    const msg = messages[i];
    const enc = msg.__encryptedData;
    const bytes = new Uint8Array(Object.keys(enc).length);
    for (let j = 0; j < bytes.length; j++) {
      bytes[j] = enc[j];
    }
    
    console.log(`\n  Message ${i + 1} (${msg.id}):`);
    console.log(`    Length: ${bytes.length} bytes`);
    console.log(`    First 24: ${Array.from(bytes.slice(0, 24)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    
    // Check if lengths have any pattern
    // NaCl secretbox: 24-byte nonce + ciphertext + 16-byte tag
    if (bytes.length > 40) {
      console.log(`    If NaCl secretbox: nonce(24) + ciphertext(${bytes.length - 24 - 16}) + tag(16)`);
    }
  }
  
  // =========================================
  // APPROACH 8: Try NaCl secretbox format
  // =========================================
  
  console.log('\n🔍 Checking if tweetnacl/NaCl is used...');
  
  // NaCl secretbox uses XSalsa20-Poly1305
  // Format: 24-byte nonce + ciphertext + 16-byte auth tag
  // The key is used directly (no derivation)
  
  // Check if nacl is available
  if (typeof nacl !== 'undefined') {
    console.log('  ✅ nacl library found globally!');
    
    try {
      const nonce = encBytes.slice(0, 24);
      const ciphertext = encBytes.slice(24);
      
      const decrypted = nacl.secretbox.open(ciphertext, nonce, keyBytes);
      if (decrypted) {
        console.log('  ✅ SUCCESS with NaCl secretbox!');
        console.log(`  Decrypted: ${new TextDecoder().decode(decrypted).substring(0, 200)}`);
        window.__veniceEncryptionFormat = 'NaCl-secretbox';
      }
    } catch (e) {
      console.log(`  NaCl secretbox failed: ${e.message}`);
    }
  } else {
    console.log('  nacl not found globally. May need to load tweetnacl.');
    
    // Offer to load tweetnacl for testing
    console.log('\n  To test NaCl, run this:');
    console.log(`  
    // Load tweetnacl
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js';
    script.onload = () => {
      const nonce = new Uint8Array([/* first 24 bytes of encrypted data */]);
      const ciphertext = new Uint8Array([/* rest of encrypted data */]);
      const key = new Uint8Array(localStorage.getItem('encryptionKey').split(',').map(Number));
      
      const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
      console.log('Decrypted:', new TextDecoder().decode(decrypted));
    };
    document.head.appendChild(script);
    `);
  }
  
  // =========================================
  // APPROACH 9: Raw inspection helper
  // =========================================
  
  console.log('\n📦 Exporting data for manual analysis...');
  
  window.__veniceAnalysis = {
    keyBytes,
    keyStr,
    sample: {
      id: sample.id,
      encBytes,
      rawRecord: sample
    },
    allMessages: messages,
    encSettings,
    
    // Helper to try different nonce sizes
    async tryDecrypt(nonceSize = 12, format = 'AES-GCM') {
      const nonce = encBytes.slice(0, nonceSize);
      const ciphertext = encBytes.slice(nonceSize);
      
      const key = await crypto.subtle.importKey(
        'raw', keyBytes, { name: format }, false, ['decrypt']
      );
      
      return crypto.subtle.decrypt(
        { name: format, iv: nonce }, key, ciphertext
      );
    }
  };
  
  console.log('\n💡 Manual analysis helpers at: window.__veniceAnalysis');
  console.log('   - keyBytes: The raw encryption key');
  console.log('   - sample.encBytes: The encrypted message bytes');
  console.log('   - tryDecrypt(nonceSize, format): Test different parameters');
  
  // =========================================
  // SUMMARY
  // =========================================
  
  console.log('\n' + '='.repeat(60));
  console.log('📋 ANALYSIS SUMMARY');
  console.log('='.repeat(60));
  console.log(`
Key: ${keyBytes.length} bytes (AES-256 compatible)
Encrypted data: ${encBytes.length} bytes

Standard AES-GCM with direct key: ❌ Failed
Standard AES-CBC with direct key: ❌ Failed

Next steps:
1. Load tweetnacl and test NaCl secretbox
2. Intercept Venice's encryption calls (refresh page with interception active)
3. Search Venice's source for encryption library

The crypto.subtle interceptor is now active - try loading a conversation
to see what encryption calls Venice makes.
  `);
  
  db.close();
  
})();
