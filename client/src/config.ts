// Unified on the SpacetimeDB Maincloud database. Override via Vite env if needed.
export const SPACETIMEDB_URI =
  (import.meta.env.VITE_SPACETIMEDB_URI as string | undefined) ?? 'wss://maincloud.spacetimedb.com';
export const MODULE_NAME =
  (import.meta.env.VITE_MODULE_NAME as string | undefined) ?? 'swarm-arena';
