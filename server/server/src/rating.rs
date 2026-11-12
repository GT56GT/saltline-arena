//! Glicko-2 ratings (Glickman, 2012). A free-for-all match is scored as pairwise results:
//! you "beat" everyone you out-placed, drew with ties, and lost to those above you.

use std::f64::consts::PI;

pub const START_RATING: f64 = 1500.0;
pub const START_RD: f64 = 350.0;
pub const START_VOL: f64 = 0.06;
const TAU: f64 = 0.5;
const SCALE: f64 = 173.7178;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rating {
    pub rating: f64,
    pub rd: f64,
    pub vol: f64,
}

impl Default for Rating {
    fn default() -> Self {
        Rating { rating: START_RATING, rd: START_RD, vol: START_VOL }
    }
}

fn g(phi: f64) -> f64 {
    1.0 / (1.0 + 3.0 * phi * phi / (PI * PI)).sqrt()
}
fn e(mu: f64, mu_j: f64, phi_j: f64) -> f64 {
    1.0 / (1.0 + (-g(phi_j) * (mu - mu_j)).exp())
}

/// Update `me` after a set of games: (opponent rating, score 0 / 0.5 / 1).
pub fn update(me: Rating, games: &[(Rating, f64)]) -> Rating {
    let mu = (me.rating - START_RATING) / SCALE;
    let phi = me.rd / SCALE;
    if games.is_empty() {
        let phi_star = (phi * phi + me.vol * me.vol).sqrt();
        return Rating { rd: (phi_star * SCALE).min(START_RD), ..me };
    }
    let mut v_inv = 0.0;
    let mut delta_sum = 0.0;
    for (opp, s) in games {
        let mu_j = (opp.rating - START_RATING) / SCALE;
        let phi_j = opp.rd / SCALE;
        let ej = e(mu, mu_j, phi_j);
        v_inv += g(phi_j).powi(2) * ej * (1.0 - ej);
        delta_sum += g(phi_j) * (s - ej);
    }
    let v = 1.0 / v_inv;
    let delta = v * delta_sum;

    // New volatility (Illinois algorithm).
    let a = (me.vol * me.vol).ln();
    let f = |x: f64| {
        let ex = x.exp();
        ex * (delta * delta - phi * phi - v - ex) / (2.0 * (phi * phi + v + ex).powi(2)) - (x - a) / (TAU * TAU)
    };
    let mut big_a = a;
    let mut big_b = if delta * delta > phi * phi + v {
        (delta * delta - phi * phi - v).ln()
    } else {
        let mut k = 1.0;
        while f(a - k * TAU) < 0.0 {
            k += 1.0;
        }
        a - k * TAU
    };
    let (mut fa, mut fb) = (f(big_a), f(big_b));
    for _ in 0..100 {
        if (big_b - big_a).abs() <= 1e-6 {
            break;
        }
        let c = big_a + (big_a - big_b) * fa / (fb - fa);
        let fc = f(c);
        if fc * fb <= 0.0 {
            big_a = big_b;
            fa = fb;
        } else {
            fa /= 2.0;
        }
        big_b = c;
        fb = fc;
    }
    let vol = (big_a / 2.0).exp();
    let phi_star = (phi * phi + vol * vol).sqrt();
    let phi_new = 1.0 / (1.0 / (phi_star * phi_star) + 1.0 / v).sqrt();
    let mu_new = mu + phi_new * phi_new * delta_sum;
    Rating { rating: START_RATING + SCALE * mu_new, rd: (SCALE * phi_new).max(30.0), vol }
}

/// Free-for-all: given each participant's rating and placing (0 = best), return new ratings.
pub fn ffa(players: &[(Rating, u32)]) -> Vec<Rating> {
    players
        .iter()
        .enumerate()
        .map(|(i, (me, place))| {
            let games: Vec<(Rating, f64)> = players
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, (opp, op))| (*opp, if place < op { 1.0 } else if place == op { 0.5 } else { 0.0 }))
                .collect();
            update(*me, &games)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glickman_paper_example() {
        // Example from Glickman's Glicko-2 paper: 1500/200 vs three opponents.
        let me = Rating { rating: 1500.0, rd: 200.0, vol: 0.06 };
        let games = [
            (Rating { rating: 1400.0, rd: 30.0, vol: 0.06 }, 1.0),
            (Rating { rating: 1550.0, rd: 100.0, vol: 0.06 }, 0.0),
            (Rating { rating: 1700.0, rd: 300.0, vol: 0.06 }, 0.0),
        ];
        let r = update(me, &games);
        assert!((r.rating - 1464.06).abs() < 0.1, "{r:?}");
        assert!((r.rd - 151.52).abs() < 0.1, "{r:?}");
        assert!((r.vol - 0.05999).abs() < 1e-4, "{r:?}");
    }

    #[test]
    fn winner_gains_loser_drops() {
        let out = ffa(&[(Rating::default(), 0), (Rating::default(), 1), (Rating::default(), 2)]);
        assert!(out[0].rating > 1500.0 && out[2].rating < 1500.0);
        assert!((out[1].rating - 1500.0).abs() < 1.0);
    }
}
