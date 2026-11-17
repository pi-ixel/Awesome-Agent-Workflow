use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::{ROUTE_LIMIT, valid_route};

const INSTANCE_SUFFIX: &str = "&aawNotificationInstance=";
const RETRY_WINDOW: Duration = Duration::from_millis(1500);
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

/// Serialize launch decisions so two simultaneous activations cannot both cold-start.
/// Every running Desktop holds a shared presence lock, including ordinary manual launches.
fn admit(root: &Path, from_notification: bool) -> io::Result<Option<File>> {
    fs::create_dir_all(root)?;
    let startup = lock_file(root.join("notification-startup.lock"))?;
    startup.lock()?;
    let presence = lock_file(root.join("notification-presence.lock"))?;
    if from_notification {
        match presence.try_lock() {
            Ok(()) => presence.unlock()?,
            Err(TryLockError::WouldBlock) => return Ok(None),
            Err(TryLockError::Error(error)) => return Err(error),
        }
    }
    presence.lock_shared()?;
    Ok(Some(presence))
}

pub(super) fn prepare(route: Option<&str>) -> io::Result<Option<File>> {
    prepare_in(&root()?, route)
}

fn prepare_in(root: &Path, route: Option<&str>) -> io::Result<Option<File>> {
    let presence = admit(root, route.is_some())?;
    let Some(route) = route else {
        return Ok(presence);
    };

    if presence.is_some() {
        // Older installed copies have the legacy relay and no presence lock.
        return if forward(&root.join("notification-relay"), route) == Delivery::Unavailable {
            Ok(presence)
        } else {
            Ok(None)
        };
    }

    let deadline = Instant::now() + RETRY_WINDOW;
    loop {
        if forward_to_resident(root, route) != Delivery::Unavailable || Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(60));
    }
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
    // Windows grants foreground permission to the process launched by the toast.
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
        return forward(&directory.join(owner), route);
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

pub(super) fn listen(deliver: impl Fn(String) + Send + 'static) -> io::Result<Registration> {
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
                let _ = stream.set_read_timeout(Some(REPLY_TIMEOUT));
                let _ = stream.set_write_timeout(Some(REPLY_TIMEOUT));
                let mut line = String::new();
                let limit = (ROUTE_LIMIT + 64) as u64;
                if BufReader::new((&stream).take(limit))
                    .read_line(&mut line)
                    .is_err()
                {
                    continue;
                }
                let route = line
                    .strip_suffix('\n')
                    .and_then(|line| line.split_once(' '));
                let accepted = match route {
                    Some((given, route)) if given == token && valid_route(route) => {
                        deliver(route.to_owned());
                        true
                    }
                    _ => false,
                };
                let _ = (&stream).write_all(if accepted { b"ok\n" } else { b"no\n" });
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

    #[test]
    fn resident_presence_blocks_notification_start_even_without_a_relay() -> io::Result<()> {
        let root = TestDirectory::new()?;
        let resident = admit(root.path(), false)?.expect("manual launch");
        let second = admit(root.path(), false)?.expect("second manual launch");
        drop(second);
        assert!(prepare_in(root.path(), Some(ROUTE))?.is_none());
        drop(resident);

        let cold = prepare_in(root.path(), Some(ROUTE))?.expect("cold activation");
        assert!(admit(root.path(), true)?.is_none());
        drop(cold);
        assert!(admit(root.path(), true)?.is_some());
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
        let delivery = std::thread::spawn(move || -> io::Result<String> {
            let deadline = Instant::now() + Duration::from_secs(4);
            let mut stream = loop {
                match original.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(error) => return Err(error),
                }
            };
            stream.set_nonblocking(false)?;
            stream.set_read_timeout(Some(REPLY_TIMEOUT))?;
            let mut message = String::new();
            BufReader::new(&stream).read_line(&mut message)?;
            stream.write_all(b"ok\n")?;
            Ok(message)
        });

        let resident = admit(root.path(), false)?.expect("manual launch");
        assert!(prepare_in(root.path(), Some(&route))?.is_none());
        assert_eq!(
            delivery.join().expect("relay thread")?,
            format!("token {expected}\n")
        );
        assert_eq!(
            unrelated.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(resident);
        Ok(())
    }
}
