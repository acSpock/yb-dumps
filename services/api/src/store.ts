import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { StoredInstagramConnection } from './contracts.js';

type StoreShape = {
  connectionsByDeviceSessionId: Record<string, StoredInstagramConnection>;
};

export type InstagramStore = {
  clearConnection: (deviceSessionId: string) => Promise<void>;
  getConnection: (deviceSessionId: string) => Promise<StoredInstagramConnection | undefined>;
  saveConnection: (deviceSessionId: string, connection: StoredInstagramConnection) => Promise<void>;
};

const defaultStore: StoreShape = {
  connectionsByDeviceSessionId: {},
};

export function createFileStore(storePath = path.resolve(process.cwd(), 'data', 'instagram-store.json')): InstagramStore {
  async function readStore(): Promise<StoreShape> {
    try {
      const raw = await readFile(storePath, 'utf8');
      return JSON.parse(raw) as StoreShape;
    } catch {
      return defaultStore;
    }
  }

  async function writeStore(store: StoreShape) {
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`);
  }

  return {
    async clearConnection(deviceSessionId) {
      const store = await readStore();
      delete store.connectionsByDeviceSessionId[deviceSessionId];
      await writeStore(store);
    },

    async getConnection(deviceSessionId) {
      const store = await readStore();
      return store.connectionsByDeviceSessionId[deviceSessionId];
    },

    async saveConnection(deviceSessionId, connection) {
      const store = await readStore();
      store.connectionsByDeviceSessionId[deviceSessionId] = connection;
      await writeStore(store);
    },
  };
}
