import { bundleResources, bundleTarget } from "./lib/databricks.mjs";
import { initializeLakebase, prepareLakebaseSetup } from "./lib/lakebase.mjs";

const resources = bundleResources(bundleTarget("setup-lakebase"));
const setup = prepareLakebaseSetup(resources);
initializeLakebase(setup);
