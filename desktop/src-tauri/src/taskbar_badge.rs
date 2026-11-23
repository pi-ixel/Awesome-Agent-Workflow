//! Windows 主窗口的未读徽标。计数由工作台提供，随任务栏按钮重建恢复。

#[tauri::command]
pub fn set_taskbar_unread(window: tauri::WebviewWindow, count: u32) -> Result<(), String> {
    if window.label() != "main" {
        return Ok(());
    }
    #[cfg(windows)]
    native::set_count(window, count)?;
    #[cfg(not(windows))]
    let _ = count;
    Ok(())
}

#[cfg(windows)]
pub use native::install;

#[cfg(windows)]
mod native {
    use std::cell::Cell;
    use tauri::WebviewWindow;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
    use windows::Win32::UI::Shell::{
        DefSubclassProc, ITaskbarList3, RemoveWindowSubclass, SetWindowSubclass, TaskbarList,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIconFromResourceEx, DestroyIcon, HICON, IsWindowVisible, LR_DEFAULTCOLOR,
        RegisterWindowMessageW, WM_NCDESTROY,
    };
    use windows::core::{Error, PCWSTR, w};

    thread_local! {
        // 只有主窗口的 UI 线程访问。隐藏到托盘时保留最新计数。
        static UNREAD: Cell<u32> = const { Cell::new(0) };
    }

    const SUBCLASS_ID: usize = 1;

