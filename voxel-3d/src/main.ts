import "./style.css";
import * as THREE from "three";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const WORLD_SIZE = 214;
const VOXEL_SIZE = 0.3;
const TERRAIN_BASE = 11;
const TERRAIN_AMPLITUDE = 4.33;
const FOUNDATION_DEPTH = 40;
const GRAVITY = 20;
const WIND_LIMIT = 6;
const MAX_POWER = 70;
const MIN_POWER = 12;
const MAX_FUEL = 100;
const TANK_MOVE_SPEED = 3.2;
const FUEL_BURN_PER_UNIT = 18;
const MAX_CLIMB_STEP = 0.7;
const TANK_GROUND_CLEARANCE = 0.06;
const WORLD_HALF_EXTENT = WORLD_SIZE * VOXEL_SIZE * 0.5;
const PROJECTILE_BOUNDS = WORLD_HALF_EXTENT + 10;

type Team = "player" | "ai";

// ---- Weapon & Economy System ----

interface WeaponDef {
  name: string;
  cost: number;
  damageMultiplier: number;
  radiusMultiplier: number;
  powerMultiplier: number;
  bulletScale: number;
  type: "standard" | "light" | "cluster" | "napalm";
}

const WEAPONS: Record<string, WeaponDef> = {
  standard: { name: "Standard", cost: 0, damageMultiplier: 1, radiusMultiplier: 1, powerMultiplier: 1, bulletScale: 1, type: "standard" },
  light: { name: "Light Shell", cost: 0, damageMultiplier: 0.55, radiusMultiplier: 0.7, powerMultiplier: 1.35, bulletScale: 0.6, type: "light" },
  cluster: { name: "Cluster Bomb", cost: 150, damageMultiplier: 0.5, radiusMultiplier: 0.6, powerMultiplier: 0.95, bulletScale: 1.2, type: "cluster" },
  napalm: { name: "Napalm", cost: 300, damageMultiplier: 0.4, radiusMultiplier: 0.5, powerMultiplier: 0.9, bulletScale: 1.1, type: "napalm" },
};

interface ShopItem {
  id: string;
  name: string;
  description: string;
  cost: number;
  type: "weapon" | "shield" | "repair25" | "repair50";
}

const SHOP_ITEMS: ShopItem[] = [
  { id: "cluster", name: "Cluster Bomb", description: "Splits into 5 bomblets on impact", cost: 150, type: "weapon" },
  { id: "napalm", name: "Napalm", description: "Lava that flows into terrain holes", cost: 300, type: "weapon" },
  { id: "shield", name: "Force Shield", description: "Absorbs 40% of next hit", cost: 200, type: "shield" },
  { id: "repair25", name: "25% Repair", description: "Restores 25 HP", cost: 100, type: "repair25" },
  { id: "repair50", name: "50% Repair", description: "Restores 50 HP", cost: 200, type: "repair50" },
];

const ROUND_WIN_MONEY = 200;
const ROUND_KILL_MONEY = 75;
const ROUND_HEAL_PERCENT = 25;

// ---- Lava System ----
const LAVA_DAMAGE_PER_SEC = 30;

// ---- Building System ----
const BUILDING_FARM_HP = 80;
const BUILDING_HQ_HP = 250;
const BUILDING_DAMAGE_RADIUS = 5.5;

interface Building {
  mesh: THREE.Group;
  health: number;
  maxHealth: number;
  type: "farm" | "hq";
  team?: Team; // Only HQs have a team
  gridX: number;
  gridZ: number;
  healthBar?: THREE.Sprite;
}

interface GameConfig {
  mode: "singleplayer" | "multiplayer" | "hotseat";
  seed?: number;
  role?: "host" | "guest";
  gameId?: string;
  ws?: WebSocket;
}

class VoxelTerrain {
  public readonly group = new THREE.Group();
  public readonly heights: number[] = [];

  private readonly width: number;
  private readonly depth: number;
  private readonly voxelSize: number;
  private readonly material = new THREE.MeshStandardMaterial({
    color: 0x8c6b46,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
  });
  private readonly foundationMaterial = new THREE.MeshStandardMaterial({
    color: 0x4c443b,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });
  private surfaceMesh: THREE.InstancedMesh | null = null;
  private foundationMesh: THREE.InstancedMesh | null = null;

  constructor(width: number, depth: number, voxelSize: number, seed?: number) {
    this.width = width;
    this.depth = depth;
    this.voxelSize = voxelSize;
    this.generate(seed);
    this.rebuildMesh();
  }

  generate(seed?: number) {
    this.heights.length = this.width * this.depth;
    // Simple seeded random (mulberry32)
    let s = seed ?? Math.floor(Math.random() * 2147483647);
    const seededRandom = () => {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const phaseA = seededRandom() * Math.PI * 2;
    const phaseB = seededRandom() * Math.PI * 2;
    for (let z = 0; z < this.depth; z += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const nx = x / this.width;
        const nz = z / this.depth;
        const wave =
          Math.sin(nx * Math.PI * 2 + phaseA) * TERRAIN_AMPLITUDE +
          Math.cos(nz * Math.PI * 3 + phaseB) * (TERRAIN_AMPLITUDE * 0.45) +
          Math.sin((nx + nz) * Math.PI * 6) * 0.35;
        const h = Math.max(2, Math.round(TERRAIN_BASE + wave));
        this.heights[z * this.width + x] = h;
      }
    }
  }

  getHeight(x: number, z: number): number {
    const ix = THREE.MathUtils.clamp(Math.round(x), 0, this.width - 1);
    const iz = THREE.MathUtils.clamp(Math.round(z), 0, this.depth - 1);
    return this.heights[iz * this.width + ix];
  }

  worldPosition(x: number, y: number, z: number): THREE.Vector3 {
    const halfW = this.width * this.voxelSize * 0.5;
    const halfD = this.depth * this.voxelSize * 0.5;
    return new THREE.Vector3(
      x * this.voxelSize - halfW + this.voxelSize * 0.5,
      y * this.voxelSize,
      z * this.voxelSize - halfD + this.voxelSize * 0.5,
    );
  }

  carveSphere(worldX: number, worldY: number, worldZ: number, radius: number) {
    const halfW = this.width * this.voxelSize * 0.5;
    const halfD = this.depth * this.voxelSize * 0.5;

    const cx = Math.round((worldX + halfW - this.voxelSize * 0.5) / this.voxelSize);
    const cz = Math.round((worldZ + halfD - this.voxelSize * 0.5) / this.voxelSize);
    const cy = Math.round(worldY / this.voxelSize);
    const radiusVoxels = Math.max(2, Math.round(radius / this.voxelSize));

    const minX = Math.max(0, cx - radiusVoxels);
    const maxX = Math.min(this.width - 1, cx + radiusVoxels);
    const minZ = Math.max(0, cz - radiusVoxels);
    const maxZ = Math.min(this.depth - 1, cz + radiusVoxels);

    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - cx;
        const dz = z - cz;
        const distanceXZ = Math.hypot(dx, dz);
        if (distanceXZ > radiusVoxels) continue;

        const depth = Math.sqrt(radiusVoxels * radiusVoxels - distanceXZ * distanceXZ);
        const floor = Math.max(1, Math.round(cy - depth));
        const index = z * this.width + x;
        if (this.heights[index] > floor) {
          this.heights[index] = floor;
        }
      }
    }

    this.relaxEdges(minX, maxX, minZ, maxZ);
    this.rebuildMesh();
  }

  private relaxEdges(minX: number, maxX: number, minZ: number, maxZ: number) {
    const left = Math.max(1, minX - 2);
    const right = Math.min(this.width - 2, maxX + 2);
    const top = Math.max(1, minZ - 2);
    const bottom = Math.min(this.depth - 2, maxZ + 2);

    for (let pass = 0; pass < 4; pass += 1) {
      for (let z = top; z <= bottom; z += 1) {
        for (let x = left; x <= right; x += 1) {
          const i = z * this.width + x;
          const neighbors = [
            this.heights[i - 1],
            this.heights[i + 1],
            this.heights[i - this.width],
            this.heights[i + this.width],
          ];
          const avg = neighbors.reduce((a, b) => a + b, 0) / neighbors.length;
          this.heights[i] = Math.round((this.heights[i] * 2 + avg) / 3);
        }
      }
    }
  }

  private rebuildMesh() {
    if (this.surfaceMesh) {
      this.group.remove(this.surfaceMesh);
      this.surfaceMesh.geometry.dispose();
    }
    if (this.foundationMesh) {
      this.group.remove(this.foundationMesh);
      this.foundationMesh.geometry.dispose();
    }

    const box = new THREE.BoxGeometry(this.voxelSize, this.voxelSize, this.voxelSize);
    const count = this.width * this.depth;
    this.surfaceMesh = new THREE.InstancedMesh(box, this.material, count);
    this.surfaceMesh.castShadow = true;
    this.surfaceMesh.receiveShadow = true;
    this.foundationMesh = new THREE.InstancedMesh(box, this.foundationMaterial, count);
    this.foundationMesh.receiveShadow = true;

    const tempMatrix = new THREE.Matrix4();
    const tempFoundationMatrix = new THREE.Matrix4();
    const foundationHeight = FOUNDATION_DEPTH;
    const foundationCenterY = -(foundationHeight * this.voxelSize) * 0.5;
    let i = 0;
    for (let z = 0; z < this.depth; z += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const height = this.heights[z * this.width + x];
        const position = this.worldPosition(x, 0, z);

        tempFoundationMatrix.makeScale(1, foundationHeight, 1);
        tempFoundationMatrix.setPosition(position.x, foundationCenterY, position.z);
        this.foundationMesh.setMatrixAt(i, tempFoundationMatrix);

        tempMatrix.makeScale(1, height, 1);
        tempMatrix.setPosition(position.x, (height * this.voxelSize) * 0.5, position.z);
        this.surfaceMesh.setMatrixAt(i, tempMatrix);
        i += 1;
      }
    }
    this.surfaceMesh.instanceMatrix.needsUpdate = true;
    this.foundationMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.foundationMesh);
    this.group.add(this.surfaceMesh);
  }

  getWidth() { return this.width; }
  getDepth() { return this.depth; }
  getVoxelSize() { return this.voxelSize; }
}

class Tank {
  readonly team: Team;
  readonly mesh: THREE.Group;
  readonly turretPivot: THREE.Object3D;
  readonly fallbackBody: THREE.Mesh;
  readonly fallbackBarrel: THREE.Mesh;
  angle = Math.PI / 4;
  power = 38;
  heading = 0;
  health = 100;
  alive = true;
  money = 0;
  selectedWeapon: string = "standard";
  inventory: Map<string, number> = new Map(); // weapon id -> ammo count
  hasShield = false;
  shieldMesh: THREE.Mesh | null = null;
  private loadedModel: THREE.Object3D | null = null;
  private loadedTurretPivot: THREE.Object3D | null = null;
  barrelMeshIndices: number[] = [];
  pitchInvert = false;
  maxPitch = 1.57;
  barrelPivotOffset = new THREE.Vector3(0, 0, 0);
  muzzleOffset = new THREE.Vector3(0, 0.45, 1.35);

  constructor(team: Team, color: number) {
    this.team = team;
    this.mesh = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.8, 1.1),
      new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.1 }),
    );
    body.castShadow = true;
    body.receiveShadow = true;

    this.turretPivot = new THREE.Object3D();
    this.turretPivot.position.set(0, 0.35, 0);

    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 1.3, 8),
      new THREE.MeshStandardMaterial({ color: 0x303030, roughness: 0.5 }),
    );
    barrel.rotation.z = Math.PI * 0.5;
    barrel.position.set(0.65, 0, 0);
    barrel.castShadow = true;

    this.fallbackBody = body;
    this.fallbackBarrel = barrel;
    this.turretPivot.add(this.fallbackBarrel);
    this.mesh.add(body);
    this.mesh.add(this.turretPivot);
  }

  getMuzzleWorldPosition(direction: THREE.Vector3) {
    // If we have a loaded turret pivot, compute the muzzle position
    // relative to the pivot so it follows barrel pitch.
    if (this.loadedTurretPivot) {
      this.mesh.updateMatrixWorld(true);
      const localOffset = this.muzzleOffset.clone();
      // Transform the offset from the pivot's local space to world space
      const worldPos = localOffset.applyMatrix4(this.loadedTurretPivot.matrixWorld);
      return worldPos;
    }
    // Fallback: static offset along firing direction
    const unitDir = direction.clone().normalize();
    return this.mesh.position
      .clone()
      .addScaledVector(unitDir, this.muzzleOffset.z)
      .add(new THREE.Vector3(this.muzzleOffset.x, this.muzzleOffset.y, 0));
  }

  setModel(model: THREE.Object3D, yOffset = 0, rotationOffset?: THREE.Vector3) {
    if (this.loadedModel) {
      this.mesh.remove(this.loadedModel);
    }
    this.loadedModel = model;
    this.loadedModel.position.set(0, 0, 0);
    this.loadedModel.rotation.set(0, 0, 0);
    if (rotationOffset) {
      this.loadedModel.rotation.set(rotationOffset.x, rotationOffset.y, rotationOffset.z);
    }

    // Re-center and re-ground after per-tank rotations so the model does not drift or float.
    const box = new THREE.Box3().setFromObject(this.loadedModel);
    const center = new THREE.Vector3();
    box.getCenter(center);
    this.loadedModel.position.x -= center.x;
    this.loadedModel.position.z -= center.z;
    this.loadedModel.position.y -= box.min.y;
    this.loadedModel.position.y += yOffset;

    this.mesh.add(this.loadedModel);
    this.fallbackBody.visible = false;
    this.fallbackBarrel.visible = false;
    this.setupLoadedTurretRig();
    this.setAimPitch(this.angle);
  }

  setAimPitch(angle: number) {
    // Keep fallback cannon behavior for debugging/fallback assets.
    this.turretPivot.rotation.z = -angle;

    if (!this.loadedTurretPivot) {
      return;
    }

    // Barrel starts horizontal (angle=0) and pitches upward.
    // angle is in radians: 0 = flat, PI/2 = straight up.
    // Clamp so it never goes below horizontal.
    const clampedAngle = Math.max(0, Math.min(angle, this.maxPitch));

    // The pivot lives inside the rotated wrapper (loadedModel), so the local
    // axes may not align with the tank's coordinate frame. Compute which
    // local axis corresponds to the tank mesh's X (the "right" axis we
    // want to pitch around) by inverse-transforming through the wrapper.
    const sign = this.pitchInvert ? 1 : -1;
    const pitchAxis = new THREE.Vector3(1, 0, 0);
    if (this.loadedModel) {
      pitchAxis.applyQuaternion(this.loadedModel.quaternion.clone().invert());
    }
    this.loadedTurretPivot.quaternion.setFromAxisAngle(pitchAxis, clampedAngle * sign);
  }

  private setupLoadedTurretRig() {
    this.loadedTurretPivot = null;
    if (!this.loadedModel) {
      return;
    }

    this.loadedModel.updateMatrixWorld(true);
    const modelBox = new THREE.Box3().setFromObject(this.loadedModel);
    const modelCenter = new THREE.Vector3();
    const modelSize = new THREE.Vector3();
    modelBox.getCenter(modelCenter);
    modelBox.getSize(modelSize);

    // Collect all meshes in traversal order (index matches sandbox dropdown)
    const allMeshes: THREE.Mesh[] = [];
    this.loadedModel.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        allMeshes.push(node);
      }
    });

    if (allMeshes.length === 0) {
      return;
    }

    let barrelMembers: THREE.Mesh[];

    // First, check if splitBarrelFromMerged created a "Barrel" mesh
    const barrelByName = allMeshes.find((m) => m.name === "Barrel");
    if (barrelByName) {
      barrelMembers = [barrelByName];
    } else if (this.barrelMeshIndices.length > 0) {
      // Use sandbox-configured indices
      barrelMembers = this.barrelMeshIndices
        .filter((i) => i >= 0 && i < allMeshes.length)
        .map((i) => allMeshes[i]);
      if (barrelMembers.length === 0) {
        return;
      }
    } else {
      // Fallback: auto-detect (legacy heuristic)
      const topThreshold = modelBox.min.y + modelSize.y * 0.52;
      type MeshInfo = { mesh: THREE.Mesh; center: THREE.Vector3; size: THREE.Vector3; score: number };
      const meshInfos: MeshInfo[] = [];
      for (const mesh of allMeshes) {
        const box = new THREE.Box3().setFromObject(mesh);
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);
        const longest = Math.max(size.x, size.y, size.z, 0.0001);
        const cross = Math.max(0.0001, Math.min(size.x, size.y, size.z));
        const elongation = longest / cross;
        const forwardBias = (center.z - modelCenter.z) / Math.max(modelSize.z, 0.0001);
        const heightBias = (center.y - modelCenter.y) / Math.max(modelSize.y, 0.0001);
        const score = elongation * 0.7 + forwardBias * 1.2 + heightBias * 0.4;
        meshInfos.push({ mesh, center, size, score });
      }
      meshInfos.sort((a, b) => b.score - a.score);
      const barrelRef = meshInfos[0];
      const radiusXZ = Math.max(modelSize.x, modelSize.z) * 0.28;
      let filtered = meshInfos.filter((info) => {
        const dx = info.center.x - barrelRef.center.x;
        const dz = info.center.z - barrelRef.center.z;
        const closeToBarrel = Math.hypot(dx, dz) <= radiusXZ;
        const highEnough = info.center.y >= topThreshold;
        const longest = Math.max(info.size.x, info.size.y, info.size.z, 0.0001);
        const shortest = Math.max(0.0001, Math.min(info.size.x, info.size.y, info.size.z));
        const elongation = longest / shortest;
        const forwardEnough = info.center.z >= modelCenter.z - modelSize.z * 0.08;
        return closeToBarrel && highEnough && forwardEnough && elongation >= 1.4;
      });
      if (filtered.length === 0) {
        filtered = [barrelRef];
      }
      barrelMembers = filtered.map((f) => f.mesh);
    }

    // Compute pivot at center of barrel members
    const avgCenter = new THREE.Vector3();
    for (const mesh of barrelMembers) {
      const box = new THREE.Box3().setFromObject(mesh);
      const c = new THREE.Vector3();
      box.getCenter(c);
      avgCenter.add(c);
    }
    avgCenter.divideScalar(barrelMembers.length);

    // Apply barrel pivot offset (shifts rotation center, e.g. to barrel base)
    avgCenter.add(this.barrelPivotOffset);

    const pivot = new THREE.Object3D();
    const pivotPos = avgCenter.clone();
    this.loadedModel.worldToLocal(pivotPos);
    pivot.position.copy(pivotPos);
    this.loadedModel.add(pivot);

    for (const mesh of barrelMembers) {
      pivot.attach(mesh);
    }
    this.loadedTurretPivot = pivot;
  }
}

interface WeaponVisualConfig {
  color: string;
  emissive: string;
  emissiveIntensity: number;
  bulletScale: number;
  trailColor: string;
  trailOpacity: number;
  trailSize: number;
  flashColor: string;
  flashIntensity: number;
  flashRadius: number;
}

type Projectile = {
  owner: Tank;
  mesh: THREE.Object3D;
  velocity: THREE.Vector3;
  weaponType: string;
};

type DeathParticle = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
};

