/** Build-time ambient declarations for the bundle sources. */

declare const BUNDLE_VERSION: string
/** Full stylesheet (plugin css + Vue Flow css), `:root` rewritten to `:host`; injected by pack.ts. */
declare const UI_STYLES: string

declare module '*.css'
