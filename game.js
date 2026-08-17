import * as THREE from 'three';

// Custom FPS camera controls (replaces PointerLockControls which requires module imports)
class FPSControls extends THREE.EventDispatcher {
    constructor(camera, domElement) {
        super();
        this.camera = camera;
        this.domElement = domElement;
        this.isLocked = false;
        this.sensitivity = 0.002;

        // YXZ order is critical for proper FPS camera: yaw(Y) then pitch(X), no roll(Z)
        this.camera.rotation.reorder('YXZ');

        const onMouseMove = (event) => {
            if (!this.isLocked) return;
            const mx = event.movementX || 0;
            const my = event.movementY || 0;
            this.camera.rotation.y -= mx * this.sensitivity;
            this.camera.rotation.x -= my * this.sensitivity;
            // Clamp pitch so you can't flip upside down
            this.camera.rotation.x = Math.max(
                -Math.PI / 2 + 0.01,
                Math.min(Math.PI / 2 - 0.01, this.camera.rotation.x)
            );
            // NEVER allow roll
            this.camera.rotation.z = 0;
        };

        const onPointerLockChange = () => {
            const wasLocked = this.isLocked;
            this.isLocked = (document.pointerLockElement === this.domElement);
            if (this.isLocked && !wasLocked) {
                this.dispatchEvent({ type: 'lock' });
            } else if (!this.isLocked && wasLocked) {
                this.dispatchEvent({ type: 'unlock' });
            }
        };

        document.addEventListener('mousemove', onMouseMove, false);
        document.addEventListener('pointerlockchange', onPointerLockChange, false);
    }

    lock() {
        this.domElement.requestPointerLock();
    }

    unlock() {
        document.exitPointerLock();
    }
}


// --- DOM ELEMENTS ---
const $ = id => document.getElementById(id);
const dom = {
    container: $('game-container'),
    hud: $('hud'),
    crosshair: $('crosshair'),
    hitMarker: $('hit-marker'),
    damageOverlay: $('damage-overlay'),
    healthFill: $('health-fill'),
    healthText: $('health-text'),
    armorFill: $('armor-fill'),
    armorText: $('armor-text'),
    ammoCurrent: $('ammo-current'),
    ammoReserve: $('ammo-reserve'),
    weaponName: $('weapon-name'),
    ammoSection: $('ammo-section'),
    killFeed: $('kill-feed'),
    minimap: $('minimap-canvas'),
    scoreCt: $('score-ct'),
    scoreT: $('score-t'),
    roundTimer: $('round-timer'),
    fpsCounter: $('fps-counter'),
    startScreen: $('start-screen'),
    startBtn: $('start-btn'),
    deathScreen: $('death-screen'),
    deathKills: $('death-kills'),
    deathDeaths: $('death-deaths'),
    deathAccuracy: $('death-accuracy'),
    restartBtn: $('restart-btn'),
    pauseScreen: $('pause-screen'),
    resumeBtn: $('resume-btn')
};

// Ensure all DOM elements exist to avoid crashes
for(let key in dom) {
    if(!dom[key]) {
        console.warn(`DOM element ${key} not found. Creating dummy element.`);
        dom[key] = document.createElement('div');
    }
}

// --- GLOBAL GAME STATE ---
const GameState = {
    isStarted: false,
    isPaused: false,
    isGameOver: false,
    roundTimeLeft: 180,
    score: { ct: 0, t: 0 },
    lastTime: performance.now(),
    frames: 0,
    lastFpsTime: performance.now(),
    fps: 0,
    collidables: [],
    spawnPoints: []
};

// --- REUSABLE OBJECTS ---
const _vec3 = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();

// --- AUDIO SYSTEM ---
class AudioManager {
    constructor() {
        this.ctx = null;
        this.enabled = false;
    }
    
    init() {
        if (!this.ctx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext();
            this.enabled = true;
        }
    }

    createNoiseBuffer() {
        if (!this.ctx) return null;
        const bufferSize = this.ctx.sampleRate * 2;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const output = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        return buffer;
    }

    playTone(freq, type, duration, vol) {
        if (!this.enabled) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(vol, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
    }

    playNoise(duration, filterFreq, vol) {
        if (!this.enabled) return;
        const noiseSource = this.ctx.createBufferSource();
        noiseSource.buffer = this.createNoiseBuffer();
        
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = filterFreq;
        
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(vol, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        
        noiseSource.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);
        
        noiseSource.start();
        noiseSource.stop(this.ctx.currentTime + duration);
    }

    playGunshot(weaponName) {
        if (weaponName === 'AK-47') {
            this.playNoise(0.4, 2000, 0.8);
            this.playTone(100, 'square', 0.2, 0.4);
        } else {
            this.playNoise(0.2, 4000, 0.6);
            this.playTone(200, 'square', 0.1, 0.3);
        }
    }

    playHit() {
        this.playTone(800, 'sine', 0.05, 0.5);
    }

    playEnemyDeath() {
        this.playNoise(0.5, 500, 0.8);
    }

    playDamage() {
        this.playNoise(0.6, 300, 1.0);
    }

    playFootstep() {
        this.playNoise(0.05, 1000, 0.1);
    }

    playReload() {
        this.playTone(400, 'square', 0.1, 0.1);
        setTimeout(() => this.playTone(500, 'square', 0.1, 0.1), 300);
        setTimeout(() => this.playTone(300, 'square', 0.1, 0.1), 1000);
    }

    playPickup() {
        this.playTone(600, 'sine', 0.1, 0.3);
        setTimeout(() => this.playTone(800, 'sine', 0.15, 0.3), 100);
    }
}
const audio = new AudioManager();

// --- TEXTURE GENERATION ---
const Textures = {
    createCanvas(size) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        return { canvas, ctx: canvas.getContext('2d') };
    },
    
    createConcreteTexture() {
        const { canvas, ctx } = this.createCanvas(256);
        ctx.fillStyle = '#666';
        ctx.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 5000; i++) {
            ctx.fillStyle = Math.random() > 0.5 ? '#777' : '#555';
            ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        return tex;
    },

