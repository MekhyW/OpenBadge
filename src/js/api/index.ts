export { API_URL, SOCKET_BASE_URL } from './env';
export { initSession, getDeviceId, getSessionToken } from './session';
export { recordBoop, recordPet, startFlushLoop, stopFlushLoop, flushQueues, fetchTotals } from './counters';
export { connectSocket, disconnectSocket, isSocketConnected, getCountersSocket } from './socket';
export { countersState, onStateChange, notifyStateChange } from './state';
export type { CountersState } from './state';
export { apiLog } from './logger';
export type { ApiLogEntry, LogLevel } from './logger';

import { initSession } from './session';
import { startFlushLoop } from './counters';
import { connectSocket } from './socket';
import { apiLog } from './logger';

const RETRY_DELAYS = [3, 5, 10, 15, 30]; // seconds

function getRetryDelay(attempt: number): number {
    return (RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]) * 1000;
}

/**
 * Bootstrap the full API integration:
 * 1. Init session (device registration + JWT)
 * 2. Connect WebSocket for real-time updates
 * 3. Start periodic flush of pending events
 *
 * Retries on failure with increasing delay.
 */
export async function bootstrapApi(): Promise<void> {
    let attempt = 0;

    const tryInit = async (): Promise<void> => {
        try {
            apiLog.info('bootstrap', attempt === 0 ? 'Initializing API…' : `Retry attempt #${attempt}…`);
            await initSession();
            connectSocket();
            startFlushLoop();
            apiLog.success('bootstrap', 'API ready');
            attempt = 0; // reset on success
        } catch (err) {
            const delay = getRetryDelay(attempt);
            apiLog.error('bootstrap', `Failed (attempt ${attempt + 1}). Retrying in ${delay / 1000}s — ${(err as Error).message}`);
            attempt++;
            setTimeout(() => {
                tryInit().catch(console.error);
            }, delay);
        }
    };

    await tryInit();
}
