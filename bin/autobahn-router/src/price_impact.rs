//! Execution-rate deterioration relative to a smaller actual quote. This is an
//! estimate, not a spot-price oracle, and unavailable estimates remain None.

/// Exact rounded (numerator / denominator * 10_000), without overflowing u128
/// even when both cross-products of u64 token amounts approach u128::MAX.
fn rounded_bps(numerator: u128, denominator: u128) -> Option<u128> {
    let whole = numerator / denominator;
    let fractional = numerator % denominator;
    let mut quotient = 0u128;
    let mut remainder = 0u128;
    for bit in (0..14).rev() {
        quotient *= 2;
        if remainder >= denominator - remainder {
            remainder -= denominator - remainder;
            quotient += 1;
        } else {
            remainder *= 2;
        }
        if (10_000u32 >> bit) & 1 != 0 {
            if remainder >= denominator - fractional {
                remainder -= denominator - fractional;
                quotient += 1;
            } else {
                remainder += fractional;
            }
        }
    }
    let rounded = u128::from(remainder >= denominator - remainder);
    whole
        .checked_mul(10_000)?
        .checked_add(quotient)?
        .checked_add(rounded)
}

pub(crate) fn relative_impact_bps(
    input: u64,
    output: u64,
    sample_input: u64,
    sample_output: u64,
) -> Option<i64> {
    if input == 0 || output == 0 || sample_input == 0 || sample_output == 0 || sample_input >= input
    {
        return None;
    }
    let expected = input as u128 * sample_output as u128;
    let actual = sample_input as u128 * output as u128;
    let magnitude = if actual <= expected {
        rounded_bps(expected - actual, expected)?
    } else {
        rounded_bps(actual - expected, expected)?
    };
    let magnitude: i64 = magnitude.try_into().ok()?;
    Some(if actual <= expected {
        magnitude
    } else {
        -magnitude
    })
}

pub(crate) const MIN_SAMPLE_UNITS: u64 = 10_000;

pub(crate) fn sample_impact_bps(
    input: u64,
    output: u64,
    mut quote: impl FnMut(u64) -> Option<u64>,
) -> Option<i64> {
    // Probe only the selected path, with at most three additional quotes. A
    // 10k-unit floor limits one-unit rounding to a basis point per hop. The
    // caller also applies that floor to intermediate token amounts.
    for divisor in [10_000, 1_000, 100] {
        let sample_input = input / divisor;
        if sample_input < MIN_SAMPLE_UNITS {
            continue;
        }
        if let Some(sample_output) = quote(sample_input).filter(|out| *out >= MIN_SAMPLE_UNITS) {
            return relative_impact_bps(input, output, sample_input, sample_output);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measured_deterioration_and_improvement_keep_the_correct_sign() {
        assert_eq!(
            relative_impact_bps(1_000_000, 1_800_000, 10_000, 20_000),
            Some(1_000)
        );
        assert_eq!(
            relative_impact_bps(1_000_000, 2_200_000, 10_000, 20_000),
            Some(-1_000)
        );
        assert_eq!(
            relative_impact_bps(1_000_000, 2_000_000, 10_000, 20_000),
            Some(0)
        );
    }

    #[test]
    fn maximum_integer_amounts_do_not_overflow_or_pass_through_f64() {
        let max = u64::MAX;
        assert_eq!(
            relative_impact_bps(max, max / 2, max / 100, max / 100),
            Some(5_000)
        );
        assert_eq!(relative_impact_bps(max, max, max / 100, max / 100), Some(0));
        assert_eq!(rounded_bps(u128::MAX / 2, u128::MAX), Some(5_000));
        assert_eq!(rounded_bps(u128::MAX - 1, u128::MAX), Some(10_000));
    }

    #[test]
    fn missing_or_dust_samples_are_unavailable_not_fake_zero() {
        assert_eq!(
            sample_impact_bps(100, 100, |_| panic!("dust must not be quoted")),
            None
        );
        assert_eq!(sample_impact_bps(100_000_000, 1_000_000, |_| None), None);
        assert_eq!(sample_impact_bps(100_000_000, 1_000_000, |_| Some(1)), None);
        assert_eq!(relative_impact_bps(100, 0, 1, 1), None);
        assert_eq!(relative_impact_bps(100, 100, 100, 100), None);
    }

    #[test]
    fn probes_use_actual_curve_and_grow_only_when_rounding_prevents_a_sample() {
        let mut probes = Vec::new();
        let input = 100_000_000u64;
        let quote = |amount: u64| {
            ((amount as u128 * 1_000_000_000) / (1_000_000_000 + amount as u128)) as u64
        };
        let impact = sample_impact_bps(input, quote(input), |amount| {
            probes.push(amount);
            Some(quote(amount))
        });
        assert_eq!(probes, vec![10_000, 100_000]);
        assert_eq!(impact, Some(908));
    }
}
