import { expect, test } from "@playwright/test";

const operation = {
  conversationId: "agent-conversation",
  messageId: "agent-response",
  mode: "agent",
  grant: "test-agent-grant",
};
const messagePath = "/api/genie/agent-conversation/messages/agent-response";
const cancelPath =
  "/api/genie/agent-conversation/responses/agent-response/cancel";
const stopped = { ...operation, status: "CANCELLED", state: "cancelled" };
const complete = { ...operation, status: "COMPLETED", state: "completed" };

for (const scenario of [
  "confirmed",
  "completed first",
  "response lost",
] as const) {
  test(`Stopping an Agent response handles ${scenario}`, async ({ page }) => {
    let submissions = 0;
    let stopRequests = 0;
    await page.route("**/api/genie", (route) => {
      submissions++;
      return route.fulfill({ json: operation });
    });
    await page.route(`**${messagePath}?mode=agent`, (route) => {
      expect(route.request().headers()["x-genie-access"]).toBe(operation.grant);
      return route.fulfill({
        json: stopRequests
          ? stopped
          : { ...operation, status: "in_progress", state: "pending" },
      });
    });
    await page.route(`**${messagePath}/result?mode=agent`, (route) =>
      route.fulfill({
        json: {
          ...operation,
          text: "Completed before Stop took effect.",
          queries: [],
        },
      }),
    );
    await page.route(`**${cancelPath}`, (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-genie-access"]).toBe(operation.grant);
      stopRequests++;
      return scenario === "response lost"
        ? route.abort("failed")
        : route.fulfill({
            json: scenario === "confirmed" ? stopped : complete,
          });
    });

    await page.goto("/genie");
    await page.getByLabel("Genie mode").selectOption("agent");
    const composer = page.getByLabel("Ask a question about taxi data");
    const send = page.getByRole("button", {
      name: "Send question",
      exact: true,
    });
    await composer.fill("Count trips");
    await send.click();
    if (scenario === "confirmed") {
      await composer.fill("Compare fares");
      await expect(send).toBeDisabled();
    }
    await page.getByRole("button", { name: "Stop", exact: true }).click();

    if (scenario === "response lost") {
      await expect(page.getByRole("alert")).toContainText(
        "Stop could not be confirmed",
      );
      await page.reload();
      await page.getByRole("button", { name: "Resume answer" }).click();
    }
    await expect(
      page.getByText(
        scenario === "completed first"
          ? "Completed before Stop took effect."
          : "Agent response stopped.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "New conversation", exact: true }),
    ).toBeEnabled();
    if (scenario === "confirmed") {
      await expect(composer).toHaveValue("Compare fares");
      await expect(send).toBeEnabled();
    }
    expect(submissions).toBe(1);
    expect(stopRequests).toBe(1);
  });
}
