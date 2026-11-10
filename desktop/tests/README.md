# tests — 测试

Vitest（`npm run test` = `vitest run`，非 watch）。jsdom 环境，
`tests/setup.ts` 全局挂载 jest-dom 匹配器与 RTL cleanup。

## 组织

测试按被验证行为的所有者组织。

- `tests/plugins/<插件>/` 放该插件的服务、内部模块和界面测试。复杂插件再按业务分组。
- `tests/integration/` 放跨插件交接和整机装配测试。
- `tests/architecture/` 放插件目录、依赖与公开边界守卫。
- `tests/shared/` 放公共基础设施测试。
- `tests/helpers/` 和 `tests/fixtures/` 放多套测试共用的驱动与样本。

## 约定

- 文件名 `*.test.ts(x)`，与被测模块同名；
- vitest 配置在 `vite.config.ts` 的 `test` 字段，不另建配置文件；
- 测试不 mock 日志环形缓冲设施——诊断链路要测「真实通路」；驱动
  store 一律走真实公开 action（夹具与局部驱动可以放 tests/ 内，
  src/ 不放）。
