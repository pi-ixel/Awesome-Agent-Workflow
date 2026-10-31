/**
 * 应用退出收口闸（core 层可读的全局标志）。
 *
 * 确认关闭后置位：所有面向界面的后台进程拉起（panel git 查询、文件
 * 列举、目录监听注册等面板 RPC）到此为止——退出窗口期收口正在杀 agent
 * 进程树，再起新进程（git.exe 等）会在风暴里启动失败弹系统硬错误框
 * （实测 0xc0000142）。UI 侧的退出呈现走 workbenchUiStore.isExiting，
 * 这里只做 core 层的闸门，保持 core 不依赖 stores 的分层。
 */
let exiting = false;

export function markAppExiting(): void {
  exiting = true;
}

export function isAppExiting(): boolean {
  return exiting;
}
