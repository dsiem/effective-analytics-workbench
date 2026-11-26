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
  Subscription,
  text,
  type,
} from "foldkit/scene";
import * as Features from "../src/app/features";
import { Focus } from "../src/app/commands";
import { Message as AppMessage } from "../src/app/message";
import {
  CreateQuestion,
  PersistConversation,
  RetrieveQuestion,
  StopQuestion,
  SubmitQuestion,
} from "../src/features/genie/commands";
import { Message } from "../src/features/genie/messages";
import type { Turn } from "../src/features/genie/model";
import { PanelReturnFocus } from "../src/features/genie/focus";
import { app, open } from "./app-scene";

const operation = { conversationId: "conversation", messageId: "message" };
const snapshot = {
  question: "Count trips",
  filters: { from: "2016-01-10", to: "2016-01-20", zip: "10001" },
  context: { page: "trips", title: "Trip records" } as const,
};
const turn = { id: "trip-count", ...snapshot };
const historySaved = Message.Persisted({ error: "" });
const send = role("button", { name: "Send question" });

test("Genie displays the applied Records scope and uses it for the entire question", () => {
  const context = role("region", {
    name: "Explore view for your next question",
  });
  const reply = { ...operation, text: "Filtered trip count", queries: [] };
  scene(
    app,
    given(open("/trips?from=2016-01-10&to=2016-01-20&zip=10001")),
    click(role("button", { name: "Ask Genie" })),
    Mount.resolve(PanelReturnFocus, Message.MountedPanelReturnFocus()),
    Command.resolve(
      Focus({ selector: "#genie-composer" }),
      AppMessage.CompletedFocus(),
    ),
    expect(context).toContainText("Jan 10, 2016 – Jan 20, 2016"),
    expect(context).toContainText("Pickup ZIP 10001"),
    expect(context).toContainText("Applied filters included."),
    type(label("Ask a question about taxi data"), "Count trips"),
    click(send),
    Command.resolve(CreateQuestion(snapshot), Message.CreatedTurn(turn)),
    Command.resolveAll(
      [PersistConversation, historySaved],
      [
        SubmitQuestion({
          turn: { ...turn, state: "submitting" },
          conversation: null,
        }),
        Message.ChangedTurn({ turn: { ...turn, state: "waiting", operation } }),
      ],
      [PersistConversation, historySaved],
    ),
    Subscription.emit(
      Features.genie.toParentMessage(
        Message.PolledQuestion({
          id: turn.id,
          operation,
          generation: 1,
          outcome: { state: "retrieving" },
        }),
      ),
    ),
    Command.resolveAll(
      [PersistConversation, historySaved],
      [
        RetrieveQuestion,
        Message.ChangedTurn({ turn: { ...turn, state: "complete", reply } }),
      ],
      [PersistConversation, historySaved],
    ),
    expect(text("Filtered trip count")).toExist(),
    click(role("button", { name: "Close Genie" })),
    Mount.expectEnded(PanelReturnFocus),
    expect(role("heading", { name: "Trip records" })).toExist(),
    expect(label("Pickup ZIP code")).toHaveValue("10001"),
  );
});

const agentTurn = {
  ...turn,
  mode: "agent",
  operation: { ...operation, mode: "agent" },
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
