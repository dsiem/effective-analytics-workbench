import { test } from "node:test";
import { Dialog } from "@foldkit/ui";
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
  within,
} from "foldkit/scene";
import {
  CreateSavedViewDraft,
  SaveSavedView,
} from "../src/features/saved-views/commands";
import { Message } from "../src/features/saved-views/messages";
import { succeed } from "../src/lib/command-result";
import { app, followNavigation, open } from "./app-scene";
import { airportView } from "./saved-view-fixture";

const button = (name: string) => role("button", { name });
const form = role("form", { name: "Filters" });
const trigger = button("Saved views");
const save = within(form, button("Save view"));
const zip = label("Pickup ZIP code");

const showEditor = [
  Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
  Mount.resolve(
    Dialog.AcquireResources,
    Dialog.Message.SucceededAcquireResources(),
  ),
];

const closeEditor = [
  Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
  Mount.expectEnded(Dialog.AcquireResources),
];

test("only applied edits can be saved, and saving keeps the applied filters", () => {
  const dialog = role("dialog", { name: "What would you call this view?" });
  const draft = {
    id: airportView.id,
    title: "Fare review",
    body: "",
    filters: { zip: "10002" },
    version: null,
  };
  scene(
    app,
    given(open("/trips?zip=10001")),
    expect(button("Apply")).toBeDisabled(),
    type(zip, "10002"),
    expect(role("status")).toContainText("Unapplied changes"),
    expect(role("status")).toContainText("Pickup ZIP 10001"),
    expect(save).toBeDisabled(),
    click(button("Apply")),
    ...followNavigation("/trips?zip=10002"),
    click(save),
    Command.resolve(
      CreateSavedViewDraft,
      Message.CreatedSavedView({ id: draft.id }),
    ),
    ...showEditor,
    type(within(dialog, label("View name")), draft.title),
    click(within(dialog, button("Save view"))),
    Command.resolve(
      SaveSavedView({ draft }),
      Message.SavedViewSaved({
        result: succeed({ ...airportView, ...draft, version: 1 }),
      }),
    ),
    ...closeEditor,
    expect(dialog).toBeAbsent(),
    expect(trigger).toContainText("Fare review"),
  );
});

for (const [query, dates] of [
  ["", "All dates"],
  ["?from=2016-01-10", "From Jan 10, 2016"],
  ["?to=2016-01-20", "Through Jan 20, 2016"],
] as const) {
  test(`the saved-view editor summarizes the scope (${dates})`, () => {
    const dialog = role("dialog", { name: "What would you call this view?" });
    scene(
      app,
      given(open(`/trips${query}`)),
      click(save),
      Command.resolve(
        CreateSavedViewDraft,
        Message.CreatedSavedView({ id: airportView.id }),
      ),
      ...showEditor,
      expect(dialog).toContainText(dates),
      expect(dialog).toContainText("All pickup areas"),
    );
  });
}
