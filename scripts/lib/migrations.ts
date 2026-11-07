import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

export const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/** Connect over the Session pooler URL, falling back to the same string with the aws-1 pooler host. */
export async function connectDb(primary: string): Promise<Client> {
  const candidates = [primary, primary.replace(/aws-0-([a-z0-9-]+)\.pooler\.supabase\.com/, "aws-1-$1.pooler.supabase.com")];
  let lastError: unknown;
  for (const connectionString of [...new Set(candidates)]) {
    const client = new Client({
      connectionString,
      // Encrypted, but not CA-verified: Supabase's pooler certificate chains to Supabase's own root CA, which is
      // not in Node's trust store. This is an admin script; download Supabase's CA and pass it as `ca` to verify.
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15_000,
    });
    try {
      await client.connect();
      console.log(`Connected to ${new URL(connectionString).host}`);
      return client;
    } catch (error) {
      lastError = error;
      console.warn(`Could not connect to ${new URL(connectionString).host}: ${(error as Error).message}`);
    }
  }
  throw lastError;
}

/**
 * Apply every supabase/migrations/*.sql not yet in private.schema_migrations, in name order, each in its own
 * transaction (a failure rolls that file back and stops). Returns the files applied.
 */
export async function applyPendingMigrations(client: Client): Promise<string[]> {
  await client.query(`
    create schema if not exists private;
    create table if not exists private.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `);
  const applied = new Set((await client.query<{ name: string }>("select name from private.schema_migrations")).rows.map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip   ${file}`);
      continue;
    }
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into private.schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`  apply  ${file}`);
      done.push(file);
    } catch (error) {
      await client.query("rollback");
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  return done;
}
