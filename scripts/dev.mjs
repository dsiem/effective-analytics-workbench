import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:os";
import {
  bundleResources,
  bundleTarget,
  deployedResourceId,
} from "./lib/databricks.mjs";
import { lakebaseEnv } from "./lib/lakebase.mjs";

function bundleServerEnv(command) {
  const resources = bundleResources(bundleTarget(command));
  const schema = deployedResourceId(resources, "schemas", "data");
  return {
    ...process.env,
    DATABRICKS_WAREHOUSE_ID: deployedResourceId(
      resources,
      "sql_warehouses",
      "analytics",
    ),
    TRIP_SNAPSHOT_TABLE: `${schema}.trips`,
    ANALYSIS_JOB_ID: deployedResourceId(resources, "jobs", "route_reliability"),
    ANALYSIS_RESULTS_TABLE: `${schema}.route_reliability_runs`,
    GENIE_SPACE_ID: deployedResourceId(resources, "genie_spaces", "taxi"),
    ...lakebaseEnv(resources),
  };
}

const mode = process.argv[2];
const proxyMode = mode === "--bundle-proxy";
const bundleMode = proxyMode || mode === "--bundle";
const serverEnv = bundleMode
  ? bundleServerEnv(proxyMode ? "app-local-proxy" : "app-local")
  : process.env;
execFileSync(
  "npm",
  ["run", "build", ...(proxyMode ? [] : ["--workspaces", "--if-present"])],
  {
    stdio: "inherit",
  },
);

const children = [];
let stopping = false;
let startupTimeout;
function stop(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimeout);
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
}

function supervise(child) {
  children.push(child);
  child.once("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.once("exit", (code, signal) =>
    stop(code ?? 128 + constants.signals[signal]),
  );
  return child;
}

process.once("SIGTERM", () => stop(128 + constants.signals.SIGTERM));
process.once("SIGINT", () => stop(128 + constants.signals.SIGINT));

if (proxyMode) {
  // Let the CLI set the backend port and keep Genie in its local mode.
  delete serverEnv.DATABRICKS_APP_PORT;
  const profile = serverEnv.DATABRICKS_CONFIG_PROFILE;
  supervise(
    spawn(
      "databricks",
      [
        "apps",
        "run-local",
        ...(profile ? ["--profile", profile] : []),
        "--env=DATABRICKS_APP_NAME=",
        "--env=APP_BIND_HOST=127.0.0.1",
      ],
      { stdio: "inherit", env: serverEnv },
    ),
  );
} else {
  const envFile = bundleMode ? [] : ["--env-file-if-exists=.env"];
  startupTimeout = setTimeout(() => {
    console.error("The API did not start within 30 seconds.");
    stop(1);
  }, 30_000);

  const server = supervise(
    spawn(
      process.execPath,
      [
        ...envFile,
        "--conditions=development",
        "--conditions=workbench-source",
        "--import",
        "tsx",
        "--watch",
        "server/src/main.ts",
        "--dev",
      ],
      { stdio: ["inherit", "inherit", "inherit", "ipc"], env: serverEnv },
    ),
  );

  let apiPort;
  server.on("message", (message) => {
    if (stopping) return;
    switch (message?.type) {
      case "dev:api-port":
        server.send(apiPort ?? 0);
        break;
      case "dev:api-failed":
        stop(message.code);
        break;
      case "dev:api-ready":
        if (apiPort !== undefined) break;
        apiPort = message.port;
        clearTimeout(startupTimeout);
        supervise(
          spawn(
            process.execPath,
            ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
            {
              stdio: "inherit",
              env: { ...process.env, DATABRICKS_APP_PORT: String(apiPort) },
            },
          ),
        );
        break;
    }
  });
}
