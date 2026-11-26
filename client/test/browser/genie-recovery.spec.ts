import { expect, type Page, test } from "@playwright/test";

const operation = { conversationId: "conversation", messageId: "message" };
const messagePath = "/api/genie/conversation/messages/message";
const reply = {
  ...operation,
  text: "Recovered answer",
  queries: [
    {
      sql: "SELECT 21932",
      description: "Trip count",
      columns: ["total_trips"],
      rows: [["21932"]],
      truncated: false,
    },
  ],
};
async function send(page: Page) {
  await page.getByLabel("Ask a question about taxi data").fill("Count trips");
  await page
    .getByRole("button", { name: "Send question", exact: true })
    .click();
}

test("result retry survives navigation and reload, and follow-ups reuse the conversation", async ({
  page,
}) => {
  const submissions: unknown[] = [];
  let downloads = 0;
  await page.route("**/api/genie", (route) => {
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ json: operation });
  });
  await page.route(`**${messagePath}`, (route) =>
    route.fulfill({
      json: { ...operation, state: "completed", status: "COMPLETED" },
    }),
  );
  await page.route(`**${messagePath}/result`, (route) => {
    downloads++;
    return route.fulfill(
      downloads === 1
        ? {
            status: 502,
            json: { error: { message: "Result download failed" } },
          }
        : { json: reply },
    );
  });
  await page.goto("/genie?zip=10001");
  await send(page);
  await expect(
    page.getByRole("button", { name: "Retry result download" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Trip explorer", exact: true }).click();
  await page
    .locator("header")
    .getByRole("button", { name: "Ask Genie", exact: true })
    .click();
  await page.reload();
  await page
    .locator("header")
    .getByRole("button", { name: "Ask Genie", exact: true })
    .click();
  await expect(page.getByText("Count trips", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry result download" }).click();
  await expect(
    page.getByRole("cell", { name: "21932", exact: true }),
  ).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(downloads).toBe(2);
  await page.getByLabel("Ask a question about taxi data").fill("Count again");
  await page
    .getByRole("button", { name: "Send question", exact: true })
    .click();
  await expect(page.getByRole("table")).toHaveCount(2);
  expect(submissions[1]).toMatchObject({ conversationId: "conversation" });
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await page.reload();
  await page
    .locator("header")
    .getByRole("button", { name: "Ask Genie", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "What caught your eye?" }),
  ).toBeVisible();
});

test("pending answers resume after reload without resubmission", async ({
  page,
}) => {
  let submissions = 0;
  let complete = false;
  await page.route("**/api/genie", (route) => {
    submissions++;
    return route.fulfill({ json: operation });
  });
  await page.route(`**${messagePath}`, (route) =>
    route.fulfill({
      json: {
        ...operation,
        state: complete ? "completed" : "pending",
        status: complete ? "COMPLETED" : "EXECUTING_QUERY",
      },
    }),
  );
  await page.route(`**${messagePath}/result`, (route) =>
    route.fulfill({ json: reply }),
  );
  await page.goto("/genie");
  await send(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        sessionStorage.getItem("databricks-effect-app.genie.v1"),
      ),
    )
    .toContain('"state":"waiting"');
  complete = true;
  await page.reload();
  await expect(
    page.getByRole("cell", { name: "21932", exact: true }),
  ).toBeVisible();
  expect(submissions).toBe(1);
});

for (const { hasAnswer, count, noticeText } of [
  {
    hasAnswer: true,
    count: 1,
    noticeText: "Genie returned an attachment this app can’t display.",
  },
  {
    hasAnswer: false,
    count: 2,
    noticeText: "Genie returned 2 attachments this app can’t display.",
  },
]) {
  test(
    hasAnswer
      ? "a partial Genie answer keeps its text, results, and attachment warning after reload"
      : "a warning-only Genie answer stays visible after reload",
    async ({ page }) => {
      let submissions = 0;
      let downloads = 0;
      await page.route("**/api/**", (route) => route.fulfill({ status: 404 }));
      await page.route("**/api/genie", (route) => {
        submissions++;
        return route.fulfill({ json: operation });
      });
      await page.route(`**${messagePath}`, (route) =>
        route.fulfill({
          json: { ...operation, state: "completed", status: "COMPLETED" },
        }),
      );
      await page.route(`**${messagePath}/result`, (route) => {
        downloads++;
        return route.fulfill({
          json: {
            ...operation,
            text: hasAnswer ? reply.text : "",
            queries: hasAnswer ? reply.queries : [],
            warning: { kind: "unsupported-attachments", count },
          },
        });
      });

      const notice = page.getByRole("status").filter({ hasText: noticeText });
      const checkAnswer = async () => {
        await expect(notice).toBeVisible();
        if (hasAnswer) {
          await expect(
            page.getByText(reply.text, { exact: true }),
          ).toBeVisible();
          await expect(page.getByRole("cell", { name: "21932" })).toBeVisible();
        } else {
          await expect(
            page.getByText("Query results", { exact: true }),
          ).toHaveCount(0);
          await expect(page.getByRole("table")).toHaveCount(0);
        }
      };

      await page.goto("/genie");
      await send(page);
      await checkAnswer();
      await page.reload();
      await checkAnswer();
      expect(submissions).toBe(1);
      expect(downloads).toBe(1);
    },
  );
}

test("submission responses are saved when navigating away before acceptance", async ({
  page,
}) => {
  let submissions = 0;
  let accept: () => void = () => {};
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  await page.route("**/api/genie", async (route) => {
    submissions++;
    await accepted;
    await route.fulfill({ json: operation });
  });
  await page.route(`**${messagePath}`, (route) =>
    route.fulfill({
      json: { ...operation, state: "completed", status: "COMPLETED" },
    }),
  );
  await page.route(`**${messagePath}/result`, (route) =>
    route.fulfill({ json: reply }),
  );
  await page.goto("/genie");
  await send(page);
  await expect.poll(() => submissions).toBe(1);
  await page.getByRole("link", { name: "Trip explorer", exact: true }).click();
  accept();
  await expect
    .poll(() =>
      page.evaluate(() =>
        sessionStorage.getItem("databricks-effect-app.genie.v1"),
      ),
    )
    .toContain('"messageId":"message"');
  await page
    .locator("header")
    .getByRole("button", { name: "Ask Genie", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "21932", exact: true }),
  ).toBeVisible();
  expect(submissions).toBe(1);
});

