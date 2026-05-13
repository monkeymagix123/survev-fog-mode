import * as PIXI from "pixi.js-legacy";
import { MapObjectDefs } from "../../shared/defs/mapObjectDefs";
import type { ObstacleDef } from "../../shared/defs/mapObjectsTyping";
import { coldet, type AABB, type Collider } from "../../shared/utils/coldet";
import { Constants } from "../../shared/net/net";
import { collider } from "../../shared/utils/collider";
import { math } from "../../shared/utils/math";
import { util } from "../../shared/utils/util";
import { type Vec2, v2 } from "../../shared/utils/v2";
import type { Camera } from "./camera";
import { errorLogManager } from "./errorLogs";
import type { FogVisibilitySettings, Game } from "./game";
import type { Map } from "./map";
import type { Building } from "./objects/building";
import type { Obstacle } from "./objects/obstacle";

function step(cur: number, target: number, rate: number) {
    const delta = target - cur;
    const s = delta * rate;
    return Math.abs(s) < 0.01 ? delta : s;
}

function createLayerMask() {
    const mask = new PIXI.Graphics();
    mask.position.set(0.0, 0.0);
    mask.scale.set(1.0, 1.0);
    mask.__zOrd = 0;
    mask.__zIdx = 0;
    return mask;
}

function drawRect(gfx: PIXI.Graphics, x: number, y: number, w: number, h: number) {
    gfx.moveTo(x, y);
    gfx.lineTo(x, y + h);
    gfx.lineTo(x + w, y + h);
    gfx.lineTo(x + w, y);
    gfx.lineTo(x, y);
    gfx.closePath();
}

const OCCLUSION_ALPHA_THRESHOLD = 0.95;
const OCCLUSION_OVERLAY_COLOR = 0x060606;
const OCCLUSION_VIEW_MARGIN = 96;

const FOG_LIGHT_RANGE_PER_STRENGTH = 10;
const FOG_VISIBILITY_MAP_SUFFIX = "_fog";

interface Edge {
    a: Vec2;
    b: Vec2;
}

function getColliderCenter(col: Collider) {
    return col.type === collider.Type.Aabb
        ? v2.mul(v2.add(col.min, col.max), 0.5)
        : col.pos;
}

function circleToShadowEdge(viewerPos: Vec2, pos: Vec2, rad: number): Edge {
    const dir = v2.normalizeSafe(v2.sub(pos, viewerPos), v2.create(1, 0));
    const perp = v2.perp(dir);
    return {
        a: v2.add(pos, v2.mul(perp, rad)),
        b: v2.sub(pos, v2.mul(perp, rad)),
    };
}

function aabbToShadowEdges(viewerPos: Vec2, col: AABB): Edge[] {
    const { min, max } = col;

    // Four AABB edges with their outward normals (CCW winding → normal is left of b-a)
    const candidates: Array<{ a: Vec2; b: Vec2; normal: Vec2 }> = [
        // Bottom  (normal -Y)
        { a: v2.create(max.x, min.y), b: v2.create(min.x, min.y), normal: v2.create(0, -1) },
        // Left    (normal -X)
        { a: v2.create(min.x, min.y), b: v2.create(min.x, max.y), normal: v2.create(-1, 0) },
        // Top     (normal +Y)
        { a: v2.create(min.x, max.y), b: v2.create(max.x, max.y), normal: v2.create(0, 1) },
        // Right   (normal +X)
        { a: v2.create(max.x, max.y), b: v2.create(max.x, min.y), normal: v2.create(1, 0) },
    ];

    const facing: Edge[] = [];
    for (const edge of candidates) {
        const mid = v2.mul(v2.add(edge.a, edge.b), 0.5);
        const toViewer = v2.sub(viewerPos, mid);
        if (v2.dot(edge.normal, toViewer) > 0) {
            facing.push({ a: edge.a, b: edge.b });
        }
    }
    return facing;
}

function obstacleToShadowEdges(viewerPos: Vec2, obstacle: Obstacle): Edge[] {
    const col = obstacle.collider;
    if (col.type === collider.Type.Aabb) {
        return aabbToShadowEdges(viewerPos, col);
    }
    return [circleToShadowEdge(viewerPos, col.pos, col.rad)];
}

