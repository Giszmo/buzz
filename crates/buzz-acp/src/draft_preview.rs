//! Channel-visible previews of the reply an agent is writing (kind 24201).
//!
//! The observer bus already carries every `agent_message_chunk` and
//! `agent_thought_chunk` the ACP agent emits, but the relay frames built from
//! it are NIP-44 encrypted to the agent's owner — nobody else in the channel
//! can read them. This module is the second consumer of that same bus: it
//! accumulates the text per turn and republishes it as a plaintext ephemeral
//! event `h`-tagged to the channel, so every member watches the reply form.
//!
//! Two properties keep that affordable and honest:
//!
//! - **Cumulative, not delta.** Ephemeral frames are droppable, so each frame
//!   repeats the text so far (clamped to its tail) and carries a `seq`. A
//!   reader that missed a frame is correct again on the next one.
//! - **Opt-in once, at the harness.** Nothing is published unless the
//!   operator turns it on. Beyond that, which parts a reader sees — reply,
//!   reasoning, neither — is a client-side choice, so both parts go on the
//!   wire and the client decides what to render.

use std::collections::VecDeque;

use buzz_core::draft_preview::{clamp_draft_text, DRAFT_MAX_TEXT_BYTES};
use buzz_sdk::{AgentDraftPart, AgentDraftPreview};
use uuid::Uuid;

use crate::observer;
use crate::relay::RelayEventPublisher;

/// How often the accumulated text is republished. Matches the observer
/// publisher's pacing: the bus itself delivers far finer-grained chunks, and
/// one relay frame per second per part reads as smooth writing without
/// turning every token into an event.
const DRAFT_PUBLISH_TICK: std::time::Duration = std::time::Duration::from_secs(1);

/// Frames published per tick, across all turns.
///
/// A pool runs several turns at once, each with a reply and a reasoning part,
/// so an unbounded tick could emit a dozen events per second and trip the
/// relay's admission budget — which would cost the typing indicators and
/// observer frames sharing that socket. Turns are served round-robin, so a
/// busy pool slows every preview down evenly instead of starving the turns at
/// the back.
const DRAFT_MAX_FRAMES_PER_TICK: usize = 4;

/// Turns tracked at once. Beyond this the oldest is dropped: its preview stops
/// updating, which is a cosmetic loss, while the memory it holds is not.
const DRAFT_MAX_ACTIVE_TURNS: usize = 16;

/// One publishable revision of one part of one turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DraftFrame {
    pub channel_id: Uuid,
    pub turn_id: String,
    pub part: AgentDraftPart,
    pub seq: u64,
    pub text: String,
    pub triggering_event_id: Option<String>,
    pub writing: bool,
}

#[derive(Debug, Default)]
struct DraftPart {
    text: String,
    seq: u64,
    dirty: bool,
}

impl DraftPart {
    fn append(&mut self, chunk: &str) {
        self.text.push_str(chunk);
        // Only the tail is ever published, so keeping more than twice the cap
        // buys nothing and lets a long turn grow this buffer without bound.
        if self.text.len() > DRAFT_MAX_TEXT_BYTES * 2 {
            let (tail, _) = clamp_draft_text(&self.text);
            self.text = tail.to_string();
        }
        self.dirty = true;
    }

    /// Take the next revision, if this part has text nobody has seen yet.
    fn take_revision(&mut self) -> Option<(u64, String)> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        self.seq += 1;
        Some((self.seq, self.text.clone()))
    }

    /// The closing revision for a finished turn. Always produced, even when
    /// nothing changed since the last tick: it is what tells readers to clear
    /// the preview rather than wait out its liveness TTL.
    fn take_final(&mut self) -> (u64, String) {
        self.dirty = false;
        self.seq += 1;
        (self.seq, self.text.clone())
    }

    fn has_text(&self) -> bool {
        !self.text.trim().is_empty()
    }
}

#[derive(Debug)]
struct DraftTurn {
    channel_id: Uuid,
    turn_id: String,
    triggering_event_id: Option<String>,
    reply: DraftPart,
    thought: DraftPart,
    /// Set by `turn_completed`; the turn emits its closing frames on the next
    /// tick and is then forgotten.
    finished: bool,
}

impl DraftTurn {
    fn part_mut(&mut self, part: AgentDraftPart) -> &mut DraftPart {
        match part {
            AgentDraftPart::Reply => &mut self.reply,
            AgentDraftPart::Thought => &mut self.thought,
        }
    }

