import { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import type { ElicitationForm } from "../../contracts/elicitation.ts";

export function parseElicitationForm(
  raw: Readonly<Record<string, unknown>>,
): ElicitationForm | null {
  // The SDK guard validates the full wire payload, including request/session scope.
  if (!CreateElicitationRequest.isForm(raw as CreateElicitationRequest))
    return null;
  const form = raw as unknown as ElicitationForm;
  return {
    ...form,
    requestedSchema: {
      ...form.requestedSchema,
      properties: form.requestedSchema.properties ?? {},
    },
  };
}