function drawEdgeShadow(
    overlay: PIXI.Graphics,
    camera: Camera,
    viewerPos: Vec2,
    edge: Edge,
    shadowLen: number,
): void {
    const viewerScreen = camera.m_pointToScreen(viewerPos);
    const aScreen = camera.m_pointToScreen(edge.a);
    const bScreen = camera.m_pointToScreen(edge.b);

    const dirA = v2.sub(aScreen, viewerScreen);
    const dirB = v2.sub(bScreen, viewerScreen);
    const lenA = v2.length(dirA);
    const lenB = v2.length(dirB);

    if (lenA < 0.0001 || lenB < 0.0001) return;

    const farA = v2.add(aScreen, v2.mul(v2.div(dirA, lenA), shadowLen));
    const farB = v2.add(bScreen, v2.mul(v2.div(dirB, lenB), shadowLen));

    overlay.moveTo(aScreen.x, aScreen.y);
    overlay.lineTo(bScreen.x, bScreen.y);
    overlay.lineTo(farB.x, farB.y);
    overlay.lineTo(farA.x, farA.y);
    overlay.closePath();
}

export class Renderer {
    zIdx = 0;
    layer = 0;
    layerAlpha = 0;
    groundAlpha = 0;
    underground = false;
    layers: RenderGroup[] = [];

    ground = new PIXI.Graphics();
    visionOverlay = new PIXI.Container();
    visionFogSprite = new PIXI.Sprite();
    visionShadowOverlay = new PIXI.Graphics();
    visionFogCanvas = document.createElement("canvas");
    visionFogContext = this.visionFogCanvas.getContext("2d");
    visionFogTexture = PIXI.Texture.from(this.visionFogCanvas);
    layerMask = createLayerMask();
    debugLayerMask = null as null | PIXI.Graphics;
    layerMaskDirty = true;
    layerMaskActive = false;

    constructor(
        public game: Game,
        public canvasMode: boolean,
    ) {
        for (let i = 0; i < 4; i++) {
            this.layers.push(new RenderGroup(`layer_${i}`));
        }
        this.ground.alpha = 0;
        this.visionFogSprite.texture = this.visionFogTexture;
        this.visionFogSprite.position.set(0, 0);
        this.visionFogSprite.visible = false;
        this.visionOverlay.addChild(this.visionFogSprite, this.visionShadowOverlay);
    }

    m_free() {
        this.visionOverlay.parent?.removeChild(this.visionOverlay);
        this.visionOverlay.destroy(true);
        this.visionFogTexture.destroy(true);
        this.layerMask.parent?.removeChild(this.layerMask);
        this.layerMask.destroy(true);
    }

    private isOpaqueVisionBlocker(viewerLayer: number, obstacle: Obstacle) {
        if (
            !obstacle.active ||
            obstacle.dead ||
            !obstacle.collidable ||
            obstacle.isSkin ||
            !util.sameLayer(viewerLayer, obstacle.layer)
        ) {
            return false;
        }
        const def = MapObjectDefs[obstacle.type] as ObstacleDef;
        const alpha = def.img.alpha ?? 1;
        return (
            !obstacle.isWindow &&
            !obstacle.isBush &&
            def.material !== "glass" &&
            obstacle.height > 0.25 &&
            alpha >= OCCLUSION_ALPHA_THRESHOLD
        );
    }

    private isWindowOpeningObstacle(viewerLayer: number, obstacle: Obstacle) {
        return (
            obstacle.active &&
            !obstacle.dead &&
            !obstacle.isSkin &&
            util.sameLayer(viewerLayer, obstacle.layer) &&
            (obstacle.isWindow || obstacle.type.includes("window"))
        );
    }

    private isBuildingVisionBlocker(viewerLayer: number, building: Building) {
        return (
            building.active &&
            !building.ceilingDead &&
            util.sameLayer(viewerLayer, building.layer)
        );
    }

    private boundaryUsesBuildingWindow(boundaryPoint: Vec2, obstacle: Obstacle) {
        const tol = 1.5;
        if (obstacle.collider.type === collider.Type.Aabb) {
            return coldet.testPointAabb(
                boundaryPoint,
                v2.sub(obstacle.collider.min, v2.create(tol, tol)),
                v2.add(obstacle.collider.max, v2.create(tol, tol)),
            );
        }
        const maxDist = obstacle.collider.rad + tol;
        return (
            v2.lengthSqr(v2.sub(boundaryPoint, obstacle.collider.pos)) <= maxDist * maxDist
        );
    }

