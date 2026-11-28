import { Schema } from "effect";
import { savedViewSchemas } from "@dsiem/analytics/contracts";

export function findingEditor<F, N>(
  filters: Schema.Codec<F>,
  notice: Schema.Codec<N>,
  clearNotice: N,
) {
  const { SavedViewInput } = savedViewSchemas(filters);
  const Draft = Schema.Struct({
    ...SavedViewInput.fields,
    title: Schema.String,
  });
  const Model = Schema.Struct({
    draft: Draft,
    saving: Schema.Boolean,
    error: notice,
  });
  type State = typeof Model.Type;

  const edit = ({
    id,
    title,
    body,
    filters,
    version,
  }: typeof Draft.Type): State => ({
    draft: { id, title, body, filters, version },
    saving: false,
    error: clearNotice,
  });
  return {
    Model,
    Draft,
    create: (id: string, filters: F) =>
      edit({ id, filters, title: "", body: "", version: null }),
    edit,
    change: (state: State, field: "title" | "body", value: string): State =>
      state.saving
        ? state
        : { ...state, draft: { ...state.draft, [field]: value } },
    submit: (state: State): State | null =>
      !state.saving && state.draft.title.trim()
        ? { ...state, saving: true, error: clearNotice }
        : null,
    reject: (state: State, error: N): State => ({
      ...state,
      saving: false,
      error,
    }),
  };
}
