import { test } from "node:test";
import {
  click,
  Command,
  expect,
  given,
  label,
  role,
  scene,
  type,
  within,
} from "foldkit/scene";
import { app, followNavigation, withDataset } from "./app-scene";

const apply = role("button", { name: "Apply" });
const start = label("Pickup start date");
const end = label("Pickup end date");
const zip = label("Pickup ZIP code");
const filterAlert = within(role("form", { name: "Filters" }), role("alert"));

test("clearing both dates preserves the applied ZIP", () => {
  scene(
    app,
    given(withDataset("/trips?from=2016-01-10&to=2016-01-20&zip=10001")),
    type(start, ""),
    type(end, ""),
    click(apply),
    ...followNavigation("/trips?zip=10001"),
    expect(start).toHaveValue(""),
    expect(end).toHaveValue(""),
    expect(zip).toHaveValue("10001"),
  );
});

for (const [query, from, to] of [
  ["from=2016-01-10", "2016-01-10", ""],
  ["to=2016-02-20", "", "2016-02-20"],
] as const) {
  test(`an open date range survives a direct link (${query})`, () => {
    scene(
      app,
      given(withDataset(`/trips?${query}`)),
      expect(start).toHaveValue(from),
      expect(end).toHaveValue(to),
      expect(apply).toBeDisabled(),
    );
  });
}

for (const [bound, from, to] of [
  ["before the dataset starts", "2016-01-02", "2016-02-25"],
  ["after the dataset ends", "2016-01-03", "2016-02-26"],
] as const) {
  test(`rejects a date ${bound} and accepts the dataset boundaries`, () => {
    scene(
      app,
      given(withDataset("/trips?zip=10001")),
      type(start, from),
      type(end, to),
      click(apply),
      Command.expectNone(),
      expect(filterAlert).toExist(),
      type(start, "2016-01-03"),
      type(end, "2016-02-25"),
      click(apply),
      ...followNavigation("/trips?from=2016-01-03&to=2016-02-25&zip=10001"),
      expect(filterAlert).toBeAbsent(),
      expect(apply).toBeDisabled(),
    );
  });
}
