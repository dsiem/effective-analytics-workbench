import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { CurrentViewer } from "../src/current-user.js";
import { unavailable } from "../src/errors.js";
import { Settings } from "../src/settings.js";
import { Workspace } from "../src/workspace.js";

const resolver = (
  config: Record<string, string> = {},
  profile: unknown = {
    displayName: "Local Developer",
    userName: "local@example.com",
  },
  failedLookups = 0,
) => {
  const paths: string[] = [];
  const user = Effect.runPromise(
    CurrentViewer.pipe(
      Effect.provide(CurrentViewer.layer),
      Effect.provideService(Workspace, {
        accessToken: Effect.succeed(Redacted.make("unused")),
        requestEvents: () => Effect.die("Unexpected workspace event request"),
        request: (path) =>
          Effect.suspend(() => {
            paths.push(path);
            return paths.length <= failedLookups
              ? Effect.fail(unavailable("workspace", "Unavailable"))
              : Effect.succeed(profile);
          }),
      }),
      Effect.provide(
        Settings.layer.pipe(
          Layer.provide(
            Layer.succeed(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnvRecord(config),
            ),
          ),
        ),
      ),
    ),
  );
  return { user, paths };
};

test("proxy identity takes priority over workspace credentials and stays per request", async () => {
  const { user, paths } = resolver({
    DATABRICKS_HOST: "https://workspace.example",
  });
  const resolve = await user;
  assert.deepEqual(
    await Effect.runPromise(
      resolve({
        "x-forwarded-preferred-username": "  Avery Morgan  ",
        "x-forwarded-email": "avery@example.com",
        "x-forwarded-user": "opaque-id",
        "x-forwarded-access-token": "private-token",
      }),
    ),
    { name: "Avery Morgan", email: "avery@example.com" },
  );
  assert.deepEqual(
    await Effect.runPromise(
      resolve({
        "x-forwarded-preferred-username": "Sam Rivera",
        "x-forwarded-email": "sam@example.com",
      }),
    ),
    { name: "Sam Rivera", email: "sam@example.com" },
  );
  assert.deepEqual(paths, []);
});

test("proxy email is the display fallback, without exposing opaque user IDs", async () => {
  const { user, paths } = resolver({
    DATABRICKS_HOST: "https://workspace.example",
  });
  const resolve = await user;
  assert.deepEqual(
    await Effect.runPromise(
      resolve({
        "x-forwarded-preferred-username": " ",
        "x-forwarded-email": "avery@example.com",
      }),
    ),
    { name: "avery@example.com", email: "avery@example.com" },
  );
  assert.deepEqual(
    await Effect.runPromise(
      resolve({
        "x-forwarded-preferred-username": "Avery Morgan",
      }),
    ),
    { name: "Avery Morgan", email: null },
  );
  assert.equal(
    await Effect.runPromise(resolve({ "x-forwarded-user": "opaque-id" })),
    null,
  );
  assert.deepEqual(paths, []);
});

test("local development uses the workspace display name and caches only the local profile", async () => {
  const { user, paths } = resolver({
    DATABRICKS_HOST: "https://workspace.example",
  });
  const resolve = await user;
  const expected = { name: "Local Developer", email: "local@example.com" };
  assert.deepEqual(await Effect.runPromise(resolve({})), expected);
  assert.deepEqual(await Effect.runPromise(resolve({})), expected);
  assert.deepEqual(
    await Effect.runPromise(
      resolve({
        "x-forwarded-preferred-username": "Different viewer",
      }),
    ),
    { name: "Different viewer", email: null },
  );
  assert.deepEqual(paths, ["/api/2.0/preview/scim/v2/Me"]);
});

test("the local profile lookup can recover immediately after a failure", async () => {
  const { user, paths } = resolver(
    { DATABRICKS_HOST: "https://workspace.example" },
    undefined,
    1,
  );
  const resolve = await user;
  assert.equal(await Effect.runPromise(resolve({})), null);
  const expected = { name: "Local Developer", email: "local@example.com" };
  assert.deepEqual(await Effect.runPromise(resolve({})), expected);
  assert.deepEqual(await Effect.runPromise(resolve({})), expected);
  assert.equal(paths.length, 2);
});

test("workspace username is used when the local profile has no display name", async () => {
  const { user } = resolver(
    { DATABRICKS_HOST: "https://workspace.example" },
    { userName: "local@example.com" },
  );
  assert.deepEqual(await Effect.runPromise((await user)({})), {
    name: "local@example.com",
    email: "local@example.com",
  });
});

for (const config of [
  {},
  {
    DATABRICKS_HOST: "https://workspace.example",
    DATABRICKS_CLIENT_ID: "app-principal",
  },
]) {
  test(`missing viewer identity never displays the app principal (${config.DATABRICKS_CLIENT_ID ?? "unconfigured"})`, async () => {
    const { user, paths } = resolver(config);
    assert.equal(await Effect.runPromise((await user)({})), null);
    assert.deepEqual(paths, []);
  });
}

for (const [description, profile, failedLookups] of [
  ["invalid profile", { applicationId: "service-principal" }, 0],
  ["unavailable workspace", null, 1],
] as const) {
  test(`optional profile lookup tolerates ${description}`, async () => {
    const { user } = resolver(
      { DATABRICKS_HOST: "https://workspace.example" },
      profile,
      failedLookups,
    );
    assert.equal(await Effect.runPromise((await user)({})), null);
  });
}
