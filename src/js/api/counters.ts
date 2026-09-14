import { apiRequest, ApiError } from './api-client';
import { getDeviceId } from './session';
import { countersState, notifyStateChange } from './state';
import { apiLog } from './logger';

const MAX_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 2000;
const RATE_LIMIT_PAUSE_MS = 1500;

interface SubmitResponse {
    accepted: number;
    rejected: number;
    total_boops: number;
    total_pets: number;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushLoopActive = false;
let rateLimitedUntil = 0;

function hasPendingEvents(): boolean {
    return countersState.pendingBoops.length > 0 || countersState.pendingPets.length > 0;
}

/**
 * Schedule the next flush only while there is something to send. An app that
 * stays open for hours must not run a periodic timer with empty queues — the
 * constant wakeups prevent the CPU from idling.
 */
function scheduleFlush(): void {
    if (!flushLoopActive || flushTimer || !hasPendingEvents()) return;

    const delay = Math.max(FLUSH_INTERVAL_MS, rateLimitedUntil - Date.now());
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushQueues()
            .catch(console.error)
            .finally(() => scheduleFlush());
    }, delay);
}

export function recordBoop(): void {
    countersState.pendingBoops.push(Date.now());
    notifyStateChange();
    scheduleFlush();
}

export function recordPet(): void {
    countersState.pendingPets.push(Date.now());
    notifyStateChange();
    scheduleFlush();
}

async function submitBoops(timestamps: number[]): Promise<void> {
    const deviceId = getDeviceId();
    apiLog.info('boops', `Submitting ${timestamps.length} boops`);
    try {
        const data = await apiRequest<SubmitResponse>('/boops/submit', {
            method: 'POST',
            auth: true,
            body: { device_id: deviceId, boops: timestamps },
        });
        countersState.totalBoops = data.total_boops;
        countersState.totalPets = data.total_pets;
        notifyStateChange();
        apiLog.success('boops', `Accepted ${data.accepted}, rejected ${data.rejected}`);
    } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
            handleRateLimit(err.body);
            countersState.pendingBoops.unshift(...timestamps);
            return;
        }
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
            apiLog.warn('boops', `Batch rejected: ${err.body}`);
            return;
        }
        apiLog.error('boops', `Submit failed, re-queuing: ${(err as Error).message}`);
        countersState.pendingBoops.unshift(...timestamps);
    }
}

async function submitPets(timestamps: number[]): Promise<void> {
    const deviceId = getDeviceId();
    apiLog.info('pets', `Submitting ${timestamps.length} pets`);
    try {
        const data = await apiRequest<SubmitResponse>('/pets/submit', {
            method: 'POST',
            auth: true,
            body: { device_id: deviceId, pets: timestamps },
        });
        countersState.totalBoops = data.total_boops;
        countersState.totalPets = data.total_pets;
        notifyStateChange();
        apiLog.success('pets', `Accepted ${data.accepted}, rejected ${data.rejected}`);
    } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
            handleRateLimit(err.body);
            countersState.pendingPets.unshift(...timestamps);
            return;
        }
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
            apiLog.warn('pets', `Batch rejected: ${err.body}`);
            return;
        }
        apiLog.error('pets', `Submit failed, re-queuing: ${(err as Error).message}`);
        countersState.pendingPets.unshift(...timestamps);
    }
}

function handleRateLimit(body: string): void {
    let retryAfter = RATE_LIMIT_PAUSE_MS;
    try {
        const parsed = JSON.parse(body);
        if (parsed.retry_after) retryAfter = parsed.retry_after;
    } catch { /* use default */ }
    rateLimitedUntil = Date.now() + retryAfter;
    apiLog.warn('rate-limit', `Pausing sends for ${retryAfter}ms`);
}

export async function flushQueues(): Promise<void> {
    if (Date.now() < rateLimitedUntil) return;

    // Flush boops
    if (countersState.pendingBoops.length > 0) {
        const batch = countersState.pendingBoops.splice(0, MAX_BATCH_SIZE);
        await submitBoops(batch);
    }

    // Flush pets
    if (countersState.pendingPets.length > 0) {
        const batch = countersState.pendingPets.splice(0, MAX_BATCH_SIZE);
        await submitPets(batch);
    }
}

export function startFlushLoop(): void {
    flushLoopActive = true;
    scheduleFlush();
}

export function stopFlushLoop(): void {
    flushLoopActive = false;
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
}

export async function fetchTotals(): Promise<void> {
    try {
        const data = await apiRequest<{
            total_boops: number;
            total_pets: number;
            last_snapshot_at: string | null;
        }>('/boops/total');
        countersState.totalBoops = data.total_boops;
        countersState.totalPets = data.total_pets;
        notifyStateChange();
    } catch (err) {
        console.warn('[counters] failed to fetch totals:', err);
    }
}
