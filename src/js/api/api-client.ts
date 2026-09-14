import { CapacitorHttp } from '@capacitor/core';
import { API_URL } from './env';
import { getSessionToken, refreshSession } from './session';
import { apiLog } from './logger';

interface FetchOptions {
    method?: string;
    body?: unknown;
    auth?: boolean;
}

export async function apiRequest<T>(path: string, opts: FetchOptions = {}): Promise<T> {
    const { method = 'GET', body, auth = false } = opts;

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    if (auth) {
        const token = getSessionToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
    }

    apiLog.info('http', `${method} ${path}`);

    let res: { status: number; data: unknown };
    try {
        res = await CapacitorHttp.request({
            url: `${API_URL}${path}`,
            method,
            headers,
            data: body != null ? body : undefined,
        });
    } catch (err) {
        apiLog.error('http', `${method} ${path} — network error: ${(err as Error).message}`);
        throw err;
    }

    if (res.status === 401 && auth) {
        apiLog.warn('http', `${method} ${path} → 401, refreshing session…`);
        await refreshSession();
        const newToken = getSessionToken();
        if (newToken) {
            headers['Authorization'] = `Bearer ${newToken}`;
        }

        const retry = await CapacitorHttp.request({
            url: `${API_URL}${path}`,
            method,
            headers,
            data: body != null ? body : undefined,
        });

        if (retry.status >= 400) {
            apiLog.error('http', `${method} ${path} retry → ${retry.status}`);
            throw new ApiError(retry.status, JSON.stringify(retry.data));
        }
        apiLog.success('http', `${method} ${path} retry → ${retry.status}`);
        return retry.data as T;
    }

    if (res.status >= 400) {
        apiLog.error('http', `${method} ${path} → ${res.status}`);
        throw new ApiError(res.status, JSON.stringify(res.data));
    }

    apiLog.success('http', `${method} ${path} → ${res.status}`);
    return res.data as T;
}

export class ApiError extends Error {
    constructor(public status: number, public body: string) {
        super(`API ${status}: ${body}`);
        this.name = 'ApiError';
    }
}
