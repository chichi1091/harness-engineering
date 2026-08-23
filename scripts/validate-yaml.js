import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

const YAML_FILE_PATTERN = /\.ya?ml$/;
const VALIDATION_ROOTS = [".github", "agents", "workflows", "test/fixtures"];

const yamlFiles = await collectYamlFiles(VALIDATION_ROOTS);
const failures = [];

for (const file of yamlFiles) {
  try {
    parse(await readFile(file, "utf8"));
    console.log(`valid YAML: ${file}`);
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}

async function collectYamlFiles(roots) {
  const files = [];

  for (const root of roots) {
    await collectFromDirectory(root, files);
  }

  return files.sort();
}

async function collectFromDirectory(directory, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFromDirectory(path, files);
    } else if (entry.isFile() && YAML_FILE_PATTERN.test(entry.name)) {
      files.push(path);
    }
  }
}
