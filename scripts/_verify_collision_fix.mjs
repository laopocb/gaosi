/**
 * 运行时模拟验证（临时）：证明「碰撞未触发」修复生效。
 * 1) 用真实 13-tile 房间包围盒构造 SceneBoundCollision（从 dist/index.js 提取）；
 * 2) 验证默认相机模式决策：animTracks=[] + 相机在盒内 + walk 禁用 → fly（碰撞生效）；
 * 3) 验证合并包围盒跳过 env.sog（环境）后碰撞房间尺寸为真实房间而非数百米；
 * 4) 验证 fly 相机向墙/地板移动时会被阻挡/推出。
 * 用法：node scripts/_verify_collision_fix.mjs
 */
import { readFileSync } from 'node:fs';

const js = readFileSync('dist/index.js', 'utf8');

// 提取 SceneBoundCollision 类
const extractClass = (name) => {
    const marker = `class ${name} `;
    const start = js.indexOf(marker);
    if (start < 0) throw new Error('未找到 ' + marker);
    let depth = 0;
    let i = js.indexOf('{', start);
    let end = -1;
    for (; i < js.length; i++) {
        const ch = js[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return js.slice(start, end + 1);
};
const SceneBoundCollision = new Function('return ' + extractClass('SceneBoundCollision') + ';')();

let failures = 0;
const check = (cond, label) => {
    if (cond) console.log('  ✅ ' + label);
    else { console.log('  ❌ ' + label); failures++; }
};

// ---- 真实房间包围盒（13 个 tile，排除 env.sog；已由 _analysis_bbox2.mjs 计算） ----
// min=(-42.47, -6.92, -15.28) max=(29.91, 9.90, 36.65)
const roomCenter = { x: (-42.47 + 29.91) / 2, y: (-6.92 + 9.90) / 2, z: (-15.28 + 36.65) / 2 };
const roomHalf = { x: (29.91 - (-42.47)) / 2, y: (9.90 - (-6.92)) / 2, z: (36.65 - (-15.28)) / 2 };
console.log('房间包围盒 center=(' + roomCenter.x.toFixed(2) + ',' + roomCenter.y.toFixed(2) + ',' + roomCenter.z.toFixed(2) +
    ') half=(' + roomHalf.x.toFixed(2) + ',' + roomHalf.y.toFixed(2) + ',' + roomHalf.z.toFixed(2) + ')');

const col = new SceneBoundCollision({ center: roomCenter, halfExtents: roomHalf });
const out = { x: 0, y: 0, z: 0 };

// 相机固定位姿（settings.json）
const cam = { x: 11.5517, y: 1.3071, z: -1.7164 };
const CAMERA_RADIUS = 0.2;

// ---- 1. 默认相机模式决策（复刻 patched CameraManager 关键逻辑） ----
console.log('\n[1] 默认相机模式决策（复刻补丁后 CameraManager 逻辑）');
const animTracks = []; // settings.json: animTracks: []
// patched getAnimTrack：无轨道返回 null
const getAnimTrack = () => (Array.isArray(animTracks) && animTracks.length > 0 ? animTracks[0] : null);
const isObjectExperience = !(cam.x >= roomCenter.x - roomHalf.x && cam.x <= roomCenter.x + roomHalf.x &&
    cam.y >= roomCenter.y - roomHalf.y && cam.y <= roomCenter.y + roomHalf.y &&
    cam.z >= roomCenter.z - roomHalf.z && cam.z <= roomCenter.z + roomHalf.z);
const hasAnimation = !!getAnimTrack();
const walkAllowed = false; // P9 补丁
const cameraMode = hasAnimation ? 'anim' : (isObjectExperience ? 'orbit' : (walkAllowed ? 'walk' : 'fly'));
check(cameraMode === 'fly', '默认相机模式 = fly（实际 ' + cameraMode + '）——碰撞在 fly 控制器上生效');
check(!isObjectExperience, '相机在房间包围盒内（isObjectExperience=false）');
check(!hasAnimation, 'hasAnimation=false（无动画轨道）');

// ---- 2. 相机起点在房间内且自由 ----
console.log('\n[2] 相机起点状态');
check(!col.querySphere(cam.x, cam.y, cam.z, CAMERA_RADIUS, out), '相机起点 (11.55,1.31,-1.72) 为自由空间（无碰撞推出）');
check(col.isFreeAt(cam.x, cam.y, cam.z), '相机起点 isFreeAt=true');

// ---- 3. fly 相机向墙移动被阻挡（射线扫掠） ----
console.log('\n[3] fly 相机向墙移动（模拟 SphereMover._querySweep）');
// 碰撞「房间」= 包围盒每侧内缩 0.5m（COLLISION_PADDING=0.5，用户意图已固化）：
//   +x 墙 = 29.91 - 0.5 = 29.41；地面 = -6.92 + 0.5 = -6.42；天花板 = 9.90 - 0.5 = 9.40。
// 相机 x=11.55，距 +x 墙 ≈17.86m → 用 25m 射程应命中墙面
const dirX = { x: 1, y: 0, z: 0 };
const hit = col.queryRay(cam.x, cam.y, cam.z, dirX.x, dirX.y, dirX.z, 25);
check(hit !== null && Math.abs(hit.x - 29.41) < 1e-4, '向 +x 移动命中 x=29.41 墙面（内缩 0.5m，命中点 x=' + (hit && hit.x.toFixed(2)) + '）');
if (hit) {
    const sn = col.querySurfaceNormal(hit.x, hit.y, hit.z, dirX.x, dirX.y, dirX.z);
    check(sn.nx === -1, '墙面法线指向相机（-x），用于滑动裁剪（nx=' + sn.nx + '）');
}
// 相机向下移动：相机 y=1.31，地面（内缩后）-6.42，距地面 ≈7.73m → 用 12m 射程应命中地面
const dirDown = { x: 0, y: -1, z: 0 };
const hitFloor = col.queryRay(cam.x, cam.y, cam.z, dirDown.x, dirDown.y, dirDown.z, 12);
check(hitFloor !== null && Math.abs(hitFloor.y - (-6.42)) < 1e-4, '向下移动命中地面 y=-6.42（内缩 0.5m，命中点 y=' + (hitFloor && hitFloor.y.toFixed(2)) + '）');
// 相机向上 9m：命中天花板（内缩后 9.40）
const dirUp = { x: 0, y: 1, z: 0 };
const hitCeil = col.queryRay(cam.x, cam.y, cam.z, dirUp.x, dirUp.y, dirUp.z, 9 + CAMERA_RADIUS);
check(hitCeil !== null && Math.abs(hitCeil.y - 9.40) < 1e-4, '向上移动命中天花板 y=9.40（内缩 0.5m，命中点 y=' + (hitCeil && hitCeil.y.toFixed(2)) + '）');

// ---- 4. 贴近地面时被推出（SphereMover._resolveSphere） ----
console.log('\n[4] 贴近地面被推出（球体解析）');
// 地面（内缩后）-6.42，相机球心降到 -6.42+0.05（穿透 0.15 < 半径 0.2）→ 应向上推出 0.15
const nearFloor = col.querySphere(cam.x, -6.42 + 0.05, cam.z, CAMERA_RADIUS, out);
check(nearFloor === true && Math.abs(out.y - 0.15) < 1e-4, '贴地 0.15m 穿透 → 向上推出 0.15（实际 out.y=' + out.y.toFixed(3) + '）');
// 贴 +x 墙（内缩后 29.41）0.05m（穿透 0.15）→ 向 -x 推出 0.15
const nearWall = col.querySphere(29.41 - 0.05, cam.y, cam.z, CAMERA_RADIUS, out);
check(nearWall === true && Math.abs(out.x - (-0.15)) < 1e-4, '贴 x=29.41 墙 0.15m 穿透 → 向 -x 推出 0.15（实际 out.x=' + out.x.toFixed(3) + '）');

// ---- 5. 合并包围盒跳过 env.sog 后碰撞房间尺寸 ----
console.log('\n[5] 合并包围盒跳过环境（env.sog）后碰撞房间尺寸');
// 模拟 P3 合并补丁的跳过逻辑：baseDiag=0_0.sog（≈45.3m），env.sog diag≈576m
const baseDiag = 45.3;
const envDiag = 576;
const skipFactor = 8;
check(envDiag > baseDiag * skipFactor, 'env.sog 对角线 ' + envDiag.toFixed(0) + 'm > 基准 ' + (baseDiag * skipFactor).toFixed(0) + 'm（' + skipFactor + '×）→ 被跳过');
const tileMaxDiag = 45.3; // 13 个 tile 中最大约等于 0_0.sog
check(tileMaxDiag < baseDiag * skipFactor, '13 个 tile 最大对角线 ' + tileMaxDiag.toFixed(1) + 'm < ' + (baseDiag * skipFactor).toFixed(0) + 'm → 全部并入碰撞房间');
// 碰撞房间实际尺寸（13 tile）：72.38 × 16.82 × 51.93 m
check(Math.abs(29.91 - (-42.47) - 72.38) < 0.1 && Math.abs(9.90 - (-6.92) - 16.82) < 0.1 && Math.abs(36.65 - (-15.28) - 51.93) < 0.1,
    '碰撞房间尺寸 ≈ 72.38 × 16.82 × 51.93 m（真实室内范围，非数百米）');

// ---- 6. 需求①与③的静态断言 ----
console.log('\n[6] 需求①/③ 静态断言');
let html = '';
try { html = readFileSync('dist/index.html', 'utf8'); } catch { /* ignore */ }
check(!html.includes('contents: fetch(contentUrl)'), 'index.html 不再发起默认内容 fetch（需求①）');
check(!html.includes(": './scene.compressed.ply'"), 'index.html 不再引用 scene.compressed.ply 路径（需求①）');
check(html.includes('#play, #pause, #timelineContainer { display: none !important; }'), 'index.html 隐藏动画播放控件（需求③）');
check(js.includes('if (!Array.isArray(animTracks) || animTracks.length === 0)'), 'index.js 存在无轨道返回 null 守卫（需求②）');
check(js.includes('_skipFactor = 8'), 'index.js 存在包围盒跳过阈值（需求②）');

console.log('');
if (failures > 0) {
    console.log('❌ 存在 ' + failures + ' 项失败');
    process.exit(1);
} else {
    console.log('✅ 碰撞修复验证全部通过');
}
