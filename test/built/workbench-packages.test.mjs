import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { build, preview } from "vite";

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
  await t.test("runs the packed report in Node", async () => {
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

  await t.test(
    "typechecks, bundles and submits a run in the browser",
    async (t) => {
      await cp(new URL("./browser/", import.meta.url), consumer, {
        recursive: true,
      });
      execFileSync(resolve("node_modules/.bin/tsc"), ["-p", "tsconfig.json"], {
        cwd: consumer,
        stdio: "inherit",
      });

      const config = { root: consumer, configFile: false, logLevel: "error" };
      await build(config);
      const server = await preview({
        ...config,
        preview: { host: "127.0.0.1", port: 0 },
      });
      t.after(() => server.close());
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      const url = server.resolvedUrls.local[0];
      await page.goto(url);
      await expect(
        page.getByText("Warehouse stock: 20 units (bulk)"),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Warehouse stock" }),
      ).toBeVisible();

      const category = page.getByLabel("Category");
      const failedRequestId = async () => {
        const failure = await page.getByRole("alert").innerText();
        const id = /^Request ([a-f0-9-]{36}) failed$/.exec(failure)?.[1];
        assert.ok(id, failure);
        return id;
      };
      await category.fill("bulk");
      const submit = page.getByRole("button", { name: "Run analysis" });
      await submit.click();
      const id = await failedRequestId();

      await submit.click();
      const firstRun = url + "#bulk/" + id;
      await expect(page).toHaveURL(firstRun);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(submit).toBeEnabled();

      await submit.click();
      await expect(page).not.toHaveURL(firstRun);
      assert.match(new URL(page.url()).hash, /^#bulk\/[a-f0-9-]{36}$/);

      const previousRun = page.url();
      await category.fill("boxed");
      await submit.click();
      const boxedId = await failedRequestId();
      await category.fill("bulk");
      await expect(page.getByRole("alert")).toHaveCount(0);
      await submit.click();
      await expect(page).not.toHaveURL(previousRun);
      const edited = new URL(page.url()).hash;
      assert.match(edited, /^#bulk\/[a-f0-9-]{36}$/);
      assert.notEqual(edited, "#bulk/" + boxedId);
    },
  );
});
