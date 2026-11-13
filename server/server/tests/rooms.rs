//! Private rooms: host, join by code, teams, warm-up, bots only when the host asks for them.

use game_core::{Input, Map};
use glam::Vec3;
use protocol::{ClientMsg, RoomConfig, ServerMsg};
use server::lobby::{JoinReq, Lobby};
use tokio::sync::mpsc;

type Rx = mpsc::UnboundedReceiver<String>;

fn lobby() -> Lobby {
    // Public rooms would top up to 4 with bots; private rooms must ignore that.
    Lobby::new(Map::yard, 4)
}

fn join(l: &mut Lobby, name: &str, req: JoinReq) -> Result<(u64, u32, Rx), String> {
    let (tx, rx) = mpsc::unbounded_channel();
    l.join_with(name.into(), Default::default(), tx, req).map(|(r, p)| (r, p, rx))
}

fn msgs(rx: &mut Rx) -> Vec<ServerMsg> {
    let mut v = Vec::new();
    while let Ok(s) = rx.try_recv() {
        if let Ok(m) = serde_json::from_str::<ServerMsg>(&s) {
            v.push(m);
        }
    }
    v
}

fn teams_cfg() -> RoomConfig {
    RoomConfig { teams: true, ..Default::default() }
}

/// Host with code + two friends, all in one private room.
fn three_players(cfg: RoomConfig) -> (Lobby, u64, [u32; 3], [Rx; 3]) {
    let mut l = lobby();
    let (room, host, mut rx0) = join(&mut l, "Host", JoinReq::Create(cfg)).unwrap();
    let code = msgs(&mut rx0)
        .into_iter()
        .find_map(|m| if let ServerMsg::Room { code, .. } = m { Some(code) } else { None })
        .expect("host is told the room code");
    let (r1, a, rx1) = join(&mut l, "Ana", JoinReq::Code(code.to_lowercase())).unwrap();
    let (r2, b, rx2) = join(&mut l, "Bo", JoinReq::Code(code)).unwrap();
    assert_eq!((r1, r2), (room, room), "joining by code lands in the host's room");
    (l, room, [host, a, b], [rx0, rx1, rx2])
}

/// Shoot `target` from 6 m away (both placed by the server).
fn shoot(l: &mut Lobby, room: u64, shooter: u32, target: u32) {
    let r = l.room_mut(room).unwrap();
    r.teleport(shooter, Vec3::new(0.0, 0.0, 6.0), 0.0);
    r.teleport(target, Vec3::new(0.0, 0.0, 0.0), 0.0);
    // One tick so the rewind history has both players where we put them.
    l.step();
    let r = l.room_mut(room).unwrap();
    let pitch = ((1.2_f32 - game_core::EYE_HEIGHT) / 6.0).atan();
    let seq = r.tick + 1000;
    r.push_inputs(shooter, vec![Input { seq, pitch, fire: true, view_tick: r.tick, ..Default::default() }]);
    l.step();
}

fn hp(l: &mut Lobby, room: u64, id: u32) -> f32 {
    l.room_mut(room).unwrap().state_of(id).unwrap().health
}

#[test]
fn host_room_starts_uneven_without_bots() {
    let (mut l, room, [host, a, b], _rx) = three_players(teams_cfg());
    l.step();
    let r = l.room_mut(room).unwrap();
    assert_eq!(r.bots(), 0, "private rooms get no automatic bots");
    assert_eq!(r.custom.as_ref().unwrap().host, host);
    // Put the host alone on team 0 against two players: 1 v 2.
    for (id, t) in [(host, 0), (a, 1), (b, 1)] {
        l.room_cmd(room, id, ClientMsg::SetTeam { team: t }).unwrap();
    }
    assert!(l.room_cmd(room, a, ClientMsg::Start).is_err(), "only the host can start");
    l.room_cmd(room, host, ClientMsg::Start).expect("host may start 1 v 2");
    let r = l.room_mut(room).unwrap();
    assert!(r.custom.as_ref().unwrap().live);
    assert_eq!((r.team_size(0), r.team_size(1), r.bots()), (1, 2, 0), "bots stay out unless the host turns them on");
}

#[test]
fn balance_bots_fill_the_short_side_only_when_asked() {
    let cfg = RoomConfig { teams: true, balance_bots: true, ..Default::default() };
    let (mut l, room, [host, a, b], _rx) = three_players(cfg);
    for (id, t) in [(host, 0), (a, 1), (b, 1)] {
        l.room_cmd(room, id, ClientMsg::SetTeam { team: t }).unwrap();
    }
    l.room_cmd(room, host, ClientMsg::Start).unwrap();
    let r = l.room_mut(room).unwrap();
    assert_eq!((r.team_size(0), r.team_size(1), r.bots()), (2, 2, 1), "one bot joins the host's side: 2 v 2");
}

#[test]
fn empty_team_cannot_start_and_settings_are_host_only() {
    let (mut l, room, [host, a, b], _rx) = three_players(teams_cfg());
    for id in [host, a, b] {
        l.room_cmd(room, id, ClientMsg::SetTeam { team: 0 }).unwrap();
    }
    assert!(l.room_cmd(room, host, ClientMsg::Start).is_err(), "3 v 0 without bots cannot start");
    assert!(l.room_cmd(room, a, ClientMsg::Configure { config: teams_cfg() }).is_err());
    l.room_cmd(room, host, ClientMsg::Configure { config: RoomConfig { teams: true, balance_bots: true, ..Default::default() } }).unwrap();
    l.room_cmd(room, host, ClientMsg::Start).expect("with bots on, the empty side is filled");
    assert!(l.room_mut(room).unwrap().team_size(1) >= 1);
}

