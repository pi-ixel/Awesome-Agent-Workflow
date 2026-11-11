import type {
  ElicitationForm,
  FormValues,
} from "../../../contracts/acp/elicitation.ts";

export interface PendingForm {
  readonly id: string;
  readonly owner: object;
  readonly label: string;
  readonly form: ElicitationForm;
  readonly values: FormValues;
  readonly stale: boolean;
  readonly submitting?: boolean;
  readonly page: number;
  readonly interacted: boolean;
  readonly context?: {
    readonly workspacePath: string;
    readonly sessionId: string | null;
    readonly activate: () => void;
  };
}

export interface ProjectFormState {
  readonly pending: readonly PendingForm[];
  readonly activeOwner: object | null;
  readonly activeId: string | null;
  readonly select: (id: string) => void;
  readonly progress: (
    id: string,
    patch: { page?: number; interacted?: boolean },
  ) => void;
  readonly edit: (id: string, values: FormValues) => void;
}

export interface FormViewItem extends Omit<PendingForm, "owner" | "context"> {
  readonly isForeground: boolean;
  readonly sessionId: string | null;
}

export interface FormViewState {
  readonly pending: readonly FormViewItem[];
  readonly activeId: string | null;
}
