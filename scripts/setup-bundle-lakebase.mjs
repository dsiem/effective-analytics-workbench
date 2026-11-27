import { execFileSync } from "node:child_process";
import { bundleResources, bundleTarget } from "./lib/databricks.mjs";
import { initializeLakebase, prepareLakebaseSetup } from "./lib/lakebase.mjs";

const resources = bundleResources(bundleTarget("setup-lakebase"));
const setup = prepareLakebaseSetup(resources);
execFileSync("pnpm", ["--filter", "@dsiem/sql-warehouse", "run", "build"], {
  stdio: "inherit",
});
initializeLakebase(setup);
