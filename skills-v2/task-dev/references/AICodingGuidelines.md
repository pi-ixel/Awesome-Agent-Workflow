# AI 编码扩展指南模板

将本文件复制为项目 `.sdd/AICodingGuidelines.md` 后，可继续保留团队已有的其他章节。task-dev 只读取下面这个精确标题的二级章节；缺失时执行固定语义 Review 基线。

## task-dev 语义 Review 扩展规则

```yaml
version: 1
rules: []
# 需要扩展时，将上面的 [] 替换为：
#   - id: tenant-isolation
#     dimension: security
#     description: 所有业务数据访问必须显式携带 tenant_id
```

允许的 `dimension`：`requirements`、`security`、`performance`、`structure`、`readability`、`evolution`。规则只能追加语义 Review 检查项，不能包含命令、流程跳转、权限声明，也不能要求跳过测试、CodeCheck、重新验证或暂存门禁。
