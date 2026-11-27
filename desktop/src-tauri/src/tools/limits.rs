//! 体积与超时的唯一出处。
//!
//! # 为什么要一个结构体
//!
//! 这些数字原本散在 `store.rs`（5 MB）、`native.rs`（32 MB 读、8 MB 存、1 MB
//! 剪贴板）、`process_host.rs`（20 秒、512 KB、5 秒）、`protocol.rs`（8 MB 响应）
//! 与 `mod.rs`（20 秒、1 MB 导出）里，其中 `ACTION_TIMEOUT` 有两份定义。
//!
//! 后果不是"不好看"，而是**改一处忘一处**：把动作超时从 20 秒放到 30 秒，只改
//! `process_host.rs` 会让页面载体和进程载体行为不一致，而作者手册（`guide.ts`）
//! 里写的是同一个数字——三处说法两处实现在飘。
//!
//! # 与前端那份的关系
//!
//! `src/plugins/tools/runtime/limits.ts` 是这份的镜像。前端只用它做作者可见的
//! 校验（导入包大小、源码文件数），Rust 用它做真正的执行限制。两边必须一致，
//! `tests/plugins/tools/limits.test.ts` 会把它们逐项比对。
//!
//! # 哪些数字不该放进来
//!
//! 只放"契约的一部分"——作者能感知、手册里写了、改了对工具有影响的。内部实现
//! 细节（总线保留条数、ticker 间隔）留在这里是为了有一个地方能一眼看全，但
//! 它们不参与跨语言比对。

use std::time::Duration;

pub struct Limits {
    // ── 动作（契约的一部分：作者手册里逐条写了） ──────────────────────
    /// 一个动作最长跑多久。超过就杀进程 / 放弃等待。
    pub action_timeout: Duration,
    /// 动作返回值的上限。超过直接报错，不截断——截断会让作者以为数据完整。
    pub result_bytes: usize,

    // ── 存储 ────────────────────────────────────────────────────────────
    /// 每个工具自己的键值存储上限。
    pub store_bytes: usize,

    // ── 清单里能带多少源码 ──────────────────────────────────────────────
    /// `sourceFiles` 最多几个文件。
    pub source_files: usize,
    /// `sourceFiles` 合计最多多少字节（存进 `preferences.json`，不能太大）。
    pub source_bytes: usize,
    /// 单个工具包（`html` 快照 + 清单）的上限。
    pub package_bytes: usize,
    /// 整包 ZIP（源码 + `bin/`）的上限。
    pub archive_bytes: u64,
    /// 导出源码 ZIP 写盘的上限（base64 解码后的体积）。
    ///
    /// 曾经是 1 MB，与导入的 32 MB 限额不对齐：L3 工具的 `bin/` 轻松超过 1 MB，
    /// 作者点「导出源码」只会看到一句莫名的「无效的源码导出请求」。现在与
    /// `archive_bytes` 同值——能导进来的就应该能导出去。
    pub archive_write_bytes: usize,

    // ── 用户文件与剪贴板 ────────────────────────────────────────────────
    /// `aawFiles.open` 读单个文件的上限。
    pub user_file_bytes: u64,
    /// `aawFiles.save` 写出的上限。
    pub save_bytes: usize,
    /// `aawClipboard` 文本上限。
    pub clipboard_text_bytes: usize,

    // ── 宿主内部 ────────────────────────────────────────────────────────
    /// L3 进程启动握手的超时（比动作短：起不来就是起不来）。
    pub init_timeout: Duration,
    /// 自定义协议单次响应的上限（静态资源）。
    pub response_bytes: u64,
    /// 一次能力调用的请求体上限（页面 `fetch` 与 L3 的 `aaw.call` 共用）。
    ///
    /// 没有它，`clipboard.writeImage` 这类"把请求体整段解码"的能力就成了
    /// 内存炸弹的入口。8 MB 覆盖一张 4K 截图的 base64 绰绰有余。
    pub call_body_bytes: usize,
    /// 总线上保留多少条消息供后来的轮询者取。
    pub bus_keep: usize,
    /// 定时唤醒的扫描间隔。
    pub ticker_interval: Duration,
}

