import { spawn } from "node:child_process";
import {
  bundleResources,
  bundleTarget,
  deployedResourceId,
} from "./lib/databricks.mjs";
import { lakebaseEnv } from "./lib/lakebase.mjs";

function bundleServerEnv() {
  const resources = bundleResources(bundleTarget("dev"));
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

const bundleMode = process.argv[2] === "--bundle";
const serverScript = bundleMode ? "dev:server:bundle" : "dev:server";
const children = [
  spawn("npm", ["run", serverScript], {
    stdio: "inherit",
    env: bundleMode ? bundleServerEnv() : process.env,
  }),
  spawn("npm", ["run", "dev:client"], { stdio: "inherit" }),
];
const stop = () => {
  for (const child of children) child.kill("SIGTERM");
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
for (const child of children)
  child.once("exit", (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
