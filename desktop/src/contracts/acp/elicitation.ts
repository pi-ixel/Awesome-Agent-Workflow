import { CreateElicitationRequest } from "@agentclientprotocol/sdk";

export type FormValue = string | number | boolean | string[];
export type FormValues = Record<string, FormValue>;
export type FormResponse =
  { action: "accept"; content: FormValues } | { action: "decline" | "cancel" };
export interface FormField {
  type: string;
  title?: string;
  description?: string;
  default?: FormValue | null;
  enum?: string[] | null;
  oneOf?: { const: string; title?: string; description?: string }[] | null;
  items?: {
    enum?: string[];
    anyOf?: { const: string; title?: string }[];
    type?: string;
  };
  minLength?: number | null;
  maxLength?: number | null;
  pattern?: string | null;
  format?: string | null;
  minimum?: number | null;
  maximum?: number | null;
  minItems?: number | null;
  maxItems?: number | null;
}
export interface ElicitationForm {
  /** Set only by Acp Runtime, never trusted from the wire. */
  customAnswerField?: string;
  message: string;
  sessionId?: string;
  requestId?: string | number;
  toolCallId?: string | null;
  requestedSchema: {
    title?: string;
    description?: string;
    properties: Record<string, FormField>;
    required?: string[] | null;
  };
}

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
