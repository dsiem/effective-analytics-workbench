import { execFileSync } from "node:child_process";
import { bundleResources, bundleTarget } from "./lib/databricks.mjs";
import { initializeLakebase, prepareLakebaseSetup } from "./lib/lakebase.mjs";

const target = bundleTarget("deploy-taxi-demo");
const bundle = (command, ...args) =>
  execFileSync("databricks", ["bundle", command, "-t", target, ...args], {
    stdio: "inherit",
  });

execFileSync("npm", ["run", "build", "--workspaces", "--if-present"], {
  stdio: "inherit",
});
bundle("deploy", "--select", "jobs.seed_trip_snapshot");
bundle("run", "seed_trip_snapshot");
bundle("deploy");

const lakebaseSetup = prepareLakebaseSetup(bundleResources(target));
bundle(
  "run",
  "grant_trip_access",
  "--params",
  `app_service_principal_id=${lakebaseSetup.principal}`,
);
initializeLakebase(lakebaseSetup);
bundle("run", "app");