    createMetalTexture() {
        const { canvas, ctx } = this.createCanvas(256);
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, 256, 256);
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
        for (let i = 0; i < 100; i++) {
            ctx.beginPath();
            ctx.moveTo(Math.random() * 256, Math.random() * 256);
            ctx.lineTo(Math.random() * 256, Math.random() * 256);
            ctx.stroke();
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        return tex;
    },

    createWoodTexture() {
        const { canvas, ctx } = this.createCanvas(256);
        ctx.fillStyle = '#6b4423';
        ctx.fillRect(0, 0, 256, 256);
        ctx.strokeStyle = '#52341b';
        ctx.lineWidth = 2;
        for (let i = 0; i < 50; i++) {
            ctx.beginPath();
            let y = Math.random() * 256;
            ctx.moveTo(0, y);
            ctx.lineTo(256, y + (Math.random() * 20 - 10));
            ctx.stroke();
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        return tex;
    },

    createGroundTexture() {
        const { canvas, ctx } = this.createCanvas(512);
        ctx.fillStyle = '#4a4a4a';
        ctx.fillRect(0, 0, 512, 512);
        for (let i = 0; i < 20000; i++) {
            ctx.fillStyle = Math.random() > 0.5 ? '#555' : '#444';
            ctx.fillRect(Math.random() * 512, Math.random() * 512, 3, 3);
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(10, 10);
        return tex;
    }
};

// --- MAP GENERATION ---
class MapGenerator {
    constructor(scene) {
        this.scene = scene;
        this.concreteTex = Textures.createConcreteTexture();
        this.metalTex = Textures.createMetalTexture();
        this.woodTex = Textures.createWoodTexture();
        this.groundTex = Textures.createGroundTexture();
        
        this.concreteMat = new THREE.MeshStandardMaterial({ map: this.concreteTex, roughness: 0.8 });
        this.metalMat = new THREE.MeshStandardMaterial({ map: this.metalTex, roughness: 0.4, metalness: 0.6 });
        this.woodMat = new THREE.MeshStandardMaterial({ map: this.woodTex, roughness: 0.9 });
        this.groundMat = new THREE.MeshStandardMaterial({ map: this.groundTex, roughness: 1.0 });
    }

    build() {
        // Ground
        const groundGeo = new THREE.PlaneGeometry(120, 120);
        const ground = new THREE.Mesh(groundGeo, this.groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.scene.add(ground);

        // Perimeter Walls
        const wallGeoX = new THREE.BoxGeometry(120, 8, 2);
        const wallGeoZ = new THREE.BoxGeometry(2, 8, 120);
        const wallProps = [
            { geo: wallGeoX, pos: [0, 4, -60] },
            { geo: wallGeoX, pos: [0, 4, 60] },
            { geo: wallGeoZ, pos: [-60, 4, 0] },
            { geo: wallGeoZ, pos: [60, 4, 0] }
        ];

        wallProps.forEach(w => {
            const wall = new THREE.Mesh(w.geo, this.concreteMat);
            wall.position.set(...w.pos);
            wall.castShadow = true;
            wall.receiveShadow = true;
            this.scene.add(wall);
            GameState.collidables.push(wall);
        });

        // Buildings
        this.createBuilding(15, 0, 15, 10, 6, 8);
        this.createBuilding(-20, 0, -20, 14, 8, 6);
        this.createBuilding(25, 0, -10, 8, 6, 4);
        this.createBuilding(-30, 0, 20, 12, 6, 8);
        this.createBuilding(0, 0, -35, 16, 5, 5);
        this.createBuilding(40, 0, 40, 10, 5, 8);

        // Crates & Cover
        for (let i = 0; i < 20; i++) {
            const type = Math.random();
            let size, mat, y;
            if (type < 0.4) {
                size = [1, 1, 1]; mat = this.woodMat; y = 0.5;
            } else if (type < 0.7) {
                size = [2, 2, 2]; mat = this.metalMat; y = 1;
            } else {
                size = [4, 1.5, 0.3]; mat = this.concreteMat; y = 0.75;
            }
            
            let pos;
            do {
                pos = new THREE.Vector3((Math.random() - 0.5) * 100, y, (Math.random() - 0.5) * 100);
            } while(pos.distanceTo(new THREE.Vector3(0,0,0)) < 10); // avoid center
            
            const geo = new THREE.BoxGeometry(...size);
            const crate = new THREE.Mesh(geo, mat);
            crate.position.copy(pos);
            crate.rotation.y = Math.random() * Math.PI;
            crate.castShadow = true;
            crate.receiveShadow = true;
            this.scene.add(crate);
            GameState.collidables.push(crate);
        }

        // Spawn points
        GameState.spawnPoints = [
            new THREE.Vector3(50, 1.7, 50),
            new THREE.Vector3(-50, 1.7, -50),
            new THREE.Vector3(50, 1.7, -50),
            new THREE.Vector3(-50, 1.7, 50),
            new THREE.Vector3(0, 1.7, 50),
            new THREE.Vector3(0, 1.7, -50)
        ];
    }

    createBuilding(x, y, z, w, h, d) {
        const group = new THREE.Group();
        group.position.set(x, y, z);
        
        const mat = Math.random() > 0.5 ? this.concreteMat : this.metalMat;
        
        // Simple solid box for building
        const geo = new THREE.BoxGeometry(w, h, d);
        const b = new THREE.Mesh(geo, mat);
        b.position.y = h / 2;
        b.castShadow = true;
        b.receiveShadow = true;
        group.add(b);
        
        this.scene.add(group);
        GameState.collidables.push(b);
    }
}

// --- PARTICLE SYSTEM ---
class ParticleSystem {
    constructor(scene) {
        this.scene = scene;
        this.particles = [];
        this.geoBox = new THREE.BoxGeometry(1, 1, 1);
        this.mats = {
            flash: new THREE.MeshBasicMaterial({ color: 0xffaa00 }),
            impact: new THREE.MeshBasicMaterial({ color: 0x888888 }),
            blood: new THREE.MeshBasicMaterial({ color: 0x880000 })
        };
    }

    emit(type, pos, normal) {
        let count, life, size, speed, mat, hasGravity;
        if (type === 'flash') {
            count = 6; life = 0.08; size = 0.05; speed = 5; mat = this.mats.flash; hasGravity = false;
        } else if (type === 'impact') {
            count = 10; life = 0.4; size = 0.03; speed = 3; mat = this.mats.impact; hasGravity = true;
        } else if (type === 'blood') {
            count = 8; life = 0.5; size = 0.04; speed = 2; mat = this.mats.blood; hasGravity = true;
        }

        for (let i = 0; i < count; i++) {
            const p = new THREE.Mesh(this.geoBox, mat);
            p.scale.set(size, size, size);
            p.position.copy(pos);
            
            const vel = new THREE.Vector3(
                (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 2
            ).normalize();
            
            if (normal) {
                vel.add(normal).normalize();
            }
            
            vel.multiplyScalar(speed * (0.5 + Math.random() * 0.5));
            
            this.scene.add(p);
            this.particles.push({
                mesh: p,
                vel: vel,
                life: life,
                maxLife: life,
                hasGravity: hasGravity
            });
        }
    }

    update(dt) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.life -= dt;
            if (p.life <= 0) {
                this.scene.remove(p.mesh);
                this.particles.splice(i, 1);
                continue;
            }
            
            if (p.hasGravity) p.vel.y -= 9.8 * dt;
            
            p.mesh.position.addScaledVector(p.vel, dt);
            
            const scale = p.life / p.maxLife;
            p.mesh.scale.setScalar(scale * 0.05); // Assuming original size ~0.05
        }
    }
}

// --- PICKUP SYSTEM ---
class Pickup {
    constructor(scene, type, position) {
        this.scene = scene;
        this.type = type; // 'ammo' or 'health'
        this.active = true;
        this.respawnTime = 15; // seconds
        this.respawnTimer = 0;
        this.bobPhase = Math.random() * Math.PI * 2;
        this.baseY = 0.5;

        this.mesh = new THREE.Group();
        this.buildMesh();
        this.mesh.position.copy(position);
        this.mesh.position.y = this.baseY;
        this.scene.add(this.mesh);

        // Glow light
        const color = type === 'ammo' ? 0x44ff44 : 0xff4444;
        this.light = new THREE.PointLight(color, 0.8, 6);
        this.light.position.y = 0.5;
        this.mesh.add(this.light);
    }

    buildMesh() {
        if (this.type === 'ammo') {
            // Ammo box — green/olive box with yellow stripe
            const boxMat = new THREE.MeshStandardMaterial({ color: 0x556b2f, emissive: 0x223311, emissiveIntensity: 0.3 });
            const stripeMat = new THREE.MeshStandardMaterial({ color: 0xffd700, emissive: 0x886600, emissiveIntensity: 0.5 });
            const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.35, 0.4), boxMat);
            const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.42), stripeMat);
            stripe.position.y = 0.05;
            this.mesh.add(box, stripe);
        } else {
            // Health pack — white box with red cross
            const boxMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x331111, emissiveIntensity: 0.3 });
            const crossMat = new THREE.MeshStandardMaterial({ color: 0xff0000, emissive: 0xff0000, emissiveIntensity: 0.5 });
            const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.5), boxMat);
            const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.05, 0.12), crossMat);
            crossH.position.y = 0.18;
            const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.35), crossMat);
            crossV.position.y = 0.18;
            this.mesh.add(box, crossH, crossV);
        }
    }

    update(dt, player, weaponMgr) {
        if (!this.active) {
            this.respawnTimer -= dt;
            if (this.respawnTimer <= 0) {
                this.active = true;
                // Respawn at a new random location
                const pos = GameState.spawnPoints[Math.floor(Math.random() * GameState.spawnPoints.length)];
                this.mesh.position.set(pos.x + (Math.random() - 0.5) * 10, this.baseY, pos.z + (Math.random() - 0.5) * 10);
            }
            return;
        }

        // Floating bob + rotation animation
        this.bobPhase += dt * 2;
        this.mesh.position.y = this.baseY + Math.sin(this.bobPhase) * 0.15;
        this.mesh.rotation.y += dt * 1.5;

        // Pulse the glow
        this.light.intensity = 0.5 + Math.sin(this.bobPhase * 2) * 0.3;

        // Check player proximity
        const dx = player.position.x - this.mesh.position.x;
        const dz = player.position.z - this.mesh.position.z;
        const distSq = dx * dx + dz * dz;

        if (distSq < 2.5) { // ~1.6 unit pickup radius
            this.collect(player, weaponMgr);
        }
    }

    collect(player, weaponMgr) {
        if (this.type === 'ammo') {
            const w = weaponMgr.getCurrent();
            const WEAPS = weaponMgr.weapons;
            // Refill both weapons
            WEAPS[0].reserveAmmo = Math.min(WEAPS[0].reserveAmmo + 30, 120);
            WEAPS[1].reserveAmmo = Math.min(WEAPS[1].reserveAmmo + 12, 48);
            weaponMgr.updateHUD();
        } else {
            player.health = Math.min(player.health + 35, 100);
            player.armor = Math.min(player.armor + 20, 100);
            dom.healthFill.style.width = player.health + '%';
            dom.healthText.textContent = Math.floor(player.health);
            dom.armorFill.style.width = player.armor + '%';
            dom.armorText.textContent = Math.floor(player.armor);
        }

        audio.playPickup();
        this.active = false;
        // Instead of making the light invisible (which forces Three.js to recompile all shaders and causes lag), we just move it far away
        this.mesh.position.y = -1000;
        this.respawnTimer = this.respawnTime;
    }
}

