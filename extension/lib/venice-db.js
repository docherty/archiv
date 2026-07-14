/**
 * Venice IndexedDB Access Module
 * 
 * Provides read/write access to Venice's encrypted IndexedDB.
 * Database: venice-db-encrypted, version discovered at runtime
 * 
 * Object Stores:
 * - conversations (encrypted)
 * - messages (encrypted)
 * - messageIds
 * - messageImages
 * - folders (encrypted)
 * - settings (encrypted)
 * - _encryptionSettings
 */

const DB_NAME = 'venice-db-encrypted';
let detectedDBVersion = null;

async function getExistingDBVersion() {
  if (Number.isInteger(detectedDBVersion) && detectedDBVersion > 0) {
    return detectedDBVersion;
  }

  if (typeof indexedDB.databases !== 'function') {
    return null;
  }

  const databases = await indexedDB.databases();
  const match = databases.find((database) => database.name === DB_NAME);

  if (!match?.version) {
    throw new Error('Venice database not found. Open Venice.ai and wait for chats to load before accessing history.');
  }

  detectedDBVersion = match.version;
  return detectedDBVersion;
}

function openDBWithVersion(version) {
  return new Promise((resolve, reject) => {
    let request;

    try {
      request = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    } catch (error) {
      reject(error);
      return;
    }

    request.onsuccess = () => {
      detectedDBVersion = request.result.version;
      resolve(request.result);
    };

    request.onerror = () => {
      if (request.error?.name === 'VersionError') {
        detectedDBVersion = null;
      }
      reject(request.error);
    };

    request.onupgradeneeded = () => {
      request.transaction?.abort();
      detectedDBVersion = null;
      reject(new Error('Venice database is not ready yet. Reload Venice.ai and try again.'));
    };
  });
}

export const VeniceDB = {
  /**
   * Open the Venice database
   * @returns {Promise<IDBDatabase>}
   */
  async open() {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const version = await getExistingDBVersion();
        return await openDBWithVersion(version);
      } catch (error) {
        lastError = error;

        if (error?.name === 'VersionError' && attempt === 0) {
          detectedDBVersion = null;
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('Failed to open Venice database');
  },
  
  /**
   * Get all records from a store
   * @param {string} storeName
   * @returns {Promise<Array>}
   */
  async getAll(storeName) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  },
  
  /**
   * Get a single record by key
   * @param {string} storeName
   * @param {string} key
   * @returns {Promise<any>}
   */
  async get(storeName, key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  },
  
  /**
   * Put a record into a store
   * @param {string} storeName
   * @param {any} value
   * @param {string} [key] - Optional key if store doesn't use in-line keys
   * @returns {Promise<void>}
   */
  async put(storeName, value, key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      const request = key ? store.put(value, key) : store.put(value);
      request.onsuccess = () => {
        db.close();
        resolve();
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  },
  
  /**
   * Delete a record from a store
   * @param {string} storeName
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(storeName, key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.delete(key);
      request.onsuccess = () => {
        db.close();
        resolve();
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  },
  
  /**
   * Get the current encryption key from localStorage
   * @returns {string|null} Comma-separated byte string or null
   */
  getCurrentKeyString() {
    return localStorage.getItem('encryptionKey');
  },
  
  /**
   * Get all conversations (encrypted)
   * @returns {Promise<Array>}
   */
  async getConversations() {
    return this.getAll('conversations');
  },
  
  /**
   * Get all messages (encrypted)
   * @returns {Promise<Array>}
   */
  async getMessages() {
    return this.getAll('messages');
  },
  
  /**
   * Get messages for a specific conversation
   * @param {string} conversationId
   * @returns {Promise<Array>}
   */
  async getMessagesForConversation(conversationId) {
    const allMessages = await this.getMessages();
    // Messages have conversationId in their decrypted content
    // For now return all - filtering requires decryption
    return allMessages;
  },
  
  /**
   * Get encryption settings
   * @returns {Promise<Array>}
   */
  async getEncryptionSettings() {
    return this.getAll('_encryptionSettings');
  }
};
