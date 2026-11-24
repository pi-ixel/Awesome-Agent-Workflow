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
    use windows::Win32::Foundation::{COLORREF, E_FAIL, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        ANTIALIASED_QUALITY, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CLIP_DEFAULT_PRECIS,
        CreateCompatibleDC, CreateDIBSection, CreateFontW, DEFAULT_CHARSET, DIB_RGB_COLORS,
        DT_CENTER, DT_SINGLELINE, DT_VCENTER, DeleteDC, DeleteObject, DrawTextW, FW_NORMAL,
        GdiFlush, HBITMAP, HDC, HFONT, HGDIOBJ, OUT_DEFAULT_PRECIS, SelectObject, SetBkMode,
        SetTextColor, TRANSPARENT,
    };
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Shell::{
        DefSubclassProc, ITaskbarList3, RemoveWindowSubclass, SetWindowSubclass, TaskbarList,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIconFromResourceEx, DestroyIcon, HICON, IsWindowVisible, LR_DEFAULTCOLOR,
        RegisterWindowMessageW, WM_DPICHANGED, WM_NCDESTROY,
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
        if msg as usize == taskbar_button_created || msg == WM_DPICHANGED {
            // 任务栏按钮重建或 DPI 变化后重新绘制徽标。
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
        let dpi = unsafe { GetDpiForWindow(hwnd) }.clamp(96, 768);
        let side = ((16 * dpi + 48) / 96) as usize;
        let icon = create_icon(count, side)?;
        let description: Vec<u16> = format!("{count} 项未读\0").encode_utf16().collect();
        let result = unsafe { taskbar.SetOverlayIcon(hwnd, icon, PCWSTR(description.as_ptr())) };
        // Explorer 复制图标；无论成功还是失败，都释放本进程的句柄。
        let _ = unsafe { DestroyIcon(icon) };
        result
    }

    const HEADER_SIZE: usize = 40;
    const FACE_BGR: [u8; 3] = [0x2d, 0x25, 0x26];
    const INK: u8 = 0xf2;
    const OVERSAMPLE: usize = 4;

    struct TextCanvas {
        dc: HDC,
        font: HFONT,
        bitmap: HBITMAP,
    }

    impl Drop for TextCanvas {
        fn drop(&mut self) {
            unsafe {
                // 先释放 DC，使字体和位图解除选中，再销毁这两个对象。
                let _ = DeleteDC(self.dc);
                if !self.font.is_invalid() {
                    let _ = DeleteObject(HGDIOBJ(self.font.0));
                }
                if !self.bitmap.is_invalid() {
                    let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
                }
            }
        }
    }

    fn badge_label(count: u32) -> String {
        if count > 99 {
            "99+".into()
        } else {
            count.to_string()
        }
    }

    fn label_coverage(label: &str, side: usize) -> windows::core::Result<Vec<f32>> {
        // 先在更大尺寸绘制系统字体，再按目标像素取平均，保留笔画的灰度边缘。
        let render_side = side * OVERSAMPLE;
        let size = render_side as i32;
        let mut canvas = TextCanvas {
            dc: unsafe { CreateCompatibleDC(None) },
            font: HFONT::default(),
            bitmap: HBITMAP::default(),
        };
        if canvas.dc.is_invalid() {
            return Err(Error::from_thread());
        }
        let font_height =
            size * match label.len() {
                1 => 83,
                2 => 68,
                _ => 53,
            } / 100;
        canvas.font = unsafe {
            CreateFontW(
                -font_height,
                0,
                0,
                0,
                FW_NORMAL.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                ANTIALIASED_QUALITY,
                0,
                w!("Segoe UI"),
            )
        };
        if canvas.font.is_invalid() {
            return Err(Error::from_thread());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size,
                biHeight: -size,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = std::ptr::null_mut();
        canvas.bitmap = unsafe {
            CreateDIBSection(Some(canvas.dc), &info, DIB_RGB_COLORS, &mut pixels, None, 0)?
        };
        let mut text: Vec<u16> = label.encode_utf16().collect();
        let mut bounds = RECT {
            left: 0,
            top: 0,
            right: size,
            bottom: size,
        };
        let byte_len = render_side * render_side * 4;
        let pixels = unsafe {
            std::ptr::write_bytes(pixels.cast::<u8>(), 0, byte_len);
            if SelectObject(canvas.dc, HGDIOBJ(canvas.bitmap.0)).is_invalid()
                || SelectObject(canvas.dc, HGDIOBJ(canvas.font.0)).is_invalid()
            {
                return Err(Error::from_thread());
            }
            SetBkMode(canvas.dc, TRANSPARENT);
            SetTextColor(canvas.dc, COLORREF(0x00ff_ffff));
            if DrawTextW(
                canvas.dc,
                &mut text,
                &mut bounds,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE,
            ) == 0
                || !GdiFlush().as_bool()
            {
                return Err(Error::new(E_FAIL, "无法绘制任务栏数字"));
            }
            std::slice::from_raw_parts(pixels.cast::<u8>(), byte_len)
        };

        let mut coverage = Vec::with_capacity(side * side);
        for y in 0..side {
            for x in 0..side {
                let mut shade = 0u32;
                for sample_y in y * OVERSAMPLE..(y + 1) * OVERSAMPLE {
                    for sample_x in x * OVERSAMPLE..(x + 1) * OVERSAMPLE {
                        shade += u32::from(pixels[(sample_y * render_side + sample_x) * 4]);
                    }
                }
                coverage.push(shade as f32 / (255 * OVERSAMPLE * OVERSAMPLE) as f32);
            }
        }
        Ok(coverage)
    }

    // Win32 图标资源的起始地址必须按 DWORD 对齐。
    struct BadgeResource(Vec<u32>);

    impl BadgeResource {
        fn bytes(&self) -> &[u8] {
            unsafe { std::slice::from_raw_parts(self.0.as_ptr().cast(), self.0.len() * 4) }
        }

        fn bytes_mut(&mut self) -> &mut [u8] {
            unsafe { std::slice::from_raw_parts_mut(self.0.as_mut_ptr().cast(), self.0.len() * 4) }
        }
    }

    fn badge_resource(count: u32, side: usize) -> windows::core::Result<BadgeResource> {
        let text = label_coverage(&badge_label(count), side)?;
        let mask_offset = HEADER_SIZE + side * side * 4;
        let mask_stride = side.div_ceil(32) * 4;
        let mut resource = BadgeResource(vec![0; (mask_offset + side * mask_stride) / 4]);
        let data = resource.bytes_mut();
        data[0..4].copy_from_slice(&(HEADER_SIZE as u32).to_le_bytes());
        data[4..8].copy_from_slice(&(side as u32).to_le_bytes());
        data[8..12].copy_from_slice(&((side * 2) as u32).to_le_bytes());
        data[12] = 1;
        data[14] = 32;
        data[mask_offset..].fill(0xff);

        let center = side as f32 / 2.0;
        for y in 0..side {
            let row = side - y - 1;
            for x in 0..side {
                let dx = x as f32 + 0.5 - center;
                let dy = y as f32 + 0.5 - center;
                let opacity = (center - dx.hypot(dy)).clamp(0.0, 1.0);
                let alpha = (255.0 * opacity).round() as u8;
                if alpha == 0 {
                    continue;
                }
                let ink = text[y * side + x];
                let [blue, green, red] = FACE_BGR.map(|value| {
                    ((f32::from(value) + f32::from(INK - value) * ink) * opacity).round() as u8
                });
                let offset = HEADER_SIZE + (row * side + x) * 4;
                data[offset..offset + 4].copy_from_slice(&[blue, green, red, alpha]);
                data[mask_offset + row * mask_stride + x / 8] &= !(0x80 >> (x % 8));
            }
        }
        Ok(resource)
    }

    fn create_icon(count: u32, side: usize) -> windows::core::Result<HICON> {
        let resource = badge_resource(count, side)?;
        // 0x00030000 是 Win32 3.0 图标资源格式。
        unsafe {
            CreateIconFromResourceEx(
                resource.bytes(),
                true,
                0x00030000,
                side as i32,
                side as i32,
                LR_DEFAULTCOLOR,
            )
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn windows_accepts_numeric_icons_at_multiple_dpi_levels() {
            for side in [16, 20, 24, 32] {
                for count in [1, 4, 9, 10, 99, 100, u32::MAX] {
                    let icon =
                        create_icon(count, side).expect("Windows should accept the badge DIB");
                    unsafe { DestroyIcon(icon).unwrap() };
                }
            }
            assert_ne!(
                badge_resource(1, 16).unwrap().0,
                badge_resource(9, 16).unwrap().0
            );
            assert_ne!(
                badge_resource(99, 16).unwrap().0,
                badge_resource(100, 16).unwrap().0
            );
            assert_eq!(badge_label(100), "99+");
            assert_eq!(
                badge_resource(100, 16).unwrap().0,
                badge_resource(u32::MAX, 16).unwrap().0
            );
        }

        #[test]
        fn single_double_and_capped_counts_keep_a_round_badge_with_antialiased_text() {
            let side = 16;
            for count in [4, 12, 100] {
                let badge = badge_resource(count, side).unwrap();
                let pixels = &badge.bytes()[HEADER_SIZE..HEADER_SIZE + side * side * 4];
                let alpha = |x, y| pixels[(y * side + x) * 4 + 3];
                assert_eq!(alpha(0, 0), 0);
                assert!((1..255).contains(&alpha(7, 0)));
                assert_eq!(alpha(7, 0), alpha(0, 7));
                assert_eq!(alpha(7, 0), alpha(7, 15));
                assert_eq!(alpha(7, 0), alpha(15, 7));
                assert!(
                    pixels
                        .chunks_exact(4)
                        .any(|pixel| pixel[3] == 255 && pixel[2] > 200)
                );
                assert!(
                    pixels
                        .chunks_exact(4)
                        .any(|pixel| pixel[3] == 255 && (50..195).contains(&pixel[2]))
                );
            }
        }
    }
}