class BurntSoil3D {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 400);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private terrain!: VoxelTerrain;
  private readonly tanks: Tank[] = [];
  private lastFrameTime = globalThis.performance.now() / 1000;
  private readonly keys = new Set<string>();
  private readonly hud = document.createElement("div");
  private readonly defaultOrbitPitch = Math.atan2(16, 18);
  private readonly cameraOrbit = {
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    yaw: 0,
    pitch: Math.atan2(16, 18),
    distance: Math.hypot(16, 18),
    minDistance: 10,
    maxDistance: 80,
    dragSensitivityYaw: 0.006,
    dragSensitivityPitch: 0.005,
    wheelSensitivity: 0.001,
    isDragging: false,
    lastX: 0,
    lastY: 0,
  };

  private currentTankIndex = 0;
  private currentProjectile: Projectile | null = null;
  private wind = 0;
  private shotInFlight = false;
  private turnFuel = MAX_FUEL;
  private aiDelay = 0;
  private bulletTemplate: THREE.Object3D | null = null;
  private weaponVisuals: Record<string, WeaponVisualConfig> = {
    standard: { color: "#ffcc00", emissive: "#ff8800", emissiveIntensity: 0.6, bulletScale: 1.0, trailColor: "#999999", trailOpacity: 0.55, trailSize: 0.25, flashColor: "#ffaa00", flashIntensity: 3, flashRadius: 5 },
    light: { color: "#eeff88", emissive: "#ccdd44", emissiveIntensity: 0.5, bulletScale: 0.6, trailColor: "#aaaaaa", trailOpacity: 0.4, trailSize: 0.18, flashColor: "#ffcc44", flashIntensity: 2, flashRadius: 4 },
    cluster: { color: "#ff6644", emissive: "#cc3300", emissiveIntensity: 0.7, bulletScale: 1.2, trailColor: "#886644", trailOpacity: 0.6, trailSize: 0.3, flashColor: "#ff8800", flashIntensity: 4, flashRadius: 6 },
    napalm: { color: "#ff4400", emissive: "#ff2200", emissiveIntensity: 1.0, bulletScale: 1.1, trailColor: "#ff6633", trailOpacity: 0.7, trailSize: 0.35, flashColor: "#ff4400", flashIntensity: 5, flashRadius: 8 },
  };
  private readonly trajectoryLine: THREE.Line;
  private readonly deathParticles: DeathParticle[] = [];
  private readonly explosionParticles: DeathParticle[] = [];
  private readonly scorchMarks: THREE.Mesh[] = [];
  private readonly damageSprites: { sprite: THREE.Sprite; velocity: THREE.Vector3; life: number; maxLife: number }[] = [];
  private muzzleFlash: { light: THREE.PointLight; mesh: THREE.Mesh; life: number } | null = null;
  private screenFlash = 0;
  private turnBanner: { text: string; color: string; life: number; maxLife: number } | null = null;
  private readonly turnBannerEl = document.createElement("div");
  private readonly teamSidebarEl = document.createElement("div");
  private impactMarker: THREE.Mesh | null = null;
  private impactRing: THREE.Mesh | null = null;
  private gameOver = false;
  private winner: Team | null = null;
  private devMode = false;

  // Day/night cycle
  private dayTimer = 0;
  private readonly dayLength = 90; // seconds per full day cycle
  private sunLight!: THREE.DirectionalLight;
  private hemiLight!: THREE.HemisphereLight;
  private moonLight!: THREE.DirectionalLight;
  private sunOrb!: THREE.Mesh;
  private moonOrb!: THREE.Mesh;
  private readonly CELESTIAL_ORBIT_RADIUS = 60;
  private readonly CELESTIAL_BASE_Y = 12;
  private readonly CELESTIAL_HEIGHT = 50;
  private readonly CELESTIAL_Z_SWAY = 40;
  private daySkyColor = new THREE.Color(0xe8b173);
  private nightSkyColor = new THREE.Color(0x1a1420);

  // Tank tracks & exhaust smoke
  private readonly tankTracks: { mesh: THREE.Mesh; life: number }[] = [];
  private readonly smokeParticles: { mesh: THREE.Mesh; velocity: THREE.Vector3; life: number; maxLife: number; initialSize: number }[] = [];
  private trackDistAccum = 0;
  private readonly TRACK_SPACING = 0.35;

  // Environment props
  private readonly environmentGroup = new THREE.Group();
  private readonly envProps: { obj: THREE.Object3D; baseY: number }[] = [];
  private readonly fallingProps: { obj: THREE.Object3D; velocity: THREE.Vector3; angularVel: THREE.Vector3; life: number }[] = [];

  // Multiplayer
  private readonly gameConfig: GameConfig;
  private mpWs: WebSocket | null = null;
  private myTeam: Team = "player";
  private localTankIndices: number[] = [];

  // Weapon system & rounds
  private currentRound = 1;
  private readonly weaponSelectorEl = document.createElement("div");

  // Lava system
  private readonly lavaVoxels: Set<number> = new Set(); // index into terrain grid
  private lavaMesh: THREE.InstancedMesh | null = null;
  private readonly lavaDamageTimer: Map<Tank, number> = new Map();
  private lavaFlowTimer = 0;
  private readonly LAVA_FLOW_INTERVAL = 0.3;

  // Repair kit pickups
  private readonly repairKits: { mesh: THREE.Group; gridX: number; gridZ: number }[] = [];
  private readonly REPAIR_KIT_HEAL = 30;

  // Camera shake
  private cameraShake = 0;

  // Camera turn transition
  private cameraTurnTransition: {
    fromX: number; fromY: number; fromZ: number; fromYaw: number;
    toX: number; toY: number; toZ: number; toYaw: number;
    elapsed: number; duration: number;
  } | null = null;

  // Projectile smoke trail
  private readonly projectileTrail: { mesh: THREE.Mesh; life: number; maxLife: number; initialOpacity: number; initialSize: number }[] = [];

  // Fire effects in craters
  private readonly craterFires: { mesh: THREE.Mesh; light: THREE.PointLight; life: number; maxLife: number; baseScaleY: number }[] = [];

  // Tank wreckage
  private readonly wreckages: THREE.Object3D[] = [];

  // ── Shared geometry & material pools (avoid per-frame allocations) ──
  private readonly _sharedParticleGeo = new THREE.SphereGeometry(1, 6, 6); // scaled at use-site
  private readonly _sharedParticleGeo8 = new THREE.SphereGeometry(1, 8, 8);
  private readonly _sharedTrackGeo = new THREE.PlaneGeometry(0.22, 0.09);
  private readonly _sharedTrackMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 1, metalness: 0, transparent: true, opacity: 0.45, depthWrite: false });
  private readonly _sharedExhaustMat = new THREE.MeshStandardMaterial({ color: 0x888888, transparent: true, opacity: 0.5, depthWrite: false, roughness: 1 });
  private readonly _sharedScorchGeo = new THREE.CircleGeometry(1, 16); // scaled per scorch
  private readonly _sharedScorchMat = new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 1, metalness: 0, transparent: true, opacity: 0.55, depthWrite: false });
  private readonly _sharedFlashGeo = new THREE.SphereGeometry(0.4, 8, 8);
  private readonly _sharedFireGeo = new THREE.ConeGeometry(1, 1, 6); // scaled per fire
  private readonly _sharedFireMat = new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.8 });
  // Pre-allocated Color objects for day/night cycle (avoid per-frame allocation)
  private readonly _dnSkyColor = new THREE.Color();
  private readonly _dnDayHemiColor = new THREE.Color(0xffefd4);
  private readonly _dnNightHemiColor = new THREE.Color(0x445566);
  private readonly _dnDayGroundColor = new THREE.Color(0x503a2a);
  private readonly _dnNightGroundColor = new THREE.Color(0x1a1a22);
  private readonly _dnWarmColor = new THREE.Color(0xfff2db);
  private readonly _dnSunsetColor = new THREE.Color(0xff9944);

  // Buildings (farm houses + HQ)
  private readonly buildings: Building[] = [];
  private voxPrototypes: { farm: THREE.Object3D[]; hq: THREE.Object3D | null } = { farm: [], hq: null };
  private buildingsReady = false;

  // Shop UI
  private readonly shopOverlayEl = document.createElement("div");

  constructor(canvas: HTMLCanvasElement, config: GameConfig = { mode: "singleplayer" }) {
    this.canvas = canvas;
    this.gameConfig = config;

    // In multiplayer, guest plays as "ai" team
    if (config.mode === "multiplayer") {
      this.myTeam = config.role === "host" ? "player" : "ai";
      this.mpWs = config.ws ?? null;
    }

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene.background = new THREE.Color(0xe8b173);

    const trajectoryMaterial = new THREE.LineDashedMaterial({
      color: 0xfff2a1,
      transparent: true,
      opacity: 0.85,
      dashSize: 0.4,
      gapSize: 0.25,
    });
    const trajectoryGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(0, 0.01, 0),
    ]);
    this.trajectoryLine = new THREE.Line(trajectoryGeometry, trajectoryMaterial);
    this.trajectoryLine.visible = false;
    this.scene.add(this.trajectoryLine);

    // Create terrain with shared seed for multiplayer
    this.terrain = new VoxelTerrain(WORLD_SIZE, WORLD_SIZE, VOXEL_SIZE, config.seed);

    this.setupLights();
    this.scene.add(this.terrain.group);
    this.createLavaRiver();
    this.createSkybox();
    this.createTanks();
    this.spawnRepairKits();
    this.setupCamera();
    this.setupHud();
    this.setupWeaponSelector();
    this.setupShopOverlay();

    globalThis.addEventListener("resize", this.onResize);
    globalThis.addEventListener("keydown", this.onKeyDown);
    globalThis.addEventListener("keyup", this.onKeyUp);
    this.canvas.addEventListener("wheel", this.onMouseWheel, { passive: false });
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    globalThis.addEventListener("mousemove", this.onMouseMove);
    globalThis.addEventListener("mouseup", this.onMouseUp);
    this.canvas.addEventListener("mouseleave", this.onMouseLeave);
    this.canvas.addEventListener("auxclick", this.onAuxClick);

    // Track which tanks this player controls
    if (config.mode === "multiplayer") {
      this.localTankIndices = this.tanks
        .map((t, i) => (t.team === this.myTeam ? i : -1))
        .filter((i) => i >= 0);
      this.setupMultiplayerListeners();
    } else if (config.mode === "hotseat") {
      // All tanks are locally controlled in hotseat
      this.localTankIndices = this.tanks.map((_, i) => i);
    } else {
      this.localTankIndices = this.tanks
        .map((t, i) => (t.team === "player" ? i : -1))
        .filter((i) => i >= 0);
    }

    this.startTurn();
    this.tick();
  }

  async initialize(onProgress?: (progress: number, label: string) => void) {
    const report = onProgress ?? (() => {});
    report(0, "Loading tank models...");
    await this.loadExternalModels();
    report(0.4, "Loading environment...");
    await this.loadEnvironmentProps();
    report(0.7, "Loading buildings...");
    await this.loadBuildingPrototypes();
    report(0.9, "Placing buildings...");
    this.spawnBuildings();
    this.buildingsReady = true;
    report(1, "Ready");
  }

  // ---- Multiplayer sync ----

  private isLocalTurn(): boolean {
    return this.localTankIndices.includes(this.currentTankIndex);
  }

  private mpSend(data: Record<string, unknown>) {
    if (this.mpWs && this.mpWs.readyState === WebSocket.OPEN) {
      this.mpWs.send(JSON.stringify(data));
    }
  }

  private setupMultiplayerListeners() {
    if (!this.mpWs) return;

    this.mpWs.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data));
      switch (data.type) {
        case "game_move": {
          const tank = this.tanks[data.tankIndex as number];
          if (tank) {
            tank.mesh.position.set(
              data.x as number,
              data.y as number,
              data.z as number,
            );
            tank.heading = data.heading as number;
            tank.mesh.rotation.y = tank.heading;
            this.turnFuel = data.fuel as number;
          }
          break;
        }
        case "game_aim": {
          const tank = this.tanks[data.tankIndex as number];
          if (tank) {
            tank.angle = data.angle as number;
            tank.power = data.power as number;
            tank.heading = data.heading as number;
            tank.mesh.rotation.y = tank.heading;
            tank.setAimPitch(tank.angle);
          }
          break;
        }
        case "game_fire": {
          const tank = this.tanks[data.tankIndex as number];
          if (tank) {
            tank.angle = data.angle as number;
            tank.power = data.power as number;
            tank.heading = data.heading as number;
            tank.mesh.rotation.y = tank.heading;
            tank.setAimPitch(tank.angle);
            this.wind = data.wind as number;
            this.fireCurrentTank();
          }
          break;
        }
        case "game_turn_start": {
          this.currentTankIndex = data.tankIndex as number;
          this.wind = data.wind as number;
          this.shotInFlight = false;
          this.turnFuel = MAX_FUEL;
          this.trackDistAccum = 0;
          const isLocal = this.isLocalTurn();
          const label = isLocal ? "YOUR" : "OPPONENT'S";
          this.turnBanner = {
            text: `${label} Turn`,
            color: `rgba(${isLocal ? "200,80,60" : "60,140,200"}, 0.85)`,
            life: 1.6,
            maxLife: 1.6,
          };
          this.updateHud();
          break;
        }
        case "opponent_disconnected": {
          this.gameOver = true;
          this.winner = this.myTeam;
          this.turnBanner = {
            text: "OPPONENT DISCONNECTED",
            color: "rgba(200,80,60,0.85)",
            life: 5,
            maxLife: 5,
          };
          this.updateHud();
          break;
        }
      }
    });
  }

  private async loadExternalModels() {
    // Load model config (sandbox-authored values)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let modelConfig: Record<string, any> = {};
    try {
      const res = await fetch("/model-config.json");
      modelConfig = await res.json();
    } catch { /* use defaults */ }

    // Load weapon visual configs if present
    if (modelConfig.weapons) {
      for (const key of Object.keys(this.weaponVisuals)) {
        if (modelConfig.weapons[key]) {
          this.weaponVisuals[key] = { ...this.weaponVisuals[key], ...modelConfig.weapons[key] };
        }
      }
    }

    const t90Cfg = modelConfig.t90 ?? { preRotation: [0.02, 0, 0], scale: 2.4, setModelYOffset: -0.01, setModelRotation: [-1.57, 0, 0], barrelMeshIndices: [], pitchInvert: false };
    const panzerCfg = modelConfig.panzer ?? { preRotation: [0, 0, 3.14], scale: 2.2, setModelYOffset: -0.01, setModelRotation: [1.58, 3.14, 1.57], barrelMeshIndices: [], pitchInvert: true };

    const [playerModel, playerModel2, enemyModel, enemyModel2, bulletModel] = await Promise.all([
      this.loadT90Model(t90Cfg),
      this.tanks[2] ? this.loadT90Model(t90Cfg) : Promise.resolve(null),
      this.loadPanzerModel(panzerCfg),
      this.tanks[3] ? this.loadPanzerModel(panzerCfg) : Promise.resolve(null),
      this.loadBulletModel(),
    ]);

    if (playerModel) {
      this.tanks[0].barrelMeshIndices = t90Cfg.barrelMeshIndices;
      this.tanks[0].pitchInvert = !!t90Cfg.pitchInvert;
      if (t90Cfg.maxPitch != null) this.tanks[0].maxPitch = t90Cfg.maxPitch;
      if (t90Cfg.barrelPivotOffset) this.tanks[0].barrelPivotOffset.set(t90Cfg.barrelPivotOffset[0], t90Cfg.barrelPivotOffset[1], t90Cfg.barrelPivotOffset[2]);
      if (t90Cfg.muzzleOffset) this.tanks[0].muzzleOffset.set(t90Cfg.muzzleOffset[0], t90Cfg.muzzleOffset[1], t90Cfg.muzzleOffset[2]);
      this.tanks[0].setModel(playerModel, t90Cfg.setModelYOffset, new THREE.Vector3(...t90Cfg.setModelRotation as [number, number, number]));
    }
    if (this.tanks[2] && playerModel2) {
      this.tanks[2].barrelMeshIndices = t90Cfg.barrelMeshIndices;
      this.tanks[2].pitchInvert = !!t90Cfg.pitchInvert;
      if (t90Cfg.maxPitch != null) this.tanks[2].maxPitch = t90Cfg.maxPitch;
      if (t90Cfg.barrelPivotOffset) this.tanks[2].barrelPivotOffset.set(t90Cfg.barrelPivotOffset[0], t90Cfg.barrelPivotOffset[1], t90Cfg.barrelPivotOffset[2]);
      if (t90Cfg.muzzleOffset) this.tanks[2].muzzleOffset.set(t90Cfg.muzzleOffset[0], t90Cfg.muzzleOffset[1], t90Cfg.muzzleOffset[2]);
      this.tanks[2].setModel(playerModel2, t90Cfg.setModelYOffset, new THREE.Vector3(...t90Cfg.setModelRotation as [number, number, number]));
    }
    if (enemyModel) {
      this.tanks[1].barrelMeshIndices = panzerCfg.barrelMeshIndices;
      this.tanks[1].pitchInvert = !!panzerCfg.pitchInvert;
      if (panzerCfg.maxPitch != null) this.tanks[1].maxPitch = panzerCfg.maxPitch;
      if (panzerCfg.barrelPivotOffset) this.tanks[1].barrelPivotOffset.set(panzerCfg.barrelPivotOffset[0], panzerCfg.barrelPivotOffset[1], panzerCfg.barrelPivotOffset[2]);
      if (panzerCfg.muzzleOffset) this.tanks[1].muzzleOffset.set(panzerCfg.muzzleOffset[0], panzerCfg.muzzleOffset[1], panzerCfg.muzzleOffset[2]);
      this.tanks[1].setModel(enemyModel, panzerCfg.setModelYOffset, new THREE.Vector3(...panzerCfg.setModelRotation as [number, number, number]));
    }
    if (this.tanks[3] && enemyModel2) {
      this.tanks[3].barrelMeshIndices = panzerCfg.barrelMeshIndices;
      this.tanks[3].pitchInvert = !!panzerCfg.pitchInvert;
      if (panzerCfg.maxPitch != null) this.tanks[3].maxPitch = panzerCfg.maxPitch;
      if (panzerCfg.barrelPivotOffset) this.tanks[3].barrelPivotOffset.set(panzerCfg.barrelPivotOffset[0], panzerCfg.barrelPivotOffset[1], panzerCfg.barrelPivotOffset[2]);
      if (panzerCfg.muzzleOffset) this.tanks[3].muzzleOffset.set(panzerCfg.muzzleOffset[0], panzerCfg.muzzleOffset[1], panzerCfg.muzzleOffset[2]);
      this.tanks[3].setModel(enemyModel2, panzerCfg.setModelYOffset, new THREE.Vector3(...panzerCfg.setModelRotation as [number, number, number]));
    }
    if (bulletModel) {
      this.bulletTemplate = bulletModel;
    }
  }

  private async loadT90Model(cfg: { preRotation: number[]; scale: number }): Promise<THREE.Object3D | null> {
    try {
      const loader = new OBJLoader();
      const model = await loader.loadAsync("/models/t-90a/t-90a(Elements_of_war).obj");
      this.keepPrimaryMeshCluster(model, 5.5);
      this.mergeMeshesByName(model, ["DrawCall_1244", "DrawCall_1301"]);
      this.splitBarrelFromMerged(model, "DrawCall_1244+DrawCall_1301");
      await this.applyTextureToModel(model, "/models/t-90a/textures/8eca739b.jpg", 0.85, 0.15);
      model.rotation.set(cfg.preRotation[0], cfg.preRotation[1], cfg.preRotation[2]);
      this.normalizeModel(model, cfg.scale);
      const wrapper = new THREE.Group();
      wrapper.add(model);
      return wrapper;
    } catch {
      return null;
    }
  }

  private async loadPanzerModel(cfg: { preRotation: number[]; scale: number }): Promise<THREE.Object3D | null> {
    try {
      const mtlLoader = new MTLLoader();
      mtlLoader.setPath("/models/Panzer_III/");
      mtlLoader.setResourcePath("/models/Panzer_III/texture/");
      const materials = await mtlLoader.loadAsync("14077_WWII_Tank_Germany_Panzer_III_v1_L2.mtl");
      materials.preload();

      const objLoader = new OBJLoader();
      objLoader.setMaterials(materials);
      objLoader.setPath("/models/Panzer_III/");
      const model = await objLoader.loadAsync("14077_WWII_Tank_Germany_Panzer_III_v1_L2.obj");
      this.splitBarrelFromMerged(model, "14077_WWII_Tank_Germany_Panzer_III_turret");
      model.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
      });
      model.rotation.set(cfg.preRotation[0], cfg.preRotation[1], cfg.preRotation[2]);
      this.normalizeModel(model, cfg.scale);
      const wrapper = new THREE.Group();
      wrapper.add(model);
      return wrapper;
    } catch {
      return null;
    }
  }

  private async loadBulletModel(): Promise<THREE.Object3D | null> {
    try {
      const loader = new OBJLoader();
      const model = await loader.loadAsync("/models/bullet45/45.obj");
      await this.applyTextureToModel(model, "/models/bullet45/texture/bullet.jpg", 0.45, 0.55);
      this.normalizeModel(model, 0.12);
      return model;
    } catch {
      return null;
    }
  }

  private async loadEnvironmentProps() {
    try {
      const loader = new GLTFLoader();
      const loadGLB = (path: string) => loader.loadAsync(path).then((gltf) => gltf.scene);

      const [pine, pineCrooked, rocksTall, rocks, debris, trunk] = await Promise.all([
        loadGLB("/models/environment/pine.glb"),
        loadGLB("/models/environment/pine-crooked.glb"),
        loadGLB("/models/environment/rocks-tall.glb"),
        loadGLB("/models/environment/rocks.glb"),
        loadGLB("/models/environment/debris.glb"),
        loadGLB("/models/environment/trunk.glb"),
      ]);

      // Fix colorSpace on embedded GLB textures
      for (const proto of [pine, pineCrooked, rocksTall, rocks, debris, trunk]) {
        proto.traverse((node) => {
          if (node instanceof THREE.Mesh && node.material) {
            const mat = node.material as THREE.MeshStandardMaterial;
            if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
          }
        });
      }

      const prototypes = [
        { model: pine, weight: 3, scaleRange: [0.45, 0.72] as [number, number] },
        { model: pineCrooked, weight: 3, scaleRange: [0.42, 0.65] as [number, number] },
        { model: rocksTall, weight: 1, scaleRange: [0.32, 0.52] as [number, number] },
        { model: rocks, weight: 1, scaleRange: [0.28, 0.45] as [number, number] },
        { model: debris, weight: 1, scaleRange: [0.25, 0.38] as [number, number] },
        { model: trunk, weight: 1, scaleRange: [0.28, 0.42] as [number, number] },
      ];

      // Build weighted pool
      const pool: typeof prototypes = [];
      for (const p of prototypes) {
        for (let i = 0; i < p.weight; i++) pool.push(p);
      }

      const halfW = WORLD_SIZE * VOXEL_SIZE * 0.5;
      const margin = 4;
      const tankPositions = this.tanks.map((t) => new THREE.Vector2(t.mesh.position.x, t.mesh.position.z));
      const placements: THREE.Vector2[] = [];
      const minSpacing = 4;
      const tankClearance = 6;
      const targetCount = 45;

      for (let attempts = 0; attempts < 1200 && placements.length < targetCount; attempts++) {
        const x = THREE.MathUtils.randFloat(-halfW + margin, halfW - margin);
        const z = THREE.MathUtils.randFloat(-halfW + margin, halfW - margin);
        const pos2 = new THREE.Vector2(x, z);

        // Don't place too close to other props
        const tooCloseToOther = placements.some((p) => p.distanceTo(pos2) < minSpacing);
        if (tooCloseToOther) continue;

        // Don't place near tanks
        const tooCloseToTank = tankPositions.some((tp) => tp.distanceTo(pos2) < tankClearance);
        if (tooCloseToTank) continue;

        placements.push(pos2);
      }

      for (const pos of placements) {
        const entry = pool[Math.floor(Math.random() * pool.length)];
        const instance = entry.model.clone(true);
        const scale = THREE.MathUtils.randFloat(entry.scaleRange[0], entry.scaleRange[1]);
        instance.scale.setScalar(scale);
        instance.rotation.y = Math.random() * Math.PI * 2;

        const terrainY = this.sampleTerrainHeightAtWorld(pos.x, pos.y);
        instance.position.set(pos.x, terrainY, pos.y);

        instance.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.castShadow = true;
            node.receiveShadow = true;
            node.frustumCulled = false;
          }
        });

        this.environmentGroup.add(instance);
        this.envProps.push({ obj: instance, baseY: terrainY });
      }
    } catch (e) {
      console.warn("Failed to load environment props:", e);
    }
  }

  private destroyProp(prop: { obj: THREE.Object3D; baseY: number }, blastPos: THREE.Vector3) {
    // Remove from env tracking
    const idx = this.envProps.indexOf(prop);
    if (idx >= 0) this.envProps.splice(idx, 1);
    this.environmentGroup.remove(prop.obj);

    // Spawn falling debris pieces from the prop
    const propPos = prop.obj.position.clone();
    const awayDir = propPos.clone().sub(blastPos).normalize();

    // Break into chunks — clone the model a few times as debris pieces
    const chunkCount = THREE.MathUtils.randInt(3, 6);
    for (let i = 0; i < chunkCount; i++) {
      const chunk = prop.obj.clone(true);
      chunk.scale.multiplyScalar(THREE.MathUtils.randFloat(0.3, 0.6));
      chunk.position.copy(propPos).add(new THREE.Vector3(
        THREE.MathUtils.randFloatSpread(0.5),
        THREE.MathUtils.randFloat(0, 0.6),
        THREE.MathUtils.randFloatSpread(0.5),
      ));
      this.scene.add(chunk);

      const velocity = new THREE.Vector3(
        awayDir.x * THREE.MathUtils.randFloat(3, 8) + THREE.MathUtils.randFloatSpread(4),
        THREE.MathUtils.randFloat(4, 10),
        awayDir.z * THREE.MathUtils.randFloat(3, 8) + THREE.MathUtils.randFloatSpread(4),
      );
      const angularVel = new THREE.Vector3(
        THREE.MathUtils.randFloatSpread(8),
        THREE.MathUtils.randFloatSpread(8),
        THREE.MathUtils.randFloatSpread(8),
      );
      this.fallingProps.push({ obj: chunk, velocity, angularVel, life: THREE.MathUtils.randFloat(1.5, 2.8) });
    }

    // Spawn extra particles at prop location
    this.spawnExplosionParticles(propPos, 0x5a7a3a, 8);
    this.spawnExplosionParticles(propPos, 0x8c6b46, 6);
  }

  private updateFallingProps(dt: number) {
    for (let i = this.fallingProps.length - 1; i >= 0; i--) {
      const fp = this.fallingProps[i];
      fp.life -= dt;
      fp.velocity.y -= GRAVITY * 0.8 * dt;
      fp.obj.position.addScaledVector(fp.velocity, dt);
      fp.obj.rotation.x += fp.angularVel.x * dt;
      fp.obj.rotation.y += fp.angularVel.y * dt;
      fp.obj.rotation.z += fp.angularVel.z * dt;

      // Stop on terrain
      const groundY = this.sampleTerrainHeightAtWorld(fp.obj.position.x, fp.obj.position.z);
      if (fp.obj.position.y < groundY) {
        fp.obj.position.y = groundY;
        fp.velocity.y = Math.abs(fp.velocity.y) * 0.2;
        fp.velocity.x *= 0.6;
        fp.velocity.z *= 0.6;
      }

      // Fade out
      if (fp.life <= 0.5) {
        const alpha = Math.max(0, fp.life / 0.5);
        fp.obj.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            const mat = node.material as THREE.MeshStandardMaterial;
            if (!mat.transparent) { mat.transparent = true; }
            mat.opacity = alpha;
          }
        });
      }

      if (fp.life <= 0) {
        this.scene.remove(fp.obj);
        this.fallingProps.splice(i, 1);
      }
    }
  }

  private checkPropsAfterExplosion(blastPos: THREE.Vector3, blastRadius: number) {
    // Destroy props within blast radius
    const destroyRadius = blastRadius + 2.5;
    for (let i = this.envProps.length - 1; i >= 0; i--) {
      const prop = this.envProps[i];
      const dist = prop.obj.position.distanceTo(blastPos);
      if (dist < destroyRadius) {
        this.destroyProp(prop, blastPos);
      }
    }
  }

  private checkPropsOnCrumbledTerrain() {
    // Props whose ground dropped significantly should fall
    for (let i = this.envProps.length - 1; i >= 0; i--) {
      const prop = this.envProps[i];
      const currentTerrainY = this.sampleTerrainHeightAtWorld(prop.obj.position.x, prop.obj.position.z);
      const drop = prop.baseY - currentTerrainY;
      if (drop > 0.6) {
        // Terrain crumbled under this prop — destroy it
        this.destroyProp(prop, prop.obj.position.clone().add(new THREE.Vector3(0, -1, 0)));
      } else if (Math.abs(prop.obj.position.y - currentTerrainY) > 0.1) {
        // Gently settle onto new terrain height
        prop.obj.position.y = currentTerrainY;
        prop.baseY = currentTerrainY;
      }
    }
  }

  private async applyTextureToModel(model: THREE.Object3D, textureUrl: string, roughness: number, metalness: number) {
    const texture = await new THREE.TextureLoader().loadAsync(textureUrl);
    texture.colorSpace = THREE.SRGBColorSpace;
    model.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.material = new THREE.MeshStandardMaterial({
          map: texture,
          roughness,
          metalness,
        });
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
  }

  private normalizeModel(model: THREE.Object3D, targetSize: number) {
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const largest = Math.max(size.x, size.y, size.z, 0.0001);
    const scale = targetSize / largest;
    model.scale.setScalar(scale);

    const boxAfter = new THREE.Box3().setFromObject(model);
    const center = new THREE.Vector3();
    boxAfter.getCenter(center);
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= boxAfter.min.y;
  }

  private mergeMeshesByName(model: THREE.Object3D, names: string[]) {
    const targets: THREE.Mesh[] = [];
    model.traverse((node) => {
      if (node instanceof THREE.Mesh && names.includes(node.name)) targets.push(node);
    });
    if (targets.length < 2) return;
    model.updateMatrixWorld(true);
    const geos = targets.map((m) => {
      const g = m.geometry.clone();
      g.applyMatrix4(m.matrixWorld);
      return g;
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) return;
    const parent = targets[0].parent;
    const invParent = new THREE.Matrix4();
    if (parent) invParent.copy(parent.matrixWorld).invert();
    merged.applyMatrix4(invParent);
    const newMesh = new THREE.Mesh(merged, targets[0].material);
    newMesh.name = names.join("+");
    newMesh.castShadow = true;
    newMesh.receiveShadow = true;
    if (parent) parent.add(newMesh);
    for (const t of targets) t.parent?.remove(t);
  }

  private splitBarrelFromMerged(model: THREE.Object3D, meshName: string) {
    let targetMesh: THREE.Mesh | null = null;
    model.traverse((n) => { if (n instanceof THREE.Mesh && n.name === meshName) targetMesh = n; });
    if (!targetMesh) return;
    const geo = (targetMesh as THREE.Mesh).geometry;
    const pos = geo.attributes.position;
    const idx = geo.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;

    // Step 1: bounding box, find longest axis (barrel direction)
    const bbox = new THREE.Box3();
    for (let i = 0; i < pos.count; i++) {
      bbox.expandByPoint(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
    const bboxSize = bbox.getSize(new THREE.Vector3());
    const dims = [bboxSize.x, bboxSize.y, bboxSize.z];
    const fwdAxis = dims.indexOf(Math.max(...dims));
    const perpAxes = [0, 1, 2].filter((a) => a !== fwdAxis);
    const getAx = (v: THREE.Vector3, a: number) => a === 0 ? v.x : a === 1 ? v.y : v.z;
    const fwdMin = getAx(bbox.min, fwdAxis);
    const fwdMax = getAx(bbox.max, fwdAxis);
    const fwdRange = fwdMax - fwdMin;

    // Step 2: cross-section analysis
    const NUM_SLICES = 30;
    const sliceWidth = fwdRange / NUM_SLICES;
    const sliceMaxR = new Float64Array(NUM_SLICES);
    const sliceCounts = new Int32Array(NUM_SLICES);
    const sliceCenterPerp0 = new Float64Array(NUM_SLICES);
    const sliceCenterPerp1 = new Float64Array(NUM_SLICES);

    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      const s = Math.min(Math.floor((getAx(v, fwdAxis) - fwdMin) / sliceWidth), NUM_SLICES - 1);
      sliceCenterPerp0[s] += getAx(v, perpAxes[0]);
      sliceCenterPerp1[s] += getAx(v, perpAxes[1]);
      sliceCounts[s]++;
    }
    for (let s = 0; s < NUM_SLICES; s++) {
      if (sliceCounts[s] > 0) {
        sliceCenterPerp0[s] /= sliceCounts[s];
        sliceCenterPerp1[s] /= sliceCounts[s];
      }
    }
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      const s = Math.min(Math.floor((getAx(v, fwdAxis) - fwdMin) / sliceWidth), NUM_SLICES - 1);
      const d0 = getAx(v, perpAxes[0]) - sliceCenterPerp0[s];
      const d1 = getAx(v, perpAxes[1]) - sliceCenterPerp1[s];
      sliceMaxR[s] = Math.max(sliceMaxR[s], Math.sqrt(d0 * d0 + d1 * d1));
    }

    // Step 3: detect barrel — check BOTH ends, pick the narrower one
    let loSlice = 0;
    while (loSlice < NUM_SLICES && sliceCounts[loSlice] === 0) loSlice++;
    let hiSlice = NUM_SLICES - 1;
    while (hiSlice > 0 && sliceCounts[hiSlice] === 0) hiSlice--;
    const avgTipR = (startSlice: number, dir: number) => {
      let sum = 0, cnt = 0;
      for (let s = startSlice; cnt < 2 && s >= 0 && s < NUM_SLICES; s += dir) {
        if (sliceCounts[s] > 0) { sum += sliceMaxR[s]; cnt++; }
      }
      return cnt > 0 ? sum / cnt : Infinity;
    };
    const loTipR = avgTipR(loSlice, 1);
    const hiTipR = avgTipR(hiSlice, -1);
    const barrelAtHi = hiTipR <= loTipR;
    const tipSlice = barrelAtHi ? hiSlice : loSlice;
    const tipRadius = barrelAtHi ? hiTipR : loTipR;
    const walkDir = barrelAtHi ? -1 : 1;
    const barrelRadiusThreshold = tipRadius * 2.0;
    let barrelStartSlice = tipSlice;
    for (let s = tipSlice; s >= 0 && s < NUM_SLICES; s += walkDir) {
      if (sliceCounts[s] === 0) continue;
      if (sliceMaxR[s] > barrelRadiusThreshold) { barrelStartSlice = s - walkDir; break; }
      barrelStartSlice = s;
    }
    const barrelStartFwd = fwdMin + Math.min(barrelStartSlice, tipSlice) * sliceWidth;
    const barrelEndFwd = fwdMin + (Math.max(barrelStartSlice, tipSlice) + 1) * sliceWidth;

    // Step 4: barrel centerline
    let bCent0 = 0, bCent1 = 0, bCount = 0;
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      const fwd = getAx(v, fwdAxis);
      if (fwd >= barrelStartFwd && fwd <= barrelEndFwd) {
        bCent0 += getAx(v, perpAxes[0]);
        bCent1 += getAx(v, perpAxes[1]);
        bCount++;
      }
    }
    if (bCount > 0) { bCent0 /= bCount; bCent1 /= bCount; }
    let barrelRadius = 0;
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      const fwd = getAx(v, fwdAxis);
      if (fwd >= barrelStartFwd && fwd <= barrelEndFwd) {
        const d0 = getAx(v, perpAxes[0]) - bCent0;
        const d1 = getAx(v, perpAxes[1]) - bCent1;
        barrelRadius = Math.max(barrelRadius, Math.sqrt(d0 * d0 + d1 * d1));
      }
    }
    const barrelCutR = barrelRadius * 1.3;

    // Step 5: classify triangles
    const turretCenterFwd = barrelAtHi
      ? fwdMin + (loSlice + barrelStartSlice) / 2 * sliceWidth
      : fwdMin + (barrelStartSlice + hiSlice) / 2 * sliceWidth;
    const barrelTriList: number[] = [];
    const turretTriList: number[] = [];
    for (let t = 0; t < triCount; t++) {
      let cx = 0, cy = 0, cz = 0;
      for (let v = 0; v < 3; v++) {
        const i = idx ? idx.getX(t * 3 + v) : t * 3 + v;
        cx += pos.getX(i); cy += pos.getY(i); cz += pos.getZ(i);
      }
      cx /= 3; cy /= 3; cz /= 3;
      const c = new THREE.Vector3(cx, cy, cz);
      const fwd = getAx(c, fwdAxis);
      const d0 = getAx(c, perpAxes[0]) - bCent0;
      const d1 = getAx(c, perpAxes[1]) - bCent1;
      const perpDist = Math.sqrt(d0 * d0 + d1 * d1);
      const inBarrelZone = fwd >= barrelStartFwd && fwd <= barrelEndFwd;
      const inBarrelCylinder = perpDist < barrelCutR;
      const inExtendedZone = barrelAtHi
        ? (fwd >= turretCenterFwd && fwd < barrelStartFwd && perpDist < barrelRadius * 1.05)
        : (fwd <= turretCenterFwd && fwd > barrelEndFwd && perpDist < barrelRadius * 1.05);
      if ((inBarrelZone && inBarrelCylinder) || inExtendedZone) {
        barrelTriList.push(t);
      } else {
        turretTriList.push(t);
      }
    }
    if (barrelTriList.length === 0) return;

    // Step 6: extract and replace
    const extractTris = (tris: number[]) => {
      const np: number[] = [], nn: number[] = [], nu: number[] = [];
      const hasNorm = !!geo.attributes.normal;
      const hasUV = !!geo.attributes.uv;
      for (const t of tris) {
        for (let v = 0; v < 3; v++) {
          const i = idx ? idx.getX(t * 3 + v) : t * 3 + v;
          np.push(pos.getX(i), pos.getY(i), pos.getZ(i));
          if (hasNorm) { const n = geo.attributes.normal; nn.push(n.getX(i), n.getY(i), n.getZ(i)); }
          if (hasUV) { const u = geo.attributes.uv; nu.push(u.getX(i), u.getY(i)); }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(np, 3));
      if (nn.length) g.setAttribute("normal", new THREE.Float32BufferAttribute(nn, 3));
      if (nu.length) g.setAttribute("uv", new THREE.Float32BufferAttribute(nu, 2));
      if (!nn.length) g.computeVertexNormals();
      return g;
    };
    const meshParent = (targetMesh as THREE.Mesh).parent;
    const mat = (targetMesh as THREE.Mesh).material;
    const turretBody = new THREE.Mesh(extractTris(turretTriList), mat);
    turretBody.name = "Turret_Body";
    turretBody.castShadow = true; turretBody.receiveShadow = true;
    const barrel = new THREE.Mesh(extractTris(barrelTriList), mat);
    barrel.name = "Barrel";
    barrel.castShadow = true; barrel.receiveShadow = true;
    if (meshParent) {
      meshParent.remove(targetMesh as THREE.Mesh);
      meshParent.add(turretBody);
      meshParent.add(barrel);
    }
  }

  private keepPrimaryMeshCluster(model: THREE.Object3D, clusterDistance: number) {
    const meshEntries: Array<{ mesh: THREE.Mesh; center: THREE.Vector3; parent: THREE.Object3D | null }> = [];
    model.updateMatrixWorld(true);
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      const box = new THREE.Box3().setFromObject(node);
      const center = new THREE.Vector3();
      box.getCenter(center);
      meshEntries.push({ mesh: node, center, parent: node.parent });
    });

    if (meshEntries.length <= 1) {
      return;
    }

    type Cluster = { members: typeof meshEntries; centroid: THREE.Vector3 };
    const clusters: Cluster[] = [];

    for (const entry of meshEntries) {
      let bestCluster: Cluster | null = null;
      let bestDistance = Infinity;
      for (const cluster of clusters) {
        const d = cluster.centroid.distanceTo(entry.center);
        if (d < bestDistance) {
          bestDistance = d;
          bestCluster = cluster;
        }
      }
      if (!bestCluster || bestDistance > clusterDistance) {
        clusters.push({ members: [entry], centroid: entry.center.clone() });
        continue;
      }
      bestCluster.members.push(entry);
      bestCluster.centroid.multiplyScalar(bestCluster.members.length - 1).add(entry.center).divideScalar(bestCluster.members.length);
    }

    if (clusters.length <= 1) {
      return;
    }

    clusters.sort((a, b) => b.members.length - a.members.length);
    const keep = new Set(clusters[0].members.map((entry) => entry.mesh));

    for (const entry of meshEntries) {
      if (keep.has(entry.mesh)) {
        continue;
      }
      entry.parent?.remove(entry.mesh);
    }
  }

  private setupLights() {
    // Hemisphere light
    this.hemiLight = new THREE.HemisphereLight(0xffefd4, 0x503a2a, 1);
    this.scene.add(this.hemiLight);

    // Sun (directional)
    this.sunLight = new THREE.DirectionalLight(0xfff2db, 1.2);
    this.sunLight.position.set(24, 40, 14);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.left = -50;
    this.sunLight.shadow.camera.right = 50;
    this.sunLight.shadow.camera.top = 50;
    this.sunLight.shadow.camera.bottom = -50;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 150;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.02;
    this.sunLight.target.position.set(0, 0, 0);
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // Moon light
    this.moonLight = new THREE.DirectionalLight(0xd8e7ff, 0.5);
    this.moonLight.position.set(-40, 50, -30);
    this.moonLight.castShadow = true;
    this.moonLight.shadow.mapSize.set(1024, 1024);
    this.moonLight.shadow.camera.left = -50;
    this.moonLight.shadow.camera.right = 50;
    this.moonLight.shadow.camera.top = 50;
    this.moonLight.shadow.camera.bottom = -50;
    this.moonLight.shadow.camera.near = 1;
    this.moonLight.shadow.camera.far = 150;
    this.moonLight.intensity = 0;
    this.scene.add(this.moonLight);
    this.scene.add(this.moonLight.target);

    // Sun orb (visual)
    this.sunOrb = new THREE.Mesh(
      new THREE.SphereGeometry(2.5, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffe68a }),
    );
    this.scene.add(this.sunOrb);

    // Moon orb (visual)
    this.moonOrb = new THREE.Mesh(
      new THREE.SphereGeometry(2, 14, 14),
      new THREE.MeshBasicMaterial({ color: 0xd8e7ff }),
    );
    this.moonOrb.visible = false;
    this.scene.add(this.moonOrb);

    // Environment group for trees/rocks
    this.scene.add(this.environmentGroup);
  }

  private getCelestialPosition(progress: number) {
    const clamped = THREE.MathUtils.clamp(progress, 0, 1);
    const azimuth = clamped * Math.PI - Math.PI / 2;
    return new THREE.Vector3(
      Math.sin(azimuth) * this.CELESTIAL_ORBIT_RADIUS,
      this.CELESTIAL_BASE_Y + Math.cos(azimuth) * this.CELESTIAL_HEIGHT,
      -Math.cos(azimuth) * this.CELESTIAL_Z_SWAY,
    );
  }

  private updateDayCycle(dt: number) {
    this.dayTimer = (this.dayTimer + dt) % this.dayLength;
    const progress = this.dayTimer / this.dayLength; // 0..1 over full cycle

    // Split: 0..0.5 = day, 0.5..1 = night
    const isDay = progress < 0.5;
    const phaseProgress = isDay ? progress / 0.5 : (progress - 0.5) / 0.5; // 0..1 within phase

    // Sun position (traverses during day)
    const sunPos = this.getCelestialPosition(isDay ? phaseProgress : 0);
    this.sunOrb.position.copy(sunPos);
    this.sunOrb.visible = isDay;
    this.sunLight.position.set(sunPos.x, sunPos.y + 8, sunPos.z + 6);

    // Moon position (traverses during night)
    const moonPos = this.getCelestialPosition(isDay ? 0 : phaseProgress);
    this.moonOrb.position.copy(moonPos);
    this.moonOrb.visible = !isDay;
    this.moonLight.position.set(moonPos.x, moonPos.y + 6, moonPos.z + 4);

    // Sunrise/sunset transitions (smooth edges)
    let dayFactor: number;
    if (isDay) {
      // Fade in during first 15% of day, fade out during last 15%
      if (phaseProgress < 0.15) dayFactor = phaseProgress / 0.15;
      else if (phaseProgress > 0.85) dayFactor = (1 - phaseProgress) / 0.15;
      else dayFactor = 1;
    } else {
      // Night — fade based on how deep into night
      if (phaseProgress < 0.1) dayFactor = 1 - phaseProgress / 0.1;
      else if (phaseProgress > 0.9) dayFactor = (phaseProgress - 0.9) / 0.1;
      else dayFactor = 0;
    }

    // Sky color: lerp between day and night
    this._dnSkyColor.copy(this.nightSkyColor).lerp(this.daySkyColor, dayFactor);
    this.scene.background = this._dnSkyColor;

    // Hemisphere light
    this.hemiLight.color.copy(this._dnNightHemiColor).lerp(this._dnDayHemiColor, dayFactor);
    this.hemiLight.groundColor.copy(this._dnNightGroundColor).lerp(this._dnDayGroundColor, dayFactor);
    this.hemiLight.intensity = THREE.MathUtils.lerp(0.35, 1.0, dayFactor);

    // Sun intensity
    this.sunLight.intensity = THREE.MathUtils.lerp(0.05, 1.3, dayFactor);
    // Near sunrise/sunset: warm orange tint
    const sunsetFactor = 1 - Math.min(1, Math.abs(dayFactor - 0.5) * 3);
    this.sunLight.color.copy(this._dnWarmColor).lerp(this._dnSunsetColor, sunsetFactor * 0.4);

    // Moon intensity (inverse of day)
    this.moonLight.intensity = THREE.MathUtils.lerp(0.55, 0, dayFactor);
  }

  private createTanks() {
    const playerA = new Tank("player", 0xea6153);
    const aiA = new Tank("ai", 0x4ea9de);
    const playerB = new Tank("player", 0xf39c12);
    const aiB = new Tank("ai", 0x2ecc71);
    this.tanks.push(playerA, aiA, playerB, aiB);
    this.scene.add(playerA.mesh, aiA.mesh, playerB.mesh, aiB.mesh);

    this.placeTankAt(playerA, 14, 14);
    this.placeTankAt(aiA, WORLD_SIZE - 14, WORLD_SIZE - 14);
    this.placeTankAt(playerB, 20, WORLD_SIZE - 20);
    this.placeTankAt(aiB, WORLD_SIZE - 20, 20);

    aiA.angle = Math.PI * 0.75;
    aiB.angle = Math.PI * 0.72;

    const center = new THREE.Vector3(0, 0, 0);
    for (const tank of this.tanks) {
      const toCenter = center.clone().sub(tank.mesh.position);
      tank.heading = Math.atan2(toCenter.x, toCenter.z);
      tank.mesh.rotation.y = tank.heading;
    }
  }

  private placeTankAt(tank: Tank, vx: number, vz: number) {
    const height = this.terrain.getHeight(vx, vz);
    const world = this.terrain.worldPosition(vx, height, vz);
    tank.mesh.position.copy(world);
    tank.mesh.position.y += TANK_GROUND_CLEARANCE;
  }

  private setupCamera() {
    this.applyCameraOrbit();
  }

  private applyCameraOrbit() {
    const minPitch = 0.3;
    const maxPitch = 1.35;
    this.cameraOrbit.pitch = THREE.MathUtils.clamp(this.cameraOrbit.pitch, minPitch, maxPitch);
    this.cameraOrbit.distance = THREE.MathUtils.clamp(
      this.cameraOrbit.distance,
      this.cameraOrbit.minDistance,
      this.cameraOrbit.maxDistance,
    );

    const horizontalDistance = Math.cos(this.cameraOrbit.pitch) * this.cameraOrbit.distance;
    const camX = this.cameraOrbit.targetX + Math.sin(this.cameraOrbit.yaw) * horizontalDistance;
    const camY = this.cameraOrbit.targetY + Math.sin(this.cameraOrbit.pitch) * this.cameraOrbit.distance;
    const camZ = this.cameraOrbit.targetZ + Math.cos(this.cameraOrbit.yaw) * horizontalDistance;
    this.camera.position.set(camX, camY, camZ);
    this.camera.lookAt(this.cameraOrbit.targetX, this.cameraOrbit.targetY, this.cameraOrbit.targetZ);
  }

  private setupHud() {
    this.hud.style.position = "fixed";
    this.hud.style.left = "16px";
    this.hud.style.top = "16px";
    this.hud.style.color = "#f7efe4";
    this.hud.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace";
    this.hud.style.background = "rgba(25, 15, 8, 0.72)";
    this.hud.style.padding = "10px 12px";
    this.hud.style.borderRadius = "8px";
    this.hud.style.border = "1px solid rgba(255,255,255,0.18)";
    this.hud.style.minWidth = "420px";
    this.hud.style.fontSize = "13px";
    this.hud.style.lineHeight = "1.6";
    document.body.appendChild(this.hud);

    // Turn banner (centered top)
    this.turnBannerEl.style.position = "fixed";
    this.turnBannerEl.style.top = "80px";
    this.turnBannerEl.style.left = "50%";
    this.turnBannerEl.style.transform = "translateX(-50%)";
    this.turnBannerEl.style.color = "#fff";
    this.turnBannerEl.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace";
    this.turnBannerEl.style.fontSize = "24px";
    this.turnBannerEl.style.fontWeight = "bold";
    this.turnBannerEl.style.padding = "10px 32px";
    this.turnBannerEl.style.borderRadius = "12px";
    this.turnBannerEl.style.pointerEvents = "none";
    this.turnBannerEl.style.display = "none";
    this.turnBannerEl.style.textShadow = "0 2px 8px rgba(0,0,0,0.5)";
    document.body.appendChild(this.turnBannerEl);

    // Team sidebar (right side)
    this.teamSidebarEl.style.position = "fixed";
    this.teamSidebarEl.style.right = "16px";
    this.teamSidebarEl.style.top = "16px";
    this.teamSidebarEl.style.color = "#f7efe4";
    this.teamSidebarEl.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace";
    this.teamSidebarEl.style.background = "rgba(25, 15, 8, 0.72)";
    this.teamSidebarEl.style.padding = "10px 12px";
    this.teamSidebarEl.style.borderRadius = "8px";
    this.teamSidebarEl.style.border = "1px solid rgba(255,255,255,0.18)";
    this.teamSidebarEl.style.fontSize = "12px";
    this.teamSidebarEl.style.lineHeight = "1.7";
    this.teamSidebarEl.style.minWidth = "160px";
    document.body.appendChild(this.teamSidebarEl);

    // Dev mode button
    const devBtn = document.createElement("button");
    devBtn.textContent = "DEV MODE";
    devBtn.style.cssText = "position:fixed;bottom:16px;right:16px;padding:6px 14px;background:rgba(40,40,40,0.8);color:#888;border:1px solid #555;border-radius:6px;font-family:monospace;font-size:11px;cursor:pointer;z-index:100;";
    devBtn.addEventListener("click", () => {
      this.devMode = !this.devMode;
      devBtn.textContent = this.devMode ? "DEV MODE: ON" : "DEV MODE";
      devBtn.style.color = this.devMode ? "#ff4" : "#888";
      devBtn.style.borderColor = this.devMode ? "#ff4" : "#555";
      if (this.devMode) {
        for (const t of this.tanks) { if (t.team === "player") t.money = 99999; }
      }
    });
    document.body.appendChild(devBtn);
  }

  private updateHud() {
    const tank = this.tanks[this.currentTankIndex];
    const isMP = this.gameConfig.mode === "multiplayer";
    const isHotseat = this.gameConfig.mode === "hotseat";
    const isLocal = this.isLocalTurn();
    const turn = isMP
      ? (isLocal ? "YOU" : "OPPONENT")
      : isHotseat
        ? (tank.team === "player" ? "PLAYER 1" : "PLAYER 2")
        : (tank.team === "player" ? "PLAYER" : "AI");
    const turnColor = isMP
      ? (isLocal ? "#ea6153" : "#4ea9de")
      : (tank.team === "player" ? "#ea6153" : "#4ea9de");
    const status = this.gameOver
      ? (isMP
        ? (this.winner === this.myTeam ? "🏆 VICTORY!" : "💀 DEFEAT!")
        : isHotseat
          ? (this.winner === "player" ? "🏆 PLAYER 1 WINS!" : "🏆 PLAYER 2 WINS!")
          : (this.winner === "player" ? "🏆 VICTORY!" : "💀 DEFEAT!"))
      : `Turn: <span style="color:${turnColor}">${turn}</span>`;

    const windDir = this.wind > 0.3 ? "→" : this.wind < -0.3 ? "←" : "·";
    const windColor = Math.abs(this.wind) > 3 ? "#ff9944" : "#aaa";

    const weaponName = WEAPONS[tank.selectedWeapon]?.name ?? "Standard";

    const playerHQ = this.buildings.find((b) => b.type === "hq" && b.team === "player");
    const aiHQ = this.buildings.find((b) => b.type === "hq" && b.team === "ai");
    const pHQ = playerHQ ? `${Math.round(playerHQ.health)}/${playerHQ.maxHealth}` : '<span style="color:#f44">DESTROYED</span>';
    const eHQ = aiHQ ? `${Math.round(aiHQ.health)}/${aiHQ.maxHealth}` : '<span style="color:#f44">DESTROYED</span>';

    this.hud.innerHTML = [
      `<b style="font-size:15px;color:#ffd666">ARTILLERY</b> <span style="font-size:11px;color:#886">Round ${this.currentRound}</span>`,
      status,
      `<span style="color:${windColor}">Wind: ${windDir} ${this.wind >= 0 ? "+" : ""}${this.wind.toFixed(2)}</span>`,
      `Fuel: <span style="color:${this.turnFuel < 25 ? "#ff6644" : "#aaa"}">${this.turnFuel.toFixed(0)}</span> | <span style="color:#ffd666">$${tank.money}</span>`,
      `Angle: ${THREE.MathUtils.radToDeg(tank.angle).toFixed(1)}° | Power: ${tank.power.toFixed(1)}`,
      `Weapon: <span style="color:#ffaa44">${weaponName}</span>`,
      `<span style="color:#ea6153">■</span> HQ: ${pHQ} | <span style="color:#4ea9de">■</span> HQ: ${eHQ}`,
      `<span style="font-size:11px;color:#886">←→ turn | ↑↓ move | A/D aim | W/S power | Space fire</span>`,
      `<span style="font-size:11px;color:#886">1-4 weapon | Wheel zoom | LMB orbit | MMB reset</span>`,
    ].join("<br>");

    // Team sidebar
    const tankRows = this.tanks.map((t) => {
      const color = t.team === "player" ? "#ea6153" : "#4ea9de";
      const hp = Math.max(0, Math.round(t.health));
      const barWidth = Math.max(0, Math.min(60, Math.round((hp / 100) * 60)));
      const barColor = hp > 40 ? "#ffd666" : "#f65c42";
      const statusText = t.alive ? `${hp}` : "<s>DEAD</s>";
      const active = this.tanks.indexOf(t) === this.currentTankIndex ? " ◀" : "";
      return `<span style="color:${t.alive ? color : "#555"}">${t.team === "player" ? "P" : "E"}${this.tanks.filter((tt) => tt.team === t.team).indexOf(t) + 1}</span> `
        + `<span style="display:inline-block;width:60px;height:8px;background:#332;border-radius:4px;vertical-align:middle">`
        + `<span style="display:inline-block;width:${barWidth}px;height:8px;background:${t.alive ? barColor : "#333"};border-radius:4px"></span></span>`
        + ` <span style="color:${t.alive ? "#ddd" : "#666"}">${statusText}${active}</span>`;
    });
    this.teamSidebarEl.innerHTML = `<b style="color:#ffd666">TANKS</b><br>` + tankRows.join("<br>");

    // Screen flash overlay
    if (this.screenFlash > 0) {
      this.canvas.style.boxShadow = `inset 0 0 120px rgba(255,240,180,${this.screenFlash})`;
    } else {
      this.canvas.style.boxShadow = "";
    }
  }

  private startTurn() {
    if (!this.tanks[this.currentTankIndex]?.alive) {
      this.advanceTurn();
      return;
    }

    if (this.gameConfig.mode === "multiplayer") {
      // In multiplayer, only the local player generates wind and broadcasts turn info
      if (this.isLocalTurn()) {
        this.wind = THREE.MathUtils.randFloatSpread(WIND_LIMIT * 2);
        this.mpSend({
          type: "game_turn_start",
          tankIndex: this.currentTankIndex,
          wind: this.wind,
        });
      }
      // Remote turns will set wind via the message handler
    } else {
      this.wind = THREE.MathUtils.randFloatSpread(WIND_LIMIT * 2);
    }

    this.shotInFlight = false;
    this.turnFuel = MAX_FUEL;
    this.trackDistAccum = 0;
    this.aiDelay = THREE.MathUtils.randFloat(0.4, 1.2);
    const tank = this.tanks[this.currentTankIndex];

    // Animate camera to the active tank
    if (this.gameConfig.mode === "hotseat" || this.gameConfig.mode === "multiplayer") {
      const pos = tank.mesh.position;
      const targetYaw = tank.heading + Math.PI;
      // Shortest yaw rotation
      let fromYaw = this.cameraOrbit.yaw;
      let delta = targetYaw - fromYaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.cameraTurnTransition = {
        fromX: this.cameraOrbit.targetX,
        fromY: this.cameraOrbit.targetY,
        fromZ: this.cameraOrbit.targetZ,
        fromYaw: fromYaw,
        toX: pos.x,
        toY: pos.y,
        toZ: pos.z,
        toYaw: fromYaw + delta,
        elapsed: 0,
        duration: 1.0,
      };
    }

    // Dev mode: refill money + fuel each turn
    if (this.devMode && tank.team === "player") {
      tank.money = 99999;
    }

    if (this.gameConfig.mode === "multiplayer") {
      const isLocal = this.isLocalTurn();
      const label = isLocal ? "YOUR" : "OPPONENT'S";
      this.turnBanner = {
        text: `${label} Turn`,
        color: `rgba(${isLocal ? "200,80,60" : "60,140,200"}, 0.85)`,
        life: 1.6,
        maxLife: 1.6,
      };
    } else if (this.gameConfig.mode === "hotseat") {
      const label = tank.team === "player" ? "PLAYER 1" : "PLAYER 2";
      const isP1 = tank.team === "player";
      this.turnBanner = {
        text: `${label}'s Turn`,
        color: `rgba(${isP1 ? "200,80,60" : "60,140,200"}, 0.85)`,
        life: 1.6,
        maxLife: 1.6,
      };
    } else {
      const label = tank.team === "player" ? "PLAYER" : "AI";
      this.turnBanner = {
        text: `${label}'s Turn`,
        color: `rgba(${(tank.team === "player") ? "200,80,60" : "60,140,200"}, 0.85)`,
        life: 1.6,
        maxLife: 1.6,
      };
    }
    this.updateHud();
  }

  private advanceTurn() {
    if (this.gameOver) {
      return;
    }
    const count = this.tanks.length;
    for (let offset = 1; offset <= count; offset += 1) {
      const idx = (this.currentTankIndex + offset) % count;
      if (this.tanks[idx].alive) {
        this.currentTankIndex = idx;
        this.startTurn();
        return;
      }
    }
  }

  private fireCurrentTank() {
    if (this.shotInFlight || this.gameOver) return;

    const tank = this.tanks[this.currentTankIndex];
    if (!tank.alive || tank.health <= 0) return;

    // Weapon handling
    const weaponDef = WEAPONS[tank.selectedWeapon] ?? WEAPONS.standard;
    // Consume ammo for purchased weapons
    if (weaponDef.cost > 0) {
      const ammo = tank.inventory.get(tank.selectedWeapon) ?? 0;
      if (ammo <= 0) {
        tank.selectedWeapon = "standard";
        return;
      }
      tank.inventory.set(tank.selectedWeapon, ammo - 1);
    }

    const shotVelocity = this.buildShotVelocity(tank, weaponDef);
    const muzzle = tank.getMuzzleWorldPosition(shotVelocity);
    const vis = this.weaponVisuals[weaponDef.type] ?? this.weaponVisuals.standard;
    const shell = this.bulletTemplate
      ? this.bulletTemplate.clone(true)
      : new THREE.Mesh(
          new THREE.SphereGeometry(0.18, 12, 12),
          new THREE.MeshStandardMaterial({ color: 0xffefc2, emissive: 0x3f2d10 }),
        );
    shell.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        (node.material as THREE.MeshStandardMaterial).color.set(vis.color);
        (node.material as THREE.MeshStandardMaterial).emissive.set(vis.emissive);
        (node.material as THREE.MeshStandardMaterial).emissiveIntensity = vis.emissiveIntensity;
      }
    });
    shell.scale.setScalar(vis.bulletScale);
    shell.position.copy(muzzle);
    this.scene.add(shell);

    this.currentProjectile = {
      owner: tank,
      mesh: shell,
      velocity: shotVelocity,
      weaponType: weaponDef.type,
    };
    this.alignProjectileToVelocity(this.currentProjectile.mesh, this.currentProjectile.velocity);
    this.shotInFlight = true;

    // Muzzle flash
    const flashLight = new THREE.PointLight(new THREE.Color(vis.flashColor), vis.flashIntensity, vis.flashRadius);
    flashLight.position.copy(muzzle);
    this.scene.add(flashLight);
    const flashMesh = new THREE.Mesh(
      this._sharedFlashGeo,
      new THREE.MeshBasicMaterial({ color: vis.flashColor, transparent: true, opacity: 0.9 }),
    );
    flashMesh.position.copy(muzzle);
    this.scene.add(flashMesh);
    this.muzzleFlash = { light: flashLight, mesh: flashMesh, life: 0.15 };
  }

  private buildShotVelocity(tank: Tank, weaponDef?: WeaponDef): THREE.Vector3 {
    const wDef = weaponDef ?? WEAPONS.standard;
    const horizontalMag = tank.power * 0.35 * wDef.powerMultiplier;
    const planar = Math.cos(tank.angle) * horizontalMag;
    const dirX = Math.sin(tank.heading);
    const dirZ = Math.cos(tank.heading);
    const vx = dirX * planar;
    const vz = dirZ * planar;
    const vy = Math.sin(tank.angle) * horizontalMag;
    return new THREE.Vector3(vx, vy, vz);
  }

  private alignProjectileToVelocity(mesh: THREE.Object3D, velocity: THREE.Vector3) {
    const speedSq = velocity.lengthSq();
    if (speedSq < 0.000001) {
      return;
    }
    const direction = velocity.clone().normalize();
    const modelForward = new THREE.Vector3(0, 1, 0);
    mesh.quaternion.setFromUnitVectors(modelForward, direction);
  }

  private explodeAt(position: THREE.Vector3, power: number, weaponType: string = "standard") {
    const wDef = WEAPONS[weaponType] ?? WEAPONS.standard;
    const craterRadius = THREE.MathUtils.clamp(1.2 + power * 0.045, 1.3, 4.4) * wDef.radiusMultiplier;
    this.terrain.carveSphere(position.x, position.y, position.z, craterRadius);
    this.fillCraterWithLava(position.x, position.y, position.z, craterRadius);

    const flash = new THREE.PointLight(0xffb26e, 2.4, 12);
    flash.position.copy(position);
    this.scene.add(flash);
    setTimeout(() => this.scene.remove(flash), 130);

    // Explosion particles (debris + sparks)
    this.spawnExplosionParticles(position, 0xffd480, 16);
    this.spawnExplosionParticles(position, 0x8c6b46, 10);
    this.spawnExplosionParticles(position, 0xff8844, 8);

    // Scorch mark on terrain
    this.addScorchMark(position, craterRadius + 0.4);

    // Fire effect in crater
    this.spawnCraterFire(position, craterRadius);

    // Camera shake (scaled by distance to active tank)
    const activeTank = this.tanks[this.currentTankIndex];
    if (activeTank) {
      const dist = activeTank.mesh.position.distanceTo(position);
      const shakeIntensity = THREE.MathUtils.clamp(2.5 - dist * 0.08, 0.2, 2.5);
      this.triggerCameraShake(shakeIntensity);
    }

    // Cluster bomb: spawn bomblets instead of direct damage
    if (weaponType === "cluster") {
      this.spawnClusterBomblets(position, power);
    }

    // Napalm: spawn lava in the crater
    if (weaponType === "napalm") {
      this.spawnNapalmLava(position, 12);
    }

    // Destroy nearby props
    this.checkPropsAfterExplosion(position, craterRadius);
    // Check if terrain crumbled under any props
    this.checkPropsOnCrumbledTerrain();

    // Damage nearby buildings
    this.damageBuildings(position, power, weaponType);

    // Screen flash for big hits
    if (craterRadius > 2.5) {
      this.screenFlash = 0.4;
    }

    const baseDamage = 90 * wDef.damageMultiplier;
    for (const tank of this.tanks) {
      if (!tank.alive) continue;
      const distance = tank.mesh.position.distanceTo(position);
      if (distance < 5.2) {
        const proximity = 1 - distance / 5.2;
        let damage = Math.max(0, proximity) * baseDamage;

        // Shield absorption
        if (tank.hasShield && damage > 0) {
          damage *= 0.6; // absorb 40%
          this.removeShieldFromTank(tank);
        }

        tank.health -= damage;

        // Floating damage number
        if (damage > 1) {
          this.spawnDamageSprite(
            tank.mesh.position.clone().add(new THREE.Vector3(
              THREE.MathUtils.randFloatSpread(0.5), 1.5, THREE.MathUtils.randFloatSpread(0.5),
            )),
            Math.round(damage),
            damage >= 30 ? 0xff4444 : 0xffeedd,
          );
        }
      }
      if (tank.health <= 0 && tank.alive) {
        this.destroyTank(tank, position);
      }
    }

    this.checkWinCondition();
  }

  private spawnExplosionParticles(position: THREE.Vector3, color: number, count: number) {
    for (let i = 0; i < count; i++) {
      const size = 0.05 + Math.random() * 0.1;
      const piece = new THREE.Mesh(
        this._sharedParticleGeo,
        new THREE.MeshStandardMaterial({ color, roughness: 0.8, emissive: color, emissiveIntensity: 0.3 }),
      );
      piece.scale.setScalar(size);
      piece.position.copy(position).add(new THREE.Vector3(
        THREE.MathUtils.randFloatSpread(0.5),
        THREE.MathUtils.randFloat(0, 0.3),
        THREE.MathUtils.randFloatSpread(0.5),
      ));
      piece.castShadow = true;
      const velocity = new THREE.Vector3(
        THREE.MathUtils.randFloatSpread(8),
        THREE.MathUtils.randFloat(3, 9),
        THREE.MathUtils.randFloatSpread(8),
      );
      const life = THREE.MathUtils.randFloat(0.4, 1.0);
      this.scene.add(piece);
      this.explosionParticles.push({ mesh: piece, velocity, life, maxLife: life });
    }
  }

  private addScorchMark(position: THREE.Vector3, radius: number) {
    const scorchMesh = new THREE.Mesh(this._sharedScorchGeo, this._sharedScorchMat);
    scorchMesh.scale.setScalar(radius);
    const terrainY = this.sampleTerrainHeightAtWorld(position.x, position.z);
    scorchMesh.position.set(position.x, terrainY + 0.02, position.z);
    scorchMesh.rotation.x = -Math.PI / 2;
    this.scene.add(scorchMesh);
    this.scorchMarks.push(scorchMesh);
  }

  private spawnDamageSprite(position: THREE.Vector3, damage: number, color: number) {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.font = "bold 42px monospace";
    ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 4;
    ctx.textAlign = "center";
    ctx.strokeText(`-${damage}`, 64, 44);
    ctx.fillText(`-${damage}`, 64, 44);
    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.6, 0.8, 1);
    sprite.position.copy(position);
    this.scene.add(sprite);
    this.damageSprites.push({
      sprite,
      velocity: new THREE.Vector3(THREE.MathUtils.randFloatSpread(0.3), 2.2, THREE.MathUtils.randFloatSpread(0.3)),
      life: 1.2,
      maxLife: 1.2,
    });
  }

  private destroyTank(tank: Tank, epicenter: THREE.Vector3) {
    tank.alive = false;
    tank.health = 0;
    tank.mesh.visible = false;

    // Spawn persistent wreckage
    this.spawnWreckage(tank);

    // Award kill money to the opposing team
    const killerTeam = tank.team === "player" ? "ai" : "player";
    for (const t of this.tanks) {
      if (t.team === killerTeam && t.alive) {
        t.money += ROUND_KILL_MONEY;
      }
    }

    const base = tank.mesh.position.clone().lerp(epicenter, 0.35);
    const deathFlash = new THREE.PointLight(0xff8a4c, 4.8, 18);
    deathFlash.position.copy(base);
    this.scene.add(deathFlash);
    setTimeout(() => this.scene.remove(deathFlash), 280);

    // Big debris shower
    const burstCount = 36;
    for (let i = 0; i < burstCount; i += 1) {
      const isSpark = Math.random() < 0.4;
      const size = isSpark ? 0.05 : 0.08 + Math.random() * 0.12;
      const piece = new THREE.Mesh(
        this._sharedParticleGeo8,
        new THREE.MeshStandardMaterial({
          color: isSpark ? 0xffdd66 : (Math.random() < 0.5 ? 0xff9b5e : 0x3d3d3d),
          roughness: 0.9,
          emissive: isSpark ? 0xffaa22 : 0x000000,
          emissiveIntensity: isSpark ? 0.8 : 0,
        }),
      );
      piece.scale.setScalar(size);
      piece.position.copy(base);
      piece.castShadow = true;
      const velocity = new THREE.Vector3(
        THREE.MathUtils.randFloatSpread(12),
        THREE.MathUtils.randFloat(5, 14),
        THREE.MathUtils.randFloatSpread(12),
      );
      const life = THREE.MathUtils.randFloat(0.8, 1.6);
      this.scene.add(piece);
      this.deathParticles.push({ mesh: piece, velocity, life, maxLife: life });
    }

    // Extra explosion particles
    this.spawnExplosionParticles(base, 0xff6633, 20);
    this.spawnExplosionParticles(base, 0xffcc44, 14);
    this.screenFlash = 0.65;

    // "DESTROYED" text
    this.spawnTextSprite(
      base.clone().add(new THREE.Vector3(0, 2.5, 0)),
      "DESTROYED",
      0xff3333,
    );
  }

  private spawnTextSprite(position: THREE.Vector3, text: string, color: number) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.font = "bold 36px monospace";
    ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 4;
    ctx.textAlign = "center";
    ctx.strokeText(text, 128, 44);
    ctx.fillText(text, 128, 44);
    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(3.2, 0.8, 1);
    sprite.position.copy(position);
    this.scene.add(sprite);
    this.damageSprites.push({
      sprite,
      velocity: new THREE.Vector3(0, 1.8, 0),
      life: 2.0,
      maxLife: 2.0,
    });
  }

  private checkWinCondition() {
    if (this.gameOver) {
      return;
    }

    // Check HQ destruction — this is the ultimate win condition
    // Skip until buildings have been spawned (async loading)
    if (this.buildingsReady) {
      const playerHQ = this.buildings.find((b) => b.type === "hq" && b.team === "player");
      const aiHQ = this.buildings.find((b) => b.type === "hq" && b.team === "ai");
      const playerHQDestroyed = !playerHQ; // Not in array = destroyed
      const aiHQDestroyed = !aiHQ;

      if (playerHQDestroyed || aiHQDestroyed) {
        this.shotInFlight = false;
        if (this.currentProjectile) {
          this.scene.remove(this.currentProjectile.mesh);
          this.currentProjectile = null;
        }
        this.gameOver = true;
        this.winner = aiHQDestroyed ? "player" : "ai";
        const winLabel = this.gameConfig.mode === "hotseat"
          ? (aiHQDestroyed ? "PLAYER 1 WINS — ENEMY HQ DESTROYED!" : "PLAYER 2 WINS — PLAYER 1 HQ DESTROYED!")
          : (aiHQDestroyed ? "VICTORY — ENEMY HQ DESTROYED!" : "DEFEAT — YOUR HQ IS DESTROYED!");
        this.turnBanner = {
          text: winLabel,
          color: aiHQDestroyed ? "rgba(100,200,60,0.9)" : "rgba(220,60,60,0.9)",
          life: 5,
          maxLife: 5,
        };
        return;
      }
    }

    const playerAlive = this.tanks.some((tank) => tank.team === "player" && tank.alive);
    const aiAlive = this.tanks.some((tank) => tank.team === "ai" && tank.alive);
    if (!playerAlive || !aiAlive) {
      this.shotInFlight = false;
      if (this.currentProjectile) {
        this.scene.remove(this.currentProjectile.mesh);
        this.currentProjectile = null;
      }

      if (playerAlive && (this.gameConfig.mode === "singleplayer" || this.gameConfig.mode === "hotseat")) {
        // Player won this round, advance to next
        for (const t of this.tanks) {
          if (t.team === "player" && t.alive) {
            t.money += ROUND_WIN_MONEY;
          }
        }
        this.turnBanner = {
          text: `ROUND ${this.currentRound} CLEAR!`,
          color: "rgba(100,200,60,0.85)",
          life: 2.5,
          maxLife: 2.5,
        };
        // Delay then start next round
        setTimeout(() => void this.startNextRound(), 3000);
        this.gameOver = true; // Temporarily block input
        this.winner = "player";
      } else {
        this.gameOver = true;
        this.winner = playerAlive ? "player" : "ai";
      }
    }
  }

  private updateDeathParticles(dt: number) {
    for (let i = this.deathParticles.length - 1; i >= 0; i -= 1) {
      const p = this.deathParticles[i];
      p.life -= dt;
      p.velocity.y -= GRAVITY * 0.7 * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.mesh.rotation.x += dt * 6;
      p.mesh.rotation.y += dt * 4;
      p.mesh.rotation.z += dt * 5;

      const alpha = Math.max(0, p.life / p.maxLife);
      const mat = p.mesh.material as THREE.MeshStandardMaterial;
      mat.transparent = true;
      mat.opacity = alpha;

      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        mat.dispose();
        this.deathParticles.splice(i, 1);
      }
    }
  }

  private stabilizeTanksOnTerrain(dt: number) {
    const settleSpeed = Math.min(1, dt * 10);
    for (const tank of this.tanks) {
      if (!tank.alive || !tank.mesh.visible) {
        continue;
      }
      const groundY = this.sampleTerrainHeightAtWorld(tank.mesh.position.x, tank.mesh.position.z);
      const targetY = groundY + TANK_GROUND_CLEARANCE;
      if (tank.mesh.position.y < targetY) {
        tank.mesh.position.y = targetY;
      } else {
        tank.mesh.position.y += (targetY - tank.mesh.position.y) * settleSpeed;
      }
    }
  }

  private updateProjectile(dt: number) {
    if (!this.currentProjectile) return;

    const p = this.currentProjectile;
    p.velocity.y -= GRAVITY * dt;
    p.velocity.x += this.wind * dt;
    p.mesh.position.addScaledVector(p.velocity, dt);
    this.alignProjectileToVelocity(p.mesh, p.velocity);

    // Smoke trail behind projectile
    if (Math.random() < 0.6) {
      this.spawnTrailPuff(p.mesh.position.clone(), p.weaponType);
    }

    const worldPos = p.mesh.position;
    const terrainY = this.sampleTerrainHeightAtWorld(worldPos.x, worldPos.z);

    const outside = Math.abs(worldPos.x) > PROJECTILE_BOUNDS || Math.abs(worldPos.z) > PROJECTILE_BOUNDS || worldPos.y < -6;
    if (outside) {
      this.scene.remove(p.mesh);
      this.currentProjectile = null;
      this.advanceTurn();
      return;
    }

    if (worldPos.y <= terrainY + 0.2) {
      this.explodeAt(worldPos, p.owner.power, p.weaponType);
      this.scene.remove(p.mesh);
      this.currentProjectile = null;
      this.advanceTurn();
    }
  }

  private sampleTerrainHeightAtWorld(worldX: number, worldZ: number): number {
    const halfW = WORLD_SIZE * VOXEL_SIZE * 0.5;
    const halfD = WORLD_SIZE * VOXEL_SIZE * 0.5;
    const gx = (worldX + halfW - VOXEL_SIZE * 0.5) / VOXEL_SIZE;
    const gz = (worldZ + halfD - VOXEL_SIZE * 0.5) / VOXEL_SIZE;
    return this.terrain.getHeight(gx, gz) * VOXEL_SIZE;
  }

  private moveTankForward(tank: Tank, direction: number, dt: number) {
    if ((!this.devMode && this.turnFuel <= 0) || !tank.alive) {
      return;
    }

    const maxDistanceByFuel = this.devMode ? 9999 : this.turnFuel / FUEL_BURN_PER_UNIT;
    const desiredDistance = Math.min(TANK_MOVE_SPEED * dt, maxDistanceByFuel);
    if (desiredDistance <= 0.0001) {
      return;
    }

    const signedDistance = desiredDistance * Math.sign(direction);
    const dirX = Math.sin(tank.heading);
    const dirZ = Math.cos(tank.heading);
    const stepX = dirX * signedDistance;
    const stepZ = dirZ * signedDistance;
    const halfW = WORLD_SIZE * VOXEL_SIZE * 0.5;
    const halfD = WORLD_SIZE * VOXEL_SIZE * 0.5;
    const margin = 0.8;
    const candidateX = THREE.MathUtils.clamp(tank.mesh.position.x + stepX, -halfW + margin, halfW - margin);
    const candidateZ = THREE.MathUtils.clamp(tank.mesh.position.z + stepZ, -halfD + margin, halfD - margin);
    const currentGround = this.sampleTerrainHeightAtWorld(tank.mesh.position.x, tank.mesh.position.z);
    const targetGround = this.sampleTerrainHeightAtWorld(candidateX, candidateZ);

    if (targetGround - currentGround > MAX_CLIMB_STEP) {
      return;
    }

    const moved = Math.hypot(candidateX - tank.mesh.position.x, candidateZ - tank.mesh.position.z);
    if (moved <= 0.0001) {
      return;
    }

    tank.mesh.position.x = candidateX;
    tank.mesh.position.z = candidateZ;
    if (!this.devMode) this.turnFuel = Math.max(0, this.turnFuel - moved * FUEL_BURN_PER_UNIT);

    // --- Tank tracks ---
    this.trackDistAccum += moved;
    if (this.trackDistAccum >= this.TRACK_SPACING) {
      this.trackDistAccum -= this.TRACK_SPACING;
      const terrainY = this.sampleTerrainHeightAtWorld(candidateX, candidateZ);
      const perpX = Math.cos(tank.heading);
      const perpZ = -Math.sin(tank.heading);
      const treadOffset = 0.41;
      for (const side of [-1, 1]) {
        const tMesh = new THREE.Mesh(this._sharedTrackGeo, this._sharedTrackMat.clone());
        tMesh.rotation.x = -Math.PI / 2;
        tMesh.rotation.z = -tank.heading;
        tMesh.position.set(
          candidateX + perpX * treadOffset * side,
          terrainY + 0.015,
          candidateZ + perpZ * treadOffset * side,
        );
        this.scene.add(tMesh);
        this.tankTracks.push({ mesh: tMesh, life: 20 });
      }
    }

    // --- Exhaust smoke ---
    const backX = -Math.sin(tank.heading) * 1.0;
    const backZ = -Math.cos(tank.heading) * 1.0;
    const exhaustY = this.sampleTerrainHeightAtWorld(candidateX, candidateZ) + 0.5;
    for (let s = 0; s < 2; s++) {
      const size = THREE.MathUtils.randFloat(0.08, 0.18);
      const puff = new THREE.Mesh(
        this._sharedParticleGeo,
        this._sharedExhaustMat.clone(),
      );
      puff.scale.setScalar(size);
      puff.position.set(
        candidateX + backX + THREE.MathUtils.randFloatSpread(0.3),
        exhaustY + THREE.MathUtils.randFloat(0, 0.15),
        candidateZ + backZ + THREE.MathUtils.randFloatSpread(0.3),
      );
      const vel = new THREE.Vector3(
        THREE.MathUtils.randFloatSpread(0.5),
        THREE.MathUtils.randFloat(0.6, 1.4),
        THREE.MathUtils.randFloatSpread(0.5),
      );
      const life = THREE.MathUtils.randFloat(0.5, 1.0);
      this.scene.add(puff);
      this.smokeParticles.push({ mesh: puff, velocity: vel, life, maxLife: life, initialSize: size });
    }
  }

  private updatePlayerInput(dt: number) {
    const tank = this.tanks[this.currentTankIndex];
    if (this.gameOver || this.shotInFlight || !tank.alive) return;

    // In multiplayer: only control your own tanks
    if (this.gameConfig.mode === "multiplayer") {
      if (!this.isLocalTurn()) return;
    } else if (this.gameConfig.mode === "hotseat") {
      // All tanks controlled locally
    } else {
      if (tank.team !== "player") return;
    }

    let moved = false;
    let aimed = false;

    if (this.keys.has("ArrowLeft")) {
      tank.heading += 2.2 * dt;
      moved = true;
    }
    if (this.keys.has("ArrowRight")) {
      tank.heading -= 2.2 * dt;
      moved = true;
    }
    tank.mesh.rotation.y = tank.heading;

    if (this.keys.has("ArrowUp")) {
      this.moveTankForward(tank, 1, dt);
      moved = true;
    }
    if (this.keys.has("ArrowDown")) {
      this.moveTankForward(tank, -1, dt);
      moved = true;
    }

    if (this.keys.has("KeyA")) {
      tank.angle += dt * 1.25;
      aimed = true;
    }
    if (this.keys.has("KeyD")) {
      tank.angle -= dt * 1.25;
      aimed = true;
    }
    if (this.keys.has("KeyW")) {
      tank.power = Math.min(MAX_POWER, tank.power + dt * 24);
      aimed = true;
    }
    if (this.keys.has("KeyS")) {
      tank.power = Math.max(MIN_POWER, tank.power - dt * 24);
      aimed = true;
    }

    tank.angle = THREE.MathUtils.clamp(tank.angle, THREE.MathUtils.degToRad(12), THREE.MathUtils.degToRad(86));
    tank.setAimPitch(tank.angle);

    // Sync to opponent in multiplayer
    if (this.gameConfig.mode === "multiplayer") {
      if (moved) {
        this.mpSend({
          type: "game_move",
          tankIndex: this.currentTankIndex,
          x: tank.mesh.position.x,
          y: tank.mesh.position.y,
          z: tank.mesh.position.z,
          heading: tank.heading,
          fuel: this.turnFuel,
        });
      }
      if (aimed) {
        this.mpSend({
          type: "game_aim",
          tankIndex: this.currentTankIndex,
          angle: tank.angle,
          power: tank.power,
          heading: tank.heading,
        });
      }
    }
  }

  private updateAiTurn(dt: number) {
    // In multiplayer or hotseat, there's no AI
    if (this.gameConfig.mode === "multiplayer" || this.gameConfig.mode === "hotseat") return;

    const ai = this.tanks[this.currentTankIndex];
    if (this.gameOver || ai.team !== "ai" || this.shotInFlight || !ai.alive) return;

    this.aiDelay -= dt;
    if (this.aiDelay > 0) return;

    const playerTargets = this.tanks.filter((tank) => tank.team === "player" && tank.alive);
    if (playerTargets.length === 0) {
      this.checkWinCondition();
      return;
    }
    // Pick weakest enemy, prefer closer as tiebreaker
    const target = playerTargets.reduce((best, candidate) => {
      if (candidate.health < best.health) return candidate;
      if (candidate.health === best.health) {
        const dBest = best.mesh.position.distanceTo(ai.mesh.position);
        const dCandidate = candidate.mesh.position.distanceTo(ai.mesh.position);
        return dCandidate < dBest ? candidate : best;
      }
      return best;
    }, playerTargets[0]);

    // Face toward target
    const toTarget = target.mesh.position.clone().sub(ai.mesh.position);
    ai.heading = Math.atan2(toTarget.x, toTarget.z);
    ai.mesh.rotation.y = ai.heading;

    // Simulation-based ballistic solver
    const targetPos = target.mesh.position;
    let bestAngle = Math.PI / 4;
    let bestPower = 40;
    let bestError = Infinity;

    // Coarse grid search
    for (let angleDeg = 18; angleDeg <= 78; angleDeg += 3) {
      for (let power = MIN_POWER; power <= MAX_POWER; power += 3) {
        const landPos = this.simulateLanding(ai, THREE.MathUtils.degToRad(angleDeg), power);
        if (!landPos) continue;
        const err = landPos.distanceTo(targetPos);
        if (err < bestError) {
          bestError = err;
          bestAngle = THREE.MathUtils.degToRad(angleDeg);
          bestPower = power;
        }
      }
    }

    // Fine refinement
    const fineAngleMin = THREE.MathUtils.radToDeg(bestAngle) - 4;
    const fineAngleMax = THREE.MathUtils.radToDeg(bestAngle) + 4;
    const finePowerMin = Math.max(MIN_POWER, bestPower - 5);
    const finePowerMax = Math.min(MAX_POWER, bestPower + 5);
    for (let angleDeg = fineAngleMin; angleDeg <= fineAngleMax; angleDeg += 1) {
      for (let power = finePowerMin; power <= finePowerMax; power += 1) {
        const landPos = this.simulateLanding(ai, THREE.MathUtils.degToRad(angleDeg), power);
        if (!landPos) continue;
        const err = landPos.distanceTo(targetPos);
        if (err < bestError) {
          bestError = err;
          bestAngle = THREE.MathUtils.degToRad(angleDeg);
          bestPower = power;
        }
      }
    }

    // Human-like scatter (not pixel-perfect)
    ai.angle = THREE.MathUtils.clamp(
      bestAngle + THREE.MathUtils.randFloatSpread(0.06),
      THREE.MathUtils.degToRad(12),
      THREE.MathUtils.degToRad(86),
    );
    ai.power = THREE.MathUtils.clamp(
      bestPower + THREE.MathUtils.randInt(-2, 2),
      MIN_POWER,
      MAX_POWER,
    );
    ai.setAimPitch(ai.angle);

    this.fireCurrentTank();
  }

  private simulateLanding(tank: Tank, angle: number, power: number): THREE.Vector3 | null {
    const origAngle = tank.angle;
    const origPower = tank.power;
    tank.angle = angle;
    tank.power = power;
    const velocity = this.buildShotVelocity(tank);
    const position = tank.getMuzzleWorldPosition(velocity);
    tank.angle = origAngle;
    tank.power = origPower;

    const simVel = velocity.clone();
    const simPos = position.clone();
    const step = 0.03;
    for (let i = 0; i < 500; i++) {
      simVel.y -= GRAVITY * step;
      simVel.x += this.wind * step;
      simPos.addScaledVector(simVel, step);

      if (Math.abs(simPos.x) > PROJECTILE_BOUNDS || Math.abs(simPos.z) > PROJECTILE_BOUNDS || simPos.y < -6) {
        return null;
      }

      const terrainY = this.sampleTerrainHeightAtWorld(simPos.x, simPos.z);
      if (simPos.y <= terrainY + 0.2) {
        return simPos.clone();
      }
    }
    return null;
  }

  private updateTrajectoryGuide() {
    if (this.shotInFlight) {
      this.trajectoryLine.visible = false;
      this.hideImpactMarker();
      return;
    }

    const tank = this.tanks[this.currentTankIndex];
    // Only show trajectory for local player's turn
    const canShowTrajectory = this.gameConfig.mode === "hotseat"
      ? true
      : this.gameConfig.mode === "multiplayer"
        ? this.isLocalTurn()
        : tank?.team === "player";
    if (!tank || !tank.alive || !canShowTrajectory) {
      this.trajectoryLine.visible = false;
      this.hideImpactMarker();
      return;
    }

    const points: THREE.Vector3[] = [];
    const weaponDef = WEAPONS[tank.selectedWeapon] ?? WEAPONS.standard;
    const velocity = this.buildShotVelocity(tank, weaponDef);
    const position = tank.getMuzzleWorldPosition(velocity);
    points.push(position.clone());

    const simVel = velocity.clone();
    const simPos = position.clone();
    const step = 0.06;
    let impactPos: THREE.Vector3 | null = null;
    for (let i = 0; i < 70; i += 1) {
      simVel.y -= GRAVITY * step;
      simVel.x += this.wind * step;
      simPos.addScaledVector(simVel, step);
      points.push(simPos.clone());

      const outside = Math.abs(simPos.x) > PROJECTILE_BOUNDS || Math.abs(simPos.z) > PROJECTILE_BOUNDS || simPos.y < -6;
      if (outside) {
        break;
      }

      // Check building collisions
      let hitBuilding = false;
      for (const b of this.buildings) {
        const bPos = b.mesh.position;
        const isHQ = b.type === "hq";
        const halfW = isHQ ? 1.75 : 0.5;
        const halfD = isHQ ? 1.4 : 0.4;
        const height = isHQ ? 2.0 : 0.8;
        if (
          simPos.x > bPos.x - halfW && simPos.x < bPos.x + halfW &&
          simPos.z > bPos.z - halfD && simPos.z < bPos.z + halfD &&
          simPos.y > bPos.y && simPos.y < bPos.y + height
        ) {
          impactPos = simPos.clone();
          hitBuilding = true;
          break;
        }
      }
      if (hitBuilding) break;

      const terrainY = this.sampleTerrainHeightAtWorld(simPos.x, simPos.z);
      if (simPos.y <= terrainY + 0.2) {
        impactPos = simPos.clone();
        impactPos.y = terrainY + 0.15;
        break;
      }
    }

    this.trajectoryLine.geometry.dispose();
    const trajGeo = new THREE.BufferGeometry();
    const flatArr = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      flatArr[i * 3] = points[i].x;
      flatArr[i * 3 + 1] = points[i].y;
      flatArr[i * 3 + 2] = points[i].z;
    }
    trajGeo.setAttribute("position", new THREE.BufferAttribute(flatArr, 3));
    this.trajectoryLine.geometry = trajGeo;
    this.trajectoryLine.computeLineDistances();
    this.trajectoryLine.visible = true;

    // Animate dash offset toward target
    const mat = this.trajectoryLine.material as THREE.LineDashedMaterial;
    // Color by weapon type
    const weaponColors: Record<string, number> = {
      standard: 0xfff2a1, light: 0xaaddff, cluster: 0xffaa33, napalm: 0xff4400,
    };
    mat.color.setHex(weaponColors[tank.selectedWeapon] ?? 0xfff2a1);
    mat.dashOffset -= 0.04;
    if (mat.dashOffset < -100) mat.dashOffset = 0;

    // Impact marker
    if (impactPos) {
      this.showImpactMarker(impactPos);
    } else {
      this.hideImpactMarker();
    }
  }

  private showImpactMarker(position: THREE.Vector3) {
    if (!this.impactMarker) {
      const geo = new THREE.SphereGeometry(0.15, 8, 8);
      const mat = new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.7 });
      this.impactMarker = new THREE.Mesh(geo, mat);
      this.scene.add(this.impactMarker);
    }
    if (!this.impactRing) {
      const ringGeo = new THREE.RingGeometry(0.8, 1.0, 24);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
      this.impactRing = new THREE.Mesh(ringGeo, ringMat);
      this.impactRing.rotation.x = -Math.PI / 2;
      this.scene.add(this.impactRing);
    }
    this.impactMarker.position.copy(position);
    this.impactMarker.visible = true;
    this.impactRing.position.set(position.x, position.y + 0.03, position.z);
    this.impactRing.visible = true;
  }

  private hideImpactMarker() {
    if (this.impactMarker) this.impactMarker.visible = false;
    if (this.impactRing) this.impactRing.visible = false;
  }

  private updateCamera(dt: number) {
    // Animated turn transition
    if (this.cameraTurnTransition) {
      const tr = this.cameraTurnTransition;
      tr.elapsed += dt;
      const raw = Math.min(tr.elapsed / tr.duration, 1);
      // Ease in-out cubic
      const t = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      this.cameraOrbit.targetX = tr.fromX + (tr.toX - tr.fromX) * t;
      this.cameraOrbit.targetY = tr.fromY + (tr.toY - tr.fromY) * t;
      this.cameraOrbit.targetZ = tr.fromZ + (tr.toZ - tr.fromZ) * t;
      this.cameraOrbit.yaw = tr.fromYaw + (tr.toYaw - tr.fromYaw) * t;
      if (raw >= 1) this.cameraTurnTransition = null;
      this.applyCameraOrbit();
      return;
    }

    const focus = this.currentProjectile ? this.currentProjectile.mesh.position : this.tanks[this.currentTankIndex].mesh.position;
    if (!this.cameraOrbit.isDragging) {
      const lerp = Math.min(1, dt * 2.2);
      this.cameraOrbit.targetX += (focus.x - this.cameraOrbit.targetX) * lerp;
      this.cameraOrbit.targetY += (focus.y - this.cameraOrbit.targetY) * lerp;
      this.cameraOrbit.targetZ += (focus.z - this.cameraOrbit.targetZ) * lerp;
    }
    this.applyCameraOrbit();
  }

  // ---- Lava River System ----

  private createLavaRiver() {
    const halfW = WORLD_SIZE / 2;
    const riverWidth = 4;
    // Central river running along z-axis (x ~ center)
    for (let z = 0; z < WORLD_SIZE; z++) {
      const centerX = halfW + Math.sin(z * 0.048) * 7; // gentle curve
      for (let dx = -riverWidth; dx <= riverWidth; dx++) {
        const x = Math.round(centerX + dx);
        if (x >= 0 && x < WORLD_SIZE) {
          // Carve river channel below terrain
          const idx = z * WORLD_SIZE + x;
          this.terrain.heights[idx] = Math.max(1, this.terrain.heights[idx] - 5);
          this.lavaVoxels.add(idx);
        }
      }
    }
    this.terrain["rebuildMesh"]();
    this.rebuildLavaMesh();
  }

  private rebuildLavaMesh() {
    if (this.lavaMesh) {
      this.scene.remove(this.lavaMesh);
      this.lavaMesh.geometry.dispose();
    }
    const count = this.lavaVoxels.size;
    if (count === 0) return;

    const box = new THREE.BoxGeometry(VOXEL_SIZE, VOXEL_SIZE * 0.3, VOXEL_SIZE);
    const lavaMat = new THREE.MeshStandardMaterial({
      color: 0xff4400,
      emissive: 0xff2200,
      emissiveIntensity: 0.8,
      roughness: 0.3,
      metalness: 0.1,
    });
    this.lavaMesh = new THREE.InstancedMesh(box, lavaMat, count);
    this.lavaMesh.receiveShadow = false;
    this.lavaMesh.castShadow = false;

    const tempMatrix = new THREE.Matrix4();
    let i = 0;
    for (const idx of this.lavaVoxels) {
      const x = idx % WORLD_SIZE;
      const z = Math.floor(idx / WORLD_SIZE);
      const h = this.terrain.heights[idx];
      const pos = this.terrain.worldPosition(x, h, z);
      tempMatrix.makeTranslation(pos.x, pos.y + VOXEL_SIZE * 0.15, pos.z);
      this.lavaMesh.setMatrixAt(i, tempMatrix);
      i++;
    }
    this.lavaMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.lavaMesh);
  }

  private fillCraterWithLava(wx: number, _wy: number, wz: number, radius: number) {
    const halfW = WORLD_SIZE * VOXEL_SIZE * 0.5;
    const cx = Math.round((wx + halfW - VOXEL_SIZE * 0.5) / VOXEL_SIZE);
    const cz = Math.round((wz + halfW - VOXEL_SIZE * 0.5) / VOXEL_SIZE);
    const rv = Math.max(2, Math.round(radius / VOXEL_SIZE)) + 1;
    const scanR = rv + 2;

    // Find the surface level of nearby lava (liquid fills to this height)
    let surfaceLevel = -1;
    for (let dz = -scanR; dz <= scanR; dz++) {
      for (let dx = -scanR; dx <= scanR; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x < 0 || x >= WORLD_SIZE || z < 0 || z >= WORLD_SIZE) continue;
        const idx = z * WORLD_SIZE + x;
        if (this.lavaVoxels.has(idx)) {
          surfaceLevel = Math.max(surfaceLevel, this.terrain.heights[idx]);
        }
      }
    }
    if (surfaceLevel < 0) return; // no lava nearby

    // Seed: cells in crater area adjacent to existing lava & below surface
    const queue: number[] = [];
    const added = new Set<number>();
    const fillR = rv + 1;
    for (let dz = -fillR; dz <= fillR; dz++) {
      for (let dx = -fillR; dx <= fillR; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x < 0 || x >= WORLD_SIZE || z < 0 || z >= WORLD_SIZE) continue;
        const idx = z * WORLD_SIZE + x;
        if (this.lavaVoxels.has(idx)) continue;
        if (this.terrain.heights[idx] > surfaceLevel) continue;
        for (const [ddx, ddz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + ddx, nz = z + ddz;
          if (nx < 0 || nx >= WORLD_SIZE || nz < 0 || nz >= WORLD_SIZE) continue;
          if (this.lavaVoxels.has(nz * WORLD_SIZE + nx)) {
            queue.push(idx);
            added.add(idx);
            break;
          }
        }
      }
    }

    // BFS: flood connected cells at or below surface level, bounded to crater
    while (queue.length > 0) {
      const idx = queue.shift()!;
      const x = idx % WORLD_SIZE;
      const z = Math.floor(idx / WORLD_SIZE);
      for (const [ddx, ddz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + ddx, nz = z + ddz;
        if (nx < 0 || nx >= WORLD_SIZE || nz < 0 || nz >= WORLD_SIZE) continue;
        if (Math.abs(nx - cx) > fillR || Math.abs(nz - cz) > fillR) continue;
        const nIdx = nz * WORLD_SIZE + nx;
        if (added.has(nIdx) || this.lavaVoxels.has(nIdx)) continue;
        if (this.terrain.heights[nIdx] <= surfaceLevel) {
          queue.push(nIdx);
          added.add(nIdx);
        }
      }
    }

    if (added.size > 0) {
      for (const idx of added) this.lavaVoxels.add(idx);
      this.rebuildLavaMesh();
    }
  }

  private updateLavaFlow(dt: number) {
    this.lavaFlowTimer += dt;
    if (this.lavaFlowTimer < this.LAVA_FLOW_INTERVAL) return;
    this.lavaFlowTimer = 0;

    const newLava = new Set<number>();
    for (const idx of this.lavaVoxels) {
      const x = idx % WORLD_SIZE;
      const z = Math.floor(idx / WORLD_SIZE);
      const h = this.terrain.heights[idx];
      const neighbors = [
        { nx: x - 1, nz: z },
        { nx: x + 1, nz: z },
        { nx: x, nz: z - 1 },
        { nx: x, nz: z + 1 },
      ];
      for (const { nx, nz } of neighbors) {
        if (nx < 0 || nx >= WORLD_SIZE || nz < 0 || nz >= WORLD_SIZE) continue;
        const nIdx = nz * WORLD_SIZE + nx;
        if (this.lavaVoxels.has(nIdx) || newLava.has(nIdx)) continue;
        const nh = this.terrain.heights[nIdx];
        // Only flow strictly downhill (gravity)
        if (nh < h) {
          newLava.add(nIdx);
        }
      }
    }

    if (newLava.size > 0) {
      for (const idx of newLava) {
        this.lavaVoxels.add(idx);
      }
      this.rebuildLavaMesh();
    }
  }

  private updateLavaDamage(dt: number) {
    for (const tank of this.tanks) {
      if (!tank.alive) continue;
      const halfW = WORLD_SIZE * VOXEL_SIZE * 0.5;
      const gx = Math.round((tank.mesh.position.x + halfW - VOXEL_SIZE * 0.5) / VOXEL_SIZE);
      const gz = Math.round((tank.mesh.position.z + halfW - VOXEL_SIZE * 0.5) / VOXEL_SIZE);
      const idx = gz * WORLD_SIZE + gx;
      if (this.lavaVoxels.has(idx)) {
        const timer = (this.lavaDamageTimer.get(tank) ?? 0) + dt;
        if (timer >= 0.5) {
          const damage = LAVA_DAMAGE_PER_SEC * 0.5;
          tank.health -= damage;
          this.spawnDamageSprite(
            tank.mesh.position.clone().add(new THREE.Vector3(0, 1.5, 0)),
            Math.round(damage),
            0xff6600,
          );
          if (tank.health <= 0 && tank.alive) {
            this.destroyTank(tank, tank.mesh.position);
            this.checkWinCondition();
          }
          this.lavaDamageTimer.set(tank, 0);
        } else {
          this.lavaDamageTimer.set(tank, timer);
        }
      } else {
        this.lavaDamageTimer.set(tank, 0);
      }
    }
  }

  // ---- Napalm Lava Spawning ----

  private spawnNapalmLava(position: THREE.Vector3, count: number) {
    const halfW = WORLD_SIZE * VOXEL_SIZE * 0.5;
    for (let i = 0; i < count; i++) {
      const wx = position.x + THREE.MathUtils.randFloatSpread(4);
      const wz = position.z + THREE.MathUtils.randFloatSpread(4);
      const gx = Math.round((wx + halfW - VOXEL_SIZE * 0.5) / VOXEL_SIZE);
      const gz = Math.round((wz + halfW - VOXEL_SIZE * 0.5) / VOXEL_SIZE);
      if (gx >= 0 && gx < WORLD_SIZE && gz >= 0 && gz < WORLD_SIZE) {
        const idx = gz * WORLD_SIZE + gx;
        this.lavaVoxels.add(idx);
      }
    }
    this.rebuildLavaMesh();
  }

  // ---- Cluster Bomb ----

  private spawnClusterBomblets(position: THREE.Vector3, ownerPower: number) {
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + THREE.MathUtils.randFloatSpread(0.5);
      const speed = THREE.MathUtils.randFloat(3, 6);
      const velocity = new THREE.Vector3(
        Math.cos(angle) * speed,
        THREE.MathUtils.randFloat(4, 8),
        Math.sin(angle) * speed,
      );
      const shell = new THREE.Mesh(
        this._sharedParticleGeo8,
        new THREE.MeshStandardMaterial({ color: 0xffaa33, emissive: 0xff6600, emissiveIntensity: 0.4 }),
      );
      shell.scale.setScalar(0.12);
      shell.position.copy(position);
      shell.castShadow = true;
      this.scene.add(shell);
      // Use a fake tank owner with reduced power for cluster sub-explosions
      const fakeTank = this.tanks[this.currentTankIndex];
      this.clusterBomblets.push({
        mesh: shell,
        velocity,
        owner: fakeTank,
        power: ownerPower * 0.4,
      });
    }
  }

  // ---- Repair Kit Pickups ----

  private spawnRepairKits() {
    const kitCount = 3;
    const placed: { x: number; z: number }[] = [];
    for (let i = 0; i < kitCount; i++) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const gx = THREE.MathUtils.randInt(10, WORLD_SIZE - 10);
        const gz = THREE.MathUtils.randInt(10, WORLD_SIZE - 10);
        // Not in lava
        if (this.lavaVoxels.has(gz * WORLD_SIZE + gx)) continue;
        // Not too close to other kits
        const tooClose = placed.some((p) => Math.hypot(p.x - gx, p.z - gz) < 15);
        if (tooClose) continue;
        // Not too close to tanks
        const kitWorld = this.terrain.worldPosition(gx, this.terrain.getHeight(gx, gz), gz);
        const nearTank = this.tanks.some((t) => t.mesh.position.distanceTo(kitWorld) < 8);
        if (nearTank) continue;

        placed.push({ x: gx, z: gz });
        this.createRepairKitAt(gx, gz);
        break;
      }
    }
  }

  private createRepairKitAt(gx: number, gz: number) {
    const group = new THREE.Group();
    // Box body
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.4, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x228833, roughness: 0.7 }),
    );
    box.castShadow = true;
    box.receiveShadow = true;
    group.add(box);
    // Cross on top
    const crossH = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.06, 0.1),
      new THREE.MeshStandardMaterial({ color: 0xff3333, emissive: 0xff0000, emissiveIntensity: 0.3 }),
    );
    crossH.position.y = 0.23;
    group.add(crossH);
    const crossV = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.06, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xff3333, emissive: 0xff0000, emissiveIntensity: 0.3 }),
    );
    crossV.position.y = 0.23;
    group.add(crossV);

    const h = this.terrain.getHeight(gx, gz);
    const world = this.terrain.worldPosition(gx, h, gz);
    group.position.set(world.x, world.y + 0.2, world.z);
    this.scene.add(group);
    this.repairKits.push({ mesh: group, gridX: gx, gridZ: gz });
  }

  private checkRepairKitPickup() {
    for (let i = this.repairKits.length - 1; i >= 0; i--) {
      const kit = this.repairKits[i];
      for (const tank of this.tanks) {
        if (!tank.alive) continue;
        if (tank.mesh.position.distanceTo(kit.mesh.position) < 1.5) {
          tank.health = Math.min(100, tank.health + this.REPAIR_KIT_HEAL);
          this.spawnDamageSprite(
            tank.mesh.position.clone().add(new THREE.Vector3(0, 1.5, 0)),
            this.REPAIR_KIT_HEAL,
            0x44ff44,
          );
          this.scene.remove(kit.mesh);
          this.repairKits.splice(i, 1);
          break;
        }
      }
    }
  }

  // ---- Camera Shake ----

  private triggerCameraShake(intensity: number) {
    this.cameraShake = Math.max(this.cameraShake, intensity);
  }

  private applyCameraShake() {
    if (this.cameraShake <= 0.01) return;
    const shakeX = THREE.MathUtils.randFloatSpread(this.cameraShake * 0.5);
    const shakeY = THREE.MathUtils.randFloatSpread(this.cameraShake * 0.3);
    this.camera.position.x += shakeX;
    this.camera.position.y += shakeY;
  }

  private updateCameraShake(dt: number) {
    if (this.cameraShake > 0) {
      this.cameraShake *= Math.max(0, 1 - dt * 6);
      if (this.cameraShake < 0.01) this.cameraShake = 0;
    }
  }

  // ---- Projectile Smoke Trail ----

  private spawnTrailPuff(position: THREE.Vector3, weaponType?: string) {
    const vis = this.weaponVisuals[weaponType ?? "standard"] ?? this.weaponVisuals.standard;
    const baseSize = vis.trailSize;
    const size = THREE.MathUtils.randFloat(baseSize * 0.6, baseSize * 1.4);
    const puff = new THREE.Mesh(
      this._sharedParticleGeo,
      new THREE.MeshStandardMaterial({
        color: vis.trailColor,
        transparent: true,
        opacity: vis.trailOpacity,
        depthWrite: false,
        roughness: 1,
      }),
    );
    puff.scale.setScalar(size);
    puff.position.copy(position);
    this.scene.add(puff);
    const life = THREE.MathUtils.randFloat(0.4, 0.8);
    this.projectileTrail.push({ mesh: puff, life, maxLife: life, initialOpacity: vis.trailOpacity, initialSize: size });
  }

  private updateProjectileTrail(dt: number) {
    for (let i = this.projectileTrail.length - 1; i >= 0; i--) {
      const p = this.projectileTrail[i];
      p.life -= dt;
      const age = 1 - p.life / p.maxLife;
      p.mesh.scale.setScalar(p.initialSize * (1 + age * 2.5));
      const mat = p.mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = Math.max(0, (p.life / p.maxLife) * p.initialOpacity);
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        mat.dispose();
        this.projectileTrail.splice(i, 1);
      }
    }
  }

  // ---- Fire Effects in Craters ----

  private spawnCraterFire(position: THREE.Vector3, radius: number) {
    const count = Math.ceil(radius * 2);
    for (let i = 0; i < count; i++) {
      const offset = new THREE.Vector3(
        THREE.MathUtils.randFloatSpread(radius),
        0,
        THREE.MathUtils.randFloatSpread(radius),
      );
      const firePos = position.clone().add(offset);
      const terrainY = this.sampleTerrainHeightAtWorld(firePos.x, firePos.z);

      const fireScaleX = 0.15 + Math.random() * 0.15;
      const fireScaleY = 0.5 + Math.random() * 0.4;
      const fireMesh = new THREE.Mesh(this._sharedFireGeo, this._sharedFireMat.clone());
      fireMesh.scale.set(fireScaleX, fireScaleY, fireScaleX);
      fireMesh.position.set(firePos.x, terrainY + 0.25, firePos.z);
      this.scene.add(fireMesh);

      const fireLight = new THREE.PointLight(0xff4400, 0.6, 4);
      fireLight.position.copy(fireMesh.position);
      this.scene.add(fireLight);

      const life = THREE.MathUtils.randFloat(3, 6);
      this.craterFires.push({ mesh: fireMesh, light: fireLight, life, maxLife: life, baseScaleY: fireScaleY });
    }
  }

  private updateCraterFires(dt: number) {
    for (let i = this.craterFires.length - 1; i >= 0; i--) {
      const f = this.craterFires[i];
      f.life -= dt;
      const t = f.life / f.maxLife;
      // Flicker
      const flicker = 0.7 + Math.sin(f.life * 12) * 0.3;
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = t * 0.8 * flicker;
      f.light.intensity = t * 0.6 * flicker;
      // Animate scale to simulate flame
      f.mesh.scale.y = f.baseScaleY * (0.8 + Math.sin(f.life * 8) * 0.3);
      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        this.scene.remove(f.light);
        (f.mesh.material as THREE.MeshBasicMaterial).dispose();
        f.light.dispose();
        this.craterFires.splice(i, 1);
      }
    }
  }

  // ---- Tank Wreckage ----

  private spawnWreckage(tank: Tank) {
    const wreck = new THREE.Group();
    // Burnt hull
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.5, 1.1),
      new THREE.MeshStandardMaterial({
        color: 0x222222,
        roughness: 1,
        metalness: 0.2,
      }),
    );
    hull.castShadow = true;
    hull.receiveShadow = true;
    wreck.add(hull);
    // Bent barrel
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 0.8, 6),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }),
    );
    barrel.rotation.z = Math.PI * 0.3 + THREE.MathUtils.randFloatSpread(0.3);
    barrel.position.set(0.3, 0.2, 0);
    barrel.castShadow = true;
    wreck.add(barrel);
    // Smoke from wreckage (persistent thin smoke)
    const smoke = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0x444444, transparent: true, opacity: 0.25 }),
    );
    smoke.position.y = 0.6;
    wreck.add(smoke);

    wreck.position.copy(tank.mesh.position);
    wreck.rotation.y = tank.heading + THREE.MathUtils.randFloatSpread(0.3);
    this.scene.add(wreck);
    this.wreckages.push(wreck);
  }

  // ---- Force Shield ----

  private createShieldForTank(tank: Tank) {
    if (tank.shieldMesh) return;
    const shieldGeo = new THREE.SphereGeometry(1.4, 16, 12);
    const shieldMat = new THREE.MeshStandardMaterial({
      color: 0x44aaff,
      transparent: true,
      opacity: 0.18,
      emissive: 0x2266ff,
      emissiveIntensity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    tank.shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
    tank.mesh.add(tank.shieldMesh);
  }

  private removeShieldFromTank(tank: Tank) {
    if (!tank.shieldMesh) return;
    tank.mesh.remove(tank.shieldMesh);
    tank.shieldMesh.geometry.dispose();
    (tank.shieldMesh.material as THREE.Material).dispose();
    tank.shieldMesh = null;
    tank.hasShield = false;
  }

  // ---- Cluster bomblet tracking ----
  private readonly clusterBomblets: { mesh: THREE.Mesh; velocity: THREE.Vector3; owner: Tank; power: number }[] = [];

  private updateClusterBomblets(dt: number) {
    for (let i = this.clusterBomblets.length - 1; i >= 0; i--) {
      const b = this.clusterBomblets[i];
      b.velocity.y -= GRAVITY * dt;
      b.velocity.x += this.wind * dt;
      b.mesh.position.addScaledVector(b.velocity, dt);

      // Trail puff for bomblets
      if (Math.random() < 0.3) {
        this.spawnTrailPuff(b.mesh.position.clone(), "cluster");
      }

      const terrainY = this.sampleTerrainHeightAtWorld(b.mesh.position.x, b.mesh.position.z);
      const outside = Math.abs(b.mesh.position.x) > PROJECTILE_BOUNDS || Math.abs(b.mesh.position.z) > PROJECTILE_BOUNDS || b.mesh.position.y < -6;
      if (outside || b.mesh.position.y <= terrainY + 0.2) {
        this.explodeAt(b.mesh.position, b.power, "standard");
        this.scene.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        this.clusterBomblets.splice(i, 1);
      }
    }
  }

  // ---- Weapon Selector UI ----

  private setupWeaponSelector() {
    this.weaponSelectorEl.style.position = "fixed";
    this.weaponSelectorEl.style.bottom = "16px";
    this.weaponSelectorEl.style.left = "50%";
    this.weaponSelectorEl.style.transform = "translateX(-50%)";
    this.weaponSelectorEl.style.display = "flex";
    this.weaponSelectorEl.style.gap = "8px";
    this.weaponSelectorEl.style.zIndex = "100";
    document.body.appendChild(this.weaponSelectorEl);
  }

  private lastWeaponSelectorKey = "";

  private updateWeaponSelector() {
    const tank = this.tanks[this.currentTankIndex];
    if (!tank || !tank.alive || this.gameOver) {
      if (this.weaponSelectorEl.innerHTML !== "") {
        this.weaponSelectorEl.innerHTML = "";
        this.lastWeaponSelectorKey = "";
      }
      return;
    }

    // Available weapons: always standard + light, plus purchased
    const available: { key: string; def: WeaponDef; ammo: number | null }[] = [
      { key: "standard", def: WEAPONS.standard, ammo: null },
      { key: "light", def: WEAPONS.light, ammo: null },
    ];
    for (const [id, count] of tank.inventory) {
      if (count > 0 && WEAPONS[id]) {
        available.push({ key: id, def: WEAPONS[id], ammo: count });
      }
    }

    // Build a cache key to avoid rebuilding every frame
    const cacheKey = tank.selectedWeapon + "|" + available.map((w) => `${w.key}:${w.ammo}`).join(",");
    if (cacheKey === this.lastWeaponSelectorKey) return;
    this.lastWeaponSelectorKey = cacheKey;

    this.weaponSelectorEl.innerHTML = available.map((w) => {
      const sel = tank.selectedWeapon === w.key;
      const bgColor = sel ? "rgba(255,214,102,0.35)" : "rgba(25,15,8,0.72)";
      const borderColor = sel ? "#ffd666" : "rgba(255,255,255,0.18)";
      const ammoStr = w.ammo !== null ? ` (${w.ammo})` : "";
      return `<div data-weapon="${w.key}" style="
        padding:8px 14px;border-radius:6px;cursor:pointer;
        background:${bgColor};border:1px solid ${borderColor};
        font-size:12px;color:#f7efe4;font-family:monospace;
        user-select:none;
      ">${w.def.name}${ammoStr}</div>`;
    }).join("");

    this.weaponSelectorEl.querySelectorAll("[data-weapon]").forEach((el) => {
      el.addEventListener("click", () => {
        tank.selectedWeapon = (el as HTMLElement).dataset.weapon!;
        this.lastWeaponSelectorKey = ""; // Force re-render to update highlight
      });
    });
  }

  // ---- Shop Between Rounds ----

  private setupShopOverlay() {
    this.shopOverlayEl.id = "shop-overlay";
    this.shopOverlayEl.style.cssText = `
      position:fixed;inset:0;background:rgba(10,8,5,0.92);
      display:none;align-items:center;justify-content:center;z-index:2000;
    `;
    document.body.appendChild(this.shopOverlayEl);
  }

  private showShop(): Promise<void> {
    return new Promise((resolve) => {
      this.shopOverlayEl.style.display = "flex";

      const playerTanks = this.tanks.filter((t) => t.team === "player" && t.alive);
      const tank = playerTanks[0]; // Show shop for first alive player tank
      if (!tank) { resolve(); return; }

      this.shopOverlayEl.innerHTML = `
        <div style="text-align:center;min-width:500px">
          <h2 style="color:#ffd666;font-size:28px;letter-spacing:6px;margin-bottom:8px">
            ROUND ${this.currentRound} COMPLETE
          </h2>
          <p style="color:#aaa;margin-bottom:24px">Money: <span id="shop-money" style="color:#ffd666">$${tank.money}</span></p>
          <div id="shop-items" style="display:flex;flex-direction:column;gap:10px;align-items:center"></div>
          <br>
          <button id="shop-continue" style="
            font-family:monospace;font-size:15px;font-weight:700;letter-spacing:3px;
            color:#f7efe4;background:rgba(255,214,102,0.15);border:2px solid #ffd666;
            padding:14px 48px;border-radius:6px;cursor:pointer;
          ">CONTINUE</button>
        </div>
      `;

      const itemsDiv = this.shopOverlayEl.querySelector("#shop-items")!;
      for (const item of SHOP_ITEMS) {
        const canBuy = tank.money >= item.cost;
        const btn = document.createElement("div");
        btn.style.cssText = `
          padding:10px 20px;border-radius:6px;cursor:${canBuy ? "pointer" : "default"};
          background:rgba(255,255,255,${canBuy ? "0.06" : "0.02"});
          border:1px solid rgba(255,255,255,${canBuy ? "0.2" : "0.08"});
          color:${canBuy ? "#f7efe4" : "#555"};font-size:13px;font-family:monospace;
          min-width:360px;text-align:left;
        `;
        btn.innerHTML = `<b>${item.name}</b> — $${item.cost}<br><span style="font-size:11px;color:#886">${item.description}</span>`;
        if (canBuy) {
          btn.addEventListener("click", () => {
            this.purchaseItem(tank, item);
            this.showShop().then(resolve);
            // Re-render by recursing (Promise chain)
          });
        }
        itemsDiv.appendChild(btn);
      }

      this.shopOverlayEl.querySelector("#shop-continue")!.addEventListener("click", () => {
        this.shopOverlayEl.style.display = "none";
        resolve();
      });
    });
  }

  private purchaseItem(tank: Tank, item: ShopItem) {
    if (tank.money < item.cost) return;
    tank.money -= item.cost;
    switch (item.type) {
      case "weapon": {
        const current = tank.inventory.get(item.id) ?? 0;
        tank.inventory.set(item.id, current + 3); // 3 ammo per purchase
        break;
      }
      case "shield":
        tank.hasShield = true;
        this.createShieldForTank(tank);
        break;
      case "repair25":
        tank.health = Math.min(100, tank.health + 25);
        break;
      case "repair50":
        tank.health = Math.min(100, tank.health + 50);
        break;
    }
    // Apply same purchase to allied tanks
    for (const t of this.tanks) {
      if (t === tank || t.team !== tank.team || !t.alive) continue;
      if (item.type === "weapon") {
        const current = t.inventory.get(item.id) ?? 0;
        t.inventory.set(item.id, current + 3);
      }
    }
  }

  // ---- Building System (Farm Houses + HQ) ----

  private async loadBuildingPrototypes() {
    // Handcrafted 3D building prototypes
    this.createBuildingPrototypes();
  }

  private createBuildingPrototypes() {
    // --- 3 distinct farmhouse styles ---

    // Style 1: Classic red barn
    const barn = new THREE.Group();
    const barnWalls = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 1.4, 1.5),
      new THREE.MeshStandardMaterial({ color: 0x8b2500, roughness: 0.85 }),
    );
    barnWalls.position.y = 0.7;
    barnWalls.castShadow = true;
    barnWalls.receiveShadow = true;
    barn.add(barnWalls);
    const barnRoof = new THREE.Mesh(
      new THREE.BoxGeometry(2.3, 0.12, 1.8),
      new THREE.MeshStandardMaterial({ color: 0x5a1a0a, roughness: 0.7 }),
    );
    barnRoof.position.y = 1.46;
    barnRoof.castShadow = true;
    barn.add(barnRoof);
    // Pitched roof ridge
    const barnRidge = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 2.3, 4),
      new THREE.MeshStandardMaterial({ color: 0x5a1a0a, roughness: 0.7 }),
    );
    barnRidge.position.y = 1.85;
    barnRidge.rotation.z = Math.PI / 2;
    barnRidge.castShadow = true;
    barn.add(barnRidge);
    // Roof slopes
    const roofSlope1 = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x6b2010, roughness: 0.8, side: THREE.DoubleSide }),
    );
    roofSlope1.position.set(0, 1.65, -0.45);
    roofSlope1.rotation.x = -0.55;
    roofSlope1.castShadow = true;
    barn.add(roofSlope1);
    const roofSlope2 = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x6b2010, roughness: 0.8, side: THREE.DoubleSide }),
    );
    roofSlope2.position.set(0, 1.65, 0.45);
    roofSlope2.rotation.x = 0.55;
    roofSlope2.castShadow = true;
    barn.add(roofSlope2);
    // Door
    const barnDoor = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x4a2000, side: THREE.DoubleSide }),
    );
    barnDoor.position.set(0, 0.45, 0.76);
    barn.add(barnDoor);
    barn.scale.setScalar(0.5);
    this.voxPrototypes.farm.push(barn);

    // Style 2: Stone cottage with chimney
    const cottage = new THREE.Group();
    const cottageWalls = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.2, 1.3),
      new THREE.MeshStandardMaterial({ color: 0x9e9585, roughness: 0.95 }),
    );
    cottageWalls.position.y = 0.6;
    cottageWalls.castShadow = true;
    cottageWalls.receiveShadow = true;
    cottage.add(cottageWalls);
    const cottageRoof = new THREE.Mesh(
      new THREE.ConeGeometry(1.3, 0.8, 4),
      new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 0.8 }),
    );
    cottageRoof.position.y = 1.6;
    cottageRoof.rotation.y = Math.PI / 4;
    cottageRoof.castShadow = true;
    cottage.add(cottageRoof);
    // Chimney
    const chimney = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.6, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x664444, roughness: 0.9 }),
    );
    chimney.position.set(0.5, 2.0, -0.3);
    chimney.castShadow = true;
    cottage.add(chimney);
    // Window
    const window1 = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xccddee, emissive: 0x445566, emissiveIntensity: 0.2, side: THREE.DoubleSide }),
    );
    window1.position.set(-0.4, 0.75, 0.66);
    cottage.add(window1);
    cottage.scale.setScalar(0.5);
    this.voxPrototypes.farm.push(cottage);

    // Style 3: Wooden cabin with porch
    const cabin = new THREE.Group();
    const cabinWalls = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 1.0, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x8b6914, roughness: 0.9 }),
    );
    cabinWalls.position.y = 0.5;
    cabinWalls.castShadow = true;
    cabinWalls.receiveShadow = true;
    cabin.add(cabinWalls);
    const cabinRoof = new THREE.Mesh(
      new THREE.BoxGeometry(2.1, 0.1, 1.6),
      new THREE.MeshStandardMaterial({ color: 0x3d2b1f, roughness: 0.8 }),
    );
    cabinRoof.position.y = 1.05;
    cabinRoof.rotation.z = 0.08; // Slight tilt
    cabinRoof.castShadow = true;
    cabin.add(cabinRoof);
    // Porch overhang
    const porch = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 0.06, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x3d2b1f, roughness: 0.8 }),
    );
    porch.position.set(0, 0.85, 0.85);
    porch.castShadow = true;
    cabin.add(porch);
    // Porch posts
    for (const px of [-0.8, 0.8]) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.04, 0.85, 6),
        new THREE.MeshStandardMaterial({ color: 0x5a3a1a }),
      );
      post.position.set(px, 0.42, 1.05);
      post.castShadow = true;
      cabin.add(post);
    }
    cabin.scale.setScalar(0.5);
    this.voxPrototypes.farm.push(cabin);

    // --- HQ: Military compound ---
    const hq = new THREE.Group();
    // Main building (concrete bunker style)
    const hqMain = new THREE.Mesh(
      new THREE.BoxGeometry(3.5, 1.8, 2.8),
      new THREE.MeshStandardMaterial({ color: 0x556b5e, roughness: 0.8, metalness: 0.15 }),
    );
    hqMain.position.y = 0.9;
    hqMain.castShadow = true;
    hqMain.receiveShadow = true;
    hq.add(hqMain);
    // Flat roof
    const hqRoof = new THREE.Mesh(
      new THREE.BoxGeometry(3.7, 0.12, 3.0),
      new THREE.MeshStandardMaterial({ color: 0x3d4d40, roughness: 0.7 }),
    );
    hqRoof.position.y = 1.86;
    hqRoof.castShadow = true;
    hq.add(hqRoof);
    // Sandbag wall around base
    const sandbagMat = new THREE.MeshStandardMaterial({ color: 0x8b7d5a, roughness: 0.95 });
    for (const [sx, sz, rw, rd] of [
      [0, 1.8, 4.0, 0.3],
      [0, -1.8, 4.0, 0.3],
      [2.1, 0, 0.3, 3.9],
      [-2.1, 0, 0.3, 3.9],
    ] as [number, number, number, number][]) {
      const sandbag = new THREE.Mesh(
        new THREE.BoxGeometry(rw, 0.4, rd),
        sandbagMat,
      );
      sandbag.position.set(sx, 0.2, sz);
      sandbag.castShadow = true;
      hq.add(sandbag);
    }
    // Antenna tower
    const antennaPole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 2.5, 6),
      new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.8 }),
    );
    antennaPole.position.set(1.2, 3.1, -0.8);
    antennaPole.castShadow = true;
    hq.add(antennaPole);
    // Antenna dish
    const dish = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 8, 8, 0, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.6 }),
    );
    dish.position.set(1.2, 4.2, -0.8);
    dish.rotation.x = -Math.PI / 4;
    dish.castShadow = true;
    hq.add(dish);
    // Camo stripe on wall
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x3a5a3a, side: THREE.DoubleSide }),
    );
    stripe.position.set(0, 1.2, 1.41);
    hq.add(stripe);
    // Steel support beams — hidden underground, revealed when terrain is blown away
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x6a6a6a, metalness: 0.7, roughness: 0.4 });
    const beamHeight = 8; // Deep enough to stay visible through heavy cratering
    const beamPositions: [number, number][] = [
      [-1.2, -1.0], [1.2, -1.0], [-1.2, 1.0], [1.2, 1.0], // 4 corners
      [0, 0], // center
    ];
    for (const [bx, bz] of beamPositions) {
      // Vertical I-beam (main column)
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, beamHeight, 0.15),
        beamMat,
      );
      beam.position.set(bx, -beamHeight / 2 + 0.1, bz);
      beam.castShadow = true;
      hq.add(beam);
      // Cross flanges for I-beam look
      const flange = new THREE.Mesh(
        new THREE.BoxGeometry(0.35, 0.08, 0.04),
        beamMat,
      );
      flange.position.set(bx, -beamHeight / 2 + 0.1, bz);
      hq.add(flange);
    }
    // Horizontal cross-braces connecting the beams (visible when ground erodes)
    const braceMat = new THREE.MeshStandardMaterial({ color: 0x5a5a5a, metalness: 0.6, roughness: 0.5 });
    const braceY = -2.0; // Below surface level
    // X-direction braces
    for (const bz of [-1.0, 1.0]) {
      const brace = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 0.1, 0.08),
        braceMat,
      );
      brace.position.set(0, braceY, bz);
      hq.add(brace);
    }
    // Z-direction braces
    for (const bx of [-1.2, 1.2]) {
      const brace = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.1, 2.0),
        braceMat,
      );
      brace.position.set(bx, braceY, 0);
      hq.add(brace);
    }
    // Concrete foundation pad at base of beams
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.2, 2.4),
      new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.9 }),
    );
    pad.position.y = -0.1;
    hq.add(pad);
    this.voxPrototypes.hq = hq;
  }

  private spawnBuildings() {
    // Clear existing buildings
    for (const b of this.buildings) {
      this.scene.remove(b.mesh);
      if (b.healthBar) this.scene.remove(b.healthBar);
    }
    this.buildings.length = 0;

    const tankPositions = this.tanks.map((t) => new THREE.Vector2(t.mesh.position.x, t.mesh.position.z));

    // --- Spawn farm houses ---
    const farmCount = 8;
    const placedPositions: THREE.Vector2[] = [];
    const farmSpacing = 8;
    const tankClearance = 7;

    for (let i = 0; i < farmCount && this.voxPrototypes.farm.length > 0; i++) {
      for (let attempt = 0; attempt < 60; attempt++) {
        const gx = THREE.MathUtils.randInt(12, WORLD_SIZE - 12);
        const gz = THREE.MathUtils.randInt(12, WORLD_SIZE - 12);
        // Not in lava
        if (this.lavaVoxels.has(gz * WORLD_SIZE + gx)) continue;
        const worldPos = this.terrain.worldPosition(gx, this.terrain.getHeight(gx, gz), gz);
        const pos2 = new THREE.Vector2(worldPos.x, worldPos.z);
        // Spacing from other buildings
        if (placedPositions.some((p) => p.distanceTo(pos2) < farmSpacing)) continue;
        // Not near tanks
        if (tankPositions.some((tp) => tp.distanceTo(pos2) < tankClearance)) continue;
        // Not too close to center (lava river area)
        if (Math.abs(worldPos.x) < 5) continue;

        placedPositions.push(pos2);
        this.createBuilding("farm", gx, gz);
        break;
      }
    }

    // --- Spawn HQ for each team ---
    if (this.voxPrototypes.hq) {
      // Player HQ near player spawn area (bottom-left)
      this.createBuilding("hq", 10, 10, "player");
      // AI HQ near AI spawn area (top-right)
      this.createBuilding("hq", WORLD_SIZE - 10, WORLD_SIZE - 10, "ai");
    }
    console.log("Buildings spawned:", this.buildings.length, "farms:", this.buildings.filter(b => b.type === "farm").length, "HQs:", this.buildings.filter(b => b.type === "hq").length);
  }

  private createBuilding(type: "farm" | "hq", gx: number, gz: number, team?: Team) {
    const group = new THREE.Group();
    let model: THREE.Object3D;

    if (type === "hq" && this.voxPrototypes.hq) {
      model = this.voxPrototypes.hq.clone(true);
    } else if (this.voxPrototypes.farm.length > 0) {
      const proto = this.voxPrototypes.farm[Math.floor(Math.random() * this.voxPrototypes.farm.length)];
      model = proto.clone(true);
    } else {
      return; // No prototypes available
    }

    model.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        node.frustumCulled = false;
      }
    });

    group.add(model);
    group.rotation.y = Math.random() * Math.PI * 2;

    const h = this.terrain.getHeight(gx, gz);
    const worldPos = this.terrain.worldPosition(gx, h, gz);
    group.position.set(worldPos.x, worldPos.y, worldPos.z);

    const maxHp = type === "hq" ? BUILDING_HQ_HP : BUILDING_FARM_HP;
    const building: Building = {
      mesh: group,
      health: maxHp,
      maxHealth: maxHp,
      type,
      team,
      gridX: gx,
      gridZ: gz,
    };

    // HQ gets a health bar and a team flag
    if (type === "hq") {
      building.healthBar = this.createBuildingHealthBar(building);
      this.scene.add(building.healthBar);
      // Add a colored flag/beacon on the HQ
      const flagColor = team === "player" ? 0xea6153 : 0x4ea9de;
      const flagPole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, 2.5, 6),
        new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.6 }),
      );
      flagPole.position.y = 2.8;
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(0.8, 0.5),
        new THREE.MeshStandardMaterial({ color: flagColor, side: THREE.DoubleSide, emissive: flagColor, emissiveIntensity: 0.3 }),
      );
      flag.position.set(0.4, 3.8, 0);
      group.add(flagPole);
      group.add(flag);
      // Glow beacon
      const beacon = new THREE.PointLight(flagColor, 1.5, 10);
      beacon.position.y = 4.2;
      group.add(beacon);
    }

    this.scene.add(group);
    this.buildings.push(building);
  }

  private createBuildingHealthBar(building: Building): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 16;
    const ctx = canvas.getContext("2d")!;
    const ratio = building.health / building.maxHealth;
    // Background
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, 0, 128, 16);
    // Health fill
    const r = Math.floor(255 * (1 - ratio));
    const g = Math.floor(255 * ratio);
    ctx.fillStyle = `rgb(${r},${g},50)`;
    ctx.fillRect(2, 2, 124 * ratio, 12);
    // Border
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.strokeRect(1, 1, 126, 14);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.5, 0.35, 1);
    sprite.position.copy(building.mesh.position).add(new THREE.Vector3(0, 4.8, 0));
    return sprite;
  }

  private updateBuildingHealthBar(building: Building) {
    if (!building.healthBar) return;
    const oldMat = building.healthBar.material as THREE.SpriteMaterial;
    if (oldMat.map) oldMat.map.dispose();
    oldMat.dispose();
    this.scene.remove(building.healthBar);
    building.healthBar = this.createBuildingHealthBar(building);
    this.scene.add(building.healthBar);
  }

  private damageBuildings(blastPos: THREE.Vector3, power: number, weaponType: string) {
    const wDef = WEAPONS[weaponType] ?? WEAPONS.standard;
    const baseDmg = 60 * wDef.damageMultiplier;
    for (let i = this.buildings.length - 1; i >= 0; i--) {
      const b = this.buildings[i];
      const dist = b.mesh.position.distanceTo(blastPos);

      let damage = 0;
      if (dist < BUILDING_DAMAGE_RADIUS) {
        // Direct hit on building
        const proximity = 1 - dist / BUILDING_DAMAGE_RADIUS;
        damage = proximity * baseDmg * (1 + power * 0.01);
      } else if (b.type === "hq") {
        // Check beam hits — beams extend below the HQ
        const beamOffsets: [number, number][] = [[-1.2, -1.0], [1.2, -1.0], [-1.2, 1.0], [1.2, 1.0], [0, 0]];
        const hqPos = b.mesh.position;
        const beamRadius = 2.5;
        for (const [bx, bz] of beamOffsets) {
          // Beam column XZ position in world space
          const beamWorldX = hqPos.x + bx;
          const beamWorldZ = hqPos.z + bz;
          const dx = blastPos.x - beamWorldX;
          const dz = blastPos.z - beamWorldZ;
          const xzDist = Math.sqrt(dx * dx + dz * dz);
          // Blast must be near the beam column and below the building surface
          if (xzDist < beamRadius && blastPos.y < hqPos.y + 0.5) {
            const proximity = 1 - xzDist / beamRadius;
            damage = Math.max(damage, proximity * baseDmg * (1 + power * 0.01) * 0.5); // 50% of normal
          }
        }
      }

      if (damage > 0) {
        b.health -= damage;

        // Floating damage number
        if (damage > 1) {
          this.spawnDamageSprite(
            b.mesh.position.clone().add(new THREE.Vector3(
              THREE.MathUtils.randFloatSpread(0.5), 2.5, THREE.MathUtils.randFloatSpread(0.5),
            )),
            Math.round(damage),
            b.type === "hq" ? 0xff8800 : 0xffeedd,
          );
        }

        if (b.health <= 0) {
          this.destroyBuilding(b, i, blastPos);
        } else {
          this.updateBuildingHealthBar(b);
        }
      }
    }
  }

  private destroyBuilding(building: Building, index: number, blastPos: THREE.Vector3) {
    // Remove from scene
    this.scene.remove(building.mesh);
    if (building.healthBar) {
      this.scene.remove(building.healthBar);
    }

    const pos = building.mesh.position.clone();
    const awayDir = pos.clone().sub(blastPos).normalize();

    // Spawn debris chunks
    const chunkCount = building.type === "hq" ? 12 : 6;
    for (let i = 0; i < chunkCount; i++) {
      const isWood = Math.random() < 0.5;
      const chunk = new THREE.Mesh(
        new THREE.BoxGeometry(
          THREE.MathUtils.randFloat(0.2, 0.6),
          THREE.MathUtils.randFloat(0.1, 0.4),
          THREE.MathUtils.randFloat(0.2, 0.5),
        ),
        new THREE.MeshStandardMaterial({
          color: isWood ? 0x8b6914 : 0x999999,
          roughness: 0.9,
        }),
      );
      chunk.position.copy(pos).add(new THREE.Vector3(
        THREE.MathUtils.randFloatSpread(1),
        THREE.MathUtils.randFloat(0.2, 1.5),
        THREE.MathUtils.randFloatSpread(1),
      ));
      chunk.castShadow = true;
      this.scene.add(chunk);

      const velocity = new THREE.Vector3(
        awayDir.x * THREE.MathUtils.randFloat(2, 6) + THREE.MathUtils.randFloatSpread(3),
        THREE.MathUtils.randFloat(4, 10),
        awayDir.z * THREE.MathUtils.randFloat(2, 6) + THREE.MathUtils.randFloatSpread(3),
      );
      const angularVel = new THREE.Vector3(
        THREE.MathUtils.randFloatSpread(8),
        THREE.MathUtils.randFloatSpread(8),
        THREE.MathUtils.randFloatSpread(8),
      );
      this.fallingProps.push({ obj: chunk, velocity, angularVel, life: THREE.MathUtils.randFloat(2, 3.5) });
    }

    // Explosion VFX
    this.spawnExplosionParticles(pos, 0x8b6914, 14);
    this.spawnExplosionParticles(pos, 0xff8844, 10);
    this.triggerCameraShake(building.type === "hq" ? 2.0 : 0.8);

    // "DESTROYED" / "HQ DESTROYED" text
    const label = building.type === "hq"
      ? `${building.team === "player" ? "PLAYER" : "ENEMY"} HQ DESTROYED`
      : "BUILDING DESTROYED";
    this.spawnTextSprite(
      pos.clone().add(new THREE.Vector3(0, 3, 0)),
      label,
      building.type === "hq" ? 0xff4444 : 0xff8844,
    );

    if (building.type === "hq") {
      this.screenFlash = 0.7;
    }

    // Remove from array
    this.buildings.splice(index, 1);
  }

  // ---- Round Progression (Single Player) ----

  private async startNextRound() {
    this.currentRound++;
    // Heal surviving player tanks 25%
    for (const t of this.tanks) {
      if (t.team === "player" && t.alive) {
        t.health = Math.min(100, t.health + ROUND_HEAL_PERCENT);
      }
    }

    // Show shop
    await this.showShop();

    // Respawn AI tanks with scaled health
    const aiHealthScale = 1 + (this.currentRound - 1) * 0.15;
    for (const t of this.tanks) {
      if (t.team === "ai") {
        t.alive = true;
        t.health = 100 * aiHealthScale;
        t.mesh.visible = true;
      }
    }

    // New terrain, new lava
    this.terrain.generate();
    this.terrain["rebuildMesh"]();
    this.lavaVoxels.clear();
    this.createLavaRiver();

    // Reposition tanks
    this.placeTankAt(this.tanks[0], 14, 14);
    this.placeTankAt(this.tanks[1], WORLD_SIZE - 14, WORLD_SIZE - 14);
    this.placeTankAt(this.tanks[2], 20, WORLD_SIZE - 20);
    this.placeTankAt(this.tanks[3], WORLD_SIZE - 20, 20);

    // Reorient
    const center = new THREE.Vector3(0, 0, 0);
    for (const tank of this.tanks) {
      const toCenter = center.clone().sub(tank.mesh.position);
      tank.heading = Math.atan2(toCenter.x, toCenter.z);
      tank.mesh.rotation.y = tank.heading;
    }

    // Fresh repair kits and clear wreckage/fires
    for (const kit of this.repairKits) this.scene.remove(kit.mesh);
    this.repairKits.length = 0;
    for (const w of this.wreckages) this.scene.remove(w);
    this.wreckages.length = 0;
    for (const f of this.craterFires) { this.scene.remove(f.mesh); this.scene.remove(f.light); }
    this.craterFires.length = 0;
    for (const s of this.scorchMarks) this.scene.remove(s);
    this.scorchMarks.length = 0;

    this.spawnRepairKits();
    this.spawnBuildings();

    this.gameOver = false;
    this.winner = null;
    this.currentTankIndex = 0;
    this.startTurn();
  }

  // ---- Skybox ----

  private createSkybox() {
    const skyGeo = new THREE.SphereGeometry(180, 32, 32);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x4488cc) },
        bottomColor: { value: new THREE.Color(0xe8b173) },
        offset: { value: 10 },
        exponent: { value: 0.5 },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + offset).y;
          gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const skyMesh = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(skyMesh);
  }

  private readonly tick = () => {
    const now = globalThis.performance.now() / 1000;
    const dt = Math.min(0.033, now - this.lastFrameTime);
    this.lastFrameTime = now;

    this.updatePlayerInput(dt);
    this.updateAiTurn(dt);
    this.updateProjectile(dt);
    this.updateClusterBomblets(dt);
    this.stabilizeTanksOnTerrain(dt);
    this.updateDeathParticles(dt);
    this.updateExplosionParticles(dt);
    this.updateFallingProps(dt);
    this.updateDamageSprites(dt);
    this.updateMuzzleFlash(dt);
    this.updateScreenFlash(dt);
    this.updateTurnBanner(dt);
    this.updateTankTracks(dt);
    this.updateSmokeParticles(dt);
    this.updateProjectileTrail(dt);
    this.updateCraterFires(dt);
    this.updateLavaFlow(dt);
    this.updateLavaDamage(dt);
    this.updateCameraShake(dt);
    this.updateDayCycle(dt);
    this.checkRepairKitPickup();
    this.checkWinCondition();
    this.updateTrajectoryGuide();
    this.updateWeaponSelector();
    this.updateCamera(dt);
    this.applyCameraShake();
    this.updateHud();

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.tick);
  };

  private updateTankTracks(dt: number) {
    for (let i = this.tankTracks.length - 1; i >= 0; i -= 1) {
      const t = this.tankTracks[i];
      t.life -= dt;
      // Fade over the last 5 seconds
      if (t.life < 5) {
        const mat = t.mesh.material as THREE.MeshStandardMaterial;
        mat.opacity = Math.max(0, (t.life / 5) * 0.45);
      }
      if (t.life <= 0) {
        this.scene.remove(t.mesh);
        (t.mesh.material as THREE.MeshStandardMaterial).dispose();
        this.tankTracks.splice(i, 1);
      }
    }
  }

  private updateSmokeParticles(dt: number) {
    for (let i = this.smokeParticles.length - 1; i >= 0; i -= 1) {
      const p = this.smokeParticles[i];
      p.life -= dt;
      p.velocity.y -= 0.3 * dt; // slight buoyancy decay
      p.mesh.position.addScaledVector(p.velocity, dt);
      // Grow as it rises
      const age = 1 - p.life / p.maxLife;
      p.mesh.scale.setScalar(p.initialSize * (1 + age * 2));
      const mat = p.mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = Math.max(0, (p.life / p.maxLife) * 0.5);

      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        mat.dispose();
        this.smokeParticles.splice(i, 1);
      }
    }
  }

  private updateExplosionParticles(dt: number) {
    for (let i = this.explosionParticles.length - 1; i >= 0; i -= 1) {
      const p = this.explosionParticles[i];
      p.life -= dt;
      p.velocity.y -= GRAVITY * 0.65 * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.mesh.rotation.x += dt * 5;
      p.mesh.rotation.z += dt * 3;

      const alpha = Math.max(0, p.life / p.maxLife);
      const mat = p.mesh.material as THREE.MeshStandardMaterial;
      mat.transparent = true;
      mat.opacity = alpha;

      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        mat.dispose();
        this.explosionParticles.splice(i, 1);
      }
    }
  }

  private updateDamageSprites(dt: number) {
    for (let i = this.damageSprites.length - 1; i >= 0; i -= 1) {
      const d = this.damageSprites[i];
      d.life -= dt;
      d.sprite.position.addScaledVector(d.velocity, dt);
      const alpha = Math.max(0, d.life / d.maxLife);
      d.sprite.material.opacity = alpha;

      if (d.life <= 0) {
        this.scene.remove(d.sprite);
        d.sprite.material.map?.dispose();
        d.sprite.material.dispose();
        this.damageSprites.splice(i, 1);
      }
    }
  }

  private updateMuzzleFlash(dt: number) {
    if (!this.muzzleFlash) return;
    this.muzzleFlash.life -= dt;
    const alpha = Math.max(0, this.muzzleFlash.life / 0.15);
    this.muzzleFlash.light.intensity = 5 * alpha;
    (this.muzzleFlash.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * alpha;
    const s = 0.2 + 0.3 * alpha;
    this.muzzleFlash.mesh.scale.setScalar(s / 0.4);
    if (this.muzzleFlash.life <= 0) {
      this.scene.remove(this.muzzleFlash.light);
      this.scene.remove(this.muzzleFlash.mesh);
      (this.muzzleFlash.mesh.material as THREE.MeshBasicMaterial).dispose();
      this.muzzleFlash.mesh.geometry.dispose();
      this.muzzleFlash = null;
    }
  }

  private updateScreenFlash(dt: number) {
    if (this.screenFlash > 0) {
      this.screenFlash = Math.max(0, this.screenFlash - dt * 3.5);
    }
  }

  private updateTurnBanner(dt: number) {
    if (!this.turnBanner) {
      this.turnBannerEl.style.display = "none";
      return;
    }
    this.turnBanner.life -= dt;
    const frac = this.turnBanner.life / this.turnBanner.maxLife;
    let opacity: number;
    if (frac > 0.7) opacity = (1 - frac) / 0.3;
    else if (frac < 0.3) opacity = frac / 0.3;
    else opacity = 1;
    this.turnBannerEl.style.display = "block";
    this.turnBannerEl.style.opacity = String(Math.min(1, opacity * 1.2));
    this.turnBannerEl.textContent = this.turnBanner.text;
    this.turnBannerEl.style.background = this.turnBanner.color;
    if (this.turnBanner.life <= 0) {
      this.turnBanner = null;
    }
  }

  private readonly onResize = () => {
    this.camera.aspect = globalThis.innerWidth / globalThis.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(globalThis.innerWidth, globalThis.innerHeight);
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    this.keys.add(event.code);
    if (event.code === "Space") {
      event.preventDefault();
      const canFire = this.gameConfig.mode === "hotseat"
        ? true
        : this.gameConfig.mode === "multiplayer"
          ? this.isLocalTurn()
          : this.tanks[this.currentTankIndex]?.team === "player";
      if (!this.gameOver && canFire) {
        if (this.gameConfig.mode === "multiplayer") {
          const tank = this.tanks[this.currentTankIndex];
          this.mpSend({
            type: "game_fire",
            tankIndex: this.currentTankIndex,
            angle: tank.angle,
            power: tank.power,
            heading: tank.heading,
            wind: this.wind,
          });
        }
        this.fireCurrentTank();
      }
    }
    // Weapon switching: 1=standard, 2=light, 3=cluster, 4=napalm
    const weaponKeys: Record<string, string> = {
      Digit1: "standard", Digit2: "light", Digit3: "cluster", Digit4: "napalm",
    };
    if (weaponKeys[event.code]) {
      const tank = this.tanks[this.currentTankIndex];
      if (tank?.alive) {
        const wKey = weaponKeys[event.code];
        const wDef = WEAPONS[wKey];
        if (wDef.cost === 0 || (tank.inventory.get(wKey) ?? 0) > 0) {
          tank.selectedWeapon = wKey;
        }
      }
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private readonly onMouseWheel = (event: WheelEvent) => {
    event.preventDefault();
    const scaleFactor = 1 + event.deltaY * this.cameraOrbit.wheelSensitivity;
    this.cameraOrbit.distance *= THREE.MathUtils.clamp(scaleFactor, 0.88, 1.12);
    this.applyCameraOrbit();
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button === 1) {
      event.preventDefault();
      this.cameraOrbit.yaw = 0;
      this.cameraOrbit.pitch = this.defaultOrbitPitch;
      this.applyCameraOrbit();
      return;
    }
    if (event.button !== 0) {
      return;
    }
    this.cameraOrbit.isDragging = true;
    this.cameraOrbit.lastX = event.clientX;
    this.cameraOrbit.lastY = event.clientY;
    this.canvas.style.cursor = "grabbing";
  };

  private readonly onMouseMove = (event: MouseEvent) => {
    if (!this.cameraOrbit.isDragging) {
      return;
    }
    const dx = event.clientX - this.cameraOrbit.lastX;
    const dy = event.clientY - this.cameraOrbit.lastY;
    this.cameraOrbit.lastX = event.clientX;
    this.cameraOrbit.lastY = event.clientY;

    this.cameraOrbit.yaw -= dx * this.cameraOrbit.dragSensitivityYaw;
    this.cameraOrbit.pitch -= dy * this.cameraOrbit.dragSensitivityPitch;
    this.applyCameraOrbit();
  };

  private readonly onMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }
    this.cameraOrbit.isDragging = false;
    this.canvas.style.cursor = "";
  };

  private readonly onMouseLeave = () => {
    this.cameraOrbit.isDragging = false;
    this.canvas.style.cursor = "";
  };

  private readonly onAuxClick = (event: MouseEvent) => {
    if (event.button === 1) {
      event.preventDefault();
    }
  };
}

