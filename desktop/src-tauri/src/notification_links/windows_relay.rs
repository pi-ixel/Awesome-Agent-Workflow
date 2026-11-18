use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::{ROUTE_LIMIT, valid_route};

const INSTANCE_SUFFIX: &str = "&aawNotificationInstance=";
pub(super) const ACTIVATE: &str = "aaw://activate";
const RETRY_WINDOW: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(200);
const REPLY_TIMEOUT: Duration = Duration::from_secs(2);

fn root() -> io::Result<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|path| PathBuf::from(path).join("com.aaw.desktop"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA"))
}

fn lock_file(path: PathBuf) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

/// 同一用户的不同安装目录、版本和开发构建共用一个实例锁。
/// 进程退出或崩溃后，由操作系统释放实例锁。
fn admit(root: &Path) -> io::Result<Option<File>> {
    fs::create_dir_all(root)?;
    let presence = lock_file(root.join("notification-presence.lock"))?;
    match presence.try_lock() {
        Ok(()) => Ok(Some(presence)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

pub(super) fn prepare(route: Option<&str>) -> io::Result<Option<File>> {
    prepare_in(&root()?, route)
}

fn prepare_in(root: &Path, route: Option<&str>) -> io::Result<Option<File>> {
    let presence = admit(root)?;
    if presence.is_some() {
        // Older installed copies have the legacy relay and no presence lock.
        if let Some(route) = route {
            match forward(&root.join("notification-relay"), route) {
                Delivery::Accepted => return Ok(None),
                Delivery::Unconfirmed => return Err(resident_unresponsive()),
                Delivery::Unavailable => {}
            }
        }
        return Ok(presence);
    }

    let request = route.unwrap_or(ACTIVATE);
    let deadline = Instant::now() + RETRY_WINDOW;
    loop {
        match forward_to_resident(root, request) {
            Delivery::Accepted => return Ok(None),
            Delivery::Unconfirmed => return Err(resident_unresponsive()),
            Delivery::Unavailable => {}
        }
        // 旧进程可能在启动或退出期间结束，此时新进程可以接管。
        if let Some(presence) = admit(root)? {
            return Ok(Some(presence));
        }
        if Instant::now() >= deadline {
            return Err(resident_unresponsive());
        }
        std::thread::sleep(Duration::from_millis(60));
    }
}

fn resident_unresponsive() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "AAW 已在运行但暂未响应，请稍后重试。",
    )
}

#[derive(PartialEq, Eq)]
enum Delivery {
    Unavailable,
    Accepted,
    Unconfirmed,
}

fn forward(file: &Path, route: &str) -> Delivery {
    let Ok(content) = fs::read_to_string(file) else {
        return Delivery::Unavailable;
    };
    let mut parts = content.split_whitespace();
    let (Some(port), Some(token), Some(pid)) = (parts.next(), parts.next(), parts.next()) else {
        return Delivery::Unavailable;
    };
    let (Ok(port), Ok(pid)) = (port.parse::<u16>(), pid.parse::<u32>()) else {
        return Delivery::Unavailable;
    };
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) else {
        return Delivery::Unavailable;
    };
    let _ = stream.set_read_timeout(Some(REPLY_TIMEOUT));
    let _ = stream.set_write_timeout(Some(REPLY_TIMEOUT));
    // 将本次启动获得的前台权限转交给已有进程。
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid);
    }
    let mut reply = String::new();
    if stream
        .write_all(format!("{token} {route}\n").as_bytes())
        .is_err()
        || BufReader::new(stream.take(16))
            .read_line(&mut reply)
            .is_err()
    {
        return Delivery::Unconfirmed;
    }
    match reply.trim() {
        "ok" => Delivery::Accepted,
        "no" => Delivery::Unavailable,
        _ => Delivery::Unconfirmed,
    }
}

