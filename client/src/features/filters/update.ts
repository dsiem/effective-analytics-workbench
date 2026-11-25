import { DatePicker } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { Command } from "foldkit";
import { taggedStruct } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import type { Filters } from "@dsiem/analytics-shared/filters";
import { filterError, filtersFromQuery, queryFor } from "../../domain/filters";
import type { FeatureUpdate } from "../../lib/feature-update";
import { isoDay } from "../../lib/format";
import { focusOnOpen, type Metadata, reset, syncDates } from "./dates";
import { Message as M, type Message } from "./messages";
import type { Model } from "./model";

const Navigate = taggedStruct("Navigate", { query: Schema.String });
export type Out = typeof Navigate.Type;

function editField(
  model: Model,
  field: keyof Model["filterDraft"],
  value: string,
  metadata: Metadata,
) {
  return syncDates(
    modifyFields(model, {
      error: () => "",
      filterDraft: (draft) => ({ ...draft, [field]: value }),
    }),
    metadata,
    field,
  );
}

export function updateFilters(
  model: Model,
  message: Message,
  context: Context,
): FeatureUpdate<Model, Message, Out> {
  const metadata = context.metadata;
  return M.match<FeatureUpdate<Model, Message, Out>>(message, {
    FilterChanged: ({ field, value }) => ({
      model: editField(model, field, value, metadata),
    }),
    GotFilterDatePickerMessage: ({ id, message }) => {
      if (Option.isNone(model.datePickers)) return { model };
      const pickers = model.datePickers.value;
      const previous = pickers[id];
      const changed = DatePicker.update(previous, message);
      const picker =
        !previous.popover.isOpen && changed.model.popover.isOpen
          ? focusOnOpen(changed.model, id, model.filterDraft[id])
          : changed.model;
      const out = changed.outMessage;
      const closed =
        out?._tag === "ClearedDate" ? DatePicker.close(picker) : undefined;
      const next = modifyFields(model, {
        datePickers: () =>
          Option.some({ ...pickers, [id]: closed?.model ?? picker }),
      });
      const commands = [
        ...(changed.commands ?? []),
        ...(closed?.commands ?? []),
      ].map((command) =>
        Command.mapMessage(command, (message) =>
          M.GotFilterDatePickerMessage({ id, message }),
        ),
      );
      return {
        model:
          out?._tag === "SelectedDate" || out?._tag === "ClearedDate"
            ? editField(
                next,
                id,
                out._tag === "SelectedDate" ? isoDay(out.date) : "",
                metadata,
              )
            : next,
        commands,
      };
    },
    ApplyFilters: () => {
      const query = queryFor(model.filterDraft);
      if (Option.isNone(filtersFromQuery(query)))
        return { model: modifyFields(model, { error: () => filterError }) };
      if (
        metadata &&
        [model.filterDraft.from, model.filterDraft.to].some(
          (day) => day && (day < metadata.from || day > metadata.to),
        )
      )
        return {
          model: modifyFields(model, {
            error: () =>
              `Choose pickup dates between ${metadata.from} and ${metadata.to}.`,
          }),
        };
      return {
        model: modifyFields(model, { error: () => "" }),
        outMessage: Navigate({ query }),
      };
    },
    ResetFilters: () => ({
      model: reset(model, {}, metadata),
      outMessage: Navigate({ query: "" }),
    }),
    PickZip: ({ zip }) => ({
      model,
      outMessage: Navigate({ query: queryFor({ ...context.filters, zip }) }),
    }),
  });
}

export type Context = {
  readonly filters: Filters | null;
  readonly metadata: Metadata;
};