class PickupManager {
    constructor(scene) {
        this.scene = scene;
        this.pickups = [];

        // Spawn pickup locations spread around the map
        const pickupSpots = [
            new THREE.Vector3(10, 0, 10),
            new THREE.Vector3(-15, 0, 25),
            new THREE.Vector3(30, 0, -5),
            new THREE.Vector3(-35, 0, -15),
            new THREE.Vector3(5, 0, -30),
            new THREE.Vector3(-10, 0, 40),
            new THREE.Vector3(45, 0, 35),
            new THREE.Vector3(-45, 0, -40),
            new THREE.Vector3(20, 0, 45),
            new THREE.Vector3(-25, 0, -35),
        ];

        // Alternate ammo and health pickups
        pickupSpots.forEach((pos, i) => {
            const type = i % 2 === 0 ? 'ammo' : 'health';
            this.pickups.push(new Pickup(scene, type, pos));
        });
    }

    update(dt, player, weaponMgr) {
        this.pickups.forEach(p => p.update(dt, player, weaponMgr));
    }

    // Get active pickup positions for minimap
    getActivePositions() {
        return this.pickups.filter(p => p.active).map(p => ({
            x: p.mesh.position.x,
            z: p.mesh.position.z,
            type: p.type
        }));
    }
}

// --- WEAPON SYSTEM ---
const WEAPONS = [
    {
        name: 'AK-47',
        damage: 28,
        fireRate: 0.1,
        magSize: 30,
        currentAmmo: 30,
        reserveAmmo: 90,
        spread: 0.02,
        recoilAmount: 0.01,
        range: 200,
        reloadTime: 2.5,
        auto: true
    },
    {
        name: 'USP-S',
        damage: 35,
        fireRate: 0.2,
        magSize: 12,
        currentAmmo: 12,
        reserveAmmo: 36,
        spread: 0.01,
        recoilAmount: 0.015,
        range: 150,
        reloadTime: 1.8,
        auto: false
    }
];