// ---- Multiplayer Lobby ----

const LOBBY_SERVER_URL = "ws://localhost:3001";

interface LobbyPlayer {
  id: number;
  name: string;
  status: string;
}

class MenuSystem {
  private mount: HTMLElement;
  private splash: HTMLDivElement;
  private loadingScreen: HTMLDivElement;
  private loadingBarFill: HTMLDivElement;
  private loadingStatus: HTMLDivElement;
  private creditsModal: HTMLDivElement;
  private lobbyScreen: HTMLDivElement;
  private lobbyPlayers: HTMLDivElement;
  private lobbyStatus: HTMLDivElement;
  private invitePopup: HTMLDivElement;
  private ws: WebSocket | null = null;
  private myId = 0;
  private players: LobbyPlayer[] = [];

  constructor(mount: HTMLElement) {
    this.mount = mount;

    // ---- Splash Screen ----
    this.splash = document.createElement("div");
    this.splash.id = "splash-screen";
    this.splash.innerHTML = `
      <div class="splash-content">
        <h1 class="splash-title">ARTILLERY</h1>
        <p class="splash-subtitle">Tactical Tank Warfare</p>
        <div class="splash-menu">
          <button id="btn-singleplayer" class="menu-btn">SINGLE PLAYER</button>
          <button id="btn-hotseat" class="menu-btn">HOT SEAT</button>
          <button id="btn-multiplayer" class="menu-btn">MULTIPLAYER</button>
          <button id="btn-credits" class="menu-btn secondary">CREDITS</button>
        </div>
      </div>
    `;
    mount.appendChild(this.splash);

    // ---- Loading Screen ----
    this.loadingScreen = document.createElement("div");
    this.loadingScreen.id = "loading-screen";
    this.loadingScreen.style.display = "none";
    this.loadingScreen.innerHTML = `
      <div class="loading-title">ARTILLERY</div>
      <div class="loading-subtitle">Preparing the battlefield</div>
      <div class="loading-bar-track">
        <div class="loading-bar-fill" id="loading-bar-fill"></div>
      </div>
      <div class="loading-status" id="loading-status">Loading...</div>
    `;
    mount.appendChild(this.loadingScreen);
    this.loadingBarFill = this.loadingScreen.querySelector("#loading-bar-fill")!;
    this.loadingStatus = this.loadingScreen.querySelector("#loading-status")!;

    // ---- Credits ----
    this.creditsModal = document.createElement("div");
    this.creditsModal.id = "credits-modal";
    this.creditsModal.style.display = "none";
    this.creditsModal.innerHTML = `
      <div class="credits-content">
        <h2>CREDITS</h2>
        <p>Artillery &mdash; Tactical Tank Warfare</p>
        <p>Built with Three.js</p>
        <p>Tank Models: T-90A, Panzer III</p>
        <p>Environment: Kenney Graveyard Kit</p>
        <br>
        <button id="btn-credits-close" class="menu-btn secondary">BACK</button>
      </div>
    `;
    mount.appendChild(this.creditsModal);

    // ---- Lobby ----
    this.lobbyScreen = document.createElement("div");
    this.lobbyScreen.id = "lobby-screen";
    this.lobbyScreen.style.display = "none";
    this.lobbyScreen.innerHTML = `
      <div class="lobby-content">
        <h2>MULTIPLAYER LOBBY</h2>
        <div id="lobby-status">Connecting...</div>
        <div id="lobby-players"></div>
        <div id="lobby-invite-popup" style="display:none"></div>
        <button id="btn-lobby-back" class="menu-btn secondary">BACK</button>
      </div>
    `;
    mount.appendChild(this.lobbyScreen);

    this.lobbyPlayers = this.lobbyScreen.querySelector("#lobby-players")!;
    this.lobbyStatus = this.lobbyScreen.querySelector("#lobby-status")!;
    this.invitePopup = this.lobbyScreen.querySelector("#lobby-invite-popup")!;

    // Bind buttons
    document.getElementById("btn-singleplayer")!.addEventListener("click", () => this.startSinglePlayer());
    document.getElementById("btn-hotseat")!.addEventListener("click", () => this.startHotseat());
    document.getElementById("btn-multiplayer")!.addEventListener("click", () => this.showLobby());
    document.getElementById("btn-credits")!.addEventListener("click", () => this.showCredits());
    document.getElementById("btn-credits-close")!.addEventListener("click", () => this.hideCredits());
    document.getElementById("btn-lobby-back")!.addEventListener("click", () => this.hideLobby());
  }

