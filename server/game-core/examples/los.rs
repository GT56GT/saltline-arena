use game_core::Map;
use glam::Vec3;
fn main() {
    let m = Map::harbour();
    let me = Vec3::new(std::env::args().nth(1).unwrap().parse().unwrap(), 0.0, std::env::args().nth(2).unwrap().parse().unwrap());
    let mut best: Vec<(f32, Vec3)> = m.spawns.iter().map(|s| (s.pos.distance(me), s.pos)).filter(|(d, _)| *d > 4.0).collect();
    best.sort_by(|a, b| a.0.total_cmp(&b.0));
    for (d, p) in best.iter().take(4) {
        let eye = me + Vec3::Y * game_core::EYE_HEIGHT;
        let tgt = *p + Vec3::Y * 1.0;
        let dir = (tgt - eye).normalize();
        let wall = m.raycast(eye, dir, 200.0);
        let blockers: Vec<String> = m.boxes.iter().filter(|b| ray_box(eye, dir, b.min, b.max).is_some_and(|t| t < d + 0.5)).map(|b| format!("{:?}..{:?} po={} {:?}", b.min, b.max, b.player_only, b.surface)).take(3).collect();
        println!("spawn {:?} dist {:.1} wall {:?} blockers {:?}", p, d, wall, blockers);
    }
}
fn ray_box(o: Vec3, d: Vec3, mn: Vec3, mx: Vec3) -> Option<f32> {
    let inv = Vec3::ONE / d;
    let t1 = (mn - o) * inv; let t2 = (mx - o) * inv;
    let tmin = t1.min(t2).max_element(); let tmax = t1.max(t2).min_element();
    if tmax >= tmin.max(0.0) { Some(tmin.max(0.0)) } else { None }
}
