"use strict";
/**
 * Trim the named environment variables in this process, then exec the remaining command
 * with the trimmed values. Never prints a value. Never writes GITHUB_ENV.
 *
 * Usage: node scripts/trim-step-env.cjs NAME [NAME ...] -- cmd [args...]
 */
const { spawnSync } = require("node:child_process");

const dash = process.argv.indexOf("--");
if (dash <= 2 || dash === process.argv.length - 1) {
  console.error("::error::usage: node scripts/trim-step-env.cjs NAME [NAME ...] -- cmd [args...]");
  process.exit(2);
}

const names = process.argv.slice(2, dash);
const cmd = process.argv[dash + 1];
const args = process.argv.slice(dash + 2);
if (!names.length || names.some((name) => !/^[A-Z][A-Z0-9_]*$/u.test(name))) {
  console.error("::error::usage: node scripts/trim-step-env.cjs NAME [NAME ...] -- cmd [args...]");
  process.exit(2);
}

const env = { ...process.env };
for (const name of names) {
  const value = String(env[name] ?? "").trim();
  if (!value) {
    console.error(`::error::${name} is missing or empty after trimming`);
    process.exit(1);
  }
  env[name] = value;
}

const result = spawnSync(cmd, args, { stdio: "inherit", env });
if (result.error) {
  console.error("::error::failed to start the command");
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
