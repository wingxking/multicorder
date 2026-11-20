//! macOS helpers for the UI: app icons as PNG, and the Chrome shortcut that starts tab capture.
//!
//! Chrome only lets an extension capture a tab after the user invokes it on that tab (toolbar
//! icon, context menu or its keyboard command). When the user presses Record in this app, we bring
//! the tab forward and send the extension's own command (⌥⇧R) to the browser, which counts as that
//! invocation. Sending keys needs the macOS Accessibility permission; without it the user clicks
//! the Multicorder icon in Chrome instead.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Gesture {
    /// The shortcut was sent to the browser.
    Sent,
    /// macOS has not allowed this app to send keys; the system prompt was shown.
    NeedsPermission,
    /// The browser did not come to the front in time.
    NotFocused,
}

#[cfg(target_os = "macos")]
pub fn send_record_shortcut(bundle_id: Option<&str>) -> Gesture {
    use cidre::{cg, ns};

    if !cg::event::access::post_preflight() {
        cg::event::access::post_request();
        return Gesture::NeedsPermission;
    }
    let bundle = ns::String::with_str(bundle_id.unwrap_or("com.google.chrome"));
    let deadline = Instant::now() + Duration::from_millis(2500);
    // The extension activates the tab and focuses its window; wait until the browser is in front
    // so the key reaches the browser window, not whatever app was active before.
    let active = loop {
        let apps = ns::RunningApp::with_bundle_id(&bundle);
        if (0..apps.len()).any(|i| apps.get(i).map(|app| app.is_active()).unwrap_or(false)) {
            break true;
        }
        if Instant::now() > deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(80));
    };
    if !active {
        return Gesture::NotFocused;
    }
    // Give Chrome a moment to make the window key after activation.
    std::thread::sleep(Duration::from_millis(150));
    const KEY_R: cg::KeyCode = 15;
    let flags = cg::EventFlags::ALT | cg::EventFlags::SHIFT;
    let source = cg::EventSrc::with_state(cg::EventSrcState::Private);
    for down in [true, false] {
        if let Some(mut event) = cg::Event::keyboard(source.as_deref(), KEY_R, down) {
            event.set_flags(flags);
            event.post(cg::EventTapLocation::Hid);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Gesture::Sent
}

#[cfg(not(target_os = "macos"))]
pub fn send_record_shortcut(_bundle_id: Option<&str>) -> Gesture {
    Gesture::NeedsPermission
}

/// A 64-point PNG of the app's Finder icon, cached in `cache_dir`.
pub fn app_icon_png(bundle_path: &str, cache_dir: &Path) -> anyhow::Result<Vec<u8>> {
    let bundle = Path::new(bundle_path);
    anyhow::ensure!(bundle.is_absolute() && bundle.extension().is_some_and(|ext| ext == "app") && bundle.is_dir(), "not an app bundle");
    let name: String = bundle_path.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    let cached: PathBuf = cache_dir.join(format!("{}.png", &name[name.len().saturating_sub(120)..]));
    if let Ok(bytes) = std::fs::read(&cached) {
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }
    std::fs::create_dir_all(cache_dir)?;
    // NSWorkspace knows every icon (icns or asset catalog); JXA reaches it without extra bindings.
    let script = r#"
ObjC.import('AppKit');
function run(argv) {
  const image = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  image.size = $.NSMakeSize(64, 64);
  const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  png.writeToFileAtomically(argv[1], true);
}"#;
    let status = std::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", script, bundle_path])
        .arg(&cached)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    anyhow::ensure!(status.success(), "could not read the app icon");
    // AppKit writes the largest representation (often 1024 px); keep the cached copy small.
    let _ = std::process::Command::new("/usr/bin/sips")
        .args(["-Z", "64"])
        .arg(&cached)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    Ok(std::fs::read(&cached)?)
}
