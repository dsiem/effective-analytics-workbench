import { test } from "node:test";
import type { SavedView } from "@dsiem/analytics-shared/saved-views";
import { Dialog, Popover } from "@foldkit/ui";
import {
  click,
  Command,
  expect,
  given,
  label,
  Mount,
  role,
  scene,
  text,
  type,
  within,
} from "foldkit/scene";
import {
  CreateSavedViewDraft,
  LoadSavedViewShortcuts,
  LoadSavedViews,
  PersistRecentSavedViews,
  RememberRecentSavedView,
  SaveSavedView,
} from "../src/features/saved-views/commands";
import { Message } from "../src/features/saved-views/messages";
import { fail, succeed } from "../src/lib/command-result";
import { app, followNavigation, open } from "./app-scene";
import { airportView } from "./saved-view-fixture";

const button = (name: string) => role("button", { name });
const form = role("form", { name: "Filters" });
const picker = role("dialog", { name: "Saved views" });
const trigger = button("Saved views");
const option = button("Open saved view for Airport pickups");
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

const loadShortcuts = (version: number, rows: readonly SavedView[]) =>
  Command.resolveAll(
    [
      LoadSavedViewShortcuts,
      Message.LoadedSavedViewShortcuts({
        version,
        recentIds: [],
        result: succeed({ rows, recents: [] }),
      }),
    ],
    [PersistRecentSavedViews, Message.CompletedPersistRecentSavedViews()],
  );

const openPicker = (version: number) => [
  click(trigger),
  Command.resolveAll(
    [Popover.LockScroll, Popover.Message.CompletedLockScroll()],
    [Popover.InertOthers, Popover.Message.CompletedInertOthers()],
  ),
  Mount.resolve(
    Popover.AnchorPopover,
    Popover.Message.CompletedAnchorPopover(),
  ),
  Mount.resolve(
    Popover.PortalPopoverBackdrop,
    Popover.Message.CompletedPortalPopoverBackdrop(),
  ),
  loadShortcuts(version, [airportView]),
];

const closePicker = Command.resolveAll(
  [Popover.UnlockScroll, Popover.Message.CompletedUnlockScroll()],
  [Popover.RestoreInert, Popover.Message.CompletedRestoreInert()],
  [Popover.FocusButton, Popover.Message.CompletedFocusButton()],
);

const followPickerNavigation = (href: string) => {
  const [complete, navigate] = followNavigation(href);
  return [
    complete,
    Mount.expectEnded(Popover.AnchorPopover, Popover.PortalPopoverBackdrop),
    navigate,
  ];
};

function cancelSearch(version: number) {
  const cancelled = Message.CompletedCancelLoadSavedViews({
    version,
    more: false,
    debounce: false,
  });
  return Command.resolve(
    LoadSavedViews.Interrupt(() => cancelled),
    cancelled,
  );
}

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

test("opening a saved view updates filters in place and All trips clears them", () => {
  const href = "/trips?from=2016-01-10&to=2016-01-20&zip=11430";
  scene(
    app,
    given(open("/trips?zip=10001")),
    ...openPicker(1),
    click(option),
    cancelSearch(1),
    closePicker,
    Command.resolve(
      RememberRecentSavedView,
      Message.CompletedRememberRecentSavedView(),
    ),
    ...followPickerNavigation(href),
    expect(picker).toBeAbsent(),
    expect(label("Pickup start date")).toHaveValue("2016-01-10"),
    expect(label("Pickup end date")).toHaveValue("2016-01-20"),
    expect(zip).toHaveValue("11430"),
    expect(trigger).toContainText("Airport pickups"),
    ...openPicker(3),
    expect(option).toContainText("Applied"),
    click(button("Show all trips")),
    cancelSearch(2),
    closePicker,
    ...followPickerNavigation("/trips"),
    expect(trigger).toContainText("All trips"),
    expect(zip).toHaveValue(""),
  );
});

test("reopening an already applied view discards unapplied edits", () => {
  const href = "/trips?from=2016-01-10&to=2016-01-20&zip=11430";
  scene(
    app,
    given(open(href)),
    type(zip, "10002"),
    ...openPicker(1),
    click(option),
    cancelSearch(1),
    closePicker,
    Command.resolve(
      RememberRecentSavedView,
      Message.CompletedRememberRecentSavedView(),
    ),
    ...followPickerNavigation(href),
    expect(zip).toHaveValue("11430"),
    expect(text("Unapplied changes")).toBeAbsent(),
    expect(save).toBeEnabled(),
  );
});

for (const removed of [false, true]) {
  test(`a ${removed ? "removed" : "changed"} saved view preserves the stale editor draft`, () => {
    const dialog = role("dialog", { name: "Edit saved view" });
    const finding = within(dialog, label("Finding (optional)"));
    const edit = button("Edit Airport pickups");
    const draft = {
      id: airportView.id,
      title: airportView.title,
      body: "My unsaved draft",
      filters: airportView.filters,
      version: airportView.version,
    };
    const error = removed
      ? "This saved view has been removed."
      : "This saved view changed since you opened it.";
    scene(
      app,
      given(open("/trips?zip=10001")),
      ...openPicker(1),
      click(edit),
      ...showEditor,
      type(finding, draft.body),
      click(within(dialog, button("Save view"))),
      Command.resolve(
        SaveSavedView({ draft }),
        Message.SavedViewSaved({ result: fail(error) }),
      ),
      cancelSearch(1),
      loadShortcuts(
        2,
        removed
          ? []
          : [{ ...airportView, body: "Another editor's content", version: 2 }],
      ),
      expect(within(dialog, role("alert"))).toHaveText(error),
      expect(finding).toHaveValue(draft.body),
      click(within(dialog, button("Cancel"))),
      ...closeEditor,
      Mount.expectEnded(Dialog.AcquireResources),
      ...(removed
        ? [expect(role("heading", { name: "No saved views" })).toExist()]
        : [
            click(edit),
            ...showEditor,
            expect(finding).toHaveValue("Another editor's content"),
          ]),
    );
  });
}

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
