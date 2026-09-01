/**
 * SplatVoxelCollision —— 从 gsplat splat 数据构建的体素碰撞网格
 * =====================================================
 * 本文件是「体素级碰撞」升级的单一源码：
 *   - 浏览器端：scripts/build.mjs 读取本文件，去掉 `export ` 前缀后作为补丁注入
 *     dist/index.js（class 位于官方模块作用域，可直接使用模块内的 Vec3 / Mat4 /
 *     BoundingBox / readImageDataAsync 等名字）；
 *   - 单测端：scripts/merge-logic-test.mjs 直接 import 本文件做 T9 逻辑验证。
 *
 * 设计说明（对应需求 1/2/4 与性能要求）：
 *   1. 构建 O(N)：
 *      - 每个 splat 解码出世界坐标（SOG 轻量解码 或 GSplatData 直读数组），
 *        用实体世界矩阵（含 Rx(-90°) 翻转）变换到世界系；
 *      - 标记其覆盖的体素：中心体素 + 按「最大尺度 × fillScale」折算的填充半径扩展
 *        （精度/性能平衡方案：数据中位数尺度约 1~2cm → 绝大多数 splat 仅标记中心体素，
 *        p95 尺度约 0.2~0.8m → 少量 splat 填充 1~2 体素半径，上限 maxFillRadius 防爆炸）；
 *      - 透明度过低的 splat（alpha < opacityThreshold）跳过，避免“幽灵墙”。
 *   2. 查询 O(1)：
 *      - 体素网格为扁平 Uint8Array（索引 ix + iy*nx + iz*nx*ny），querySphere 仅检查
 *        球心周围 3×3×3 体素（数组直索引，最多 3 轮迭代，仍是常数次访问）；
 *      - queryRay 用 DDA 体素步进（最坏 nx+ny+nz 步，不遍历 splat）；
 *      - 均不每帧遍历 splat。
 *   3. 构建异步分批：requestAnimationFrame + 每帧 frameBudgetMs（默认 6ms）时间预算，
 *      与渲染/UI 交错执行，不阻塞主线程；构建完成后释放中间解码数据（splat 原始数据保留给渲染）。
 *   4. 与 AABB「房间」叠加（二者语义分离）：
 *      - 房间（sceneBound 内缩 0.5m）管「不能出场景」（外边界，轴对齐钳制）；
 *      - 体素管「不能穿模型」（内表面，最深穿透推出）。
 *      实现官方碰撞接口 queryRay / querySphere / queryCapsule / querySurfaceNormal /
 *      isFreeAt / voxelResolution，供 fly SphereMover 与 orbit 钳制复用。
 *
 *   5. 根因修复（2024-08，用户实测「相机可穿过模型」）：
 *      - 故障点：_prepareEntity 的 SOG 纹理读取用 `if (!texture._levels[0])` 判定是否读回，
 *        但官方 ImgParser.open() 会把 ImageBitmap/HTMLImageElement 存入 _levels[0]（truthy 但
 *        不可索引）→ 从不执行 readImageDataAsync → 解码 NaN → 网格恒空 → 碰撞不生效；
 *      - 修复：_ensureTextureBytes() —— _levels[0] 已是字节数组（ArrayBufferView）直接复用，
 *        否则无条件从 GPU 读回（texture.read，与官方 decompress 同路径）；
 *      - 防御：SOG 解码后增加 isFinite 位置校验（NaN 会使 Math.floor(NaN)=NaN 绕过边界检查）；
 *      - 诊断：_finish 在有 splat 却 0 实心体素时输出 warning，避免「静默空网格」。
 */
export class SplatVoxelCollision {
    constructor(options) {
        options = options || {};
        // —— 可配置参数（默认值见需求建议：分辨率 0.3m、填充半径 = maxScale×1.5、上限 2 体素）——
        this.voxelResolution = (typeof options.voxelResolution === 'number' && options.voxelResolution > 0.05)
            ? options.voxelResolution : 0.3;
        this.fillScale = (typeof options.fillScale === 'number' && options.fillScale > 0)
            ? options.fillScale : 1.5;
        this.maxFillRadius = (typeof options.maxFillRadius === 'number' && options.maxFillRadius >= 0)
            ? options.maxFillRadius : 2;
        this.opacityThreshold = (typeof options.opacityThreshold === 'number' && options.opacityThreshold >= 0)
            ? options.opacityThreshold : 0.1;
        this.collisionPadding = (typeof options.collisionPadding === 'number' && options.collisionPadding >= 0)
            ? options.collisionPadding : 0.5;
        this.frameBudgetMs = (typeof options.frameBudgetMs === 'number' && options.frameBudgetMs > 1)
            ? options.frameBudgetMs : 12;

        // —— 房间外边界（AABB + 内缩 padding；Viewer 回调 setRoom 写入权威值）——
        this.minX = 0; this.minY = 0; this.minZ = 0;
        this.maxX = 0; this.maxY = 0; this.maxZ = 0;
        this._roomSet = false;

        // —— 体素网格（扁平 Uint8Array，O(1) 索引；约 240×57×174 @0.3m ≈ 2.4MB）——
        this._grid = null;
        this._nx = 0; this._ny = 0; this._nz = 0;
        this._gMinX = 0; this._gMinY = 0; this._gMinZ = 0;

        // —— 构建状态 ——
        this._pending = [];        // 待准备的实体
        this._seen = null;         // 去重 Set（合并模式 per-file 钩子 + 全量钩子会重复入队）
        this._prepared = [];       // 已准备（解码完成）的轻量访问器
        this._current = null;      // 当前正在体素化的实体 { prep, i }
        this._building = false;
        this._done = false;
        this._destroyed = false;
        this._startTime = 0;
        this._endTime = 0;
        this._processedSplats = 0;
        this._totalQueued = 0;
        this._solidCount = 0;
        this._prepTotal = 0;       // 准备阶段的实体总数（用于准备进度）
        this._prepDone = 0;        // 已完成准备的实体数
        this._baseDiag = 0;        // 首个实体世界包围盒半对角线（用于跳过环境/天空盒）
        this._skippedEnv = [];     // 被跳过的超大实体名
        this._lastEmitMs = 0;

        // —— 复用对象（避免查询时分配）——
        this._push = { x: 0, y: 0, z: 0 };
        this._normalResult = { nx: 0, ny: 1, nz: 0 };
    }

    // 网格已分配（有体素数据，哪怕是空的）→ 供 orbit 钳制补丁与鼠标射线判断
    get hasVoxels() {
        return this._grid !== null;
    }

    // 构建已全部完成
    get ready() {
        return this._done;
    }

    // 实心体素总数（构建进度 / 测试用）
    get solidCount() {
        return this._solidCount;
    }

    // 设置房间外边界；同时暴露 minX/maxX… 供 orbit 钳制补丁（P12）读取
    setRoom(bbox) {
        if (!bbox || !bbox.center || !bbox.halfExtents) return;
        const p = this.collisionPadding;
        this.minX = bbox.center.x - bbox.halfExtents.x + p;
        this.maxX = bbox.center.x + bbox.halfExtents.x - p;
        this.minY = bbox.center.y - bbox.halfExtents.y + p;
        this.maxY = bbox.center.y + bbox.halfExtents.y - p;
        this.minZ = bbox.center.z - bbox.halfExtents.z + p;
        this.maxZ = bbox.center.z + bbox.halfExtents.z - p;
        this._roomSet = true;
        // 正常情况下 setRoom 先于首帧构建（Viewer 回调是微任务，首帧构建在 rAF）；
        // 若网格已分配（防御），按新房间重建，体素计数清零（队列继续填充新网格）。
        if (this._grid) {
            this._allocateGrid();
            this._solidCount = 0;
        }
    }