    private drawFogLightOverlay(
        camera: Camera,
        viewerPos: Vec2,
        settings: FogVisibilitySettings,
    ) {
        const ctx = this.visionFogContext;
        if (!ctx) {
            this.visionFogSprite.visible = false;
            return;
        }

        const width = Math.max(1, Math.ceil(camera.m_screenWidth));
        const height = Math.max(1, Math.ceil(camera.m_screenHeight));
        if (this.visionFogCanvas.width !== width || this.visionFogCanvas.height !== height) {
            this.visionFogCanvas.width = width;
            this.visionFogCanvas.height = height;
            this.visionFogTexture.update();
        }

        const minBrightness = math.clamp(
            settings.minBrightness ?? (1 - math.clamp(settings.ambientDarkness ?? 1, 0, 1)),
            0,
            1,
        );
        const maxBrightness = math.clamp(settings.maxBrightness ?? 1, minBrightness, 1);
        const strength = settings.lightStrength ?? 1;
        const falloff = Math.max(settings.lightFalloff ?? 2, 0.01);
        const falloffStart = Math.max(0, settings.lightFalloffStart ?? 4);
        const radius = Math.max(
            falloffStart + Math.max(0.0001, strength) * FOG_LIGHT_RANGE_PER_STRENGTH,
            falloffStart + 0.0001,
        );

        const center = camera.m_pointToScreen(viewerPos);
        const innerRadiusPx = camera.m_scaleToScreen(falloffStart);
        const outerRadiusPx = camera.m_scaleToScreen(radius);
        const innerDarkness = 1 - maxBrightness;
        const outerDarkness = 1 - minBrightness;

        const gradient = ctx.createRadialGradient(
            center.x,
            center.y,
            innerRadiusPx,
            center.x,
            center.y,
            outerRadiusPx,
        );
        gradient.addColorStop(0, `rgba(6, 6, 6, ${innerDarkness})`);

        const stopCount = 12;
        for (let i = 1; i < stopCount; i++) {
            const t = i / stopCount;
            const darknessT = 1 - Math.pow(1 - t, falloff);
            const alpha = innerDarkness + (outerDarkness - innerDarkness) * darknessT;
            gradient.addColorStop(t, `rgba(6, 6, 6, ${alpha})`);
        }

        gradient.addColorStop(1, `rgba(6, 6, 6, ${outerDarkness})`);

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        this.visionFogTexture.update();
        this.visionFogSprite.visible = true;
        this.visionFogSprite.texture = this.visionFogTexture;
        this.visionFogSprite.position.set(0, 0);
        this.visionFogSprite.width = width;
        this.visionFogSprite.height = height;
    }

    private drawObstacleShadows(
        overlay: PIXI.Graphics,
        camera: Camera,
        viewerPos: Vec2,
        shadowLen: number,
        obstacle: Obstacle,
        shadowOverlayAlpha: number,
    ): void {
        const edges = obstacleToShadowEdges(viewerPos, obstacle);
        if (edges.length === 0) return;

        overlay.beginFill(OCCLUSION_OVERLAY_COLOR, shadowOverlayAlpha);
        for (const edge of edges) {
            drawEdgeShadow(overlay, camera, viewerPos, edge, shadowLen);
        }
        overlay.endFill();
    }

    private drawBuildingZoomShadow(
        overlay: PIXI.Graphics,
        camera: Camera,
        viewerPos: Vec2,
        shadowLen: number,
        zoomIn: AABB,
        windowEdges: Edge[],
        shadowOverlayAlpha: number,
    ): void {
        const edges = aabbToShadowEdges(viewerPos, zoomIn);
        if (edges.length === 0) return;

        overlay.beginFill(OCCLUSION_OVERLAY_COLOR, shadowOverlayAlpha);
        for (const edge of edges) {
            drawEdgeShadow(overlay, camera, viewerPos, edge, shadowLen);
        }
        if (windowEdges.length > 0) {
            overlay.beginHole();
            for (const edge of windowEdges) {
                drawEdgeShadow(overlay, camera, viewerPos, edge, shadowLen);
            }
            overlay.endHole();
        }
        overlay.endFill();
    }