    fn frame(&self, part: AgentDraftPart, seq: u64, text: String, writing: bool) -> DraftFrame {
        DraftFrame {
            channel_id: self.channel_id,
            turn_id: self.turn_id.clone(),
            part,
            seq,
            text,
            triggering_event_id: self.triggering_event_id.clone(),
            writing,
        }
    }
}

/// Accumulates observer chunks into per-turn previews and hands out the frames
/// to publish. Pure state: the publishing loop owns the clock and the socket.
#[derive(Debug, Default)]
pub(crate) struct DraftPreviewState {
    turns: VecDeque<DraftTurn>,
}

impl DraftPreviewState {
    fn turn_index(&self, channel_id: Uuid, turn_id: &str) -> Option<usize> {
        self.turns
            .iter()
            .position(|turn| turn.channel_id == channel_id && turn.turn_id == turn_id)
    }

    fn ensure_turn(&mut self, channel_id: Uuid, turn_id: &str) -> usize {
        if let Some(index) = self.turn_index(channel_id, turn_id) {
            return index;
        }
        if self.turns.len() >= DRAFT_MAX_ACTIVE_TURNS {
            if let Some(dropped) = self.turns.pop_front() {
                tracing::warn!(
                    channel_id = %dropped.channel_id,
                    turn_id = %dropped.turn_id,
                    "draft preview turn evicted: too many concurrent turns"
                );
            }
        }
        self.turns.push_back(DraftTurn {
            channel_id,
            turn_id: turn_id.to_string(),
            triggering_event_id: None,
            reply: DraftPart::default(),
            thought: DraftPart::default(),
            finished: false,
        });
        self.turns.len() - 1
    }

    /// Fold one observer event into the per-turn state.
    pub(crate) fn ingest(&mut self, event: &observer::ObserverEvent) {
        let (Some(channel_id), Some(turn_id)) = (
            event
                .channel_id
                .as_deref()
                .and_then(|id| Uuid::parse_str(id).ok()),
            event.turn_id.as_deref(),
        ) else {
            // Heartbeats and pre-session frames have no channel to show a
            // preview in.
            return;
        };

        match event.kind.as_str() {
            "turn_started" => {
                let trigger = event
                    .payload
                    .get("triggeringEventIds")
                    .and_then(|ids| ids.as_array())
                    .and_then(|ids| ids.first())
                    .and_then(|id| id.as_str())
                    .map(ToOwned::to_owned);
                let index = self.ensure_turn(channel_id, turn_id);
                if let Some(turn) = self.turns.get_mut(index) {
                    turn.triggering_event_id = trigger;
                }
            }
            "turn_completed" => {
                if let Some(index) = self.turn_index(channel_id, turn_id) {
                    if let Some(turn) = self.turns.get_mut(index) {
                        turn.finished = true;
                    }
                }
            }
            _ => {
                let Some((key, text)) = crate::observer_chunk_key_and_text(event) else {
                    return;
                };
                let part = match key.update_type.as_str() {
                    "agent_message_chunk" => AgentDraftPart::Reply,
                    "agent_thought_chunk" => AgentDraftPart::Thought,
                    // user_message_chunk is the prompt echoed back, not the
                    // agent writing.
                    _ => return,
                };
                let index = self.ensure_turn(channel_id, turn_id);
                if let Some(turn) = self.turns.get_mut(index) {
                    turn.part_mut(part).append(&text);
                }
            }
        }
    }

    /// Frames to publish this tick, at most [`DRAFT_MAX_FRAMES_PER_TICK`].
    ///
    /// Turns are served in order and then rotated, so a turn that could not
    /// fit in this tick's budget leads the next one.
    pub(crate) fn next_frames(&mut self) -> Vec<DraftFrame> {
        let mut frames = Vec::new();
        let mut rotations = 0;
        let turn_count = self.turns.len();

        while rotations < turn_count && frames.len() < DRAFT_MAX_FRAMES_PER_TICK {
            let Some(mut turn) = self.turns.pop_front() else {
                break;
            };
            rotations += 1;

            // Set when the budget ran out before a part that still owes a
            // frame. A finished turn is forgotten only once every part it owes
            // has been emitted, so a closing frame can never be lost to the
            // budget.
            let mut deferred = false;
            for part in [AgentDraftPart::Reply, AgentDraftPart::Thought] {
                // A part that never produced text has no preview on screen to
                // update or clear, so it stays silent.
                let owes_frame = if turn.finished {
                    turn.part_mut(part).has_text()
                } else {
                    turn.part_mut(part).dirty
                };
                if !owes_frame {
                    continue;
                }
                if frames.len() >= DRAFT_MAX_FRAMES_PER_TICK {
                    deferred = true;
                    continue;
                }
                if turn.finished {
                    let (seq, text) = turn.part_mut(part).take_final();
                    frames.push(turn.frame(part, seq, text, false));
                } else if let Some((seq, text)) = turn.part_mut(part).take_revision() {
                    frames.push(turn.frame(part, seq, text, true));
                }
            }

            if !turn.finished || deferred {
                self.turns.push_back(turn);
            }
        }

        frames
    }

    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.turns.is_empty()
    }
}

