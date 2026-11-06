// The PGlite contrib entry points are published through package "exports", which the repo's
// Node10 module resolution cannot see; the runtime (and Vitest) resolve them fine.
declare module '@electric-sql/pglite/contrib/ltree' {
  export const ltree: import('@electric-sql/pglite').Extension;
}
declare module '@electric-sql/pglite/contrib/pg_trgm' {
  export const pg_trgm: import('@electric-sql/pglite').Extension;
}
