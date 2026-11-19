use std::path::Path;

use mc_engine::Engine;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextPart {
    Transcript,
    Summary,
}

impl TextPart {
    pub fn label(self) -> &'static str {
        match self {
            Self::Transcript => "Transcript",
            Self::Summary => "AI Summary",
        }
    }

    pub fn suffix(self) -> &'static str {
        match self {
            Self::Transcript => "transcript",
            Self::Summary => "summary",
        }
    }
}

#[derive(Serialize)]
pub struct RecordingPreview {
    pub transcript: Option<String>,
    pub summary: Option<String>,
}

fn summary_text(engine: &Engine, id: &str) -> anyhow::Result<Option<String>> {
    Ok(engine.store.report(id)?.filter(|report| report.model.is_some()).map(|report| {
        report.body.lines()
            .skip_while(|line| line.starts_with("# ") || line.trim().is_empty())
            .map(|line| line.trim_start_matches('#').trim().replace('`', ""))
            .collect::<Vec<_>>().join("\n").trim().to_owned()
    }).filter(|text| !text.is_empty()))
}

fn excerpt(text: &str) -> String {
    let mut chars = text.chars();
    let mut preview = chars.by_ref().take(240).collect::<String>();
    if chars.next().is_some() {
        preview.push('…');
    }
    preview
}

pub fn preview(engine: &Engine, id: &str) -> anyhow::Result<RecordingPreview> {
    let transcript = engine.transcript(id)?.into_iter()
        .map(|line| line.text).take(4).collect::<Vec<_>>().join(" ");
    Ok(RecordingPreview {
        transcript: (!transcript.is_empty()).then(|| excerpt(&transcript)),
        summary: summary_text(engine, id)?.map(|text| excerpt(&text)),
    })
}

pub fn text(engine: &Engine, id: &str, part: TextPart) -> anyhow::Result<String> {
    match part {
        TextPart::Transcript => {
            let events = engine.transcript(id)?;
            anyhow::ensure!(!events.is_empty(), "There is no transcript yet");
            Ok(events.iter().map(|event| {
                let seconds = event.start_ms / 1000;
                format!("[{:02}:{:02}] {}", seconds / 60, seconds % 60, event.text)
            }).collect::<Vec<_>>().join("\n"))
        }
        TextPart::Summary => summary_text(engine, id)?.ok_or_else(|| anyhow::anyhow!("There is no AI summary yet")),
    }
}

#[cfg(target_os = "macos")]
pub fn copy(text: &str) -> anyhow::Result<()> {
    use cidre::ns;
    let mut pasteboard = ns::Pasteboard::general();
    pasteboard.clear_contents();
    let string = ns::String::with_str(text);
    anyhow::ensure!(pasteboard.set_string_for_type(&string, ns::pasteboard_types::string()), "Could not copy text");
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn write_pdf(path: &Path, heading: &str, text: &str) -> anyhow::Result<()> {
    use cidre::{arc, cf, cg, ct};

    // The safe Core Text bindings provide line layout. These framework calls write the pages and
    // return how much UTF-16 text fit, so wrapped paragraphs continue exactly on the next page.
    unsafe extern "C-unwind" {
        fn CGPDFContextCreateWithURL(url: &cf::Url, media_box: &cg::Rect, info: Option<&cf::Dictionary>) -> Option<arc::R<cg::Context>>;
        fn CGPDFContextBeginPage(ctx: &mut cg::Context, info: Option<&cf::Dictionary>);
        fn CGPDFContextEndPage(ctx: &mut cg::Context);
        fn CGPDFContextClose(ctx: &mut cg::Context);
        fn CTFrameGetVisibleStringRange(frame: &ct::Frame) -> cf::Range;
        fn CTFrameDraw(frame: &ct::Frame, ctx: &mut cg::Context);
    }

    let page = cg::Rect::new(0.0, 0.0, 595.0, 842.0); // A4
    let box_path = cg::Path::with_rect(cg::Rect::new(50.0, 50.0, 495.0, 742.0), None);
    let url = cf::Url::with_file_path(path).ok_or_else(|| anyhow::anyhow!("Invalid export path"))?;
    let content = cf::String::from_str(&format!("{heading}\n\n{text}"));
    let font = ct::Font::with_name_size(&cf::String::from_str("Helvetica"), 12.0);
    let attrs = cf::Dictionary::with_keys_values(&[ct::StringAttrName::font().as_type_ref()], &[font.as_type_ref()])
        .ok_or_else(|| anyhow::anyhow!("Could not prepare the PDF text"))?;
    let attributed = cf::AttrString::with_attrs(&content, &attrs);
    let layout = ct::Framesetter::with_attr_string(&attributed);
    let mut context = unsafe { CGPDFContextCreateWithURL(&url, &page, None) }.ok_or_else(|| anyhow::anyhow!("Could not create the PDF"))?;
    let mut offset = 0;
    while offset < attributed.len() {
        let frame = layout.create_frame(cf::Range::new(offset as isize, 0), &box_path, None);
        let visible = unsafe { CTFrameGetVisibleStringRange(&frame) };
        anyhow::ensure!(visible.len > 0, "Could not fit the export on a PDF page");
        unsafe {
            CGPDFContextBeginPage(&mut context, None);
            CTFrameDraw(&frame, &mut context);
            CGPDFContextEndPage(&mut context);
        }
        offset += visible.len as usize;
    }
    unsafe { CGPDFContextClose(&mut context) };
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn copy(_text: &str) -> anyhow::Result<()> {
    anyhow::bail!("The native clipboard requires macOS")
}

#[cfg(not(target_os = "macos"))]
pub fn write_pdf(_path: &Path, _heading: &str, _text: &str) -> anyhow::Result<()> {
    anyhow::bail!("PDF export requires macOS")
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn pdf_exports_unicode_and_multiple_pages() {
        let temp = std::env::temp_dir().join(format!("multicorder-pdf-{}.pdf", mc_core::new_id()));
        let fixture = std::env::var_os("MULTICORDER_PDF_FIXTURE").map(std::path::PathBuf::from);
        let path = fixture.as_deref().unwrap_or(&temp);
        let text = "会议记录和摘要。 这是双语录音的转写稿。\n[00:00] The recording is saved on this Mac.\n\n".repeat(80);
        write_pdf(path, "Multicorder - Transcript", &text).unwrap();
        let bytes = std::fs::read(path).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        assert!(bytes.windows(b"/Type /Page".len()).filter(|w| *w == b"/Type /Page").count() > 2);
        if fixture.is_none() {
            std::fs::remove_file(path).unwrap();
        }
    }
}