/// Subscribe to the observer bus and publish channel-visible previews.
pub(crate) fn spawn_draft_preview_publisher(
    observer: observer::ObserverHandle,
    publisher: RelayEventPublisher,
    keys: nostr::Keys,
) -> tokio::task::JoinHandle<()> {
    // Subscribe before spawning: a chunk emitted between this call and the
    // task's first poll would otherwise be lost, and there is no replay
    // snapshot behind it to recover from.
    let rx = observer.subscribe();
    tokio::spawn(async move { run_draft_preview_publisher(rx, publisher, keys).await })
}

async fn run_draft_preview_publisher(
    mut rx: tokio::sync::broadcast::Receiver<observer::ObserverEvent>,
    publisher: RelayEventPublisher,
    keys: nostr::Keys,
) {
    let mut state = DraftPreviewState::default();
    // Unlike the observer publisher there is no replay snapshot to drain: a
    // preview of a turn that already ended is noise, not telemetry.
    let mut publish_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + DRAFT_PUBLISH_TICK,
        DRAFT_PUBLISH_TICK,
    );
    publish_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut closed = false;

    loop {
        tokio::select! {
            result = rx.recv(), if !closed => {
                match result {
                    Ok(event) => state.ingest(&event),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                        // Cumulative text means a gap self-heals on the next
                        // frame; nothing to recover here.
                        tracing::warn!(dropped = count, "draft preview publisher lagged");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        closed = true;
                    }
                }
            }
            _ = publish_tick.tick() => {
                let frames = state.next_frames();
                let drained = frames.is_empty();
                for frame in frames {
                    publish_draft_frame(&publisher, &keys, frame).await;
                }
                if closed && drained {
                    break;
                }
            }
        }
    }
}

