import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

const OPEN_CODE_DIRECTORY = ".opencode";
const OVERWRITE_POLICIES = new Set(["error", "overwrite"]);

/**
 * Safely places Adapter-produced OpenCode command content in a project.
 * This is an I/O boundary: it never invokes the OpenCode CLI or an AI model.
 *
 * @param {import("./contracts.js").OpenCodeExecutorOptions} options
 * @returns {Promise<import("./contracts.js").PlacementResult>}
 */
export async function placeOpenCodeCommand({ projectRoot, command, overwritePolicy = "error" }) {
  return placeMarkdownFile({ projectRoot, file: command, leafDirectory: "commands", overwritePolicy });
}

/**
 * Safely places an Adapter-produced OpenCode agent definition in a project.
 * Placement rules and overwrite policies are shared with command placement;
 * only the target directory differs (.opencode/agent/).
 *
 * @param {import("./contracts.js").OpenCodeAgentExecutorOptions} options
 * @returns {Promise<import("./contracts.js").PlacementResult>}
 */
export async function placeOpenCodeAgent({ projectRoot, file, overwritePolicy = "error" }) {
  return placeMarkdownFile({ projectRoot, file, leafDirectory: "agent", overwritePolicy });
}

function validateOverwritePolicy(overwritePolicy) {
  if (!OVERWRITE_POLICIES.has(overwritePolicy)) {
    throw new Error(`Unsupported overwrite policy: ${overwritePolicy}`);
  }
}

async function placeMarkdownFile({ projectRoot, file, leafDirectory, overwritePolicy }) {
  validateOverwritePolicy(overwritePolicy);
  const { openCodeDirectory, targetDirectory, targetPath } = resolveMarkdownTarget(projectRoot, file, leafDirectory);

  await rejectSymbolicLinkIfPresent(openCodeDirectory);
  await mkdir(targetDirectory, { recursive: true });
  await rejectSymbolicLinkIfPresent(openCodeDirectory);
  await rejectSymbolicLinkIfPresent(targetDirectory);

  if (overwritePolicy === "error") {
    await writeFile(targetPath, file.content, { encoding: "utf8", flag: "wx" });
    return { path: targetPath, action: "created" };
  }

  const exists = await rejectSymbolicLinkIfPresent(targetPath);
  await writeFile(targetPath, file.content, { encoding: "utf8" });
  return { path: targetPath, action: exists ? "overwritten" : "created" };
}

function resolveMarkdownTarget(projectRoot, file, leafDirectory) {
  if (!projectRoot || !file?.relativePath || typeof file.content !== "string") {
    throw new Error("projectRoot、file.relativePath、file.content は必須です。");
  }

  if (isAbsolute(file.relativePath)) {
    throw new Error("OpenCode file path must be relative.");
  }

  const openCodeDirectory = resolve(projectRoot, OPEN_CODE_DIRECTORY);
  const targetDirectory = resolve(openCodeDirectory, leafDirectory);
  const targetPath = resolve(projectRoot, file.relativePath);

  if (dirname(targetPath) !== targetDirectory || extname(targetPath) !== ".md") {
    throw new Error(`OpenCode file must be a Markdown file directly under .opencode/${leafDirectory}/.`);
  }

  return { openCodeDirectory, targetDirectory, targetPath };
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
