import { CapacitorHttp } from '@capacitor/core';
import { API_URL } from './env';
import { countersState, notifyStateChange } from './state';
import { apiLog } from './logger';

const DEVICE_ID_KEY = 'nick_device_id';

interface SessionInitResponse {
    session_token: string;
    expires_in: number;
    total_boops: number;
    total_pets: number;
}

function generateUUID(): string {
    return crypto.randomUUID();
}

export function getDeviceId(): string {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
        id = generateUUID();
        localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
}

let sessionToken: string | null = null;
let tokenExpiresAt: number = 0;

export function getSessionToken(): string | null {
    if (sessionToken && Date.now() < tokenExpiresAt) {
        return sessionToken;
    }
    return sessionToken; // let the API client handle the 401
}

export function isTokenExpired(): boolean {
    return !sessionToken || Date.now() >= tokenExpiresAt;
}

export async function initSession(): Promise<SessionInitResponse> {
    const deviceId = getDeviceId();

    apiLog.info('session', 'POST /session/init');

    let res: { status: number; data: unknown };
    try {
        res = await CapacitorHttp.request({
            url: `${API_URL}/session/init`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: { device_id: deviceId },
        });
    } catch (err) {
        apiLog.error('session', `Network error: ${(err as Error).message}`);
        throw err;
    }

    if (res.status >= 400) {
        apiLog.error('session', `Init failed: ${res.status}`);
        throw new Error(`Session init failed: ${res.status}`);
    }

    const data = res.data as SessionInitResponse;

    sessionToken = data.session_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;

    // Update global state with initial totals
    countersState.totalBoops = data.total_boops;
    countersState.totalPets = data.total_pets;
    notifyStateChange();

    apiLog.success('session', `Session OK — boops=${data.total_boops} pets=${data.total_pets} expires_in=${data.expires_in}s`);
    return data;
}

export async function refreshSession(): Promise<void> {
    apiLog.info('session', 'Refreshing session…');
    await initSession();
}