    // 分配网格（房间已知后调用；Uint8Array 扁平索引 O(1)）
    _allocateGrid() {
        const res = this.voxelResolution;
        const nx = Math.max(1, Math.ceil((this.maxX - this.minX) / res));
        const ny = Math.max(1, Math.ceil((this.maxY - this.minY) / res));
        const nz = Math.max(1, Math.ceil((this.maxZ - this.minZ) / res));
        this._nx = nx; this._ny = ny; this._nz = nz;
        this._gMinX = this.minX; this._gMinY = this.minY; this._gMinZ = this.minZ;
        this._grid = new Uint8Array(nx * ny * nz);
    }

    // 体素实心查询（O(1) 数组访问）
    isVoxelSolid(ix, iy, iz) {
        const g = this._grid;
        if (!g || ix < 0 || iy < 0 || iz < 0 || ix >= this._nx || iy >= this._ny || iz >= this._nz) {
            return false;
        }
        return g[ix + iy * this._nx + iz * this._nx * this._ny] === 1;
    }

    // ==================== 构建（异步分批） ====================

    // 入队实体（合并模式 per-file 钩子与全量钩子会重复调用 → Set 去重）
    enqueueEntities(entities) {
        if (!Array.isArray(entities) || entities.length === 0) return;
        // [防崩溃补丁] _finish()/destroy() 会把 _pending/_seen 置 null（释放中间资源）。
        // 渐进加载 swap 替换实体后再次构建时（__ssplatBuildVoxelFromEntity 第二次调用），
        // _pending 为 null 会抛 "Cannot read properties of null (reading 'push')"。
        // 这里惰性重建队列（等价于一次全新构建，_done 由 startBuild 的幂等检查处理）。
        if (!Array.isArray(this._pending)) this._pending = [];
        if (!this._seen) this._seen = new Set();
        let added = false;
        for (const entity of entities) {
            if (!entity || this._seen.has(entity)) continue;
            this._seen.add(entity);
            this._pending.push(entity);
            added = true;
        }
        if (added) this._prepTotal = this._pending.length;
    }

    // 启动异步构建（幂等）
    startBuild() {
        if (this._building || this._done || this._destroyed) return;
        if (this._pending.length === 0) {
            // 无实体：直接完成（仅房间碰撞）
            this._done = true;
            this._emitDone();
            return;
        }
        this._building = true;
        this._startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        // 先异步准备（SOG 纹理读回等），再进入分帧体素化
        this._prepareAll().then(() => {
            if (this._destroyed) return;
            this._totalQueued = this._prepared.reduce((sum, p) => sum + p.numSplats, 0);
            this._schedule();
        }).catch(() => {
            // 静默：数据准备失败不再输出日志（需求：移除全部日志输出），仅完成构建流程
            this._building = false;
            this._done = true;
            this._emitDone();
        });
    }

    // 逐个实体异步准备：读取 SOG 纹理数据到 CPU（轻量解码路径，不做完整 decompress）。
    // 返回多个 prep（普通实体 0~1 个；octree 流式资源按 LOD0 文件展开为多个）。
    async _prepareAll() {
        this._pending = this._pending || [];
        for (const entity of this._pending) {
            if (this._destroyed) break;
            const preps = await this._prepareEntityAll(entity);
            for (const prep of preps) {
                if (prep) this._prepared.push(prep);
            }
            this._prepDone++;
            this._emitProgress('preparing');
        }
        this._pending = [];
        this._seen = null;
    }

    // 单个实体 → prep 数组（octree 资源展开为多个文件 prep）
    async _prepareEntityAll(entity) {
        const gsplat = entity && entity.gsplat;
        let resource = gsplat && gsplat.resource;
        if (!resource) return [];

        // ==================== [Streamed SOG 补丁] octree 资源分支 ====================
        // 默认模式（手机版 Streamed SOG）的资源是 GSplatOctreeResource：没有 gsplatData，
        // 只有 resource.octree（叶子节点 + 分块文件引用）。splat 数据按文件分块加载，
        // 每个文件是 GSplatSogResource（gsplatData = SOG v2，坐标仍为模型本地系，
        // 与单文件 .sog 完全一致，仅按空间分块）。
        // 旧代码只认 resource.gsplatData → 等满 5 秒放弃 → 0 splat → 体素网格恒空
        // → 碰撞只剩 AABB 房间（相机可穿模型）→「碰撞改没了」的直接根因。
        if (resource.octree) {
            return await this._prepareOctreeEntity(entity, resource);
        }

        // 普通 SOG / GSplatData 实体：单个 prep
        const prep = await this._prepareEntity(entity);
        return prep ? [prep] : [];
    }

    // [Streamed SOG 补丁] octree 资源：等待 LOD0 分块文件加载完成，逐个走 SOG 轻量解码。
    // LOD0 即碰撞网格所需的最细粒度；文件加载由官方 LOD 系统按视点流式触发，
    // 这里轮询 octree.fileResources，最多等 OCTREE_WAIT_TIMEOUT_MS（45s，低带宽
    // 12MB @ 80KB/s ≈ 150s，超时后使用已加载部分，剩余区域由 AABB 房间兜底）。
    async _prepareOctreeEntity(entity, resource) {
        const octree = resource.octree;
        if (!octree || !octree.nodes || !octree.nodes.length) return [];

        // LOD0 文件索引集合（去重；多节点可共享同一文件）
        const lod0FileIndexes = new Set();
        for (const node of octree.nodes) {
            const l0 = node && node.lods && node.lods[0];
            if (l0 && l0.fileIndex !== -1) lod0FileIndexes.add(l0.fileIndex);
        }
        const required = [...lod0FileIndexes];
        if (required.length === 0) return [];

        // 轮询等待文件加载（每 200ms 检查一次；已加载 ≥1 个且 5s 无新增时提前开始）
        const OCTREE_WAIT_TIMEOUT_MS = 45000;
        const lastAddedAt = Date.now();
        let lastLoaded = 0;
        while (Date.now() - lastAddedAt < 5000) {
            if (Date.now() - (this._octreeWaitStart || Date.now()) > OCTREE_WAIT_TIMEOUT_MS) break;
            const loaded = required.filter((fi) => octree.getFileResource ? !!octree.getFileResource(fi) : false).length;
            if (loaded > lastLoaded) {
                lastLoaded = loaded;
                this._octreeWaitStart = Date.now(); // 有新增则从该时刻再给 5s
            }
            if (loaded === required.length) break;
            if (this._destroyed) return [];
            await new Promise((r) => setTimeout(r, 200));
        }
        this._octreeWaitStart = 0;

        // 对每个已加载的 LOD0 文件走 SOG 轻量解码（与单文件 .sog 同一路径）
        const preps = [];
        for (const fi of required) {
            if (this._destroyed) break;
            const fileResource = octree.getFileResource ? octree.getFileResource(fi) : null;
            if (!fileResource || !fileResource.gsplatData) continue;
            const data = fileResource.gsplatData;
            const numSplats = data.numSplats || 0;
            if (numSplats <= 0) continue;
            if (typeof data.getProp !== 'function' && !data.isSog && !data.means_l) continue;
            const prep = await this._prepareSogData(entity, data);
            if (prep) preps.push(prep);
        }
        return preps;
    }

