import { io, Socket } from 'socket.io-client';
import { SOCKET_BASE_URL } from './env';
import { countersState, notifyStateChange } from './state';
import { apiLog } from './logger';

export interface CountersUpdatePayload {
    total_boops: number;
    total_pets: number;
    timestamp: string;
}

let socketInstance: Socket | null = null;
let listeners: Set<() => void> = new Set();

/**
 * Gets or creates a singleton Socket.IO instance.
 * Does NOT auto-connect (use connectSocket() to do so).
 */
export function getCountersSocket(): Socket {
    if (socketInstance) return socketInstance;

    apiLog.info('socket', `Creating socket instance for ${SOCKET_BASE_URL}/counters`);

    socketInstance = io(`${SOCKET_BASE_URL}/counters`, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        // Long max backoff: with an unreachable server, retrying every 5s
        // would wake the radio ~720×/h for the whole (hours-long) session.
        reconnectionDelayMax: 30000,
        randomizationFactor: 0.5,
        timeout: 20000,
        autoConnect: false, // Manual connect only
    });

    return socketInstance;
}

/**
 * Connects to the Socket.IO server and sets up event handlers.
 * Returns an unsubscribe function to remove all listeners.
 */
export function connectSocket(): () => void {
    const socket = getCountersSocket();

    // Drop any previously attached handlers so repeated connects (visibility
    // changes, bootstrap retries) never stack duplicate listeners.
    unsubscribeAll();

    if (!socket.connected) {
        apiLog.info('socket', 'Connecting to /counters…');
    }

    const handleConnect = () => {
        apiLog.success('socket', 'Connected to /counters');
        countersState.isSocketConnected = true;
        countersState.socketError = null;
        notifyStateChange();
    };

    const handleDisconnect = (reason: string) => {
        apiLog.warn('socket', `Disconnected: ${reason}`);
        countersState.isSocketConnected = false;
        notifyStateChange();
    };

    const handleConnectError = (error: Error) => {
        const errMsg = error?.message || 'Unknown error';
        apiLog.error('socket', `Connection error: ${errMsg}`);
        countersState.isSocketConnected = false;
        countersState.socketError = errMsg;
        notifyStateChange();
    };

    const handleReconnectAttempt = (attempt: number) => {
        apiLog.info('socket', `Reconnect attempt #${attempt}…`);
    };

    const handleReconnect = () => {
        apiLog.success('socket', 'Reconnected to /counters');
        countersState.isSocketConnected = true;
        countersState.socketError = null;
        notifyStateChange();
    };

    const handleReconnectFailed = () => {
        apiLog.error('socket', 'Reconnection failed after all attempts');
        countersState.isSocketConnected = false;
        countersState.socketError = 'Reconnection failed';
        notifyStateChange();
    };

    const handleCountersUpdate = (payload: CountersUpdatePayload) => {
        apiLog.success('socket', `counters:update — boops=${payload.total_boops} pets=${payload.total_pets}`);
        countersState.totalBoops = payload.total_boops;
        countersState.totalPets = payload.total_pets;
        countersState.lastSocketUpdateAt = payload.timestamp;
        countersState.socketError = null;
        notifyStateChange();
    };

    // Attach listeners
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.io.on('reconnect_attempt', handleReconnectAttempt);
    socket.io.on('reconnect', handleReconnect);
    socket.io.on('reconnect_failed', handleReconnectFailed);
    socket.on('counters:update', handleCountersUpdate);

    // Store unsubscribe handlers
    const unsubscribe = () => {
        socket.off('connect', handleConnect);
        socket.off('disconnect', handleDisconnect);
        socket.off('connect_error', handleConnectError);
        socket.io.off('reconnect_attempt', handleReconnectAttempt);
        socket.io.off('reconnect', handleReconnect);
        socket.io.off('reconnect_failed', handleReconnectFailed);
        socket.off('counters:update', handleCountersUpdate);
    };
    listeners.add(unsubscribe);

    if (!socket.connected) {
        socket.connect();
    } else {
        // Handlers were re-attached on a live connection — just sync state
        countersState.isSocketConnected = true;
        notifyStateChange();
    }

    return unsubscribe;
}

/**
 * Disconnects the Socket.IO instance and cleans up.
 */
export function disconnectSocket(): void {
    unsubscribeAll();

    if (socketInstance) {
        apiLog.info('socket', 'Disconnecting from /counters');
        socketInstance.disconnect();
        socketInstance = null;
        countersState.isSocketConnected = false;
        countersState.socketError = null;
        notifyStateChange();
    }
}

/**
 * Removes all event listeners without disconnecting.
 */
function unsubscribeAll(): void {
    listeners.forEach((unsubscribe) => unsubscribe());
    listeners.clear();
}

/**
 * Returns whether the socket is currently connected.
 */
export function isSocketConnected(): boolean {
    return socketInstance?.connected ?? false;
}

/**
 * Returns the current socket instance (for advanced use cases).
 * WARNING: Only use this if you need direct socket access. Prefer connectSocket() and disconnectSocket().
 */
export function getSocket(): Socket | null {
    return socketInstance;
}