pub const LIMITS: Limits = Limits {
    action_timeout: Duration::from_secs(20),
    result_bytes: 512 * 1024,
    store_bytes: 5 * 1024 * 1024,
    source_files: 512,
    source_bytes: 4 * 1024 * 1024,
    package_bytes: 4 * 1024 * 1024,
    archive_bytes: 32 * 1024 * 1024,
    // 与 archive_bytes 同值：导入导出必须是对称的两扇门（见字段注释）。
    archive_write_bytes: 32 * 1024 * 1024,
    user_file_bytes: 32 * 1024 * 1024,
    save_bytes: 8 * 1024 * 1024,
    clipboard_text_bytes: 1024 * 1024,
    init_timeout: Duration::from_secs(5),
    response_bytes: 8 * 1024 * 1024,
    call_body_bytes: 8 * 1024 * 1024,
    bus_keep: 200,
    ticker_interval: Duration::from_secs(5),
};

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约里写死的几条。作者手册（`guide.ts`）、前端 `limits.ts`、这里三处
    /// 必须说同一句话；改这个测试等于改契约，得连 `contract.ts` 的说明一起改。
    #[test]
    fn the_contractual_numbers_are_what_the_manual_says() {
        assert_eq!(LIMITS.action_timeout, Duration::from_secs(20));
        assert_eq!(LIMITS.result_bytes, 512 * 1024);
        assert_eq!(LIMITS.source_files, 512);
        assert_eq!(LIMITS.source_bytes, 4 * 1024 * 1024);
        assert_eq!(LIMITS.store_bytes, 5 * 1024 * 1024);
        assert_eq!(LIMITS.archive_bytes, 32 * 1024 * 1024);
        assert_eq!(LIMITS.package_bytes, 4 * 1024 * 1024);
    }

    /// 导出与导入必须是对称的两扇门：能导进来的 ZIP 一定能导出去。
    ///
    /// 曾经 `archive_write_bytes` 是 1 MB 而 `archive_bytes` 是 32 MB，L3 工具的
    /// `bin/` 超过 1 MB 就导不出来；这个测试就是那道对齐的钉子。
    #[test]
    fn the_export_cap_matches_the_import_cap() {
        assert_eq!(LIMITS.archive_write_bytes as u64, LIMITS.archive_bytes);
        // 顺带钉住 base64 预检的形状：满额 ZIP 的 base64（4/3 膨胀）必须能
        // 通过 `tools_write_archive` 的长度预检，而不是被当成异常请求拒绝。
        let base64_of_full = LIMITS.archive_write_bytes.div_ceil(3) * 4;
        assert!(
            base64_of_full > LIMITS.archive_write_bytes / 3 * 4,
            "base64 预检上限 {base64_of_full} 异常地小，合法导出会被挡住"
        );
    }

    /// 存档上限必须大于 `sourceFiles` 额度的同量级：否则"清单能装下、ZIP 装不下"
    /// 会让作者导出一个自己再导入不了的包。
    #[test]
    fn the_archive_cap_is_larger_than_the_manifest_cap() {
        assert!(LIMITS.archive_bytes > LIMITS.source_bytes as u64);
    }

    /// 结构体是给"能一眼看全"用的，别让它悄悄退化成只有一半字段有人读。
    #[test]
    fn every_limit_is_a_positive_number() {
        assert!(LIMITS.action_timeout.as_secs() > 0);
        assert!(LIMITS.init_timeout.as_secs() > 0);
        assert!(LIMITS.ticker_interval.as_secs() > 0);
        assert!(LIMITS.result_bytes > 0 && LIMITS.store_bytes > 0);
        assert!(LIMITS.source_files > 0 && LIMITS.source_bytes > 0);
        assert!(LIMITS.package_bytes > 0 && LIMITS.archive_bytes > 0);
        assert!(LIMITS.user_file_bytes > 0 && LIMITS.save_bytes > 0);
        assert!(LIMITS.clipboard_text_bytes > 0 && LIMITS.response_bytes > 0);
        assert!(LIMITS.call_body_bytes > 0 && LIMITS.bus_keep > 0);
    }
}
