import { createContext } from "react";
import type { ProjectAnnotationEditor } from "../../project/service.ts";

export const DocumentAnnotationContext = createContext<ProjectAnnotationEditor | undefined>(undefined);