  private startSinglePlayer() {
    this.splash.style.display = "none";
    this.showLoadingAndLaunch({ mode: "singleplayer" });
  }

  private startHotseat() {
    this.splash.style.display = "none";
    this.showLoadingAndLaunch({ mode: "hotseat" });
  }

  private showLoadingAndLaunch(config: GameConfig) {
    this.loadingScreen.style.display = "flex";
    this.loadingBarFill.style.width = "0%";
    this.loadingStatus.textContent = "Loading...";

    const canvas = document.createElement("canvas");
    canvas.id = "voxel-canvas";
    this.mount.appendChild(canvas);
    const game = new BurntSoil3D(canvas, config);
    void game.initialize((progress: number, label: string) => {
      this.loadingBarFill.style.width = `${Math.round(progress * 100)}%`;
      this.loadingStatus.textContent = label;
    }).then(() => {
      this.loadingBarFill.style.width = "100%";
      this.loadingStatus.textContent = "Ready";
      setTimeout(() => {
        this.loadingScreen.classList.add("fade-out");
        setTimeout(() => {
          this.loadingScreen.style.display = "none";
          this.loadingScreen.classList.remove("fade-out");
        }, 500);
      }, 300);
    });
  }

  // ---- Credits ----

  private showCredits() {
    this.creditsModal.style.display = "flex";
  }

