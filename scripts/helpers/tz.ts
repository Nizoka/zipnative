/**
 * Pin the process timezone to UTC — side-effect module.
 *
 * ZIP headers carry MS-DOS local-time fields and `dateToDosDateTime()`
 * reads a `Date` with the host's local calendar by default, so a sample
 * generator that ever passes an explicit `Date` would emit different
 * bytes in Paris and on a UTC CI runner. The corpus uses the DOS-epoch
 * default everywhere today; pinning the zone keeps that true by
 * construction instead of by review, and makes the fingerprint baseline
 * (`npm run verify:samples`) a pure function of the sources.
 *
 * Import this module FIRST, before anything that formats a date. ES
 * modules evaluate imports in source order, so a bare
 * `import './helpers/tz.ts';` placed above the others runs before them.
 *
 * `process.env.TZ` has been honoured at runtime on every platform since
 * Node 16.2; the project's engine floor is Node 22.
 */
process.env.TZ = 'UTC';
