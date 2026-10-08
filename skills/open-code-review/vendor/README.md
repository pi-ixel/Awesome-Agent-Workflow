# vendor/bin — 内置 ocr 二进制

随 Skill 分发的 open-code-review CLI 静态二进制，运行时零网络依赖。

| 文件 | 平台 | 版本 |
|---|---|---|
| `ocr.exe` | windows/amd64 | v1.12.12 |
| `ocr` | linux/amd64（服务器/WSL） | v1.12.12 |

两者的来源 URL、sha256 与获取日期见 `VERSION`；均已实测可运行（`--version` 与 `delegate preview`）。

技能按「Windows 用 `ocr.exe`，其他平台用 `ocr`」解析调用。`ocr` 为 ELF 静态链接，无 glibc 等运行时依赖。

## 维护注意

- **Git 可执行位**：在 Windows 上提交时 `ocr` 默认会丢失可执行位，须用 `git add --chmod=+x skills/open-code-review/vendor/bin/ocr` 暂存，否则 Linux 同事检出后无法直接执行。
- **Git Bash 的 .exe 魔法**：在 Git Bash 中对无扩展名目标执行 `cp`、`mv`、`install` 甚至 `>` 重定向，写入时会被静默重定向到 `<名>.exe`，会覆盖 Windows 二进制。放置 unix 二进制一律用 PowerShell（`Copy-Item`）或 `cmd /c copy`，完成后用 `certutil -hashfile` 核对 sha256。

## 补充其他平台

从 <https://github.com/alibaba/open-code-review/releases> 下载对应平台二进制（windows-arm64 / darwin-amd64 / darwin-arm64 / linux-arm64），按上表命名规则（windows 用 `.exe`，其余无扩展名）放入本目录，并在 `VERSION` 追加一行 sha256 记录。在有网络的环境中完成下载与校验，再经内部渠道分发，团队成员无需访问外网。
