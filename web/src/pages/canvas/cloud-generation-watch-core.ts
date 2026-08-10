import { newerEventCursor } from "../../services/api/cloud-event-stream.ts";

interface Scheduler {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

const defaultScheduler: Scheduler = {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const CLOUD_GENERATION_CURSOR_SCAN_MS = 5_000;

function abortError(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export class CloudGenerationWakeChannel {
    #wake: (() => void) | undefined;
    readonly #scheduler: Scheduler;

    constructor(scheduler: Scheduler = defaultScheduler) {
        this.#scheduler = scheduler;
    }

    notify(): void {
        this.#wake?.();
    }

    wait(delayMs: number, signal: AbortSignal): Promise<void> {
        if (signal.aborted) return Promise.reject(abortError(signal));
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (callback: () => void) => {
                if (settled) return;
                settled = true;
                this.#scheduler.clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                if (this.#wake === onWake) this.#wake = undefined;
                callback();
            };
            const onWake = () => finish(resolve);
            const onAbort = () => finish(() => reject(abortError(signal)));
            const timer = this.#scheduler.setTimeout(onWake, delayMs);
            this.#wake = onWake;
            signal.addEventListener("abort", onAbort, { once: true });
        });
    }
}

export class ActiveGenerationWatchRegistry {
    #active = new Map<string, { signal: AbortSignal; token: symbol }>();

    acquire(key: string, signal: AbortSignal): (() => void) | null {
        const current = this.#active.get(key);
        if (current && !current.signal.aborted) return null;
        const token = Symbol(key);
        this.#active.set(key, { signal, token });
        return () => {
            if (this.#active.get(key)?.token === token) this.#active.delete(key);
        };
    }
}

export async function runCloudGenerationEventPump(options: {
    signal: AbortSignal;
    initialCursor?: string;
    reconnectDelayMs?: number;
    loadSnapshot: (signal: AbortSignal) => Promise<{ projectId: string; eventCursor: string }>;
    subscribe: (options: {
        projectId: string;
        cursor: string;
        signal: AbortSignal;
        onEventSequence: (sequence: string) => void;
    }) => Promise<void>;
    onEvent: () => void;
    waitForReconnect?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
    let cursor = options.initialCursor ?? "0";
    const waitForReconnect = options.waitForReconnect ?? ((delayMs, signal) => new CloudGenerationWakeChannel().wait(delayMs, signal));
    while (!options.signal.aborted) {
        try {
            const snapshot = await options.loadSnapshot(options.signal);
            cursor = newerEventCursor(cursor, snapshot.eventCursor);
            await options.subscribe({
                projectId: snapshot.projectId,
                cursor,
                signal: options.signal,
                onEventSequence: (sequence) => {
                    cursor = newerEventCursor(cursor, sequence);
                    options.onEvent();
                },
            });
        } catch {
            if (options.signal.aborted) return;
        }
        if (options.signal.aborted) return;
        try {
            await waitForReconnect(options.reconnectDelayMs ?? 1_500, options.signal);
        } catch {
            if (options.signal.aborted) return;
            throw new Error("Generation event reconnect delay failed");
        }
    }
}

export function waitForCloudGenerationCursorScan(channel: CloudGenerationWakeChannel, signal: AbortSignal): Promise<void> {
    return channel.wait(CLOUD_GENERATION_CURSOR_SCAN_MS, signal);
}
