//! Helper-process attribution: responsible process → parent chain → outermost `.app` in the path.
//! WebKit's GPU process (Safari, WKWebView apps) lives outside the app bundle, so path alone is wrong;
//! the responsible-process call is private SPI with a graceful fallback (Fader, MIT).

use std::path::{Path, PathBuf};

/// System daemons whose audio is not something users mean to record.
pub const IGNORED_PROCESS_NAMES: &[&str] = &[
    "coreaudiod", "corespeechd", "systemsoundserverd", "audiomxd", "WindowServer", "universalaccessd",
    "callservicesd", "assistantd", "siriactionsd", "SiriNCService", "ControlCenter", "NotificationCenter",
];

#[cfg(target_os = "macos")]
type ResponsibleFn = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;

#[cfg(target_os = "macos")]
fn responsible_fn() -> Option<ResponsibleFn> {
    use std::sync::OnceLock;
    static F: OnceLock<Option<usize>> = OnceLock::new();
    let addr = *F.get_or_init(|| unsafe {
        let name = c"responsibility_get_pid_responsible_for_pid";
        let sym = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr());
        (!sym.is_null()).then_some(sym as usize)
    });
    addr.map(|a| unsafe { std::mem::transmute::<usize, ResponsibleFn>(a) })
}

/// The app process responsible for `pid` (itself when unknown).
pub fn responsible_pid(pid: i32) -> i32 {
    #[cfg(target_os = "macos")]
    if let Some(f) = responsible_fn() {
        let owner = unsafe { f(pid) };
        if owner > 0 {
            return owner;
        }
    }
    pid
}

pub fn parent_pid(pid: i32) -> Option<i32> {
    #[cfg(target_os = "macos")]
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let n = libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size);
        if n == size && info.pbi_ppid > 1 {
            return Some(info.pbi_ppid as i32);
        }
    }
    let _ = pid;
    None
}

pub fn exe_path(pid: i32) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    unsafe {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let n = libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32);
        if n > 0 {
            buf.truncate(n as usize);
            return Some(PathBuf::from(String::from_utf8_lossy(&buf).into_owned()));
        }
    }
    let _ = pid;
    None
}

pub fn process_name(pid: i32) -> Option<String> {
    #[cfg(target_os = "macos")]
    unsafe {
        let mut buf = vec![0u8; 256];
        let n = libc::proc_name(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32);
        if n > 0 {
            buf.truncate(n as usize);
            return Some(String::from_utf8_lossy(&buf).into_owned());
        }
    }
    let _ = pid;
    None
}

/// Outermost `*.app` directory in a path: `/Applications/Google Chrome.app/…/Helper.app/…` → Chrome.app.
pub fn outermost_app(path: &Path) -> Option<PathBuf> {
    let mut acc = PathBuf::new();
    for comp in path.components() {
        acc.push(comp);
        if acc.extension().is_some_and(|e| e == "app") {
            return Some(acc);
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppIdentity {
    pub owner_pid: i32,
    pub app_id: String,
    pub bundle_id: Option<String>,
    pub name: String,
    pub bundle_path: Option<String>,
}

pub fn bundle_info(app: &Path) -> (Option<String>, Option<String>) {
    let plist_path = app.join("Contents/Info.plist");
    let Ok(value) = plist::Value::from_file(&plist_path) else { return (None, None) };
    let dict = value.as_dictionary();
    let get = |k: &str| dict.and_then(|d| d.get(k)).and_then(|v| v.as_string()).map(str::to_string);
    let id = get("CFBundleIdentifier");
    let name = get("CFBundleDisplayName").or_else(|| get("CFBundleName"));
    (id, name)
}

/// Resolves which app a process belongs to (three-step fallback).
pub fn identify(pid: i32) -> AppIdentity {
    // 1. Responsible process, when it lives in an app bundle.
    let owner = responsible_pid(pid);
    let mut candidates = vec![owner];
    // 2. Parent chain (Chrome/Electron helpers).
    let mut cur = pid;
    for _ in 0..8 {
        match parent_pid(cur) {
            Some(p) => {
                candidates.push(p);
                cur = p;
            }
            None => break,
        }
    }
    candidates.push(pid);
    for cand in candidates {
        if let Some(app) = exe_path(cand).as_deref().and_then(outermost_app) {
            if app.starts_with("/System/Library") && cand != pid {
                continue;
            }
            let (bundle_id, name) = bundle_info(&app);
            let name = name.unwrap_or_else(|| app.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
            return AppIdentity {
                owner_pid: cand,
                app_id: bundle_id.clone().unwrap_or_else(|| app.to_string_lossy().into_owned()),
                bundle_id,
                name,
                bundle_path: Some(app.to_string_lossy().into_owned()),
            };
        }
    }
    // 3. Not in any app bundle (command-line tools such as afplay): the process itself.
    let name = process_name(pid).unwrap_or_else(|| format!("pid {pid}"));
    AppIdentity { owner_pid: pid, app_id: format!("pid:{pid}"), bundle_id: None, name, bundle_path: None }
}

pub fn is_ignored(name: &str) -> bool {
    IGNORED_PROCESS_NAMES.iter().any(|n| n.eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_outermost_app() {
        let p = Path::new("/Applications/Google Chrome.app/Contents/Frameworks/X.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/x");
        assert_eq!(outermost_app(p).unwrap(), Path::new("/Applications/Google Chrome.app"));
        assert!(outermost_app(Path::new("/usr/bin/afplay")).is_none());
    }

    #[test]
    fn identifies_own_process() {
        let me = identify(std::process::id() as i32);
        assert!(!me.name.is_empty());
        assert!(parent_pid(std::process::id() as i32).is_some());
    }

    #[test]
    fn ignores_daemons() {
        assert!(is_ignored("coreaudiod"));
        assert!(!is_ignored("Safari"));
    }
}
