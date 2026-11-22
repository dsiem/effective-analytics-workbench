import { defineConfig } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "3011";

export default defineConfig({
  testDir: "client/test/browser",
  ...(process.env.CI ? { workers: 2 } : {}),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "webkit",
      use: { browserName: "webkit" },
      testMatch: [
        "analysis-runs.spec.ts",
        "date-range.spec.ts",
        "explore-context.spec.ts",
        "filter-workflow.spec.ts",
        "foldkit.spec.ts",
        "gps-map.spec.ts",
        "saved-views-conflicts.spec.ts",
        "saved-views-pagination.spec.ts",
        "trip-comments.spec.ts",
        "ui.spec.ts",
      ],
    },
  ],
  webServer: {
    command: "node dist/server/src/main.js",
    url: `http://127.0.0.1:${port}/`,
    env: {
      DATABRICKS_APP_PORT: port,
      DATABRICKS_HOST: "https://127.0.0.1:1",
      DATABRICKS_TOKEN: "fixture-token",
      DATABRICKS_WAREHOUSE_ID: "",
      GENIE_SPACE_ID: "fixture-space",
      PGHOST: "",
      LAKEBASE_ENDPOINT: "",
    },
  },
  reporter: "list",
});