async fn publish_draft_frame(
    publisher: &RelayEventPublisher,
    keys: &nostr::Keys,
    frame: DraftFrame,
) {
    let builder = match buzz_sdk::build_agent_draft_preview(&AgentDraftPreview {
        channel_id: frame.channel_id,
        turn_id: &frame.turn_id,
        part: frame.part,
        seq: frame.seq,
        text: &frame.text,
        triggering_event_id: frame.triggering_event_id.as_deref(),
        writing: frame.writing,
    }) {
        Ok(builder) => builder,
        Err(error) => {
            tracing::warn!("failed to build draft preview frame: {error}");
            return;
        }
    };
    let signed = match builder.sign_with_keys(keys) {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!("failed to sign draft preview frame: {error}");
            return;
        }
    };
    if let Err(error) = publisher.publish_event(signed).await {
        tracing::warn!("draft preview frame dropped: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHANNEL: &str = "11111111-2222-3333-4444-555555555555";

    fn event(kind: &str, turn: &str, payload: serde_json::Value) -> observer::ObserverEvent {
        observer::ObserverEvent {
            seq: 1,
            timestamp: "2026-09-21T00:00:00Z".to_string(),
            kind: kind.to_string(),
            agent_index: Some(0),
            channel_id: Some(CHANNEL.to_string()),
            session_id: Some("session-1".to_string()),
            turn_id: Some(turn.to_string()),
            started_at: None,
            payload,
        }
    }

    fn chunk(turn: &str, update_type: &str, text: &str) -> observer::ObserverEvent {
        event(
            "acp_read",
            turn,
            serde_json::json!({
                "params": {
                    "update": {
                        "sessionUpdate": update_type,
                        "content": { "type": "text", "text": text },
                    }
                }
            }),
        )
    }

    fn turn_started(turn: &str, trigger: &str) -> observer::ObserverEvent {
        event(
            "turn_started",
            turn,
            serde_json::json!({ "source": "channel", "triggeringEventIds": [trigger] }),
        )
    }

    #[test]
    fn accumulates_reply_chunks_into_one_cumulative_frame() {
        let mut state = DraftPreviewState::default();
        state.ingest(&chunk("turn-1", "agent_message_chunk", "Hello"));
        state.ingest(&chunk("turn-1", "agent_message_chunk", ", world"));

        let frames = state.next_frames();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].text, "Hello, world");
        assert_eq!(frames[0].seq, 1);
        assert_eq!(frames[0].part, AgentDraftPart::Reply);
        assert!(frames[0].writing);
    }

    #[test]
    fn seq_advances_and_idle_ticks_publish_nothing() {
        let mut state = DraftPreviewState::default();
        state.ingest(&chunk("turn-1", "agent_message_chunk", "one"));
        assert_eq!(state.next_frames()[0].seq, 1);

        assert!(state.next_frames().is_empty(), "no new text, no frame");

        state.ingest(&chunk("turn-1", "agent_message_chunk", " two"));
        let frames = state.next_frames();
        assert_eq!(frames[0].seq, 2);
        assert_eq!(frames[0].text, "one two");
    }

    #[test]
    fn reasoning_rides_its_own_part_so_a_reader_can_hide_it() {
        let mut state = DraftPreviewState::default();
        state.ingest(&chunk("turn-1", "agent_thought_chunk", "thinking"));
        state.ingest(&chunk("turn-1", "agent_message_chunk", "writing"));

        let frames = state.next_frames();
        assert_eq!(frames.len(), 2);
        let reply = frames
            .iter()
            .find(|frame| frame.part == AgentDraftPart::Reply)
            .expect("reply frame");
        let thought = frames
            .iter()
            .find(|frame| frame.part == AgentDraftPart::Thought)
            .expect("thought frame");
        assert_eq!(reply.text, "writing");
        assert_eq!(thought.text, "thinking");
    }

    #[test]
    fn user_message_chunks_are_not_the_agent_writing() {
        let mut state = DraftPreviewState::default();
        state.ingest(&chunk("turn-1", "user_message_chunk", "the prompt"));
        assert!(state.next_frames().is_empty());
    }

    #[test]
    fn turn_started_supplies_the_triggering_event() {
        let trigger = "a".repeat(64);
        let mut state = DraftPreviewState::default();
        state.ingest(&turn_started("turn-1", &trigger));
        state.ingest(&chunk("turn-1", "agent_message_chunk", "hi"));

        let frames = state.next_frames();
        assert_eq!(frames[0].triggering_event_id.as_deref(), Some(&trigger[..]));
    }

    #[test]
    fn completion_emits_a_closing_frame_and_forgets_the_turn() {
        let mut state = DraftPreviewState::default();
        state.ingest(&chunk("turn-1", "agent_message_chunk", "done soon"));
        assert_eq!(state.next_frames().len(), 1);

        state.ingest(&event("turn_completed", "turn-1", serde_json::json!({})));
        let frames = state.next_frames();
        assert_eq!(frames.len(), 1);
        assert!(!frames[0].writing, "final frame clears the preview");
        assert_eq!(frames[0].seq, 2);
        assert!(state.is_empty());
        assert!(state.next_frames().is_empty());
    }

    #[test]
    fn a_turn_that_never_wrote_emits_nothing_at_all() {
        let mut state = DraftPreviewState::default();
        state.ingest(&turn_started("turn-1", &"b".repeat(64)));
        state.ingest(&event("turn_completed", "turn-1", serde_json::json!({})));
        assert!(state.next_frames().is_empty());
        assert!(state.is_empty());
    }

    #[test]
    fn events_without_a_channel_are_ignored() {
        let mut state = DraftPreviewState::default();
        let mut heartbeat = chunk("turn-1", "agent_message_chunk", "tick");
        heartbeat.channel_id = None;
        state.ingest(&heartbeat);
        assert!(state.next_frames().is_empty());
    }

    #[test]
    fn concurrent_turns_are_served_round_robin_within_the_budget() {
        let mut state = DraftPreviewState::default();
        // Six dirty parts across three turns; the budget is four frames.
        for turn in ["turn-1", "turn-2", "turn-3"] {
            state.ingest(&chunk(turn, "agent_message_chunk", "reply"));
            state.ingest(&chunk(turn, "agent_thought_chunk", "thought"));
        }

        let first = state.next_frames();
        assert_eq!(first.len(), DRAFT_MAX_FRAMES_PER_TICK);
        let second = state.next_frames();
        assert_eq!(second.len(), 2, "the starved turn leads the next tick");

        let mut served: Vec<&str> = first
            .iter()
            .chain(second.iter())
            .map(|frame| frame.turn_id.as_str())
            .collect();
        served.sort_unstable();
        served.dedup();
        assert_eq!(served, vec!["turn-1", "turn-2", "turn-3"]);
    }

    #[test]
    fn long_replies_publish_their_tail() {
        let mut state = DraftPreviewState::default();
        state.ingest(&chunk(
            "turn-1",
            "agent_message_chunk",
            &"x".repeat(DRAFT_MAX_TEXT_BYTES * 3),
        ));
        state.ingest(&chunk("turn-1", "agent_message_chunk", "END"));

        let frames = state.next_frames();
        assert!(frames[0].text.ends_with("END"));
        assert!(frames[0].text.len() <= DRAFT_MAX_TEXT_BYTES * 2);
    }

    #[tokio::test(start_paused = true)]
    async fn publisher_emits_signed_channel_scoped_frames() {
        use buzz_core::draft_preview::{
            DRAFT_PART_TAG, DRAFT_SEQ_TAG, DRAFT_STATUS_DONE, DRAFT_STATUS_TAG,
            DRAFT_STATUS_WRITING, DRAFT_TURN_TAG,
        };

        let handle = observer::ObserverHandle::in_process();
        let (publisher, mut published) = RelayEventPublisher::test_pair();
        let keys = nostr::Keys::generate();
        let task =
            spawn_draft_preview_publisher(handle.clone(), publisher, keys.clone());

        let context = observer::ObserverContext {
            channel_id: Some(CHANNEL.to_string()),
            session_id: Some("session-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            started_at: None,
        };
        handle.emit(
            "acp_read",
            Some(0),
            &context,
            serde_json::json!({
                "params": {
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": "forming" },
                    }
                }
            }),
        );

        let event = tokio::time::timeout(std::time::Duration::from_secs(5), published.recv())
            .await
            .expect("a frame within the pacing window")
            .expect("publisher channel open");

        assert_eq!(
            event.kind.as_u16(),
            buzz_core::kind::KIND_AGENT_DRAFT_PREVIEW as u16
        );
        assert_eq!(event.pubkey, keys.public_key());
        assert_eq!(event.content, "forming");
        assert!(tag_value(&event, "h").as_deref() == Some(CHANNEL));
        assert_eq!(tag_value(&event, DRAFT_TURN_TAG).as_deref(), Some("turn-1"));
        assert_eq!(tag_value(&event, DRAFT_PART_TAG).as_deref(), Some("reply"));
        assert_eq!(tag_value(&event, DRAFT_SEQ_TAG).as_deref(), Some("1"));
        assert_eq!(
            tag_value(&event, DRAFT_STATUS_TAG).as_deref(),
            Some(DRAFT_STATUS_WRITING)
        );
        // Nothing is encrypted: a channel member reads the text directly.
        assert!(buzz_core::verify_event(&event).is_ok());

        handle.emit("turn_completed", Some(0), &context, serde_json::json!({}));
        let closing = tokio::time::timeout(std::time::Duration::from_secs(5), published.recv())
            .await
            .expect("a closing frame")
            .expect("publisher channel open");
        assert_eq!(
            tag_value(&closing, DRAFT_STATUS_TAG).as_deref(),
            Some(DRAFT_STATUS_DONE)
        );

        task.abort();
    }

    fn tag_value(event: &nostr::Event, key: &str) -> Option<String> {
        event.tags.iter().find_map(|t| {
            let slice = t.as_slice();
            if slice.first().map(|v| v.as_str()) == Some(key) {
                slice.get(1).map(|v| v.to_string())
            } else {
                None
            }
        })
    }

    #[test]
    fn active_turns_are_bounded() {
        let mut state = DraftPreviewState::default();
        for index in 0..(DRAFT_MAX_ACTIVE_TURNS + 4) {
            state.ingest(&chunk(&format!("turn-{index}"), "agent_message_chunk", "x"));
        }
        assert_eq!(state.turns.len(), DRAFT_MAX_ACTIVE_TURNS);
        assert_eq!(
            state.turns.front().map(|turn| turn.turn_id.as_str()),
            Some("turn-4")
        );
    }
}