    private redrawVisionOverlay(camera: Camera, map: Map) {
        const overlay = this.visionShadowOverlay;
        overlay.clear();

        const gameLike = this.game as {
            m_activePlayer?: { layer: number };
            m_obstacleOcclusionOverlay?: boolean;
            m_shadowOverlayAlpha?: number;
            m_fogVisibilitySettings?: FogVisibilitySettings;
        };

        const activePlayer = gameLike.m_activePlayer;
        const shadowOverlayAlpha = math.clamp(gameLike.m_shadowOverlayAlpha ?? 0.5, 0, 1);
        const fogModeEnabled = map.mapName.endsWith(FOG_VISIBILITY_MAP_SUFFIX);
        const fogSettings: FogVisibilitySettings = gameLike.m_fogVisibilitySettings ?? {
            ambientDarkness: 1,
            minBrightness: 0.1,
            maxBrightness: 0.7,
            lightStrength: 1.15,
            lightFalloff: 2,
            lightFalloffStart: 4,
            enableShadows: true,
        };

        const shadowsEnabled =
            !!gameLike.m_obstacleOcclusionOverlay ||
            (fogModeEnabled && fogSettings.enableShadows);

        if ((!shadowsEnabled && !fogModeEnabled) || !activePlayer || !map.mapLoaded) {
            this.visionOverlay.visible = false;
            this.visionFogSprite.visible = false;
            return;
        }

        this.visionOverlay.visible = true;
        this.visionFogSprite.visible = false;

        if (fogModeEnabled) {
            this.drawFogLightOverlay(camera, camera.m_pos, fogSettings);
        }

        if (!shadowsEnabled) return;

        const viewerPos = camera.m_pos;
        const shadowLen =
            Math.hypot(camera.m_screenWidth, camera.m_screenHeight) +
            OCCLUSION_VIEW_MARGIN * 2;

        const obstacles = map.m_obstaclePool.m_getPool();
        const buildings = map.m_buildingPool.m_getPool();

        // --- Obstacle shadows -------------------------------------------------
        for (let i = 0; i < obstacles.length; i++) {
            const obstacle = obstacles[i];
            if (!this.isOpaqueVisionBlocker(activePlayer.layer, obstacle)) continue;
            if (collider.intersectCircle(obstacle.collider, viewerPos, 0.05)) continue;

            const centerScreen = camera.m_pointToScreen(getColliderCenter(obstacle.collider));
            if (
                centerScreen.x < -OCCLUSION_VIEW_MARGIN ||
                centerScreen.x > camera.m_screenWidth + OCCLUSION_VIEW_MARGIN ||
                centerScreen.y < -OCCLUSION_VIEW_MARGIN ||
                centerScreen.y > camera.m_screenHeight + OCCLUSION_VIEW_MARGIN
            ) {
                continue;
            }

            this.drawObstacleShadows(
                overlay,
                camera,
                viewerPos,
                shadowLen,
                obstacle,
                shadowOverlayAlpha,
            );
        }

        // --- Building shadows -------------------------------------------------
        for (let i = 0; i < buildings.length; i++) {
            const building = buildings[i];
            if (!this.isBuildingVisionBlocker(activePlayer.layer, building)) continue;

            for (let j = 0; j < building.ceiling.zoomRegions.length; j++) {
                const zoomIn = building.ceiling.zoomRegions[j].zoomIn;
                if (!zoomIn || zoomIn.type !== collider.Type.Aabb) continue;
                if (coldet.testPointAabb(viewerPos, zoomIn.min, zoomIn.max)) continue;

                const centerScreen = camera.m_pointToScreen(getColliderCenter(zoomIn));
                if (
                    centerScreen.x < -OCCLUSION_VIEW_MARGIN ||
                    centerScreen.x > camera.m_screenWidth + OCCLUSION_VIEW_MARGIN ||
                    centerScreen.y < -OCCLUSION_VIEW_MARGIN ||
                    centerScreen.y > camera.m_screenHeight + OCCLUSION_VIEW_MARGIN
                ) {
                    continue;
                }

                // Gather window opening edges that punch through this boundary
                const windowEdges: Edge[] = [];
                for (let k = 0; k < obstacles.length; k++) {
                    const obstacle = obstacles[k];
                    if (
                        !this.isWindowOpeningObstacle(activePlayer.layer, obstacle) ||
                        !collider.intersect(obstacle.collider, zoomIn)
                    ) {
                        continue;
                    }

                    const windowCenter = getColliderCenter(obstacle.collider);
                    const windowProbe = v2.add(
                        windowCenter,
                        v2.mul(
                            v2.normalizeSafe(v2.sub(windowCenter, viewerPos), v2.create(1, 0)),
                            8,
                        ),
                    );
                    const boundaryHit = collider.intersectSegment(zoomIn, viewerPos, windowProbe);
                    if (
                        !boundaryHit ||
                        !this.boundaryUsesBuildingWindow(boundaryHit.point, obstacle)
                    ) {
                        continue;
                    }

                    for (const e of obstacleToShadowEdges(viewerPos, obstacle)) {
                        windowEdges.push(e);
                    }
                }

                this.drawBuildingZoomShadow(
                    overlay,
                    camera,
                    viewerPos,
                    shadowLen,
                    zoomIn,
                    windowEdges,
                    shadowOverlayAlpha,
                );
            }
        }
    }