class WeaponManager {
    constructor(camera, scene) {
        this.camera = camera;
        this.scene = scene;
        this.weapons = JSON.parse(JSON.stringify(WEAPONS)); // Deep copy
        this.currentIdx = 0;
        this.group = new THREE.Group();
        this.camera.add(this.group);
        this.group.position.set(0.3, -0.25, -0.5);
        
        this.lastShotTime = 0;
        this.isReloading = false;
        this.reloadTimer = 0;
        this.isSwitching = false;
        this.switchTimer = 0;
        this.recoilOffset = 0;
        this.bobTime = 0;
        this.isAiming = false;

        this.models = [];
        this.buildModels();
        this.equipWeapon(0);
        
        this.muzzleLight = new THREE.PointLight(0xffaa00, 0, 10);
        this.muzzleLight.position.set(0.3, -0.2, -1);
        this.camera.add(this.muzzleLight);
    }

    buildModels() {
        // AK47
        const akGroup = new THREE.Group();
        const akMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x5c3a21 });
        
        const akBody = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.4), akMat);
        const akBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.3), akMat);
        akBarrel.rotation.x = Math.PI / 2;
        akBarrel.position.set(0, 0.02, -0.3);
        const akGrip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.15, 0.08), woodMat);
        akGrip.position.set(0, -0.1, 0.1);
        akGrip.rotation.x = Math.PI / 8;
        const akMag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.15, 0.1), akMat);
        akMag.position.set(0, -0.1, -0.1);
        akMag.rotation.x = -Math.PI / 8;
        
        akGroup.add(akBody, akBarrel, akGrip, akMag);
        this.models.push(akGroup);

        // USP-S
        const uspGroup = new THREE.Group();
        const uspMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
        
        const uspBody = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.25), uspMat);
        const uspGrip = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.12, 0.06), uspMat);
        uspGrip.position.set(0, -0.08, 0.08);
        uspGrip.rotation.x = Math.PI / 10;
        const uspSilencer = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.15), uspMat);
        uspSilencer.rotation.x = Math.PI / 2;
        uspSilencer.position.set(0, 0, -0.2);
        
        uspGroup.add(uspBody, uspGrip, uspSilencer);
        this.models.push(uspGroup);
    }

    equipWeapon(idx) {
        this.group.clear();
        this.group.add(this.models[idx]);
        this.currentIdx = idx;
        this.isReloading = false;
        this.updateHUD();
    }

    switchWeapon(idx) {
        if (idx === this.currentIdx || this.isSwitching) return;
        this.isSwitching = true;
        this.switchTimer = 0.3;
        this.switchTarget = idx;
        this.isReloading = false;
    }

    reload() {
        const w = this.weapons[this.currentIdx];
        if (this.isReloading || w.currentAmmo === w.magSize || w.reserveAmmo <= 0 || this.isSwitching) return;
        this.isReloading = true;
        this.reloadTimer = w.reloadTime;
        audio.playReload();
    }

    getCurrent() {
        return this.weapons[this.currentIdx];
    }

    update(dt, isMoving) {
        const w = this.getCurrent();
        
        // Timers
        if (this.isSwitching) {
            this.switchTimer -= dt;
            this.group.position.y = -0.25 - Math.sin((this.switchTimer / 0.3) * Math.PI) * 0.5;
            if (this.switchTimer <= 0) {
                this.isSwitching = false;
                this.equipWeapon(this.switchTarget);
            }
        } else if (this.isReloading) {
            this.reloadTimer -= dt;
            this.group.position.y = -0.25 - Math.sin((this.reloadTimer / w.reloadTime) * Math.PI) * 0.3;
            this.group.rotation.x = Math.sin((this.reloadTimer / w.reloadTime) * Math.PI) * 0.5;
            if (this.reloadTimer <= 0) {
                this.isReloading = false;
                const needed = w.magSize - w.currentAmmo;
                const take = Math.min(needed, w.reserveAmmo);
                w.currentAmmo += take;
                w.reserveAmmo -= take;
                this.updateHUD();
            }
        } else {
            // ADS Logic
            const targetFov = this.isAiming ? 45 : 70;
            this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, dt * 10);
            this.camera.updateProjectionMatrix();

            const aimOffsetX = this.isAiming ? 0 : 0.3;
            const aimOffsetY = this.isAiming ? -0.15 : -0.25;

            // Bobbing & Recoil return
            this.recoilOffset = THREE.MathUtils.lerp(this.recoilOffset, 0, dt * 10);
            
            if (isMoving && !this.isAiming) {
                this.bobTime += dt * 10;
                this.group.position.x = aimOffsetX + Math.sin(this.bobTime * 0.5) * 0.02;
                this.group.position.y = aimOffsetY + Math.abs(Math.cos(this.bobTime * 0.5)) * 0.02 - this.recoilOffset * 0.1;
            } else {
                this.group.position.x = THREE.MathUtils.lerp(this.group.position.x, aimOffsetX, dt * 15);
                this.group.position.y = THREE.MathUtils.lerp(this.group.position.y, aimOffsetY - this.recoilOffset * 0.1, dt * 15);
            }
            this.group.rotation.x = this.recoilOffset;
        }

        // Muzzle light decay
        if (this.muzzleLight.intensity > 0) {
            this.muzzleLight.intensity -= dt * 50;
        }
    }

    shoot(player, particles, enemies) {
        const w = this.getCurrent();
        const now = performance.now() / 1000;
        if (this.isReloading || this.isSwitching || now - this.lastShotTime < w.fireRate) return;
        
        if (w.currentAmmo <= 0) {
            if (!this.isReloading) this.reload();
            return;
        }

        w.currentAmmo--;
        player.stats.shotsFired++;
        this.lastShotTime = now;
        this.updateHUD();

        // Recoil - reduced when aiming
        const recoilMod = this.isAiming ? 0.5 : 1;
        this.recoilOffset = w.recoilAmount * recoilMod;
        this.camera.rotation.x += w.recoilAmount * 0.5 * recoilMod;

        // Visuals
        audio.playGunshot(w.name);
        this.muzzleLight.intensity = 2;
        
        const flashX = this.isAiming ? 0 : 0.3;
        const flashY = this.isAiming ? -0.15 : -0.2;
        const tipPos = new THREE.Vector3(flashX, flashY, -0.8).applyMatrix4(this.camera.matrixWorld);
        particles.emit('flash', tipPos);

        // Crosshair expand (less if aiming)
        dom.crosshair.style.setProperty('--spread', this.isAiming ? '10px' : '20px');
        setTimeout(() => dom.crosshair.style.setProperty('--spread', '5px'), 100);

        // Raycast
        this.camera.getWorldDirection(_direction);
        const spreadMod = this.isAiming ? 0.3 : 1;
        _direction.x += (Math.random() - 0.5) * w.spread * spreadMod;
        _direction.y += (Math.random() - 0.5) * w.spread * spreadMod;
        _direction.z += (Math.random() - 0.5) * w.spread * spreadMod;
        _direction.normalize();

        _raycaster.set(this.camera.getWorldPosition(_origin), _direction);
        
        // Collect targets: enemies + collidables
        let targets = [];
        enemies.forEach(e => {
            if (e.state !== 'DEAD') targets.push(e.mesh);
        });
        targets.push(...GameState.collidables);

        const intersects = _raycaster.intersectObjects(targets, true);

        if (intersects.length > 0) {
            const hit = intersects[0];
            
            // Check if it's an enemy
            let enemyHit = false;
            enemies.forEach(e => {
                if (e.mesh === hit.object || e.mesh.children.includes(hit.object)) {
                    e.takeDamage(w.damage, player);
                    particles.emit('blood', hit.point, hit.face ? hit.face.normal : new THREE.Vector3(0,1,0));
                    player.stats.shotsHit++;
                    enemyHit = true;
                    
                    dom.hitMarker.classList.add('active');
                    setTimeout(() => dom.hitMarker.classList.remove('active'), 100);
                    audio.playHit();
                }
            });

            if (!enemyHit) {
                particles.emit('impact', hit.point, hit.face.normal);
            }
        }
    }

    updateHUD() {
        const w = this.getCurrent();
        dom.weaponName.textContent = w.name;
        dom.ammoCurrent.textContent = w.currentAmmo;
        dom.ammoReserve.textContent = w.reserveAmmo;
        if (w.currentAmmo <= 5) {
            dom.ammoSection.classList.add('ammo-low');
        } else {
            dom.ammoSection.classList.remove('ammo-low');
        }
    }
}

