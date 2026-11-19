//! Number check (ported in spirit from Catchup's `validators/numbers.py`): every number written in an
//! insight must appear in its evidence. Small integers (0–10) are allowed freely because they are
//! often counts or list positions produced by the writer.

/// Extracts digit groups, ignoring thousands separators: "1,200.5" → "1200.5".
pub fn extract(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let mut s = String::new();
            while i < chars.len() {
                let c = chars[i];
                if c.is_ascii_digit() {
                    s.push(c);
                } else if (c == ',' || c == '.') && i + 1 < chars.len() && chars[i + 1].is_ascii_digit() {
                    if c == '.' {
                        s.push('.');
                    }
                } else {
                    break;
                }
                i += 1;
            }
            out.push(s);
        } else {
            i += 1;
        }
    }
    out
}

/// `Err(number)` for the first number in `text` that the evidence does not contain.
pub fn check(text: &str, evidence: &str) -> Result<(), String> {
    let have: Vec<String> = extract(evidence);
    for n in extract(text) {
        if let Ok(v) = n.parse::<f64>() {
            if v <= 10.0 && !n.contains('.') {
                continue;
            }
        }
        if !have.iter().any(|h| h == &n || h.trim_end_matches(".0") == n) {
            return Err(n);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_with_separators() {
        assert_eq!(extract("about 1,200.5 users and 42%"), vec!["1200.5", "42"]);
    }

    #[test]
    fn checks_against_evidence() {
        assert!(check("预算 42 million", "budget is 42 million dollars").is_ok());
        assert_eq!(check("budget 43 million", "budget is 42 million"), Err("43".into()));
        assert!(check("3 points", "nothing numeric").is_ok());
        assert!(check("revenue 2,500", "revenue was 2500 last year").is_ok());
    }
}
