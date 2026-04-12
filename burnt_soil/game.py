from __future__ import annotations

import math
import random

import pygame

from burnt_soil.config import (
    ACCENT,
    ANGLE_STEP,
    BASE_SHOT_SPEED,
    EXPLOSION_PUSH,
    FPS,
    GRAVITY,
    GROUND_EDGE,
    GROUND_FILL,
    HEIGHT,
    HORIZON,
    MOVE_SPEED,
    PLAYER_COLORS,
    PLAYER_NAMES,
    POWER_STEP,
    SHADOW,
    SKY_BOTTOM,
    SKY_TOP,
    TANK_HEIGHT,
    TANK_WIDTH,
    TEXT,
    TRAIL_STEP,
    WARNING,
    WEAPONS,
    WIDTH,
    WIND_LIMIT,
    WeaponSpec,
)
from burnt_soil.entities import Projectile, Tank
from burnt_soil.terrain import Terrain


class BurntSoilGame:
    def __init__(self) -> None:
        pygame.init()
        pygame.display.set_caption("Burnt Soil")
        self.screen = pygame.display.set_mode((WIDTH, HEIGHT))
        self.clock = pygame.time.Clock()
        self.hud_font = pygame.font.SysFont("couriernew", 20, bold=True)
        self.title_font = pygame.font.SysFont("couriernew", 30, bold=True)
        self.small_font = pygame.font.SysFont("couriernew", 15, bold=True)
        self.background = self._build_background()
        self.reset_match()

    def reset_match(self) -> None:
        self.terrain = Terrain(WIDTH, HEIGHT)
        self.tanks = self._spawn_tanks()
        self.projectiles: list[Projectile] = []
        self._spawned_projectiles: list[Projectile] = []
        self.death_explosions: list[dict[str, object]] = []
        self.turn_cursor = -1
        self.active_tank: Tank | None = None
        self.turn_shot_pending = False
        self.wind = 0.0
        self.winner: str | None = None
        self.status_line = "A/D move  Arrow keys aim/power  TAB weapon  SPACE fire  R restart"

        self.camera_focus = pygame.Vector2(WIDTH / 2, HEIGHT / 2)
        self.camera_zoom = 1.0
        self.camera_target_zoom = 1.0
        self.shake_time = 0.0
        self.shake_strength = 0.0

        self.particles: list[dict] = []
        self.damage_texts: list[dict] = []
        self.muzzle_flash: dict | None = None
        self.turn_banner: dict | None = None
        self.screen_flash = 0.0
        self.scorch_marks: list[tuple[int, int, int]] = []  # (x, y, radius)

        self.ai_delay = 0.0
        self.advance_turn(initial=True)

    def _build_background(self) -> pygame.Surface:
        surface = pygame.Surface((WIDTH, HEIGHT))
        for y in range(HEIGHT):
            blend = y / HEIGHT
            color = (
                int(SKY_TOP[0] * (1.0 - blend) + SKY_BOTTOM[0] * blend),
                int(SKY_TOP[1] * (1.0 - blend) + SKY_BOTTOM[1] * blend),
                int(SKY_TOP[2] * (1.0 - blend) + SKY_BOTTOM[2] * blend),
            )
            pygame.draw.line(surface, color, (0, y), (WIDTH, y))

        ridge_points = [(0, HEIGHT)]
        for x in range(0, WIDTH + 80, 80):
            y = int(HEIGHT * 0.58 + math.sin(x / 170) * 28 + math.cos(x / 120) * 18)
            ridge_points.append((x, y))
        ridge_points.append((WIDTH, HEIGHT))
        pygame.draw.polygon(surface, HORIZON, ridge_points)
        pygame.draw.circle(surface, (255, 241, 180), (WIDTH - 130, 110), 48)
        pygame.draw.circle(surface, (255, 225, 149), (WIDTH - 130, 110), 30)

        clouds = pygame.Surface((WIDTH, HEIGHT), pygame.SRCALPHA)
        rng = random.Random(42)
        for _ in range(7):
            cx = rng.randint(80, WIDTH - 80)
            cy = rng.randint(35, int(HEIGHT * 0.28))
            for _j in range(5):
                ox = rng.randint(-34, 34)
                oy = rng.randint(-12, 12)
                r = rng.randint(20, 42)
                pygame.draw.circle(clouds, (255, 255, 255, 30), (cx + ox, cy + oy), r)
        surface.blit(clouds, (0, 0))
        return surface

    def _spawn_tanks(self) -> list[Tank]:
        positions = (0.14, 0.31, 0.69, 0.86)
        angles = (45.0, 55.0, 125.0, 135.0)
        tanks: list[Tank] = []
        for index, fraction in enumerate(positions):
            x = int(WIDTH * fraction)
            self.terrain.make_landing_pad(x, 28)
            y = self.terrain.surface_y(x) - TANK_HEIGHT - 3
            team_index = 0 if index < 2 else 1
            team_offset = index if index < 2 else index - 2
            tank = Tank(
                name=f"{PLAYER_NAMES[team_index]} {team_offset + 1}",
                team=PLAYER_NAMES[team_index],
                color=PLAYER_COLORS[team_index],
                x=float(x),
                y=float(y),
                angle=angles[index],
                ai_controlled=team_index == 1,
            )
            tanks.append(tank)
        return tanks

    def active_teams(self) -> set[str]:
        return {tank.team for tank in self.tanks if tank.alive}

    def advance_turn(self, initial: bool = False) -> None:
        teams = self.active_teams()
        if len(teams) <= 1:
            self.winner = next(iter(teams)) if teams else "Nobody"
            self.active_tank = None
            self.turn_shot_pending = False
            return

        for _ in range(len(self.tanks)):
            self.turn_cursor = (self.turn_cursor + 1) % len(self.tanks)
            candidate = self.tanks[self.turn_cursor]
            if candidate.alive:
                self.active_tank = candidate
                candidate.reset_turn()
                self.turn_shot_pending = True
                self.wind = random.uniform(-WIND_LIMIT, WIND_LIMIT)
                self.ai_delay = random.uniform(0.35, 0.9)
                if not initial:
                    self.status_line = f"{candidate.name} is up. Wind reset."
                    self.turn_banner = {
                        "text": f"{candidate.name}'s turn",
                        "color": candidate.color,
                        "life": 1.6,
                        "max_life": 1.6,
                    }
                return

    def run(self) -> int:
        running = True
        while running:
            dt = self.clock.tick(FPS) / 1000.0
            running = self._handle_events()
            self._update(dt)
            self._draw()
        pygame.quit()
        return 0

    def _handle_events(self) -> bool:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return False
            if event.type == pygame.KEYDOWN:
                if not self._handle_keydown(event.key):
                    return False
        return True

    def _handle_keydown(self, key: int) -> bool:
        if key == pygame.K_ESCAPE:
            return False
        if key == pygame.K_r:
            self.reset_match()
            return True
        if self.winner:
            return True
        if not self.active_tank or self.active_tank.ai_controlled:
            return True
        if self.projectiles or not self.turn_shot_pending:
            return True
        self._handle_player_combat_keydown(key)
        return True

    def _handle_player_combat_keydown(self, key: int) -> None:
        if not self.active_tank:
            return
        if key == pygame.K_TAB:
            self.active_tank.weapon_index = (self.active_tank.weapon_index + 1) % len(WEAPONS)
            self.status_line = f"Weapon: {WEAPONS[self.active_tank.weapon_index].name}"
        elif key == pygame.K_SPACE:
            self._fire_tank(self.active_tank)

    def _update(self, dt: float) -> None:
        self._update_death_explosions(dt)
        self._update_particles(dt)
        self._update_damage_texts(dt)
        self._update_muzzle_flash(dt)
        self._update_turn_banner(dt)
        if self.screen_flash > 0:
            self.screen_flash = max(0.0, self.screen_flash - dt * 4.0)
        if self.winner:
            return

        self._update_camera_state(dt)
        self._update_active_tank_controls(dt)
        self._update_ai_turn(dt)
        self._update_tank_positions(dt)
        self._update_projectiles(dt)

        if self.turn_shot_pending and not self.projectiles and self.active_tank is None:
            self.advance_turn()

    def _update_particles(self, dt: float) -> None:
        alive: list[dict] = []
        for p in self.particles:
            p["life"] -= dt
            if p["life"] <= 0:
                continue
            p["vx"] += self.wind * 0.3 * dt
            p["vy"] += 210 * dt  # gravity on particles
            p["x"] += p["vx"] * dt
            p["y"] += p["vy"] * dt
            alive.append(p)
        self.particles = alive

    def _update_damage_texts(self, dt: float) -> None:
        alive: list[dict] = []
        for t in self.damage_texts:
            t["life"] -= dt
            if t["life"] <= 0:
                continue
            t["y"] -= 40 * dt  # float upward
            alive.append(t)
        self.damage_texts = alive

    def _update_muzzle_flash(self, dt: float) -> None:
        if self.muzzle_flash is None:
            return
        self.muzzle_flash["life"] -= dt
        if self.muzzle_flash["life"] <= 0:
            self.muzzle_flash = None

    def _update_turn_banner(self, dt: float) -> None:
        if self.turn_banner is None:
            return
        self.turn_banner["life"] -= dt
        if self.turn_banner["life"] <= 0:
            self.turn_banner = None

    def _spawn_explosion_particles(
        self, pos: pygame.Vector2, color: tuple[int, int, int], count: int = 18,
    ) -> None:
        for _ in range(count):
            angle = random.uniform(0, math.tau)
            speed = random.uniform(60, 240)
            self.particles.append({
                "x": pos.x + random.uniform(-4, 4),
                "y": pos.y + random.uniform(-4, 4),
                "vx": math.cos(angle) * speed,
                "vy": math.sin(angle) * speed - random.uniform(40, 120),
                "life": random.uniform(0.35, 0.85),
                "max_life": 0.85,
                "color": color,
                "size": random.uniform(2.0, 5.0),
            })

    def _update_death_explosions(self, dt: float) -> None:
        if not self.death_explosions:
            return
        updated: list[dict[str, object]] = []
        for explosion in self.death_explosions:
            ttl = float(explosion["ttl"]) - dt
            if ttl <= 0:
                continue
            explosion["ttl"] = ttl
            updated.append(explosion)
        self.death_explosions = updated

    def _update_active_tank_controls(self, dt: float) -> None:
        if not self.active_tank or self.active_tank.ai_controlled:
            return
        if self.projectiles or not self.turn_shot_pending:
            return

        keys = pygame.key.get_pressed()
        tank = self.active_tank
        if keys[pygame.K_LEFT]:
            tank.angle += ANGLE_STEP * dt
        if keys[pygame.K_RIGHT]:
            tank.angle -= ANGLE_STEP * dt
        power_delta = max(1, int(round(POWER_STEP * dt)))
        if keys[pygame.K_UP]:
            tank.power += power_delta
        if keys[pygame.K_DOWN]:
            tank.power -= power_delta

        horizontal = 0
        if keys[pygame.K_a]:
            horizontal -= 1
        if keys[pygame.K_d]:
            horizontal += 1
        if horizontal and tank.fuel > 0:
            distance = horizontal * MOVE_SPEED * dt
            attempted_x = max(TANK_WIDTH / 2, min(WIDTH - TANK_WIDTH / 2, tank.x + distance))
            if self._can_move_to(tank, attempted_x):
                moved = abs(attempted_x - tank.x)
                tank.x = attempted_x
                tank.fuel = max(0.0, tank.fuel - moved)
                tank.sync_y(self.terrain.surface_y(tank.x))

        tank.clamp_aim()

    def _update_ai_turn(self, dt: float) -> None:
        if not self.active_tank or not self.active_tank.ai_controlled:
            return
        if self.projectiles or not self.turn_shot_pending:
            return

        self.ai_delay -= dt
        if self.ai_delay > 0:
            return

        self._select_ai_shot(self.active_tank)
        self._fire_tank(self.active_tank)

    def _simulate_landing_x(
        self, tank: Tank, angle: float, power: int, weapon: WeaponSpec,
    ) -> float | None:
        """Fast forward-sim to find where a shot lands (x-coord) or None."""
        rad = math.radians(angle)
        speed = BASE_SHOT_SPEED * (power / 100.0) * weapon.speed_scale
        tip = tank.turret_tip()
        px, py = tip.x, tip.y
        vx = math.cos(rad) * speed
        vy = -math.sin(rad) * speed
        step = 0.025
        for _ in range(400):
            vx += self.wind * step
            vy += GRAVITY * step
            px += vx * step
            py += vy * step
            if px < -50 or px > WIDTH + 50 or py > HEIGHT + 50:
                return None
            if py > 0 and 0 <= px < WIDTH and self.terrain.is_solid(px, py):
                return px
        return None

    def _select_ai_shot(self, tank: Tank) -> None:
        targets = [other for other in self.tanks if other.alive and other.team != tank.team]
        if not targets:
            return
        # Pick weakest enemy, prefer closer ones as tiebreaker
        target = min(
            targets,
            key=lambda t: (t.health, abs(t.x - tank.x)),
        )

        weapon_index = self._pick_ai_weapon(target)
        weapon = WEAPONS[weapon_index]

        dx = target.x - tank.x
        if dx >= 0:
            angle_candidates = range(20, 78, 3)
        else:
            angle_candidates = range(102, 161, 3)

        best_angle = 45.0 if dx >= 0 else 135.0
        best_power = 60
        best_error = float("inf")

        # Coarse grid search
        for angle in angle_candidates:
            for power in range(25, 101, 5):
                land_x = self._simulate_landing_x(tank, float(angle), power, weapon)
                if land_x is None:
                    continue
                err = abs(land_x - target.x)
                if err < best_error:
                    best_error = err
                    best_angle = float(angle)
                    best_power = power

        # Fine refine around best result
        for a_off in range(-4, 5):
            for p_off in range(-6, 7, 2):
                a = best_angle + a_off
                p = max(20, min(100, best_power + p_off))
                land_x = self._simulate_landing_x(tank, a, int(p), weapon)
                if land_x is None:
                    continue
                err = abs(land_x - target.x)
                if err < best_error:
                    best_error = err
                    best_angle = a
                    best_power = int(p)

        # Add human-like scatter so AI isn't pixel-perfect every time
        tank.angle = best_angle + random.gauss(0, 2.0)
        tank.power = max(20, min(100, best_power + random.randint(-2, 2)))
        tank.weapon_index = weapon_index
        tank.clamp_aim()

    def _pick_ai_weapon(self, target: Tank) -> int:
        if self.active_tank is None:
            return 0
        distance = abs(target.x - self.active_tank.x)
        # Low-health target: use high-damage weapon
        if target.health <= 35:
            return self._weapon_index("Needler", fallback=0)
        # Long range: cluster for area coverage
        if distance > 400:
            return self._weapon_index("Cluster", fallback=0)
        # Close range: napalm for splash
        if distance < 120:
            return self._weapon_index("Napalm", fallback=1)
        # Mid range: heavy for damage or bouncer for terrain tricks
        if distance < 250:
            return self._weapon_index("Heavy", fallback=0)
        return self._weapon_index("Standard", fallback=0)

    def _weapon_index(self, name: str, fallback: int) -> int:
        for index, weapon in enumerate(WEAPONS):
            if weapon.name == name:
                return index
        return fallback

    def _can_move_to(self, moving_tank: Tank, x_position: float) -> bool:
        for tank in self.tanks:
            if tank is moving_tank or not tank.alive:
                continue
            if abs(tank.x - x_position) < TANK_WIDTH * 1.15:
                return False
        return True

    def _update_tank_positions(self, dt: float) -> None:
        for tank in self.tanks:
            if not tank.alive:
                continue
            target_y = self.terrain.surface_y(tank.x) - TANK_HEIGHT - 3
            if tank.y < target_y:
                tank.y = min(target_y, tank.y + 180.0 * dt)
            else:
                tank.y = target_y

    def _fire_tank(self, tank: Tank) -> None:
        weapon = WEAPONS[tank.weapon_index]
        projectile = self._build_projectile(tank, weapon)
        self.projectiles.append(projectile)
        self.turn_shot_pending = False
        self.status_line = f"{tank.name} fired {weapon.name}."
        tip = tank.turret_tip()
        self.muzzle_flash = {
            "pos": pygame.Vector2(tip.x, tip.y),
            "life": 0.18,
            "max_life": 0.18,
            "radius": 22,
            "color": weapon.color,
        }

    def _build_projectile(self, tank: Tank, weapon: WeaponSpec) -> Projectile:
        angle = math.radians(tank.angle)
        muzzle = tank.turret_tip()
        speed = BASE_SHOT_SPEED * (tank.power / 100.0) * weapon.speed_scale
        velocity = pygame.Vector2(math.cos(angle) * speed, -math.sin(angle) * speed)
        return Projectile(
            owner=tank,
            weapon=weapon,
            position=muzzle,
            velocity=velocity,
            bounces_left=weapon.bounce_count,
            effect_tag=weapon.kind,
        )

    def _update_projectiles(self, dt: float) -> None:
        if not self.projectiles:
            if not self.turn_shot_pending:
                self.advance_turn()
            return

        self._spawned_projectiles = []
        survivors: list[Projectile] = []
        for projectile in self.projectiles:
            exploded = self._simulate_projectile(projectile, dt)
            if not exploded:
                survivors.append(projectile)

        self.projectiles = survivors + self._spawned_projectiles
        self._spawned_projectiles = []

    def _simulate_projectile(self, projectile: Projectile, dt: float) -> bool:
        previous = projectile.position.copy()
        projectile.velocity.x += self.wind * dt
        projectile.velocity.y += GRAVITY * dt
        projectile.position += projectile.velocity * dt

        if not projectile.trail or projectile.position.distance_to(projectile.trail[-1]) >= TRAIL_STEP:
            projectile.trail.append((int(projectile.position.x), int(projectile.position.y)))
            projectile.trail = projectile.trail[-20:]

        if projectile.fuse_time is not None:
            projectile.fuse_time -= dt
            if projectile.fuse_time <= 0:
                self._explode(projectile.position, projectile.weapon)
                return True

        impact = self._find_projectile_impact(previous, projectile.position, projectile.owner)
        if impact is not None:
            if self._try_bounce(projectile, impact):
                return False
            self._explode(impact, projectile.weapon)
            self._spawn_special_children(projectile, impact)
            return True

        out_of_bounds = (
            projectile.position.x < -80
            or projectile.position.x > WIDTH + 80
            or projectile.position.y > HEIGHT + 80
        )
        if out_of_bounds:
            return True
        return False

    def _find_projectile_impact(
        self,
        start: pygame.Vector2,
        end: pygame.Vector2,
        owner: Tank,
    ) -> pygame.Vector2 | None:
        delta = end - start
        steps = max(1, int(delta.length() / 3.0))
        for step in range(1, steps + 1):
            probe = start.lerp(end, step / steps)
            if not (0 <= probe.x < WIDTH):
                continue
            tank_impact = self._probe_hits_tank(probe, owner)
            if tank_impact is not None:
                return tank_impact
            if self.terrain.is_solid(probe.x, probe.y):
                return pygame.Vector2(probe.x, self.terrain.surface_y(probe.x))
        return None

    def _probe_hits_tank(self, probe: pygame.Vector2, owner: Tank) -> pygame.Vector2 | None:
        for tank in self.tanks:
            if not tank.alive:
                continue
            if tank is owner and self._is_owner_grace_period(probe):
                continue
            if tank.body_rect.inflate(4, 6).collidepoint(probe.x, probe.y):
                return pygame.Vector2(probe.x, probe.y)
        return None

    def _is_owner_grace_period(self, probe: pygame.Vector2) -> bool:
        del probe
        if not self.projectiles:
            return False
        return len(self.projectiles[0].trail) < 4

    def _try_bounce(self, projectile: Projectile, impact: pygame.Vector2) -> bool:
        if projectile.bounces_left <= 0:
            return False
        if projectile.effect_tag != "bouncer":
            return False

        normal = self._terrain_normal(impact.x)
        reflected = projectile.velocity.reflect(normal)
        projectile.velocity = reflected * 0.72
        projectile.position = impact - normal * 3
        projectile.bounces_left -= 1
        projectile.trail.clear()
        self.status_line = "Bouncer ricochet!"
        return True

    def _terrain_normal(self, x: float) -> pygame.Vector2:
        left_x = max(0, int(x) - 2)
        right_x = min(WIDTH - 1, int(x) + 2)
        slope = self.terrain.heights[right_x] - self.terrain.heights[left_x]
        tangent = pygame.Vector2(max(1, right_x - left_x), slope)
        normal = pygame.Vector2(-tangent.y, tangent.x)
        if normal.length_squared() == 0:
            return pygame.Vector2(0, -1)
        return normal.normalize()

    def _spawn_special_children(self, projectile: Projectile, impact: pygame.Vector2) -> None:
        if projectile.effect_tag == "cluster":
            self._spawn_cluster_bursts(projectile, impact)
        elif projectile.effect_tag == "napalm":
            self._spawn_napalm_bursts(projectile, impact)

    def _spawn_cluster_bursts(self, projectile: Projectile, impact: pygame.Vector2) -> None:
        count = max(1, projectile.weapon.child_count)
        for _ in range(count):
            spread = random.uniform(-180, 180)
            upward = random.uniform(-300, -190)
            child = Projectile(
                owner=projectile.owner,
                weapon=WeaponSpec(
                    name="Cluster Frag",
                    blast_radius=20,
                    damage=22,
                    speed_scale=1.0,
                    crater_scale=0.7,
                    color=(255, 220, 160),
                ),
                position=impact + pygame.Vector2(random.uniform(-12, 12), -6),
                velocity=pygame.Vector2(spread, upward),
                fuse_time=None,
                effect_tag="cluster_pellet",
            )
            self._spawned_projectiles.append(child)

    def _spawn_napalm_bursts(self, projectile: Projectile, impact: pygame.Vector2) -> None:
        count = max(1, projectile.weapon.child_count)
        for index in range(count):
            horizontal = (index - count // 2) * random.uniform(22, 34)
            child = Projectile(
                owner=projectile.owner,
                weapon=WeaponSpec(
                    name="Napalm Drop",
                    blast_radius=24,
                    damage=16,
                    speed_scale=1.0,
                    crater_scale=0.55,
                    color=(255, 103, 64),
                ),
                position=impact + pygame.Vector2(random.uniform(-14, 14), -2),
                velocity=pygame.Vector2(horizontal, random.uniform(-120, -40)),
                fuse_time=random.uniform(0.25, 0.65),
                effect_tag="child",
            )
            self._spawned_projectiles.append(child)

    def _explode(self, point: pygame.Vector2, weapon: WeaponSpec) -> None:
        crater_radius = int(weapon.blast_radius * weapon.crater_scale)
        self.terrain.carve_circle((int(point.x), int(point.y)), crater_radius)
        for tank in self.tanks:
            self._apply_explosion_to_tank(tank, point, weapon)

        self._spawn_explosion_particles(point, weapon.color, count=22)
        # Dirt particles (brown debris)
        self._spawn_explosion_particles(point, (120, 85, 50), count=10)
        # Scorch mark at impact
        self.scorch_marks.append((int(point.x), int(point.y), crater_radius + 6))

        self.shake_strength = max(self.shake_strength, min(20.0, crater_radius * 0.14))
        self.shake_time = max(self.shake_time, 0.22)
        if crater_radius > 40:
            self.screen_flash = 0.5
        self._update_winner_state()

    def _apply_explosion_to_tank(self, tank: Tank, point: pygame.Vector2, weapon: WeaponSpec) -> None:
        if not tank.alive:
            return

        distance = tank.center.distance_to(point)
        reach = weapon.blast_radius + 24
        if distance > reach:
            return

        falloff = max(0.0, 1.0 - (distance / reach))
        damage = int(weapon.damage * falloff)
        if damage <= 0:
            return

        was_alive = tank.alive
        tank.apply_damage(damage)
        # Floating damage number
        self.damage_texts.append({
            "text": f"-{damage}",
            "x": tank.x + random.uniform(-8, 8),
            "y": tank.y - 30,
            "life": 1.2,
            "max_life": 1.2,
            "color": WARNING if damage >= 30 else TEXT,
        })
        direction = tank.center - point
        if direction.length_squared() > 0:
            direction.scale_to_length(EXPLOSION_PUSH * falloff)
            tank.x = max(TANK_WIDTH / 2, min(WIDTH - TANK_WIDTH / 2, tank.x + direction.x))
            tank.sync_y(self.terrain.surface_y(tank.x))

        if was_alive and not tank.alive:
            self._trigger_tank_destruction(tank)
            self.status_line = f"{tank.name} DESTROYED!"

    def _update_winner_state(self) -> None:
        teams = self.active_teams()
        if len(teams) > 1:
            return
        self.winner = next(iter(teams)) if teams else "Nobody"
        self.status_line = f"{self.winner} wins the duel. Press R to restart."

    def _trigger_tank_destruction(self, tank: Tank) -> None:
        center = pygame.Vector2(tank.x, tank.y + TANK_HEIGHT / 2)
        self.death_explosions.append(
            {
                "center": center,
                "ttl": 0.55,
                "max_ttl": 0.55,
                "radius": 52,
            }
        )
        self.terrain.carve_circle((int(center.x), int(center.y)), 22)
        self.shake_strength = max(self.shake_strength, 14.0)
        self.shake_time = max(self.shake_time, 0.2)
        # Big debris shower
        self._spawn_explosion_particles(center, tank.color, count=30)
        self._spawn_explosion_particles(center, (255, 220, 100), count=16)
        self._spawn_explosion_particles(center, (50, 40, 30), count=12)
        self.screen_flash = 0.7

    def _update_camera_state(self, dt: float) -> None:
        focus = self._camera_focus_target()
        self.camera_focus += (focus - self.camera_focus) * min(1.0, dt * 5.0)

        self.camera_target_zoom = 1.25 if self.projectiles else 1.0
        self.camera_zoom += (self.camera_target_zoom - self.camera_zoom) * min(1.0, dt * 5.0)

        if self.shake_time > 0:
            self.shake_time = max(0.0, self.shake_time - dt)
            if self.shake_time == 0:
                self.shake_strength = 0.0

    def _camera_focus_target(self) -> pygame.Vector2:
        if self.projectiles:
            return self.projectiles[0].position
        if self.active_tank:
            return pygame.Vector2(self.active_tank.x, self.active_tank.y)
        return pygame.Vector2(WIDTH / 2, HEIGHT / 2)

    def _draw(self) -> None:
        world_surface = self._build_frame_world()
        self._draw_main_camera_view(world_surface)
        if self.projectiles:
            self._draw_split_inset(world_surface)
        if self.screen_flash > 0:
            flash_surface = pygame.Surface((WIDTH, HEIGHT), pygame.SRCALPHA)
            flash_alpha = min(160, int(self.screen_flash * 280))
            flash_surface.fill((255, 245, 200, flash_alpha))
            self.screen.blit(flash_surface, (0, 0))
        self._draw_hud(self.screen)
        self._draw_team_sidebar(self.screen)
        self._draw_turn_banner(self.screen)
        pygame.display.flip()

    def _build_frame_world(self) -> pygame.Surface:
        target = self.background.copy()
        target.blit(self.background, (0, 0))
        self._draw_grid(target)
        self._draw_terrain(target)
        self._draw_trajectory_preview(target)

        for tank in self.tanks:
            if tank.alive:
                self._draw_tank(target, tank)

        for projectile in self.projectiles:
            self._draw_projectile(target, projectile)

        self._draw_particles(target)
        self._draw_muzzle_flash(target)
        self._draw_damage_texts(target)
        self._draw_death_explosions(target)
        return target

    def _draw_death_explosions(self, target: pygame.Surface) -> None:
        for explosion in self.death_explosions:
            center = explosion["center"]
            if not isinstance(center, pygame.Vector2):
                continue
            ttl = float(explosion["ttl"])
            max_ttl = max(0.01, float(explosion["max_ttl"]))
            life = 1.0 - (ttl / max_ttl)
            radius = int(float(explosion["radius"]) * (0.45 + life * 0.8))
            alpha = max(20, int(220 * (1.0 - life)))

            blast = pygame.Surface((radius * 2 + 6, radius * 2 + 6), pygame.SRCALPHA)
            c = blast.get_width() // 2
            pygame.draw.circle(blast, (255, 242, 188, alpha), (c, c), int(radius * 0.45))
            pygame.draw.circle(blast, (255, 166, 84, int(alpha * 0.8)), (c, c), int(radius * 0.72))
            pygame.draw.circle(blast, (199, 66, 44, int(alpha * 0.62)), (c, c), radius)
            target.blit(blast, (int(center.x - c), int(center.y - c)))

    def _draw_main_camera_view(self, world_surface: pygame.Surface) -> None:
        self.screen.fill((0, 0, 0))
        zoom = max(1.0, min(1.6, self.camera_zoom))
        view_w = int(WIDTH / zoom)
        view_h = int(HEIGHT / zoom)

        shake_x = 0
        shake_y = 0
        if self.shake_time > 0:
            shake_x = int(random.uniform(-self.shake_strength, self.shake_strength))
            shake_y = int(random.uniform(-self.shake_strength, self.shake_strength))

        left = int(self.camera_focus.x - view_w / 2 + shake_x)
        top = int(self.camera_focus.y - view_h / 2 + shake_y)
        left = max(0, min(WIDTH - view_w, left))
        top = max(0, min(HEIGHT - view_h, top))

        view = world_surface.subsurface((left, top, view_w, view_h))
        scaled = pygame.transform.smoothscale(view, (WIDTH, HEIGHT))
        self.screen.blit(scaled, (0, 0))

    def _draw_split_inset(self, world_surface: pygame.Surface) -> None:
        if not self.active_tank:
            return
        inset_w = 290
        inset_h = 170
        center = pygame.Vector2(self.active_tank.x, self.active_tank.y)
        view_w = int(inset_w / 1.5)
        view_h = int(inset_h / 1.5)

        left = int(center.x - view_w / 2)
        top = int(center.y - view_h / 2)
        left = max(0, min(WIDTH - view_w, left))
        top = max(0, min(HEIGHT - view_h, top))

        view = world_surface.subsurface((left, top, view_w, view_h))
        inset = pygame.transform.smoothscale(view, (inset_w, inset_h))
        frame = pygame.Rect(WIDTH - inset_w - 20, 96, inset_w, inset_h)
        pygame.draw.rect(self.screen, SHADOW, frame.inflate(8, 8), border_radius=8)
        self.screen.blit(inset, frame.topleft)
        pygame.draw.rect(self.screen, TEXT, frame, 2, border_radius=8)
        label = self.small_font.render("Split View: Shooter", True, TEXT)
        self.screen.blit(label, (frame.left + 10, frame.top + 8))

    def _draw_grid(self, target: pygame.Surface) -> None:
        overlay = pygame.Surface((WIDTH, HEIGHT), pygame.SRCALPHA)
        for x in range(0, WIDTH, 80):
            pygame.draw.line(overlay, (255, 255, 255, 16), (x, 0), (x, HEIGHT))
        for y in range(0, HEIGHT, 80):
            pygame.draw.line(overlay, (255, 255, 255, 16), (0, y), (WIDTH, y))
        target.blit(overlay, (0, 0))

    def _draw_terrain(self, target: pygame.Surface) -> None:
        pygame.draw.polygon(target, GROUND_FILL, self.terrain.polygon())
        # Scorch marks (charred earth)
        for sx, sy, sr in self.scorch_marks:
            scorch = pygame.Surface((sr * 2, sr * 2), pygame.SRCALPHA)
            pygame.draw.circle(scorch, (30, 22, 15, 90), (sr, sr), sr)
            pygame.draw.circle(scorch, (20, 14, 8, 60), (sr, sr), int(sr * 0.6))
            target.blit(scorch, (sx - sr, sy - sr))
        edge_points = [(x, height) for x, height in enumerate(self.terrain.heights)]
        pygame.draw.lines(target, GROUND_EDGE, False, edge_points, 3)

    def _draw_tank(self, target: pygame.Surface, tank: Tank) -> None:
        active = tank is self.active_tank and self.turn_shot_pending and not self.winner

        tilt_degrees = self._tank_tilt_degrees(tank)
        tank_sprite = self._build_tank_sprite(tank, active)
        rotated_tank = pygame.transform.rotate(tank_sprite, -tilt_degrees)
        rotated_rect = rotated_tank.get_rect(center=(int(tank.x), int(tank.y + TANK_HEIGHT / 2)))
        shadow_rect = rotated_rect.move(4, 4)
        target.blit(rotated_tank, shadow_rect)
        target.blit(rotated_tank, rotated_rect)

        pygame.draw.line(
            target,
            TEXT if active else SHADOW,
            (int(tank.x), int(tank.y) - 2),
            (int(tank.turret_tip().x), int(tank.turret_tip().y)),
            5,
        )

        self._draw_health_bar(target, tank, active)

    def _build_tank_sprite(self, tank: Tank, active: bool) -> pygame.Surface:
        sprite_w = TANK_WIDTH + 22
        sprite_h = TANK_HEIGHT + 22
        sprite = pygame.Surface((sprite_w, sprite_h), pygame.SRCALPHA)
        center_x = sprite_w // 2
        body_top = 8
        body_rect = pygame.Rect(
            center_x - (TANK_WIDTH // 2),
            body_top,
            TANK_WIDTH,
            TANK_HEIGHT,
        )

        body_color = tank.color
        outline_color = TEXT if active else SHADOW
        pygame.draw.rect(sprite, body_color, body_rect, border_radius=5)
        pygame.draw.circle(sprite, body_color, (center_x, body_top + 2), 12)
        pygame.draw.rect(sprite, outline_color, body_rect, 1, border_radius=5)

        wheels_y = body_top + TANK_HEIGHT + 4
        for offset in (-10, 0, 10):
            pygame.draw.circle(sprite, SHADOW, (center_x + offset, wheels_y), 5)
        return sprite

    def _tank_tilt_degrees(self, tank: Tank) -> float:
        left_x = max(0, int(tank.x) - 10)
        right_x = min(WIDTH - 1, int(tank.x) + 10)
        if right_x == left_x:
            return 0.0
        dy = float(self.terrain.heights[right_x] - self.terrain.heights[left_x])
        dx = float(right_x - left_x)
        slope_degrees = math.degrees(math.atan2(dy, dx))
        return max(-45.0, min(45.0, slope_degrees))

    def _draw_health_bar(self, target: pygame.Surface, tank: Tank, active: bool) -> None:
        width = 54
        left = int(tank.x - width / 2)
        top = int(tank.y - 24)
        pygame.draw.rect(target, SHADOW, (left + 2, top + 2, width, 8), border_radius=4)
        pygame.draw.rect(target, (61, 43, 31), (left, top, width, 8), border_radius=4)
        fill = max(0, int((tank.health / 100) * width))
        bar_color = ACCENT if tank.health > 40 else WARNING
        pygame.draw.rect(target, bar_color, (left, top, fill, 8), border_radius=4)
        if active:
            pygame.draw.rect(target, TEXT, (left - 2, top - 2, width + 4, 12), 1, border_radius=5)

    def _draw_projectile(self, target: pygame.Surface, projectile: Projectile) -> None:
        for index, point in enumerate(projectile.trail):
            alpha = 90 + index * 7
            color = (*projectile.weapon.color, min(alpha, 220))
            trail = pygame.Surface((8, 8), pygame.SRCALPHA)
            pygame.draw.circle(trail, color, (4, 4), 2)
            target.blit(trail, (point[0] - 4, point[1] - 4))

        pygame.draw.circle(
            target,
            projectile.weapon.color,
            (int(projectile.position.x), int(projectile.position.y)),
            4,
        )

    def _draw_trajectory_preview(self, target: pygame.Surface) -> None:
        if not self.active_tank or self.active_tank.ai_controlled:
            return
        if self.projectiles or self.winner or not self.turn_shot_pending:
            return

        weapon = WEAPONS[self.active_tank.weapon_index]
        angle = math.radians(self.active_tank.angle)
        speed = BASE_SHOT_SPEED * (self.active_tank.power / 100.0) * weapon.speed_scale
        position = self.active_tank.turret_tip()
        velocity = pygame.Vector2(math.cos(angle) * speed, -math.sin(angle) * speed)
        impact_pos = None
        for i in range(60):
            velocity.x += self.wind * 0.04
            velocity.y += GRAVITY * 0.04
            position += velocity * 0.04
            if position.x < 0 or position.x >= WIDTH or position.y >= HEIGHT:
                break
            if self.terrain.is_solid(position.x, position.y):
                impact_pos = (int(position.x), int(position.y))
                break
            # Dotted line: every other dot
            if i % 2 == 0:
                alpha = max(60, 220 - i * 3)
                dot = pygame.Surface((6, 6), pygame.SRCALPHA)
                pygame.draw.circle(dot, (*TEXT[:3], alpha), (3, 3), 2)
                target.blit(dot, (int(position.x) - 3, int(position.y) - 3))
        # Impact crosshair
        if impact_pos:
            ix, iy = impact_pos
            cross_size = 10
            cross_color = WARNING
            pygame.draw.line(target, cross_color, (ix - cross_size, iy), (ix + cross_size, iy), 2)
            pygame.draw.line(target, cross_color, (ix, iy - cross_size), (ix, iy + cross_size), 2)
            # Blast radius indicator
            radius = int(weapon.blast_radius * weapon.crater_scale)
            cross_surf = pygame.Surface((radius * 2 + 4, radius * 2 + 4), pygame.SRCALPHA)
            pygame.draw.circle(
                cross_surf, (*cross_color, 40),
                (radius + 2, radius + 2), radius, 1,
            )
            target.blit(cross_surf, (ix - radius - 2, iy - radius - 2))

    def _draw_particles(self, target: pygame.Surface) -> None:
        for p in self.particles:
            life_frac = max(0.0, p["life"] / p["max_life"])
            alpha = int(220 * life_frac)
            sz = max(1, int(p["size"] * life_frac))
            s = pygame.Surface((sz * 2 + 2, sz * 2 + 2), pygame.SRCALPHA)
            pygame.draw.circle(s, (*p["color"], alpha), (sz + 1, sz + 1), sz)
            target.blit(s, (int(p["x"]) - sz - 1, int(p["y"]) - sz - 1))

    def _draw_muzzle_flash(self, target: pygame.Surface) -> None:
        if self.muzzle_flash is None:
            return
        mf = self.muzzle_flash
        life_frac = max(0.0, mf["life"] / mf["max_life"])
        radius = int(mf["radius"] * (0.4 + life_frac * 0.6))
        alpha = int(220 * life_frac)
        s = pygame.Surface((radius * 2 + 4, radius * 2 + 4), pygame.SRCALPHA)
        c = radius + 2
        pygame.draw.circle(s, (255, 255, 240, alpha), (c, c), radius)
        pygame.draw.circle(s, (*mf["color"], int(alpha * 0.7)), (c, c), int(radius * 0.6))
        pos = mf["pos"]
        target.blit(s, (int(pos.x) - c, int(pos.y) - c))

    def _draw_damage_texts(self, target: pygame.Surface) -> None:
        for dt_item in self.damage_texts:
            life_frac = max(0.0, dt_item["life"] / dt_item["max_life"])
            alpha = int(255 * life_frac)
            rendered = self.small_font.render(dt_item["text"], True, dt_item["color"])
            s = pygame.Surface(rendered.get_size(), pygame.SRCALPHA)
            s.blit(rendered, (0, 0))
            s.set_alpha(alpha)
            target.blit(s, (int(dt_item["x"]) - s.get_width() // 2, int(dt_item["y"])))

    def _draw_turn_banner(self, screen: pygame.Surface) -> None:
        if self.turn_banner is None:
            return
        tb = self.turn_banner
        life_frac = max(0.0, tb["life"] / tb["max_life"])
        # Slide in from top then fade
        if life_frac > 0.7:
            slide = (1.0 - life_frac) / 0.3  # 0→1 during first 30%
        elif life_frac < 0.3:
            slide = life_frac / 0.3  # 1→0 during last 30%
        else:
            slide = 1.0
        alpha = int(240 * min(1.0, slide * 1.3))
        y = int(100 + (1.0 - slide) * -40)
        text = self.title_font.render(tb["text"], True, TEXT)
        bg = pygame.Surface((text.get_width() + 60, text.get_height() + 20), pygame.SRCALPHA)
        pygame.draw.rect(bg, (*tb["color"], int(alpha * 0.7)), bg.get_rect(), border_radius=12)
        bg.blit(text, (30, 10))
        bg.set_alpha(alpha)
        screen.blit(bg, (WIDTH // 2 - bg.get_width() // 2, y))

    def _draw_team_sidebar(self, screen: pygame.Surface) -> None:
        panel_w = 160
        panel_h = 22 * len(self.tanks) + 18
        panel = pygame.Surface((panel_w, panel_h), pygame.SRCALPHA)
        pygame.draw.rect(panel, (29, 20, 13, 160), (0, 0, panel_w, panel_h), border_radius=8)
        y = 10
        for tank in self.tanks:
            color = tank.color if tank.alive else (80, 70, 60)
            name = tank.name[:12]
            label = self.small_font.render(name, True, color)
            panel.blit(label, (10, y))
            # Mini HP bar
            bar_w = 50
            bar_x = panel_w - bar_w - 10
            pygame.draw.rect(panel, (50, 40, 30), (bar_x, y + 2, bar_w, 8), border_radius=4)
            fill = max(0, int((tank.health / 100) * bar_w)) if tank.alive else 0
            bar_color = ACCENT if tank.health > 40 else WARNING
            if fill > 0:
                pygame.draw.rect(panel, bar_color, (bar_x, y + 2, fill, 8), border_radius=4)
            y += 20
        screen.blit(panel, (12, 94))

    def _draw_hud(self, target: pygame.Surface) -> None:
        panel = pygame.Surface((WIDTH, 84), pygame.SRCALPHA)
        pygame.draw.rect(panel, (29, 20, 13, 205), (0, 0, WIDTH, 84))
        target.blit(panel, (0, 0))

        title = self.title_font.render("BURNT SOIL", True, ACCENT)
        target.blit(title, (24, 18))

        if self.active_tank and not self.winner:
            weapon = WEAPONS[self.active_tank.weapon_index]
            ai_tag = " AI" if self.active_tank.ai_controlled else ""
            left_text = (
                f"TURN {self.active_tank.name}{ai_tag}   ANG {self.active_tank.angle:5.1f}   "
                f"POW {self.active_tank.power:3d}   FUEL {self.active_tank.fuel:5.1f}"
            )
            target.blit(self.hud_font.render(left_text, True, TEXT), (255, 20))
            weapon_label = f"WEAPON {weapon.name}  DMG {weapon.damage}  BLAST {weapon.blast_radius}"
            target.blit(
                self.hud_font.render(weapon_label, True, weapon.color),
                (255, 47),
            )
            # Active tank dot color indicator
            pygame.draw.circle(target, self.active_tank.color, (240, 30), 8)
            pygame.draw.circle(target, TEXT, (240, 30), 8, 2)
        elif self.winner:
            winner_text = self.title_font.render(f"{self.winner} wins!", True, ACCENT)
            target.blit(winner_text, (255, 18))
            restart_text = self.hud_font.render("Press R to restart", True, TEXT)
            target.blit(restart_text, (255, 52))

        wind_text = f"WIND {self.wind:+05.1f}"
        wind_surface = self.hud_font.render(wind_text, True, TEXT)
        wind_x = WIDTH - 260
        target.blit(wind_surface, (wind_x, 20))
        # Wind gauge with colored bar
        pygame.draw.line(target, (80, 60, 40), (wind_x, 54), (wind_x + 120, 54), 4)
        center_marker = wind_x + 60
        pygame.draw.line(target, TEXT, (center_marker, 48), (center_marker, 60), 1)
        marker = wind_x + 60 + int((self.wind / WIND_LIMIT) * 55)
        wind_color = (100, 200, 255) if self.wind < 0 else (255, 160, 80)
        # Draw filled wind bar from center to marker
        bar_left = min(center_marker, marker)
        bar_right = max(center_marker, marker)
        pygame.draw.rect(target, wind_color, (bar_left, 50, bar_right - bar_left, 8))
        pygame.draw.line(target, ACCENT, (marker, 44), (marker, 64), 4)

        # Arrow showing wind direction
        arrow_tip_x = wind_x + 140
        arrow_y = 50
        if abs(self.wind) > 5:
            direction = 1 if self.wind > 0 else -1
            arrow_size = min(12, int(abs(self.wind) / WIND_LIMIT * 12))
            pygame.draw.line(
                target, wind_color,
                (arrow_tip_x, arrow_y), (arrow_tip_x + direction * arrow_size, arrow_y), 3,
            )
            pygame.draw.line(
                target, wind_color,
                (arrow_tip_x + direction * arrow_size, arrow_y),
                (arrow_tip_x + direction * (arrow_size - 4), arrow_y - 4), 2,
            )
            pygame.draw.line(
                target, wind_color,
                (arrow_tip_x + direction * arrow_size, arrow_y),
                (arrow_tip_x + direction * (arrow_size - 4), arrow_y + 4), 2,
            )

        status = self.small_font.render(self.status_line, True, TEXT)
        target.blit(status, (24, HEIGHT - 28))


def main() -> int:
    game = BurntSoilGame()
    return game.run()
