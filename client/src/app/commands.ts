import { readFramePreferences } from "@dsiem/workbench-ui/workspace-frame";
import { Effect, Schema } from "effect";
import { Calendar, Command, Dom } from "foldkit";
import { request } from "../lib/api-client";
import { result } from "../lib/command-result";
import { Message as M } from "./message";
export const RestoreWorkspace = Command.define("RestoreWorkspace", {
  messages: [M.Booted],
  execute: Effect.sync(() => M.Booted(readFramePreferences())),
});
export const Focus = Command.define("Focus", {
  args: { selector: Schema.String },
  messages: [M.CompletedFocus],
  execute: ({ selector }) =>
    Dom.focus(selector).pipe(Effect.ignore, Effect.as(M.CompletedFocus())),
});
export const FocusAnalysisHeading = Command.define("FocusAnalysisHeading", {
  messages: [M.CompletedFocusAnalysisHeading],
  execute: Dom.focus("#analysis-heading").pipe(
    Effect.ignore,
    Effect.as(M.CompletedFocusAnalysisHeading()),
  ),
});
export const LoadMetadata = Command.define("LoadMetadata", {
  messages: [M.LoadedMetadata],
  execute: Effect.all({
    result: result(request((client) => client.analytics.metadata())),
    today: Calendar.today.local,
  }).pipe(
    Effect.map(({ result, today }) => M.LoadedMetadata({ result, today })),
  ),
});
export const LoadUser = Command.define("LoadUser", {
  messages: [M.LoadedUser],
  execute: result(request((client) => client.viewer.current())).pipe(
    Effect.map((result) => M.LoadedUser({ result })),
  ),
});
