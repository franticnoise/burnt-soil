from dataclasses import dataclass


WIDTH = 1280
HEIGHT = 720
FPS = 60

SKY_TOP = (246, 201, 116)
SKY_BOTTOM = (233, 128, 74)
HORIZON = (102, 77, 69)
GROUND_FILL = (77, 61, 42)
GROUND_EDGE = (164, 124, 74)
GRID_COLOR = (255, 255, 255, 24)
TEXT = (245, 236, 221)
ACCENT = (255, 214, 102)
WARNING = (246, 92, 66)
SHADOW = (37, 28, 20)

GRAVITY = 240.0
WIND_LIMIT = 85.0
TRAIL_STEP = 4.0

TANK_WIDTH = 34
TANK_HEIGHT = 16
TURRET_LENGTH = 26
TURRET_WIDTH = 4
MAX_HEALTH = 100
TURN_FUEL = 120.0
MOVE_SPEED = 90.0
MIN_POWER = 20
MAX_POWER = 100
POWER_STEP = 35.0
ANGLE_STEP = 70.0
MIN_ANGLE = 10.0
MAX_ANGLE = 170.0
GROUND_CLEARANCE = 3
EXPLOSION_PUSH = 18.0

BASE_SHOT_SPEED = 360.0


@dataclass(frozen=True)
class WeaponSpec:
    name: str
    blast_radius: int
    damage: int
    speed_scale: float
    crater_scale: float
    color: tuple[int, int, int]
    kind: str = "normal"
    child_count: int = 0
    bounce_count: int = 0


WEAPONS = (
    WeaponSpec("Standard", blast_radius=38, damage=46, speed_scale=1.0, crater_scale=1.0, color=(255, 242, 153)),
    WeaponSpec("Heavy", blast_radius=60, damage=70, speed_scale=0.86, crater_scale=1.25, color=(255, 165, 92)),
    WeaponSpec("Digger", blast_radius=88, damage=20, speed_scale=0.94, crater_scale=1.5, color=(173, 232, 244)),
    WeaponSpec("Needler", blast_radius=28, damage=82, speed_scale=1.18, crater_scale=0.8, color=(255, 122, 122)),
    WeaponSpec(
        "Cluster",
        blast_radius=26,
        damage=30,
        speed_scale=0.98,
        crater_scale=0.9,
        color=(255, 196, 117),
        kind="cluster",
        child_count=10,
    ),
    WeaponSpec(
        "Napalm",
        blast_radius=34,
        damage=24,
        speed_scale=0.92,
        crater_scale=0.95,
        color=(255, 121, 74),
        kind="napalm",
        child_count=7,
    ),
    WeaponSpec(
        "Bouncer",
        blast_radius=42,
        damage=50,
        speed_scale=1.04,
        crater_scale=1.05,
        color=(200, 246, 255),
        kind="bouncer",
        bounce_count=2,
    ),
)


PLAYER_COLORS = (
    (233, 93, 83),
    (78, 171, 222),
)

PLAYER_NAMES = (
    "Rust Riders",
    "Blue Suns",
)