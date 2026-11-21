import { execFileSync } from "node:child_process";
import { bundleResources, bundleTarget } from "./lib/databricks.mjs";
import { initializeLakebase, prepareLakebaseSetup } from "./lib/lakebase.mjs";

const resources = bundleResources(bundleTarget("setup_lakebase"));
const setup = prepareLakebaseSetup(resources);
execFileSync("npm", ["run", "build", "--workspace", "@dsiem/sql-warehouse"], {
  stdio: "inherit",
});
initializeLakebase(setup);