    pub fn install(window: &WebviewWindow) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        // setup 运行在窗口线程，必须在该线程安装子类回调。
        let created = unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) };
        if created == 0
            || !unsafe { SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, created as usize) }
                .as_bool()
        {
            return Err(Error::from_thread().to_string());
        }
        Ok(())
    }

    pub fn set_count(window: WebviewWindow, count: u32) -> Result<(), String> {
        let owner = window.clone();
        window
            .run_on_main_thread(move || {
                let Ok(hwnd) = owner.hwnd() else { return };
                UNREAD.set(count);
                refresh(hwnd);
            })
            .map_err(|error| error.to_string())
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        taskbar_button_created: usize,
    ) -> LRESULT {
        if msg == WM_NCDESTROY {
            UNREAD.set(0);
            let _ = unsafe { RemoveWindowSubclass(hwnd, Some(window_proc), id) };
        }
        let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
        if msg as usize == taskbar_button_created {
            // 从托盘恢复或 Explorer 重启都会重新创建任务栏按钮。
            refresh(hwnd);
        }
        result
    }

    fn refresh(hwnd: HWND) {
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return;
        }
        if let Err(error) = apply_icon(hwnd, UNREAD.get()) {
            eprintln!("更新任务栏徽标失败: {error}");
        }
    }

    fn apply_icon(hwnd: HWND, count: u32) -> windows::core::Result<()> {
        let taskbar: ITaskbarList3 =
            unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)? };
        unsafe { taskbar.HrInit()? };
        if count == 0 {
            return unsafe { taskbar.SetOverlayIcon(hwnd, HICON::default(), PCWSTR::null()) };
        }
        let icon = create_icon(count)?;
        let description: Vec<u16> = format!("{count} 项未读\0").encode_utf16().collect();
        let result = unsafe { taskbar.SetOverlayIcon(hwnd, icon, PCWSTR(description.as_ptr())) };
        // Explorer 复制图标；无论成功还是失败，都释放本进程的句柄。
        let _ = unsafe { DestroyIcon(icon) };
        result
    }

    const SIDE: usize = 16;
    const HEADER_SIZE: usize = 40;
    const MASK_OFFSET: usize = HEADER_SIZE + SIDE * SIDE * 4;
    const MASK_STRIDE: usize = 4;
    const GLYPHS: [[u8; 5]; 11] = [
        [7, 5, 5, 5, 7],
        [2, 6, 2, 2, 7],
        [7, 1, 7, 4, 7],
        [7, 1, 7, 1, 7],
        [5, 5, 7, 1, 1],
        [7, 4, 7, 1, 7],
        [7, 4, 7, 5, 7],
        [7, 1, 2, 2, 2],
        [7, 5, 7, 5, 7],
        [7, 5, 7, 1, 7],
        [0, 2, 7, 2, 0],
    ];

    // Win32 的图标资源由 DWORD 对齐的 DIB、BGRA 像素和按行对齐的透明蒙版组成。
    #[repr(align(4))]
    struct BadgeResource([u8; MASK_OFFSET + SIDE * MASK_STRIDE]);

    fn badge_label(count: u32) -> String {
        if count > 99 {
            "99+".into()
        } else {
            count.to_string()
        }
    }

    fn badge_resource(count: u32) -> BadgeResource {
        let label = badge_label(count);
        let mut resource = BadgeResource([0; MASK_OFFSET + SIDE * MASK_STRIDE]);
        let data = &mut resource.0;
        data[0] = HEADER_SIZE as u8;
        data[4] = SIDE as u8;
        data[8] = (SIDE * 2) as u8;
        data[12] = 1;
        data[14] = 32;
        data[MASK_OFFSET..].fill(0xff);
        let mut pixel = |x: usize, y: usize, color: [u8; 4]| {
            let row = SIDE - y - 1;
            let start = HEADER_SIZE + (row * SIDE + x) * 4;
            data[start..start + 4].copy_from_slice(&color);
            data[MASK_OFFSET + row * MASK_STRIDE + x / 8] &= !(0x80 >> (x % 8));
        };

        let radius = 6.0;
        let span = if label.len() == 1 {
            0.0
        } else {
            SIDE as f32 / 2.0 - radius
        };
        for y in 0..SIDE {
            for x in 0..SIDE {
                let dx = ((x as f32 + 0.5 - 8.0).abs() - span).max(0.0);
                let dy = y as f32 + 0.5 - 8.0;
                if dx * dx + dy * dy <= radius * radius {
                    // AAW 暖白主题的未读红底，使用白字保障系统浅色和深色任务栏上的对比度。
                    pixel(x, y, [0x29, 0x29, 0xc5, 0xff]);
                }
            }
        }

        let (glyph_width, glyph_height) = match label.len() {
            1 => (6, 10),
            2 => (5, 8),
            _ => (3, 6),
        };
        let text_width = (glyph_width + 1) * label.len() - 1;
        let left = (SIDE - text_width) / 2;
        let top = (SIDE - glyph_height) / 2;
        for (index, glyph) in label.bytes().enumerate() {
            let rows = &GLYPHS[if glyph == b'+' {
                10
            } else {
                (glyph - b'0') as usize
            }];
            for y in 0..glyph_height {
                for x in 0..glyph_width {
                    let row = rows[y * 5 / glyph_height];
                    if row & (4 >> (x * 3 / glyph_width)) != 0 {
                        pixel(left + index * (glyph_width + 1) + x, top + y, [0xff; 4]);
                    }
                }
            }
        }
        resource
    }

    fn create_icon(count: u32) -> windows::core::Result<HICON> {
        // 0x00030000 是 Win32 3.0 图标资源格式。
        unsafe {
            CreateIconFromResourceEx(
                &badge_resource(count).0,
                true,
                0x00030000,
                SIDE as i32,
                SIDE as i32,
                LR_DEFAULTCOLOR,
            )
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn windows_accepts_single_double_and_capped_numeric_icons() {
            for count in [1, 9, 10, 99, 100, u32::MAX] {
                let icon = create_icon(count).expect("Windows should accept the badge DIB");
                unsafe { DestroyIcon(icon).unwrap() };
            }
            assert_ne!(badge_resource(1).0, badge_resource(9).0);
            assert_ne!(badge_resource(99).0, badge_resource(100).0);
            assert_eq!(badge_label(99), "99");
            assert_eq!(badge_label(100), "99+");
            assert_eq!(badge_resource(100).0, badge_resource(u32::MAX).0);
        }
    }
}
