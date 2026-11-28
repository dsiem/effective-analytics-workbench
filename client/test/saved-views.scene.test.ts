import { test } from "node:test";
import assert from "node:assert/strict";
import { Dialog } from "@foldkit/ui";
import { Option } from "effect";
import {
  click,
  Command,
  expect,
  given,
  label,
  Mount,
  role,
  scene,
  type,
  text,
  within,
} from "foldkit/scene";
import { writes } from "../src/features/saved-views/workflow";
import { app, open } from "./app-scene";
import { airportView } from "./saved-view-fixture";

const button = (name: string) => role("button", { name });
const form = role("form", { name: "Filters" });
const save = within(form, button("Save view"));
const zip = label("Pickup ZIP code");

const showEditor = [
  Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
  Mount.resolve(
    Dialog.AcquireResources,
    Dialog.Message.SucceededAcquireResources(),
  ),
];

test("restoring the applied ZIP by typing makes the view saveable again", () => {
  const pending = within(form, text("Unapplied changes"));
  scene(
    app,
    given(open("/trips?zip=10001")),
    type(zip, "10002"),
    expect(pending).toExist(),
    expect(within(form, role("status"))).toContainText("Pickup ZIP 10001"),
    expect(save).toBeDisabled(),
    type(zip, "10001"),
    expect(pending).toBeAbsent(),
    expect(save).toBeEnabled(),
    expect(within(form, button("Apply"))).toBeDisabled(),
  );
});

for (const [query, dates] of [
  ["", "All dates"],
  ["?from=2016-01-10", "From Jan 10, 2016"],
  ["?to=2016-01-20", "Through Jan 20, 2016"],
] as const) {
  test(`the saved-view editor summarizes the scope (${dates})`, () => {
    const dialog = role("dialog", { name: "What would you call this view?" });
    const model = open(`/trips${query}`);
    const filters = Option.getOrThrow(model.location.filters);
    const writing = writes.update(
      model.savedViewsState.writes,
      writes.Message.New({ input: filters }),
    );
    const prepare = writing.commands?.[0];
    assert.ok(prepare);
    scene(
      app,
      given(model),
      click(save),
      Command.resolve(
        prepare,
        writes.Message.DraftPrepared({
          generation: writing.model.generation,
          draft: {
            id: airportView.id,
            filters,
            title: "",
            body: "",
            version: null,
          },
        }),
      ),
      ...showEditor,
      expect(dialog).toContainText(dates),
      expect(dialog).toContainText("All pickup areas"),
    );
  });
}
