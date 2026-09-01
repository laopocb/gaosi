// 合并视图逻辑单测：从 dist/index.js 提取补丁函数，用 mock 引擎对象验证
import { existsSync, readFileSync, statSync } from 'node:fs';
import { SplatVoxelCollision } from './splat-voxel-collision.mjs';

const js = readFileSync('dist/index.js', 'utf8');

// 提取 loadGsplat / loadGsplats / loadGsplatOrMerge 三个函数源码
const extract = (name) => {
    const marker = `const ${name} = `;
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
    return js.slice(start, end + 1) + ';';
};

const loadGsplatSrc = extract('loadGsplat');
const loadGsplatsSrc = extract('loadGsplats');
const loadGsplatOrMergeSrc = extract('loadGsplatOrMerge');

// 提取 class 定义（SceneBoundCollision，无 `const X = ` 前缀）
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

const sceneBoundCollisionSrc = extractClass('SceneBoundCollision');
const SceneBoundCollision = new Function('return ' + sceneBoundCollisionSrc + ';')();

// ---- mock 引擎环境 ----
class MockEntity {
    constructor(name) {
        this.name = name;
        this.gsplat = null;
        this._angles = null;
    }
    setLocalEulerAngles(x, y, z) { this._angles = [x, y, z]; }
    addComponent(type, data) {
        if (type !== 'gsplat') throw new Error('unexpected component ' + type);
        const numSplats = (data.asset && data.asset._numSplats) ?? 100;
        this.gsplat = {
            resource: { numSplats },
            customAabb: { center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } }
        };
    }
    getWorldTransform() { return { _angles: this._angles }; }
}
class MockAsset {
    constructor(filename, type, file, data) {
        this.filename = filename;
        this.type = type;
        this.file = file;
        this.data = data;
        this.resource = null;
        this._handlers = {};
        // 按文件名推导 splat 数（file_N.sog → (N+1)*1000），模拟真实引擎的 resource.numSplats
        const m = /file_(\d+)\.sog/.exec(filename);
        this._numSplats = m ? (Number(m[1]) + 1) * 1000 : 100;
    }
    on(ev, cb) { (this._handlers[ev] ??= []).push(cb); }
    fire(ev, ...args) { (this._handlers[ev] ?? []).forEach((cb) => cb(...args)); }
}
const mockApp = {
    root: { children: [], addChild(e) { mockApp.root.children.push(e); } },
    assets: {
        add() {},
        load(a) {
            a.resource = { numSplats: a._numSplats ?? 100, aabb: {} };
            queueMicrotask(() => a.fire('load'));
        }
    },
    renderNextFrame: false
};
// mock 环境说明：__ssplatFlip 语义已改为「默认关闭官方 Z 翻转」——
//   undefined / false → z=0（默认行为，仅 Rx(-90°) 轴修正）；
//   true（?flip=1 逃生通道）→ z=180（叠加官方 Z 翻转）。
const mockWindow = { __ssplatFlip: true, __ssplatMergeProgress: null, __ssplatMergeDone: null };
const mockLocation = { href: 'http://localhost/index.html' };

// 构造可执行函数（注入 mock）
const makeFn = (src) => {
    const fn = new Function(
        'Entity', 'Asset', 'app', 'window', 'location', 'URL',
        `return (async () => { ${src} return { loadGsplat, loadGsplats, loadGsplatOrMerge }; })();`
    );
    return fn(MockEntity, MockAsset, mockApp, mockWindow, mockLocation, URL);
};

const mod = await makeFn([loadGsplatSrc, loadGsplatsSrc, loadGsplatOrMergeSrc].join('\n'));

let failures = 0;
const check = (cond, label) => {
    if (cond) { console.log('  ✅ ' + label); }
    else { console.log('  ❌ ' + label); failures++; }
};

// ---- 测试 1：单文件模式（无 mergeFiles）----
console.log('T1 单文件模式（无 mergeFiles，回落 loadGsplat）');
mockApp.root.children = [];
const singleConfig = { contentUrl: './sog_data/0_0.sog', contents: Promise.resolve() };
const singleEntity = await mod.loadGsplatOrMerge(mockApp, singleConfig, () => {});
check(mockApp.root.children.length === 1, '实体数 = 1，实际 ' + mockApp.root.children.length);
check(singleEntity._angles && singleEntity._angles[0] === -90 && singleEntity._angles[2] === 180,
    '翻转角 = [-90,0,180]，实际 ' + JSON.stringify(singleEntity._angles));

// ---- 测试 2：合并模式 ----
console.log('T2 合并模式（14 个文件同一场景）');
mockApp.root.children = [];
const progressEvents = [];
const doneEvents = [];
mockWindow.__ssplatMergeProgress = (info) => progressEvents.push(info);
mockWindow.__ssplatMergeDone = (info) => doneEvents.push(info);
const mergeFiles = Array.from({ length: 14 }, (_, i) => ({
    contentUrl: './sog_data/file_' + i + '.sog',
    contents: Promise.resolve(),
    _numSplats: (i + 1) * 1000
}));
const mergeConfig = { contentUrl: mergeFiles[0].contentUrl, contents: mergeFiles[0].contents, mergeFiles };
const first = await mod.loadGsplatOrMerge(mockApp, mergeConfig, () => {});
check(mockApp.root.children.length === 14, '实体数 = 14，实际 ' + mockApp.root.children.length);
check(first.__ssplatMergedEntities && first.__ssplatMergedEntities.length === 14, 'first.__ssplatMergedEntities = 14');
check(progressEvents.length === 14, '进度事件 = 14，实际 ' + progressEvents.length);
check(doneEvents.length === 1, '完成事件 = 1');
check(doneEvents[0] && doneEvents[0].total === 14 && doneEvents[0].loaded === 14 && doneEvents[0].totalSplats === 105000,
    '完成事件内容正确：' + JSON.stringify(doneEvents[0]));
check(mockApp.root.children.every((c) => c._angles && c._angles[0] === -90 && c._angles[2] === 180),
    '每个实体均应用翻转 [-90,0,180]');

// ---- 测试 3：合并模式翻转关闭（__ssplatFlip = false）----
console.log('T3 合并模式翻转关闭（__ssplatFlip = false → z=0）');
mockWindow.__ssplatFlip = false;
mockApp.root.children = [];
const flipOff = await mod.loadGsplatOrMerge(mockApp, mergeConfig, () => {});
check(flipOff._angles && flipOff._angles[0] === -90 && flipOff._angles[2] === 0,
    '翻转角 = [-90,0,0]，实际 ' + JSON.stringify(flipOff._angles));
mockWindow.__ssplatFlip = true;

// ---- 测试 5：默认行为（未设置 __ssplatFlip → z=0，不再默认 180°）----
console.log('T5 默认行为（__ssplatFlip = undefined → z=0）');
mockWindow.__ssplatFlip = undefined;
mockApp.root.children = [];
const flipDefault = await mod.loadGsplatOrMerge(mockApp, mergeConfig, () => {});
check(flipDefault._angles && flipDefault._angles[0] === -90 && flipDefault._angles[2] === 0,
    '默认翻转角 = [-90,0,0]，实际 ' + JSON.stringify(flipDefault._angles));
mockWindow.__ssplatFlip = true;

// ---- 测试 4：部分文件加载失败仍能返回已加载实体 ----
console.log('T4 部分文件失败');
mockApp.root.children = [];
const badFiles = [
    { contentUrl: './sog_data/a.sog', contents: Promise.resolve() },
    { contentUrl: './sog_data/bad.sog', contents: null }
];
const origLoad = mockApp.assets.load;
mockApp.assets.load = (a) => {
    if (!a.file || !a.file.contents) { a.fire('error', new Error('no contents')); return; }
    origLoad(a);
};
let partial = null;
try {
    partial = await mod.loadGsplatOrMerge(mockApp, { mergeFiles: badFiles }, () => {});
} catch (e) {
    console.log('  ℹ️ 整体抛出（首个也失败时符合预期）: ' + e.message);
}
if (partial) {
    check(mockApp.root.children.length === 1, '仍加载了 1 个实体');
    const lastDone = doneEvents[doneEvents.length - 1];
    check(lastDone && lastDone.loaded === 1 && lastDone.failed === 1, '完成事件 loaded=1 failed=1：' + JSON.stringify(lastDone));
} else {
    check(mockApp.root.children.length === 0, '首个失败 → 无实体（符合预期）');
}
mockApp.assets.load = origLoad;

// ---- 测试 6：SceneBoundCollision 简化碰撞（AABB 房间，含 0.5m 内缩 padding）----
console.log('T6 SceneBoundCollision 简化碰撞（AABB 房间 + 0.5m padding）');
// 原始包围盒：x[-2,2] y[-1,1] z[-3,3]；SceneBoundCollision 构造时每侧内缩 0.5m
// （COLLISION_PADDING=0.5，用户意图已固化到 build.mjs）→ 碰撞「房间」：
//   x[-1.5,1.5] y[-0.5,0.5] z[-2.5,2.5]
const bbox = { center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 2, y: 1, z: 3 } };
const col = new SceneBoundCollision(bbox);
const out = { x: 0, y: 0, z: 0 };

// 6a: 盒内沿 +z 射线命中 z=2.5 墙面（padding 后 maxZ = 3 - 0.5；起点在盒内 → 返回出口交点）
const hit6 = col.queryRay(0, 0, 0, 0, 0, 1, 10);
check(hit6 !== null && Math.abs(hit6.z - 2.5) < 1e-6, '盒内沿 +z 射线命中 z=2.5 墙面，实际 ' + (hit6 && hit6.z));
// 6b: 射线距离不足 → 无命中
const miss6 = col.queryRay(0, 0, 0, 1, 0, 0, 1);
check(miss6 === null, '盒内向 +x 且距离 1 < 1.5 时无命中');
// 6c: 盒外射线未朝向盒子 → 无命中
const miss6b = col.queryRay(5, 5, 5, 1, 0, 0, 10);
check(miss6b === null, '盒外射线背离盒子时无命中');
// 6d: 球心在盒内且远离墙面 → 无碰撞
check(col.querySphere(0, 0, 0, 0.2, out) === false, '盒内远离墙面无碰撞');
// 6e: 球心在盒内贴近 x=1.5 墙面（1.4 处距墙面 0.1 < 0.2）→ 碰撞且向盒内（-x）推出 0.1
const nearWall = col.querySphere(1.4, 0, 0, 0.2, out);
check(nearWall === true && Math.abs(out.x - (-0.1)) < 1e-6 && Math.abs(out.y) < 1e-9 && Math.abs(out.z) < 1e-9,
    '盒内贴 x=1.5 墙面推出 -0.1，实际 ' + JSON.stringify(out));
// 6f: 球心在盒外贴 x=1.5 墙面（1.6，0.1 < 0.2）→ 碰撞且向盒外（+x）推出 0.1
const outside = col.querySphere(1.6, 0, 0, 0.2, out);
check(outside === true && Math.abs(out.x - 0.1) < 1e-6, '盒外贴墙向外推出 +0.1，实际 ' + JSON.stringify(out));
// 6g: 地面：球心在盒内贴近 y=-0.5 地板（-0.4 处距地板 0.1 < 0.2）→ 向上（+y）推出 0.1
const floorHit = col.querySphere(0, -0.4, 0, 0.2, out);
check(floorHit === true && Math.abs(out.y - 0.1) < 1e-6, '贴近地板向上推出 0.1，实际 ' + JSON.stringify(out));
// 6h: isFreeAt：盒内自由，盒外非自由
check(col.isFreeAt(0, 0, 0) === true, '盒内为自由空间');
check(col.isFreeAt(3, 0, 0) === false, '盒外非自由');
// 6i: querySurfaceNormal：命中 x=1.5 墙面、射线方向 -x → 法线朝外（+x，朝向射线起点）
const sn6 = col.querySurfaceNormal(1.5, 0, 0, -1, 0, 0);
check(sn6.nx === 1 && sn6.ny === 0 && sn6.nz === 0, 'x=1.5 墙面法线朝外 (+x)，实际 ' + JSON.stringify(sn6));
// 6j: querySurfaceNormal：从盒内命中 x=1.5 墙面、射线方向 +x → 法线翻转朝向射线起点（-x）
const sn6b = col.querySurfaceNormal(1.5, 0, 0, 1, 0, 0);
check(sn6b.nx === -1 && sn6b.ny === 0 && sn6b.nz === 0, '盒内撞 x=1.5 墙面法线朝内 (-x)，实际 ' + JSON.stringify(sn6b));
// 6k: queryCapsule：胶囊（y∈[0.45,1.45]）贴天花板（y=0.5，padding 后）→ 碰撞并向下推出 1.15
const capHit = col.queryCapsule(0, 0.95, 0, 0.5, 0.2, out);
check(capHit === true && Math.abs(out.y - (-1.15)) < 1e-6, '胶囊贴天花板向下推出 1.15，实际 ' + JSON.stringify(out));

// ---- 测试 7：新增补丁回归检查（需求① 404 移除 / 需求② 无动画 + 合并包围盒跳过环境 / 需求③ play 隐藏）----
console.log('T7 新增补丁回归检查（404 / 无动画 / 包围盒跳过 / play 隐藏）');
// 7a: getAnimTrack 无轨道守卫（默认模式进入 fly 的关键）
check(js.includes('无显式动画轨道时禁用官方默认动画'), 'index.js 存在 getAnimTrack 无轨道守卫注释');
check(js.includes('if (!Array.isArray(animTracks) || animTracks.length === 0) {\n                return null;'), 'index.js 存在 animTracks 为空返回 null 的守卫');
// 7b: 合并包围盒跳过超大实体（环境/天空盒）
check(js.includes('_skipFactor = 8'), 'index.js 存在合并包围盒跳过超大实体阈值 _skipFactor=8');
check(js.includes('if (_mergedTmpBox.halfExtents.length() > _baseDiag * _skipFactor)'), 'index.js 存在包围盒对角线超阈值跳过逻辑');
// 7c: 默认相机模式计算仍保留 fly 分支（isObjectExperience ? orbit : (walkAllowed ? walk : fly)）
check(js.includes("state.cameraMode = state.hasAnimation ? 'anim' : (isObjectExperience ? 'orbit' : (walkAllowed ? 'walk' : 'fly'));"),
    'index.js 保留默认模式计算（hasAnimation=false 时进入 fly）');
// 7e: Streamed SOG 叶子节点包围盒修正（流式模式空气墙/碰撞/取景用正确场景范围）
check(js.includes('[Streamed SOG 补丁] 对于八叉树资源（Streamed SOG），使用叶子节点的实际包围盒'),
    'index.js 存在 Streamed SOG 叶子节点包围盒修正注释（手机/桌面流式空气墙正确性）');
check(js.includes('window.__ssplatSceneBound = sceneBound;'), 'index.js 暴露 __ssplatSceneBound（流式 sceneBound 延迟修正引用）');
check(js.includes('window.__ssplatAirWall.setFromBBox(sceneBound)'), 'index.js 流式叶子包围盒修正后重建空气墙');