// --- ENEMY SYSTEM ---
class Enemy {
    constructor(scene) {
        this.scene = scene;
        this.health = 100;
        this.maxHealth = 100;
        this.speed = 3;
        this.state = 'PATROL';
        this.targetPoint = new THREE.Vector3();
        this.lastShotTime = 0;
        this.fireRate = 0.8;
        this.damage = 12;
        this.detectionRange = 30;
        this.attackRange = 25;
        this.accuracy = 0.15;
        
        this.mesh = new THREE.Group();
        this.buildMesh();
        this.scene.add(this.mesh);
        this.spawn();
    }

    buildMesh() {
        const mat = new THREE.MeshStandardMaterial({ color: 0xdd4422 });
        
        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1, 0.4), mat);
        torso.position.y = 1;
        torso.castShadow = true;
        
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), mat);
        head.position.y = 1.8;
        head.castShadow = true;
        
        this.legL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.8, 0.3), mat);
        this.legL.position.set(-0.2, 0.4, 0);
        this.legL.castShadow = true;
        
        this.legR = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.8, 0.3), mat);
        this.legR.position.set(0.2, 0.4, 0);
        this.legR.castShadow = true;
        
        this.mesh.add(torso, head, this.legL, this.legR);
        
        // Health bar
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 8;
        this.hpCtx = canvas.getContext('2d');
        this.hpTex = new THREE.CanvasTexture(canvas);
        const hpMat = new THREE.MeshBasicMaterial({ map: this.hpTex, transparent: true });
        this.hpBar = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.15), hpMat);
        this.hpBar.position.y = 2.4;
        this.mesh.add(this.hpBar);
        this.updateHealthBar();
    }

    updateHealthBar() {
        this.hpCtx.clearRect(0,0,64,8);
        this.hpCtx.fillStyle = '#f00';
        this.hpCtx.fillRect(0,0,64,8);
        this.hpCtx.fillStyle = '#0f0';
        this.hpCtx.fillRect(0,0,64 * (this.health / this.maxHealth),8);
        this.hpTex.needsUpdate = true;
    }

    spawn() {
        this.health = this.maxHealth;
        this.state = 'PATROL';
        this.updateHealthBar();
        this.hpBar.visible = true;
        
        // Stand up
        this.mesh.rotation.x = 0;
        
        const spawn = GameState.spawnPoints[Math.floor(Math.random() * GameState.spawnPoints.length)];
        this.mesh.position.set(spawn.x, 0, spawn.z); // y=0, enemies are built from ground up
        this.pickNewTarget();
    }

    pickNewTarget() {
        this.targetPoint.copy(GameState.spawnPoints[Math.floor(Math.random() * GameState.spawnPoints.length)]);
    }

    takeDamage(amt, player) {
        if (this.state === 'DEAD') return;
        this.health -= amt;
        this.updateHealthBar();
        if (this.health <= 0) {
            this.die(player);
        } else {
            this.state = 'CHASE'; // Aggro on hit
        }
    }

    die(player) {
        this.state = 'DEAD';
        this.hpBar.visible = false;
        audio.playEnemyDeath();
        
        // Death animation
        this.mesh.rotation.x = -Math.PI / 2;
        this.mesh.position.y = 0.5;
        
        if (player) {
            player.stats.kills++;
            GameState.score.ct++;
            dom.scoreCt.textContent = GameState.score.ct;
        }
        addKillFeedEntry('Player', 'Enemy');
        
        setTimeout(() => {
            if (!GameState.isGameOver) this.spawn();
        }, 5000);
    }

    update(dt, player, particles) {
        if (this.state === 'DEAD' || !player.isAlive) return;

        const distToPlayer = this.mesh.position.distanceTo(player.position);
        
        // Line of sight check
        let hasLOS = false;
        if (distToPlayer < this.detectionRange) {
            _direction.subVectors(player.position, this.mesh.position).normalize();
            _raycaster.set(this.mesh.position.clone().setY(1.5), _direction);
            const intersects = _raycaster.intersectObjects(GameState.collidables, true);
            if (intersects.length === 0 || intersects[0].distance > distToPlayer) {
                hasLOS = true;
            }
        }

        // State machine
        if (this.state === 'PATROL') {
            if (hasLOS) {
                this.state = 'CHASE';
            } else {
                this.moveTowards(this.targetPoint, dt);
                if (this.mesh.position.distanceTo(this.targetPoint) < 2) {
                    this.pickNewTarget();
                }
            }
        } else if (this.state === 'CHASE') {
            if (!hasLOS && distToPlayer > this.detectionRange) {
                this.state = 'PATROL';
                this.pickNewTarget();
            } else if (hasLOS && distToPlayer < this.attackRange) {
                this.state = 'ATTACK';
            } else {
                this.moveTowards(player.position, dt);
            }
        } else if (this.state === 'ATTACK') {
            if (!hasLOS || distToPlayer > this.attackRange) {
                this.state = 'CHASE';
            } else {
                this.mesh.lookAt(player.position.x, this.mesh.position.y, player.position.z);
                this.shootAt(player, particles);
            }
        }

        // Billboard health bar
        this.hpBar.lookAt(player.camera.position);
    }

    moveTowards(target, dt) {
        _direction.subVectors(target, this.mesh.position);
        _direction.y = 0;
        if (_direction.lengthSq() > 0.1) {
            _direction.normalize();
            this.mesh.position.addScaledVector(_direction, this.speed * dt);
            this.mesh.lookAt(target.x, this.mesh.position.y, target.z);
            
            // Walk anim
            const time = performance.now() * 0.01;
            this.legL.rotation.x = Math.sin(time) * 0.5;
            this.legR.rotation.x = Math.sin(time + Math.PI) * 0.5;
        }
    }

    shootAt(player, particles) {
        const now = performance.now() / 1000;
        if (now - this.lastShotTime > this.fireRate) {
            this.lastShotTime = now;
            
            // Muzzle flash
            particles.emit('flash', this.mesh.position.clone().add(new THREE.Vector3(0, 1.5, 0)));
            
            // Accuracy roll
            if (Math.random() > this.accuracy) {
                // Hit player
                player.takeDamage(this.damage);
                dom.damageOverlay.classList.add('active');
                setTimeout(() => dom.damageOverlay.classList.remove('active'), 100);
            }
        }
    }
}

