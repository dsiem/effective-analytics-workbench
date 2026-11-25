import type { HtmlBuilder } from "foldkit/html";
import type { Filters } from "@dsiem/analytics-shared/filters";
import { dateLabel } from "../lib/format";
import { badge } from "../ui/primitives";
export const filterSummary = <Message>(
  h: HtmlBuilder<Message>,
  filters: Filters,
) =>
  h.div(
    [h.Class("flex flex-wrap gap-1.5")],
    [
      badge(h, dateLabel(filters)),
      badge(h, filters.zip ? `Pickup ZIP ${filters.zip}` : "All pickup areas"),
    ],
  );
