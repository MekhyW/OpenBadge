export interface CountersState {
    totalBoops: number;
    totalPets: number;
    isSocketConnected: boolean;
    lastSocketUpdateAt: string | null;
    socketError: string | null;
    pendingBoops: number[];
    pendingPets: number[];
}

export const countersState: CountersState = {
    totalBoops: 0,
    totalPets: 0,
    isSocketConnected: false,
    lastSocketUpdateAt: null,
    socketError: null,
    pendingBoops: [],
    pendingPets: [],
};

type StateListener = (state: CountersState) => void;

const listeners: StateListener[] = [];

export function onStateChange(listener: StateListener): () => void {
    listeners.push(listener);
    return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
    };
}

export function notifyStateChange(): void {
    for (const fn of listeners) {
        fn(countersState);
    }
}
