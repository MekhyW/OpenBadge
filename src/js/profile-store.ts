import type { AnimationConfig } from './types';

export interface LocalProfile {
  title: string;
  shareUrl: string;
  avatarName: string;
  animationSources: Record<string, string>;
  /** Original file names of uploaded videos, keyed by their `local:` source. */
  mediaNames: Record<string, string>;
  motionEnabled: boolean;
  dayNightEnabled: boolean;
  animationConfig?: AnimationConfig;
}

const DB_NAME = 'openbadge-local';
const DB_VERSION = 1;
const PROFILE_KEY = 'profile';

export const defaultProfile: LocalProfile = {
  title: 'OpenBadge',
  shareUrl: 'https://example.com',
  avatarName: 'Nick',
  animationSources: {},
  mediaNames: {},
  motionEnabled: false,
  dayNightEnabled: false,
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeRequest<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = run(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function loadProfile(): Promise<LocalProfile> {
  const saved = await storeRequest<LocalProfile | undefined>('settings', 'readonly', (store) => store.get(PROFILE_KEY));
  return { ...structuredClone(defaultProfile), ...saved };
}

export async function saveProfile(profile: LocalProfile): Promise<void> {
  await storeRequest<IDBValidKey>('settings', 'readwrite', (store) => store.put(profile, PROFILE_KEY));
}

export async function saveMedia(id: string, blob: Blob): Promise<void> {
  await storeRequest<IDBValidKey>('media', 'readwrite', (store) => store.put(blob, id));
}

export async function loadMedia(id: string): Promise<Blob | undefined> {
  return storeRequest<Blob | undefined>('media', 'readonly', (store) => store.get(id));
}
