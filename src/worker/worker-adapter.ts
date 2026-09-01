/**
 * zipnative — worker runtime adapter
 * ==================================
 * One handle shape over Node `worker_threads` and the Web Worker API,
 * with a readiness handshake: `spawnWorker` resolves only after the
 * script posts `ready` (or resolves null on any failure — the caller
 * degrades to main-thread compression, never fails).
 *
 * Script URL: `new URL('./zip-worker.js', import.meta.url)` — resolves
 * to the sibling self-contained bundle in dist/, and is the idiom
 * Vite/webpack detect statically for browser builds. `workerUrl`
 * overrides it for bundlers that cannot.
 *
 * @module worker/worker-adapter
 */

import { type WorkerJobRequest, type WorkerResponse } from './worker-protocol.js';

export interface WorkerHandle {
    post(message: WorkerJobRequest, transfer: ArrayBuffer[]): void;
    onMessage(handler: (message: WorkerResponse) => void): void;
    onError(handler: (error: Error) => void): void;
    terminate(): void;
}

const READY_TIMEOUT_MS = 5000;

/** Worker count default: leave one core for the main thread, cap at 8. */
export function defaultConcurrency(): number {
    const g = globalThis as Record<string, unknown>;
    const nav = g['navigator'] as { hardwareConcurrency?: number } | undefined;
    let cores = nav?.hardwareConcurrency ?? 0;
    if (cores === 0) {
        const proc = g['process'] as { versions?: { node?: string } } | undefined;
        if (proc?.versions?.node) cores = 4; // refined below when os is importable
    }
    return Math.max(1, Math.min((cores || 2) - 1, 8));
}

async function nodeConcurrency(): Promise<number | null> {
    const g = globalThis as Record<string, unknown>;
    const proc = g['process'] as { versions?: { node?: string } } | undefined;
    if (!proc?.versions?.node) return null;
    try {
        const modName = 'node:os';
        const os = await (import(modName) as Promise<Record<string, unknown>>);
        const fn = os['availableParallelism'] as (() => number) | undefined;
        return typeof fn === 'function' ? fn() : null;
    } catch {
        return null;
    }
}

/** Best-effort core count (async because Node's lives in node:os). */
export async function detectConcurrency(): Promise<number> {
    const node = await nodeConcurrency();
    if (node !== null) return Math.max(1, Math.min(node - 1, 8));
    return defaultConcurrency();
}

function defaultWorkerUrl(): URL {
    return new URL('./zip-worker.js', import.meta.url);
}

/**
 * Spawn one worker and await its `ready` handshake. Returns null on ANY
 * failure (no worker support, missing script, CSP, handshake timeout) —
 * parallelism is a progressive enhancement, never a requirement.
 */
export async function spawnWorker(workerUrl?: string | URL): Promise<WorkerHandle | null> {
    const url = workerUrl ?? defaultWorkerUrl();
    const g = globalThis as Record<string, unknown>;
    const proc = g['process'] as { versions?: { node?: string } } | undefined;

    try {
        let handle: WorkerHandle;
        if (proc?.versions?.node) {
            const modName = 'node:worker_threads';
            const wt = await (import(modName) as Promise<Record<string, unknown>>);
            const NodeWorker = wt['Worker'] as new (url: URL | string) => {
                postMessage(value: unknown, transferList?: ArrayBuffer[]): void;
                on(event: string, handler: (value: unknown) => void): void;
                terminate(): Promise<number>;
                unref(): void;
            };
            const worker = new NodeWorker(url);
            worker.unref(); // never keep the process alive on our account
            handle = {
                post: (message, transfer) => worker.postMessage(message, transfer),
                onMessage: (handler) => worker.on('message', (value) => handler(value as WorkerResponse)),
                onError: (handler) => {
                    worker.on('error', (err) => handler(err instanceof Error ? err : new Error(String(err))));
                    worker.on('exit', (code) => {
                        if (code !== 0) handler(new Error(`worker exited with code ${String(code)}`));
                    });
                },
                terminate: () => void worker.terminate(),
            };
        } else if (typeof g['Worker'] === 'function') {
            const WebWorker = g['Worker'] as new (url: URL | string, options?: { type: 'module' }) => {
                postMessage(message: unknown, transfer: ArrayBuffer[]): void;
                onmessage: ((event: { data: unknown }) => void) | null;
                onerror: ((event: { message?: string }) => void) | null;
                terminate(): void;
            };
            const worker = new WebWorker(url, { type: 'module' });
            handle = {
                post: (message, transfer) => worker.postMessage(message, transfer),
                onMessage: (handler) => {
                    worker.onmessage = (event) => handler(event.data as WorkerResponse);
                },
                onError: (handler) => {
                    worker.onerror = (event) => handler(new Error(event.message ?? 'worker error'));
                },
                terminate: () => worker.terminate(),
            };
        } else {
            return null;
        }

        // Readiness handshake: dispatch is gated on the script's `ready`.
        const ready = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
            handle.onMessage((message) => {
                if (message.type === 'ready') {
                    clearTimeout(timer);
                    resolve(true);
                }
            });
            handle.onError(() => {
                clearTimeout(timer);
                resolve(false);
            });
        });
        if (!ready) {
            handle.terminate();
            return null;
        }
        return handle;
    } catch {
        return null;
    }
}