    // 等待 gsplat 资源就绪并返回 gsplatData（无则 null）
    async _waitGsplatData(gsplat) {
        let resource = gsplat && gsplat.resource;
        if (!resource || !resource.gsplatData) {
            for (let _wait = 0; _wait < 100; _wait++) {
                await new Promise((r) => setTimeout(r, 50));
                resource = gsplat && gsplat.resource;
                if (resource && resource.gsplatData) break;
            }
        }
        return (resource && resource.gsplatData) || null;
    }

    // 准备单个实体 → 轻量访问器；失败/超大实体返回 null
    async _prepareEntity(entity) {
        const gsplat = entity && entity.gsplat;
        const data = await this._waitGsplatData(gsplat);
        if (!data) return null;
        const numSplats = data.numSplats || 0;
        if (numSplats <= 0) return null;

        // [compressed.ply 兼容补丁] compressed.ply（GSplatCompressedData）只有 packed 顶点数据
        // （chunkData + vertexData，无 SOG 纹理 means_l 也无 getProp 属性数组）。
        // 旧逻辑直接跳过实体（iOS 50 万 splat 空跑构建的权宜），但会导致 /new 桌面加载
        // point_cloud.compressed.ply（788 万 splat）时**完全没有模型表面碰撞**。
        // 现在：用官方 GSplatCompressedData.getCenters() 解码全部位置（chunk 相对量化，
        // 与 SOG 同口径），scale 由 chunkData 的 scale 通道（index 6..8 = 对数尺度 min/max）
        // 解码 → 走普通 GSplatData 分支体素化。
        if (typeof data.getProp !== 'function' && !data.isSog && !data.means_l) {
            if (typeof data.getCenters === 'function' && data.chunkData && data.vertexData) {
                const _centers = data.getCenters();
                if (_centers && _centers.length >= numSplats * 3) {
                    const world = entity.getWorldTransform().clone();
                    const _cs = data.chunkData;
                    const _csSize = (data.chunkSize || 18);
                    const _numChunks = (data.numChunks || Math.ceil(numSplats / 256));
                    // 每个 splat 的 log(scale) 取所在 chunk 的 scale min/max 平均值（粗糙但稳定）
                    const _sx = new Float32Array(numSplats);
                    const _sy = new Float32Array(numSplats);
                    const _sz = new Float32Array(numSplats);
                    for (let _c = 0; _c < _numChunks; _c++) {
                        const _off = _c * _csSize;
                        const _smx = _cs[_off + 6], _sMx = _cs[_off + 9];
                        const _smy = _cs[_off + 7], _sMy = _cs[_off + 10];
                        const _smz = _cs[_off + 8], _sMz = _cs[_off + 11];
                        const _ax = (_smx + _sMx) * 0.5, _ay = (_smy + _sMy) * 0.5, _az = (_smz + _sMz) * 0.5;
                        const _start = _c * 256, _end = Math.min(numSplats, _start + 256);
                        for (let _i = _start; _i < _end; _i++) {
                            _sx[_i] = _ax; _sy[_i] = _ay; _sz[_i] = _az;
                        }
                    }
                    return {
                        numSplats,
                        world,
                        sog: false,
                        x: _centers.subarray(0, numSplats * 3),
                        y: null, z: null,        // 位置已打包进 x（stride 3）
                        xyz3: _centers,           // 标记：x 是 xyz 交错数组
                        sx: _sx, sy: _sy, sz: _sz,
                        op: null
                    };
                }
            }
            // 无法解码（非 compressed.ply 且无属性）：跳过（保留 AABB 房间 + 空气墙兜底）
            return null;
        }

        // 跳过环境/天空盒等超大实体（与合并包围盒 P3 的 _skipFactor=8 规则一致）
        const bbox = gsplat.customAabb;
        if (bbox && bbox.center && bbox.halfExtents) {
            const wm = entity.getWorldTransform();
            const wb = new BoundingBox();
            wb.setFromTransformedAabb(bbox, wm);
            const diag = wb.halfExtents.length();
            if (this._baseDiag === 0) {
                this._baseDiag = diag;
            } else if (diag > this._baseDiag * 8) {
                this._skippedEnv.push((entity.name || '?').toString());
                return null;
            }
        }

        return this._prepareSogData(entity, data);
    }

    // SOG 轻量解码 → 轻量访问器（SOG 纹理路径 + getProp 回退路径）
    async _prepareSogData(entity, data) {
        const numSplats = data.numSplats || 0;
        if (numSplats <= 0) return null;
        const world = entity.getWorldTransform().clone();
        // —— SOG 路径：轻量解码位置 + 尺度（不分配 14 个 Float32Array，不跑同步大循环）——
        // [体素碰撞补丁] SOG 纹理读回失败时，不直接跳过，而是回退到普通路径
        if (data.isSog || data.means_l) {
            try {
                if (typeof data._patchCodebooks === 'function') data._patchCodebooks();
                const ml = await this._ensureTextureBytes(data.means_l);
                const mu = await this._ensureTextureBytes(data.means_u);
                const sc = await this._ensureTextureBytes(data.scales);
                if (!ml || !mu || !sc) {
                    // 纹理数据不可读：回退到普通路径（直读 getProp 数组），不直接跳过（静默，不输出日志）
                } else {
                let sh0 = null;
                let sh0min = null;
                let sh0max = null;
                if (this.opacityThreshold > 0 && data.sh0) {
                    sh0 = await this._ensureTextureBytes(data.sh0);
                    const sh0meta = (data.meta && data.meta.sh0) || {};
                    sh0min = sh0meta.mins || null;
                    sh0max = sh0meta.maxs || null;
                }
                const meta = data.meta || {};
                const means = meta.means || { mins: [0, 0, 0], maxs: [0, 0, 0] };
                const scales = meta.scales || {};
                return {
                    numSplats,
                    world,
                    sog: true,
                    ml,
                    mu,
                    sc,
                    sh0,
                    sh0min,
                    sh0max,
                    means,
                    version2: meta.version === 2,
                    codebook: scales.codebook || null,
                    smin: scales.mins || null,
                    smax: scales.maxs || null
                };
                } // end else (SOG textures readable)
                // [体素碰撞补丁] SOG 纹理不可读时回退：直读 GSplatData 属性数组
                if (typeof data.getProp === 'function') {
                    const x = data.getProp('x');
                    const y = data.getProp('y');
                    const z = data.getProp('z');
                    if (x && y && z) {
                        return {
                            numSplats,
                            world,
                            sog: false,
                            x, y, z,
                            sx: data.getProp('scale_0'),
                            sy: data.getProp('scale_1'),
                            sz: data.getProp('scale_2'),
                            op: this.opacityThreshold > 0 ? data.getProp('opacity') : null
                        };
                    }
                }
                // 静默：SOG 纹理不可读且回退失败，跳过实体（不输出日志）
                return null;
            } catch (err) {
                // 静默：SOG 纹理读取异常，尝试普通路径回退（不输出日志）
                // [体素碰撞补丁] 异常时回退到普通路径
                if (typeof data.getProp === 'function') {
                    const x = data.getProp('x');
                    const y = data.getProp('y');
                    const z = data.getProp('z');
                    if (x && y && z) {
                        return {
                            numSplats,
                            world,
                            sog: false,
                            x, y, z,
                            sx: data.getProp('scale_0'),
                            sy: data.getProp('scale_1'),
                            sz: data.getProp('scale_2'),
                            op: this.opacityThreshold > 0 ? data.getProp('opacity') : null
                        };
                    }
                }
                return null;
            }
        }

        // —— 普通 GSplatData（.ply/.splat 等）：直读属性数组 ——
        return {
            numSplats,
            world,
            sog: false,
            x: data.getProp('x'),
            y: data.getProp('y'),
            z: data.getProp('z'),
            sx: data.getProp('scale_0'),
            sy: data.getProp('scale_1'),
            sz: data.getProp('scale_2'),
            op: this.opacityThreshold > 0 ? data.getProp('opacity') : null
        };
    }