// --- PLAYER CONTROLLER ---
class Player {
    constructor(camera, scene) {
        this.camera = camera;
        this.scene = scene;
        this.controls = new FPSControls(camera, document.body);
        
        // Add the camera to the scene so child objects (weapons) render properly
        this.scene.add(this.camera);
        
        this.position = this.camera.position;
        this.position.set(0, 1.7, 0);
        
        this.velocity = new THREE.Vector3();
        this._forward = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._moveDir = new THREE.Vector3();
        
        this.isAlive = true;
        this.health = 100;
        this.armor = 100;
        this.stats = { kills: 0, deaths: 0, shotsFired: 0, shotsHit: 0 };
        
        this.keys = { w: false, a: false, s: false, d: false, shift: false, space: false };
        
        this.walkSpeed = 6;
        this.sprintSpeed = 10;
        this.jumpVelocity = 8;
        this.gravity = 22;
        this.onGround = false;
        this.bobPhase = 0;
        
        this.setupInputs();
    }

    setupInputs() {
        document.addEventListener('keydown', e => this.onKey(e.code, true));
        document.addEventListener('keyup', e => this.onKey(e.code, false));
    }

    onKey(code, isDown) {
        switch(code) {
            case 'KeyW': case 'ArrowUp':    this.keys.w = isDown; break;
            case 'KeyA': case 'ArrowLeft':  this.keys.a = isDown; break;
            case 'KeyS': case 'ArrowDown':  this.keys.s = isDown; break;
            case 'KeyD': case 'ArrowRight': this.keys.d = isDown; break;
            case 'ShiftLeft': case 'ShiftRight': this.keys.shift = isDown; break;
            case 'Space': 
                if (isDown && this.onGround && this.isAlive && !GameState.isPaused) {
                    this.velocity.y = this.jumpVelocity;
                    this.onGround = false;
                }
                break;
        }
    }