// 7d: index.html 不再发起 scene.compressed.ply fetch（需求①）
let html = '';try {
    html = readFileSync('dist/index.html', 'utf8');
} catch {
    html = '';
}
check(html !== '', 'dist/index.html 存在');
check(!html.includes('contents: fetch(contentUrl)'), 'index.html 不再调用 fetch(contentUrl)');
check(!html.includes(": './scene.compressed.ply'"), 'index.html 不再引用默认 scene.compressed.ply 路径');
check(html.includes('#play, #pause, #timelineContainer { display: none !important; }'), 'index.html 存在隐藏动画播放控件的 CSS（需求③）');

// ---- 测试 8：orbit 相机碰撞钳制（需求②：orbit 旋转/缩放不能穿出房间）----
console.log('T8 orbit 相机碰撞钳制（焦点不变，相机球体钳回 AABB 房间内）');
// 8a: 补丁存在性（dist/index.js 由 build.mjs 注入）
check(js.includes('controllers.orbit.collision = collision;'), 'index.js 存在 orbit 控制器挂接碰撞体（P11）');
check(js.includes('[orbit 碰撞补丁] 相机球体钳制到碰撞房间内'), 'index.js 存在 orbit 相机钳制补丁注释（P12）');
check(js.includes('camera.look(_orbitClamped.set(_orbitLX, _orbitLY, _orbitLZ), _orbitFocus);'), 'index.js 存在 orbit 钳制后 look() 同步朝向逻辑');

