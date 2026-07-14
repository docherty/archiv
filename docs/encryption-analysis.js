/**
 * Venice.ai Encryption Analysis Script
 * 
 * Run this in the browser console on venice.ai to discover:
 * 1. The encryption algorithm Venice uses
 * 2. The data format (IV/nonce position, auth tag, etc.)
 * 3. Whether we can successfully decrypt/re-encrypt
 * 
 * This is essential for the unified view feature that re-encrypts
 * old conversations with a new key.
 */

(async function analyzeVeniceEncryption() {
  console.log('🔐 Venice Encryption Analysis');
  console.log('='.repeat(50));
  
  // =========================================
  // STEP 1: Get the encryption key
  // =========================================
  
  const keyStr = localStorage.getItem('encryptionKey');
  if (!keyStr) {
    console.error('❌ No encryption key found in localStorage');
    return;
  }
  
  const keyBytes = new Uint8Array(keyStr.split(',').map(Number));
  console.log('\n📊 Key Analysis:');
  console.log(`  Length: ${keyBytes.length} bytes`);
  console.log(`  Likely: AES-${keyBytes.length * 8} (${keyBytes.length === 32 ? 'AES-256' : keyBytes.length === 16 ? 'AES-128' : 'unknown'})`);
  
  // =========================================
  // STEP 2: Get sample encrypted data
  // =========================================
  
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('venice-db-encrypted', 210);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  
  const tx = db.transaction(['messages', 'conversations'], 'readonly');
  
  const messages = await new Promise((resolve) => {
    const req = tx.objectStore('messages').getAll();
    req.onsuccess = () => resolve(req.result);
  });
  
  const conversations = await new Promise((resolve) => {
    const req = tx.objectStore('conversations').getAll();
    req.onsuccess = () => resolve(req.result);
  });
  
  if (messages.length === 0) {
    console.error('❌ No messages found to analyze');
    return;
  }
  
  console.log(`\n📦 Found ${messages.length} messages, ${conversations.length} conversations`);
  
  // =========================================
  // STEP 3: Analyze encrypted data format
  // =========================================
  
  const sample = messages[0];
  const encData = sample.__encryptedData;
  
  // Convert byte object to Uint8Array
  const encBytes = new Uint8Array(Object.keys(encData).length);
  for (let i = 0; i < encBytes.length; i++) {
    encBytes[i] = encData[i];
  }
  
  console.log('\n📊 Encrypted Data Analysis:');
  console.log(`  Total length: ${encBytes.length} bytes`);
  console.log(`  First 16 bytes (hex): ${Array.from(encBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
  console.log(`  Last 16 bytes (hex): ${Array.from(encBytes.slice(-16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
  
  // Analyze possible formats
  console.log('\n🔍 Format Detection:');
  
  // AES-GCM: typically 12-byte nonce + ciphertext + 16-byte auth tag
  // AES-CBC: typically 16-byte IV + ciphertext (padded)
  
  const possibleFormats = [];
  
  // Check for AES-GCM (12-byte nonce)
  if (encBytes.length > 28) { // At minimum: 12 nonce + 1 data + 16 tag
    possibleFormats.push({
      name: 'AES-GCM (12-byte nonce)',
      nonceSize: 12,
      tagSize: 16,
      ciphertextSize: encBytes.length - 12 - 16
    });
  }
  
  // Check for AES-GCM (16-byte nonce) - less common but possible
  if (encBytes.length > 32) {
    possibleFormats.push({
      name: 'AES-GCM (16-byte nonce)',
      nonceSize: 16,
      tagSize: 16,
      ciphertextSize: encBytes.length - 16 - 16
    });
  }
  
  // Check for AES-CBC (16-byte IV)
  if (encBytes.length % 16 === 0) {
    possibleFormats.push({
      name: 'AES-CBC (16-byte IV, padded)',
      ivSize: 16,
      ciphertextSize: encBytes.length - 16
    });
  }
  
  possibleFormats.forEach(f => {
    console.log(`  Possible: ${f.name}`);
  });
  
  // =========================================
  // STEP 4: Try to decrypt with AES-GCM
  // =========================================
  
  console.log('\n🔓 Attempting Decryption...');
  
  // Try AES-GCM with 12-byte nonce (most common for WebCrypto)
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    
    // Try: nonce at start (12 bytes), rest is ciphertext with integrated tag
    const nonce = encBytes.slice(0, 12);
    const ciphertext = encBytes.slice(12);
    
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      ciphertext
    );
    
    const plaintext = new TextDecoder().decode(decrypted);
    console.log('  ✅ SUCCESS with AES-GCM (12-byte nonce at start)');
    console.log(`  Decrypted length: ${plaintext.length} chars`);
    console.log(`  Preview: ${plaintext.substring(0, 200)}...`);
    
    // Parse as JSON to see structure
    try {
      const parsed = JSON.parse(plaintext);
      console.log('\n📋 Decrypted Structure:');
      console.log(`  Type: ${typeof parsed}`);
      console.log(`  Keys: ${Object.keys(parsed).join(', ')}`);
      
      // Store for later use
      window.__veniceDecryptedSample = parsed;
      window.__veniceEncryptionFormat = 'AES-GCM-12';
      
    } catch (e) {
      console.log('  Note: Decrypted data is not JSON');
      window.__veniceDecryptedSample = plaintext;
      window.__veniceEncryptionFormat = 'AES-GCM-12';
    }
    
    // =========================================
    // STEP 5: Test Re-encryption
    // =========================================
    
    console.log('\n🔄 Testing Re-encryption...');
    
    const encryptKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );
    
    // Generate new nonce
    const newNonce = crypto.getRandomValues(new Uint8Array(12));
    
    const reencrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: newNonce },
      encryptKey,
      decrypted
    );
    
    // Combine nonce + ciphertext (same format as original)
    const combined = new Uint8Array(newNonce.length + reencrypted.byteLength);
    combined.set(newNonce);
    combined.set(new Uint8Array(reencrypted), newNonce.length);
    
    console.log(`  Re-encrypted length: ${combined.length} bytes`);
    console.log(`  Original length: ${encBytes.length} bytes`);
    console.log(`  ✅ Re-encryption successful!`);
    
    // Verify by decrypting again
    const verifyNonce = combined.slice(0, 12);
    const verifyCiphertext = combined.slice(12);
    
    const verified = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: verifyNonce },
      key,
      verifyCiphertext
    );
    
    const verifiedText = new TextDecoder().decode(verified);
    console.log(`  Verification: ${verifiedText === plaintext ? '✅ Match' : '❌ Mismatch'}`);
    
    // =========================================
    // STEP 6: Summary
    // =========================================
    
    console.log('\n' + '='.repeat(50));
    console.log('📋 SUMMARY');
    console.log('='.repeat(50));
    console.log(`
Encryption Algorithm: AES-256-GCM
Key Size: 32 bytes (256 bits)
Nonce Size: 12 bytes
Format: [12-byte nonce][ciphertext + auth tag]

The encrypted data structure:
┌──────────────┬────────────────────────────────────────┐
│ 12 bytes     │ Variable length                        │
│ Nonce/IV     │ Ciphertext + 16-byte GCM auth tag     │
└──────────────┴────────────────────────────────────────┘

✅ Re-encryption is POSSIBLE!
   We can decrypt with old key and re-encrypt with new key.
    `);
    
    // Export utility functions
    window.__veniceEncryption = {
      async decrypt(encryptedData, keyBytes) {
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
        const data = this.byteObjectToArray(encryptedData);
        const nonce = data.slice(0, 12);
        const ciphertext = data.slice(12);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
        return new TextDecoder().decode(decrypted);
      },
      
      async encrypt(plaintext, keyBytes) {
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce },
          key,
          new TextEncoder().encode(plaintext)
        );
        const combined = new Uint8Array(nonce.length + encrypted.byteLength);
        combined.set(nonce);
        combined.set(new Uint8Array(encrypted), nonce.length);
        return this.arrayToByteObject(combined);
      },
      
      async reencrypt(encryptedData, oldKeyBytes, newKeyBytes) {
        const plaintext = await this.decrypt(encryptedData, oldKeyBytes);
        return await this.encrypt(plaintext, newKeyBytes);
      },
      
      byteObjectToArray(obj) {
        const length = Object.keys(obj).length;
        const arr = new Uint8Array(length);
        for (let i = 0; i < length; i++) arr[i] = obj[i];
        return arr;
      },
      
      arrayToByteObject(arr) {
        const obj = {};
        for (let i = 0; i < arr.length; i++) obj[i] = arr[i];
        return obj;
      },
      
      parseKeyString(keyStr) {
        return new Uint8Array(keyStr.split(',').map(Number));
      }
    };
    
    console.log('\n💡 Utility functions available at: window.__veniceEncryption');
    console.log('   Example: await __veniceEncryption.decrypt(data, keyBytes)');
    
  } catch (e) {
    console.log(`  ❌ AES-GCM (12-byte nonce) failed: ${e.message}`);
    
    // Try other formats...
    console.log('\n  Trying alternative formats...');
    
    // Try AES-GCM with 16-byte nonce
    try {
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
      const nonce = encBytes.slice(0, 16);
      const ciphertext = encBytes.slice(16);
      
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
      console.log('  ✅ SUCCESS with AES-GCM (16-byte nonce)');
      window.__veniceEncryptionFormat = 'AES-GCM-16';
    } catch (e2) {
      console.log(`  ❌ AES-GCM (16-byte nonce) failed: ${e2.message}`);
    }
    
    // Try AES-CBC
    try {
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
      const iv = encBytes.slice(0, 16);
      const ciphertext = encBytes.slice(16);
      
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
      console.log('  ✅ SUCCESS with AES-CBC');
      window.__veniceEncryptionFormat = 'AES-CBC';
    } catch (e3) {
      console.log(`  ❌ AES-CBC failed: ${e3.message}`);
    }
    
    console.log('\n⚠️ Could not determine encryption format. May need manual investigation.');
  }
  
  db.close();
  
})();