    takeDamage(amt) {
        if (!this.isAlive) return;
        audio.playDamage();
        
        if (this.armor > 0) {
            const block = Math.min(amt, this.armor);
            this.armor -= block;
            amt -= block;
        }
        
        this.health -= amt;
        
        dom.healthFill.style.width = Math.max(0, this.health) + '%';
        dom.healthText.textContent = Math.max(0, Math.floor(this.health));
        dom.armorFill.style.width = Math.max(0, this.armor) + '%';
        dom.armorText.textContent = Math.max(0, Math.floor(this.armor));
        
        if (this.health <= 0) {
            this.die();
        }
    }

    die() {
        this.isAlive = false;
        this.stats.deaths++;
        GameState.isGameOver = true;
        this.controls.unlock();
        dom.hud.style.display = 'none';
        dom.deathScreen.style.display = 'flex';
        
        dom.deathKills.textContent = this.stats.kills;
        dom.deathDeaths.textContent = this.stats.deaths;
        const acc = this.stats.shotsFired > 0 ? Math.round((this.stats.shotsHit / this.stats.shotsFired) * 100) : 0;
        dom.deathAccuracy.textContent = acc + '%';
    }

    respawn() {
        this.isAlive = true;
        this.health = 100;
        this.armor = 100;
        GameState.isGameOver = false;
        
        dom.healthFill.style.width = '100%';
        dom.healthText.textContent = '100';
        dom.armorFill.style.width = '100%';
        dom.armorText.textContent = '100';
        
        const spawn = GameState.spawnPoints[Math.floor(Math.random() * GameState.spawnPoints.length)];
        this.position.copy(spawn);
        this.velocity.set(0,0,0);
        
        dom.deathScreen.style.display = 'none';
        dom.hud.style.display = 'block';
        this.controls.lock();
    }

    checkCollisions() {
        // Floor
        if (this.position.y <= 1.7) {
            this.position.y = 1.7;
            this.velocity.y = 0;
            this.onGround = true;
        }

        // Walls — cast rays in 8 directions for better coverage
        const radius = 0.5;
        const dirs = [
            new THREE.Vector3(1,0,0), new THREE.Vector3(-1,0,0),
            new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,-1),
            new THREE.Vector3(0.707,0,0.707), new THREE.Vector3(-0.707,0,0.707),
            new THREE.Vector3(0.707,0,-0.707), new THREE.Vector3(-0.707,0,-0.707)
        ];

        for (const dir of dirs) {
            _raycaster.set(this.position, dir);
            _raycaster.far = radius;
            const intersects = _raycaster.intersectObjects(GameState.collidables, true);
            if (intersects.length > 0) {
                const pushDist = radius - intersects[0].distance;
                this.position.addScaledVector(dir, -pushDist);
                // Kill velocity in that direction
                const dot = this.velocity.dot(dir);
                if (dot > 0) this.velocity.addScaledVector(dir, -dot);
            }
        }
        _raycaster.far = Infinity;
    }

    update(dt) {
        if (!this.isAlive) return false;

        // Gravity
        this.velocity.y -= this.gravity * dt;

        // Get camera forward/right vectors projected onto XZ plane
        this.camera.getWorldDirection(this._forward);
        this._forward.y = 0;
        this._forward.normalize();

        this._right.crossVectors(this._forward, new THREE.Vector3(0, 1, 0));

        // Input
        const inputZ = Number(this.keys.w) - Number(this.keys.s); // forward/back
        const inputX = Number(this.keys.d) - Number(this.keys.a); // right/left
        const hasInput = inputZ !== 0 || inputX !== 0;

        const speed = this.keys.shift ? this.sprintSpeed : this.walkSpeed;

        if (hasInput) {
            // Combine forward and right based on input
            this._moveDir.set(0, 0, 0);
            this._moveDir.addScaledVector(this._forward, inputZ);
            this._moveDir.addScaledVector(this._right, inputX);
            this._moveDir.normalize();

            this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, this._moveDir.x * speed, dt * 12);
            this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, this._moveDir.z * speed, dt * 12);
            
            // Footstep sounds
            if (this.onGround && Math.random() < 0.04) audio.playFootstep();
        } else {
            // Decelerate
            this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, 0, dt * 12);
            this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, 0, dt * 12);
        }

        // Apply velocity
        this.position.x += this.velocity.x * dt;
        this.position.y += this.velocity.y * dt;
        this.position.z += this.velocity.z * dt;
        
        this.checkCollisions();

        // Check if moving for weapon bob / crosshair
        const isMoving = Math.abs(this.velocity.x) > 0.5 || Math.abs(this.velocity.z) > 0.5;
        return isMoving;
    }
}

// --- UTILS ---
function addKillFeedEntry(killer, victim) {
    const div = document.createElement('div');
    div.className = 'kill-entry';
    div.innerHTML = `<span class="killer-name">${killer}</span> <span class="kill-icon">✕</span> <span class="victim-name">${victim}</span>`;
    dom.killFeed.appendChild(div);
    setTimeout(() => {
        if (div.parentNode) div.parentNode.removeChild(div);
    }, 5000);
}

// --- MAIN GAME ENGINE ---
class Game {
    constructor() {
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        dom.container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color('#1a1a2e');
        this.scene.fog = new THREE.Fog('#1a1a2e', 0, 150);

        this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);
        
        this.setupLighting();
        
        this.mapGen = new MapGenerator(this.scene);
        this.mapGen.build();

        this.particles = new ParticleSystem(this.scene);
        this.player = new Player(this.camera, this.scene);
        this.weaponMgr = new WeaponManager(this.camera, this.scene);
        
        this.enemies = [];
        for(let i=0; i<6; i++) {
            this.enemies.push(new Enemy(this.scene));
        }

        this.pickupMgr = new PickupManager(this.scene);

