//! Channel-visible agent draft previews (kind 24201).
//!
//! A draft preview is the reply an agent is composing right now, published as
//! a plaintext ephemeral event `h`-tagged to the channel the reply will land
//! in. Every channel member sees it, which is the whole point: the owner-only
//! observer stream ([`crate::observer`]) cannot show a teammate what someone
//! else's agent is writing.
//!
//! Because the text is public and unfinished, publishing is opt-in at the
//! harness. Only the reply is ever carried here: an agent's reasoning is
//! working text that can quote a secret the finished reply would not, so it
//! stays on the owner-scoped encrypted observer path and has no `part` value
//! in this kind. Previews are ephemeral (never stored) and are superseded by
//! the finished `kind:9`.

/// Tag naming the turn a preview belongs to. Stable for one prompt turn, so a
/// reader can tell a new turn from a continuation of the current one.
pub const DRAFT_TURN_TAG: &str = "turn";
/// Tag naming which half of the turn a preview carries.
pub const DRAFT_PART_TAG: &str = "part";
/// Tag carrying a per-`(turn, part)` monotonic revision counter. Previews
/// carry the cumulative text, so a reader keeps the highest `seq` seen and
/// discards anything older — reordered or replayed frames cannot rewind the
/// text.
pub const DRAFT_SEQ_TAG: &str = "seq";
/// Tag carrying the preview's lifecycle state.
pub const DRAFT_STATUS_TAG: &str = "status";
/// Tag set to `"1"` when the text was trimmed to [`DRAFT_MAX_TEXT_BYTES`].
pub const DRAFT_TRUNCATED_TAG: &str = "truncated";

/// `part` value for the reply text the agent will publish. The only value
/// this kind defines — reasoning is deliberately not publishable here.
pub const DRAFT_PART_REPLY: &str = "reply";

/// `status` value while the turn is still running.
pub const DRAFT_STATUS_WRITING: &str = "writing";
/// `status` value for the final frame of a turn. Tells readers to clear the
/// preview immediately instead of waiting for its liveness TTL to lapse.
pub const DRAFT_STATUS_DONE: &str = "done";

/// Maximum preview text bytes carried by one frame.
///
/// Previews are cumulative — each frame repeats the text so far so a dropped
/// ephemeral frame cannot leave a reader with a hole. That makes the frame
/// grow with the reply, so the text is clamped to its most recent
/// [`DRAFT_MAX_TEXT_BYTES`]: enough that a reader watches real sentences form,
/// small enough that a long turn cannot push multi-kilobyte frames at the
/// relay once a second. The finished `kind:9` carries the whole message.
pub const DRAFT_MAX_TEXT_BYTES: usize = 4_096;

/// Clamp `text` to its trailing [`DRAFT_MAX_TEXT_BYTES`] on a char boundary.
///
/// Returns the slice to publish and whether anything was dropped. The tail is
/// kept, not the head: a reader watching a reply form cares about the words
/// appearing now.
pub fn clamp_draft_text(text: &str) -> (&str, bool) {
    if text.len() <= DRAFT_MAX_TEXT_BYTES {
        return (text, false);
    }
    let mut start = text.len() - DRAFT_MAX_TEXT_BYTES;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    (&text[start..], true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_untouched() {
        let (text, truncated) = clamp_draft_text("hello");
        assert_eq!(text, "hello");
        assert!(!truncated);
    }

    #[test]
    fn exactly_at_cap_is_untouched() {
        let input = "a".repeat(DRAFT_MAX_TEXT_BYTES);
        let (text, truncated) = clamp_draft_text(&input);
        assert_eq!(text.len(), DRAFT_MAX_TEXT_BYTES);
        assert!(!truncated);
    }

    #[test]
    fn long_text_keeps_the_tail() {
        let input = format!("{}TAIL", "a".repeat(DRAFT_MAX_TEXT_BYTES));
        let (text, truncated) = clamp_draft_text(&input);
        assert!(truncated);
        assert!(text.len() <= DRAFT_MAX_TEXT_BYTES);
        assert!(text.ends_with("TAIL"));
    }

    #[test]
    fn multibyte_boundary_is_respected() {
        // Every char is 4 bytes, so the naive cut lands mid-char.
        let input = "😀".repeat(DRAFT_MAX_TEXT_BYTES); // 4x the cap in bytes
        let (text, truncated) = clamp_draft_text(&input);
        assert!(truncated);
        assert!(text.len() <= DRAFT_MAX_TEXT_BYTES);
        assert!(text.chars().all(|c| c == '😀'));
    }
}
