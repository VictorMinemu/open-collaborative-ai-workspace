#!/usr/bin/env node
// `pnpm setup:env`: alias of `pnpm ocw setup` (scripts/ocw/setup.mjs), kept for existing installs and docs. Generates
// a local .env with random secrets (database passwords, auth, cell and sandbox tokens such as OCW_SANDBOX_TOKEN, S3
// keys); explicit command only, nothing is ever generated at boot. Refuses to overwrite
// unless --force. Prints which keys it wrote and where, never a value.
//   pnpm setup:env                 # fresh .env from .env.example with random secrets
//   pnpm setup:env --force         # overwrite (rotates EVERY secret)
//   pnpm setup:env --add-missing   # existing .env: append only keys it lacks (never rotates)
//   --dir <path>                   # write <path>/.env instead of the repo's (tests)
// Every `pnpm ocw setup` option works here too (`pnpm ocw setup --help`).
import { runMain } from "./ocw/setup.mjs";

runMain(process.argv.slice(2));