        this.inputState = { mouseDown: false };
        
        this.setupEvents();
        
        this.miniCtx = dom.minimap.getContext('2d');
        
        window.addEventListener('resize', () => this.onResize());
        
        requestAnimationFrame((t) => this.loop(t));
    }

    setupLighting() {
        const hemiLight = new THREE.HemisphereLight('#87CEEB', '#444444', 0.6);
        this.scene.add(hemiLight);

        const dirLight = new THREE.DirectionalLight('#FDB813', 1.2);
        dirLight.position.set(50, 80, 30);
        dirLight.castShadow = true;
        dirLight.shadow.mapSize.width = 2048;
        dirLight.shadow.mapSize.height = 2048;
        dirLight.shadow.camera.left = -60;
        dirLight.shadow.camera.right = 60;
        dirLight.shadow.camera.top = 60;
        dirLight.shadow.camera.bottom = -60;
        dirLight.shadow.camera.near = 0.5;
        dirLight.shadow.camera.far = 200;
        dirLight.shadow.bias = -0.001;
        this.scene.add(dirLight);

        const ambLight = new THREE.AmbientLight('#404060', 0.3);
        this.scene.add(ambLight);
    }

    setupEvents() {
        dom.startBtn.addEventListener('click', () => {
            audio.init();
            dom.startScreen.style.display = 'none';
            dom.hud.style.display = 'block';
            this.player.controls.lock();
            GameState.isStarted = true;
        });

        dom.restartBtn.addEventListener('click', () => {
            this.player.respawn();
            this.enemies.forEach(e => e.spawn());
            this.player.stats.kills = 0;
            this.weaponMgr.weapons = JSON.parse(JSON.stringify(WEAPONS));
            this.weaponMgr.equipWeapon(0);
        });

        dom.resumeBtn.addEventListener('click', () => {
            dom.pauseScreen.style.display = 'none';
            this.player.controls.lock();
        });

        this.player.controls.addEventListener('lock', () => {
            GameState.isPaused = false;
            dom.pauseScreen.style.display = 'none';
        });

        this.player.controls.addEventListener('unlock', () => {
            if (GameState.isStarted && !GameState.isGameOver) {
                GameState.isPaused = true;
                dom.pauseScreen.style.display = 'flex';
            }
        });

        document.addEventListener('mousedown', (e) => {
            if (e.button === 0 && this.player.controls.isLocked) {
                this.inputState.mouseDown = true;
                const w = this.weaponMgr.getCurrent();
                if (!w.auto) this.weaponMgr.shoot(this.player, this.particles, this.enemies);
            } else if (e.button === 2 && this.player.controls.isLocked) {
                this.weaponMgr.isAiming = true;
            }
        });

        document.addEventListener('mouseup', (e) => {
            if (e.button === 0) {
                this.inputState.mouseDown = false;
            } else if (e.button === 2) {
                this.weaponMgr.isAiming = false;
            }
        });

        document.addEventListener('keydown', (e) => {
            if (!this.player.controls.isLocked) return;
            if (e.code === 'Digit1') this.weaponMgr.switchWeapon(0);
            if (e.code === 'Digit2') this.weaponMgr.switchWeapon(1);
            if (e.code === 'KeyR') this.weaponMgr.reload();
        });
    }

    onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    updateMinimap() {
        const ctx = this.miniCtx;
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, 200, 200);
        
        ctx.save();
        ctx.translate(100, 100);
        
        const playerRot = this.player.camera.rotation.y;
        ctx.rotate(-playerRot);
        
        // Draw map bounds
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 2;
        ctx.strokeRect(-60, -60, 120, 120);

        // Player
        ctx.fillStyle = '#0f0';
        ctx.beginPath();
        ctx.arc(0, 0, 3, 0, Math.PI * 2);
        ctx.fill();

        // Enemies
        ctx.fillStyle = '#f00';
        this.enemies.forEach(e => {
            if (e.state !== 'DEAD') {
                const dx = e.mesh.position.x - this.player.position.x;
                const dz = e.mesh.position.z - this.player.position.z;
                if (Math.abs(dx) < 100 && Math.abs(dz) < 100) {
                    ctx.beginPath();
                    ctx.arc(dx, dz, 2, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        });
        
        ctx.restore();
    }

    loop(time) {
        requestAnimationFrame((t) => this.loop(t));

        let dt = (time - GameState.lastTime) / 1000;
        GameState.lastTime = time;
        if (dt > 0.05) dt = 0.05; // Cap delta to prevent physics explosion

        GameState.frames++;
        if (time > GameState.lastFpsTime + 1000) {
            dom.fpsCounter.textContent = GameState.frames + ' FPS';
            GameState.frames = 0;
            GameState.lastFpsTime = time;
            
            // Update round timer
            if (GameState.isStarted && !GameState.isPaused && !GameState.isGameOver) {
                GameState.roundTimeLeft--;
                if (GameState.roundTimeLeft <= 0) GameState.roundTimeLeft = 180;
                const m = Math.floor(GameState.roundTimeLeft / 60).toString().padStart(2, '0');
                const s = (GameState.roundTimeLeft % 60).toString().padStart(2, '0');
                dom.roundTimer.textContent = `${m}:${s}`;
            }
        }

        if (GameState.isStarted && !GameState.isPaused && !GameState.isGameOver) {
            const isMoving = this.player.update(dt);
            
            this.weaponMgr.update(dt, isMoving);
            
            if (this.inputState.mouseDown && this.weaponMgr.getCurrent().auto) {
                this.weaponMgr.shoot(this.player, this.particles, this.enemies);
            }
            
            this.enemies.forEach(e => e.update(dt, this.player, this.particles));
            
            this.pickupMgr.update(dt, this.player, this.weaponMgr);
            
            this.particles.update(dt);
            
            // HUD Update throttle (approx 15hz)
            if (GameState.frames % 4 === 0) {
                this.updateMinimap();
            }
        }

        this.renderer.render(this.scene, this.camera);
    }
}

// Start Engine — ES modules run after DOM is parsed, no need for window.onload
new Game();
