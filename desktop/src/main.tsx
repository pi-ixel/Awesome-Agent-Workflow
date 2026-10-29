import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorGuard } from "./core/crashGuard.ts";
import "./index.css";
// 应用启动即开始内存采样（诊断页「性能」折线图的数据源，见模块注释）
import "./ui/perf/memorySampler.ts";

// 全局异常守卫 + 渲染进程死亡取证:必须在渲染前安装(白屏诊断设施)
installGlobalErrorGuard();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
