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
  switch (message._tag) {
    case "Analyze":
      return openGenie(message);
    case "Reload":
      return M.LoadPage();
    default:
      return Features.overview.toParentMessage(message);
  }
}

export function tripsViewMessage(message: typeof TripsMessage.Type): Message {
  return message._tag === "Reload"
    ? M.LoadPage()
    : Features.trips.toParentMessage(message);
}

export function gpsViewMessage(message: typeof GpsMessage.Type): Message {
  switch (message._tag) {
    case "Analyze":
      return openGenie(message);
    case "Reload":
      return M.LoadPage();
    default:
      return Features.gps.toParentMessage(message);
  }
}
