import { DatePicker, Dialog, Tooltip } from "@foldkit/ui";
import { Option, Result, Schema } from "effect";
import { AsyncData, Command, type Update } from "foldkit";
import { AnalysisInput } from "@dsiem/analytics-shared/analysis-runs";
import type { ApiClient } from "../../lib/api-client";
import { isoDay } from "../../lib/format";
import { empty, pending } from "../../lib/request-state";
import * as Commands from "./commands";
import { focusWeek } from "./dates";
import { Message as M, type Message } from "./messages";
import {
  type AnalysisRunLink,
  defaultDraft,
  initReuseTooltip,
  type Model,
  readyToSubmit,
} from "./model";

type Change = Update.Return<Model, Message, ApiClient>;

function updateFormDialog(model: Model, message: Dialog.Message): Change {
  const changed = Dialog.update(model.dialog, message);
  const commands: Command.Command<Message>[] = (changed.commands ?? []).map(
    (command) =>
      Command.mapMessage(command, (message) =>
        M.AnalysisFormDialog({ message }),
      ),
  );
  let datePickers = model.datePickers;
  if (model.dialog.isOpen && !changed.model.isOpen && datePickers) {
    for (const field of ["baselineWeek", "comparisonWeek"] as const) {
      const picker = datePickers[field];
      if (!picker.popover.isOpen) continue;
      const closed = DatePicker.close(picker);
      datePickers = { ...datePickers, [field]: closed.model };
      commands.push(
        ...(closed.commands ?? []).map((command) =>
          Command.mapMessage(command, (message) =>
            M.AnalysisDatePicker({ field, message }),
          ),
        ),
      );
    }
  }
  return {
    model:
      changed.model === model.dialog
        ? model
        : { ...model, dialog: changed.model, datePickers },
    commands,
  };
}

export const closeAnalysisForm = (model: Model): Change =>
  model.dialog.isOpen
    ? updateFormDialog(model, Dialog.Message.RequestedClose())
    : { model };

const editField = (
  model: Model,
  field: keyof Model["draft"],
  value: string,
): Model => ({
  ...model,
  draft: { ...model.draft, [field]: value },
  submission: readyToSubmit(),
});

function loadHistory(model: Model): Change {
  const generation = model.historyGeneration + 1;
  return {
    model: {
      ...model,
      historyGeneration: generation,
      recent: Option.getOrElse(
        AsyncData.revalidateOrLoad(model.recent),
        () => model.recent,
      ),
    },
    commands: [Commands.LoadHistory({ generation })],
  };
}

export function openAnalysisRuns(model: Model, run: AnalysisRunLink): Change {
  const generation = model.generation + 1;
  const reuseTooltip = initReuseTooltip();
  if (run._tag !== "SelectedRun") {
    return loadHistory({
      ...model,
      generation,
      reuseTooltip,
      invalidLink: run._tag === "InvalidRun",
      selected: null,
    });
  }
  return {
    model: {
      ...model,
      generation,
      reuseTooltip,
      invalidLink: false,
      selected: {
        id: run.id,
        generation,
        detail: pending,
        report: empty,
        observedAt: 0,
      },
    },
  };
}

const loadReport = (
  model: Model,
  selected: NonNullable<Model["selected"]>,
): Change => ({
  model: { ...model, selected: { ...selected, report: pending } },
  commands: [
    Commands.LoadReport({ id: selected.id, generation: selected.generation }),
  ],
});