  private hideCredits() {
    this.creditsModal.style.display = "none";
  }

  // ---- Lobby ----

  private showLobby() {
    this.splash.style.display = "none";
    this.lobbyScreen.style.display = "flex";
    this.connectToLobby();
  }

  private hideLobby() {
    this.lobbyScreen.style.display = "none";
    this.invitePopup.style.display = "none";
    this.splash.style.display = "flex";
    this.disconnectFromLobby();
  }

  private connectToLobby() {
    if (this.ws) return;
    this.lobbyStatus.textContent = "Connecting...";

    try {
      this.ws = new WebSocket(LOBBY_SERVER_URL);
    } catch {
      this.lobbyStatus.textContent = "Failed to connect. Is the server running?";
      return;
    }

    this.ws.addEventListener("open", () => {
      this.lobbyStatus.textContent = "Connected to lobby";
    });

    this.ws.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data));
      this.handleServerMessage(data);
    });

    this.ws.addEventListener("close", () => {
      this.lobbyStatus.textContent = "Disconnected from server";
      this.ws = null;
      this.players = [];
      this.renderLobbyPlayers();
    });

    this.ws.addEventListener("error", () => {
      this.lobbyStatus.textContent = "Connection error. Is the server running?";
      this.ws = null;
    });
  }

  private disconnectFromLobby() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.players = [];
  }

  private handleServerMessage(data: { type: string; [key: string]: unknown }) {
    switch (data.type) {
      case "welcome":
        this.myId = data.id as number;
        this.lobbyStatus.textContent = `Connected as ${data.name}`;
        break;

      case "lobby_update":
        this.players = data.players as LobbyPlayer[];
        this.renderLobbyPlayers();
        break;

      case "invite_received":
        this.showInvitePopup(data.from as { id: number; name: string });
        break;

      case "invite_declined":
        this.lobbyStatus.textContent = `${(data.by as { name: string }).name} declined your invite`;
        break;

      case "game_start": {
        this.lobbyScreen.style.display = "none";
        this.invitePopup.style.display = "none";
        // Keep the WebSocket open for game communication — don't disconnect
        const gameWs = this.ws;
        this.ws = null; // Prevent hideLobby from closing it
        this.showLoadingAndLaunch({
          mode: "multiplayer",
          seed: data.seed as number,
          role: data.role as "host" | "guest",
          gameId: data.gameId as string,
          ws: gameWs ?? undefined,
        });
        break;
      }
    }
  }

  private renderLobbyPlayers() {
    if (this.players.length === 0) {
      this.lobbyPlayers.innerHTML = `<p style="color:#555;text-align:center;padding:24px">No players in lobby</p>`;
      return;
    }

    this.lobbyPlayers.innerHTML = this.players
      .map((p) => {
        const isMe = p.id === this.myId;
        const nameClass = isMe ? "lobby-player-name is-you" : "lobby-player-name";
        const statusLabel =
          p.status === "in_game" ? "(in game)" : p.status === "inviting" ? "(inviting...)" : "";
        const canInvite = !isMe && p.status === "idle";
        const btnHtml = canInvite
          ? `<button class="invite-btn" data-id="${p.id}">INVITE</button>`
          : isMe
            ? `<span style="color:#555;font-size:11px">(you)</span>`
            : `<span class="lobby-player-status">${statusLabel}</span>`;
        return `<div class="lobby-player"><span class="${nameClass}">${this.escapeHtml(p.name)}</span>${btnHtml}</div>`;
      })
      .join("");

    this.lobbyPlayers.querySelectorAll(".invite-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = Number((btn as HTMLElement).dataset.id);
        this.sendInvite(targetId);
      });
    });
  }

  private sendInvite(targetId: number) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "invite", targetId }));
      this.lobbyStatus.textContent = "Invite sent...";
    }
  }

  private showInvitePopup(from: { id: number; name: string }) {
    this.invitePopup.style.display = "block";
    this.invitePopup.innerHTML = `
      <h3>BATTLE INVITE</h3>
      <p><strong>${this.escapeHtml(from.name)}</strong> challenges you!</p>
      <div class="invite-popup-btns">
        <button class="menu-btn" id="btn-accept-invite">ACCEPT</button>
        <button class="menu-btn secondary" id="btn-decline-invite">DECLINE</button>
      </div>
    `;

    document.getElementById("btn-accept-invite")!.addEventListener("click", () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "accept_invite", fromId: from.id }));
      }
      this.invitePopup.style.display = "none";
    });

    document.getElementById("btn-decline-invite")!.addEventListener("click", () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "decline_invite", fromId: from.id }));
      }
      this.invitePopup.style.display = "none";
    });
  }

  private escapeHtml(text: string): string {
    const el = document.createElement("span");
    el.textContent = text;
    return el.innerHTML;
  }
}

// ---- Bootstrap ----
const mount = document.getElementById("app");
if (!(mount instanceof HTMLElement)) {
  throw new TypeError("App root not found");
}
new MenuSystem(mount);