    addPIXIObj(obj: PIXI.Container, layer: number, zOrd: number, zIdx?: number) {
        if (!obj.transform) {
            const err = new Error();
            const str = {
                type: "addChild",
                stack: err.stack,
                browser: navigator.userAgent,
                playing: this.game.m_playing,
                gameOver: this.game.m_gameOver,
                spectating: this.game.m_spectating,
                time: this.game.m_playingTicker,
                mode: this.game.teamMode,
                layer,
                zOrd,
                zIdx,
            };
            errorLogManager.logError("addPixiObj", str);
        }
        if (obj.__layerIdx === undefined) {
            obj.__layerIdx = -1;
            obj.__zOrd = -1;
            obj.__zIdx = -1;
        }
        let layerIdx = layer;
        const onStairs = layer & 0x2;
        if (onStairs) {
            layerIdx = zOrd >= 100 ? 3 : 2;
        }

        if (
            obj.parent == this.layers[layerIdx] &&
            obj.__zOrd == zOrd &&
            (zIdx === undefined || obj.__zIdx == zIdx)
        ) {
            return;
        }

        obj.__layerIdx = layerIdx;
        obj.__zOrd = zOrd;
        obj.__zIdx = zIdx !== undefined ? zIdx : this.zIdx++;

        this.layers[layerIdx].addSortedChild(obj);
    }

    setActiveLayer(layer: number) {
        this.layer = layer;
    }

    setUnderground(underground: boolean) {
        this.underground = underground;
    }

    resize(map: Map, camera: Camera) {
        const undergroundColor = map.mapLoaded
            ? map.getMapDef().biome.colors.underground
            : 1772803;

        this.ground.clear();
        this.ground.beginFill(undergroundColor);
        this.ground.drawRect(0, 0, camera.m_screenWidth, camera.m_screenHeight);
        this.ground.endFill();

        this.layerMaskDirty = true;
    }

