import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

const COMMAND_DIRECTORY = [".opencode", "commands"];
const OVERWRITE_POLICIES = new Set(["error", "overwrite"]);

/**
 * Safely places Adapter-produced OpenCode command content in a project.
 * This is an I/O boundary: it never invokes the OpenCode CLI or an AI model.
 *
 * @param {import("./contracts.js").OpenCodeExecutorOptions} options
 * @returns {Promise<import("./contracts.js").PlacementResult>}
 */
export async function placeOpenCodeCommand({
  projectRoot,
  command,
  overwritePolicy = "error"
}) {
  validateOverwritePolicy(overwritePolicy);
  const { openCodeDirectory, commandDirectory, targetPath } = resolveCommandTarget(projectRoot, command);

  await rejectSymbolicLinkIfPresent(openCodeDirectory);
  await mkdir(commandDirectory, { recursive: true });
  await rejectSymbolicLinkIfPresent(openCodeDirectory);
  await rejectSymbolicLinkIfPresent(commandDirectory);

  if (overwritePolicy === "error") {
    await writeFile(targetPath, command.content, { encoding: "utf8", flag: "wx" });
    return { path: targetPath, action: "created" };
  }

  const exists = await rejectSymbolicLinkIfPresent(targetPath);
  await writeFile(targetPath, command.content, { encoding: "utf8" });
  return { path: targetPath, action: exists ? "overwritten" : "created" };
}

function validateOverwritePolicy(overwritePolicy) {
  if (!OVERWRITE_POLICIES.has(overwritePolicy)) {
    throw new Error(`Unsupported overwrite policy: ${overwritePolicy}`);
  }
}

function resolveCommandTarget(projectRoot, command) {
  if (!projectRoot || !command?.relativePath || typeof command.content !== "string") {
    throw new Error("projectRoot、command.relativePath、command.content は必須です。");
  }

  if (isAbsolute(command.relativePath)) {
    throw new Error("OpenCode command path must be relative.");
  }

  const openCodeDirectory = resolve(projectRoot, COMMAND_DIRECTORY[0]);
  const commandDirectory = resolve(openCodeDirectory, COMMAND_DIRECTORY[1]);
  const targetPath = resolve(projectRoot, command.relativePath);

  if (dirname(targetPath) !== commandDirectory || extname(targetPath) !== ".md") {
    throw new Error("OpenCode command must be a Markdown file directly under .opencode/commands/.");
  }

  return { openCodeDirectory, commandDirectory, targetPath };
}

async function rejectSymbolicLinkIfPresent(targetPath) {
  try {
    const metadata = await lstat(targetPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symbolic link: ${targetPath}`);
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
