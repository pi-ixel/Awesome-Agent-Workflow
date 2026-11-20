import { createContext } from "react";

export const MarkdownAppearance = createContext<{ readonly theme: "dark" | "warm"; readonly uiFontSize: number }>({ theme: "dark", uiFontSize: 14 });
