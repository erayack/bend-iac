// npm run build: check the proofs (bend2, then --verdict when the kernel is
// built), then compile core/planner.bend to .build/planner.mjs.
import { build, EngineError, isFresh } from "../src/engine";

const quiet = process.argv.includes("--quiet");

try {
  if (quiet && isFresh()) process.exit(0);
  build((s) => quiet || console.log(s));
} catch (e) {
  console.error(e instanceof EngineError ? `build: ${e.message}` : e);
  process.exit(1);
}
