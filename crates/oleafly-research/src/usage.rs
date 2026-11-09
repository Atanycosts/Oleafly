//! Cumulative parent and helper usage within one task execution.
use std::collections::HashMap;

use oleafly_agent::{AgentEvent, InputTokenSemantics, Usage};

#[derive(Default)]
pub struct TaskUsageAggregator {
    parent_completed: Option<Usage>,
    parent_current: Option<Usage>,
    parent_turn_active: bool,
    helpers: HashMap<String, HelperUsage>,
}

#[derive(Default)]
struct HelperUsage {
    current: Option<Usage>,
    started: bool,
}

impl TaskUsageAggregator {
    pub fn register_helper(&mut self, actor: &str) -> Option<Usage> {
        self.helpers.entry(actor.to_owned()).or_default();
        self.total()
    }

    pub fn begin_parent_turn(&mut self) -> Option<Usage> {
        if self.parent_turn_active {
            let completed = self.parent_current.unwrap_or_default();
            self.parent_completed = Some(match self.parent_completed {
                Some(previous) => sum_usage(previous, completed),
                None => completed,
            });
        }
        self.parent_current = None;
        self.parent_turn_active = true;
        self.total()
    }

    pub fn observe_parent(&mut self, event: &AgentEvent) -> Option<Usage> {
        self.parent_turn_active = true;
        if let AgentEvent::Usage { usage, .. } = event {
            self.parent_current = Some(*usage);
        }
        self.total()
    }

    pub fn observe_helper(&mut self, actor: &str, event: &AgentEvent) -> Option<Usage> {
        if matches!(event, AgentEvent::StepStart { step: 0 }) {
            self.helpers.entry(actor.to_owned()).or_default().started = true;
            return self.total();
        }
        let AgentEvent::Usage { usage: current, .. } = event else {
            return self.total();
        };
        let helper = self.helpers.entry(actor.to_owned()).or_default();
        helper.started = true;
        helper.current = Some(*current);
        self.total()
    }

    pub fn total(&self) -> Option<Usage> {
        let mut components = Vec::with_capacity(2 + self.helpers.len());
        if let Some(completed) = self.parent_completed {
            components.push(Some(completed));
        }
        if self.parent_turn_active {
            components.push(self.parent_current);
        }
        components.extend(
            self.helpers
                .values()
                .filter_map(|helper| helper.started.then_some(helper.current)),
        );

        let mut components = components.into_iter();
        let first = components.next()?;
        Some(components.fold(first.unwrap_or_default(), |total, usage| {
            sum_usage(total, usage.unwrap_or_default())
        }))
    }

    pub fn counts(&self) -> Option<(Option<u64>, Option<u64>)> {
        self.total().map(|usage| {
            (
                usage.reported_input().map(u64::from),
                usage.reported_output().map(u64::from),
            )
        })
    }
}

