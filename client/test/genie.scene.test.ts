import { test } from "node:test";
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
} from "foldkit/scene";
import { Focus } from "../src/app/commands";
import { Message as AppMessage } from "../src/app/message";
import { Message } from "../src/features/genie/messages";
import { PanelReturnFocus } from "../src/features/genie/focus";
import { app, open } from "./app-scene";

test("Genie shows the applied Records scope while a different ZIP is still a draft", () => {
  const context = role("region", {
    name: "Explore view for your next question",
  });
  scene(
    app,
    given(open("/trips?from=2016-01-10&to=2016-01-20&zip=10001")),
    type(label("Pickup ZIP code"), "10002"),
    expect(text("Unapplied changes")).toExist(),
    click(role("button", { name: "Ask Genie" })),
    Mount.resolve(PanelReturnFocus, Message.MountedPanelReturnFocus()),
    Command.resolve(Focus, AppMessage.CompletedFocus()),
    expect(context).toContainText("Jan 10, 2016 – Jan 20, 2016"),
    expect(context).toContainText("Pickup ZIP 10001"),
    expect(context).toContainText("Applied filters included."),
  );
});