fn route_owner(route: &str) -> Option<&str> {
    let (_, owner) = route.rsplit_once(INSTANCE_SUFFIX)?;
    (owner.len() == 32 && owner.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(owner)
}

fn forward_to_resident(root: &Path, route: &str) -> Delivery {
    let directory = root.join("notification-instances");
    if let Some(owner) = route_owner(route) {
        let delivery = forward(&directory.join(owner), route);
        if delivery != Delivery::Unavailable {
            return delivery;
        }
    }

    // Notifications created before instance routing was introduced have no owner.
    // Try the most recently registered receivers first, then the legacy relay.
    let mut candidates: Vec<_> = fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().len() == 32)
        .map(|entry| {
            (
                entry.metadata().and_then(|meta| meta.modified()).ok(),
                entry.path(),
            )
        })
        .collect();
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in candidates {
        let delivery = forward(&path, route);
        if delivery != Delivery::Unavailable {
            return delivery;
        }
    }
    forward(&root.join("notification-relay"), route)
}

fn random_id() -> io::Result<String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| io::Error::other("随机数不可用"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(super) struct Registration {
    id: String,
    descriptor: PathBuf,
}

impl Registration {
    pub(super) fn addressed_route(&self, route: &str) -> String {
        let addressed = format!("{route}{INSTANCE_SUFFIX}{}", self.id);
        if valid_route(&addressed) {
            addressed
        } else {
            route.to_owned()
        }
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.descriptor);
    }
}

pub(super) fn listen(
    deliver: impl Fn(String) -> io::Result<()> + Send + 'static,
) -> io::Result<Registration> {
    let root = root()?;
    let directory = root.join("notification-instances");
    fs::create_dir_all(&directory)?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let id = random_id()?;
    let token = random_id()?;
    let registration = Registration {
        descriptor: directory.join(&id),
        id,
    };

    let address = format!("{port} {token} {}", std::process::id());
    std::thread::Builder::new()
        .name("notification-relay".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                if let Err(error) = handle_request(stream, &token, &deliver) {
                    eprintln!("AAW 唤起失败: {error}");
                }
            }
        })?;
    let staging = directory.join(format!("{}.tmp", registration.id));
    fs::write(&staging, &address)?;
    fs::rename(staging, &registration.descriptor)?;
    if let Err(error) = fs::write(root.join("notification-relay"), address) {
        eprintln!("兼容旧版通知转交地址写入失败: {error}");
    }
    Ok(registration)
}

