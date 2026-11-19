pub fn effective_budget(limits: [i32; 3]) -> Result<u32, String> {
    if limits.iter().any(|limit| *limit < 0) {
        return Err("INVALID_BUDGET".into());
    }
    Ok(limits.into_iter().min().unwrap_or(0) as u32)
}

pub struct Reservation {
    pub resource_id: String,
    released: bool,
}

impl Reservation {
    pub fn new(resource_id: &str) -> Self {
        Self {
            resource_id: resource_id.into(),
            released: false,
        }
    }

    pub fn release(&mut self) -> Result<String, String> {
        if self.released {
            return Err("ALREADY_RELEASED".into());
        }
        self.released = true;
        Ok("released".into())
    }
}

pub struct Sample {
    pub value: Option<u64>,
    pub status: String,
    pub reason: Option<String>,
}

pub fn known_sample(value: u64) -> Sample {
    Sample {
        value: Some(value),
        status: "known".into(),
        reason: None,
    }
}

pub fn unknown_sample(reason: &str) -> Sample {
    Sample {
        value: None,
        status: "unknown".into(),
        reason: Some(reason.into()),
    }
}

#[derive(Debug)]
pub struct PerformanceMetrics {
    pub mean: f64,
    pub p95: f64,
    pub max: f64,
    pub count: usize,
}

pub fn performance_metrics(samples: &[f64]) -> Result<PerformanceMetrics, String> {
    if samples.is_empty() {
        return Err("NO_SAMPLES".into());
    }
    if samples
        .iter()
        .any(|sample| !sample.is_finite() || *sample < 0.0)
    {
        return Err("INVALID_SAMPLE".into());
    }
    let mut ordered = samples.to_vec();
    ordered.sort_by(|left, right| left.total_cmp(right));
    let mean = ordered.iter().sum::<f64>() / ordered.len() as f64;
    let p95_index = ((ordered.len() as f64) * 0.95).ceil() as usize - 1;
    Ok(PerformanceMetrics {
        mean,
        p95: ordered[p95_index],
        max: ordered[ordered.len() - 1],
        count: ordered.len(),
    })
}

pub struct PairingReport {
    pub unpaired: Vec<String>,
    pub duplicate_created: Vec<String>,
    pub duplicate_closed: Vec<String>,
}

pub fn pair_resources(created: &[&str], closed: &[&str]) -> PairingReport {
    let duplicates = |values: &[&str]| {
        let mut unique = std::collections::BTreeSet::new();
        let mut duplicate = std::collections::BTreeSet::new();
        for value in values {
            if !unique.insert(*value) {
                duplicate.insert((*value).to_owned());
            }
        }
        duplicate.into_iter().collect::<Vec<_>>()
    };
    let closed_values = closed;
    let closed = closed_values
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    PairingReport {
        unpaired: created
            .iter()
            .copied()
            .filter(|resource| !closed.contains(resource))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .map(str::to_owned)
            .collect(),
        duplicate_created: duplicates(created),
        duplicate_closed: duplicates(closed_values),
    }
}

pub struct ReleaseGate {
    pub allowed: bool,
    pub reasons: Vec<String>,
}

pub fn evaluate_release_gate(
    tests_passed: bool,
    executed: bool,
    evidence: bool,
    coverage: bool,
) -> ReleaseGate {
    let mut reasons = Vec::new();
    if !tests_passed {
        reasons.push("TESTS_FAILED".into());
    }
    if !executed {
        reasons.push("TESTS_NOT_EXECUTED".into());
    }
    if !evidence {
        reasons.push("EVIDENCE_MISSING".into());
    }
    if !coverage {
        reasons.push("COVERAGE_INCOMPLETE".into());
    }
    ReleaseGate {
        allowed: reasons.is_empty(),
        reasons,
    }
}

pub struct EvidenceValidation {
    pub valid: bool,
    pub reason: String,
}

pub fn validate_evidence(
    manual: bool,
    assertion_code: bool,
    deskpilot_marked: bool,
    evidence: bool,
) -> EvidenceValidation {
    let reason = if !manual && !assertion_code {
        "ASSERTION_CODE_MISSING"
    } else if manual && !deskpilot_marked {
        "DESKPILOT_COVERAGE_UNMARKED"
    } else if !evidence {
        "EVIDENCE_MISSING"
    } else {
        ""
    };
    EvidenceValidation {
        valid: reason.is_empty(),
        reason: reason.into(),
    }
}

pub struct SelfCheckReport {
    pub status: String,
    pub guidance: Vec<String>,
}

pub fn aggregate_self_checks(statuses: &[&str]) -> SelfCheckReport {
    let mut guidance = Vec::new();
    if statuses.contains(&"failed") {
        guidance.push("修复失败分项".into());
    }
    if statuses.contains(&"unknown") {
        guidance.push("补充不可判定证据".into());
    }
    if statuses.contains(&"unsupported") {
        guidance.push("使用支持能力或人工验证".into());
    }
    let status = if statuses.contains(&"failed") {
        "failed"
    } else if guidance.is_empty() && statuses.iter().all(|status| *status == "passed") {
        "passed"
    } else {
        "unknown"
    };
    SelfCheckReport {
        status: status.into(),
        guidance,
    }
}
