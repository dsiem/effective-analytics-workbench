import type { Update } from "foldkit";
import type { ApiClient } from "./api-client";
// Feature outputs describe coordination requests; the application interprets them.
export type FeatureUpdate<
  Model,
  Message,
  Out = never,
> = Update.ReturnWithOutMessage<Model, Message, Out, ApiClient>;
