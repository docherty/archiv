/**
 * Venice.ai NaCl Test Script
 * 
 * Tests if Venice uses tweetnacl/NaCl secretbox encryption.
 * Run this AFTER running encryption-analysis-v2.js to have the helpers loaded.
 */

(async function testNaClEncryption() {
  console.log('🔐 Testing NaCl/TweetNaCl encryption...');
  
  // Load tweetnacl if not present
  if (typeof nacl === 'undefined') {
    console.log('📥 Loading tweetnacl library...');
    
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    
    console.log('✅ tweetnacl loaded');
  }
  
  // Get key and sample
  const keyStr = localStorage.getItem('encryptionKey');
  const keyBytes = new Uint8Array(keyStr.split(',').map(Number));
  
  const db = await new Promise((resolve) => {
    const req = indexedDB.open('venice-db-encrypted', 210);
    req.onsuccess = () => resolve(req.result);
  });
  
  const tx = db.transaction(['messages'], 'readonly');
  const messages = await new Promise((resolve) => {
    const req = tx.objectStore('messages').getAll();
    req.onsuccess = () => resolve(req.result);
  });
  
  const sample = messages[0];
  const encData = sample.__encryptedData;
  const encBytes = new Uint8Array(Object.keys(encData).length);
  for (let i = 0; i < encBytes.length; i++) {
    encBytes[i] = encData[i];
  }
  
  console.log(`\n📊 Testing with ${encBytes.length} byte message...`);
  
  // NaCl secretbox format: nonce (24 bytes) + ciphertext (includes auth tag)
  console.log('\n🔓 Trying NaCl secretbox (24-byte nonce)...');
  
  try {
    const nonce = encBytes.slice(0, 24);
    const ciphertext = encBytes.slice(24);
    
    console.log(`  Nonce: ${Array.from(nonce).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    console.log(`  Ciphertext length: ${ciphertext.length}`);
    
    const decrypted = nacl.secretbox.open(ciphertext, nonce, keyBytes);
    
    if (decrypted) {
      const plaintext = new TextDecoder().decode(decrypted);
      console.log('\n✅ SUCCESS! Venice uses NaCl secretbox (XSalsa20-Poly1305)');
      console.log(`  Decrypted length: ${plaintext.length} chars`);
      console.log(`  Preview: ${plaintext.substring(0, 300)}...`);
      
      // Parse as JSON
      try {
        const parsed = JSON.parse(plaintext);
        console.log('\n📋 Decrypted Structure:');
        console.log('  Keys:', Object.keys(parsed).join(', '));
        window.__veniceDecryptedSample = parsed;
      } catch (e) {
        console.log('  (Not JSON format)');
      }
      
      // Test re-encryption
      console.log('\n🔄 Testing re-encryption...');
      const newNonce = nacl.randomBytes(24);
      const reencrypted = nacl.secretbox(decrypted, newNonce, keyBytes);
      
      // Verify
      const verified = nacl.secretbox.open(reencrypted, newNonce, keyBytes);
      if (verified && new TextDecoder().decode(verified) === plaintext) {
        console.log('✅ Re-encryption successful and verified!');
      }
      
      // Export utilities
      window.__veniceEncryption = {
        format: 'NaCl-secretbox-XSalsa20-Poly1305',
        nonceSize: 24,
        
        decrypt(encryptedData, keyBytes) {
          const data = this.byteObjectToArray(encryptedData);
          const nonce = data.slice(0, 24);
          const ciphertext = data.slice(24);
          const decrypted = nacl.secretbox.open(ciphertext, nonce, keyBytes);
          if (!decrypted) throw new Error('Decryption failed - wrong key or corrupted data');
          return new TextDecoder().decode(decrypted);
        },
        
        encrypt(plaintext, keyBytes) {
          const nonce = nacl.randomBytes(24);
          const encrypted = nacl.secretbox(
            new TextEncoder().encode(plaintext),
            nonce,
            keyBytes
          );
          // Combine: nonce + ciphertext
          const combined = new Uint8Array(nonce.length + encrypted.length);
          combined.set(nonce);
          combined.set(encrypted, nonce.length);
          return this.arrayToByteObject(combined);
        },
        
        reencrypt(encryptedData, oldKeyBytes, newKeyBytes) {
          const plaintext = this.decrypt(encryptedData, oldKeyBytes);
          return this.encrypt(plaintext, newKeyBytes);
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
      
      console.log('\n💡 Utility functions at: window.__veniceEncryption');
      
      // Summary
      console.log('\n' + '='.repeat(50));
      console.log('📋 CONFIRMED ENCRYPTION FORMAT');
      console.log('='.repeat(50));
      console.log(`
Algorithm: XSalsa20-Poly1305 (NaCl secretbox)
Library: tweetnacl
Key Size: 32 bytes
Nonce Size: 24 bytes
Auth Tag: 16 bytes (Poly1305 MAC)

Format:
┌──────────────┬──────────────────────────────────────┐
│ 24 bytes     │ Variable length                       │
│ Nonce        │ Ciphertext + 16-byte Poly1305 tag    │
└──────────────┴──────────────────────────────────────┘

✅ Re-encryption is POSSIBLE!
   Decrypt with old key → Encrypt with new key
      `);
      
    } else {
      console.log('❌ NaCl secretbox decryption returned null (auth failed)');
    }
    
  } catch (e) {
    console.log(`❌ NaCl secretbox failed: ${e.message}`);
    console.log(e);
  }
  
  db.close();
  
})();
