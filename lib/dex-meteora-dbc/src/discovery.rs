use std::collections::{HashSet, VecDeque};
use std::fmt::{Display, Formatter};
use std::hash::Hash;

/// Root count is independent from recursion depth. The total budget bounds GPA
/// work and memory even when many curves branch into distinct parent quotes.
pub(crate) const MAX_PARENT_DEPTH: usize = 32;
pub(crate) const MAX_DISCOVERY_MINTS: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DiscoveryLimit {
    Depth(usize),
    Mints(usize),
}
impl Display for DiscoveryLimit {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Depth(limit) => write!(f, "DBC parent discovery exceeded depth {limit}"),
            Self::Mints(limit) => write!(
                f,
                "DBC discovery exceeded total budget of {limit} distinct mints"
            ),
        }
    }
}
impl std::error::Error for DiscoveryLimit {}

pub(crate) struct DiscoveryWalk<K> {
    queue: VecDeque<(K, usize)>,
    scheduled: HashSet<K>,
    max_depth: usize,
    max_mints: usize,
}

impl<K: Copy + Eq + Hash> DiscoveryWalk<K> {
    pub(crate) fn new(roots: impl IntoIterator<Item = K>) -> Result<Self, DiscoveryLimit> {
        Self::with_limits(roots, MAX_PARENT_DEPTH, MAX_DISCOVERY_MINTS)
    }

    fn with_limits(
        roots: impl IntoIterator<Item = K>,
        max_depth: usize,
        max_mints: usize,
    ) -> Result<Self, DiscoveryLimit> {
        let mut walk = Self {
            queue: VecDeque::new(),
            scheduled: HashSet::new(),
            max_depth,
            max_mints,
        };
        for root in roots {
            walk.schedule(root, 0)?;
        }
        Ok(walk)
    }

    fn schedule(&mut self, mint: K, depth: usize) -> Result<(), DiscoveryLimit> {
        // Breadth-first scheduling guarantees the first occurrence has the
        // shortest depth from any root. Shared parents and cycles cost no RPC.
        if self.scheduled.contains(&mint) {
            return Ok(());
        }
        if depth > self.max_depth {
            return Err(DiscoveryLimit::Depth(self.max_depth));
        }
        if self.scheduled.len() >= self.max_mints {
            return Err(DiscoveryLimit::Mints(self.max_mints));
        }
        self.scheduled.insert(mint);
        self.queue.push_back((mint, depth));
        Ok(())
    }

    pub(crate) fn next(&mut self) -> Option<(K, usize)> {
        self.queue.pop_front()
    }

    pub(crate) fn add_parent(
        &mut self,
        parent: K,
        child_depth: usize,
    ) -> Result<(), DiscoveryLimit> {
        self.schedule(parent, child_depth.saturating_add(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thousand_shallow_roots_do_not_exhaust_recursion_depth() {
        let mut walk = DiscoveryWalk::new(0..1024u64).unwrap();
        let mut visits = Vec::new();
        while let Some((mint, depth)) = walk.next() {
            visits.push((mint, depth));
            if mint < 1024 {
                walk.add_parent(2000, depth).unwrap();
            }
            if mint == 2000 {
                walk.add_parent(2001, depth).unwrap();
            }
        }
        assert_eq!(visits.len(), 1026);
        assert!(visits[..1024].iter().all(|(_, depth)| *depth == 0));
        assert_eq!(&visits[1024..], &[(2000, 1), (2001, 2)]);
    }

    #[test]
    fn deep_chain_fails_at_parent_limit_without_restricting_other_roots() {
        let mut walk = DiscoveryWalk::new([0u64, 1000]).unwrap();
        while let Some((mint, depth)) = walk.next() {
            if mint == 1000 {
                assert_eq!(depth, 0);
                continue;
            }
            let result = walk.add_parent(mint + 1, depth);
            if depth == MAX_PARENT_DEPTH {
                assert_eq!(result, Err(DiscoveryLimit::Depth(MAX_PARENT_DEPTH)));
                return;
            }
            result.unwrap();
        }
        panic!("Expected chain depth limit");
    }

    #[test]
    fn cycles_and_shared_roots_are_visited_once_at_shortest_depth() {
        let mut walk = DiscoveryWalk::new([0, 1, 0]).unwrap();
        assert_eq!(walk.next(), Some((0, 0)));
        walk.add_parent(1, 0).unwrap();
        assert_eq!(walk.next(), Some((1, 0)));
        walk.add_parent(0, 0).unwrap();
        assert_eq!(walk.next(), None);
    }

    #[test]
    fn total_rpc_budget_is_distinct_from_depth_and_rejects_before_scheduling() {
        let mut walk = DiscoveryWalk::with_limits([0, 1, 2], 32, 4).unwrap();
        walk.add_parent(3, 0).unwrap();
        assert_eq!(walk.add_parent(4, 0), Err(DiscoveryLimit::Mints(4)));
        assert_eq!(walk.scheduled.len(), 4);
        assert!(!walk.scheduled.contains(&4));
    }
}
