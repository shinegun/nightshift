/**
 * Loads .env, before anything reads process.env.
 *
 * This must be the first import in server/index.ts. ES module imports are evaluated in order, and
 * several modules read the environment while they are being imported — db.ts picks its data
 * directory that way — so loading later would be loading too late.
 *
 * Values already in the environment win: a variable set on the command line or by a service
 * manager is a deliberate override of the file.
 */
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.env.NIGHTSHIFT_ENV_FILE ?? '.env');

if (fs.existsSync(file)) {
  // Snapshot the values, not just the names: the point is to restore what they were.
  const before = new Map(Object.entries(process.env));
  try {
    process.loadEnvFile(file);
    // loadEnvFile overwrites, so put back anything the real environment had already set.
    for (const [key, value] of before) {
      if (value !== undefined) process.env[key] = value;
    }
  } catch (e) {
    console.error(`[env] could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
