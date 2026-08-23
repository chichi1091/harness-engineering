import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { placeOpenCodeCommand } from "../src/runtimes/opencode/opencode-executor.js";

const command = {
  relativePath: ".opencode/commands/harness-feature-development.md",
  content: "---\ndescription: Feature workflow\n---\n"
};

async function withTemporaryProject(callback) {
  const projectRoot = await mkdtemp(join(tmpdir(), "harness-executor-"));
  try {
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("Adapter出力を.opencode/commands/へ配置する", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const result = await placeOpenCodeCommand({ projectRoot, command });

    assert.equal(result.action, "created");
    assert.equal(
      result.path,
      join(projectRoot, ".opencode/commands/harness-feature-development.md")
    );
    assert.equal(await readFile(result.path, "utf8"), command.content);
  });
});

test("既定のerrorポリシーは既存コマンドを上書きしない", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const targetPath = join(projectRoot, command.relativePath);
    await placeOpenCodeCommand({ projectRoot, command });

    await assert.rejects(
      placeOpenCodeCommand({ projectRoot, command: { ...command, content: "new content" } }),
      { code: "EEXIST" }
    );
    assert.equal(await readFile(targetPath, "utf8"), command.content);
  });
});

test("明示的なoverwriteポリシーでのみ既存コマンドを置換する", async () => {
  await withTemporaryProject(async (projectRoot) => {
    await placeOpenCodeCommand({ projectRoot, command });
    const replacement = { ...command, content: "replacement" };

    const result = await placeOpenCodeCommand({
      projectRoot,
      command: replacement,
      overwritePolicy: "overwrite"
    });

    assert.equal(result.action, "overwritten");
    assert.equal(await readFile(result.path, "utf8"), "replacement");
  });
});

test("overwriteポリシーでも未存在のコマンドはcreatedとして配置する", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const result = await placeOpenCodeCommand({
      projectRoot,
      command,
      overwritePolicy: "overwrite"
    });

    assert.equal(result.action, "created");
  });
});

test("配置先外へのパスとパストラバーサルを拒否する", async () => {
  await withTemporaryProject(async (projectRoot) => {
    await assert.rejects(
      placeOpenCodeCommand({
        projectRoot,
        command: { ...command, relativePath: "../outside.md" }
      }),
      /\.opencode\/commands/
    );
    await assert.rejects(
      placeOpenCodeCommand({
        projectRoot,
        command: { ...command, relativePath: ".opencode/commands/../outside.md" }
      }),
      /\.opencode\/commands/
    );
  });
});

test("overwriteポリシーでもシンボリックリンクを置換しない", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const targetPath = join(projectRoot, command.relativePath);
    const outsidePath = join(projectRoot, "outside.md");
    await mkdir(join(projectRoot, ".opencode/commands"), { recursive: true });
    await writeFile(outsidePath, "protected", "utf8");
    await symlink(outsidePath, targetPath);

    await assert.rejects(
      placeOpenCodeCommand({ projectRoot, command, overwritePolicy: "overwrite" }),
      /symbolic link/
    );
    assert.equal(await readFile(outsidePath, "utf8"), "protected");
  });
});

test(".opencodeディレクトリがシンボリックリンクの場合は配置しない", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const outsideDirectory = join(projectRoot, "outside");
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, join(projectRoot, ".opencode"));

    await assert.rejects(
      placeOpenCodeCommand({ projectRoot, command }),
      /symbolic link/
    );
  });
});
