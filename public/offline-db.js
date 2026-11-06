/* NextGen Smart Classroom — IndexedDB offline queue and record cache */
const DB_NAME = 'ngsc-offline';
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('queue')) {
        const q = db.createObjectStore('queue', { keyPath: 'id' });
        q.createIndex('status', 'status');
        q.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('records')) {
        db.createObjectStore('records', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const OfflineDB = {
  async getDeviceId() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const req = store.get('deviceId');
      req.onsuccess = () => {
        if (req.result && req.result.value) {
          resolve(req.result.value);
        } else {
          const id = 'dev-' + crypto.randomUUID();
          store.put({ key: 'deviceId', value: id });
          tx.oncomplete = () => resolve(id);
        }
      };
      req.onerror = () => reject(req.error);
    });
  },

  async addQueueItem(item) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').put(item);
      tx.oncomplete = () => resolve(item);
      tx.onerror = () => reject(tx.error);
    });
  },

  async getQueue() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readonly');
      const req = tx.objectStore('queue').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async updateQueueItem(item) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').put(item);
      tx.oncomplete = () => resolve(item);
      tx.onerror = () => reject(tx.error);
    });
  },

  async removeQueueItem(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async cacheRecords(records) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
      store.clear();
      for (const r of records) store.put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async getCachedRecords() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readonly');
      const req = tx.objectStore('records').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async exportPending() {
    const items = await this.getQueue();
    return items.filter(i => i.status === 'pending' || i.status === 'failed' || i.status === 'conflict');
  },

  async clearQueue() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async clearCachedRecords() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      tx.objectStore('records').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async getDataGeneration() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('dataGeneration');
      req.onsuccess = () => {
        const v = req.result && req.result.value;
        const n = parseInt(String(v), 10);
        resolve(Number.isFinite(n) && n > 0 ? n : 1);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async setDataGeneration(gen) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key: 'dataGeneration', value: String(gen) });
      tx.oncomplete = () => resolve(gen);
      tx.onerror = () => reject(tx.error);
    });
  }
};

window.OfflineDB = OfflineDB;