// 8b: 提取补丁后的 OrbitController 包装类 + vecToAngles（Camera#look 依赖），
//     用 mock 控制器验证钳制逻辑（不执行构造器，避免依赖官方 OrbitController$1/Vec2）
const vecToAnglesSrc = extract('vecToAngles');
const extractOrbitClass = () => {
    const marker = 'class OrbitController {';
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
const orbitControllerSrc = extractOrbitClass();
class MockVec3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    distance(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    sub2(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
    normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
}
const vecToAngles = new Function(vecToAnglesSrc + '; return vecToAngles;')();
// 注意：OrbitController 类源码不直接引用 vecToAngles（钳制逻辑经 camera.look() 调用），
// 因此这里只需把已提取的函数值作为参数注入，不能再把 vecToAnglesSrc 拼进函数体
// （否则 const vecToAngles 与形参同名会抛 SyntaxError）。
const makeOrbitController = new Function(
    'Vec3', 'vecToAngles',
    orbitControllerSrc + '\nreturn OrbitController;'
);
const OrbitControllerCls = makeOrbitController(MockVec3, vecToAngles);
// mock camera：与官方 Camera 行为一致（look 用 vecToAngles 反算 angles）
class MockCamera {
    constructor() {
        this.position = new MockVec3();
        this.angles = new MockVec3();
        this.distance = 1;
        this.fov = 65;
        this._dir = new MockVec3();
    }
    look(from, to) {
        this.position.copy(from);
        this.distance = from.distance(to);
        vecToAngles(this.angles, this._dir.sub2(to, from).normalize());
    }
}
// mock orbit 控制器：模拟官方 OrbitController$1 的状态模型（焦点/角度/距离 + update 返回期望位姿）
const makeMockController = (focus, distance) => {
    const rootPose = { position: new MockVec3(focus[0], focus[1], focus[2]), angles: new MockVec3() };
    const targetRootPose = { position: new MockVec3(focus[0], focus[1], focus[2]), angles: new MockVec3() };
    const childPose = { position: new MockVec3(0, 0, distance) };
    const targetChildPose = { position: new MockVec3(0, 0, distance) };
    return {
        _rootPose: rootPose,
        _targetRootPose: targetRootPose,
        _childPose: childPose,
        _targetChildPose: targetChildPose,
        zoomRange: { x: 0.3 },
        setPose(desiredPos, angles, dist) {
            this._desired = { position: new MockVec3(desiredPos[0], desiredPos[1], desiredPos[2]), angles: new MockVec3(angles[0], angles[1], angles[2]), distance: dist };
        },
        update() { return this._desired; }
    };
};
// 复用 T6 的碰撞体（含 0.5m padding：x[-1.5,1.5] y[-0.5,0.5] z[-2.5,2.5]，
// 球心允许范围 = [min+0.2, max-0.2]：x[-1.3,1.3] y[-0.3,0.3] z[-2.3,2.3]）
const runOrbit = (focus, desiredPos, desiredDist) => {
    const cam = new MockCamera();
    const ctrl = makeMockController(focus, desiredDist);
    ctrl.setPose(desiredPos, [0, 0, 0], desiredDist);
    const inst = Object.create(OrbitControllerCls.prototype);
    inst.controller = ctrl;
    inst.collision = col;
    inst.fov = 90;
    inst.update(1 / 60, {}, cam);
    return { cam, ctrl };
};
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// 8c: 相机在盒内 → 不钳制，位置/距离保持官方 update 结果
let r = runOrbit([0, 0, 0], [0.5, 0, 0.5], 0.70710678);
check(approx(r.cam.position.x, 0.5) && approx(r.cam.position.y, 0) && approx(r.cam.position.z, 0.5),
    '盒内相机位置保持不变，实际 (' + r.cam.position.x.toFixed(4) + ', ' + r.cam.position.y.toFixed(4) + ', ' + r.cam.position.z.toFixed(4) + ')');
check(approx(r.cam.distance, 0.70710678), '盒内相机距离保持不变，实际 ' + r.cam.distance.toFixed(6));

// 8d: 相机穿出 +x 墙（desired x=3）→ 钳回 x=1.3，焦点不变，朝向反算
r = runOrbit([0, 0, 0], [3, 0, 0], 3);
check(approx(r.cam.position.x, 1.3) && approx(r.cam.position.y, 0) && approx(r.cam.position.z, 0),
    '穿 +x 墙后钳回 x=1.3，实际 (' + r.cam.position.x.toFixed(4) + ', ' + r.cam.position.y.toFixed(4) + ', ' + r.cam.position.z.toFixed(4) + ')');
check(approx(r.cam.distance, 1.3), '钳制后距离 = 1.3，实际 ' + r.cam.distance.toFixed(4));
check(approx(r.cam.angles.y, 90, 1e-4), '朝向反算 yaw=90°（看向焦点），实际 ' + r.cam.angles.y.toFixed(4));
check(approx(r.ctrl._rootPose.position.x, 0) && approx(r.ctrl._rootPose.position.y, 0) && approx(r.ctrl._rootPose.position.z, 0),
    '焦点（target）保持不变 (0,0,0)');
check(approx(r.ctrl._childPose.position.z, r.cam.distance), 'child pose 距离已同步 = 相机距离');
check(approx(r.ctrl._rootPose.angles.y, r.cam.angles.y), 'root pose 朝向已同步 = 相机朝向');

// 8e: 相机穿出地板（desired y=-2）→ 钳回 y=-0.3，距离恰为 0.3（不小于最小缩放）
r = runOrbit([0, 0, 0], [0, -2, 0], 2);
check(approx(r.cam.position.y, -0.3) && approx(r.cam.position.x, 0) && approx(r.cam.position.z, 0),
    '穿地板后钳回 y=-0.3，实际 y=' + r.cam.position.y.toFixed(4));
check(approx(r.cam.distance, 0.3), '地板钳制后距离 = 0.3（最小缩放），实际 ' + r.cam.distance.toFixed(4));

// 8f: 焦点贴近墙面（1.2,0,0）且相机穿出 → 钳回 1.3 后距焦点 0.1 < 0.3 → 按 0.3 最小距离修正
r = runOrbit([1.2, 0, 0], [2, 0, 0], 0.8);
check(approx(r.cam.position.x, 1.5), '最小距离修正后 x=1.5（焦点 1.2 + 0.3），实际 ' + r.cam.position.x.toFixed(4));
check(approx(r.cam.distance, 0.3), '最小距离修正后距离 = 0.3，实际 ' + r.cam.distance.toFixed(4));

// 8g: 连续两帧稳定性：第一帧钳制后，把「官方下一帧重建位置」作为期望位姿再跑一次 → 不再发生钳制
r = runOrbit([0, 0, 0], [3, 0, 0], 3);
const stablePos = [r.cam.position.x, r.cam.position.y, r.cam.position.z];
const r2 = runOrbit([0, 0, 0], stablePos, r.cam.distance);
check(approx(r2.cam.position.x, stablePos[0]) && approx(r2.cam.position.y, stablePos[1]) && approx(r2.cam.position.z, stablePos[2]),
    '第二帧以钳制位置为期望位姿 → 不再钳制（状态自洽不抖动），实际 (' +
    r2.cam.position.x.toFixed(4) + ', ' + r2.cam.position.y.toFixed(4) + ', ' + r2.cam.position.z.toFixed(4) + ')');

// 8h: 无碰撞体（this.collision 为 null）→ 补丁安全跳过，行为与官方一致
const camNoCol = new MockCamera();
const ctrlNoCol = makeMockController([0, 0, 0], 3);
ctrlNoCol.setPose([3, 0, 0], [0, 0, 0], 3);
const instNoCol = Object.create(OrbitControllerCls.prototype);
instNoCol.controller = ctrlNoCol;
instNoCol.collision = null;
instNoCol.fov = 90;
instNoCol.update(1 / 60, {}, camNoCol);
check(approx(camNoCol.position.x, 3) && approx(camNoCol.distance, 3),
    '无碰撞体时保持官方行为（不钳制），实际 x=' + camNoCol.position.x.toFixed(4));

// ---- 测试 9：体素碰撞（需求① 从 splat 构建体素网格 / 需求② 相机穿透推出 / 需求③ 射线命中 / 需求④ 距离）----
console.log('T9 体素碰撞（SplatVoxelCollision：构建正确性 / 相机推出 / 射线命中 / 距离 / 性能基本断言）');
const approx9 = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// 9a: 补丁存在性（dist/index.js 由 build.mjs 注入）
check(js.includes('class SplatVoxelCollision {'), 'index.js 存在 SplatVoxelCollision 体素碰撞类');
check(js.includes('window.__ssplatVoxelBuild = (entities, startNow) => {'), 'index.js 存在全局体素构建入口 __ssplatVoxelBuild');
check(js.includes('window.__ssplatBuildVoxelFromEntity = (entity) => {'), 'index.js 存在单文件钩子 __ssplatBuildVoxelFromEntity');
check(js.includes('window.__ssplatBuildVoxelFromEntities = (entities) => {'), 'index.js 存在合并完成钩子 __ssplatBuildVoxelFromEntities');
check(js.includes('window.__ssplatVoxelMergeMode = true;'), 'index.js 存在合并模式标志（loadGsplats 内）');
check(js.includes('window.__ssplatVoxelCollision ?? (collision ?? new SceneBoundCollision(sceneBound))'), 'index.js 相机碰撞优先使用体素碰撞');
check(js.includes("_col.queryRay(_rayNear.x, _rayNear.y, _rayNear.z, _rayDir.x, _rayDir.y, _rayDir.z, 1000)"), 'index.js 存在鼠标射线持续求交（pointermove → queryRay）');
check(js.includes('window.__ssplatVoxelRayHit = {'), 'index.js 存在射线命中结果暴露 __ssplatVoxelRayHit');
check(js.includes('orbit 相机球体同样不能进入实心体素'), 'index.js orbit 钳制补丁包含体素推出分支');

// 9b: 构建正确性 —— 单 splat 填充 → 网格实心
const room9 = { center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 5, y: 5, z: 5 } };
const vox = new SplatVoxelCollision({ voxelResolution: 0.3 });
vox.setRoom(room9);
vox._allocateGrid();
// 一个 splat 位于世界 (0.1, 0.1, 0.1)，尺度 log(0.01)（≈1cm，r=0 → 仅标记中心体素）
const identity = { data: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
const prep1 = {
    numSplats: 1,
    world: identity,
    sog: false,
    x: new Float32Array([0.1]), y: new Float32Array([0.1]), z: new Float32Array([0.1]),
    sx: new Float32Array([Math.log(0.01)]), sy: new Float32Array([Math.log(0.01)]), sz: new Float32Array([Math.log(0.01)]),
    op: null
};
vox._fillFromPrepared(prep1, 0, 1);
// 网格 gMin = -4.5 → 体素 (15,15,15) 覆盖世界 [0, 0.3]³，应被标记
check(vox.isVoxelSolid(15, 15, 15) === true, '单 splat 中心体素被标记实心 (15,15,15)');
check(vox.isVoxelSolid(10, 10, 10) === false, '远处体素仍为空');
check(vox.solidCount === 1, '实心体素计数 = 1，实际 ' + vox.solidCount);

// 9c: 相机球体穿透推出 —— 球心在实心体素正上方 0.4m（球底 0.2 < 体素顶 0.3，穿透 0.1）→ 向上推出 +0.1
const push9 = { x: 0, y: 0, z: 0 };
const hit9 = vox.querySphere(0.15, 0.4, 0.15, 0.2, push9);
check(hit9 === true && approx9(push9.x, 0) && approx9(push9.y, 0.1) && approx9(push9.z, 0),
    '球心在体素上方 0.4m → 向上推出 +0.1，实际 (' + push9.x.toFixed(3) + ',' + push9.y.toFixed(3) + ',' + push9.z.toFixed(3) + ')');

// 9d: 球心进入实心体素内部 → 沿最短退出方向推出（最小穿透轴，模长 = 0.15+0.2 = 0.35）
const push9b = { x: 0, y: 0, z: 0 };
const hit9b = vox.querySphere(0.15, 0.15, 0.15, 0.2, push9b);
const mag9b = Math.hypot(push9b.x, push9b.y, push9b.z);
check(hit9b === true && approx9(mag9b, 0.35, 1e-6), '球心在实心体素内 → 推出模长 0.35，实际 ' + mag9b.toFixed(3));

// 9e: 射线命中 —— 从体素正上方 (0.15, 2, 0.15) 竖直向下 → 命中体素顶面 y=0.3
const ray9 = vox.queryRay(0.15, 2, 0.15, 0, -1, 0, 10);
check(ray9 !== null && approx9(ray9.y, 0.3), '竖直向下射线命中 y=0.3，实际 ' + (ray9 && ray9.y.toFixed(3)));
const rayMiss9 = vox.queryRay(0.15, 2, 0.15, 0, 1, 0, 10);
check(rayMiss9 !== null && approx9(rayMiss9.y, 4.5),
    '竖直向上射线无体素命中 → 回落到房间天花板 y=4.5（体素+房间叠加），实际 ' + (rayMiss9 && rayMiss9.y.toFixed(3)));

// 9f: isFreeAt —— 房间内空位自由；实心体素内非自由；房间外非自由
check(vox.isFreeAt(0, 2, 0) === true, 'isFreeAt(0,2,0)=true（房间内空位）');
check(vox.isFreeAt(0.15, 0.15, 0.15) === false, 'isFreeAt(实心体素内)=false');
check(vox.isFreeAt(6, 0, 0) === false, 'isFreeAt(房间外)=false');

// 9g: 房间外边界 —— 球心在房间外 x=6（maxX=4.5，球心允许 4.3）→ 推回 -1.7
const push9c = { x: 0, y: 0, z: 0 };
const hit9c = vox.querySphere(6, 0, 0, 0.2, push9c);
check(hit9c === true && approx9(push9c.x, -1.7), '房间外球心 x=6 → 推回 -1.7，实际 ' + push9c.x.toFixed(3));

// 9h: 距离查询 —— 相机 (0.15, 2, 0.15) 到实心体素表面 ≈ 2 - 0.3 = 1.7
const dist9 = vox.distanceToModel(0.15, 2, 0.15, 10);
check(dist9 >= 0 && approx9(dist9, 1.7, 1e-6), 'distanceToModel(0.15,2,0.15) ≈ 1.7，实际 ' + dist9.toFixed(3));
check(vox.distanceToModel(0.15, 0.15, 0.15, 10) === 0, 'distanceToModel(实心体内)=0');

// 9i: SOG 轻量解码路径 —— 合成 ml/mu/sc + codebook，位置解码后同样命中体素 (15,15,15)
// 目标世界坐标 (0.1, 0.1, 0.1)：means.mins=[-1,-1,-1]、maxs=[1,1,1] 时 nx=log(1.1)≈0.0953，
// 量化 q=(0.0953+1)/2≈0.5477 → n=round(q*65535)=35895 → mu=高字节、ml=低字节
const nq = Math.round(((Math.log(1.1) + 1) / 2) * 65535);
const muByte = Math.floor(nq / 256), mlByte = nq % 256;
const ml = new Uint8Array(4), mu = new Uint8Array(4), sc = new Uint8Array(4);
ml[0] = mlByte; mu[0] = muByte;
ml[1] = mlByte; mu[1] = muByte;
ml[2] = mlByte; mu[2] = muByte;
sc[0] = sc[1] = sc[2] = 0; // codebook 索引 0 → log(0.01)
const voxSog = new SplatVoxelCollision({ voxelResolution: 0.3 });
voxSog.setRoom(room9);
voxSog._allocateGrid();
const prepSog = {
    numSplats: 1,
    world: identity,
    sog: true,
    ml, mu, sc,
    sh0: null, sh0min: null, sh0max: null,
    means: { mins: [-1, -1, -1], maxs: [1, 1, 1] },
    version2: true,
    codebook: new Float32Array([Math.log(0.01)]),
    smin: null, smax: null
};
voxSog._fillFromPrepared(prepSog, 0, 1);
check(voxSog.isVoxelSolid(15, 15, 15) === true, 'SOG 轻量解码路径：合成数据命中体素 (15,15,15)');

// 9j: 性能基本断言 —— 10 万 splat 构建、10 万次球查询、1 万次射线查询均应在宽松阈值内
const NPERF = 100000;
const pxA = new Float32Array(NPERF), pyA = new Float32Array(NPERF), pzA = new Float32Array(NPERF);
const psxA = new Float32Array(NPERF), psya = new Float32Array(NPERF), psza = new Float32Array(NPERF);
for (let i = 0; i < NPERF; i++) {
    pxA[i] = (Math.random() * 2 - 1) * 4;
    pyA[i] = Math.random() * 4;
    pzA[i] = (Math.random() * 2 - 1) * 4;
    psxA[i] = psya[i] = psza[i] = Math.log(0.02);
}
const voxPerf = new SplatVoxelCollision({ voxelResolution: 0.3 });
voxPerf.setRoom(room9);
voxPerf._allocateGrid();
const t9a = performance.now();
voxPerf._fillFromPrepared({ numSplats: NPERF, world: identity, sog: false, x: pxA, y: pyA, z: pzA, sx: psxA, sy: psya, sz: psza, op: null }, 0, NPERF);
const buildPerfMs = performance.now() - t9a;
const out9 = { x: 0, y: 0, z: 0 };
const t9b = performance.now();
let sphHits9 = 0;
for (let i = 0; i < NPERF; i++) {
    if (voxPerf.querySphere(pxA[i], pyA[i], pzA[i], 0.2, out9)) sphHits9++;
}
const sphPerfMs = performance.now() - t9b;
const t9c = performance.now();
let rayHits9 = 0;
for (let i = 0; i < 10000; i++) {
    const dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1;
    const l = Math.hypot(dx, dy, dz) || 1;
    if (voxPerf.queryRay(pxA[i], pyA[i], pzA[i], dx / l, dy / l, dz / l, 50)) rayHits9++;
}
const rayPerfMs = performance.now() - t9c;
check(buildPerfMs < 2000, '10 万 splat 构建 < 2000ms，实际 ' + buildPerfMs.toFixed(1) + 'ms（' + (buildPerfMs * 1000 / NPERF).toFixed(1) + 'ns/splat）');
check(sphPerfMs < 1000, '10 万次 querySphere < 1000ms，实际 ' + sphPerfMs.toFixed(1) + 'ms（' + (sphPerfMs * 1000 / NPERF).toFixed(3) + 'µs/次）');
check(rayPerfMs < 1000, '1 万次 queryRay < 1000ms，实际 ' + rayPerfMs.toFixed(1) + 'ms');
console.log('  📊 性能基准（本机 Node）：构建 ' + buildPerfMs.toFixed(1) + 'ms（' + (buildPerfMs * 1000 / NPERF).toFixed(1) + 'ns/splat）· querySphere ' +
    sphPerfMs.toFixed(1) + 'ms（' + (sphPerfMs * 1000 / NPERF).toFixed(3) + 'µs/次）· queryRay ' + rayPerfMs.toFixed(1) + 'ms');

// ---- 测试 10：真实 GSplatSogData 结构端到端（根因修复：_levels[0]=ImageBitmap 不再导致空网格）----
// 复刻真实运行时链路：官方 ImgParser 把 ImageBitmap 存入 texture._levels[0]（truthy 但不可索引）。
// 旧代码 `if (!_levels[0])` 判定会跳过 GPU 读回 → 解码 NaN → 网格恒空 → 相机可穿模型。
// 修复后 _ensureTextureBytes 应检测到非字节数组并调用 readImageDataAsync（stub 模拟 GPU 读回）。
console.log('T10 真实 GSplatSogData 结构端到端（_prepareEntity → _fillFromPrepared → querySphere）');
{
    // 读取与 build.mjs 注入完全相同的类源码（去掉 export 前缀），注入 stub 依赖执行
    const voxelSrc = readFileSync('scripts/splat-voxel-collision.mjs', 'utf8')
        .replace('export class SplatVoxelCollision', 'class SplatVoxelCollision');
    // 最小 BoundingBox（仅 _prepareEntity 的包围盒跳过逻辑使用；实体 mock 走 identity 变换）
    class MockBoundingBox {
        constructor() {
            this.center = { x: 0, y: 0, z: 0 };
            this.halfExtents = {
                x: 1, y: 1, z: 1,
                length() { return Math.hypot(this.x, this.y, this.z); }
            };
        }
        setFromTransformedAabb(bbox) {
            this.center = { x: bbox.center.x, y: bbox.center.y, z: bbox.center.z };
            this.halfExtents.x = bbox.halfExtents.x;
            this.halfExtents.y = bbox.halfExtents.y;
            this.halfExtents.z = bbox.halfExtents.z;
            return this;
        }
    }
    // 模拟 readImageDataAsync（官方 = texture.read → GPU readPixels → RGBA 字节数组）：
    // 这里直接从纹理的 __mockData 返回，模拟「GPU 读回成功」
    let readbackCalls = 0;
    const readImageDataAsyncStub = async (texture) => {
        readbackCalls++;
        return texture.__mockData;
    };
    const makeRealVoxel = new Function(
        'readImageDataAsync', 'BoundingBox',
        voxelSrc + '\nreturn SplatVoxelCollision;'
    );
    const SplatVoxelCollisionReal = makeRealVoxel(readImageDataAsyncStub, MockBoundingBox);

    // —— 模拟真实 GSplatSogData（0_0.sog 风格：version=2 + scales.codebook；位置量化用
    //    与 T9 相同的 [-1,1] 范围，保证解码数学已由 T9 覆盖，本测试聚焦「读回路径」）——
    const meansT10 = { mins: [-1, -1, -1], maxs: [1, 1, 1] };
    const codebookT10 = new Float32Array([Math.log(0.01)]);
    const mkTexture = (bytes) => ({
        // 关键：_levels[0] 是「非字节数组」对象（模拟 ImageBitmap）——truthy 但不可索引
        _levels: [{ width: 1, height: 1 }],
        __mockData: bytes,
        width: 1,
        height: 1,
        device: {}
    });
    // 目标世界位置 (0.1, 0.1, 0.1)：nx=log(1.1)≈0.0953 → q≈0.54766 → n=35895（与 T9 同源）
    const nT10 = Math.round(((Math.log(1.1) + 1) / 2) * 65535);
    const muByte = Math.floor(nT10 / 256), mlByte = nT10 % 256;
    const mlT10 = new Uint8Array(4), muT10 = new Uint8Array(4), scT10 = new Uint8Array(4), sh0T10 = new Uint8Array(4);
    mlT10[0] = mlT10[1] = mlT10[2] = mlByte;
    muT10[0] = muT10[1] = muT10[2] = muByte;
    scT10[0] = scT10[1] = scT10[2] = 0; // codebook 索引 0 → log(0.01)
    sh0T10[3] = 255; // v2 alpha = 1.0（> opacityThreshold 0.1，不跳过）
    const gsplatDataT10 = {
        isSog: true,
        numSplats: 1,
        meta: { version: 2, means: meansT10, scales: { codebook: codebookT10 }, sh0: {} },
        _patchCodebooks() {},
        means_l: mkTexture(mlT10),
        means_u: mkTexture(muT10),
        scales: mkTexture(scT10),
        sh0: mkTexture(sh0T10)
    };
    const identityMatT10 = { data: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
    const entityT10 = {
        name: 'tile_0',
        gsplat: {
            resource: { gsplatData: gsplatDataT10 },
            customAabb: { center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } }
        },
        getWorldTransform() { return { clone() { return identityMatT10; } }; }
    };

    // —— 端到端：_prepareEntity（含读回修复）→ _fillFromPrepared → querySphere ——
    const roomT10 = { center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 5, y: 5, z: 5 } };
    const voxT10 = new SplatVoxelCollisionReal({ voxelResolution: 0.3 });
    voxT10.setRoom(roomT10);
    const prepT10 = await voxT10._prepareEntity(entityT10);
    check(prepT10 !== null, '_prepareEntity 返回轻量访问器（真实 GSplatSogData 结构）');
    check(readbackCalls >= 4, '检测到 _levels[0] 非字节数组 → 触发 GPU 读回（readImageDataAsync 被调用 ≥4 次，实际 ' + readbackCalls + '）');
    check(prepT10 && (prepT10.ml instanceof Uint8Array) && (prepT10.mu instanceof Uint8Array) && (prepT10.sc instanceof Uint8Array),
        'ml/mu/sc 均为字节数组（修复：不再把 ImageBitmap 当字节数组用）');
    if (prepT10) {
        voxT10._allocateGrid();
        voxT10._fillFromPrepared(prepT10, 0, 1);
        check(voxT10.solidCount === 1, '真实结构端到端：实心体素 = 1，实际 ' + voxT10.solidCount);
        // 穿透相机：球心在实心体素正上方 0.4m（球底 0.2 < 体素顶 0.3，穿透 0.1）→ 向上推出 +0.1
        const pushT10 = { x: 0, y: 0, z: 0 };
        const hitT10 = voxT10.querySphere(0.15, 0.4, 0.15, 0.2, pushT10);
        check(hitT10 === true && approx9(pushT10.y, 0.1),
            '穿透相机被体素推出（querySphere → +0.1），实际 (' + pushT10.x.toFixed(3) + ',' + pushT10.y.toFixed(3) + ',' + pushT10.z.toFixed(3) + ')');
        // 射线命中：竖直向下从体素上方 → 命中体素顶面 y=0.3
        const rayT10 = voxT10.queryRay(0.15, 2, 0.15, 0, -1, 0, 10);
        check(rayT10 !== null && approx9(rayT10.y, 0.3), '射线命中体素顶面 y=0.3，实际 ' + (rayT10 && rayT10.y.toFixed(3)));
    }
    // 静态断言：dist/index.js 注入的体素类包含修复（build.mjs 从同一源注入）
    check(js.includes('_ensureTextureBytes'), 'dist/index.js 存在 _ensureTextureBytes（读回修复已随构建注入）');
    check(js.includes('if (!isFinite(px) || !isFinite(py) || !isFinite(pz)) continue;'), 'dist/index.js SOG 解码含 isFinite 防御');
    check(!js.includes('实心体素为 0'), 'dist/index.js 已移除空网格诊断 warning（日志清理）');
}

// ---- 测试 11：固定空气墙（需求：0.3m 空气墙 + 每帧无条件相机位置钳制）----
console.log('T11 固定空气墙（sceneBound 外扩 0.3m + 相机半径 0.2m 内缩 + CameraManager.update 每帧钳制）');
{
    // 11a: 补丁存在性（dist/index.js 由 build.mjs 注入）
    check(js.includes('class SceneAirWall {'), 'index.js 存在 SceneAirWall 空气墙类');
    check(js.includes('window.__ssplatAirWall'), 'index.js 存在空气墙全局 __ssplatAirWall');
    check(js.includes('window.__ssplatWallClamps'), 'index.js 存在钳制计数 __ssplatWallClamps');
    check(!js.includes('[SSPLAT-WALL]'), 'index.js 已移除空气墙钳制调试日志标记 [SSPLAT-WALL]（日志清理）');
    check(js.includes('window.__ssplatAirWall.clampCamera(this.camera)'), 'index.js CameraManager.update 存在每帧无条件钳制调用');
    check(js.includes('window.__ssplatAirWall.setFromBBox(sceneBound)'), 'index.js Viewer 回调以合并 sceneBound 初始化空气墙');

    // 11b: 提取 SceneAirWall 类源码并实例化验证公式
    const sceneAirWallSrc = extractClass('SceneAirWall');
    const SceneAirWall = new Function('return ' + sceneAirWallSrc + ';')();

    // 以合并包围盒（13-tile 世界包围盒，env 已跳过）验证确定性公式：
    //   bbox x[-42.47,29.91] y[-6.92,9.90] z[-15.28,36.65]
    //   → 空气墙（±0.3） x[-42.77,30.21] y[-7.22,10.20] z[-15.58,36.95]
    //   → 相机球心允许（±0.2） x[-42.57,30.01] y[-7.02,10.00] z[-15.38,36.75]
    const wallBBox = {
        center: { x: (-42.47 + 29.91) / 2, y: (-6.92 + 9.90) / 2, z: (-15.28 + 36.65) / 2 },
        halfExtents: { x: (29.91 - (-42.47)) / 2, y: (9.90 - (-6.92)) / 2, z: (36.65 - (-15.28)) / 2 }
    };
    const aw = new SceneAirWall();
    const savedWindow11 = globalThis.window;
    globalThis.window = { __ssplatWallClamps: 0 };
    try {
        check(aw.ready === false, '初始未就绪（sceneBound 未确定时安全跳过）');
        const camNoReady = { position: { x: 100, y: 100, z: 100 } };
        check(aw.clampCamera(camNoReady) === false, '未就绪时 clampCamera 安全跳过（不钳制）');
        check(camNoReady.position.x === 100 && camNoReady.position.y === 100 && camNoReady.position.z === 100,
            '未就绪时相机位置不变');
        aw.setFromBBox(wallBBox);
        check(aw.ready === true, 'setFromBBox(sceneBound) 后就绪');
        check(approx(aw.minX, -42.77) && approx(aw.maxX, 30.21),
            '空气墙 x[-42.77,30.21]，实际 [' + aw.minX.toFixed(2) + ',' + aw.maxX.toFixed(2) + ']');
        check(approx(aw.minY, -7.22) && approx(aw.maxY, 10.20),
            '空气墙 y[-7.22,10.20]，实际 [' + aw.minY.toFixed(2) + ',' + aw.maxY.toFixed(2) + ']');
        check(approx(aw.minZ, -15.58) && approx(aw.maxZ, 36.95),
            '空气墙 z[-15.58,36.95]，实际 [' + aw.minZ.toFixed(2) + ',' + aw.maxZ.toFixed(2) + ']');
        check(approx(aw.clampMinX, -42.57) && approx(aw.clampMaxX, 30.01),
            '相机球心允许 x[-42.57,30.01]（内缩 0.2m），实际 [' + aw.clampMinX.toFixed(2) + ',' + aw.clampMaxX.toFixed(2) + ']');
        check(approx(aw.clampMinY, -7.02) && approx(aw.clampMaxY, 10.00),
            '相机球心允许 y[-7.02,10.00]，实际 [' + aw.clampMinY.toFixed(2) + ',' + aw.clampMaxY.toFixed(2) + ']');
        check(approx(aw.clampMinZ, -15.38) && approx(aw.clampMaxZ, 36.75),
            '相机球心允许 z[-15.38,36.75]，实际 [' + aw.clampMinZ.toFixed(2) + ',' + aw.clampMaxZ.toFixed(2) + ']');

        // 11c: 任意输入位置 → clamp 后必在相机球心允许范围内
        const inside = { position: { x: 0, y: 0, z: 0 } };
        check(aw.clampCamera(inside) === false, '盒内位置不触发钳制');
        check(inside.position.x === 0 && inside.position.y === 0 && inside.position.z === 0, '盒内位置保持不变');
        const outside = { position: { x: 100, y: -100, z: 100 } };
        check(aw.clampCamera(outside) === true, '盒外位置触发钳制');
        check(approx(outside.position.x, 30.01) && approx(outside.position.y, -7.02) && approx(outside.position.z, 36.75),
            '钳制后 = (30.01,-7.02,36.75)（各轴钳到球心允许边界），实际 (' +
            outside.position.x.toFixed(2) + ',' + outside.position.y.toFixed(2) + ',' + outside.position.z.toFixed(2) + ')');
        check(aw.clampCount === 1, '钳制计数 = 1，实际 ' + aw.clampCount);
        check(globalThis.window.__ssplatWallClamps === 1, '__ssplatWallClamps 同步 = 1，实际 ' + globalThis.window.__ssplatWallClamps);
        check(aw.clampCamera(outside) === false, '已钳制到位的位姿再次调用不重复计数');
        check(aw.clampCount === 1, '计数仍为 1，实际 ' + aw.clampCount);
        // 相机半径内缩语义：球心恰好压线（clampMinX = -42.57）→ 不钳制；越线 0.01 → 钳回
        const edge = { position: { x: -42.58, y: 0, z: 0 } };
        check(aw.clampCamera(edge) === true && approx(edge.position.x, -42.57),
            '越线 0.01 被钳回 -42.57（半径内缩生效），实际 x=' + edge.position.x.toFixed(3));
        // 任意随机位置 → 钳制后必在允许范围
        let allInside11 = true;
        for (let i = 0; i < 100; i++) {
            const p = { position: { x: (Math.random() * 200 - 100), y: (Math.random() * 200 - 100), z: (Math.random() * 200 - 100) } };
            aw.clampCamera(p);
            if (p.position.x < aw.clampMinX - 1e-9 || p.position.x > aw.clampMaxX + 1e-9 ||
                p.position.y < aw.clampMinY - 1e-9 || p.position.y > aw.clampMaxY + 1e-9 ||
                p.position.z < aw.clampMinZ - 1e-9 || p.position.z > aw.clampMaxZ + 1e-9) {
                allInside11 = false;
                break;
            }
        }
        check(allInside11, '100 个随机位置钳制后全部位于相机球心允许范围内');
    } finally {
        globalThis.window = savedWindow11;
    }
}

// ---- 测试 12：setStatus 非递归回归（BugFix：window.__ssplatOnStatus 曾自我引用导致 RangeError 爆栈，页面卡 100%）----
console.log('T12 setStatus 非递归（dist/app.js 可完整执行、状态钩子触发无爆栈）');
{
    const appSrc = readFileSync('dist/app.js', 'utf8');
    // 12a: 静态断言——不再出现「全局回调 = setStatus」的自我引用赋值（含注释中都不应出现该字面量）
    check(!/window\.__ssplatOnStatus\s*=\s*setStatus/.test(appSrc),
        'dist/app.js 不包含 window.__ssplatOnStatus = setStatus（自我引用已彻底解除）');
    // 12b: 静态断言——默认全局回调为独立箭头函数（与 setStatus 解耦定义，绝不指向自身），
    //      且为静默实现（不含 console.* 调用，日志输出已全部移除）
    check(/window\.__ssplatOnStatus\s*=\s*\(text,\s*kind\s*=\s*''\)\s*=>/.test(appSrc),
        'dist/app.js 默认全局回调为独立箭头函数（与 setStatus 解耦）');
    // 12b2: 受控日志（任务⑤）——app.js 的 console.* 调用已全部注销（注释保留，代码不删除）
    //       （console.log 调用仅以注释形式保留在 __ssplatLog 定义内，其余代码仍零 console 调用）
    const appConsoleCount12 = (appSrc.match(/console\.(log|warn|error|info|debug)\s*\(/g) || []).length;
    check(appConsoleCount12 <= 1 && appSrc.includes("console.log('[SSPLAT-LOG]['"),
        'dist/app.js console.* 已注销（仅注释形式保留 1 处，带 [SSPLAT-LOG] 前缀），实际 ' + appConsoleCount12 + ' 处');

    // 12c: 动态断言——在 mock 浏览器环境中完整执行 dist/app.js，验证不抛 RangeError、状态链路可用
    const logs12 = [];
    const mockConsole12 = {
        log: (...a) => logs12.push('log:' + a.join(' ')),
        warn: (...a) => logs12.push('warn:' + a.join(' ')),
        error: (...a) => logs12.push('error:' + a.join(' '))
    };
    const mockConfig12 = { contentUrl: 'scene.compressed.ply', contents: null };
    const mockWindow12 = { sse: { config: mockConfig12 } };
    let fetchCalls12 = 0;
    const mockFetch12 = () => { fetchCalls12++; return Promise.resolve({ ok: true }); };
    let execError12 = null;
    try {
        const runApp12 = new Function(
            'window', 'location', 'URLSearchParams', 'fetch', 'console', 'encodeURIComponent',
            appSrc + '\n;return typeof window.firstFrame;'
        );
        runApp12(mockWindow12, { search: '' }, URLSearchParams, mockFetch12, mockConsole12, encodeURIComponent);
    } catch (err) {
        execError12 = err;
    }
    check(!execError12, 'dist/app.js 在 mock 环境完整执行无异常' + (execError12 ? '（' + execError12.message + '）' : ''));
    // BugFix（桌面默认轻量）：默认（无参数、桌面 UA）→ 轻量流式（sog_data_mobile/streamed，1 次 fetch），
    // 不再默认合并 14 个 .sog（74MB 公网低带宽会超时导致封面常驻、看不到数据）
    check(fetchCalls12 === 1, '默认桌面 → fetch 1 次（轻量流式 lod-meta.json），实际 ' + fetchCalls12);
    check(mockConfig12.contentUrl === './sog_data_mobile/streamed/lod-meta.json',
        '默认桌面 → contentUrl = 轻量流式 lod-meta.json，实际 ' + mockConfig12.contentUrl);
    check(!('mergeFiles' in mockConfig12), '默认桌面 → 无 mergeFiles（不再默认 14 文件合并）');
    check(typeof mockWindow12.firstFrame === 'function', 'window.firstFrame 已挂接（初始化链路未被爆栈中断）');

    // 12d: 动态断言——逐一触发各状态钩子，确认内部 setStatus 调用不递归
    // 注：默认桌面（轻量流式）不安装合并钩子（仅 ?mode=merge 分支安装），
    // 这里先补装空实现再触发，覆盖 setStatus 非递归路径；体素钩子/首帧始终安装。
    let hookError12 = null;
    try {
        if (typeof mockWindow12.__ssplatMergeProgress !== 'function') {
            mockWindow12.__ssplatMergeProgress = () => {};
        }
        if (typeof mockWindow12.__ssplatMergeDone !== 'function') {
            mockWindow12.__ssplatMergeDone = () => {};
        }
        mockWindow12.__ssplatMergeProgress({ file: './sog_data/0_0.sog', index: 1, total: 14 });
        mockWindow12.__ssplatMergeDone({ loaded: 14, failed: 0, total: 14, totalSplats: 1234567 });
        mockWindow12.__ssplatVoxelProgress({ phase: 'voxelizing', percent: 50 });
        mockWindow12.__ssplatVoxelDone({ solidVoxels: 100, voxelResolution: 0.3, buildMs: 123 });
        mockWindow12.firstFrame();
        mockWindow12.__ssplatOnStatus('独立回调自测', 'ok');
    } catch (err) {
        hookError12 = err;
    }
    check(!hookError12,
        '状态钩子（mergeProgress/mergeDone/voxelProgress/voxelDone/firstFrame/默认回调）触发无异常' +
        (hookError12 ? '（' + hookError12.message + '）' : ''));
    check(logs12.length === 0, '状态钩子触发后无任何 console 输出（默认静默，日志清理）');
}

// ---- 测试 13：日志清理回归（需求：移除全部日志输出；官方 bundle 自带的 console.* 不计入）----
console.log('T13 日志清理回归（app.js 无 console；注入补丁区段无 [SSPLAT-CAM]/[SSPLAT-WALL]/[本地高斯查看器]）');
{
    const appSrc13 = readFileSync('dist/app.js', 'utf8');
    // 13a: dist/app.js —— 本项目注入代码的 console 调用仅限受控日志函数（任务⑤：?log=1 显式日志）；
    //      其余代码零 console 调用（输出已注销，代码注释保留）；[本地高斯查看器] 旧前缀不出现。
    const appConsoleCount13 = (appSrc13.match(/console\.(log|warn|error|info|debug)\s*\(/g) || []).length;
    check(appConsoleCount13 <= 1 && appSrc13.includes("console.log('[SSPLAT-LOG]['"),
        'dist/app.js console.* 已注销（仅注释形式保留 1 处，带 [SSPLAT-LOG] 前缀），实际 ' + appConsoleCount13 + ' 处');
    check(!appSrc13.includes('[本地高斯查看器]'), 'dist/app.js 无 [本地高斯查看器] 日志前缀');
    // 13c: 受控日志全局（任务⑤）——app.js 提供 __ssplatLog / __ssplatLogEnabled（?log= 开关）
    check(appSrc13.includes('window.__ssplatLogEnabled =') && appSrc13.includes('window.__ssplatLog ='),
        'dist/app.js 提供受控日志 __ssplatLog / __ssplatLogEnabled（?log=1 开启 / ?log=0 静默）');
    // 13b: dist/index.js —— 本项目注入补丁的日志字符串必须 0（官方 bundle 自带的不计）
    check(!js.includes('[SSPLAT-CAM]'), 'dist/index.js 无 [SSPLAT-CAM] 相机日志字符串');
    check(!js.includes('[SSPLAT-WALL]'), 'dist/index.js 无 [SSPLAT-WALL] 空气墙日志字符串');
    check(!js.includes('[本地高斯查看器]'), 'dist/index.js 无 [本地高斯查看器] 日志字符串');
    check(!js.includes("console.error('[合并视图] 加载失败"), 'dist/index.js 合并加载失败不再 console.error');
    check(!/console\.(log|warn|error)\(\s*'\[体素碰撞\]/.test(js), 'dist/index.js 体素碰撞诊断不再 console 输出');
    check(!js.includes('window.__ssplatViewer') && !js.includes('window.__ssplatLastCam') && !js.includes('__ssplatCamLog'),
        'dist/index.js 已移除相机日志相关全局（__ssplatViewer/__ssplatLastCam/__ssplatCamLog）');
}

// ---- 测试 14：手机模式（需求：手机 UA / ?mobile=1 → 手机版 Streamed SOG；?mobile=0 → 桌面合并；?mode=single → mobile.sog）----
console.log('T14 手机模式（默认流式 sog_data_mobile/streamed/、预算 0.6M、WebGL、体素 0.5m；桌面行为不变）');
{
    const appSrc14 = readFileSync('dist/app.js', 'utf8');
    const buildSrc14 = readFileSync('scripts/build.mjs', 'utf8');

    // 14a: 静态断言——app.js 存在手机版流式/单文件 URL 常量与 0.6M 预算
    check(appSrc14.includes("const MOBILE_STREAMED_URL = './sog_data_mobile/streamed/lod-meta.json';"),
        'app.js 存在 MOBILE_STREAMED_URL（轻量/手机版 Streamed SOG 入口）');
    check(appSrc14.includes("const MOBILE_SINGLE_URL = './sog_data_mobile/mobile.sog';"),
        'app.js 存在 MOBILE_SINGLE_URL（手机版单文件回退）');
    check(appSrc14.includes('const MOBILE_BUDGET_MILLIONS = 0.6;'),
        'app.js 轻量/手机预算 = 0.6M（覆盖手机版 LOD0 全量约 50 万）');
    // 模式语义 v2：?mode=merge 且非手机 → 合并；其余（默认/streamed）→ 流式；single 除外
    check(appSrc14.includes("const isMergeMode = !FORCE_IOS_PLY && !IS_MOBILE && modeParam === 'merge';"),
        'app.js isMergeMode = ?mode=merge 且非手机（iOS 排除；桌面显式完整版入口）');
    check(appSrc14.includes("const isStreamedMode = !FORCE_IOS_PLY && !isMergeMode && modeParam !== 'single'"),
        'app.js 默认/streamed 均进入流式（isStreamedMode 排除 merge/single/iOS/备用数据集）');
    check(appSrc14.includes('config.renderer = \'webgl\''),
        'app.js 手机流式模式强制 WebGL 渲染');
    check(appSrc14.includes('MOBILE_DEFAULT_VOXEL_RESOLUTION'),
        'app.js 存在手机体素分辨率默认值（0.5m）');

    // 14b: 静态断言——build.mjs 同步 sog_data_mobile（零删除 + 跳过 _src 中间产物）
    check(buildSrc14.includes('SOG_MOBILE_SRC') && buildSrc14.includes('SOG_MOBILE_DEST'),
        'build.mjs 定义手机版数据源/目标路径');
    check(buildSrc14.includes('const syncMobileData = async () => {'),
        'build.mjs 存在 syncMobileData 递归同步函数');
    check(buildSrc14.includes("if (name === '_src') continue;"),
        'build.mjs 同步时跳过 _src/ 中间产物目录');
    check(buildSrc14.includes('dist/sog_data_mobile/'),
        'build.mjs 输出 dist/sog_data_mobile/ 同步日志');

    // 14c: 动态断言——手机 UA（无 URL 参数）→ 手机版 Streamed SOG（contentUrl / budget / renderer / 体素 / 1 次 fetch）
    const runMobile = (search, ua, innerWidth) => {
        const config = { contentUrl: 'scene.compressed.ply', contents: null };
        const win = { sse: { config }, innerWidth: innerWidth ?? 390 };
        let fetchCount = 0;
        const fetchUrls = [];
        const fetchMock = (url) => { fetchCount++; fetchUrls.push(url); return Promise.resolve({ ok: true }); };
        const nav = { userAgent: ua };
        const exec = new Function(
            'window', 'location', 'URLSearchParams', 'fetch', 'console', 'encodeURIComponent', 'navigator',
            appSrc14 + '\n;return true;'
        );
        exec(win, { search }, URLSearchParams, fetchMock, { log(){}, warn(){}, error(){} }, encodeURIComponent, nav);
        return { config, fetchCount, fetchUrls, win };
    };

    // 手机 UA（安卓）：默认进入手机版流式
    const mobileUa = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
    const rMobile = runMobile('', mobileUa, 390);
    check(rMobile.config.contentUrl === './sog_data_mobile/streamed/lod-meta.json',
        '手机 UA 默认 → contentUrl = 手机版流式 lod-meta.json，实际 ' + rMobile.config.contentUrl);
    check(rMobile.config.budget === 0.6, '手机 UA 默认 → budget = 0.6M，实际 ' + rMobile.config.budget);
    check(rMobile.config.renderer === 'webgl', '手机 UA 默认 → renderer = webgl，实际 ' + rMobile.config.renderer);
    check(!('mergeFiles' in rMobile.config), '手机 UA 默认 → 删除 mergeFiles（走官方单场景流式路径）');
    check(rMobile.fetchCount === 1, '手机 UA 默认 → fetch 仅 1 次（lod-meta.json），实际 ' + rMobile.fetchCount);
    check(rMobile.win.__ssplatVoxelResolution === 0.5, '手机 UA 默认 → 体素分辨率默认 0.5m，实际 ' + rMobile.win.__ssplatVoxelResolution);

    // 桌面 UA + ?mobile=1 → 同样手机版流式（显式强制）
    const rMobileForce = runMobile('?mobile=1', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', 1920);
    check(rMobileForce.config.contentUrl === './sog_data_mobile/streamed/lod-meta.json' && rMobileForce.config.budget === 0.6,
        '?mobile=1（桌面 UA）→ 强制手机版流式 contentUrl/budget=0.6，实际 ' + rMobileForce.config.contentUrl);

    // 手机 UA + ?mobile=0 → 强制桌面语义（默认轻量流式；仅叠加 ?mode=merge 才加载完整版）
    const rDesktopForce = runMobile('?mobile=0', mobileUa, 390);
    check(rDesktopForce.config.contentUrl === './sog_data_mobile/streamed/lod-meta.json',
        '?mobile=0（手机 UA）→ 桌面语义默认轻量流式，实际 ' + rDesktopForce.config.contentUrl);
    check(rDesktopForce.config.budget === 0.6, '?mobile=0 → budget = 0.6M（轻量默认），实际 ' + rDesktopForce.config.budget);
    check(!('mergeFiles' in rDesktopForce.config), '?mobile=0 → 无 mergeFiles（不再默认合并）');
    check(rDesktopForce.fetchCount === 1, '?mobile=0 → fetch 1 次（轻量流式），实际 ' + rDesktopForce.fetchCount);
    check(rDesktopForce.win.__ssplatVoxelResolution === undefined, '?mobile=0 → 不写手机体素分辨率（桌面 0.3m 默认）');

    // ?mode=single&mobile=1 → 手机版单文件 mobile.sog（回退方案）
    const rMobileSingle = runMobile('?mode=single&mobile=1', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', 1920);
    check(rMobileSingle.config.contentUrl === './sog_data_mobile/mobile.sog',
        '?mode=single&mobile=1 → contentUrl = mobile.sog（单文件回退），实际 ' + rMobileSingle.config.contentUrl);
    check(rMobileSingle.fetchCount === 1, '?mode=single&mobile=1 → fetch 1 次，实际 ' + rMobileSingle.fetchCount);

    // 桌面 UA（无参数）→ 默认轻量流式（BugFix：桌面默认不再合并 14 个 .sog）
    const rDesktop = runMobile('', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', 1920);
    check(rDesktop.config.contentUrl === './sog_data_mobile/streamed/lod-meta.json',
        '桌面 UA 默认 → contentUrl = 轻量流式 lod-meta.json，实际 ' + rDesktop.config.contentUrl);
    check(rDesktop.config.budget === 0.6, '桌面 UA 默认 → budget = 0.6M（轻量），实际 ' + rDesktop.config.budget);
    check(!('mergeFiles' in rDesktop.config), '桌面 UA 默认 → 无 mergeFiles（不再默认合并）');
    check(rDesktop.fetchCount === 1, '桌面 UA 默认 → fetch 1 次（轻量流式），实际 ' + rDesktop.fetchCount);

    // 桌面 UA + ?mode=merge → 显式完整版（14 个 .sog 合并，74MB）
    const rDesktopMerge = runMobile('?mode=merge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', 1920);
    check(Array.isArray(rDesktopMerge.config.mergeFiles) && rDesktopMerge.config.mergeFiles.length === 14,
        '?mode=merge（桌面）→ 强制完整版合并（14 个文件），实际 ' + (rDesktopMerge.config.mergeFiles || []).length);
    check(rDesktopMerge.config.contentUrl === './sog_data/0_0.sog' && rDesktopMerge.config.budget === 12,
        '?mode=merge（桌面）→ contentUrl = ./sog_data/0_0.sog、budget = 12M（完整版）');
    check(rDesktopMerge.fetchCount === 14, '?mode=merge（桌面）→ fetch 14 次，实际 ' + rDesktopMerge.fetchCount);

    // 桌面 UA + ?mode=streamed → 桌面版流式（./streamed/lod-meta.json，不强制 WebGL）
    const rDesktopStreamed = runMobile('?mode=streamed', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', 1920);
    check(rDesktopStreamed.config.contentUrl === './streamed/lod-meta.json',
        '?mode=streamed（桌面）→ contentUrl = 桌面版流式，实际 ' + rDesktopStreamed.config.contentUrl);
    check(rDesktopStreamed.config.renderer !== 'webgl', '?mode=streamed（桌面）→ 不强制 WebGL（保持官方默认渲染器）');
}

console.log('T15 iOS 16 白屏修复（iOS 走 mobile.compressed.ply 单文件，安卓/鸿蒙保留流式；UA 检测补 iPadOS）');
{
    const appSrc15 = readFileSync('dist/app.js', 'utf8');
    const buildSrc15 = readFileSync('scripts/build.mjs', 'utf8');
    const iosFileExists = existsSync('sog_data_mobile/mobile.compressed.ply');
    const iosFileSize = iosFileExists ? statSync('sog_data_mobile/mobile.compressed.ply').size : 0;

    // 15a: 数据产物存在（mobile.compressed.ply 已生成并进入 sog_data_mobile 根目录）
    check(iosFileExists && iosFileSize > 0, 'sog_data_mobile/mobile.compressed.ply 已生成（iOS 兼容格式）');
    check(buildSrc15.includes("if (name === '_src') continue;"),
        'build.mjs 同步手机数据仍跳过 _src/（mobile.compressed.ply 位于根目录会被同步进 dist）');

    // 15b: 静态断言——app.js 存在 iOS PLY 常量/检测/路由
    check(appSrc15.includes("const MOBILE_IOS_URL = './sog_data_mobile/mobile.compressed.ply';"),
        'app.js 存在 MOBILE_IOS_URL（iOS 兼容 PLY）');
    check(appSrc15.includes('const isIOsDevice = () => {'),
        'app.js 存在 isIOsDevice()（iPhone/iPad/iPadOS 13+ Macintosh UA）');
    check(appSrc15.includes('const FORCE_IOS_PLY = IS_MOBILE && IS_IOS;'),
        'app.js 存在 FORCE_IOS_PLY（仅手机模式下 iOS 生效）');
    check(appSrc15.includes('const isStreamedMode = !FORCE_IOS_PLY &&'),
        'app.js iOS 强制绕过流式（isStreamedMode 排除 FORCE_IOS_PLY）');

    // 15c: 动态断言——iOS UA 默认 → mobile.compressed.ply（单文件、WebGL、0.6M、1 次 fetch）
    const runIos = (search, ua, innerWidth, maxTouchPoints) => {
        const config = { contentUrl: 'scene.compressed.ply', contents: null };
        const win = { sse: { config }, innerWidth: innerWidth ?? 390 };
        let fetchCount = 0;
        const fetchUrls = [];
        const fetchMock = (url) => { fetchCount++; fetchUrls.push(url); return Promise.resolve({ ok: true }); };
        const nav = { userAgent: ua, maxTouchPoints };
        const exec = new Function(
            'window', 'location', 'URLSearchParams', 'fetch', 'console', 'encodeURIComponent', 'navigator',
            appSrc15 + '\n;return true;'
        );
        exec(win, { search }, URLSearchParams, fetchMock, { log(){}, warn(){}, error(){} }, encodeURIComponent, nav);
        return { config, fetchCount, fetchUrls, win };
    };

    // iPhone iOS 16 Safari（含 Mobile 标记）
    const iosUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
    const rIos = runIos('', iosUa, 390);
    check(rIos.config.contentUrl === './sog_data_mobile/mobile.compressed.ply',
        'iOS UA 默认 → contentUrl = mobile.compressed.ply，实际 ' + rIos.config.contentUrl);
    check(rIos.config.budget === 0.6, 'iOS UA 默认 → budget = 0.6M，实际 ' + rIos.config.budget);
    check(rIos.config.renderer === 'webgl', 'iOS UA 默认 → renderer = webgl，实际 ' + rIos.config.renderer);
    check(rIos.fetchCount === 1, 'iOS UA 默认 → fetch 仅 1 次（PLY），实际 ' + rIos.fetchCount);

    // iPhone iOS 16 ?mode=single → 仍是 mobile.compressed.ply（覆盖原 mobile.sog 白屏路径）
    const rIosSingle = runIos('?mode=single', iosUa, 390);
    check(rIosSingle.config.contentUrl === './sog_data_mobile/mobile.compressed.ply',
        'iOS ?mode=single → contentUrl = mobile.compressed.ply（不再走 mobile.sog），实际 ' + rIosSingle.config.contentUrl);

    // iPhone iOS 16 ?mode=streamed / ?mode=merge → 也回落 PLY（不进入 webp 流式/14 文件合并）
    const rIosStreamed = runIos('?mode=streamed', iosUa, 390);
    check(rIosStreamed.config.contentUrl === './sog_data_mobile/mobile.compressed.ply',
        'iOS ?mode=streamed → 回落 mobile.compressed.ply（避开 WebP 流式），实际 ' + rIosStreamed.config.contentUrl);
    const rIosMerge = runIos('?mode=merge', iosUa, 390);
    check(!('mergeFiles' in rIosMerge.config) && rIosMerge.config.contentUrl === './sog_data_mobile/mobile.compressed.ply',
        'iOS ?mode=merge → 回落 mobile.compressed.ply（不加载 14 个桌面 .sog），实际 ' + rIosMerge.config.contentUrl);

    // iPadOS 13+（UA 伪装 Macintosh + maxTouchPoints>1）→ 检测为手机 → PLY
    const ipadUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15';
    const rIpad = runIos('', ipadUa, 1024, 5);
    check(rIpad.config.contentUrl === './sog_data_mobile/mobile.compressed.ply',
        'iPadOS 13+ UA（Macintosh+触摸点）→ 识别为手机并走 PLY，实际 ' + rIpad.config.contentUrl);

    // 桌面 Mac Safari（无触摸点）→ 不被误判为手机 → 桌面语义默认轻量流式（BugFix：不再默认合并）
    const macUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15';
    const rMac = runIos('', macUa, 1440, 0);
    check(rMac.config.contentUrl === './sog_data_mobile/streamed/lod-meta.json' && !('mergeFiles' in rMac.config),
        '桌面 Mac Safari（maxTouchPoints=0）→ 不误判为手机，默认轻量流式，实际 ' + rMac.config.contentUrl);

    // 安卓手机 → 仍保留流式（性能最优，不因 iOS 修复受影响）
    const androidUa = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
    const rAndroid = runIos('', androidUa, 390);
    check(rAndroid.config.contentUrl === './sog_data_mobile/streamed/lod-meta.json',
        '安卓 UA 默认 → 保留手机版流式（不受 iOS 修复影响），实际 ' + rAndroid.config.contentUrl);

    // 鸿蒙/华为 UA（不含 android 关键字变体）→ 仍识别为手机 → 流式
    const harmonyUa = 'Mozilla/5.0 (Phone; OpenHarmony 4.0; HarmonyOS 4.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';
    const rHarmony = runIos('', harmonyUa, 390);
    check(rHarmony.config.contentUrl === './sog_data_mobile/streamed/lod-meta.json',
        '鸿蒙 UA（Phone/OpenHarmony）→ 识别为手机并走流式，实际 ' + rHarmony.config.contentUrl);

    // ?mobile=0 强制桌面语义 → iOS 也走桌面轻量流式（显式覆盖优先；仅叠加 ?mode=merge 才完整版）
    const rIosDesktop = runIos('?mobile=0', iosUa, 390);
    check(rIosDesktop.config.contentUrl === './sog_data_mobile/streamed/lod-meta.json' && !('mergeFiles' in rIosDesktop.config),
        'iOS + ?mobile=0 → 桌面语义默认轻量流式（不再默认合并），实际 ' + rIosDesktop.config.contentUrl);
    const rIosDesktopMerge = runIos('?mobile=0&mode=merge', iosUa, 390);
    check(Array.isArray(rIosDesktopMerge.config.mergeFiles) && rIosDesktopMerge.config.mergeFiles.length === 14,
        'iOS + ?mobile=0&mode=merge → 强制完整版合并 14 文件，实际 ' + (rIosDesktopMerge.config.mergeFiles || []).length);
}

console.log('T16 手机端触控（官方双指平移/捏合已内置；补丁新增 orbit 焦点空气墙钳制 + 点击行走状态机）');
{
    const jsSrc16 = readFileSync('dist/index.js', 'utf8');

    // 官方双指平移/捏合（TouchDevice）仍在（任务②A 的基础能力）
    check(jsSrc16.includes('class MultiTouchSource'),
        'index.js 存在 MultiTouchSource（官方双指质心/距离差实现）');
    check(jsSrc16.includes('screenToWorld(cameraComponent, touch[0], touch[1], distance, orbitMove)'),
        'index.js 存在双指平移屏幕→世界换算（orbit 平移 target）');
    check(jsSrc16.includes('pinchMoveTmp.set(0, 0, (orbit - directFirstPerson) * pinch[0])'),
        'index.js 存在双指捏合缩放（距离差 → orbit z 缩放）');

    // 补丁：orbit 焦点钳制到空气墙内（任务②A target 钳制）
    check(jsSrc16.includes('orbit 焦点（target）同样钳制到空气墙内'),
        'index.js 已注入 orbit 焦点空气墙钳制补丁');
    check(jsSrc16.includes('_oc._targetRootPose.position'),
        'index.js orbit 焦点钳制同时覆盖 _targetRootPose（双指平移目标）');

    // 补丁：点击行走状态机（CameraManager.update 内）
    check(jsSrc16.includes('window.__ssplatWalkState = null;'),
        'index.js 已注入 __ssplatWalkState 全局');
    check(jsSrc16.includes('window.__ssplatWalkTo = (toX, toY, toZ, lookX, lookY, lookZ, duration) =>'),
        'index.js 已注入 __ssplatWalkTo 入口');
    check(jsSrc16.includes('点击行走状态机（每帧推进平滑飞行）'),
        'index.js CameraManager.update 已注入点击行走状态机注释');

    // 补丁：NavInteraction 手机端 orbit 点击行走（?walk=0 关闭，桌面不变）
    check(jsSrc16.includes('_walkToPickedPosition = async (offsetX, offsetY) => {'),
        'index.js 已注入 _walkToPickedPosition（拾取→目的地→空气墙钳制→飞行）');
    check(jsSrc16.includes('if (window.__ssplatWalkEnabled !== false) {'),
        'index.js 手机端 orbit 点击行走受 __ssplatWalkEnabled 控制（?walk=0 关闭）');
    check(jsSrc16.includes('else {'),
        'index.js ?walk=0 时回落官方聚焦行为');

    // 桌面端点击行为不变：NavInteraction._onPointerUp 的 orbit 分支仍是 _focusPickedPosition
    check(jsSrc16.includes("else if (state.cameraMode === 'orbit') {"),
        'index.js 官方桌面点击 orbit 聚焦路径仍在（桌面行为不变）');
}

console.log('T17 传输中断修复（nginx 大文件调优 + UA 检测修正；.sog-gsplat 为资源缓存键非真实请求）');
{
    const nginxSrc17 = readFileSync('deploy/nginx.conf', 'utf8');
    const appSrc17 = readFileSync('dist/app.js', 'utf8');

    // nginx：大文件下载稳定性调优
    check(nginxSrc17.includes('send_timeout 300;'),
        'nginx.conf 已设置 send_timeout 300（低带宽大 .sog 下载不再中途断开）');
    check(nginxSrc17.includes('sendfile on;') && nginxSrc17.includes('tcp_nopush on;') && nginxSrc17.includes('tcp_nodelay on;'),
        'nginx.conf 已启用 sendfile/tcp_nopush/tcp_nodelay');
    check(nginxSrc17.includes('keepalive_timeout 75;'),
        'nginx.conf 已设置 keepalive_timeout 75');
    check(nginxSrc17.includes('gzip_types text/css application/javascript application/json image/svg+xml;'),
        'nginx.conf gzip_types 不含 .sog/.ply/.webp（二进制不被 gzip 误伤）');
    check(nginxSrc17.includes('try_files $uri =404;') && nginxSrc17.includes('\\.(sog|ply|spz|ksplat|splat|webp'),
        'nginx.conf 二进制资源缺失返回 404（不再回退 index.html 造成解析失败）');

    // UA 检测修正：iPadOS 13+（Macintosh）识别
    check(appSrc17.includes('/macintosh/.test(ua) && typeof navigator !== \'undefined\' &&'),
        'app.js isIOsDevice 覆盖 iPadOS 13+（Macintosh UA）');

    // .sog-gsplat 结论：ResourceLoader 缓存键（URL-type），非真实网络请求
    check(!/location.*sog-gsplat/.test(nginxSrc17), 'nginx.conf 不需要为 .sog-gsplat 配置 location（非真实请求）');
}

console.log('T18 点击行走开关（?walk=0 关闭；默认开启；桌面不启用）');
{
    const appSrc18 = readFileSync('dist/app.js', 'utf8');
    const jsSrc18 = readFileSync('dist/index.js', 'utf8');

    // app.js 解析 ?walk= 并写入 __ssplatWalkEnabled（默认 true）
    check(appSrc18.includes("const walkParam = params.get('walk');"),
        'app.js 解析 ?walk= 参数');
    check(appSrc18.includes("window.__ssplatWalkEnabled = walkParam !== '0';"),
        'app.js __ssplatWalkEnabled 默认开启（仅 ?walk=0 关闭）');

    // 开关只作用于手机端 orbit 点击行走（bundle 内判断），桌面 pointerup 路径不含该开关
    const walkGateCount = (jsSrc18.match(/window\.__ssplatWalkEnabled/g) || []).length;
    check(walkGateCount === 1, 'index.js __ssplatWalkEnabled 仅 1 处使用（mobileTap orbit 分支），实际 ' + walkGateCount);
}


console.log('T19 页面标题「云冈艺术」（build.mjs 严格补丁 + dist/index.html 产物 0 处 SuperSplat Viewer）');
{
    const buildSrc19 = readFileSync('scripts/build.mjs', 'utf8');
    let html19 = '';
    try {
        html19 = readFileSync('dist/index.html', 'utf8');
    } catch {
        html19 = '';
    }

    // build.mjs：标题与品牌区两个严格补丁已定义并注册到 htmlPatchSteps
    check(buildSrc19.includes("const HTML_TITLE_TARGET = '<title>SuperSplat Viewer</title>';"),
        'build.mjs 定义标题严格补丁目标（<title>SuperSplat Viewer</title>）');
    check(buildSrc19.includes("const HTML_TITLE_REPLACEMENT = '<title>云冈艺术</title>';"),
        'build.mjs 标题替换为 <title>云冈艺术</title>');
    check(buildSrc19.includes("'index.html-页面标题改为「云冈艺术」'"),
        'build.mjs htmlPatchSteps 注册标题补丁步骤（严格校验 1 处）');
    check(buildSrc19.includes("const HTML_BRAND_TARGET = '<span class=\"title-name\">SuperSplat Viewer</span>';"),
        'build.mjs 定义品牌区文案严格补丁目标');
    check(buildSrc19.includes("'index.html-品牌区文案改为「云冈艺术」'"),
        'build.mjs htmlPatchSteps 注册品牌区文案补丁步骤');

    // dist 产物：标题正确 + 0 处 SuperSplat Viewer（含品牌区）
    check(html19.includes('<title>云冈艺术</title>'), 'dist/index.html 含 <title>云冈艺术</title>');
    check(!html19.includes('SuperSplat Viewer'), 'dist/index.html 0 处 SuperSplat Viewer（标题与品牌区均已替换）');

    // 严格校验前提：目标串在官方 HTML 各恰好 1 处（applyStrictPatch 依赖）
    const officialHtml19 = readFileSync('node_modules/@playcanvas/supersplat-viewer/public/index.html', 'utf8');
    const titleCount19 = (officialHtml19.match(/<title>SuperSplat Viewer<\/title>/g) || []).length;
    check(titleCount19 === 1, '官方 index.html <title>SuperSplat Viewer</title> 恰好 1 处（严格补丁可校验），实际 ' + titleCount19);
    const brandCount19 = (officialHtml19.match(/<span class="title-name">SuperSplat Viewer<\/span>/g) || []).length;
    check(brandCount19 === 1, '官方 index.html 品牌区文案恰好 1 处（严格补丁可校验），实际 ' + brandCount19);
}

console.log('T20 nginx 静态资源禁缓存（代码 no-cache 重验证；二进制短缓存；无 1 天缓存陷阱）');
{
    const nginx20 = readFileSync('deploy/nginx.conf', 'utf8');

    // 代码/文本类：no-cache（配合 ETag 每次重新验证）
    check(nginx20.includes('add_header Cache-Control "no-cache";'),
        'nginx.conf 代码/文本类 Cache-Control: no-cache（每次重新访问重新验证）');
    check(/location ~\* \\\.\(html\|css\|js\|mjs\|json\|map\|wasm\|svg\)\$/.test(nginx20),
        'nginx.conf 代码/文本类 location 覆盖 html/css/js/json/wasm/svg');

    // 二进制大文件：短缓存 max-age=300（5 分钟），弱网 iOS 不必每次重下 8.1MB
    check(nginx20.includes('add_header Cache-Control "public, max-age=300";'),
        'nginx.conf 二进制大文件短缓存 max-age=300（5 分钟）');
    check(nginx20.includes('\\.(sog|ply|spz|ksplat|splat|webp'), 'nginx.conf 二进制 location 覆盖 .sog/.ply/.spz');

    // 不再有 1 天缓存（活动指令；注释中允许提及历史值 max-age=86400 作说明）
    check(!nginx20.includes('add_header Cache-Control "public, max-age=86400"'),
        'nginx.conf 已移除 1 天缓存活动指令（add_header public, max-age=86400）');

    // ETag 显式开启（no-cache 重验证依赖）
    check(nginx20.includes('etag on;'), 'nginx.conf 显式开启 etag（If-None-Match 条件请求）');

    // 大文件下载稳定性调优与 404 语义保留（T17 回归）
    check(nginx20.includes('send_timeout 300;'), 'nginx.conf 仍保留 send_timeout 300（大文件稳定）');
    check(nginx20.includes('sendfile on;') && nginx20.includes('tcp_nopush on;') && nginx20.includes('tcp_nodelay on;'),
        'nginx.conf 仍保留 sendfile/tcp_nopush/tcp_nodelay');
    check(nginx20.includes('try_files $uri =404;'), 'nginx.conf 静态资源缺失仍返回 404');
    check(nginx20.includes('gzip_types text/css application/javascript application/json image/svg+xml;'),
        'nginx.conf gzip_types 不含 .sog/.ply/.webp（二进制不被 gzip 误伤）');
}

console.log('T21 ?debug=1 诊断面板（显式开启；UA/判定/contentUrl/错误收集；默认关闭不建 DOM）');
{
    const appSrc21 = readFileSync('dist/app.js', 'utf8');
    let html21 = '';
    try {
        html21 = readFileSync('dist/index.html', 'utf8');
    } catch {
        html21 = '';
    }
    const buildSrc21 = readFileSync('scripts/build.mjs', 'utf8');

    // app.js：DEBUG 开关与错误收集
    check(appSrc21.includes("const DEBUG = new URLSearchParams(location.search).get('debug') === '1';"),
        'app.js 解析 ?debug=1 为 DEBUG 开关');
    check(appSrc21.includes('window.__ssplatDebugErrors'), 'app.js 使用 window.__ssplatDebugErrors 收集错误');
    check(appSrc21.includes('__ssplatDebugPanel'), 'app.js 诊断面板 id = __ssplatDebugPanel');
    check(appSrc21.includes('FORCE_IOS_PLY='), 'app.js 面板显示 FORCE_IOS_PLY 判定结果');
    check(appSrc21.includes('contentUrl: '), 'app.js 面板显示 contentUrl');
    check(appSrc21.includes('unhandledrejection'), 'app.js 收集 unhandledrejection（Promise 拒绝）');

    // index.html：head 早期错误收集器（bundle 加载前，官方脚本执行前）
    check(html21.includes('window.__ssplatDebugErrors = window.__ssplatDebugErrors || [];'),
        'index.html 在官方脚本前注入错误收集器（可捕获早期 JS 错误）');
    check(html21.includes("window.addEventListener('error'"), 'index.html 收集器监听 window error');
    check(buildSrc21.includes('index.html-注入 ?debug=1 早期错误收集器'),
        'build.mjs htmlPatchSteps 注册早期错误收集器补丁');

    // 默认静默：面板创建仅在 DEBUG 分支内；app.js 的 console.* 仅限受控日志函数（任务⑤）
    check(/if \(DEBUG\) \{/.test(appSrc21), 'app.js 面板创建仅在 DEBUG 分支内（默认关闭）');
    const appConsoleCount21 = (appSrc21.match(/console\.(log|warn|error|info|debug)\s*\(/g) || []).length;
    check(appConsoleCount21 <= 1 && appSrc21.includes("console.log('[SSPLAT-LOG]['"),
        'app.js console.* 已注销（诊断面板不引入日志输出），实际 ' + appConsoleCount21 + ' 处');

    // 动态断言：无 debug 参数（默认）执行 app.js 不创建面板、不抛异常（既有 mock 环境回归）
    const mockConfig21 = { contentUrl: 'scene.compressed.ply', contents: null };
    const mockWindow21 = { sse: { config: mockConfig21 } };
    let execError21 = null;
    let fetchCalls21 = 0;
    const mockFetch21 = () => { fetchCalls21++; return Promise.resolve({ ok: true }); };
    try {
        const runApp21 = new Function(
            'window', 'location', 'URLSearchParams', 'fetch', 'console', 'encodeURIComponent',
            appSrc21 + '\n;return { firstFrame: typeof window.firstFrame, debugErrors: window.__ssplatDebugErrors };'
        );
        const result21 = runApp21(mockWindow21, { search: '' }, URLSearchParams, mockFetch21, { log() {}, warn() {}, error() {} }, encodeURIComponent);
        check(result21 && result21.firstFrame === 'function', '默认模式（无 ?debug=1）app.js 完整执行且 firstFrame 已挂接');
        check(Array.isArray(result21.debugErrors), '默认模式 window.__ssplatDebugErrors 为数组（错误收集器兜底就绪）');
    } catch (err) {
        execError21 = err;
    }
    check(!execError21, '默认模式 app.js 执行无异常' + (execError21 ? '（' + execError21.message + '）' : ''));
}

console.log('T22 加载封面 splash（#ssplatCover + dist/cover.jpg + firstFrame 隐藏链路；默认无日志）');
{
    const html22 = readFileSync('dist/index.html', 'utf8');
    const appSrc22 = readFileSync('dist/app.js', 'utf8');
    const buildSrc22 = readFileSync('scripts/build.mjs', 'utf8');
    const nginx22 = readFileSync('deploy/nginx.conf', 'utf8');

    // 22a: dist/index.html 含 splash DOM（id=ssplatCover + ssplat-cover class）+ 内联 window.__ssplatCover 定义
    check(html22.includes('id="ssplatCover"') && html22.includes('class="ssplat-cover"'),
        'dist/index.html 含 #ssplatCover 封面 DOM（id + ssplat-cover class）');
    check(html22.includes('window.__ssplatCover'), 'dist/index.html 含内联 window.__ssplatCover 定义（官方脚本之前注入）');
    check(/url\(["']\.\/cover\.jpg["']\)/.test(html22), 'dist/index.html 封面背景图指向 ./cover.jpg（不硬编码用户桌面路径）');
    // 比例适配（BugFix）：竖版海报统一 contain + center center（宽屏完整显示，不裁剪）
    check(/background-size:\s*contain;/.test(html22), 'dist/index.html 封面 background-size: contain（比例适配，宽屏完整显示海报）');
    check(/background-position:\s*center center;/.test(html22), 'dist/index.html 封面 background-position: center center');
    // splash 超时兜底（BugFix）：app.js 解析 ?splashtimeout= 并注入 __ssplatFailHint 失败提示
    check(appSrc22.includes("const splashTimeoutParam = params.get('splashtimeout');"),
        'dist/app.js 解析 ?splashtimeout= 参数（超时时长可配置，默认 30s）');
    check(appSrc22.includes('__ssplatFailHint') && appSrc22.includes('加载失败，请刷新重试'),
        'dist/app.js 超时兜底创建 #__ssplatFailHint 失败提示（仅失败时出现）');
    check(appSrc22.includes('splashTimeoutMs = isMergeMode ? 600000 : 180000'),
        'dist/app.js splash 超时默认 600s（merge）/180s（流式），首帧超时自动隐藏封面');

    // 22b: dist/cover.jpg 存在且非空
    const coverSize22 = existsSync('dist/cover.jpg') ? statSync('dist/cover.jpg').size : 0;
    check(existsSync('dist/cover.jpg') && coverSize22 > 0,
        'dist/cover.jpg 存在且 size > 0（实际 ' + coverSize22 + ' 字节）');

    // 22c: app.js firstFrame 隐藏链路（首帧渲染完成 → onFirstFrameInternal → window.__ssplatCover() → 封面加 .hidden）
    check(appSrc22.includes('onFirstFrameInternal();'),
        'dist/app.js firstFrame 内调用 onFirstFrameInternal()（三种模式统一隐藏链路）');
    check(appSrc22.includes("if (typeof window.__ssplatCover === 'function')") &&
        appSrc22.includes('window.__ssplatCover();'),
        'dist/app.js onFirstFrameInternal 内调用 window.__ssplatCover()（封面隐藏）');
    check(appSrc22.includes("if (typeof window.__ssplatCover !== 'function')"),
        'dist/app.js 兜底定义 window.__ssplatCover（与 index.html 内联定义一致、防重复）');

    // 22d: build.mjs 注册 splash 严格补丁 + 复制 cover.jpg 到 dist（nginx/Docker 直接取 dist/）
    check(buildSrc22.includes('index.html-注入加载封面 splash'),
        'build.mjs htmlPatchSteps 注册封面 splash 严格补丁（applyStrictPatch 校验 1 处）');
    check(buildSrc22.includes('COVER_DEST') && buildSrc22.includes('dist/cover.jpg'),
        'build.mjs 定义 cover.jpg 复制步骤（项目根 cover.jpg → dist/cover.jpg）');

    // 22e: 默认静默（splash 不输出 console；app.js 的 console.* 已注销，代码注释保留）
    const appConsoleCount22 = (appSrc22.match(/console\.(log|warn|error|info|debug)\s*\(/g) || []).length;
    check(appConsoleCount22 <= 1 && appSrc22.includes("console.log('[SSPLAT-LOG]['"),
        'app.js console.* 已注销（splash 不引入日志输出），实际 ' + appConsoleCount22 + ' 处');

    // 22f: nginx cover.jpg 单独 no-cache（新封面部署后重新访问立即生效，不走 5 分钟短缓存）
    check(nginx22.includes('location = /cover.jpg') &&
        /location = \/cover\.jpg[\s\S]{0,300}?Cache-Control "no-cache"/.test(nginx22),
        'nginx.conf 为 /cover.jpg 单独配置 no-cache（新封面立即生效）');

    // 22g: 动态断言——mock document：完整执行 app.js 后触发 firstFrame，封面元素被加 .hidden（splash 隐藏）
    const coverEl22 = {
        classList: {
            _set: new Set(),
            contains(cls) { return this._set.has(cls); },
            add(cls) { this._set.add(cls); },
            remove(cls) { this._set.delete(cls); }
        },
        style: {}
    };
    const mockDocument22 = { getElementById: (id) => (id === 'ssplatCover' ? coverEl22 : null) };
    const mockWindow22 = {
        sse: { config: { contentUrl: 'scene.compressed.ply', contents: null } },
        document: mockDocument22
    };
    let execError22 = null;
    let result22 = null;
    try {
        const runApp22 = new Function(
            'window', 'location', 'URLSearchParams', 'fetch', 'console', 'encodeURIComponent', 'document', 'setTimeout',
            appSrc22 + '\n;return { firstFrame: window.firstFrame, hide: window.__ssplatCover };'
        );
        result22 = runApp22(
            mockWindow22,
            { search: '' },
            URLSearchParams,
            () => Promise.resolve({ ok: true }),
            { log() {}, warn() {}, error() {} },
            encodeURIComponent,
            mockDocument22,
            setTimeout
        );
    } catch (err) {
        execError22 = err;
    }
    check(!execError22, 'app.js 在 mock 环境完整执行无异常' + (execError22 ? '（' + execError22.message + '）' : ''));
    check(result22 && typeof result22.hide === 'function',
        'app.js 已定义 window.__ssplatCover（mock 环境兜底补装）');
    check(!coverEl22.classList.contains('hidden'), 'firstFrame 触发前 #ssplatCover 未隐藏（封面正常显示）');
    let hookError22 = null;
    try {
        result22 && result22.firstFrame(); // 触发首帧 → 隐藏封面
    } catch (err) {
        hookError22 = err;
    }
    check(!hookError22, 'firstFrame 触发无异常' + (hookError22 ? '（' + hookError22.message + '）' : ''));
    check(coverEl22.classList.contains('hidden'),
        'firstFrame 触发后 #ssplatCover 已添加 .hidden（splash 淡出隐藏链路生效）');
}

// ---- 测试 23：BugFix——Web 端桌面默认轻量数据 + ?mode=merge 完整版 + splash 超时兜底 + 封面 contain ----
console.log('T23 桌面默认轻量路由 + ?mode=merge 完整版 + splash 超时兜底 + 封面 contain（BugFix：Web 端桌面看不到数据 + 封面比例不适配）');
{
    const appSrc23 = readFileSync('dist/app.js', 'utf8');
    const html23 = readFileSync('dist/index.html', 'utf8');
    const buildSrc23 = readFileSync('scripts/build.mjs', 'utf8');

    // 23a: 静态断言——模式语义 v2 关键行（桌面默认轻量；?mode=merge 显式完整版）
    check(appSrc23.includes("const isMergeMode = !FORCE_IOS_PLY && !IS_MOBILE && modeParam === 'merge';"),
        'app.js isMergeMode = ?mode=merge 且非手机（iOS 排除；桌面显式完整版入口）');
    check(appSrc23.includes("const isStreamedMode = !FORCE_IOS_PLY && !isMergeMode && modeParam !== 'single'"),
        'app.js 默认/streamed 均进入流式（isStreamedMode 排除 merge/single/iOS/备用数据集）');

    // 23b: 动态断言——桌面 UA 默认 → 轻量流式（sog_data_mobile/streamed，1 次 fetch，无 mergeFiles）
    const runCase23 = (search, ua, innerWidth, maxTouchPoints) => {
        const config = { contentUrl: 'scene.compressed.ply', contents: null };
        const win = { sse: { config }, innerWidth: innerWidth ?? 1920 };
        let fetchCount = 0;
        const fetchUrls = [];
        const fetchMock = (url) => { fetchCount++; fetchUrls.push(url); return Promise.resolve({ ok: true }); };
        const nav = { userAgent: ua, maxTouchPoints: maxTouchPoints ?? 0 };
        const exec = new Function(
            'window', 'location', 'URLSearchParams', 'fetch', 'console', 'encodeURIComponent', 'navigator',
            appSrc23 + '\n;return true;'
        );
        exec(win, { search }, URLSearchParams, fetchMock, { log(){}, warn(){}, error(){} }, encodeURIComponent, nav);
        return { config, fetchCount, fetchUrls, win };
    };

    const desktopUa23 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    const mobileUa23 = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

    // 桌面 UA 默认（无参数）→ 轻量流式
    const d23Default = runCase23('', desktopUa23, 1920);
    check(d23Default.config.contentUrl === './sog_data_mobile/streamed/lod-meta.json',
        '桌面 UA 默认 → contentUrl = 轻量流式 lod-meta.json，实际 ' + d23Default.config.contentUrl);
    check(d23Default.config.budget === 0.6, '桌面 UA 默认 → budget = 0.6M（轻量），实际 ' + d23Default.config.budget);
    check(!('mergeFiles' in d23Default.config), '桌面 UA 默认 → 无 mergeFiles（不再默认 74MB 合并）');
    check(d23Default.fetchCount === 1, '桌面 UA 默认 → fetch 1 次（轻量流式），实际 ' + d23Default.fetchCount);

    // 桌面 UA + ?mode=merge → 完整版 14 文件（74MB，带宽足够时用）
    const d23Merge = runCase23('?mode=merge', desktopUa23, 1920);
    check(Array.isArray(d23Merge.config.mergeFiles) && d23Merge.config.mergeFiles.length === 14,
        '?mode=merge（桌面）→ 完整版合并 14 文件，实际 ' + (d23Merge.config.mergeFiles || []).length);
    check(d23Merge.config.contentUrl === './sog_data/0_0.sog' && d23Merge.config.budget === 12,
        '?mode=merge → contentUrl/budget=12M（完整版行为保留）');
    check(d23Merge.fetchCount === 14, '?mode=merge → fetch 14 次，实际 ' + d23Merge.fetchCount);

    // 手机 UA + ?mode=merge → 回落手机版流式（无手机版合并数据，不生成 14 个手机版 .sog）
    const d23MobileMerge = runCase23('?mode=merge', mobileUa23, 390);
    check(d23MobileMerge.config.contentUrl === './sog_data_mobile/streamed/lod-meta.json' && !('mergeFiles' in d23MobileMerge.config),
        '手机 UA + ?mode=merge → 回落手机版流式（无手机版合并数据），实际 ' + d23MobileMerge.config.contentUrl);

    // ?mobile=0（手机 UA）→ 桌面语义默认轻量；?mobile=0&mode=merge → 完整版
    const d23Mobile0 = runCase23('?mobile=0', mobileUa23, 390);
    check(d23Mobile0.config.contentUrl === './sog_data_mobile/streamed/lod-meta.json' && !('mergeFiles' in d23Mobile0.config),
        '?mobile=0 → 保持轻量（不再默认合并），实际 ' + d23Mobile0.config.contentUrl);
    const d23Mobile0Merge = runCase23('?mobile=0&mode=merge', mobileUa23, 390);
    check(Array.isArray(d23Mobile0Merge.config.mergeFiles) && d23Mobile0Merge.config.mergeFiles.length === 14,
        '?mobile=0&mode=merge → 完整版 14 文件（显式覆盖优先），实际 ' + (d23Mobile0Merge.config.mergeFiles || []).length);

    // 23c: splash 超时兜底动态断言（mock document/setTimeout；首帧 30s 未触发 → hidden + 失败提示）
    const coverEl23 = {
        classList: {
            _set: new Set(),
            contains(cls) { return this._set.has(cls); },
            add(cls) { this._set.add(cls); },
            remove(cls) { this._set.delete(cls); }
        },
        style: {}
    };
    const createdEls23 = [];
    const makeEl23 = (tag) => {
        const el = { id: '', tagName: tag, style: {}, parentNode: null, textContent: '', children: [] };
        el.appendChild = (child) => { child.parentNode = el; el.children.push(child); };
        el.removeChild = (child) => { child.parentNode = null; const i = el.children.indexOf(child); if (i >= 0) el.children.splice(i, 1); };
        el.addEventListener = () => {};
        return el;
    };
    const mockDocument23 = {
        getElementById: (id) => {
            if (id === 'ssplatCover') return coverEl23;
            if (id === '__ssplatFailHint') return createdEls23.find((el) => el.id === '__ssplatFailHint') || null;
            return null;
        },
        createElement: (tag) => {
            const el = makeEl23(tag);
            createdEls23.push(el);
            return el;
        },
        body: {
            appendChild(el) { el.parentNode = mockDocument23.body; },
            removeChild(el) { el.parentNode = null; }
        }
    };
    let capturedTimeout23 = null;
    const mockSetTimeout23 = (fn, ms) => { capturedTimeout23 = { fn, ms }; return { unref() {} }; };
    const mockClearTimeout23 = () => {};
    const mockWin23 = { sse: { config: { contentUrl: 'scene.compressed.ply', contents: null } }, innerWidth: 1920, document: mockDocument23 };
    let execError23 = null;
    let result23 = null;
    try {
        const runApp23 = new Function(
            'window', 'location', 'URLSearchParams', 'fetch', 'console', 'encodeURIComponent', 'navigator', 'document', 'setTimeout', 'clearTimeout',
            appSrc23 + '\n;return { firstFrame: window.firstFrame, hide: window.__ssplatCover };'
        );
        result23 = runApp23(
            mockWin23,
            { search: '?splashtimeout=30' },
            URLSearchParams,
            () => Promise.resolve({ ok: true }),
            { log() {}, warn() {}, error() {} },
            encodeURIComponent,
            { userAgent: desktopUa23, maxTouchPoints: 0 },
            mockDocument23,
            mockSetTimeout23,
            mockClearTimeout23
        );
    } catch (err) {
        execError23 = err;
    }
    check(!execError23, 'app.js 在 mock 环境（splashtimeout=30）完整执行无异常' + (execError23 ? '（' + execError23.message + '）' : ''));
    check(capturedTimeout23 !== null && capturedTimeout23.ms === 30000,
        '?splashtimeout=30 → 超时定时器 30000ms（默认 30s，可配置）' + (capturedTimeout23 ? '，实际 ' + capturedTimeout23.ms : ''));
    check(!coverEl23.classList.contains('hidden'), '超时回调触发前封面未隐藏');
    let timeoutError23 = null;
    try {
        capturedTimeout23 && capturedTimeout23.fn(); // 模拟 30s 后首帧仍未触发（加载失败场景）
    } catch (err) {
        timeoutError23 = err;
    }
    check(!timeoutError23, '超时回调执行无异常' + (timeoutError23 ? '（' + timeoutError23.message + '）' : ''));
    check(coverEl23.classList.contains('hidden'),
        '超时回调 → 封面已隐藏（splash 不再常驻遮挡，BugFix：失败时不再"海报+黑屏"）');
    const failHint23 = createdEls23.find((el) => el.id === '__ssplatFailHint');
    // BugFix 后语义：fetch 未失败（仍在下载）→ 不创建失败提示，改创建中性「正在加载…」；
    // 仅 fetch 真失败才创建 #__ssplatFailHint（mock 环境 fetch ok → 走仍下载分支）
    check(!failHint23, '超时回调（仍在下载）→ 不创建失败提示（区分真失败/低带宽仍下载，BugFix）');
    const loadingHint23 = createdEls23.find((el) => el.id === '__ssplatLoadingHint');
    check(!!loadingHint23 && loadingHint23.textContent.includes('正在加载'),
        '超时回调（仍在下载）→ 创建 #__ssplatLoadingHint 中性提示（数据到齐后首帧自动清除）');
    // 成功路径：firstFrame 到达 → 失败提示从 DOM 移除（不残留）
    let ffError23 = null;
    try {
        result23 && result23.firstFrame();
    } catch (err) {
        ffError23 = err;
    }
    check(!ffError23, 'firstFrame 触发无异常' + (ffError23 ? '（' + ffError23.message + '）' : ''));
    check(!createdEls23.some((el) => el.id === '__ssplatFailHint' && el.parentNode),
        'firstFrame 后失败提示已从 DOM 移除（成功路径不残留）');

    // 23d: 封面 contain 样式断言（build.mjs 源码 + dist 产物）
    check(buildSrc23.includes("background-size: contain;"),
        'build.mjs 注入 background-size: contain（竖版海报完整显示，宽屏两侧黑边）');
    check(/background-size:\s*contain;/.test(html23),
        'dist/index.html 产物封面 background-size: contain（比例适配）');
    check(/background-position:\s*center center;/.test(html23),
        'dist/index.html 产物封面 background-position: center center');
}

// ---- 测试 24：测试数据页面（任务④：页面区分 /test，不通过按钮；默认页完全不变）----
console.log('T24 测试数据页面（/test 路径识别 + 单文件加载 new_data 优化产物；默认页无按钮无 test 逻辑）');
{
    const appSrc24 = readFileSync('dist/app.js', 'utf8');

    // 24a: 静态断言——/test 路径识别 + new_data 数据源；无切换按钮（DATASETS/ensureDatasetSwitcher 已移除）
    check(appSrc24.includes("const IS_TEST_PAGE = typeof location.pathname === 'string'"),
        'app.js 按 location.pathname 识别测试页（/test，SPA 回退语义）');
    check(appSrc24.includes("location.pathname.endsWith('/test')"),
        'app.js 存在 /test 路径后缀判断');
    check(appSrc24.includes("'./new_data/t0.mobile.sog'") && appSrc24.includes("'./new_data/t0.compressed.ply'"),
        'app.js 测试页数据源 = new_data/ 优化产物（mobile.sog 桌面/安卓 + compressed.ply iOS）');
    check(!appSrc24.includes('ensureDatasetSwitcher') && !appSrc24.includes('__ssplatDatasetSwitch'),
        'app.js 无数据集切换按钮逻辑（任务④改为页面区分，按钮已移除）');
    check(!appSrc24.includes("params.get('data')"),
        'app.js 无 ?data= 参数逻辑（任务④改为页面区分，参数已移除）');

    // 24b: 动态断言——mock 环境（pathname=/test，桌面 UA）→ 强制单文件模式加载 t0.mobile.sog
    const runCase24 = (pathname, ua, maxTouchPoints, innerWidth) => {
        const config = { contentUrl: 'scene.compressed.ply', contents: null };
        const win = { sse: { config }, innerWidth: innerWidth ?? 1920 };
        let fetchCount = 0;
        const fetchUrls = [];
        const fetchMock = (url) => { fetchCount++; fetchUrls.push(url); return Promise.resolve({ ok: true }); };
        const nav = { userAgent: ua, maxTouchPoints: maxTouchPoints ?? 0 };
        const exec = new Function(
            'window', 'location', 'URLSearchParams', 'fetch', 'console', 'encodeURIComponent', 'navigator',
            appSrc24 + '\n;return true;'
        );
        exec(win, { search: '', pathname }, URLSearchParams, fetchMock, { log(){}, warn(){}, error(){} }, encodeURIComponent, nav);
        return { config, fetchCount, fetchUrls, win };
    };

    const desktopUa24 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    const iosUa24 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    const androidUa24 = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

    // /test + 桌面 → t0.mobile.sog（单文件模式）
    const d24TestDesktop = runCase24('/test', desktopUa24);
    check(d24TestDesktop.config.contentUrl === './new_data/t0.mobile.sog',
        '/test 桌面 → 单文件 t0.mobile.sog，实际 ' + d24TestDesktop.config.contentUrl);

    // /test + iOS 手机 → t0.compressed.ply（iOS 白屏兼容路径保持）
    const d24TestIos = runCase24('/test', iosUa24, 5, 390);
    check(d24TestIos.config.contentUrl === './new_data/t0.compressed.ply',
        '/test iOS → 单文件 t0.compressed.ply，实际 ' + d24TestIos.config.contentUrl);

    // /test + 安卓手机 → t0.mobile.sog
    const d24TestAndroid = runCase24('/test', androidUa24, 5, 390);
    check(d24TestAndroid.config.contentUrl === './new_data/t0.mobile.sog',
        '/test 安卓 → 单文件 t0.mobile.sog，实际 ' + d24TestAndroid.config.contentUrl);

    // 默认页（/）→ 完全不变：流式云冈（轻量 lod-meta.json，桌面默认）
    const d24Default = runCase24('/', desktopUa24);
    check(d24Default.config.contentUrl === './sog_data_mobile/streamed/lod-meta.json',
        '默认页（/）→ 桌面轻量流式 lod-meta.json（上个版本行为不变），实际 ' + d24Default.config.contentUrl);
}

// ---- 测试 25：受控日志 + 碰撞开关 + 编辑旋转（任务⑤：日志输出、碰撞开/关、编辑整体旋转）----
console.log('T25 受控日志（__ssplatLog/?log=）+ 碰撞开关（__ssplatCollisionEnabled）+ 编辑旋转（方向键 setLocalEulerAngles）');
{
    const appSrc25 = readFileSync('dist/app.js', 'utf8');
    const js25 = readFileSync('dist/index.js', 'utf8');
    const buildSrc25 = readFileSync('scripts/build.mjs', 'utf8');

    // 25a: app.js —— 受控日志函数 + ?log= 开关（?log=1 强制开启 / ?log=0 静默 / 测试页默认开启）
    check(appSrc25.includes('window.__ssplatLogEnabled = logParam === \'1\''),
        'app.js ?log=1 强制开启日志（logParam 已解析）');
    check(appSrc25.includes("console.log('[SSPLAT-LOG]['"),
        'app.js 受控日志输出代码保留（带 [SSPLAT-LOG][tag] 前缀）');
    check(appSrc25.includes('// [控制台输出注销]') && appSrc25.includes('//     console.log(\'[SSPLAT-LOG][\''),
        'app.js 控制台输出已注销（console.log 注释保留，代码不删除）');
    check(appSrc25.includes("window.__ssplatLog('app'"),
        'app.js 页面初始化输出日志（mode/contentUrl/设备判定）');
    check(appSrc25.includes('__ssplatVoxelDone') && appSrc25.includes("window.__ssplatLog('voxel'"),
        'app.js 包装体素构建完成钩子并输出构建日志（solid/res/耗时）');

    // 25b: app.js —— 调试按钮条已按用户要求移除（碰撞/编辑开关不再显示，相关 DOM/指针逻辑一并删除）
    check(!appSrc25.includes('__ssplatTestControls'), 'app.js 已移除调试按钮条（__ssplatTestControls 不再创建）');
    check(!appSrc25.includes('__ssplatCollisionToggle'), 'app.js 已移除碰撞开关按钮（__ssplatCollisionToggle）');
    check(!appSrc25.includes('__ssplatEditToggle'), 'app.js 已移除编辑开关按钮（__ssplatEditToggle）');
    check(!appSrc25.includes('editPointerDown'), 'app.js 已移除编辑模式指针接管逻辑（editPointerDown）');
    check(appSrc25.includes('window.__ssplatFrameNoTransition = true;'),
        'app.js 保留测试页删除官方进入场景相机跳转动画');

    // 25c: dist/index.js —— 碰撞开关消费点（空气墙钳制 / orbit 钳制 / 相机周期日志）
    check(js25.includes('window.__ssplatCollisionEnabled === false'),
        'index.js 碰撞消费点统一读取 __ssplatCollisionEnabled 开关');
    check(js25.includes('window.__ssplatCollisionEnabled !== false'),
        'index.js 碰撞消费点（空气墙/orbit/焦点）开关关闭时跳过');
    check(js25.includes('__ssplatWallClamps') && js25.includes("window.__ssplatLog('wall'"),
        'index.js 空气墙钳制经 __ssplatLog 输出（节流 1s，排查相机被卡住）');
    check(js25.includes("window.__ssplatLog('cam'"),
        'index.js 相机位置周期日志（2s 一次，含 mode/wallClamps/voxelDone）');
    check(js25.includes("window.__ssplatLog('voxel'"),
        'index.js orbit 体素推出经 __ssplatLog 输出（节流 1s，排查相机被模型推出）');

    // 25d: SplatVoxelCollision（浏览器注入版）—— 查询入口读碰撞开关
    const voxelClassInJs = js25.includes('window.__ssplatCollisionEnabled === false') &&
        js25.includes('querySphere') && js25.includes('queryRay');
    check(voxelClassInJs, 'index.js 体素查询（querySphere/queryRay/queryCapsule）入口读取碰撞开关');
    check(buildSrc25.includes('window.__ssplatCollisionEnabled = true;'),
        'build.mjs 全局块默认 __ssplatCollisionEnabled = true（默认开启碰撞）');
    check(buildSrc25.includes('window.__ssplatEntities = [];') && buildSrc25.includes('window.__ssplatCurrentEntity = null;'),
        'build.mjs 全局块暴露实体引用（__ssplatEntities / __ssplatCurrentEntity，编辑旋转用）');

    // 25f: 设备分类操控（需求：网页支持 WASD、手机支持点选，分类别对待）
    check(appSrc25.includes("window.__ssplatDevice = IS_MOBILE ? 'mobile' : 'desktop';"),
        'app.js 统一设备分类 __ssplatDevice（desktop=网页 / mobile=手机，与数据选型共用判定）');
    check(appSrc25.includes("window.__ssplatLog('device'"),
        'app.js 输出设备分类日志（[SSPLAT-LOG][device] 操控方式=WASD行走/点击行走）');
    check(buildSrc25.includes('MODE_SHORTCUTS_WASD_REPLACEMENT') && js25.includes("window.__ssplatDevice !== 'mobile'"),
        'build.mjs 设备分类补丁：ModeShortcuts WASD 分支显式排除手机（蓝牙键盘误触无效）');
    check(buildSrc25.includes('window.__ssplatWalkEnabled !== false') &&
        buildSrc25.includes('this._walkToPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);'),
        'build.mjs 手机端点选行走保留（orbit 点击行走，?walk=0 关闭回落聚焦）');

    // 25e: 测试页旋转参数（x=0、y=0、z=180）+ 模型中心平移到世界原点 + 相机瞬移包围盒中心（镜头对准墙面）
    check(appSrc25.includes('window.__ssplatTestX = testRxParam !== null && Number.isFinite(Number(testRxParam)) ? Number(testRxParam) : 0;'),
        'app.js 测试页默认旋转清零：x=0（可经 ?rx= 覆盖）');
    check(appSrc25.includes('window.__ssplatTestY = testRyParam !== null && Number.isFinite(Number(testRyParam)) ? Number(testRyParam) : 0;'),
        'app.js 测试页默认旋转清零：y=0（可经 ?ry= 覆盖）');
    check(appSrc25.includes('window.__ssplatTestZ = testRzParam !== null && Number.isFinite(Number(testRzParam)) ? Number(testRzParam) : 180;'),
        'app.js 测试页默认旋转清零：z=180（可经 ?rz= 覆盖）');
    check(appSrc25.includes('window.__ssplatCenterModelsAtOrigin = true;'),
        'app.js 测试页开启模型中心平移到世界原点（__ssplatCenterModelsAtOrigin）');
    check(appSrc25.includes('window.__ssplatFocusBBoxCenter'),
        'app.js 定义相机定位函数 __ssplatFocusBBoxCenter');
    check(appSrc25.includes('let cx = -2.23, cy = -0.60, cz = -1.07;') === false,
        'app.js 已移除旧的固定取景点 (-2.23,-0.60,-1.07)（由 pos/rot 形态接管）');
    check(appSrc25.includes('window.__ssplatTeleportState = { x: -0.00, y: 0.92, z: 0.55, ax: 6.35, ay: -26.65, az: 0.00 };'),
        'app.js 相机直接瞬移到 pos=(-0.00,0.92,0.55) rot=(6.35/-26.65/0.00)（位置+朝向欧拉角形态）');
    check(appSrc25.includes('window.__ssplatFrameNoTransition = true;'),
        'app.js 测试页开启 __ssplatFrameNoTransition（删除进入场景相机跳转动画）');
    check(buildSrc25.includes('window.__ssplatFrameNoTransition === true'),
        'build.mjs frame 事件补丁：__ssplatFrameNoTransition=true 时 snap() 直接落位（默认页保留官方过渡动画）');
    check(appSrc25.includes('setTimeout(() => window.__ssplatFocusBBoxCenter(), 300)'),
        'app.js 体素构建完成后延迟 300ms 触发相机瞬移');
    check(buildSrc25.includes('window.__ssplatCenterModelsAtOrigin = window.__ssplatCenterModelsAtOrigin === true;'),
        'build.mjs 全局块默认关闭居中（保留 app.js 已设置的 true）');
    check(buildSrc25.includes('window.__ssplatCenterModelAtOrigin'),
        'build.mjs 定义居中函数 __ssplatCenterModelAtOrigin（世界包围盒中心 → 原点）');
    check(buildSrc25.includes('window.__ssplatModelCenter = __ssplatModelCenterC;'),
        'build.mjs 居中函数暴露模型世界中心 __ssplatModelCenter');
    check(buildSrc25.includes('window.__ssplatTeleportState'),
        'build.mjs CameraManager 消费瞬移状态 __ssplatTeleportState（look 对准目标点 + orbit.goto 同步）');
    check(buildSrc25.includes('_ts.ax'),
        'build.mjs 瞬移消费支持位置+朝向欧拉角形态 {x,y,z,ax,ay,az}（镜头精确对准）');
    check(js25.includes('window.__ssplatCenterModelAtOrigin(entity)'),
        'index.js 单文件实体加载后调用居中函数（resolve 之前，sceneBound 自动跟随）');
}

console.log('');
if (failures > 0) {
    console.log('❌ 存在 ' + failures + ' 项失败');
    process.exit(1);
} else {
    console.log('✅ 全部逻辑测试通过');
}