use super::*;

#[test]
#[ignore]
fn probe_seed_95_jitter() {
    let gen = generate(95);
    let base = detect_topology(&gen.entities);
    let n = gen.entities.len();
    let mut rnd = Prng::new(95 ^ 0x5eed_1234);
    let mut perm: Vec<usize> = (0..n).collect();
    for i in (1..n).rev() {
        let j = rnd.below(i + 1);
        perm.swap(i, j);
    }
    let deltas: Vec<[f64; 2]> = (0..n)
        .map(|_| {
            let angle = rnd.next_f64() * std::f64::consts::TAU;
            let mag = MERGE / 10.0 * (0.2 + 0.8 * rnd.next_f64());
            [mag * angle.cos(), mag * angle.sin()]
        })
        .collect();
    let jittered = jitter_input(&gen.entities, &deltas);
    let moved = detect_topology(&jittered);
    for (label, out) in [("base", &base), ("jittered", &moved)] {
        eprintln!(
            "{label}: surfaces {} hole_regions {}",
            out.surfaces.len(),
            out.hole_regions.len()
        );
        for (i, s) in out.surfaces.iter().enumerate() {
            let (area, c) = crate::topology::oracle::loop_area_centroid(&s.boundary);
            if area.abs() > 1.9e6 {
                let hole_areas: Vec<f64> = s
                    .holes
                    .iter()
                    .map(|h| crate::topology::oracle::loop_area_centroid(h).0)
                    .collect();
                eprintln!(
                    "  {label} surface {i} area {area:.3} centroid ({:.3},{:.3}) holes {:?}",
                    c[0], c[1], hole_areas
                );
            }
        }
        let mut holes: Vec<(f64, f64)> = out
            .hole_regions
            .iter()
            .map(|h| {
                let (area, c) = crate::topology::oracle::loop_area_centroid(&h.boundary);
                (area, c[0])
            })
            .collect();
        holes.sort_by(|a, b| a.0.total_cmp(&b.0));
        eprintln!("  {label} hole areas {holes:?}");
    }
}
