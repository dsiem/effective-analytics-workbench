import { execFileSync } from "node:child_process";

export function databricksJson(...args) {
  const output = execFileSync("databricks", [...args, "-o", "json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Expected JSON from databricks ${args.join(" ")}.`);
  }
}

export function bundleTarget(script) {
  const target = process.env.DATABRICKS_BUNDLE_TARGET;
  if (!target || !process.env.DATABRICKS_HOST) {
    throw new Error(`Use databricks bundle run ${script} with a target.`);
  }
  return target;
}

export function bundleResources(target) {
  const summary = databricksJson(
    "bundle",
    "summary",
    "-t",
    target,
    "--force-pull",
  );
  if (!summary?.resources || typeof summary.resources !== "object") {
    throw new Error(`Missing deployed resources for bundle target ${target}.`);
  }
  return summary.resources;
}

export function deployedResourceId(resources, group, key) {
  const id = resources[group]?.[key]?.id;
  if (typeof id === "string" && id.trim()) return id;
  if (group === "jobs" && Number.isSafeInteger(id) && id > 0) return String(id);
  throw new Error(`Missing deployed resource ${group}.${key} in bundle state.`);
}

export function bundleApp(resources) {
  return databricksJson(
    "apps",
    "get",
    deployedResourceId(resources, "apps", "app"),
  );
}
