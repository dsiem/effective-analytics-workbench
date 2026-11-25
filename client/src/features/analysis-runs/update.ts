import { DatePicker, Dialog, Tooltip } from "@foldkit/ui";
import { Option, Result, Schema } from "effect";
import { AsyncData, Command, type Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { AnalysisInput } from "@dsiem/analytics-shared/analysis-runs";
import type { AnalysisRunLink } from "../../app/route";
import type { ApiClient } from "../../lib/api-client";
import { isoDay } from "../../lib/format";
import * as Commands from "./commands";
import { focusWeek } from "./dates";
import { Message as M, type Message } from "./messages";
import {
  defaultDraft,
  initReuseTooltip,
  type Model,
  readyToSubmit,
  type SelectedRun,
  Submission,
} from "./model";

type Change = Update.Return<Model, Message, ApiClient>;

function updateFormDialog(model: Model, message: Dialog.Message): Change {
  const changed = Dialog.update(model.dialog, message);
  const commands: Command.Command<Message>[] = (changed.commands ?? []).map(
    (command) =>
      Command.mapMessage(command, (message) =>
        M.GotAnalysisFormDialogMessage({ message }),
      ),
  );
  let datePickers = Option.getOrUndefined(model.datePickers);
  if (model.dialog.isOpen && !changed.model.isOpen && datePickers) {
    for (const field of ["baselineWeek", "comparisonWeek"] as const) {
      const picker = datePickers[field];
      if (!picker.popover.isOpen) continue;
      const closed = DatePicker.close(picker);
      datePickers = { ...datePickers, [field]: closed.model };
      commands.push(
        ...(closed.commands ?? []).map((command) =>
          Command.mapMessage(command, (message) =>
            M.GotAnalysisDatePickerMessage({ id: field, message }),
          ),
        ),
      );
    }
  }
  return {
    model:
      changed.model === model.dialog
        ? model
        : modifyFields(model, {
            dialog: () => changed.model,
            datePickers: () => Option.fromUndefinedOr(datePickers),
          }),
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
): Model =>
  modifyFields(model, {
    draft: (draft) => ({ ...draft, [field]: value }),
    submission: () => readyToSubmit(),
  });

function openForm(model: Model, draft: Model["draft"]): Change {
  if (model.dialog.isOpen || model.submission._tag === "Submitting")
    return { model };
  return updateFormDialog(
    modifyFields(model, {
      draft: () => draft,
      submission: () => readyToSubmit(),
      reuseTooltip: initReuseTooltip,
    }),
    Dialog.Message.RequestedOpen(),
  );
}

function loadHistory(model: Model): Change {
  const generation = model.historyGeneration + 1;
  return {
    model: modifyFields(model, {
      historyGeneration: () => generation,
      recent: (recent) =>
        Option.getOrElse(AsyncData.revalidateOrLoad(recent), () => recent),
    }),
    commands: [Commands.LoadAnalysisHistory({ generation })],
  };
}

export function openAnalysisRuns(model: Model, run: AnalysisRunLink): Change {
  const generation = model.generation + 1;
  const reuseTooltip = initReuseTooltip();
  if (run._tag !== "SelectedRun") {
    return loadHistory(
      modifyFields(model, {
        generation: () => generation,
        reuseTooltip: () => reuseTooltip,
        invalidLink: () => run._tag === "InvalidRun",
        selected: Option.none,
      }),
    );
  }
  return {
    model: modifyFields(model, {
      generation: () => generation,
      reuseTooltip: () => reuseTooltip,
      invalidLink: () => false,
      selected: () =>
        Option.some({
          id: run.id,
          generation,
          detail: AsyncData.Loading(),
          report: AsyncData.Idle(),
          observedAt: 0,
        }),
    }),
  };
}

const loadReport = (model: Model, selected: SelectedRun): Change => ({
  model: modifyFields(model, {
    selected: () =>
      Option.some(
        modifyFields(selected, { report: () => AsyncData.Loading() }),
      ),
  }),
  commands: [
    Commands.LoadAnalysisReport({
      id: selected.id,
      generation: selected.generation,
    }),
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
    message._tag !== "GotAnalysisFormDialogMessage"
  )
    return { model };
  const selected = Option.getOrUndefined(model.selected);
  return M.match<Change>(message, {
    CompletedOpenAnalysisRun: () => ({ model }),
    GotReuseTooltipMessage: ({ message }) => {
      if (model.dialog.isOpen) return { model };
      const changed = Tooltip.update(model.reuseTooltip, message);
      return {
        model: modifyFields(model, { reuseTooltip: () => changed.model }),
        commands: (changed.commands ?? []).map((command) =>
          Command.mapMessage(command, (message) =>
            M.GotReuseTooltipMessage({ message }),
          ),
        ),
      };
    },
    OpenAnalysisForm: () => openForm(model, defaultDraft),
    ReuseAnalysisInputs: ({ input }) =>
      openForm(model, { ...input, minimumTrips: String(input.minimumTrips) }),
    CloseAnalysisForm: () =>
      model.submission._tag === "Submitting"
        ? { model }
        : closeAnalysisForm(model),
    GotAnalysisFormDialogMessage: ({ message }) => {
      if (
        message._tag === "RequestedClose" &&
        model.submission._tag === "Submitting"
      )
        return { model };
      return updateFormDialog(model, message);
    },
    GotAnalysisDatePickerMessage: ({ id, message }) => {
      if (
        !model.dialog.isOpen ||
        Option.isNone(model.datePickers) ||
        model.submission._tag === "Submitting"
      )
        return { model };
      const datePickers = model.datePickers.value;
      const previous = datePickers[id];
      const changed = DatePicker.update(previous, message);
      const out = changed.outMessage;
      const closed =
        out?._tag === "ClearedDate" ? DatePicker.close(changed.model) : null;
      const picker =
        !previous.popover.isOpen && changed.model.popover.isOpen
          ? focusWeek(changed.model, model.draft[id])
          : (closed?.model ?? changed.model);
      const next = modifyFields(model, {
        datePickers: () => Option.some({ ...datePickers, [id]: picker }),
      });
      return {
        model:
          out && out._tag !== "ChangedViewMonth"
            ? editField(
                next,
                id,
                out._tag === "SelectedDate" ? isoDay(out.date) : "",
              )
            : next,
        commands: [
          ...(changed.commands ?? []),
          ...(closed?.commands ?? []),
        ].map((command) =>
          Command.mapMessage(command, (message) =>
            M.GotAnalysisDatePickerMessage({ id, message }),
          ),
        ),
      };
    },
    AnalysisFieldChanged: ({ field, value }) => {
      if (!model.dialog.isOpen || model.submission._tag === "Submitting")
        return { model };
      return { model: editField(model, field, value) };
    },
    StartAnalysis: () => {
      if (!model.dialog.isOpen || model.submission._tag === "Submitting")
        return { model };
      const input = Schema.decodeUnknownOption(AnalysisInput)({
        ...model.draft,
        minimumTrips: Number(model.draft.minimumTrips),
      });
      if (input._tag === "None") {
        return {
          model: modifyFields(model, {
            submission: () =>
              readyToSubmit(
                Option.none(),
                "Enter two valid week starts and a positive whole number of trips.",
              ),
          }),
        };
      }
      const generation = model.generation;
      return {
        model: modifyFields(model, {
          submission: () => Submission.Submitting({ generation }),
        }),
        commands: [
          Commands.SubmitAnalysisRun({
            input: input.value,
            retryId: model.submission.retryId,
            generation,
          }),
        ],
      };
    },
    AnalysisSubmitted: (message) => {
      if (
        model.submission._tag !== "Submitting" ||
        model.submission.generation !== message.generation
      ) {
        return { model };
      }
      const { result } = message;
      if (query === null || model.generation !== message.generation) {
        const next = modifyFields(model, { submission: () => readyToSubmit() });
        return result._tag === "Success" && query !== null && !selected
          ? loadHistory(next)
          : { model: next };
      }
      if (result._tag === "Failure") {
        return {
          model: modifyFields(model, {
            submission: () =>
              readyToSubmit(Option.some(message.requestId), result.error),
          }),
        };
      }
      const closed = closeAnalysisForm(
        modifyFields(model, {
          submission: () => readyToSubmit(),
        }),
      );
      return {
        model: closed.model,
        commands: [
          ...(closed.commands ?? []),
          Commands.OpenAnalysisRun({ id: result.data.id, query }),
        ],
      };
    },
    RefreshAnalysisHistory: () =>
      AsyncData.isPending(model.recent) ? { model } : loadHistory(model),
    LoadedAnalysisHistory: ({ generation, result }) => {
      if (generation !== model.historyGeneration) return { model };
      return {
        model: modifyFields(model, {
          recent: (recent) => AsyncData.settle(recent, result),
        }),
      };
    },
    RetryAnalysisStatus: () => {
      if (!selected) return { model };
      const detail = AsyncData.revalidateOrLoad(selected.detail);
      if (Option.isNone(detail)) return { model };
      return {
        model: modifyFields(model, {
          selected: () =>
            Option.some(modifyFields(selected, { detail: () => detail.value })),
        }),
      };
    },
    LoadedAnalysisStatus: (message) => {
      if (
        selected?.id !== message.id ||
        selected.generation !== message.generation
      )
        return { model };
      const result = message.result;
      const detail =
        Result.isFailure(result) && typeof result.failure !== "string"
          ? AsyncData.fail(result.failure)
          : AsyncData.settle(selected.detail, result);
      const next = modifyFields(selected, {
        detail: () => detail,
        observedAt: () => message.observedAt,
      });
      if (Result.isSuccess(result) && result.success.state === "succeeded")
        return loadReport(model, next);
      return {
        model: modifyFields(model, { selected: () => Option.some(next) }),
      };
    },
    RetryAnalysisReport: () =>
      selected &&
      Option.getOrUndefined(AsyncData.getData(selected.detail))?.state ===
        "succeeded" &&
      !AsyncData.isPending(selected.report)
        ? loadReport(model, selected)
        : { model },
    LoadedAnalysisReport: (message) => {
      if (
        selected?.id !== message.id ||
        selected.generation !== message.generation
      )
        return { model };
      return {
        model: modifyFields(model, {
          selected: () =>
            Option.some(
              modifyFields(selected, { report: () => message.result }),
            ),
        }),
      };
    },
  });
}
