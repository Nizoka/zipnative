/**
 * zipnative — DOS date/time conversion
 * ====================================
 * ZIP headers carry MS-DOS timestamps: local time, 2-second resolution,
 * epoch 1980-01-01. Layout:
 *   date: day 0–4 | month 5–8 | year−1980 9–15
 *   time: sec/2 0–4 | minute 5–10 | hour 11–15
 *
 * @module core/zip-dos-time
 */

/** The DOS epoch — zipnative's deterministic default timestamp (M2+). */
export const DETERMINISTIC_DOS_DATE = 0x0021; // 1980-01-01
export const DETERMINISTIC_DOS_TIME = 0x0000; // 00:00:00

/**
 * Convert a DOS date/time pair to a `Date` (interpreted as local time —
 * the DOS convention; ZIP stores no timezone).
 */
export function dosDateTimeToDate(dosDate: number, dosTime: number): Date {
    const day = dosDate & 0x1f;
    const month = (dosDate >>> 5) & 0x0f;
    const year = ((dosDate >>> 9) & 0x7f) + 1980;
    const seconds = (dosTime & 0x1f) * 2;
    const minutes = (dosTime >>> 5) & 0x3f;
    const hours = (dosTime >>> 11) & 0x1f;
    // Clamp nonsense fields (day/month 0 appear in the wild) rather than
    // letting Date roll them into a different month.
    return new Date(year, Math.max(0, month - 1), Math.max(1, day), hours, minutes, seconds);
}

/**
 * Convert a `Date` to a DOS date/time pair (local-time fields, seconds
 * floored to even — the deterministic write-path conversion, M2+).
 */
export function dateToDosDateTime(date: Date): { dosDate: number; dosTime: number } {
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >>> 1);
    return { dosDate, dosTime };
}