    // 把 SOG 纹理转换为 CPU 可读的 RGBA 字节数组。
    // ⚠️ 根因修复（实测「相机可穿过模型」的直接原因）：
    //   官方 ImgParser.open() 对 .sog 内嵌纹理（webp 等）执行 texture.setSource(data)，
    //   会把 ImageBitmap / HTMLImageElement 直接存入 texture._levels[0]（truthy 但**不可索引**）。
    //   旧代码用 `if (!data.means_l._levels[0])` 判定 → 永远为假 → 从不执行
    //   readImageDataAsync → ml/mu/sc/sh0 拿到 ImageBitmap → ml[i4] 为 undefined →
    //   位置解码 NaN → 体素标记全部落空 → 网格恒空 → 碰撞不触发（只有 AABB 房间生效）。
    //   官方 GSplatSogData.decompress() 是**无条件**调用 readImageDataAsync（覆盖 _levels[0]），
    //   因此这里同样：字节数组（Uint8Array/Uint8ClampedArray 等 ArrayBufferView）直接复用；
    //   其它（ImageBitmap/Image/Canvas）→ 必须从 GPU 读回（texture.read，官方同路径）。
    async _ensureTextureBytes(texture) {
        if (!texture) return null;
        const level0 = texture._levels && texture._levels[0];
        if (level0 && (level0 instanceof Uint8Array || level0 instanceof Uint8ClampedArray || ArrayBuffer.isView(level0))) {
            return level0;
        }
        const bytes = await readImageDataAsync(texture);
        if (bytes) {
            texture._levels[0] = bytes;
        }
        return bytes;
    }

