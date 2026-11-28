import { analysisQuestion } from "@dsiem/genie-client";
import type { GenieInput } from "@dsiem/analytics-shared/genie";

export function taxiQuestion(table: string, question: typeof GenieInput.Type) {
  return analysisQuestion(
    {
      table: table || "the configured trip table",
      filterInstructions:
        "Apply from and to to tpep_pickup_datetime: from is inclusive; to includes the entire day (before midnight of the next day). Apply zip to pickup_zip. Omitted bounds or ZIP mean unrestricted.",
    },
    question,
  );
}
