询问用户：此 SR 是否需要拆分 AR？

拆分 AR 时，收集每个 AR 的 id 和 title，例如：

- AR-001: 用户管理
- AR-002: 权限控制

确认后，构造：

```json
{"ars":[{"id":"AR-001","title":"用户管理"},{"id":"AR-002","title":"权限控制"}]}
```

不拆分时，构造：

```json
{"mode":"no_split"}
```