    // 分帧调度：优先 rAF（与渲染交错），Node 测试环境回退 setTimeout
    _schedule() {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => this._processChunk());
        } else {
            setTimeout(() => this._processChunk(), 0);
        }
    }

    // 单帧处理：在 frameBudgetMs 时间预算内尽量多处理 splat，随后让出主线程
    _processChunk() {
        if (this._destroyed || this._done) return;
        // 防御：正常情况下 setRoom（Viewer 回调，微任务）先于首帧构建（rAF）执行；
        // 若极端情况下网格尚未分配，用当前房间兜底分配（房间未设置时退化为 1×1×1，全跳过）。
        if (!this._grid) {
            this._allocateGrid();
        }
        const deadline = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() + this.frameBudgetMs : Date.now() + this.frameBudgetMs;
        const nowFn = (typeof performance !== 'undefined' && performance.now)
            ? () => performance.now() : () => Date.now();
        while (nowFn() < deadline) {
            if (!this._current) {
                if (this._prepared.length === 0) {
                    this._finish();
                    return;
                }
                this._current = { prep: this._prepared.shift(), i: 0 };
            }
            const cur = this._current;
            const from = cur.i;
            const to = Math.min(cur.prep.numSplats, from + 200000);
            this._fillFromPrepared(cur.prep, from, to);
            this._processedSplats += (to - from);
            cur.i = to;
            if (cur.i >= cur.prep.numSplats) {
                this._current = null;
            }
            this._emitProgress('voxelizing');
        }
        this._schedule();
    }

    // 核心体素化循环：把 [from, to) 区间内每个 splat 解码 → 世界变换 → 标记体素
    _fillFromPrepared(prep, from, to) {
        const res = this.voxelResolution;
        const grid = this._grid;
        if (!grid) return; // 防御：网格未分配时跳过（正常时序下不会发生）
        const nx = this._nx, ny = this._ny, nz = this._nz;
        const gx0 = this._gMinX, gy0 = this._gMinY, gz0 = this._gMinZ;
        const maxFill = this.maxFillRadius;
        const fillScale = this.fillScale;
        const opThresh = this.opacityThreshold;
        const d = prep.world.data; // 列主序 Mat4：x'=d0*x+d4*y+d8*z+d12 …
        let solid = 0;

        if (prep.sog) {
            const ml = prep.ml, mu = prep.mu, sc = prep.sc, sh0 = prep.sh0;
            const mins = prep.means.mins, maxs = prep.means.maxs;
            const dxm = maxs[0] - mins[0], dym = maxs[1] - mins[1], dzm = maxs[2] - mins[2];
            const v2 = prep.version2, cb = prep.codebook;
            const smin = prep.smin, smax = prep.smax;
            const sh0min = prep.sh0min, sh0max = prep.sh0max;
            for (let i = from; i < to; i++) {
                const i4 = i * 4;
                // 位置解码：u16 量化 → lerp(mins,maxs) → sign*(exp(|v|)-1)
                const qx = ((mu[i4] << 8) + ml[i4]) / 65535;
                const qy = ((mu[i4 + 1] << 8) + ml[i4 + 1]) / 65535;
                const qz = ((mu[i4 + 2] << 8) + ml[i4 + 2]) / 65535;
                const nxv = mins[0] + dxm * qx;
                const nyv = mins[1] + dym * qy;
                const nzv = mins[2] + dzm * qz;
                const px = Math.sign(nxv) * (Math.exp(Math.abs(nxv)) - 1);
                const py = Math.sign(nyv) * (Math.exp(Math.abs(nyv)) - 1);
                const pz = Math.sign(nzv) * (Math.exp(Math.abs(nzv)) - 1);
                // 防御：位置必须有限（旧 bug 曾把 ImageBitmap 当字节数组 → NaN 静默落空）；
                // NaN 会使下方 Math.floor(NaN)=NaN 绕过边界检查（NaN 比较恒 false）→ 必须显式跳过。
                if (!isFinite(px) || !isFinite(py) || !isFinite(pz)) continue;
                // 透明度过滤（v2：alpha 直接量化；v1：sigmoid(lerp)）
                if (sh0) {
                    if (v2) {
                        if (sh0[i4 + 3] / 255 < opThresh) continue;
                    } else {
                        const a = sh0min[3] + (sh0max[3] - sh0min[3]) * (sh0[i4 + 3] / 255);
                        if (1 / (1 + Math.exp(-a)) < opThresh) continue;
                    }
                }
                // 尺度解码（v2：codebook 索引；v1：lerp）→ 最大半轴（log 尺度需 exp）
                let s0, s1, s2;
                if (v2 && cb) {
                    s0 = cb[sc[i4]]; s1 = cb[sc[i4 + 1]]; s2 = cb[sc[i4 + 2]];
                } else if (smin && smax) {
                    s0 = smin[0] + (smax[0] - smin[0]) * (sc[i4] / 255);
                    s1 = smin[1] + (smax[1] - smin[1]) * (sc[i4 + 1] / 255);
                    s2 = smin[2] + (smax[2] - smin[2]) * (sc[i4 + 2] / 255);
                } else {
                    s0 = s1 = s2 = 0;
                }
                const ms = s0 > s1 ? (s0 > s2 ? s0 : s2) : (s1 > s2 ? s1 : s2);
                const maxScale = Math.exp(ms);
                // 世界变换（列主序矩阵，手动展开避免对象分配）
                const wx = d[0] * px + d[4] * py + d[8] * pz + d[12];
                const wy = d[1] * px + d[5] * py + d[9] * pz + d[13];
                const wz = d[2] * px + d[6] * py + d[10] * pz + d[14];
                // 体素索引 + 填充
                const ix = Math.floor((wx - gx0) / res);
                const iy = Math.floor((wy - gy0) / res);
                const iz = Math.floor((wz - gz0) / res);
                if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
                let r = Math.round(maxScale * fillScale / res);
                if (r < 0) r = 0;
                if (r > maxFill) r = maxFill;
                if (r === 0) {
                    const idx = ix + iy * nx + iz * nx * ny;
                    if (grid[idx] === 0) { grid[idx] = 1; solid++; }
                    continue;
                }
                for (let dz = -r; dz <= r; dz++) {
                    const zz = iz + dz;
                    if (zz < 0 || zz >= nz) continue;
                    const zoff = zz * nx * ny;
                    for (let dy = -r; dy <= r; dy++) {
                        const yy = iy + dy;
                        if (yy < 0 || yy >= ny) continue;
                        const yoff = yy * nx;
                        for (let dx = -r; dx <= r; dx++) {
                            const xx = ix + dx;
                            if (xx < 0 || xx >= nx) continue;
                            const idx = xx + yoff + zoff;
                            if (grid[idx] === 0) { grid[idx] = 1; solid++; }
                        }
                    }
                }
            }
        } else {
            const xa = prep.x, ya = prep.y, za = prep.z;
            const xyz3 = prep.xyz3; // compressed.ply：xyz 交错数组（stride 3，xa 即 xyz3）
            const sxa = prep.sx, sya = prep.sy, sza = prep.sz;
            const opa = prep.op;
            const opLogit = -Math.log(1 / opThresh - 1); // alpha=opThresh 对应的 logit
            for (let i = from; i < to; i++) {
                const px = xyz3 ? xyz3[i * 3] : xa[i];
                const py = xyz3 ? xyz3[i * 3 + 1] : ya[i];
                const pz = xyz3 ? xyz3[i * 3 + 2] : za[i];
                if (!isFinite(px) || !isFinite(py) || !isFinite(pz)) continue;
                if (opa && opa[i] < opLogit) continue;
                const s0 = sxa ? sxa[i] : 0;
                const s1 = sya ? sya[i] : 0;
                const s2 = sza ? sza[i] : 0;
                const ms = s0 > s1 ? (s0 > s2 ? s0 : s2) : (s1 > s2 ? s1 : s2);
                const maxScale = Math.exp(ms);
                const wx = d[0] * px + d[4] * py + d[8] * pz + d[12];
                const wy = d[1] * px + d[5] * py + d[9] * pz + d[13];
                const wz = d[2] * px + d[6] * py + d[10] * pz + d[14];
                const ix = Math.floor((wx - gx0) / res);
                const iy = Math.floor((wy - gy0) / res);
                const iz = Math.floor((wz - gz0) / res);
                if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
                let r = Math.round(maxScale * fillScale / res);
                if (r < 0) r = 0;
                if (r > maxFill) r = maxFill;
                if (r === 0) {
                    const idx = ix + iy * nx + iz * nx * ny;
                    if (grid[idx] === 0) { grid[idx] = 1; solid++; }
                    continue;
                }
                for (let dz = -r; dz <= r; dz++) {
                    const zz = iz + dz;
                    if (zz < 0 || zz >= nz) continue;
                    const zoff = zz * nx * ny;
                    for (let dy = -r; dy <= r; dy++) {
                        const yy = iy + dy;
                        if (yy < 0 || yy >= ny) continue;
                        const yoff = yy * nx;
                        for (let dx = -r; dx <= r; dx++) {
                            const xx = ix + dx;
                            if (xx < 0 || xx >= nx) continue;
                            const idx = xx + yoff + zoff;
                            if (grid[idx] === 0) { grid[idx] = 1; solid++; }
                        }
                    }
                }
            }
        }
        this._solidCount += solid;
    }

    _emitProgress(phase) {
        if (typeof window === 'undefined' || typeof window.__ssplatVoxelProgress !== 'function') return;
        let percent;
        if (phase === 'voxelizing' && this._totalQueued > 0) {
            percent = Math.min(100, Math.round(this._processedSplats / this._totalQueued * 100));
        } else {
            percent = Math.min(100, Math.round(this._prepDone / Math.max(1, this._prepTotal) * 100));
        }
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        // 节流：最多每 80ms 通知一次 UI
        if (now - this._lastEmitMs < 80) return;
        this._lastEmitMs = now;
        window.__ssplatVoxelProgress({
            phase,
            percent,
            processedSplats: this._processedSplats,
            totalSplats: this._totalQueued,
            solidVoxels: this._solidCount
        });
    }

    _emitDone() {
        if (typeof window === 'undefined' || typeof window.__ssplatVoxelDone !== 'function') return;
        window.__ssplatVoxelDone({
            totalSplats: this._totalQueued,
            solidVoxels: this._solidCount,
            gridDims: [this._nx, this._ny, this._nz],
            voxelResolution: this.voxelResolution,
            buildMs: Math.round(this._endTime - this._startTime),
            skippedEnv: this._skippedEnv
        });
    }

    _finish() {
        this._building = false;
        this._done = true;
        this._endTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        // 注：原「有 splat 数据却 0 实心体素」的空网格诊断输出已移除（需求：移除全部日志输出），
        // 构建流程与查询逻辑不受影响；如需排查请外部调试。
        // 释放中间数据（解码出的位置/尺度数组；splat 原始数据保留给渲染）
        this._prepared = null;
        this._pending = null;
        this._current = null;
        this._seen = null;
        this._processedSplats = this._totalQueued;
        this._emitDone();
    }

    // 释放全部中间资源（页面销毁等场景）
    destroy() {
        this._destroyed = true;
        this._prepared = null;
        this._pending = null;
        this._current = null;
        this._seen = null;
        this._grid = null;
    }

    // ==================== 查询（官方碰撞接口） ====================

    // 球体碰撞：房间外边界（轴对齐钳制）+ 体素最深穿透推出（3×3×3 窗口，最多 3 轮，O(1)）
    querySphere(cx, cy, cz, radius, out) {
        // [碰撞开关补丁] 全局开关关闭时直接返回无碰撞（相机可自由穿行，不重建网格）
        if (typeof window !== 'undefined' && window.__ssplatCollisionEnabled === false) {
            out.x = 0; out.y = 0; out.z = 0;
            return false;
        }
        let pushX = 0, pushY = 0, pushZ = 0;
        let anyPush = false;
        let tx = cx, ty = cy, tz = cz;
        // —— 房间外边界：球心钳制到 [min+radius, max-radius] ——
        if (this._roomSet) {
            const r = radius;
            const minX = this.minX + r, maxX = this.maxX - r;
            const minY = this.minY + r, maxY = this.maxY - r;
            const minZ = this.minZ + r, maxZ = this.maxZ - r;
            if (tx < minX) { pushX += minX - tx; tx = minX; }
            else if (tx > maxX) { pushX += maxX - tx; tx = maxX; }
            if (ty < minY) { pushY += minY - ty; ty = minY; }
            else if (ty > maxY) { pushY += maxY - ty; ty = maxY; }
            if (tz < minZ) { pushZ += minZ - tz; tz = minZ; }
            else if (tz > maxZ) { pushZ += maxZ - tz; tz = maxZ; }
            if (pushX !== 0 || pushY !== 0 || pushZ !== 0) anyPush = true;
        }
        // —— 体素：迭代最深穿透推出（3×3×3 窗口，最多 6 轮，O(1)）——
        // 6 轮：实心段一次性推出后通常 1~2 轮收敛；多轮兜底极端多段/拐角场景。
        if (this._grid) {
            let vx = tx, vy = ty, vz = tz;
            for (let pass = 0; pass < 6; pass++) {
                const pen = this._deepestPenetration(vx, vy, vz, radius);
                if (!pen) break;
                pushX += pen.x; pushY += pen.y; pushZ += pen.z;
                vx += pen.x; vy += pen.y; vz += pen.z;
                anyPush = true;
            }
        }
        if (anyPush) {
            out.x = pushX; out.y = pushY; out.z = pushZ;
            return true;
        }
        out.x = 0; out.y = 0; out.z = 0;
        return false;
    }

    // 球心周围体素内找最深穿透（返回推出向量；无则 null）
    // 窗口按碰撞半径动态扩展：ceil(radius/res) 体素（如半径 2m、分辨率 0.3 → ±7 体素，15³），
    // 保证「相机距模型 2m 触发」的球体范围全部覆盖（固定 3×3×3 只覆盖 ±1 体素，
    // 半径大于体素分辨率时表面体素不在窗口内 → 碰撞失效）。
    _deepestPenetration(cx, cy, cz, radius) {
        const res = this.voxelResolution;
        const gx0 = this._gMinX, gy0 = this._gMinY, gz0 = this._gMinZ;
        const cix = Math.floor((cx - gx0) / res);
        const ciy = Math.floor((cy - gy0) / res);
        const ciz = Math.floor((cz - gz0) / res);
        const rSq = radius * radius;
        const range = Math.max(1, Math.ceil(radius / res)); // 碰撞半径覆盖的体素窗口
        let bestPen = 1e-6, bestX = 0, bestY = 0, bestZ = 0;
        let found = false;
        for (let dz = -range; dz <= range; dz++) {
            const iz = ciz + dz;
            if (iz < 0 || iz >= this._nz) continue;
            for (let dy = -range; dy <= range; dy++) {
                const iy = ciy + dy;
                if (iy < 0 || iy >= this._ny) continue;
                for (let dx = -range; dx <= range; dx++) {
                    const ix = cix + dx;
                    if (ix < 0 || ix >= this._nx) continue;
                    if (!this.isVoxelSolid(ix, iy, iz)) continue;
                    const vMinX = gx0 + ix * res, vMinY = gy0 + iy * res, vMinZ = gz0 + iz * res;
                    const vMaxX = vMinX + res, vMaxY = vMinY + res, vMaxZ = vMinZ + res;
                    const nearX = Math.max(vMinX, Math.min(cx, vMaxX));
                    const nearY = Math.max(vMinY, Math.min(cy, vMaxY));
                    const nearZ = Math.max(vMinZ, Math.min(cz, vMaxZ));
                    const ddx = cx - nearX, ddy = cy - nearY, ddz = cz - nearZ;
                    const dSq = ddx * ddx + ddy * ddy + ddz * ddz;
                    if (dSq >= rSq) continue;
                    let pxx, pyy, pzz, pen;
                    if (dSq > 1e-12) {
                        const dist = Math.sqrt(dSq);
                        pen = radius - dist;
                        const inv = 1 / dist;
                        pxx = ddx * inv * pen;
                        pyy = ddy * inv * pen;
                        pzz = ddz * inv * pen;
                    } else {
                        // 球心在体素内：沿最小穿透轴推出（与官方 VoxelCollision 一致），
                        // 且推出距离覆盖该方向上的连续实心段（BugFix「卡墙里面」：
                        // 旧实现只推到最近面 + radius，厚墙内落点仍在相邻实心体素 →
                        // 每帧推出方向来回振荡（+/-）→ 相机卡死在墙内出不来）。
                        const dnX = cx - vMinX, dpX = vMaxX - cx;
                        const dnY = cy - vMinY, dpY = vMaxY - cy;
                        const dnZ = cz - vMinZ, dpZ = vMaxZ - cz;
                        const eX = dnX < dpX ? -(dnX + radius) : (dpX + radius);
                        const eY = dnY < dpY ? -(dnY + radius) : (dpY + radius);
                        const eZ = dnZ < dpZ ? -(dnZ + radius) : (dpZ + radius);
                        const aX = Math.abs(eX), aY = Math.abs(eY), aZ = Math.abs(eZ);
                        pxx = pyy = pzz = 0;
                        if (aX <= aY && aX <= aZ) {
                            const run = this._solidRunLength(ix, iy, iz, eX < 0 ? -1 : 1, 0, 0);
                            pxx = eX < 0 ? -(aX + run) : (aX + run);
                            pen = aX + run;
                        } else if (aY <= aZ) {
                            const run = this._solidRunLength(ix, iy, iz, 0, eY < 0 ? -1 : 1, 0);
                            pyy = eY < 0 ? -(aY + run) : (aY + run);
                            pen = aY + run;
                        } else {
                            const run = this._solidRunLength(ix, iy, iz, 0, 0, eZ < 0 ? -1 : 1);
                            pzz = eZ < 0 ? -(aZ + run) : (aZ + run);
                            pen = aZ + run;
                        }
                    }
                    if (pen > bestPen) {
                        bestPen = pen; bestX = pxx; bestY = pyy; bestZ = pzz;
                        found = true;
                    }
                }
            }
        }
        return found ? { x: bestX, y: bestY, z: bestZ } : null;
    }

    // [卡墙修复] 从 (ix,iy,iz) 沿方向 (sx,sy,sz)（单位轴向量）连续扫描实心体素的
    // 总长度（不含起点体素本身）。用于球心在实心体素内时一次性推过整个实心段，
    // 避免厚墙内推出方向来回振荡（相机卡死在墙内）。
    _solidRunLength(ix, iy, iz, sx, sy, sz) {
        const res = this.voxelResolution;
        let len = 0;
        let cx = ix, cy = iy, cz = iz;
        for (;;) {
            cx += sx; cy += sy; cz += sz;
            if (cx < 0 || cy < 0 || cz < 0 || cx >= this._nx || cy >= this._ny || cz >= this._nz) break;
            if (!this.isVoxelSolid(cx, cy, cz)) break;
            len += res;
        }
        return len;
    }

    // 胶囊（竖直线段 + 半径）碰撞：遍历胶囊包围盒内实心体素取最深穿透（walk 未启用，接口完整性）
    queryCapsule(cx, cy, cz, halfHeight, radius, out) {
        // [碰撞开关补丁] 全局开关关闭时直接返回无碰撞
        if (typeof window !== 'undefined' && window.__ssplatCollisionEnabled === false) {
            out.x = 0; out.y = 0; out.z = 0;
            return false;
        }
        if (!this._grid) {
            out.x = 0; out.y = 0; out.z = 0;
            return false;
        }
        const res = this.voxelResolution;
        const gx0 = this._gMinX, gy0 = this._gMinY, gz0 = this._gMinZ;
        const segBottom = cy - halfHeight, segTop = cy + halfHeight;
        const rSq = radius * radius;
        let bestPen = 1e-6, bestX = 0, bestY = 0, bestZ = 0;
        let found = false;
        const ixMin = Math.floor((cx - radius - gx0) / res);
        const ixMax = Math.floor((cx + radius - gx0) / res);
        const iyMin = Math.floor((segBottom - radius - gy0) / res);
        const iyMax = Math.floor((segTop + radius - gy0) / res);
        const izMin = Math.floor((cz - radius - gz0) / res);
        const izMax = Math.floor((cz + radius - gz0) / res);
        for (let iz = izMin; iz <= izMax; iz++) {
            for (let iy = iyMin; iy <= iyMax; iy++) {
                for (let ix = ixMin; ix <= ixMax; ix++) {
                    if (!this.isVoxelSolid(ix, iy, iz)) continue;
                    const vMinX = gx0 + ix * res, vMinY = gy0 + iy * res, vMinZ = gz0 + iz * res;
                    const vMaxX = vMinX + res, vMaxY = vMinY + res, vMaxZ = vMinZ + res;
                    // 线段上离体素 AABB 最近的 Y
                    let segY;
                    if (segTop < vMinY) segY = segTop;
                    else if (segBottom > vMaxY) segY = segBottom;
                    else segY = Math.max(segBottom, Math.min(segTop, (vMinY + vMaxY) * 0.5));
                    const nearX = Math.max(vMinX, Math.min(cx, vMaxX));
                    const nearY = Math.max(vMinY, Math.min(segY, vMaxY));
                    const nearZ = Math.max(vMinZ, Math.min(cz, vMaxZ));
                    const ddx = cx - nearX, ddy = segY - nearY, ddz = cz - nearZ;
                    const dSq = ddx * ddx + ddy * ddy + ddz * ddz;
                    if (dSq >= rSq) continue;
                    let pxx, pyy, pzz, pen;
                    if (dSq > 1e-12) {
                        const dist = Math.sqrt(dSq);
                        pen = radius - dist;
                        const inv = 1 / dist;
                        pxx = ddx * inv * pen; pyy = ddy * inv * pen; pzz = ddz * inv * pen;
                    } else {
                        const dnX = cx - vMinX, dpX = vMaxX - cx;
                        const dnY = segY - vMinY, dpY = vMaxY - segY;
                        const dnZ = cz - vMinZ, dpZ = vMaxZ - cz;
                        const eX = dnX < dpX ? -(dnX + radius) : (dpX + radius);
                        const eY = dnY < dpY ? -(dnY + radius) : (dpY + radius);
                        const eZ = dnZ < dpZ ? -(dnZ + radius) : (dpZ + radius);
                        const aX = Math.abs(eX), aY = Math.abs(eY), aZ = Math.abs(eZ);
                        pxx = pyy = pzz = 0;
                        if (aX <= aY && aX <= aZ) { pxx = eX; pen = aX; }
                        else if (aY <= aZ) { pyy = eY; pen = aY; }
                        else { pzz = eZ; pen = aZ; }
                    }
                    if (pen > bestPen) {
                        bestPen = pen; bestX = pxx; bestY = pyy; bestZ = pzz;
                        found = true;
                    }
                }
            }
        }
        if (found) {
            out.x = bestX; out.y = bestY; out.z = bestZ;
            return true;
        }
        out.x = 0; out.y = 0; out.z = 0;
        return false;
    }

    // 射线求交：体素 DDA + 房间 slab，取最近命中
    queryRay(ox, oy, oz, dx, dy, dz, maxDist) {
        // [碰撞开关补丁] 全局开关关闭时射线不命中任何碰撞体
        if (typeof window !== 'undefined' && window.__ssplatCollisionEnabled === false) {
            return null;
        }
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-10) return null;
        const nx = dx / len, ny = dy / len, nz = dz / len;
        let best = null;
        // —— 体素 DDA（官方 VoxelCollision 同款）——
        if (this._grid) {
            const hit = this._voxelRay(ox, oy, oz, nx, ny, nz, maxDist);
            if (hit) best = hit;
        }
        // —— 房间 slab（官方 SceneBoundCollision 同款）——
        if (this._roomSet) {
            const hit = this._roomRay(ox, oy, oz, nx, ny, nz, maxDist);
            if (hit && (!best || this._rayDist(ox, oy, oz, hit) < this._rayDist(ox, oy, oz, best))) {
                best = hit;
            }
        }
        return best;
    }

    _rayDist(ox, oy, oz, p) {
        const ddx = p.x - ox, ddy = p.y - oy, ddz = p.z - oz;
        return ddx * ddx + ddy * ddy + ddz * ddz;
    }

    _voxelRay(ox, oy, oz, dx, dy, dz, maxDist) {
        const res = this.voxelResolution;
        const gMinX = this._gMinX, gMinY = this._gMinY, gMinZ = this._gMinZ;
        const gMaxX = gMinX + this._nx * res;
        const gMaxY = gMinY + this._ny * res;
        const gMaxZ = gMinZ + this._nz * res;
        const EPS = 1e-12;
        let tNear = 0, tFar = maxDist;
        if (Math.abs(dx) > EPS) {
            let t1 = (gMinX - ox) / dx, t2 = (gMaxX - ox) / dx;
            if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
            if (t1 > tNear) tNear = t1;
            if (t2 < tFar) tFar = t2;
            if (tNear > tFar) return null;
        } else if (ox < gMinX || ox >= gMaxX) {
            return null;
        }
        if (Math.abs(dy) > EPS) {
            let t1 = (gMinY - oy) / dy, t2 = (gMaxY - oy) / dy;
            if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
            if (t1 > tNear) tNear = t1;
            if (t2 < tFar) tFar = t2;
            if (tNear > tFar) return null;
        } else if (oy < gMinY || oy >= gMaxY) {
            return null;
        }
        if (Math.abs(dz) > EPS) {
            let t1 = (gMinZ - oz) / dz, t2 = (gMaxZ - oz) / dz;
            if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
            if (t1 > tNear) tNear = t1;
            if (t2 < tFar) tFar = t2;
            if (tNear > tFar) return null;
        } else if (oz < gMinZ || oz >= gMaxZ) {
            return null;
        }
        const entryX = ox + dx * tNear;
        const entryY = oy + dy * tNear;
        const entryZ = oz + dz * tNear;
        let ix = Math.max(0, Math.min(Math.floor((entryX - gMinX) / res), this._nx - 1));
        let iy = Math.max(0, Math.min(Math.floor((entryY - gMinY) / res), this._ny - 1));
        let iz = Math.max(0, Math.min(Math.floor((entryZ - gMinZ) / res), this._nz - 1));
        const stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
        const stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
        const stepZ = dz > 0 ? 1 : (dz < 0 ? -1 : 0);
        const invDx = Math.abs(dx) > EPS ? 1 / dx : 0;
        const invDy = Math.abs(dy) > EPS ? 1 / dy : 0;
        const invDz = Math.abs(dz) > EPS ? 1 / dz : 0;
        let tMaxX = Math.abs(dx) > EPS ? (gMinX + (ix + (dx > 0 ? 1 : 0)) * res - ox) * invDx : Infinity;
        let tMaxY = Math.abs(dy) > EPS ? (gMinY + (iy + (dy > 0 ? 1 : 0)) * res - oy) * invDy : Infinity;
        let tMaxZ = Math.abs(dz) > EPS ? (gMinZ + (iz + (dz > 0 ? 1 : 0)) * res - oz) * invDz : Infinity;
        const tDeltaX = Math.abs(dx) > EPS ? res * Math.abs(invDx) : Infinity;
        const tDeltaY = Math.abs(dy) > EPS ? res * Math.abs(invDy) : Infinity;
        const tDeltaZ = Math.abs(dz) > EPS ? res * Math.abs(invDz) : Infinity;
        let currentT = tNear;
        const maxSteps = this._nx + this._ny + this._nz;
        for (let step = 0; step < maxSteps; step++) {
            if (this.isVoxelSolid(ix, iy, iz)) {
                return { x: ox + dx * currentT, y: oy + dy * currentT, z: oz + dz * currentT };
            }
            if (tMaxX < tMaxY) {
                if (tMaxX < tMaxZ) { currentT = tMaxX; ix += stepX; tMaxX += tDeltaX; }
                else { currentT = tMaxZ; iz += stepZ; tMaxZ += tDeltaZ; }
            } else if (tMaxY < tMaxZ) {
                currentT = tMaxY; iy += stepY; tMaxY += tDeltaY;
            } else {
                currentT = tMaxZ; iz += stepZ; tMaxZ += tDeltaZ;
            }
            if (ix < 0 || iy < 0 || iz < 0 || ix >= this._nx || iy >= this._ny || iz >= this._nz || currentT > maxDist) {
                return null;
            }
        }
        return null;
    }

    _roomRay(ox, oy, oz, dx, dy, dz, maxDist) {
        let tMin = -Infinity, tMax = Infinity;
        if (Math.abs(dx) < 1e-12) {
            if (ox < this.minX || ox > this.maxX) return null;
        } else {
            let t1 = (this.minX - ox) / dx, t2 = (this.maxX - ox) / dx;
            if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
            if (t1 > tMin) tMin = t1;
            if (t2 < tMax) tMax = t2;
            if (tMin > tMax) return null;
        }
        if (Math.abs(dy) < 1e-12) {
            if (oy < this.minY || oy > this.maxY) return null;
        } else {
            let t1 = (this.minY - oy) / dy, t2 = (this.maxY - oy) / dy;
            if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
            if (t1 > tMin) tMin = t1;
            if (t2 < tMax) tMax = t2;
            if (tMin > tMax) return null;
        }
        if (Math.abs(dz) < 1e-12) {
            if (oz < this.minZ || oz > this.maxZ) return null;
        } else {
            let t1 = (this.minZ - oz) / dz, t2 = (this.maxZ - oz) / dz;
            if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
            if (t1 > tMin) tMin = t1;
            if (t2 < tMax) tMax = t2;
            if (tMin > tMax) return null;
        }
        const t = tMin < 0 ? tMax : tMin;
        if (t < 0 || t > maxDist) return null;
        return { x: ox + dx * t, y: oy + dy * t, z: oz + dz * t };
    }

    // 命中点表面法线：优先体素面法线（朝射线起点），回退房间面法线
    querySurfaceNormal(x, y, z, rdx, rdy, rdz) {
        const result = this._normalResult;
        const len = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
        if (len < 1e-10) {
            result.nx = 0; result.ny = 1; result.nz = 0;
            return result;
        }
        const dx = rdx / len, dy = rdy / len, dz = rdz / len;
        // —— 体素面法线 ——
        if (this._grid) {
            const res = this.voxelResolution;
            const nudge = res * 0.25;
            const px = x + Math.sign(dx) * nudge;
            const py = y + Math.sign(dy) * nudge;
            const pz = z + Math.sign(dz) * nudge;
            const ix = Math.floor((px - this._gMinX) / res);
            const iy = Math.floor((py - this._gMinY) / res);
            const iz = Math.floor((pz - this._gMinZ) / res);
            if (this.isVoxelSolid(ix, iy, iz)) {
                const vMinX = this._gMinX + ix * res;
                const vMinY = this._gMinY + iy * res;
                const vMinZ = this._gMinZ + iz * res;
                const eps = res * 0.05;
                let snx = 0, sny = 0, snz = 0;
                if (Math.abs(x - vMinX) < eps) snx = -1;
                else if (Math.abs(x - vMinX - res) < eps) snx = 1;
                else if (Math.abs(y - vMinY) < eps) sny = -1;
                else if (Math.abs(y - vMinY - res) < eps) sny = 1;
                else if (Math.abs(z - vMinZ) < eps) snz = -1;
                else if (Math.abs(z - vMinZ - res) < eps) snz = 1;
                if (snx !== 0 || sny !== 0 || snz !== 0) {
                    if (snx * dx + sny * dy + snz * dz > 0) {
                        snx = -snx; sny = -sny; snz = -snz;
                    }
                    result.nx = snx; result.ny = sny; result.nz = snz;
                    return result;
                }
                // 掠角命中：退回沿射线反方向
                result.nx = -dx; result.ny = -dy; result.nz = -dz;
                return result;
            }
        }
        // —— 房间面法线（与 SceneBoundCollision 一致）——
        const eps = 1e-4;
        let nx2 = 0, ny2 = 0, nz2 = 0;
        if (Math.abs(x - this.minX) < eps) nx2 = -1;
        else if (Math.abs(x - this.maxX) < eps) nx2 = 1;
        else if (Math.abs(y - this.minY) < eps) ny2 = -1;
        else if (Math.abs(y - this.maxY) < eps) ny2 = 1;
        else if (Math.abs(z - this.minZ) < eps) nz2 = -1;
        else if (Math.abs(z - this.maxZ) < eps) nz2 = 1;
        if (nx2 !== 0 || ny2 !== 0 || nz2 !== 0) {
            if (nx2 * dx + ny2 * dy + nz2 * dz > 0) {
                nx2 = -nx2; ny2 = -ny2; nz2 = -nz2;
            }
            result.nx = nx2; result.ny = ny2; result.nz = nz2;
            return result;
        }
        result.nx = 0; result.ny = 1; result.nz = 0;
        return result;
    }

    // 自由空间判断：在房间内 且 不在实心体素内（spawn 搜索 / NavCursor 用）
    isFreeAt(x, y, z) {
        if (this._roomSet) {
            if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY || z < this.minZ || z > this.maxZ) {
                return false;
            }
        }
        if (this._grid) {
            const ix = Math.floor((x - this._gMinX) / this.voxelResolution);
            const iy = Math.floor((y - this._gMinY) / this.voxelResolution);
            const iz = Math.floor((z - this._gMinZ) / this.voxelResolution);
            if (this.isVoxelSolid(ix, iy, iz)) return false;
        }
        return true;
    }

    // 相机/点到最近实心体素表面（模型）的距离（需求④，UI 与碰撞推出参考）。
    // 近似实现：以查询点为球心的切比雪夫壳层向外搜索（步长 = 体素分辨率），
    // 第一个命中的实心体素按「点到体素 AABB 最近点」计算距离；未命中返回 -1。
    distanceToModel(x, y, z, maxDist) {
        if (!this._grid) return -1;
        const res = this.voxelResolution;
        const gx0 = this._gMinX, gy0 = this._gMinY, gz0 = this._gMinZ;
        const cix = Math.floor((x - gx0) / res);
        const ciy = Math.floor((y - gy0) / res);
        const ciz = Math.floor((z - gz0) / res);
        if (this.isVoxelSolid(cix, ciy, ciz)) return 0;
        const maxCells = Math.min(Math.ceil(maxDist / res), Math.max(this._nx, this._ny, this._nz));
        for (let r = 1; r <= maxCells; r++) {
            for (let dz = -r; dz <= r; dz++) {
                const iz = ciz + dz;
                if (iz < 0 || iz >= this._nz) continue;
                for (let dy = -r; dy <= r; dy++) {
                    const iy = ciy + dy;
                    if (iy < 0 || iy >= this._ny) continue;
                    const onShell = Math.abs(dz) === r || Math.abs(dy) === r;
                    for (let dx = -r; dx <= r; dx++) {
                        if (!onShell && Math.abs(dx) !== r) continue; // 只遍历壳层
                        const ix = cix + dx;
                        if (ix < 0 || ix >= this._nx) continue;
                        if (!this.isVoxelSolid(ix, iy, iz)) continue;
                        const vMinX = gx0 + ix * res, vMinY = gy0 + iy * res, vMinZ = gz0 + iz * res;
                        const nearX = Math.max(vMinX, Math.min(x, vMinX + res));
                        const nearY = Math.max(vMinY, Math.min(y, vMinY + res));
                        const nearZ = Math.max(vMinZ, Math.min(z, vMinZ + res));
                        const ddx = x - nearX, ddy = y - nearY, ddz = z - nearZ;
                        return Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
                    }
                }
            }
        }
        return -1;
    }
}
