import * as PIXI from "pixi.js-legacy";
import { MapObjectDefs } from "../../shared/defs/mapObjectDefs";
import type { ObstacleDef } from "../../shared/defs/mapObjectsTyping";
import { coldet, type AABB, type Collider } from "../../shared/utils/coldet";
import { Constants } from "../../shared/net/net";
import { collider } from "../../shared/utils/collider";
import { util } from "../../shared/utils/util";
import { type Vec2, v2 } from "../../shared/utils/v2";
import type { Camera } from "./camera";
import { errorLogManager } from "./errorLogs";
import type { Game } from "./game";
import type { Map } from "./map";
import type { Building } from "./objects/building";
import type { Obstacle } from "./objects/obstacle";

//
// Helpers
//
function step(cur: number, target: number, rate: number) {
    const delta = target - cur;
    const step = delta * rate;
    return Math.abs(step) < 0.01 ? delta : step;
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
const OCCLUSION_OVERLAY_ALPHA = 0.99;
const OCCLUSION_OVERLAY_COLOR = 0x060606;
const OCCLUSION_VIEW_MARGIN = 96;

function getColliderCenter(col: Collider) {
    return col.type === collider.Type.Aabb
        ? v2.mul(v2.add(col.min, col.max), 0.5)
        : col.pos;
}

function getAabbShadowEdgePoints(viewerPos: { x: number; y: number }, col: AABB) {
    const center = getColliderCenter(col);
    const dir = v2.normalizeSafe(v2.sub(center, viewerPos), v2.create(1, 0));
    const perp = v2.perp(dir);
    const corners = [
        v2.create(col.min.x, col.min.y),
        v2.create(col.min.x, col.max.y),
        v2.create(col.max.x, col.min.y),
        v2.create(col.max.x, col.max.y),
    ];

    let left = corners[0];
    let right = corners[0];
    let leftProj = -Infinity;
    let rightProj = Infinity;

    for (let i = 0; i < corners.length; i++) {
        const corner = corners[i];
        const proj = v2.dot(v2.sub(corner, viewerPos), perp);
        if (proj > leftProj) {
            leftProj = proj;
            left = corner;
        }
        if (proj < rightProj) {
            rightProj = proj;
            right = corner;
        }
    }

    return [left, right] as const;
}

function getObstacleShadowEdgePoints(viewerPos: { x: number; y: number }, obstacle: Obstacle) {
    const col = obstacle.collider;
    if (col.type === collider.Type.Aabb) {
        return getAabbShadowEdgePoints(viewerPos, col);
    }

    const dir = v2.normalizeSafe(v2.sub(col.pos, viewerPos), v2.create(1, 0));
    const perp = v2.perp(dir);
    return [
        v2.add(col.pos, v2.mul(perp, col.rad)),
        v2.sub(col.pos, v2.mul(perp, col.rad)),
    ] as const;
}

function getScreenShadowQuad(
    camera: Camera,
    viewerPos: Vec2,
    edge0: Vec2,
    edge1: Vec2,
    shadowLen: number,
) {
    const viewerScreen = camera.m_pointToScreen(viewerPos);
    const screen0 = camera.m_pointToScreen(edge0);
    const screen1 = camera.m_pointToScreen(edge1);
    const dir0 = v2.sub(screen0, viewerScreen);
    const dir1 = v2.sub(screen1, viewerScreen);

    if (v2.lengthSqr(dir0) < 0.0001 || v2.lengthSqr(dir1) < 0.0001) {
        return null;
    }

    return {
        near0: screen0,
        near1: screen1,
        far0: v2.add(screen0, v2.mul(v2.normalizeSafe(dir0, v2.create(1, 0)), shadowLen)),
        far1: v2.add(screen1, v2.mul(v2.normalizeSafe(dir1, v2.create(1, 0)), shadowLen)),
    };
}

export class Renderer {
    zIdx = 0;
    layer = 0;
    layerAlpha = 0;
    groundAlpha = 0;
    underground = false;
    layers: RenderGroup[] = [];

    ground = new PIXI.Graphics();
    visionOverlay = new PIXI.Graphics();
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
    }

    m_free() {
        this.visionOverlay.parent?.removeChild(this.visionOverlay);
        this.visionOverlay.destroy(true);
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

    private segmentUsesBuildingWindow(
        viewerPos: Vec2,
        targetPos: Vec2,
        boundaryPoint: Vec2,
        viewerLayer: number,
        map: Map,
        zoomIn: Collider,
    ) {
        const obstacles = map.m_obstaclePool.m_getPool();
        const maxWindowDistSq = 9;

        for (let i = 0; i < obstacles.length; i++) {
            const obstacle = obstacles[i];
            if (
                !this.isWindowOpeningObstacle(viewerLayer, obstacle) ||
                !collider.intersect(obstacle.collider, zoomIn)
            ) {
                continue;
            }

            const intersection = collider.intersectSegment(
                obstacle.collider,
                viewerPos,
                targetPos,
            );
            if (!intersection) {
                continue;
            }

            if (v2.lengthSqr(v2.sub(intersection.point, boundaryPoint)) <= maxWindowDistSq) {
                return true;
            }
        }

        return false;
    }

    private drawShadowQuad(
        overlay: PIXI.Graphics,
        camera: Camera,
        viewerPos: Vec2,
        edge0: Vec2,
        edge1: Vec2,
        shadowLen: number,
    ) {
        const quad = getScreenShadowQuad(camera, viewerPos, edge0, edge1, shadowLen);
        if (!quad) {
            return;
        }

        overlay.moveTo(quad.near0.x, quad.near0.y);
        overlay.lineTo(quad.near1.x, quad.near1.y);
        overlay.lineTo(quad.far1.x, quad.far1.y);
        overlay.lineTo(quad.far0.x, quad.far0.y);
        overlay.closePath();
    }

    private redrawVisionOverlay(camera: Camera, map: Map) {
        const overlay = this.visionOverlay;
        overlay.clear();

        const gameLike = this.game as {
            m_activePlayer?: {
                layer: number;
            };
            m_obstacleOcclusionOverlay?: boolean;
        };

        const activePlayer = gameLike.m_activePlayer;
        const enabled = gameLike.m_obstacleOcclusionOverlay;

        if (!enabled || !activePlayer || !map.mapLoaded) {
            overlay.visible = false;
            return;
        }

        overlay.visible = true;

        const viewerPos = camera.m_pos;
        const shadowLen =
            Math.hypot(camera.m_screenWidth, camera.m_screenHeight) + OCCLUSION_VIEW_MARGIN * 2;
        const obstacles = map.m_obstaclePool.m_getPool();
        const buildings = map.m_buildingPool.m_getPool();

        overlay.beginFill(OCCLUSION_OVERLAY_COLOR, OCCLUSION_OVERLAY_ALPHA);

        for (let i = 0; i < obstacles.length; i++) {
            const obstacle = obstacles[i];
            if (!this.isOpaqueVisionBlocker(activePlayer.layer, obstacle)) {
                continue;
            }

            if (collider.intersectCircle(obstacle.collider, viewerPos, 0.05)) {
                continue;
            }

            const centerScreen = camera.m_pointToScreen(getColliderCenter(obstacle.collider));
            if (
                centerScreen.x < -OCCLUSION_VIEW_MARGIN ||
                centerScreen.x > camera.m_screenWidth + OCCLUSION_VIEW_MARGIN ||
                centerScreen.y < -OCCLUSION_VIEW_MARGIN ||
                centerScreen.y > camera.m_screenHeight + OCCLUSION_VIEW_MARGIN
            ) {
                continue;
            }

            const [leftWorld, rightWorld] = getObstacleShadowEdgePoints(viewerPos, obstacle);
            this.drawShadowQuad(overlay, camera, viewerPos, leftWorld, rightWorld, shadowLen);
        }

        for (let i = 0; i < buildings.length; i++) {
            const building = buildings[i];
            if (!this.isBuildingVisionBlocker(activePlayer.layer, building)) {
                continue;
            }

            for (let j = 0; j < building.ceiling.zoomRegions.length; j++) {
                const zoomIn = building.ceiling.zoomRegions[j].zoomIn;
                if (!zoomIn || zoomIn.type !== collider.Type.Aabb) {
                    continue;
                }

                if (coldet.testPointAabb(viewerPos, zoomIn.min, zoomIn.max)) {
                    continue;
                }

                const centerScreen = camera.m_pointToScreen(getColliderCenter(zoomIn));
                if (
                    centerScreen.x < -OCCLUSION_VIEW_MARGIN ||
                    centerScreen.x > camera.m_screenWidth + OCCLUSION_VIEW_MARGIN ||
                    centerScreen.y < -OCCLUSION_VIEW_MARGIN ||
                    centerScreen.y > camera.m_screenHeight + OCCLUSION_VIEW_MARGIN
                ) {
                    continue;
                }

                const [leftWorld, rightWorld] = getAabbShadowEdgePoints(viewerPos, zoomIn);
                this.drawShadowQuad(overlay, camera, viewerPos, leftWorld, rightWorld, shadowLen);

                overlay.beginHole();
                for (let k = 0; k < obstacles.length; k++) {
                    const obstacle = obstacles[k];
                    if (
                        !this.isWindowOpeningObstacle(activePlayer.layer, obstacle) ||
                        !collider.intersect(obstacle.collider, zoomIn)
                    ) {
                        continue;
                    }

                    const boundaryHit = collider.intersectSegment(
                        zoomIn,
                        viewerPos,
                        obstacle.pos,
                    );
                    if (
                        !boundaryHit ||
                        !this.segmentUsesBuildingWindow(
                            viewerPos,
                            obstacle.pos,
                            boundaryHit.point,
                            activePlayer.layer,
                            map,
                            zoomIn,
                        )
                    ) {
                        continue;
                    }

                    const [windowLeft, windowRight] = getObstacleShadowEdgePoints(
                        viewerPos,
                        obstacle,
                    );
                    this.drawShadowQuad(
                        overlay,
                        camera,
                        viewerPos,
                        windowLeft,
                        windowRight,
                        shadowLen,
                    );
                }
                overlay.endHole();
            }
        }

        overlay.endFill();
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
        // Hack to render large/high objects (trees, smokes) on
        // a separate layer that isn't masked off by the bunkers.
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
                    if (!structure.active) {
                        continue;
                    }
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
            // Redraw mask
            if (this.layerMaskDirty) {
                this.layerMaskDirty = false;
                mask.clear();
                mask.beginFill(0xffffff, 1.0);
                drawRect(mask, 0.0, 0.0, Constants.MaxPosition, Constants.MaxPosition);
                const structures = map.m_structurePool.m_getPool();
                for (let i = 0; i < structures.length; i++) {
                    const structure = structures[i];
                    if (!structure.active) {
                        continue;
                    }
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
            // Position layer mask
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
            if (structure.active) {
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
        }
        mask.endFill();
        const p0 = camera.m_pointToScreen(v2.create(0, 0));
        const s = camera.m_scaleToScreen(1);
        mask.position.set(p0.x, p0.y);
        mask.scale.set(s, -s);
    }

    m_update(dt: number, camera: Camera, map: Map) {
        // Adjust layer alpha
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

        // Set stairs mask
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

        // Sort layers
        // let sortCount = 0;
        for (let i = 0; i < this.layers.length; i++) {
            this.layers[i].checkSort();
            /* if (this.layers[i].checkSort()) {
                sortCount++;
            } */
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