    redrawLayerMask(camera: Camera, map: Map) {
        const mask = this.layerMask;
        if (this.canvasMode) {
            mask.clear();
            if (this.layerMaskActive) {
                mask.beginFill(0xffffff, 1.0);
                mask.drawRect(0.0, 0.0, camera.m_screenWidth, camera.m_screenHeight);
                const structures = map.m_structurePool.m_getPool();
                for (let i = 0; i < structures.length; i++) {
                    const structure = structures[i];
                    if (!structure.active) continue;
                    for (let j = 0; j < structure.mask.length; j++) {
                        const m = structure.mask[j];
                        const e = v2.mul(v2.sub(m.max, m.min), 0.5);
                        const c = v2.add(m.min, e);
                        const ll = camera.m_pointToScreen(v2.sub(c, e));
                        const tr = camera.m_pointToScreen(v2.add(c, e));
                        mask.drawRect(ll.x, ll.y, tr.x - ll.x, tr.y - ll.y);
                    }
                }
                mask.endFill();
            }
        } else {
            if (this.layerMaskDirty) {
                this.layerMaskDirty = false;
                mask.clear();
                mask.beginFill(0xffffff, 1.0);
                drawRect(mask, 0.0, 0.0, Constants.MaxPosition, Constants.MaxPosition);
                const structures = map.m_structurePool.m_getPool();
                for (let i = 0; i < structures.length; i++) {
                    const structure = structures[i];
                    if (!structure.active) continue;
                    for (let j = 0; j < structure.mask.length; j++) {
                        const m = structure.mask[j];
                        const e = v2.mul(v2.sub(m.max, m.min), 0.5);
                        const c = v2.add(m.min, e);
                        const x = c.x - e.x;
                        const y = c.y - e.y;
                        const w = e.x * 2.0;
                        const h = e.y * 2.0;
                        mask.beginHole();
                        drawRect(mask, x, y, w, h);
                        mask.endHole();
                    }
                }
                mask.endFill();
            }
            const p0 = camera.m_pointToScreen(v2.create(0.0, 0.0));
            const s = camera.m_scaleToScreen(1.0);
            mask.position.set(p0.x, p0.y);
            mask.scale.set(s, -s);
        }
    }

    redrawDebugLayerMask(camera: Camera, map: Map) {
        const mask = this.debugLayerMask as PIXI.Graphics;
        mask.clear();
        mask.beginFill(16711935, 1);
        const structures = map.m_structurePool.m_getPool();
        for (let i = 0; i < structures.length; i++) {
            const structure = structures[i];
            if (!structure.active) continue;
            for (let s = 0; s < structure.mask.length; s++) {
                const n = structure.mask[s];
                const c = v2.mul(v2.sub(n.max, n.min), 0.5);
                const m = v2.add(n.min, c);
                const p = m.x - c.x;
                const h = m.y - c.y;
                const u = c.x * 2;
                const g = c.y * 2;
                drawRect(mask, p, h, u, g);
            }
        }
        mask.endFill();
        const p0 = camera.m_pointToScreen(v2.create(0, 0));
        const s = camera.m_scaleToScreen(1);
        mask.position.set(p0.x, p0.y);
        mask.scale.set(s, -s);
    }

    m_update(dt: number, camera: Camera, map: Map) {
        const alphaTarget = this.layer > 0 ? 1.0 : 0.0;
        this.layerAlpha += step(this.layerAlpha, alphaTarget, dt * 12.0);
        const groundTarget = this.layer == 1 && this.underground ? 1.0 : 0.0;
        this.groundAlpha += step(this.groundAlpha, groundTarget, dt * 12.0);

        this.layers[0].alpha = 1.0;
        this.layers[1].alpha = this.layerAlpha;
        this.layers[2].alpha = 1.0;
        this.layers[3].alpha = 1.0;
        this.ground.alpha = this.groundAlpha;

        this.layers[0].visible = this.groundAlpha < 1.0;
        this.layers[1].visible = this.layerAlpha > 0.0;
        this.ground.visible = this.groundAlpha > 0.0;

        this.redrawLayerMask(camera, map);
        this.redrawVisionOverlay(camera, map);

        const maskActive = this.layer == 0;
        if (maskActive && !this.layerMaskActive) {
            this.layers[2].mask = this.layerMask;
            this.layers[2].addChild(this.layerMask);
            this.layerMaskActive = true;
        } else if (!maskActive && this.layerMaskActive) {
            this.layers[2].mask = null;
            this.layers[2].removeChild(this.layerMask);
            this.layerMaskActive = false;
        }

        for (let i = 0; i < this.layers.length; i++) {
            this.layers[i].checkSort();
        }
    }
}

class RenderGroup extends PIXI.Container {
    dirty = true;

    constructor(public debugName = "") {
        super();
    }

    addSortedChild(child: PIXI.Container) {
        this.addChild(child);
        this.dirty = true;
    }

    checkSort() {
        if (this.dirty) {
            this.children.sort((a, b) =>
                a.__zOrd == b.__zOrd ? a.__zIdx - b.__zIdx : a.__zOrd - b.__zOrd,
            );
            this.dirty = false;
            return true;
        }
        return false;
    }
}
