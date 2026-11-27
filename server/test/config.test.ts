import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { ServerConfig } from "../src/config.js";

const readConfig = (env: Record<string, string>) =>
  Effect.runPromise(ServerConfig.parse(ConfigProvider.fromEnvRecord(env)));

test("starts locally without Databricks credentials", async () => {
  assert.deepEqual(await readConfig({}), { host: "0.0.0.0", port: 3000 });
});

test("reads the Databricks port", async () => {
  assert.deepEqual(
    await readConfig({
      DATABRICKS_APP_PORT: "8000",
    }),
    { host: "0.0.0.0", port: 8000 },
  );
});

test("binds to loopback when the local proxy sets the host", async () => {
  assert.equal(
    (await readConfig({ APP_BIND_HOST: "127.0.0.1" })).host,
    "127.0.0.1",
  );
});

test("accepts an ephemeral port for smoke checks", async () => {
  assert.equal((await readConfig({ DATABRICKS_APP_PORT: "0" })).port, 0);
});

test("treats empty environment values as absent", async () => {
  assert.deepEqual(await readConfig({ DATABRICKS_APP_PORT: "" }), {
    host: "0.0.0.0",
    port: 3000,
  });
});

for (const port of ["-1", "65536", "1.5", "invalid"]) {
  test(`rejects invalid port ${JSON.stringify(port)} without falling back`, async () => {
    await assert.rejects(readConfig({ DATABRICKS_APP_PORT: port }));
  });
}

test("accepts a platform workspace hostname as well as a full URL", async () => {
  const { Settings } = await import("../src/settings.js");
  const { Layer } = await import("effect");
  for (const host of [
    "workspace.cloud.databricks.com",
    "https://workspace.cloud.databricks.com",
  ]) {
    const value = await Effect.runPromise(
      Effect.gen(function* () {
        return (yield* Settings).host;
      }).pipe(
        Effect.provide(
          Settings.layer.pipe(
            Layer.provide(
              Layer.succeed(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromEnvRecord({ DATABRICKS_HOST: host }),
              ),
            ),
          ),
        ),
      ),
    );
    assert.equal(value, "https://workspace.cloud.databricks.com");
  }
});

for (const [key, value] of [
  ["PGPORT", "-1"],
  ["PGPORT", "65536"],
  ["PGPORT", "invalid"],
  ["WAREHOUSE_MAX_CONCURRENCY", "0"],
  ["WAREHOUSE_MAX_CONCURRENCY", "-1"],
  ["WAREHOUSE_MAX_CONCURRENCY", "1.5"],
  ["GENIE_MAX_CONCURRENCY", "0"],
  ["GENIE_MAX_CONCURRENCY", "invalid"],
  ["DATABRICKS_HOST", "http://workspace.invalid"],
  ["DATABRICKS_HOST", "https://workspace.invalid/api"],
  ["DATABRICKS_HOST", "https://user:secret@workspace.invalid"],
  ["DATABRICKS_HOST", "not a host"],
] as const) {
  test(`invalid ${key} fails service configuration instead of disabling a capability`, async () => {
    const { Settings } = await import("../src/settings.js");
    await assert.rejects(
      Effect.runPromise(
        Settings.pipe(
          Effect.provide(Settings.layer),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord({ [key]: value }),
          ),
        ),
      ),
      /ConfigError/,
    );
  });
}

test("admission settings have independent defaults and accept positive overrides", async () => {
  const { Settings } = await import("../src/settings.js");
  for (const [env, expected] of [
    [{}, [4, 2]],
    [{ WAREHOUSE_MAX_CONCURRENCY: "1", GENIE_MAX_CONCURRENCY: "3" }, [1, 3]],
  ] as const) {
    const actual = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* Settings;
        return [settings.warehouseConcurrency, settings.genieConcurrency];
      }).pipe(
        Effect.provide(Settings.layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(env),
        ),
      ),
    );
    assert.deepEqual(actual, expected);
  }
});
