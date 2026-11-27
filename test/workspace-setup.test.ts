import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const principal = "472a6613-2337-4af1-a416-e9b6b61064dd";
const endpointName = "projects/test/branches/production/endpoints/primary";
const deployTaxiDemo = new URL(
  "../scripts/deploy-taxi-demo.mjs",
  import.meta.url,
);
const setupBundleLakebase = new URL(
  "../scripts/setup-bundle-lakebase.mjs",
  import.meta.url,
);
const dev = new URL("../scripts/dev.mjs", import.meta.url);
const api = new URL("../server/src/main.ts", import.meta.url);
const tsxPackage = new URL("../node_modules/tsx/", import.meta.url);
const buildWorkspaces = "run build --workspaces --if-present";
const watchServer =
  "--conditions=development --conditions=workbench-source --import tsx --watch server/src/main.ts --dev";
const startClient = "node_modules/vite/bin/vite.js --host 127.0.0.1";

async function writeDevFixture(directory: string) {
  const server = join(directory, "server", "src");
  const workspace = join(directory, "packages", "fixture");
  const modules = join(directory, "node_modules");
  await Promise.all(
    [server, workspace, modules].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await Promise.all([
    writeFile(
      join(directory, ".env"),
      [
        "DATABRICKS_HOST=https://local.invalid",
        "DATABRICKS_WAREHOUSE_ID=other-warehouse",
        "DATABRICKS_CONFIG_PROFILE=other-profile",
        "DATABRICKS_CONFIG_FILE=/stale/databricks.cfg",
        "DATABRICKS_TOKEN=fixture-old-token",
        "PGHOST=other-db.invalid",
        "PGPORT=5555",
        "PGDATABASE=other-database",
        "PGPASSWORD=fixture-old-password",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(directory, "package.json"),
      '{"private":true,"type":"module","workspaces":["packages/*"]}',
    ),
    writeFile(
      join(workspace, "package.json"),
      '{"name":"fixture","private":true}',
    ),
    symlink(tsxPackage, join(modules, "tsx"), "junction"),
    writeFile(
      join(server, "main.ts"),
      `
const keys = [
  "DATABRICKS_HOST", "DATABRICKS_WAREHOUSE_ID", "TRIP_SNAPSHOT_TABLE", "ANALYSIS_JOB_ID",
  "ANALYSIS_RESULTS_TABLE", "GENIE_SPACE_ID", "LAKEBASE_ENDPOINT", "PGHOST", "PGPORT",
  "PGDATABASE", "PGUSER", "PGPASSWORD", "DATABRICKS_CONFIG_PROFILE", "DATABRICKS_TOKEN",
  "DATABRICKS_CONFIG_FILE", "GENIE_MAX_CONCURRENCY",
];
console.log("SERVER " + JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]))));
`,
    ),
  ]);
}

const fakeCommands = `
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => {
  const command = args.join(" ");
  console.log("CALL " + command);
  if (command.startsWith("bundle summary")) return JSON.stringify({ resources: {
    apps: { app: { name: "configured-app", id: "deployed-app" } },
    sql_warehouses: { analytics: { id: process.env.SETUP_WAREHOUSE } },
    schemas: { data: { catalog_name: "configured_catalog", name: "configured-schema", id: "seed_catalog.seed-schema" } },
    jobs: { route_reliability: { id: 123456 } },
    genie_spaces: { taxi: { id: "genie" } },
    postgres_endpoints: { notebook_endpoint: { id: "${endpointName}" } },
  } });
  if (command.startsWith("apps get")) return JSON.stringify({ service_principal_client_id: process.env.SETUP_PRINCIPAL });
  if (command.startsWith("current-user me")) return JSON.stringify({ userName: "deployer@example.com" });
  if (args[0] === "--import") {
    console.log("LAKEBASE " + JSON.stringify({
      host: options.env.PGHOST, principal: options.env.APP_SERVICE_PRINCIPAL_ID,
      endpoint: options.env.LAKEBASE_ENDPOINT, user: options.env.PGUSER,
      port: options.env.PGPORT, database: options.env.PGDATABASE, password: options.env.PGPASSWORD,
      profile: options.env.DATABRICKS_CONFIG_PROFILE, configFile: options.env.DATABRICKS_CONFIG_FILE,
    }));
  }
  if (command === process.env.SETUP_FAILURE) throw new Error("Fixture command failed");
  return "";
};
childProcess.spawn = (file, args, options) => {
  const child = new EventEmitter();
  child.kill = () => false;
  console.log("CALL " + args.join(" "));
  if (args.includes("server/src/main.ts")) {
    process.stdout.write(execFileSync(file, args.filter((arg) => arg !== "--watch"), {
      encoding: "utf8", env: options.env, timeout: 10_000,
    }));
    setImmediate(() => child.emit("message", { type: "dev:api-ready", port: 43171 }));
  }
  if (file === "databricks" && args[1] === "run-local") {
    console.log("SERVER " + JSON.stringify({
      port: options.env.DATABRICKS_APP_PORT ?? null,
      profile: options.env.DATABRICKS_CONFIG_PROFILE,
      genie: options.env.GENIE_SPACE_ID,
    }));
    setImmediate(() => child.emit("exit", 0, null));
  }
  return child;
};
syncBuiltinESMExports();
await import(process.env.SETUP_ENTRY_POINT);
`;

async function setup(
  t: TestContext,
  entryPoint: URL,
  {
    failure = "",
    warehouse = "warehouse",
    appPrincipal = principal,
    expectedError = failure ? /Fixture command failed/ : undefined,
    args = [],
    appPort,
  }: {
    failure?: string;
    warehouse?: string;
    appPrincipal?: string;
    expectedError?: RegExp;
    args?: string[];
    appPort?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (entryPoint === dev) await writeDevFixture(directory);
  const standaloneDev = entryPoint === dev && args.length === 0;
  let stdout: string;
  try {
    const result = await run(
      process.execPath,
      ["--input-type=module", "-e", fakeCommands, "--", "fixture", ...args],
      {
        cwd: directory,
        env: {
          ...process.env,
          DATABRICKS_BUNDLE_TARGET: standaloneDev ? undefined : "prod",
          DATABRICKS_HOST: standaloneDev
            ? undefined
            : "https://workspace.invalid",
          DATABRICKS_CONFIG_PROFILE: standaloneDev
            ? undefined
            : "selected-profile",
          DATABRICKS_CONFIG_FILE: undefined,
          DATABRICKS_TOKEN: "",
          DATABRICKS_APP_PORT: appPort,
          PGHOST: "local.invalid",
          GENIE_MAX_CONCURRENCY: "3",
          SETUP_FAILURE: failure,
          SETUP_WAREHOUSE: warehouse,
          SETUP_PRINCIPAL: appPrincipal,
          SETUP_ENTRY_POINT: entryPoint.href,
        },
        timeout: 15_000,
      },
    );
    assert.equal(expectedError, undefined);
    stdout = result.stdout;
  } catch (error) {
    assert.ok(expectedError);
    assert.ok(error instanceof Error && "stdout" in error);
    assert.match(error.message, expectedError);
    stdout = String(error.stdout);
  }
  const calls = stdout
    .split("\n")
    .filter((line) => line.startsWith("CALL "))
    .map((line) => line.slice(5));
  const lakebase = stdout
    .split("\n")
    .find((line) => line.startsWith("LAKEBASE "));
  const server = stdout.split("\n").find((line) => line.startsWith("SERVER "));
  return { calls, lakebase, server };
}

const lakebaseCommand = "--import tsx scripts/setup-lakebase.ts";
const summaryCommand = "bundle summary -t prod --force-pull -o json";
const lakebaseCalls = [
  "current-user me -o json",
  "apps get deployed-app -o json",
];
const lakebaseSettings = {
  host: "",
  principal,
  endpoint: endpointName,
  user: "deployer@example.com",
  port: "5432",
  database: "databricks_postgres",
  password: "",
  profile: "selected-profile",
};
const setupCalls = [
  buildWorkspaces,
  "bundle deploy -t prod --select jobs.seed_trip_snapshot",
  "bundle run -t prod seed_trip_snapshot",
  "bundle deploy -t prod",
  summaryCommand,
  ...lakebaseCalls,
  `bundle run -t prod grant_trip_access --params app_service_principal_id=${principal}`,
  lakebaseCommand,
  "bundle run -t prod app",
];

test("deploy-taxi-demo seeds before creating Genie and the app, then grants access before starting it", async (t) => {
  const result = await setup(t, deployTaxiDemo);
  assert.deepEqual(result.calls, setupCalls);
  assert.equal(result.lakebase, "LAKEBASE " + JSON.stringify(lakebaseSettings));
});

for (const failedCommand of [setupCalls[2]!, setupCalls[7]!, lakebaseCommand]) {
  test(`deploy-taxi-demo stops after ${failedCommand} fails`, async (t) => {
    const result = await setup(t, deployTaxiDemo, { failure: failedCommand });
    assert.deepEqual(
      result.calls,
      setupCalls.slice(0, setupCalls.indexOf(failedCommand) + 1),
    );
  });
}

test("bundle Lakebase setup initializes the deployed database with the hosted app's grants", async (t) => {
  const result = await setup(t, setupBundleLakebase);
  assert.equal(result.lakebase, "LAKEBASE " + JSON.stringify(lakebaseSettings));
});

test("bundle Lakebase setup stops when the hosted app principal is missing", async (t) => {
  const result = await setup(t, setupBundleLakebase, {
    appPrincipal: "",
    expectedError: /Missing the deployed app service principal/,
  });
  assert.deepEqual(result.calls, [summaryCommand, ...lakebaseCalls]);
});

test("bundle dev starts the API with the deployed target and its authentication settings", async (t) => {
  const result = await setup(t, dev, { args: ["--bundle"] });
  assert.deepEqual(result.calls, [
    summaryCommand,
    "current-user me -o json",
    buildWorkspaces,
    watchServer,
    startClient,
  ]);
  assert.ok(result.server);
  assert.deepEqual(JSON.parse(result.server.slice("SERVER ".length)), {
    DATABRICKS_HOST: "https://workspace.invalid",
    DATABRICKS_WAREHOUSE_ID: "warehouse",
    TRIP_SNAPSHOT_TABLE: "seed_catalog.seed-schema.trips",
    ANALYSIS_JOB_ID: "123456",
    ANALYSIS_RESULTS_TABLE: "seed_catalog.seed-schema.route_reliability_runs",
    GENIE_SPACE_ID: "genie",
    LAKEBASE_ENDPOINT: endpointName,
    PGHOST: "",
    PGPORT: "5432",
    PGDATABASE: "databricks_postgres",
    PGUSER: "deployer@example.com",
    PGPASSWORD: "",
    DATABRICKS_CONFIG_PROFILE: "selected-profile",
    DATABRICKS_TOKEN: "",
    DATABRICKS_CONFIG_FILE: null,
    GENIE_MAX_CONCURRENCY: "3",
  });
});

test("bundle dev stops before starting either process when a target setting is missing", async (t) => {
  const result = await setup(t, dev, {
    args: ["--bundle"],
    warehouse: "",
    expectedError: /Missing deployed resource sql_warehouses.analytics/,
  });
  assert.deepEqual(result.calls, [summaryCommand]);
});

test("bundle proxy builds the app and gives the CLI control of the backend port", async (t) => {
  const result = await setup(t, dev, {
    args: ["--bundle-proxy"],
    appPort: "43170",
  });
  assert.deepEqual(result.calls, [
    summaryCommand,
    "current-user me -o json",
    "run build",
    "apps run-local --profile selected-profile --env=DATABRICKS_APP_NAME= --env=APP_BIND_HOST=127.0.0.1",
  ]);
  assert.equal(
    result.server,
    'SERVER {"port":null,"profile":"selected-profile","genie":"genie"}',
  );
});

test("npm dev launches the API with its local connection settings", async (t) => {
  const result = await setup(t, dev, { warehouse: "" });
  assert.deepEqual(result.calls, [
    buildWorkspaces,
    `--env-file-if-exists=.env ${watchServer}`,
    startClient,
  ]);
  assert.ok(result.server);
  assert.match(result.server, /"DATABRICKS_HOST":"https:\/\/local\.invalid"/);
  assert.match(
    result.server,
    /"DATABRICKS_CONFIG_FILE":"\/stale\/databricks\.cfg"/,
  );
  assert.match(result.server, /"DATABRICKS_WAREHOUSE_ID":"other-warehouse"/);
});

test("dev preserves the first process failure and shuts down the other process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dev-processes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeDevFixture(directory);
  const vite = join(directory, "node_modules", "vite", "bin");
  await mkdir(vite, { recursive: true });
  await Promise.all([
    writeFile(
      join(directory, "server", "src", "main.ts"),
      `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
const server = createServer((_, response) => response.writeHead(204).end());
server.listen(0, "127.0.0.1", () => {
  writeFileSync("server.pid", String(process.pid));
  process.send({ type: "dev:api-ready", port: server.address().port });
});
`,
    ),
    writeFile(
      join(vite, "vite.js"),
      `const response = await fetch("http://127.0.0.1:" + process.env.DATABRICKS_APP_PORT);
process.exit(response.status === 204 ? 7 : 2);
`,
    ),
  ]);

  await assert.rejects(
    run(process.execPath, [fileURLToPath(dev)], {
      cwd: directory,
      timeout: 10_000,
    }),
    { code: 7 },
  );
  const serverPid = Number(
    await readFile(join(directory, "server.pid"), "utf8"),
  );
  assert.throws(() => process.kill(serverPid, 0), { code: "ESRCH" });
});

test("dev reports an occupied API port before starting the frontend", async (t) => {
  const occupied = createServer();
  occupied.listen(0, "0.0.0.0");
  await once(occupied, "listening");
  t.after(() => occupied.close());
  const address = occupied.address();
  assert.ok(address && typeof address === "object");

  const directory = await mkdtemp(join(tmpdir(), "dev-occupied-port-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeDevFixture(directory);
  const vite = join(directory, "node_modules", "vite", "bin");
  await mkdir(vite, { recursive: true });
  await Promise.all([
    writeFile(
      join(directory, "server", "src", "main.ts"),
      `await import(${JSON.stringify(api.href)});`,
    ),
    writeFile(
      join(vite, "vite.js"),
      'console.log("Frontend started"); process.exit(7);',
    ),
  ]);

  await assert.rejects(
    run(process.execPath, [fileURLToPath(dev)], {
      cwd: directory,
      env: {
        ...process.env,
        DATABRICKS_HOST: "https://workspace.invalid",
        DATABRICKS_APP_PORT: String(address.port),
        GENIE_SPACE_ID: "fixture-space",
      },
      timeout: 10_000,
    }),
    (error: unknown) => {
      assert.ok(
        error instanceof Error &&
          "code" in error &&
          "stdout" in error &&
          "stderr" in error,
      );
      assert.equal(error.code, 1);
      const output = String(error.stdout) + String(error.stderr);
      assert.match(output, /EADDRINUSE/);
      assert.doesNotMatch(output, /Frontend started/);
      return true;
    },
  );
});
