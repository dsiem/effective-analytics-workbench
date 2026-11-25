import { Match } from "effect";
import { Message as Genie } from "../features/genie/messages";
import type { Message as GpsMessage } from "../features/gps/view-messages";
import type { Message as OverviewMessage } from "../features/overview/view-messages";
import type { Message as TripsMessage } from "../features/trips/view-messages";
import * as Features from "./features";
import { Message as M, type Message } from "./message";

export const openGenie = ({
  context,
  question,
}: Pick<ReturnType<typeof Genie.OpenGenie>, "context" | "question">) =>
  Features.genie.toParentMessage(Genie.OpenGenie({ context, question }));

export function overviewViewMessage(
  message: typeof OverviewMessage.Type,
): Message {
  return Match.value(message).pipe(
    Match.tags({ Analyze: openGenie, Reload: () => M.LoadPage() }),
    Match.orElse(Features.overview.toParentMessage),
  );
}

export function tripsViewMessage(message: typeof TripsMessage.Type): Message {
  return Match.value(message).pipe(
    Match.tag("Reload", () => M.LoadPage()),
    Match.orElse(Features.trips.toParentMessage),
  );
}

export function gpsViewMessage(message: typeof GpsMessage.Type): Message {
  return Match.value(message).pipe(
    Match.tags({ Analyze: openGenie, Reload: () => M.LoadPage() }),
    Match.orElse(Features.gps.toParentMessage),
  );
}
