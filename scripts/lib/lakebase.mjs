import { execFileSync } from "node:child_process";
import {
  bundleApp,
  databricksJson,
  deployedResourceId,
} from "./databricks.mjs";

export function lakebaseEnv(resources) {
  const endpoint = deployedResourceId(
    resources,
    "postgres_endpoints",
    "notebook_endpoint",
  );
  const user = databricksJson("current-user", "me")?.userName;
  if (typeof user !== "string" || !user.trim()) {
    throw new Error("Missing the workspace identity.");
  }
  return {
    LAKEBASE_ENDPOINT: endpoint,
    PGHOST: "",
    PGPORT: "5432",
    PGDATABASE: "databricks_postgres",
    PGUSER: user,
    PGPASSWORD: "",
  };
}

export function prepareLakebaseSetup(resources) {
  const env = lakebaseEnv(resources);
  const principal = bundleApp(resources)?.service_principal_client_id;
  if (typeof principal !== "string" || !principal.trim()) {
    throw new Error("Missing the deployed app service principal.");
  }
  return { env, principal };
}

export function initializeLakebase({ env, principal }) {
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/setup-lakebase.ts"],
    {
      stdio: "inherit",
      env: { ...process.env, ...env, APP_SERVICE_PRINCIPAL_ID: principal },
    },
  );
}
