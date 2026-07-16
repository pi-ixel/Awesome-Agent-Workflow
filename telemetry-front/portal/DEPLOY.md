# Portal 前端部署说明（Nginx · 同源反向代理）

本项目是纯静态前端（HTML/CSS/JS + ECharts CDN），无需构建、无需 Node 运行时。
生产环境用 Nginx 托管静态文件，并把 `/api/v1/` 反向代理到后端，实现前后端同源、免跨域。

## 一、文件清单

部署到服务器时，把以下文件放同一目录（如 `D:/program/portal`）：

```
bright.html   bright.css   bright.js
config.js     mock-data.js
```

> `telemetry-api-contract.md`、`nginx.portal.conf`、本说明文件是文档/配置，
> 不需要放进 Nginx 的 root 对外目录（放了也无妨，不会被当页面访问）。
> ECharts 走公网 CDN，服务器需能访问外网；若内网隔离，需把 echarts.min.js
> 下载到本地并改 bright.html 里的 <script src>。

## 二、config.js 已就绪

已设为生产模式：

- `useMock: false`      → 走真实后端
- `apiBase: "/api/v1"`  → 同源相对路径（配合 Nginx 反代，无需改）
- `credentials: "same-origin"` → 同源，保持不变

采用同源反代方案时，config.js 通常不用再动。

## 三、部署步骤

1. 安装 Nginx（Windows 版解压即用：https://nginx.org/en/download.html）。

2. 打开 `nginx.portal.conf`，改其中 3 处 `← TODO`：
   - `listen`     ：对外 IP:端口（如 `0.0.0.0:8080`）
   - `root`       ：前端文件目录（正斜杠，如 `D:/program/portal`）
   - `proxy_pass` ：后端地址:端口（后端启动后填，如 `http://127.0.0.1:9000`）

3. 把该 server 块并入 Nginx 主配置：
   - 简单做法：直接用它替换 `conf/nginx.conf` 里 http {} 内的示例 server 块；
   - 规范做法：在 http {} 中加 `include D:/program/portal/nginx.portal.conf;`

4. 校验并启动：
   ```powershell
   cd <nginx 安装目录>
   .\nginx.exe -t                    # 语法检查，出现 successful 即正确
   Start-Process .\nginx.exe         # 首次启动
   # 改配置后热重载：
   .\nginx.exe -s reload
   # 停止：
   .\nginx.exe -s stop
   ```

5. 浏览器访问：`http://<listen 的 IP>:<端口>/bright.html`

## 四、后端就绪前先自测前端

后端还没起时，想先确认前端页面本身正常，可临时把 `config.js` 改回
`useMock: true`（用内置假数据），页面即可脱离后端独立展示。
后端就绪后再改回 `false`，并填好 `proxy_pass`。

## 五、常见问题

| 现象 | 排查方向 |
|---|---|
| 页面能开但图表空/报错 | 后端未起或 `proxy_pass` 地址错；F12 看 /api/v1 请求是否 502/404 |
| 502 Bad Gateway | 后端没监听在 proxy_pass 指的地址端口；确认后端已启动 |
| 页面 404 | root 目录不对，或访问的是 / 而非 /bright.html |
| 改了 config.js 不生效 | HTML/JS 被缓存；conf 已对 html 设 no-cache，强刷(Ctrl+F5)一次 |
| 端口打不开 | 服务器防火墙未放行该端口 |

## 六、如果前后端不同源（备选，不推荐）

若后端独立部署、不走本机反代，则改 `config.js`：
- `apiBase` 填后端完整地址，如 `https://api.example.com/api/v1`
- `credentials` 视后端鉴权改为 `"include"`
- 且后端需开启 CORS，允许本前端域名。
同源反代能省掉这些跨域配置，优先用第三节方案。
