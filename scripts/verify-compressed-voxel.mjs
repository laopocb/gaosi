/**
 * 验证 compressed.ply（GSplatCompressedData）体素碰撞解码
 * =====================================================
 * /new 桌面加载 point_cloud.compressed.ply（chunked PLY，788 万 splat）后，
 * 体素构建必须能解码位置并填充网格（旧逻辑直接跳过 → 完全没有模型表面碰撞）。
 *
 * 覆盖：
 * 1) _prepareEntity 的 compressed 分支：getCenters() 解码位置 + chunkData 解码 scale
 * 2) _fillFromPrepared 的 xyz3 交错位置读取
 * 3) 模型内碰撞命中 / 模型外不命中
 *
 * 用法：node scripts/verify-compressed-voxel.mjs
 */
import { SplatVoxelCollision } from './splat-voxel-collision.mjs';

let failed = 0;
const check = (ok, msg) => {
    console.log((ok ? '✅ ' : '❌ ') + msg);
    if (!ok) failed++;
};

const numChunks = 1, chunkSize = 18, numSplats = 256;
const chunkData = new Float32Array(numChunks * chunkSize);
chunkData[0] = -1; chunkData[1] = -1; chunkData[2] = -1;   // pos min
chunkData[3] = 1;  chunkData[4] = 1;  chunkData[5] = 1;    // pos max
chunkData[6] = -2; chunkData[7] = -2; chunkData[8] = -2;   // scale min (log)
chunkData[9] = -1; chunkData[10] = -1; chunkData[11] = -1; // scale max (log)
const vertexData = new Uint32Array(numSplats * 4);
for (let i = 0; i < numSplats; i++) {
    vertexData[i * 4] = (0x400 << 21) | (512 << 11) | 0x400; // packed pos 中点 → (0,0,0)
}
const fakeCompressed = {
    numSplats, chunkData, vertexData, numChunks, chunkSize,
    isSog: false, means_l: null, getProp: null,
    getCenters() {
        const r = new Float32Array(numSplats * 3);
        for (let i = 0; i < numSplats; i++) { r[i * 3] = 0; r[i * 3 + 1] = 0; r[i * 3 + 2] = 0; }
        return r;
    }
};

const col = new SplatVoxelCollision({ voxelResolution: 0.3, fillScale: 1.5, maxFillRadius: 2, opacityThreshold: 0.1 });
col.setRoom({ center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 10, y: 10, z: 10 } });
col._allocateGrid();

const entity = {
    gsplat: { resource: { gsplatData: fakeCompressed } },
    customAabb: { center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } },
    getWorldTransform: () => ({ clone: () => ({ data: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }) })
};

col._baseDiag = 0;
const prep = await col._prepareEntity(entity);
check(prep !== null, 'compressed.ply 解码成功（_prepareEntity 返回访问器）');
if (prep) {
    check(prep.numSplats === numSplats, 'splat 数正确（256）');
    check(prep.xyz3 && prep.xyz3.length === numSplats * 3, 'xyz3 交错位置数组存在（768 项）');
    check(Number.isFinite(prep.sx[0]) && Math.abs(prep.sx[0] + 1.5) < 0.01, 'scale 解码正确（chunk 均值 -1.5 log）');
    col._fillFromPrepared(prep, 0, numSplats);
    check(col._solidCount > 0, '实心体素已填充（' + col._solidCount + ' 个）');
    const o1 = { x: 0, y: 0, z: 0 };
    check(col.querySphere(0.2, 0, 0, 0.5, o1) === true, '相机在模型内 0.2m → 命中碰撞');
    const o2 = { x: 0, y: 0, z: 0 };
    check(col.querySphere(8, 0, 0, 0.5, o2) === false, '相机在模型外 8m → 不命中（自由）');
}

console.log(failed === 0 ? '\n✅ compressed.ply 体素碰撞验证全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
