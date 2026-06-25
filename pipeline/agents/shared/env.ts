/**
 * Gooi als een vereiste env var ontbreekt. De agent-entrypoints hebben een
 * `main().catch(...)` die de fout logt en met exit-code 1 afsluit, dus één
 * throw-variant volstaat overal (geen losse `process.exit` per agent).
 */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