fn sum_usage(previous: Usage, current: Usage) -> Usage {
    let sum = |a: Option<u32>, b: Option<u32>| a.zip(b).map(|(a, b)| a.saturating_add(b));
    Usage {
        input: previous.input.saturating_add(current.input),
        output: previous.output.saturating_add(current.output),
        input_known: Some(
            previous.reported_input().is_some() && current.reported_input().is_some(),
        ),
        output_known: Some(
            previous.reported_output().is_some() && current.reported_output().is_some(),
        ),
        cache_read: sum(previous.cache_read, current.cache_read),
        cache_write: sum(previous.cache_write, current.cache_write),
        reasoning: sum(previous.reasoning, current.reasoning),
        input_semantics: if previous.input_semantics == current.input_semantics {
            previous.input_semantics
        } else {
            InputTokenSemantics::Unknown
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage_event(input: Option<u32>, output: Option<u32>) -> AgentEvent {
        AgentEvent::usage(Usage {
            input: input.unwrap_or_default(),
            output: output.unwrap_or_default(),
            input_known: Some(input.is_some()),
            output_known: Some(output.is_some()),
            ..Default::default()
        })
    }

    fn counts(usage: Option<Usage>) -> (Option<u64>, Option<u64>) {
        usage
            .map(|usage| {
                (
                    usage.reported_input().map(u64::from),
                    usage.reported_output().map(u64::from),
                )
            })
            .unwrap_or((None, None))
    }

    #[test]
    fn helper_snapshots_aggregate_with_parent_cumulative_usage_once() {
        let mut aggregate = TaskUsageAggregator::default();
        assert_eq!(
            counts(aggregate.observe_parent(&usage_event(Some(100), Some(10)))),
            (Some(100), Some(10))
        );
        aggregate.register_helper("helper-a");
        assert_eq!(
            counts(aggregate.observe_helper("helper-a", &usage_event(Some(30), Some(3)))),
            (Some(130), Some(13))
        );
        assert_eq!(
            counts(aggregate.observe_parent(&usage_event(Some(140), Some(14)))),
            (Some(170), Some(17))
        );
        assert_eq!(
            counts(aggregate.observe_parent(&usage_event(Some(140), Some(14)))),
            (Some(170), Some(17)),
            "replaying a cumulative snapshot must not add it twice"
        );
        assert_eq!(
            counts(aggregate.observe_helper("helper-a", &usage_event(Some(30), Some(3)))),
            (Some(170), Some(17)),
            "replaying a helper snapshot must not add it twice"
        );
    }

    #[test]
    fn helper_aggregation_preserves_unknown_counters_and_reported_zero() {
        let mut aggregate = TaskUsageAggregator::default();
        aggregate.register_helper("unknown-helper");
        assert_eq!(
            counts(aggregate.observe_parent(&usage_event(Some(0), Some(7)))),
            (Some(0), Some(7)),
            "registering a helper does not imply that its model call started"
        );
        aggregate.observe_helper("unknown-helper", &AgentEvent::StepStart { step: 0 });
        assert_eq!(counts(aggregate.total()), (None, None));
        assert_eq!(
            counts(aggregate.observe_helper("unknown-helper", &usage_event(Some(0), Some(0)))),
            (Some(0), Some(7))
        );

        aggregate.register_helper("unstarted-helper");
        assert_eq!(
            counts(aggregate.observe_parent(&usage_event(Some(12), Some(4)))),
            (Some(12), Some(4)),
            "a helper that did not start contributes no unknown usage"
        );
        aggregate.observe_helper("unstarted-helper", &AgentEvent::StepStart { step: 0 });
        assert_eq!(counts(aggregate.total()), (None, None));
    }

    #[test]
    fn a_started_helper_without_a_usage_report_keeps_task_totals_unknown() {
        let mut aggregate = TaskUsageAggregator::default();
        aggregate.observe_parent(&usage_event(Some(100), Some(10)));
        aggregate.register_helper("helper-a");
        assert_eq!(aggregate.counts(), Some((Some(100), Some(10))));
        aggregate.observe_helper("helper-a", &AgentEvent::StepStart { step: 0 });
        assert_eq!(aggregate.counts(), Some((None, None)));
        aggregate.observe_helper("helper-a", &usage_event(Some(30), Some(3)));
        assert_eq!(aggregate.counts(), Some((Some(130), Some(13))));
    }

    #[test]
    fn helper_aggregation_keeps_parent_turns_separate_and_adds_each_once() {
        let mut aggregate = TaskUsageAggregator::default();
        aggregate.observe_parent(&usage_event(Some(10), Some(2)));
        aggregate.begin_parent_turn();
        aggregate.observe_helper("helper-a", &usage_event(Some(5), Some(1)));
        aggregate.observe_parent(&usage_event(Some(3), Some(1)));
        assert_eq!(
            counts(aggregate.total()),
            (Some(18), Some(4)),
            "two parent turns and one helper are accumulated"
        );

        aggregate.begin_parent_turn();
        aggregate.observe_parent(&usage_event(Some(0), Some(0)));
        assert_eq!(
            counts(aggregate.total()),
            (Some(18), Some(4)),
            "a known zero in a later parent turn leaves prior totals unchanged"
        );
    }

    #[test]
    fn helper_unknown_fields_and_new_member_executions_remain_independent() {
        let mut first = TaskUsageAggregator::default();
        first.observe_parent(&usage_event(Some(12), Some(3)));
        first.register_helper("member-a:helper-1");
        assert_eq!(
            counts(first.observe_helper("member-a:helper-1", &usage_event(None, Some(0)))),
            (None, Some(3)),
            "one unreported counter does not erase a different reported counter"
        );
        first.begin_parent_turn();
        first.observe_parent(&usage_event(Some(2), Some(1)));
        assert_eq!(counts(first.total()), (None, Some(4)));

        let mut next = TaskUsageAggregator::default();
        assert_eq!(next.total(), None);
        assert_eq!(
            counts(next.observe_parent(&usage_event(Some(0), Some(0)))),
            (Some(0), Some(0)),
            "a new member execution starts without prior helper or parent counts"
        );
    }

    #[test]
    fn a_started_parent_turn_without_usage_stays_unknown_across_later_turns() {
        let mut aggregate = TaskUsageAggregator::default();
        assert_eq!(
            aggregate.total(),
            None,
            "an unstarted turn adds no component"
        );
        aggregate.begin_parent_turn();
        assert_eq!(aggregate.counts(), Some((None, None)));
        aggregate.begin_parent_turn();
        aggregate.observe_parent(&usage_event(Some(7), Some(1)));
        assert_eq!(
            aggregate.counts(),
            Some((None, None)),
            "a later report cannot account for the earlier unreported turn"
        );
        aggregate.begin_parent_turn();
        aggregate.observe_parent(&usage_event(Some(0), Some(0)));
        assert_eq!(aggregate.counts(), Some((None, None)));
    }

    #[test]
    fn a_new_parent_turn_is_unknown_until_it_reports() {
        let mut aggregate = TaskUsageAggregator::default();
        aggregate.observe_parent(&usage_event(Some(10), Some(2)));
        aggregate.begin_parent_turn();
        assert_eq!(aggregate.counts(), Some((None, None)));
        aggregate.observe_parent(&usage_event(Some(0), Some(0)));
        assert_eq!(aggregate.counts(), Some((Some(10), Some(2))));
    }
}
