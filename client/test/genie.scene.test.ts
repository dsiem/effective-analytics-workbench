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
import {
  PersistConversation,
  StopQuestion,
} from "../src/features/genie/commands";
import { Message } from "../src/features/genie/messages";
import type { Turn } from "../src/features/genie/model";
import { PanelReturnFocus } from "../src/features/genie/focus";
import { app, open } from "./app-scene";

const historySaved = Message.Persisted({ error: "" });
const send = role("button", { name: "Send question" });

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

const agentTurn = {
  id: "trip-count",
  question: "Count trips",
  mode: "agent",
  operation: {
    conversationId: "conversation",
    messageId: "message",
    mode: "agent",
  },
} as const;

test("stopping an Agent answer ends the wait and releases the composer", () => {
  const waiting = { ...agentTurn, state: "waiting" } satisfies Turn;
  const model = open("/genie");
  const stop = role("button", { name: "Stop" });
  scene(
    app,
    given({
      ...model,
      genieState: { ...model.genieState, turns: [waiting], genieMode: "agent" },
    }),
    click(stop),
    Command.resolveAll(
      [PersistConversation, historySaved],
      [
        StopQuestion({ turn: { ...agentTurn, state: "stopping" } }),
        Message.ChangedTurn({ turn: { ...agentTurn, state: "cancelled" } }),
      ],
      [PersistConversation, historySaved],
    ),
    expect(stop).toBeAbsent(),
    expect(text("Agent response stopped.")).toExist(),
    type(label("Ask a question about taxi data"), "Try a different question"),
    expect(send).toBeEnabled(),
  );
});
