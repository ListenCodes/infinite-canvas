export function findCanaryLocations(records, canaries) {
  const locations = [];
  const inspect = (value, location) => {
    if (typeof value === "string") {
      if (canaries.some((canary) => value.includes(canary))) locations.push(location);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => inspect(child, `${location}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, child]) => {
        inspect(key, `${location}.${key}:key`);
        inspect(child, `${location}.${key}`);
      });
    }
  };
  records.forEach((record, index) => inspect(record, `record-${index}`));
  return locations;
}

export function scanBrowserStorage(page, canaries) {
  return page.evaluate(async (expected) => {
    const violations = [];
    const visited = new WeakSet();
    const inspect = async (location, value) => {
      if (typeof value === "string") {
        if (expected.some((canary) => value.includes(canary))) violations.push(location);
        return;
      }
      if (value instanceof Blob) {
        if (value.size <= 20 * 1024 * 1024) await inspect(location, await value.text());
        return;
      }
      if (value instanceof ArrayBuffer) {
        if (value.byteLength <= 20 * 1024 * 1024) await inspect(location, new TextDecoder().decode(value));
        return;
      }
      if (ArrayBuffer.isView(value)) {
        if (value.byteLength <= 20 * 1024 * 1024) {
          await inspect(location, new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
        }
        return;
      }
      if (value instanceof Map) {
        if (visited.has(value)) return;
        visited.add(value);
        let index = 0;
        for (const [key, child] of value.entries()) {
          await inspect(`${location}:map-${index}:key`, key);
          await inspect(`${location}:map-${index}:value`, child);
          index += 1;
        }
        return;
      }
      if (value instanceof Set) {
        if (visited.has(value)) return;
        visited.add(value);
        let index = 0;
        for (const child of value.values()) {
          await inspect(`${location}:set-${index}`, child);
          index += 1;
        }
        return;
      }
      if (value && typeof value === "object") {
        if (visited.has(value)) return;
        visited.add(value);
        let index = 0;
        for (const [key, child] of Object.entries(value)) {
          await inspect(`${location}:property-${index}:key`, key);
          await inspect(`${location}:property-${index}:value`, child);
          index += 1;
        }
        return;
      }
      if (value !== undefined && value !== null) await inspect(location, String(value));
    };
    for (const [storageName, storage] of [["localStorage", localStorage], ["sessionStorage", sessionStorage]]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === null) continue;
        await inspect(`${storageName}:entry-${index}:key`, key);
        await inspect(`${storageName}:entry-${index}:value`, storage.getItem(key));
      }
    }
    if (typeof indexedDB.databases === "function") {
      let databaseIndex = 0;
      for (const entry of await indexedDB.databases()) {
        if (!entry.name) continue;
        const databaseLocation = `indexedDB:database-${databaseIndex}`;
        await inspect(`${databaseLocation}:name`, entry.name);
        const database = await new Promise((resolveOpen, rejectOpen) => {
          const request = indexedDB.open(entry.name);
          request.onsuccess = () => resolveOpen(request.result);
          request.onerror = () => rejectOpen(request.error);
        });
        try {
          let storeIndex = 0;
          for (const storeName of Array.from(database.objectStoreNames)) {
            const storeLocation = `${databaseLocation}:store-${storeIndex}`;
            await inspect(`${storeLocation}:name`, storeName);
            const records = await new Promise((resolveStore, rejectStore) => {
              const values = [];
              const transaction = database.transaction(storeName, "readonly");
              const request = transaction.objectStore(storeName).openCursor();
              request.onerror = () => rejectStore(request.error);
              transaction.onerror = () => rejectStore(transaction.error);
              transaction.oncomplete = () => resolveStore(values);
              request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                values.push({ key: cursor.key, value: cursor.value });
                cursor.continue();
              };
            });
            for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
              const record = records[recordIndex];
              await inspect(`${storeLocation}:record-${recordIndex}:key`, record.key);
              await inspect(`${storeLocation}:record-${recordIndex}:value`, record.value);
            }
            storeIndex += 1;
          }
        } finally {
          database.close();
        }
        databaseIndex += 1;
      }
    }
    return violations;
  }, canaries);
}
