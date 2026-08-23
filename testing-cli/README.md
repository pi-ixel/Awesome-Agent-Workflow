# testwf

测试工作流的最小独立 CLI。只有两个命令：

```powershell
testwf start --repository team/example-service
# 在当前 Git 工作区生成或修改测试代码
testwf finished
```

`start` 会像 AAW 的开发步骤一样，对当前工作区建立 D0 Git 树快照并上报开始事件。`finished` 建立 D1 快照、生成 D0→D1 的本地二进制 Diff，先上报结束事件，再上传 Diff 到测试 API；`.testwf/` 自身不会计入代码变更。

网络暂时不可用时，事件和 Diff 会保留在 `.testwf/telemetry/outbox/`。下次执行 `start` 或 `finished` 时会自动补发。

安装：

```powershell
cd testing-cli
python -m pip install -e .
```

环境变量：

- `TESTWF_TELEMETRY_ENDPOINT`：服务地址，默认 `http://127.0.0.1:18080`。
- `TESTWF_TELEMETRY_TOKEN`：可选 Bearer Token。
- `TESTWF_TELEMETRY_INSECURE`：默认关闭。仅在开发环境连接自签名 HTTPS
  服务且无法安装可信 CA 时显式设为 `1`；启用后只影响 testwf 的 Telemetry 请求。

Telemetry 请求使用独立的直连 transport，不读取系统代理，也不修改进程环境或全局
`urllib` 配置。HTTPS 默认校验证书和主机名。
