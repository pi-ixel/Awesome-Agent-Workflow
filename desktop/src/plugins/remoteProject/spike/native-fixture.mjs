import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readDesktopProjectService } from "../../../bootstrap/mainRuntime.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { approvalProfile, effectForTool } from "./approval-profile.mjs";

const alwaysAllow = {
  optionId: "allow_edits",
  kind: "allow_always",
  name: "本会话总是允许",
};
const options = [
  { optionId: "allow", kind: "allow_once", name: "允许一次" },
  { optionId: "reject", kind: "reject_once", name: "拒绝" },
];

export async function configureNativeFixture({
  workspace,
  agentExecutable,
  ssh,
  approvalMode,
  profileName,
}) {
  if (!import.meta.env.DEV) throw new Error("仅调试版本可运行远程项目测试");
  const project = readDesktopProjectService();
  if (!project) throw new Error("AAWD 工作台尚未就绪");
  const registerWorkspace = async () => {
    project.projects.patchToolPaths({ opencode: agentExecutable });
    project.preferences.setApprovalMode(approvalMode);
    await project.sessions.switchAgent("native-opencode");
    project.projects.registerProject(workspace);
  };
  if (!ssh) {
    await registerWorkspace();
    return { local: true };
  }
  const permission = approvalProfile(profileName);
  let context;
  let sessionId;
  let hasApprovedEdits = false;
  const events = [];
  const { generation, pid } = await invoke("ops_service_start", {
    projectSpike: true,
  });
  const send = (message) =>
    invoke("ops_service_write", { generation, message });
  const ready = Promise.withResolvers();
  const releaseExit = await listen("aaw://ops-service-exit", ({ payload }) => {
    if (payload.generation === generation) {
      const error = new Error("运维 sidecar 退出");
      events.push({ event: "exit", code: payload.code });
      ready.reject(error);
    }
  });
  const release = await listen("aaw://ops-service", ({ payload }) => {
    if (payload.generation !== generation) return;
    const message = payload.message;
    if (message.event === "ready") {
      ready.resolve(message);
    } else if (message.event === "permission") {
      void (async () => {
        const isEdit =
          message.tool === "edit_file" || message.tool === "write_file";
        const effect =
          isEdit && hasApprovedEdits
            ? "allow"
            : effectForTool(permission, message);
        let allow = Boolean(context && sessionId && effect === "allow");
        if (effect === "ask")
          try {
            const outcome = await context?.requestPermission?.(
              {
                toolCallId: "remote-project:" + message.id,
                title:
                  message.tool === "run_command"
                    ? message.command
                    : "修改远端文件 " + message.path,
                kind: message.tool === "run_command" ? "execute" : "edit",
                rawInput:
                  message.tool === "run_command"
                    ? { command: message.command }
                    : { path: message.path },
                edit: message.edit,
              },
              isEdit ? [...options, alwaysAllow] : options,
            );
            const optionId =
              outcome?.outcome === "selected" ? outcome.optionId : null;
            if (optionId === alwaysAllow.optionId) hasApprovedEdits = true;
            allow =
              optionId === "allow" ||
              (isEdit && optionId === alwaysAllow.optionId);
          } catch {
            // 会话已释放时默认拒绝。
          }
        events.push({
          event: "permission",
          tool: message.tool,
          path: message.path,
          command: message.command,
          effect,
          allow,
          sessionId,
        });
        await send({ id: message.id, allow });
      })().catch(() => events.push({ event: "permission_send_failed" }));
    } else {
      events.push(message);
    }
  });
  const deadline = setTimeout(
    () => ready.reject(new Error("远程项目 MCP 启动超时")),
    40000,
  );
  try {
    await send(ssh);
    const { url, token } = await ready.promise;
    if (new URL(url).hostname !== "127.0.0.1")
      throw new Error("MCP 必须使用本机回环地址");
    const unregister = project.sessions.registerSessionTools((candidate) => {
      if (
        candidate.agentId !== "native-opencode" ||
        pathKey(candidate.workspacePath) !== pathKey(workspace)
      )
        return [];
      if (!candidate.agent?.agentCapabilities?.mcpCapabilities?.http) return [];
      if (context && context !== candidate)
        throw new Error("此测试仅绑定一条会话");
      context = candidate;
      candidate.onEstablished?.((establishedId) => {
        sessionId = establishedId;
        events.push({ event: "established", sessionId });
      });
      candidate.onDispose?.(async () => {
        if (context === candidate) {
          context = undefined;
          sessionId = undefined;
          hasApprovedEdits = false;
        }
      });
      return [
        {
          type: "http",
          name: "remote_project",
          url,
          headers: [{ name: "Authorization", value: "Bearer " + token }],
        },
      ];
    });
    globalThis.__aawRemoteFixture = {
      events: () => events,
      dispose: () => {
        unregister();
        release();
        releaseExit();
      },
    };
    await registerWorkspace();
    return { pid };
  } catch (error) {
    release();
    releaseExit();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