#[test]
fn warmup_is_safe_and_friendly_fire_is_off_by_default() {
    let (mut l, room, [host, a, b], _rx) = three_players(teams_cfg());
    for (id, t) in [(host, 0), (a, 0), (b, 1)] {
        l.room_cmd(room, id, ClientMsg::SetTeam { team: t }).unwrap();
    }
    shoot(&mut l, room, host, b);
    assert_eq!(hp(&mut l, room, b), 100.0, "nobody is hurt during warm-up");
    l.room_cmd(room, host, ClientMsg::Start).unwrap();
    shoot(&mut l, room, host, a);
    assert_eq!(hp(&mut l, room, a), 100.0, "rounds pass through teammates");
    for _ in 0..4 {
        l.step();
    }
    shoot(&mut l, room, host, b);
    assert!(hp(&mut l, room, b) < 100.0, "the other team takes damage once live");
}

#[test]
fn host_leaving_hands_over_and_leavers_are_not_replaced_unless_asked() {
    let (mut l, room, [host, a, _b], _rx) = three_players(teams_cfg());
    l.room_cmd(room, host, ClientMsg::Start).unwrap();
    l.leave(room, host);
    let r = l.room_mut(room).unwrap();
    assert_eq!(r.custom.as_ref().unwrap().host, a, "the next player becomes host");
    assert_eq!(r.bots(), 0);

    let cfg = RoomConfig { teams: true, replace_leavers: true, ..Default::default() };
    let (mut l, room, [host, a, b], _rx) = three_players(cfg);
    l.room_cmd(room, host, ClientMsg::Start).unwrap();
    let team_b = l.room_mut(room).unwrap().players[&b].team;
    l.leave(room, b);
    let r = l.room_mut(room).unwrap();
    assert_eq!(r.bots(), 1, "with replace-leavers on, a bot takes the slot");
    assert!(r.players.values().any(|p| p.is_bot() && p.team == team_b));
    let _ = a;
}

#[test]
fn team_reaching_the_target_wins_then_room_returns_to_warmup() {
    let cfg = RoomConfig { teams: true, kill_target: 5, ..Default::default() };
    let (mut l, room, [host, a, b], mut rx) = three_players(cfg);
    for (id, t) in [(host, 0), (a, 0), (b, 1)] {
        l.room_cmd(room, id, ClientMsg::SetTeam { team: t }).unwrap();
    }
    l.room_cmd(room, host, ClientMsg::Start).unwrap();
    let mut ended = None;
    for _ in 0..400 {
        if l.room_mut(room).unwrap().state_of(b).unwrap().alive {
            shoot(&mut l, room, host, b);
        } else {
            l.step();
        }
        if let Some(e) = msgs(&mut rx[2]).into_iter().find_map(|m| if let ServerMsg::MatchEnd { winner_team, team_scores, .. } = m { Some((winner_team, team_scores)) } else { None }) {
            ended = Some(e);
            break;
        }
    }
    let (winner_team, scores) = ended.expect("match ends at the team kill target");
    assert_eq!(winner_team, Some(0));
    assert_eq!(scores.unwrap()[0], 5);
    assert!(!l.room_mut(room).unwrap().custom.as_ref().unwrap().live, "back to warm-up for a rematch");
}

#[test]
fn quick_play_never_lands_in_a_private_room_and_bad_codes_fail() {
    let mut l = lobby();
    let (private, _, _rx) = join(&mut l, "Host", JoinReq::Create(teams_cfg())).unwrap();
    let (public, _, _rx2) = join(&mut l, "Solo", JoinReq::Quick).unwrap();
    assert_ne!(private, public);
    l.step();
    assert!(l.room_mut(public).unwrap().bots() > 0, "public rooms still top up with bots");
    assert_eq!(l.room_mut(private).unwrap().bots(), 0);
    assert!(join(&mut l, "X", JoinReq::Code("ZZZZZ".into())).is_err());
}

#[test]
fn health_regenerates_after_a_quiet_spell_and_host_damage_setting_applies() {
    let cfg = RoomConfig { teams: true, damage: 50, ..Default::default() };
    let (mut l, room, [host, a, b], _rx) = three_players(cfg);
    for (id, t) in [(host, 0), (a, 0), (b, 1)] {
        l.room_cmd(room, id, ClientMsg::SetTeam { team: t }).unwrap();
    }
    l.room_cmd(room, host, ClientMsg::Start).unwrap();
    for _ in 0..4 {
        l.step();
    }
    shoot(&mut l, room, host, b);
    let hurt = hp(&mut l, room, b);
    assert_eq!(hurt, 100.0 - 9.0, "half damage: 18 x 50%");
    for _ in 0..(3 * game_core::TICK_HZ) {
        l.step();
    }
    assert_eq!(hp(&mut l, room, b), hurt, "no regeneration during the first seconds");
    for _ in 0..(2 * game_core::TICK_HZ) {
        l.step();
    }
    assert_eq!(hp(&mut l, room, b), 100.0, "back to full after the quiet spell");
}
