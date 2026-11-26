import type {} from "cordis";

declare module "cordis" {
  interface Context {
    visual: VisualService;
  }
}

/**
 * 讲解图：在会话 Markdown（Agent 回答）中把 ```visual 围栏渲染成讲解图。
 * 界面插件 visual-workbench 注入本服务读取语言并登记渲染器。
 */
export interface VisualService {
  /** 接管的围栏语言（小写）。 */
  readonly languages: readonly string[];
}
