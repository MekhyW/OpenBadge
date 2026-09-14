export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface ApiLogEntry {
    timestamp: number;
    level: LogLevel;
    tag: string;
    message: string;
}

const MAX_ENTRIES = 100;
const entries: ApiLogEntry[] = [];

type LogListener = (entries: readonly ApiLogEntry[]) => void;
const listeners: LogListener[] = [];

function push(level: LogLevel, tag: string, message: string): void {
    entries.push({ timestamp: Date.now(), level, tag, message });
    if (entries.length > MAX_ENTRIES) entries.shift();
    for (const fn of listeners) fn(entries);
}

export const apiLog = {
    info: (tag: string, msg: string) => push('info', tag, msg),
    warn: (tag: string, msg: string) => push('warn', tag, msg),
    error: (tag: string, msg: string) => push('error', tag, msg),
    success: (tag: string, msg: string) => push('success', tag, msg),
    getEntries: (): readonly ApiLogEntry[] => entries,
    onUpdate: (fn: LogListener): (() => void) => {
        listeners.push(fn);
        return () => {
            const idx = listeners.indexOf(fn);
            if (idx >= 0) listeners.splice(idx, 1);
        };
    },
};
