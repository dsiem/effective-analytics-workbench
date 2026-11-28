import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

test("an external application can compose the packed workbench modules with only their peers", async (t) => {
  const consumer = await mkdtemp(join(tmpdir(), "workbench-consumer-"));
  t.after(() => rm(consumer, { recursive: true, force: true }));
  const modules = join(consumer, "node_modules");
  await mkdir(modules);
  for (const peer of ["effect", "foldkit", "@foldkit/ui"]) {
    await mkdir(dirname(join(modules, peer)), { recursive: true });
    await symlink(resolve("node_modules", peer), join(modules, peer), "dir");
  }
  for (const name of ["analytics", "workbench-ui"]) {
    const archive = join(consumer, name + ".tgz");
    const target = join(modules, "@dsiem", name);
    await mkdir(target, { recursive: true });
    execFileSync("pnpm", [
      "--filter",
      "@dsiem/" + name,
      "pack",
      "--out",
      archive,
    ]);
    execFileSync("tar", [
      "-xzf",
      archive,
      "-C",
      target,
      "--strip-components=1",
    ]);
  }
  await copyFile(
    new URL("./external-report.mjs", import.meta.url),
    join(consumer, "app.mjs"),
  );
  const result = execFileSync(process.execPath, ["app.mjs"], {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(result), { category: "bulk", remaining: 20 });
});
