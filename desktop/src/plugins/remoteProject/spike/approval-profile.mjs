// 只复现实测的 OpenCode 1.19.5 build 配置。任意用户权限规则需要另做适配。
export function approvalProfile(name) {
  if (name === "build-default") return { agentPermission: {}, edit: "allow" };
  if (name === "ask-edits")
    return { agentPermission: { edit: "ask" }, edit: "ask" };
  throw new Error("未知的 OpenCode 对照权限配置 " + name);
}

export function effectForTool(profile, { tool, path }) {
  switch (tool) {
    case "edit_file":
    case "write_file":
      return profile.edit;
    case "run_command":
      return "allow";
    case "read_file": {
      const name = path.split("/").at(-1);
      return name.endsWith(".env.example")
        ? "allow"
        : /\.env($|\.)/.test(name)
          ? "ask"
          : "allow";
    }
    default:
      return "deny";
  }
}
