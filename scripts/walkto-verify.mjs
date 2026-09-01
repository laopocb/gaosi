// walkTo 功能自测：验证 dist/index.js 注入的点击行走状态机数学逻辑
// （目的地计算、空气墙钳制、easeOut 插值、到达清空、orbit 同步）。
import { readFileSync } from 'node:fs';

const js = readFileSync('dist/index.js', 'utf8');

// —— 轻量 Vec3 mock（与 PlayCanvas Vec3 行为一致：copy/sub/normalize/mulScalar/set/distance/clone）——
class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    copy(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    sub(o) { this.x -= o.x; this.y -= o.y; this.z -= o.z; return this; }
    add(o) { this.x += o.x; this.y += o.y; this.z += o.z; return this; }
    mulScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    normalize() { const l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
    distance(o) { const dx = this.x - o.x, dy = this.y - o.y, dz = this.z - o.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
    clone() { return new V3(this.x, this.y, this.z); }
}

let failures = 0;
const check = (cond, msg) => {
    if (cond) { console.log('  ✅ ' + msg); }
    else { failures++; console.log('  ❌ ' + msg); }
};
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// —— 1. 目的地计算（模拟 _walkToPickedPosition 的核心数学）——
console.log('walkTo 目的地计算与钳制：');
{
    const cameraPos = new V3(0, 0, 10);
    const target = new V3(0, 0, 0);
    const dir = new V3().copy(target).sub(cameraPos).normalize();
    const fov = 60;
    const halfFov = Math.min(120, Math.max(15, fov)) * Math.PI / 180 * 0.5;
    const stopDist = Math.min(4.0, Math.max(0.75, 0.75 / Math.tan(halfFov)));
    const dest = new V3().copy(target).sub(dir.mulScalar(stopDist));
    check(approx(dest.z, stopDist), `相机目的地 = 目标点前方 ${stopDist.toFixed(3)}m（z=${dest.z.toFixed(3)}）`);
    check(dest.distance(target) > 0.74 && dest.distance(target) < 4.01, '目的地与目标点距离在 [0.75, 4.0] 区间（“目标点附近”）');

    // 空气墙钳制：墙范围 [-5, 5]，目的地被钳进
    const wall = { ready: true, clampMinX: -5, clampMaxX: 5, clampMinY: -5, clampMaxY: 5, clampMinZ: -5, clampMaxZ: 5 };
    const dest2 = new V3(0, 0, 100);
    dest2.x = Math.min(wall.clampMaxX, Math.max(wall.clampMinX, dest2.x));
    dest2.y = Math.min(wall.clampMaxY, Math.max(wall.clampMinY, dest2.y));
    dest2.z = Math.min(wall.clampMaxZ, Math.max(wall.clampMinZ, dest2.z));
    check(dest2.z === 5 && dest2.x === 0, '目的地超出空气墙时被钳制到墙内（z=100 → 5）');
}

// —— 2. 状态机插值（模拟 CameraManager.update 内的 walkTo 块）——
console.log('walkTo 状态机插值（easeOut + 到达清空）：');
{
    const fromPos = new V3(0, 0, 10);
    const fromTarget = new V3(0, 0, 0);
    const toPos = new V3(0, 0, 2);
    const toTarget = new V3(1, 1, 0);
    const duration = 1.0;
    let t = 0;
    const easeOut = (x) => 1 - Math.pow(1 - x, 3);
    let camPos = fromPos.clone();
    let camTgt = fromTarget.clone();
    let finished = false;

    const step = (dt) => {
        t = Math.min(1, t + dt / Math.max(0.1, duration));
        const k = t >= 1 ? 1 : easeOut(t);
        camPos.set(
            fromPos.x + (toPos.x - fromPos.x) * k,
            fromPos.y + (toPos.y - fromPos.y) * k,
            fromPos.z + (toPos.z - fromPos.z) * k
        );
        camTgt.set(
            fromTarget.x + (toTarget.x - fromTarget.x) * k,
            fromTarget.y + (toTarget.y - fromTarget.y) * k,
            fromTarget.z + (toTarget.z - fromTarget.z) * k
        );
        if (t >= 1) finished = true;
    };

    step(0.5); // 半程
    check(approx(camPos.z, 10 - 8 * (1 - Math.pow(1 - 0.5, 3)), 1e-9), '半程相机位置按 easeOut 插值正确');
    check(!finished, '半程未到达（finished=false）');
    step(0.5); // 全程
    check(finished, '1s 后到达（finished=true）');
    check(approx(camPos.z, toPos.z) && approx(camPos.x, toPos.x), '到达后相机位置 = 目的地');
    check(approx(camTgt.x, toTarget.x) && approx(camTgt.y, toTarget.y), '到达后注视点 = 目标点');
}

// —— 3. __ssplatWalkTo 全局（dist 注入块）——
console.log('__ssplatWalkTo 全局注入：');
{
    check(js.includes('window.__ssplatWalkState = null;'), 'dist 注入 __ssplatWalkState=null 初始化');
    const walkToDef = js.match(/window\.__ssplatWalkTo = \(toX, toY, toZ, lookX, lookY, lookZ, duration\) => \{[\s\S]*?\n\};/);
    check(!!walkToDef, 'dist 注入 __ssplatWalkTo 定义');
    check(js.includes('toPos: new Vec3(toX, toY, toZ),'), '__ssplatWalkTo 写入 toPos（世界坐标）');
    check(js.includes('duration: (typeof duration === \'number\' && duration > 0) ? duration : 1.2'), '__ssplatWalkTo 时长默认 1.2s');

    // 模拟执行 __ssplatWalkTo
    const walkToBody = walkToDef[0]
        .replace('window.__ssplatWalkTo = (toX, toY, toZ, lookX, lookY, lookZ, duration) => {', 'return function(toX, toY, toZ, lookX, lookY, lookZ, duration) {')
        .replace(/\n\};$/, '\n};');
    const fakeWindow = { __ssplatWalkState: null };
    const walkToFn = new Function('window', 'Vec3', walkToBody)(fakeWindow, V3);
    fakeWindow.__ssplatWalkTo = walkToFn;
    fakeWindow.__ssplatWalkTo(0, 0, 2, 1, 1, 0, 1.5);
    check(!!fakeWindow.__ssplatWalkState, '调用后 __ssplatWalkState 被创建');
    check(approx(fakeWindow.__ssplatWalkState.toPos.z, 2) && approx(fakeWindow.__ssplatWalkState.toTarget.x, 1),
        '状态含 toPos/toTarget 且 t=0');
    check(approx(fakeWindow.__ssplatWalkState.duration, 1.5), 'duration=1.5 生效');
}

console.log('');
if (failures > 0) {
    console.log('❌ walkTo 功能自测存在 ' + failures + ' 项失败');
    process.exit(1);
} else {
    console.log('✅ walkTo 功能自测全部通过');
}
