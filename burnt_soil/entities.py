from __future__ import annotations

import math
from dataclasses import dataclass, field

import pygame

from burnt_soil.config import (
    GROUND_CLEARANCE,
    MAX_ANGLE,
    MAX_HEALTH,
    MAX_POWER,
    MIN_ANGLE,
    MIN_POWER,
    TANK_HEIGHT,
    TANK_WIDTH,
    TURN_FUEL,
    TURRET_LENGTH,
    WeaponSpec,
)


@dataclass
class Tank:
    name: str
    team: str
    color: tuple[int, int, int]
    x: float
    y: float
    angle: float
    power: int = 62
    health: int = MAX_HEALTH
    fuel: float = TURN_FUEL
    weapon_index: int = 0
    ai_controlled: bool = False
    alive: bool = True

    @property
    def center(self) -> pygame.Vector2:
        return pygame.Vector2(self.x, self.y + TANK_HEIGHT / 2)

    @property
    def body_rect(self) -> pygame.Rect:
        return pygame.Rect(
            int(self.x - TANK_WIDTH / 2),
            int(self.y),
            TANK_WIDTH,
            TANK_HEIGHT,
        )

    def turret_tip(self) -> pygame.Vector2:
        radians = math.radians(self.angle)
        return pygame.Vector2(
            self.x + math.cos(radians) * TURRET_LENGTH,
            self.y - 2 - math.sin(radians) * TURRET_LENGTH,
        )

    def clamp_aim(self) -> None:
        self.angle = max(MIN_ANGLE, min(MAX_ANGLE, self.angle))
        self.power = max(MIN_POWER, min(MAX_POWER, self.power))

    def reset_turn(self) -> None:
        self.fuel = TURN_FUEL

    def apply_damage(self, amount: int) -> None:
        self.health = max(0, self.health - amount)
        if self.health == 0:
            self.alive = False

    def sync_y(self, surface_y: int) -> None:
        self.y = surface_y - TANK_HEIGHT - GROUND_CLEARANCE


@dataclass
class Projectile:
    owner: Tank
    weapon: WeaponSpec
    position: pygame.Vector2
    velocity: pygame.Vector2
    armed: bool = True
    bounces_left: int = 0
    fuse_time: float | None = None
    effect_tag: str = ""
    trail: list[tuple[int, int]] = field(default_factory=list)