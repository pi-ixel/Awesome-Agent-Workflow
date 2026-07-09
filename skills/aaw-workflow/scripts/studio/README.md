# AAW Workflow Studio

本目录提供 `aaw-workflow` 的本地可视化配置工作台。YAML 文件仍是唯一配置源，Studio 只负责读取、编辑、校验和保存。

## 本机一键启动

Windows 下双击：

```text
start-studio.bat
```

默认地址：

```text
http://127.0.0.1:8765/
```

也可以命令行启动：

```bash
python server.py --host 127.0.0.1 --port 8765 --open
```

## 内网运行

内网共享时双击：

```text
start-studio-lan.bat
```

脚本会要求输入访问令牌，并监听：

```text
0.0.0.0:8765
```

同网段用户使用服务所在机器的内网 IP 访问，例如：

```text
http://192.168.1.23:8765/
```

内网模式具备写配置能力，请只在可信网络中使用，并设置访问令牌。

## 提交范围

最小提交内容：

- `server.py`
- `index.html`
- `app.js`
- `styles.css`
- `start-studio.bat`
- `start-studio-lan.bat`

建议同时提交：

- `README.md`
- `test/aaw_workflow_beta/test_workflow_studio.py`
