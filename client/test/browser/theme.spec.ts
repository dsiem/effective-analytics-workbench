import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // Theme behavior is independent of warehouse connectivity.
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, json: { message: "Offline theme review" } }),
  );
});

test("theme menu supports keyboard selection, navigation, persistence and prepaint", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/trips");
  const system = page.getByRole("button", {
    name: "Theme: System",
    exact: true,
  });
  await expect(system).toBeVisible();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(247, 248, 251)",
  );
  await system.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem")).toHaveText([
    "Dark",
    "Light",
    "System(selected)",
  ]);
  await expect(page.getByRole("menu")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(system).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  const dark = page.getByRole("button", { name: "Theme: Dark", exact: true });
  await expect(dark).toBeFocused();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(20, 24, 33)",
  );
  await expect(page.getByLabel("Pickup start date", { exact: true })).toHaveCSS(
    "color-scheme",
    "dark",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#141821",
  );
  await page.getByRole("link", { name: "Trip overview", exact: true }).click();
  await expect(dark).toBeVisible();
  await page.reload();
  await expect(dark).toBeVisible();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(20, 24, 33)",
  );

  // Stop the application bundle: the saved theme must already be set by the head script.
  await page.route("**/assets/index-*.js", (route) => route.abort());
  await page.reload();
  await expect(page.locator("#root")).toBeEmpty();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(20, 24, 33)",
  );
});

test("System follows appearance changes while explicit choices override them", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/genie");
  const system = page.getByRole("button", {
    name: "Theme: System",
    exact: true,
  });
  await expect(system).toBeVisible();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(20, 24, 33)",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(247, 248, 251)",
  );
  await system.click();
  await page.getByRole("menuitem", { name: "Light", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(
    page.getByRole("button", { name: "Theme: Light", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(247, 248, 251)",
  );
  await page.reload();
  await page.getByRole("button", { name: "Theme: Light", exact: true }).click();
  await page.getByRole("menuitem", { name: "System", exact: true }).click();
  await expect(system).toBeFocused();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(20, 24, 33)",
  );
});

for (const storage of ["invalid", "blocked"] as const) {
  test(`${storage} storage falls back to System and still permits switching`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript((storage) => {
      if (storage === "invalid")
        localStorage.setItem("databricks-effect-app.theme.v1", "invalid");
      else {
        for (const method of ["getItem", "setItem"]) {
          Object.defineProperty(Storage.prototype, method, {
            value: () => {
              throw new Error("Storage blocked");
            },
          });
        }
      }
    }, storage);
    await page.goto("/");
    await page
      .getByRole("button", { name: "Theme: System", exact: true })
      .click();
    await expect(page.locator("body")).toHaveCSS(
      "background-color",
      "rgb(20, 24, 33)",
    );
    await page.getByRole("menuitem", { name: "Light", exact: true }).click();
    await expect(page.locator("body")).toHaveCSS(
      "background-color",
      "rgb(247, 248, 251)",
    );
  });
}

test("Appearance stays in the sidebar when expanded or collapsed", async ({
  page,
}) => {
  await page.goto("/trips");
  const theme = page.getByRole("button", {
    name: "Theme: System",
    exact: true,
  });
  await expect(
    page.locator("header").getByRole("button", { name: /Theme:/ }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Theme: System", exact: true }),
  ).toHaveText("AppearanceSystem");
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await expect(theme).toBeVisible();
  expect((await theme.boundingBox())?.width).toBe(40);
  await theme.click();
  await expect(page.getByRole("menu")).toBeFocused();
  const sidebar = await page
    .getByRole("navigation", { name: "Main navigation" })
    .boundingBox();
  const menu = await page.getByRole("menu").boundingBox();
  expect(menu?.x).toBeGreaterThan((sidebar?.x ?? 0) + (sidebar?.width ?? 0));
  await page.keyboard.press("Escape");
  await expect(theme).toBeFocused();
});

test("mobile Appearance menu closes before the navigation drawer and survives resizing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/trips");
  const opener = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  await opener.click();
  const drawer = page.getByRole("dialog", { name: "Sidebar", exact: true });
  const theme = page.getByRole("button", {
    name: "Theme: System",
    exact: true,
  });
  await theme.click();
  await expect(page.getByRole("menu")).toBeFocused();
  await page.getByRole("menuitem", { name: "Dark", exact: true }).click();
  const dark = page.getByRole("button", { name: "Theme: Dark", exact: true });
  await expect(dark).toBeFocused();
  await expect(drawer).toBeVisible();
  await dark.click();
  await expect(page.getByRole("menu")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).not.toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(dark).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(page.getByRole("menu")).not.toBeVisible();
  await dark.click();
  await expect(page.getByRole("menu")).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("menu")).not.toBeVisible();
  await opener.click();
  await expect(dark).toBeVisible();
  await page
    .getByRole("button", { name: "Close navigation", exact: true })
    .click();
  await expect(opener).toBeFocused();
});
