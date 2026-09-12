import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { validateQualityGates } from "../src/verification/verification-engine.js";

/**
 * Semantic validation of the canonical quality gates declaration. Mirrors
 * the registry validators: the script reads files, the validator is pure.
 */

const sourcePath = join("quality-gates.yaml");

let gates;
try {
  gates = parse(await readFile(sourcePath, "utf8"));
} catch (error) {
  console.error(`${sourcePath}: ${error.message}`);
  process.exit(1);
}

const errors = validateQualityGates(gates);

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`valid quality gates: ${gates.name} (${gates.commands.length} commands)`);
}