export function updateAnalysisRuns(
  model: Model,
  message: Message,
  query: string | null,
): Change {
  if (
    query === null &&
    message._tag !== "AnalysisSubmitted" &&
    message._tag !== "AnalysisFormDialog"
  )
    return { model };
  const selected = model.selected;
  switch (message._tag) {
    case "Idle":
      return { model };
    case "ReuseTooltip": {
      if (model.dialog.isOpen) return { model };
      const changed = Tooltip.update(model.reuseTooltip, message.message);
      return {
        model: { ...model, reuseTooltip: changed.model },
        commands: (changed.commands ?? []).map((command) =>
          Command.mapMessage(command, (message) => M.ReuseTooltip({ message })),
        ),
      };
    }
    case "OpenAnalysisForm":
    case "ReuseAnalysisInputs": {
      if (model.dialog.isOpen || model.submission._tag === "Submitting")
        return { model };
      const draft =
        message._tag === "OpenAnalysisForm"
          ? defaultDraft
          : {
              ...message.input,
              minimumTrips: String(message.input.minimumTrips),
            };
      return updateFormDialog(
        {
          ...model,
          draft,
          submission: readyToSubmit(),
          reuseTooltip: initReuseTooltip(),
        },
        Dialog.Message.RequestedOpen(),
      );
    }
    case "CloseAnalysisForm":
      return model.submission._tag === "Submitting"
        ? { model }
        : closeAnalysisForm(model);
    case "AnalysisFormDialog":
      if (
        message.message._tag === "RequestedClose" &&
        model.submission._tag === "Submitting"
      )
        return { model };
      return updateFormDialog(model, message.message);
    case "AnalysisDatePicker": {
      if (
        !model.dialog.isOpen ||
        !model.datePickers ||
        model.submission._tag === "Submitting"
      )
        return { model };
      const { field } = message;
      const previous = model.datePickers[field];
      const changed = DatePicker.update(previous, message.message);
      const out = changed.outMessage;
      const closed =
        out?._tag === "ClearedDate" ? DatePicker.close(changed.model) : null;
      const picker =
        !previous.popover.isOpen && changed.model.popover.isOpen
          ? focusWeek(changed.model, model.draft[field])
          : (closed?.model ?? changed.model);
      const next = {
        ...model,
        datePickers: { ...model.datePickers, [field]: picker },
      };
      return {
        model:
          out && out._tag !== "ChangedViewMonth"
            ? editField(
                next,
                field,
                out._tag === "SelectedDate" ? isoDay(out.date) : "",
              )
            : next,
        commands: [
          ...(changed.commands ?? []),
          ...(closed?.commands ?? []),
        ].map((command) =>
          Command.mapMessage(command, (message) =>
            M.AnalysisDatePicker({ field, message }),
          ),
        ),
      };
    }
    case "AnalysisFieldChanged":
      if (!model.dialog.isOpen || model.submission._tag === "Submitting")
        return { model };
      return { model: editField(model, message.field, message.value) };
    case "StartAnalysis": {
      if (!model.dialog.isOpen || model.submission._tag === "Submitting")
        return { model };
      const input = Schema.decodeUnknownOption(AnalysisInput)({
        ...model.draft,
        minimumTrips: Number(model.draft.minimumTrips),
      });
      if (input._tag === "None") {
        return {
          model: {
            ...model,
            submission: readyToSubmit(
              null,
              "Enter two valid week starts and a positive whole number of trips.",
            ),
          },
        };
      }
      const generation = model.generation;
      return {
        model: { ...model, submission: { _tag: "Submitting", generation } },
        commands: [
          Commands.Submit({
            input: input.value,
            retryId: model.submission.retryId,
            generation,
          }),
        ],
      };
    }
    case "AnalysisSubmitted": {
      if (
        model.submission._tag !== "Submitting" ||
        model.submission.generation !== message.generation
      ) {
        return { model };
      }
      if (query === null || model.generation !== message.generation) {
        const next = { ...model, submission: readyToSubmit() };
        return message.data && query !== null && !selected
          ? loadHistory(next)
          : { model: next };
      }
      if (!message.data) {
        return {
          model: {
            ...model,
            submission: readyToSubmit(message.requestId, message.error),
          },
        };
      }
      const closed = closeAnalysisForm({
        ...model,
        submission: readyToSubmit(),
      });
      return {
        model: closed.model,
        commands: [
          ...(closed.commands ?? []),
          Commands.OpenRun({ id: message.data.id, query }),
        ],
      };
    }
    case "RefreshAnalysisHistory":
      return AsyncData.isPending(model.recent) ? { model } : loadHistory(model);
    case "LoadedAnalysisHistory":
      if (message.generation !== model.historyGeneration) return { model };
      return {
        model: {
          ...model,
          recent: AsyncData.settle(model.recent, message.result),
        },
      };
    case "RetryAnalysisStatus":
      if (!selected || selected.detail.loading) return { model };
      return {
        model: {
          ...model,
          selected: {
            ...selected,
            detail: { ...selected.detail, error: "", loading: true },
          },
        },
      };
    case "LoadedAnalysisStatus": {
      if (
        selected?.id !== message.id ||
        selected.generation !== message.generation
      )
        return { model };
      const result = message.result;
      const detail = Result.match(result, {
        onFailure: (error) => ({
          data: typeof error === "string" ? selected.detail.data : null,
          error,
          loading: false,
        }),
        onSuccess: (data) => ({ data, error: "", loading: false }),
      });
      const next = {
        ...selected,
        detail,
        observedAt: message.observedAt,
      };
      if (Result.isSuccess(result) && result.success.state === "succeeded")
        return loadReport(model, next);
      return { model: { ...model, selected: next } };
    }
    case "RetryAnalysisReport":
      return selected?.detail.data?.state === "succeeded" &&
        !selected.report.loading
        ? loadReport(model, selected)
        : { model };
    case "LoadedAnalysisReport":
      if (
        selected?.id !== message.id ||
        selected.generation !== message.generation
      )
        return { model };
      return {
        model: {
          ...model,
          selected: {
            ...selected,
            report: {
              data: message.data,
              error: message.error,
              loading: false,
            },
          },
        },
      };
  }
}
