//! Minimal inotify (Linux) through direct libc FFI, so the events file is
//! read as soon as it changes instead of polling it every second.

use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::FromRawFd;
use std::os::raw::{c_char, c_int};
use std::path::Path;

unsafe extern "C" {
    fn inotify_init1(flags: c_int) -> c_int;
    fn inotify_add_watch(fd: c_int, pathname: *const c_char, mask: u32) -> c_int;
}

const IN_CLOEXEC: c_int = 0o2000000;
pub const IN_MODIFY: u32 = 0x0000_0002;
pub const IN_CLOSE_WRITE: u32 = 0x0000_0008;
pub const IN_MOVED_TO: u32 = 0x0000_0080;
pub const IN_CREATE: u32 = 0x0000_0100;

pub struct Inotify {
    file: File,
}

/// One event: the name of the file inside the watched directory, if any
pub struct Event {
    pub name: Vec<u8>,
}

impl Inotify {
    /// Watch a directory for `mask` events on its entries
    pub fn watch_dir(dir: &Path, mask: u32) -> io::Result<Self> {
        let path = CString::new(dir.as_os_str().as_encoded_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
        // SAFETY: plain syscalls; the fd is owned by `File` from here on
        unsafe {
            let fd = inotify_init1(IN_CLOEXEC);
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let file = File::from_raw_fd(fd);
            if inotify_add_watch(fd, path.as_ptr(), mask) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { file })
        }
    }

    /// Block until events arrive and return them
    pub fn read_events(&mut self) -> io::Result<Vec<Event>> {
        let mut buf = [0u8; 4096];
        let n = self.file.read(&mut buf)?;
        let mut events = Vec::new();
        let mut offset = 0;
        // struct inotify_event { int wd; uint32_t mask, cookie, len; char name[]; }
        while offset + 16 <= n {
            let len =
                u32::from_ne_bytes(buf[offset + 12..offset + 16].try_into().unwrap()) as usize;
            let name_bytes = &buf[offset + 16..(offset + 16 + len).min(n)];
            let name_end = name_bytes
                .iter()
                .position(|&b| b == 0)
                .unwrap_or(name_bytes.len());
            events.push(Event {
                name: name_bytes[..name_end].to_vec(),
            });
            offset += 16 + len;
        }
        Ok(events)
    }
}