fn handle_request(
    mut stream: TcpStream,
    token: &str,
    deliver: &impl Fn(String) -> io::Result<()>,
) -> io::Result<()> {
    stream.set_read_timeout(Some(REPLY_TIMEOUT))?;
    stream.set_write_timeout(Some(REPLY_TIMEOUT))?;
    let mut line = String::new();
    let limit = (ROUTE_LIMIT + 64) as u64;
    BufReader::new((&stream).take(limit)).read_line(&mut line)?;
    let request = line
        .strip_suffix('\n')
        .and_then(|line| line.split_once(' '));
    match request {
        Some((given, request))
            if given == token && (request == ACTIVATE || valid_route(request)) =>
        {
            // 主窗口实际处理完唤起请求后才确认成功。
            deliver(request.to_owned())?;
            stream.write_all(b"ok\n")
        }
        _ => stream.write_all(b"no\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROUTE: &str = "aaw://notification?project=example&sessionId=demo";
    const OWNER: &str = "00000000000000000000000000000001";
    const OTHER: &str = "00000000000000000000000000000002";

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> io::Result<Self> {
            let path = std::env::temp_dir().join(format!("aaw-notification-test-{}", random_id()?));
            fs::create_dir(&path)?;
            Ok(Self(path))
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn descriptor(root: &Path, name: &str, listener: &TcpListener) -> io::Result<()> {
        let port = listener.local_addr()?.port();
        fs::write(
            root.join(name),
            format!("{port} token {}", std::process::id()),
        )
    }

    fn serve_once(
        listener: TcpListener,
        deliver: impl Fn(String) -> io::Result<()> + Send + 'static,
    ) -> std::thread::JoinHandle<io::Result<()>> {
        std::thread::spawn(move || {
            listener.set_nonblocking(true)?;
            let deadline = Instant::now() + Duration::from_secs(4);
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_nonblocking(false)?;
                        return handle_request(stream, "token", &deliver);
                    }
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(error) => return Err(error),
                }
            }
        })
    }

    #[test]
    fn every_launch_requires_exclusive_presence_and_exit_releases_it() -> io::Result<()> {
        let root = TestDirectory::new()?;
        let resident = prepare_in(root.path(), None)?.expect("manual launch");
        assert!(admit(root.path())?.is_none());
        drop(resident);

        let cold = prepare_in(root.path(), Some(ROUTE))?.expect("cold activation");
        assert!(admit(root.path())?.is_none());
        drop(cold);
        assert!(admit(root.path())?.is_some());
        Ok(())
    }

    #[test]
    fn concurrent_launches_admit_one_owner() -> io::Result<()> {
        let root = TestDirectory::new()?;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let launches: Vec<_> = (0..8)
            .map(|_| {
                let root = root.path().to_owned();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    admit(&root)
                })
            })
            .collect();
        let owners: Vec<_> = launches
            .into_iter()
            .map(|launch| launch.join().expect("launch thread"))
            .collect::<io::Result<_>>()?;
        assert_eq!(owners.iter().filter(|owner| owner.is_some()).count(), 1);
        Ok(())
    }

    #[test]
    fn legacy_shared_presence_also_blocks_a_new_desktop() -> io::Result<()> {
        let root = TestDirectory::new()?;
        let legacy = lock_file(root.path().join("notification-presence.lock"))?;
        legacy.lock_shared()?;
        assert!(admit(root.path())?.is_none());
        drop(legacy);
        assert!(admit(root.path())?.is_some());
        Ok(())
    }

    #[test]
    fn duplicate_manual_launch_activates_resident_and_exits() -> io::Result<()> {
        let root = TestDirectory::new()?;
        let _resident = admit(root.path())?.expect("resident");
        // 旧版启动器可能持有启动锁，同时等待当前实例退出。
        let legacy_startup = lock_file(root.path().join("notification-startup.lock"))?;
        legacy_startup.lock()?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        descriptor(root.path(), "notification-relay", &listener)?;
        let receiver = serve_once(listener, |request| {
            assert_eq!(request, ACTIVATE);
            Ok(())
        });
        assert!(prepare_in(root.path(), None)?.is_none());
        receiver.join().expect("receiver")?;
        Ok(())
    }

    #[test]
    fn normalized_notification_reuses_resident_and_preserves_route() -> io::Result<()> {
        let root = TestDirectory::new()?;
        let _resident = admit(root.path())?.expect("resident");
        let route =
            format!("aaw://notification/?project=example&sessionId=demo{INSTANCE_SUFFIX}{OWNER}");
        assert!(valid_route(&route));
        let directory = root.path().join("notification-instances");
        fs::create_dir(&directory)?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        descriptor(&directory, OWNER, &listener)?;
        let expected = route.clone();
        let receiver = serve_once(listener, move |request| {
            assert_eq!(request, expected);
            Ok(())
        });
        assert!(prepare_in(root.path(), Some(&route))?.is_none());
        receiver.join().expect("receiver")?;
        Ok(())
    }

    #[test]
    fn duplicate_waits_for_resident_listener_to_start() -> io::Result<()> {
        let root = TestDirectory::new()?;
        let _resident = admit(root.path())?.expect("resident");
        let directory = root.path().to_owned();
        let receiver = std::thread::spawn(move || -> io::Result<()> {
            std::thread::sleep(Duration::from_millis(150));
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
            descriptor(&directory, "notification-relay", &listener)?;
            serve_once(listener, |request| {
                assert_eq!(request, ACTIVATE);
                Ok(())
            })
            .join()
            .expect("receiver")
        });
        assert!(prepare_in(root.path(), None)?.is_none());
        receiver.join().expect("delayed receiver")?;
        Ok(())
    }

    #[test]
    fn failed_ui_activation_reports_unresponsive_and_keeps_owner() -> io::Result<()> {
        let root = TestDirectory::new()?;
        let _resident = admit(root.path())?.expect("resident");
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        descriptor(root.path(), "notification-relay", &listener)?;
        let receiver = serve_once(listener, |_| Err(io::Error::other("UI unavailable")));
        let error = prepare_in(root.path(), None).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().contains("AAW 已在运行但暂未响应"));
        assert!(receiver.join().expect("receiver").is_err());
        assert!(admit(root.path())?.is_none());
        Ok(())
    }

    #[test]
    fn missing_listener_reports_unresponsive_and_keeps_owner() -> io::Result<()> {
        let root = TestDirectory::new()?;
        let _resident = admit(root.path())?.expect("resident");
        let error = prepare_in(root.path(), None).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(admit(root.path())?.is_none());
        Ok(())
    }

    #[test]
    fn a_notification_from_an_exited_owner_reaches_the_current_resident() -> io::Result<()> {
        let root = TestDirectory::new()?;
        let _resident = admit(root.path())?.expect("resident");
        let directory = root.path().join("notification-instances");
        fs::create_dir(&directory)?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        descriptor(&directory, OTHER, &listener)?;
        let route = format!("{ROUTE}{INSTANCE_SUFFIX}{OWNER}");
        let expected = route.clone();
        let receiver = serve_once(listener, move |request| {
            assert_eq!(request, expected);
            Ok(())
        });
        assert!(prepare_in(root.path(), Some(&route))?.is_none());
        receiver.join().expect("receiver")?;
        Ok(())
    }

    #[test]
    fn invalid_token_cannot_activate_the_resident() -> io::Result<()> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let address = listener.local_addr()?;
        let receiver = serve_once(listener, |_| panic!("unauthorized activation"));
        let mut stream = TcpStream::connect(address)?;
        stream.set_read_timeout(Some(REPLY_TIMEOUT))?;
        stream.write_all(format!("wrong-token {ACTIVATE}\n").as_bytes())?;
        let mut reply = String::new();
        BufReader::new(stream).read_line(&mut reply)?;
        assert_eq!(reply, "no\n");
        receiver.join().expect("receiver")?;
        Ok(())
    }

    #[test]
    fn exited_resident_releases_presence_while_duplicate_is_waiting() -> io::Result<()> {
        let root = TestDirectory::new()?;
        let resident = admit(root.path())?.expect("resident");
        let exiting = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(resident);
        });
        let new_owner = prepare_in(root.path(), None)?.expect("new owner");
        exiting.join().expect("exiting resident");
        assert!(admit(root.path())?.is_none());
        drop(new_owner);
        Ok(())
    }

    #[test]
    #[ignore = "subprocess fixture for crash recovery"]
    fn hold_presence_in_child() -> io::Result<()> {
        let root = PathBuf::from(std::env::var_os("AAW_INSTANCE_TEST_ROOT").expect("test root"));
        let _resident = admit(&root)?.expect("child owner");
        fs::write(root.join("ready"), "")?;
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    #[test]
    fn killed_process_releases_presence_without_deleting_lock_files() -> io::Result<()> {
        use std::os::windows::process::CommandExt;
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let root = TestDirectory::new()?;
        let mut child = Child(
            std::process::Command::new(std::env::current_exe()?)
                .args([
                    "--ignored",
                    "--exact",
                    "notification_links::windows_relay::tests::hold_presence_in_child",
                ])
                .env("AAW_INSTANCE_TEST_ROOT", root.path())
                .creation_flags(0x08000000)
                .stdout(std::process::Stdio::null())
                .spawn()?,
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.path().join("ready").exists() {
            assert!(Instant::now() < deadline, "child did not acquire presence");
            assert!(
                child.0.try_wait()?.is_none(),
                "child exited before acquiring presence"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(admit(root.path())?.is_none());
        child.0.kill()?;
        child.0.wait()?;
        assert!(admit(root.path())?.is_some());
        Ok(())
    }

    #[test]
    fn addressed_notifications_use_their_original_resident() -> io::Result<()> {
        let root = TestDirectory::new()?;
        let directory = root.path().join("notification-instances");
        fs::create_dir(&directory)?;
        let original = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        original.set_nonblocking(true)?;
        descriptor(&directory, OWNER, &original)?;
        let unrelated = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        unrelated.set_nonblocking(true)?;
        descriptor(&directory, OTHER, &unrelated)?;
        let route = format!("{ROUTE}{INSTANCE_SUFFIX}{OWNER}");
        let expected = route.clone();
        let delivery = serve_once(original, move |request| {
            assert_eq!(request, expected);
            Ok(())
        });

        let resident = admit(root.path())?.expect("manual launch");
        assert!(prepare_in(root.path(), Some(&route))?.is_none());
        delivery.join().expect("relay thread")?;
        assert_eq!(
            unrelated.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(resident);
        Ok(())
    }
}
