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

/// File formats a transcript or summary can be saved as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextFormat {
    Pdf,
    Docx,
    Txt,
    Md,
}

impl TextFormat {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pdf" => Some(Self::Pdf),
            "docx" => Some(Self::Docx),
            "txt" => Some(Self::Txt),
            "md" => Some(Self::Md),
            _ => None,
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Txt => "txt",
            Self::Md => "md",
        }
    }

    pub fn filter_name(self) -> &'static str {
        match self {
            Self::Pdf => "PDF",
            Self::Docx => "Word",
            Self::Txt => "Text",
            Self::Md => "Markdown",
        }
    }
}

/// Writes `heading` and `text` to `path` in `format`.
pub fn write_text(path: &Path, format: TextFormat, heading: &str, text: &str) -> anyhow::Result<()> {
    match format {
        TextFormat::Pdf => write_pdf(path, heading, text),
        TextFormat::Docx => Ok(std::fs::write(path, docx(heading, text))?),
        TextFormat::Txt => Ok(std::fs::write(path, format!("{heading}\n\n{text}\n"))?),
        TextFormat::Md => Ok(std::fs::write(path, format!("# {heading}\n\n{}\n", text.lines().collect::<Vec<_>>().join("  \n")))?),
    }
}

/// A file name without characters macOS Finder or other systems reject.
pub fn file_name(stem: &str, extension: &str) -> String {
    let clean: String = stem.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '-' } else { c }).collect();
    let clean = clean.trim().trim_start_matches('.');
    format!("{}.{extension}", if clean.is_empty() { "Multicorder" } else { clean })
}

fn xml_escape(text: &str) -> String {
    text.chars().filter(|c| !c.is_control() || *c == '\t').fold(String::new(), |mut out, c| {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
        out
    })
}

/// A minimal Word document: the heading in bold, then one paragraph per line.
fn docx(heading: &str, text: &str) -> Vec<u8> {
    let run = |text: &str, props: &str| format!("<w:p><w:r>{props}<w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>", xml_escape(text));
    let mut body = run(heading, "<w:rPr><w:b/><w:sz w:val=\"32\"/></w:rPr>");
    for line in text.lines() {
        body.push_str(&run(line, ""));
    }
    let document = format!(concat!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
        r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{}"#,
        r#"<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>"#,
        r#"</w:body></w:document>"#), body);
    let content_types = concat!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
        r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">"#,
        r#"<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>"#,
        r#"<Default Extension="xml" ContentType="application/xml"/>"#,
        r#"<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>"#,
        r#"</Types>"#);
    let rels = concat!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
        r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>"#,
        r#"</Relationships>"#);
    stored_zip(&[("[Content_Types].xml", content_types.as_bytes()), ("_rels/.rels", rels.as_bytes()), ("word/document.xml", document.as_bytes())])
}

/// An uncompressed ZIP archive, which is all a .docx package needs.
fn stored_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    const DOS_DATE: u16 = (1 << 5) | 1; // 1980-01-01
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let crc = crc32fast::hash(data);
        let offset = out.len() as u32;
        let mut common = Vec::new();
        common.extend_from_slice(&20u16.to_le_bytes()); // version needed
        common.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
        common.extend_from_slice(&0u16.to_le_bytes()); // stored
        common.extend_from_slice(&0u16.to_le_bytes()); // time
        common.extend_from_slice(&DOS_DATE.to_le_bytes());
        common.extend_from_slice(&crc.to_le_bytes());
        common.extend_from_slice(&(data.len() as u32).to_le_bytes());
        common.extend_from_slice(&(data.len() as u32).to_le_bytes());
        common.extend_from_slice(&(name.len() as u16).to_le_bytes());
        common.extend_from_slice(&0u16.to_le_bytes()); // extra length
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&common);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&common);
        central.extend_from_slice(&[0; 6]); // comment length, disk, internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
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

#[cfg(test)]
mod format_tests {
    use super::*;

    #[test]
    fn docx_is_a_zip_with_escaped_text() {
        let bytes = docx("Talk <1>", "[00:00] A & B\n会议");
        assert!(bytes.starts_with(b"PK\x03\x04"));
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("Talk &lt;1&gt;") && text.contains("A &amp; B") && text.contains("会议"));
        assert!(bytes.ends_with(&[0, 0]) && bytes.windows(4).any(|w| w == b"PK\x05\x06"));
        if let Some(path) = std::env::var_os("MULTICORDER_DOCX_FIXTURE") {
            std::fs::write(path, &bytes).unwrap();
        }
    }

    #[test]
    fn file_names_drop_path_characters() {
        assert_eq!(file_name("a/b: c", "txt"), "a-b- c.txt");
        assert_eq!(file_name("  ", "docx"), "Multicorder.docx");
    }
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
