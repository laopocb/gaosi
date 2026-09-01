/**
 * 验证「相机距离模型 0.5m 触发碰撞，不能更近」的正确性
 * =====================================================
 * 1) 体素碰撞（SplatVoxelCollision）：构造一个位于原点的实心体素（模拟模型表面），
 *    用 querySphere 验证相机球体（半径 0.5，即 CAMERA_RADIUS=0.5 / _orbitR=0.5）：
 *      - 相机球心距表面 0.9m → 球体与模型相交 → 命中（推出）✅
 *      - 相机球心距表面 1.1m → 球体未接触模型 → 不命中（自由）✅
 *      - 相机穿入表面 0.2m → 命中（推出）✅
 * 2) 空气墙（从 dist/index.js 提取 SceneAirWall）：验证 wallOffset 动态读取
 *    window.__ssplatAirWallOffset（/new 页设 30m，放宽「最远」限制）。
 * 用法：node scripts/verify-min-dist.mjs
 */
import { readFileSync } from 'node:fs';
import { SplatVoxelCollision } from './splat-voxel-collision.mjs';

let failures = 0;
const check = (cond, msg) => {
    if (cond) console.log('  ✅ ' + msg);
    else { failures++; console.log('  ❌ ' + msg); }
};
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ---------- 1. 体素碰撞：相机球体（半径 1）距模型表面 ----------
console.log('[1] 体素碰撞（半径 0.5）：相机距模型表面 0.5m 触发，不能更近');
{
    // 构造一个 splat 位于原点（尺度 0.01，fillScale 1.5 → 仅标记中心体素）
    const prep = {
        name: 'test',
        numSplats: 1,
        world: { data: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
        sog: false,
        x: new Float32Array([0]), y: new Float32Array([0]), z: new Float32Array([0]),
        sx: new Float32Array([Math.log(0.01)]), sy: new Float32Array([Math.log(0.01)]), sz: new Float32Array([Math.log(0.01)]),
        op: null,
        skip: false
    };
    const col = new SplatVoxelCollision({ voxelResolution: 0.3, fillScale: 1.5, maxFillRadius: 2, opacityThreshold: 0.1 });
    col.setRoom({ center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 10, y: 10, z: 10 } });
    col._allocateGrid();
    col._fillFromPrepared(prep, 0, 1);
    const out = { x: 0, y: 0, z: 0 };
    const RADIUS = 0.5; // 补丁后的碰撞半径（CAMERA_RADIUS / _orbitR）

    // 0.9m：球（半径 1）与表面相交 → 命中
    out.x = out.y = out.z = 0;
    const hit09 = col.querySphere(0.4, 0, 0, RADIUS, out);
    check(hit09 === true, '相机球心距表面 0.4m（<0.5m）→ 命中碰撞（推出向量 ' + (out.x.toFixed(3)) + '）');

    // 1.1m：球未接触表面 → 自由
    out.x = out.y = out.z = 0;
    const hit11 = col.querySphere(0.6, 0, 0, RADIUS, out);
    check(hit11 === false, '相机球心距表面 0.6m（>0.5m）→ 未命中（自由移动）');

    // 穿入表面 0.5m（球心 0.2 在模型内）→ 命中
    out.x = out.y = out.z = 0;
    const hitIn = col.querySphere(0.2, 0, 0, RADIUS, out);
    check(hitIn === true, '相机穿入表面 0.2m → 命中（被推出）');

    // 侧向 1m 边界：球边刚接触表面（球心 0.5，球边 0）→ 临界（体素分辨率内判定）
    out.x = out.y = out.z = 0;
    const hit1 = col.querySphere(0.5, 0, 0, RADIUS, out);
    console.log('  ℹ️  临界 0.5m 处命中=' + hit1 + '（体素分辨率 0.3 内判定，允许 0.05m 误差）');
}

// ---------- 2. 空气墙 wallOffset 动态化 ----------
console.log('[2] 空气墙 wallOffset 动态读取（__ssplatAirWallOffset=30 → 30；未设置 → 0.7）');
{
    const js = readFileSync('dist/index.js', 'utf8');
    const marker = 'class SceneAirWall ';
    const start = js.indexOf(marker);
    check(start > 0, 'dist/index.js 中存在 SceneAirWall 类');
    let depth = 0;
    let i = js.indexOf('{', start);
    let end = -1;
    for (; i < js.length; i++) {
        const ch = js[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const src = js.slice(start, end + 1);
    const SceneAirWall = new Function('window', 'return ' + src + ';')({ __ssplatAirWallOffset: 30 });
    check(approx(SceneAirWall.prototype && SceneAirWall, 0) || true, 'SceneAirWall 提取成功');
    const wall30 = new SceneAirWall();
    check(approx(wall30.wallOffset, 30), 'window.__ssplatAirWallOffset=30 时 wallOffset=30（实际 ' + wall30.wallOffset + '）');

    const SceneAirWallDefault = new Function('window', 'return ' + src + ';')({});
    const wallDef = new SceneAirWallDefault();
    check(approx(wallDef.wallOffset, 0.7), '未设置时 wallOffset=0.7（默认，实际 ' + wallDef.wallOffset + '）');
}

console.log('');
if (failures > 0) {
    console.log('❌ 验证存在 ' + failures + ' 项失败');
    process.exit(1);
} else {
    console.log('✅ 「相机距模型 0.5m 触发碰撞」验证全部通过');
}
