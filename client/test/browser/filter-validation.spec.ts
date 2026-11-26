import { expect, test } from "@playwright/test";

for (const [path, search] of [
  ["/", "from=2016-02-01&to=2016-01-01"],
  ["/trips", "from=2016-02-30"],
  ["/trip-map", "zip=invalid"],
  ["/genie", "zip=invalid"],
] as const) {
  test(`${path} shows invalid filters (${search}) without querying unfiltered data`, async ({
    page,
  }) => {
    const dataRequests: string[] = [];
    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      if (
        [
          "/api/overview",
          "/api/trip-map",
          "/api/trips",
          "/api/saved-views",
          "/api/genie",
        ].includes(url.pathname)
      )
        dataRequests.push(url.pathname);
      return route.continue();
    });
    await page.goto(`${path}?${search}`);
    await expect(
      page.getByRole("heading", { name: "Invalid Explore filters" }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(
      "start date must be on or before the end date",
    );
    expect(dataRequests).toEqual([]);
    await page.getByRole("button", { name: "Clear invalid filters" }).click();
    await expect(
      page.getByRole("heading", { name: "Invalid Explore filters" }),
    ).not.toBeVisible();
    await expect(page).toHaveURL(path);
    if (path !== "/genie") {
      const expected =
        path === "/trips"
          ? "/api/trips"
          : path === "/trip-map"
            ? "/api/trip-map"
            : "/api/overview";
      await expect.poll(() => dataRequests).toContain(expected);
    }
  });
}

test("navigation preserves invalid filters until corrected and Apply can repair them", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/api/overview**", (route) => {
    requests.push(route.request().url());
    return route.continue();
  });
  await page.goto("/trips?zip=invalid");
  await expect(
    page.getByRole("heading", { name: "Invalid Explore filters" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Trip overview", exact: true }).click();
  await expect(page).toHaveURL("/?zip=invalid");
  await expect(
    page.getByRole("heading", { name: "Invalid Explore filters" }),
  ).toBeVisible();
  expect(requests).toEqual([]);
  await page
    .getByRole("textbox", { name: "Pickup ZIP code", exact: true })
    .fill("10001");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL("/?zip=10001");
  await expect.poll(() => requests.length).toBe(1);
  expect(new URL(requests[0] ?? "").searchParams.get("zip")).toBe("10001");
});
