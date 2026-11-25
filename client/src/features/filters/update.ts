import { DatePicker } from "@foldkit/ui";
import { Command, type Update } from "foldkit";
import type { Filters } from "@dsiem/analytics-shared/filters";
import { filterError, filtersFromQuery, queryFor } from "../../domain/filters";
import type { FeatureUpdate } from "../../lib/feature-update";
import { isoDay } from "../../lib/format";
import { focusOnOpen, type Metadata, reset, syncDates } from "./dates";
import { Message as M, type Message } from "./messages";
import type { Model } from "./model";
export function updateFilters(
  model: Model,
  message: Message,
  context: Context,
): FeatureUpdate<Model, Message, Out> {
  const metadata = context.metadata;
  switch (message._tag) {
    case "Idle":
      return { model };
    case "FilterChanged":
      return {
        model: syncDates(
          {
            ...model,
            error: "",
            filterDraft: {
              ...model.filterDraft,
              [message.field]: message.value,
            },
          },
          context.metadata,
          message.field,
        ),
      };
    case "FilterDatePicker": {
      if (!model.datePickers) return { model };
      const field = message.field;
      const changed = DatePicker.update(
        model.datePickers[field],
        message.message,
      );
      let picker = changed.model;
      if (!model.datePickers[field].popover.isOpen && picker.popover.isOpen)
        picker = focusOnOpen(picker, field, model.filterDraft[field]);
      let commands: Update.Commands<Message> = (changed.commands ?? []).map(
        (command) =>
          Command.mapMessage(command, (message) =>
            M.FilterDatePicker({ field, message }),
          ),
      );
      const out = changed.outMessage;
      let next = {
        ...model,
        datePickers: { ...model.datePickers, [field]: picker },
      };
      if (out?._tag === "SelectedDate" || out?._tag === "ClearedDate") {
        if (out._tag === "ClearedDate") {
          const closed = DatePicker.close(picker);
          picker = closed.model;
          commands = [
            ...commands,
            ...(closed.commands ?? []).map((command) =>
              Command.mapMessage(command, (message) =>
                M.FilterDatePicker({ field, message }),
              ),
            ),
          ];
          next = {
            ...next,
            datePickers: { ...next.datePickers, [field]: picker },
          };
        }
        return {
          model: syncDates(
            {
              ...next,
              error: "",
              filterDraft: {
                ...next.filterDraft,
                [field]: out._tag === "SelectedDate" ? isoDay(out.date) : "",
              },
            },
            context.metadata,
            field,
          ),
          commands,
        };
      }
      return { model: next, commands };
    }
    case "ApplyFilters":
      if (!filtersFromQuery(queryFor(model.filterDraft)))
        return { model: { ...model, error: filterError } };
      if (
        metadata &&
        [model.filterDraft.from, model.filterDraft.to].some(
          (day) => day && (day < metadata.from || day > metadata.to),
        )
      )
        return {
          model: {
            ...model,
            error: `Choose pickup dates between ${metadata.from} and ${metadata.to}.`,
          },
        };
      return {
        model: { ...model, error: "" },
        outMessage: { _tag: "Navigate", query: queryFor(model.filterDraft) },
      };
    case "ResetFilters":
      return {
        model: reset(model, {}, context.metadata),
        outMessage: { _tag: "Navigate", query: "" },
      };
    case "PickZip":
      return {
        model,
        outMessage: {
          _tag: "Navigate",
          query: queryFor({
            ...context.filters,
            zip: message.zip,
          }),
        },
      };
  }
}

export type Context = {
  readonly filters: Filters | null;
  readonly metadata: Metadata;
};
export type Out = { readonly _tag: "Navigate"; readonly query: string };
