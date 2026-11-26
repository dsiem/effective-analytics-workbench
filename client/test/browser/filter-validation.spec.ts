import { expect, test } from "@playwright/test";

const invalidQueries = [
  "from=2016-02-01&to=2016-01-01",
  "from=2016-02-30",
  "zip=invalid",
];
const dataEndpoints = new Set([
  "/api/overview",
  "/api/trip-map",
  "/api/trips",
  "/api/saved-views",
  "/api/genie",
]);

for (const [path, endpointAfterClear] of [
  ["/", "/api/overview"],
  ["/trips", "/api/trips"],
  ["/trip-map", "/api/trip-map"],
  ["/genie", null],
] as const) {
  for (const search of invalidQueries) {
    test(`${path} shows invalid filters (${search}) without querying unfiltered data`, async ({
      page,
    }) => {
      const dataRequests: string[] = [];
      page.on("request", (request) => {
        const { pathname } = new URL(request.url());
        if (dataEndpoints.has(pathname)) dataRequests.push(pathname);
      });
      await page.goto(`${path}?${search}`);
      const invalid = page.getByRole("heading", {
        name: "Invalid Explore filters",
      });
      await expect(invalid).toBeVisible();
      await expect(page.getByRole("alert")).toContainText(
        "start date must be on or before the end date",
      );
      expect(dataRequests).toEqual([]);
      await page.getByRole("button", { name: "Clear invalid filters" }).click();
      await expect(invalid).toBeHidden();
      await expect(page).toHaveURL(path);
      if (endpointAfterClear) {
        await expect.poll(() => dataRequests).toContain(endpointAfterClear);
      }
    });
  }
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