test("reload during an uncertain submission never silently resubmits", async ({
  page,
}) => {
  let submissions = 0;
  await page.route("**/api/genie", (route) => {
    submissions++;
    return route.abort("failed");
  });
  await page.goto("/genie");
  await send(page);
  await expect(page.getByRole("alert")).toContainText("may have been accepted");
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("may have been accepted");
  await expect(page.getByRole("button", { name: "Edit question" })).toHaveCount(
    0,
  );
  expect(submissions).toBe(1);
});

for (const { name, status, error } of [
  {
    name: "permission",
    status: 403,
    error: {
      code: "permission_denied",
      message: "Even Genie needs permission to send this question.",
    },
  },
  {
    name: "Agent mode unavailable",
    status: 503,
    error: {
      code: "genie_agent_mode_unavailable",
      message:
        "Agent mode is disabled in this Databricks workspace. Select Chat.",
    },
  },
] as const) {
  test(`${name} rejection survives reload and allows an explicit corrected submission`, async ({
    page,
  }) => {
    const submissions: Record<string, unknown>[] = [];
    await page.route("**/api/genie", (route) => {
      submissions.push(route.request().postDataJSON());
      return route.fulfill(
        submissions.length === 1
          ? { status, json: { error } }
          : { json: operation },
      );
    });
    await page.route(`**${messagePath}`, (route) =>
      route.fulfill({
        json: { ...operation, state: "completed", status: "COMPLETED" },
      }),
    );
    await page.route(`**${messagePath}/result`, (route) =>
      route.fulfill({ json: reply }),
    );
    await page.goto("/genie");
    if (name === "Agent mode unavailable")
      await page.getByLabel("Genie mode").selectOption("agent");
    await send(page);
    const expectedMessage =
      name === "permission"
        ? error.message
        : `The question was rejected. ${error.message}`;
    await expect(page.getByRole("alert")).toHaveText(expectedMessage);
    await expect(page.getByRole("alert")).not.toContainText(
      "may have been accepted",
    );
    await page.reload();
    await expect(page.getByRole("alert")).toHaveText(expectedMessage);
    await expect(
      page.getByRole("alert").locator('svg[aria-hidden="true"]'),
    ).toHaveCount(name === "permission" ? 1 : 0);
    expect(submissions).toHaveLength(1);
    if (name === "Agent mode unavailable") {
      expect(submissions[0]).toMatchObject({ mode: "agent" });
      await page.getByRole("button", { name: "Retry in Chat" }).click();
      await expect(
        page.getByRole("cell", { name: "21932", exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel("Genie mode")).toHaveValue("chat");
      expect(submissions).toHaveLength(2);
      expect(submissions[1]).toEqual({ ...submissions[0], mode: "chat" });
      return;
    }
    await expect(
      page.getByRole("button", { name: "Retry in Chat" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Edit question" }).click();
    const composer = page.getByLabel("Ask a question about taxi data");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Count trips");
    await composer.fill("Count trips by hour");
    await page
      .getByRole("button", { name: "Send question", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "21932", exact: true }),
    ).toBeVisible();
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toMatchObject({ content: "Count trips by hour" });
    expect(submissions[1]).not.toHaveProperty("mode");
  });
}

for (const step of ["poll", "result"] as const) {
  test(`permission denied during Genie ${step} ends the turn and survives reload`, async ({
    page,
  }) => {
    const message =
      "This conversation is under lock. You need permission to read Genie’s answer.";
    const denied = {
      status: 403,
      json: { error: { code: "permission_denied", message } },
    };
    let polls = 0;
    await page.route("**/api/genie", (route) =>
      route.fulfill({ json: operation }),
    );
    await page.route(`**${messagePath}`, (route) => {
      polls++;
      return route.fulfill(
        step === "poll"
          ? denied
          : {
              json: { ...operation, state: "completed", status: "COMPLETED" },
            },
      );
    });
    await page.route(`**${messagePath}/result`, (route) =>
      route.fulfill(denied),
    );
    await page.goto("/genie");
    await send(page);
    await expect(page.getByRole("alert")).toHaveText(message);
    await page.reload();
    await expect(page.getByRole("alert")).toHaveText(message);
    await expect(
      page.getByRole("button", { name: /Resume answer|Retry result download/ }),
    ).toHaveCount(0);
    expect(polls).toBe(1);
  });
}

test("Chat and Agent mode use separate follow-up conversations", async ({
  page,
}) => {
  const agent = {
    conversationId: "agent-conversation",
    messageId: "response",
    mode: "agent",
  };
  const submissions: unknown[] = [];
  await page.route("**/api/genie", async (route) => {
    const payload = route.request().postDataJSON();
    submissions.push(payload);
    await route.fulfill({ json: payload.mode === "agent" ? agent : operation });
  });
  await page.route(`**${messagePath}`, (route) =>
    route.fulfill({
      json: { ...operation, state: "completed", status: "COMPLETED" },
    }),
  );
  await page.route(`**${messagePath}/result`, (route) =>
    route.fulfill({ json: reply }),
  );
  await page.route(
    /\/api\/genie\/agent-conversation\/messages\/response(\/result)?\?mode=agent$/,
    (route) =>
      route.fulfill({
        json: route.request().url().includes("/result?")
          ? { ...agent, text: "Agent report", queries: [] }
          : { ...agent, state: "completed", status: "completed" },
      }),
  );

  await page.goto("/genie?zip=10001");
  await send(page);
  await expect(page.getByText("Recovered answer", { exact: true })).toHaveCount(
    1,
  );
  await page.getByLabel("Genie mode").selectOption("agent");
  await send(page);
  await expect(page.getByText("Agent report", { exact: true })).toHaveCount(1);
  expect(submissions[1]).toMatchObject({ mode: "agent" });
  expect(submissions[1]).not.toHaveProperty("conversationId");

  await page.reload();
  await expect(page.getByLabel("Genie mode")).toHaveValue("agent");
  await send(page);
  await expect(page.getByText("Agent report", { exact: true })).toHaveCount(2);
  expect(submissions[2]).toMatchObject({
    mode: "agent",
    conversationId: agent.conversationId,
  });

  await page.getByLabel("Genie mode").selectOption("chat");
  await send(page);
  await expect(page.getByText("Recovered answer", { exact: true })).toHaveCount(
    2,
  );
  expect(submissions[3]).toMatchObject({
    conversationId: operation.conversationId,
  });
  expect(submissions[3]).not.toHaveProperty("mode");
});

test("Agent mode shows live progress and resumes with the accepted response after reload", async ({
  page,
}) => {
  const agent = { ...operation, mode: "agent" };
  let submissions = 0;
  let polls = 0;
  await page.route("**/api/genie", (route) => {
    submissions++;
    return route.fulfill({ json: agent });
  });
  await page.route(`**${messagePath}?mode=agent`, (route) => {
    polls++;
    return route.fulfill({
      json: {
        ...agent,
        ...(polls < 3
          ? {
              state: "pending",
              status: "in_progress",
              phase: polls === 1 ? "running-sql" : "preparing-report",
            }
          : { state: "completed", status: "completed" }),
      },
    });
  });
  await page.route(`**${messagePath}/result?mode=agent`, (route) =>
    route.fulfill({
      json: { ...agent, text: "Completed Agent report", queries: [] },
    }),
  );

  await page.goto("/genie");
  await page.getByLabel("Genie mode").selectOption("agent");
  await send(page);
  await expect(
    page.getByRole("status").filter({ hasText: "Running SQL" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Preparing the report" }),
  ).toBeVisible({ timeout: 8_000 });
  await page.reload();
  await expect(
    page.getByText("Completed Agent report", { exact: true }),
  ).toBeVisible();
  expect(submissions).toBe(1);
});
