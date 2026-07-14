/**
 * Venice.ai Storage Discovery Script
 * 
 * Run this in the browser DevTools console while on venice.ai
 * to discover how they store chat history.
 * 
 * Usage:
 * 1. Go to https://venice.ai/chat
 * 2. Open DevTools (F12 or Cmd+Option+I)
 * 3. Go to Console tab
 * 4. Paste this entire script and press Enter
 * 5. Wait for the analysis to complete
 * 6. Copy the output for documentation
 */

(async function discoverVeniceStorage() {
  console.log('🔍 Venice.ai Storage Discovery Script\n');
  console.log('='.repeat(50));
  
  const report = {
    timestamp: new Date().toISOString(),
    url: window.location.href,
    localStorage: {},
    sessionStorage: {},
    indexedDB: [],
    cookies: document.cookie ? document.cookie.split(';').length : 0
  };

  // 1. Analyze localStorage
  console.log('\n📦 Analyzing localStorage...');
  const localStorageKeys = Object.keys(localStorage);
  report.localStorage.totalKeys = localStorageKeys.length;
  report.localStorage.totalSize = 0;
  report.localStorage.items = [];
  
  localStorageKeys.forEach(key => {
    const value = localStorage.getItem(key);
    const size = new Blob([value]).size;
    report.localStorage.totalSize += size;
    
    let preview = value;
    if (value.length > 100) {
      preview = value.substring(0, 100) + '...';
    }
    
    // Try to parse as JSON
    let isJSON = false;
    let structure = null;
    try {
      const parsed = JSON.parse(value);
      isJSON = true;
      if (Array.isArray(parsed)) {
        structure = `Array[${parsed.length}]`;
      } else if (typeof parsed === 'object') {
        structure = `Object{${Object.keys(parsed).slice(0, 5).join(', ')}${Object.keys(parsed).length > 5 ? '...' : ''}}`;
      }
    } catch (e) {
      // Not JSON
    }
    
    report.localStorage.items.push({
      key,
      size,
      isJSON,
      structure,
      preview
    });
  });
  
  console.log(`  Found ${localStorageKeys.length} keys, ${(report.localStorage.totalSize / 1024).toFixed(2)} KB total`);

  // 2. Analyze sessionStorage
  console.log('\n📦 Analyzing sessionStorage...');
  const sessionStorageKeys = Object.keys(sessionStorage);
  report.sessionStorage.totalKeys = sessionStorageKeys.length;
  report.sessionStorage.items = [];
  
  sessionStorageKeys.forEach(key => {
    const value = sessionStorage.getItem(key);
    report.sessionStorage.items.push({
      key,
      size: new Blob([value]).size,
      preview: value.substring(0, 100) + (value.length > 100 ? '...' : '')
    });
  });
  
  console.log(`  Found ${sessionStorageKeys.length} keys`);

  // 3. Analyze IndexedDB
  console.log('\n📦 Analyzing IndexedDB...');
  
  try {
    const databases = await indexedDB.databases();
    console.log(`  Found ${databases.length} database(s)`);
    
    for (const dbInfo of databases) {
      console.log(`\n  Analyzing database: ${dbInfo.name} (v${dbInfo.version})`);
      
      const dbReport = {
        name: dbInfo.name,
        version: dbInfo.version,
        objectStores: []
      };
      
      try {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(dbInfo.name);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        
        const storeNames = Array.from(db.objectStoreNames);
        console.log(`    Object stores: ${storeNames.join(', ')}`);
        
        for (const storeName of storeNames) {
          try {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            
            const storeReport = {
              name: storeName,
              keyPath: store.keyPath,
              autoIncrement: store.autoIncrement,
              indexes: Array.from(store.indexNames),
              recordCount: 0,
              sampleRecords: []
            };
            
            // Count records
            const countRequest = store.count();
            const count = await new Promise((resolve, reject) => {
              countRequest.onsuccess = () => resolve(countRequest.result);
              countRequest.onerror = () => reject(countRequest.error);
            });
            storeReport.recordCount = count;
            
            // Get sample records (up to 3)
            const cursorRequest = store.openCursor();
            let sampleCount = 0;
            await new Promise((resolve, reject) => {
              cursorRequest.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor && sampleCount < 3) {
                  const record = cursor.value;
                  // Create a summary of the record structure
                  let recordSummary;
                  if (typeof record === 'object' && record !== null) {
                    recordSummary = {
                      _type: Array.isArray(record) ? 'array' : 'object',
                      _keys: Object.keys(record).slice(0, 10),
                      _preview: JSON.stringify(record).substring(0, 200)
                    };
                  } else {
                    recordSummary = { _type: typeof record, _value: String(record).substring(0, 100) };
                  }
                  storeReport.sampleRecords.push(recordSummary);
                  sampleCount++;
                  cursor.continue();
                } else {
                  resolve();
                }
              };
              cursorRequest.onerror = () => reject(cursorRequest.error);
            });
            
            dbReport.objectStores.push(storeReport);
            console.log(`      ${storeName}: ${count} records`);
            
          } catch (storeError) {
            console.log(`      ${storeName}: Error - ${storeError.message}`);
          }
        }
        
        db.close();
      } catch (dbError) {
        console.log(`    Error opening database: ${dbError.message}`);
        dbReport.error = dbError.message;
      }
      
      report.indexedDB.push(dbReport);
    }
  } catch (idbError) {
    console.log(`  Error listing databases: ${idbError.message}`);
    report.indexedDB.error = idbError.message;
  }

  // 4. Look for specific Venice patterns
  console.log('\n🔎 Looking for Venice-specific patterns...');
  
  const venicePatterns = {
    possibleChatStorage: [],
    possibleUserData: [],
    possibleSettings: []
  };
  
  // Check localStorage for chat-related keys
  localStorageKeys.forEach(key => {
    const keyLower = key.toLowerCase();
    if (keyLower.includes('chat') || keyLower.includes('conversation') || keyLower.includes('message') || keyLower.includes('history')) {
      venicePatterns.possibleChatStorage.push(key);
    }
    if (keyLower.includes('user') || keyLower.includes('profile') || keyLower.includes('account')) {
      venicePatterns.possibleUserData.push(key);
    }
    if (keyLower.includes('setting') || keyLower.includes('config') || keyLower.includes('preference')) {
      venicePatterns.possibleSettings.push(key);
    }
  });
  
  // Check IndexedDB store names
  report.indexedDB.forEach(db => {
    if (db.objectStores) {
      db.objectStores.forEach(store => {
        const nameLower = store.name.toLowerCase();
        if (nameLower.includes('chat') || nameLower.includes('conversation') || nameLower.includes('message')) {
          venicePatterns.possibleChatStorage.push(`IndexedDB: ${db.name}/${store.name}`);
        }
      });
    }
  });
  
  report.venicePatterns = venicePatterns;
  
  console.log(`  Possible chat storage locations: ${venicePatterns.possibleChatStorage.length}`);
  console.log(`  Possible user data locations: ${venicePatterns.possibleUserData.length}`);
  console.log(`  Possible settings locations: ${venicePatterns.possibleSettings.length}`);

  // 5. Output full report
  console.log('\n' + '='.repeat(50));
  console.log('📋 FULL STORAGE REPORT');
  console.log('='.repeat(50));
  console.log('\nCopy this JSON for documentation:\n');
  console.log(JSON.stringify(report, null, 2));
  
  // Also make it available as a global for easier access
  window.__veniceStorageReport = report;
  console.log('\n💡 Report also available as: window.__veniceStorageReport');
  
  // 6. Specific extraction attempt if we find chat data
  if (venicePatterns.possibleChatStorage.length > 0) {
    console.log('\n' + '='.repeat(50));
    console.log('🎯 ATTEMPTING CHAT DATA EXTRACTION');
    console.log('='.repeat(50));
    
    for (const location of venicePatterns.possibleChatStorage) {
      if (location.startsWith('IndexedDB:')) {
        // Already analyzed above
        continue;
      }
      
      // localStorage key
      try {
        const value = localStorage.getItem(location);
        const parsed = JSON.parse(value);
        console.log(`\n${location}:`);
        console.log(`  Type: ${Array.isArray(parsed) ? 'Array' : typeof parsed}`);
        if (Array.isArray(parsed)) {
          console.log(`  Length: ${parsed.length}`);
          if (parsed.length > 0) {
            console.log(`  First item structure: ${JSON.stringify(Object.keys(parsed[0]))}`);
          }
        } else if (typeof parsed === 'object') {
          console.log(`  Keys: ${Object.keys(parsed).slice(0, 10).join(', ')}`);
        }
      } catch (e) {
        console.log(`\n${location}: Could not parse as JSON`);
      }
    }
  }

  console.log('\n✅ Discovery complete!');
  console.log('📝 Please save this output for reference when building the extension.');
  
  return report;
})();
