/**
 * zipnative — DOS date/time conversion
 * ====================================
 * ZIP headers carry MS-DOS timestamps: wall-clock time with no zone,
 * 2-second resolution, epoch 1980-01-01, ceiling 2107-12-31 23:59:58.
 * Layout:
 *   date: day 0–4 | month 5–8 | year−1980 9–15
 *   time: sec/2 0–4 | minute 5–10 | hour 11–15
 *
 * Which wall-clock a `Date` is read with is the caller's choice
 * (`DosTimeMode`, issue #9): `'local'` — the host's zone, the convention
 * of Info-ZIP, 7-Zip and Explorer, and the 1.0.0 behaviour, so one
 * instant encodes differently in Paris and in Tokyo; `'utc'` — the same
 * fields on every host, the reproducible choice. Both directions take the
 * same mode so a writer's own archives read back without a shift.
 *
 * @module core/zip-dos-time
 */

import type { DosTimeMode } from '../types/zip-types.js';

/** The DOS epoch — zipnative's deterministic default timestamp (M2+). */
export const DETERMINISTIC_DOS_DATE = 0x0021; // 1980-01-01
export const DETERMINISTIC_DOS_TIME = 0x0000; // 00:00:00

/** The last representable instant: 2107-12-31 23:59:58. */
export const MAX_DOS_DATE = 0xff9f;
export const MAX_DOS_TIME = 0xbf7d;

/** Why `dateToDosDateTime` could not encode the Date as given. */
export type DosClampReason = 'invalid' | 'before-1980' | 'after-2107';

export interface DosDateTime {
    readonly dosDate: number;
    readonly dosTime: number;
    /** Set when the fields are a clamp, not the Date (the caller diagnoses it). */
    readonly clamped: DosClampReason | null;
}

/**
 * Convert a DOS date/time pair to a `Date` — in the host's local zone by
 * default (the DOS convention; ZIP stores no timezone), or as UTC fields
 * with `mode: 'utc'`.
 */
export function dosDateTimeToDate(dosDate: number, dosTime: number, mode: DosTimeMode = 'local'): Date {
    const day = dosDate & 0x1f;
    const month = (dosDate >>> 5) & 0x0f;
    const year = ((dosDate >>> 9) & 0x7f) + 1980;
    const seconds = (dosTime & 0x1f) * 2;
    const minutes = (dosTime >>> 5) & 0x3f;
    const hours = (dosTime >>> 11) & 0x1f;
    // Clamp nonsense fields (day/month 0 appear in the wild) rather than
    // letting Date roll them into a different month.
    const m = Math.max(0, month - 1);
    const d = Math.max(1, day);
    return mode === 'utc'
        ? new Date(Date.UTC(year, m, d, hours, minutes, seconds))
        : new Date(year, m, d, hours, minutes, seconds);
}

/**
 * Convert a `Date` to a DOS date/time pair (seconds floored to even — the
 * deterministic write-path conversion, M2+), reading the Date's fields in
 * the host's zone (`'local'`, default) or in UTC.
 *
 * Out-of-range input is clamped like Info-ZIP's `dostime()`: anything
 * before 1980-01-01 becomes the DOS epoch, anything after
 * 2107-12-31 23:59:58 becomes that maximum, and an invalid Date becomes the
 * epoch — never a refusal, and never a fictitious in-range date (1.0.0
 * clamped the year alone, so 1975-07-15 encoded as 1980-07-15). The
 * `clamped` field tells the caller, which emits `ZIP_TIMESTAMP_CLAMPED`.
 */
export function dateToDosDateTime(date: Date, mode: DosTimeMode = 'local'): DosDateTime {
    const ms = date.getTime();
    if (Number.isNaN(ms)) {
        return { dosDate: DETERMINISTIC_DOS_DATE, dosTime: DETERMINISTIC_DOS_TIME, clamped: 'invalid' };
    }
    const utc = mode === 'utc';
    const year = utc ? date.getUTCFullYear() : date.getFullYear();
    if (year < 1980) {
        return { dosDate: DETERMINISTIC_DOS_DATE, dosTime: DETERMINISTIC_DOS_TIME, clamped: 'before-1980' };
    }
    if (year > 2107) {
        return { dosDate: MAX_DOS_DATE, dosTime: MAX_DOS_TIME, clamped: 'after-2107' };
    }
    const month = utc ? date.getUTCMonth() : date.getMonth();
    const day = utc ? date.getUTCDate() : date.getDate();
    const hours = utc ? date.getUTCHours() : date.getHours();
    const minutes = utc ? date.getUTCMinutes() : date.getMinutes();
    const seconds = utc ? date.getUTCSeconds() : date.getSeconds();
    const dosDate = ((year - 1980) << 9) | ((month + 1) << 5) | day;
    const dosTime = (hours << 11) | (minutes << 5) | (seconds >>> 1);
    return { dosDate, dosTime, clamped: null };
}
