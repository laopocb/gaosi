/**
 * 本地 3D 高斯查看器 —— 自定义启动与控制逻辑（无自绘 UI）
 * =====================================================
 * 职责：
 *   1. 在官方 viewer 启动（DOMContentLoaded 回调中调用 main()）之前，改写
 *      window.sse.config（模式语义 v2，BugFix：Web 端桌面默认轻量数据）：
 *        - 默认（无 mode 参数）：桌面与手机统一走**轻量数据** —— 手机版 Streamed SOG
 *          （./sog_data_mobile/streamed/lod-meta.json，12MB LOD 渐进，首屏按预算秒开，
 *          公网低带宽可快速显示；iOS 仍回落 mobile.compressed.ply，见 FORCE_IOS_PLY）；
 *        - 合并模式（?mode=merge，显式完整版）：桌面把 14 个 .sog（74MB）全部加载进
 *          同一场景同时渲染（写入 config.mergeFiles，由 build.mjs 注入 bundle 的
 *          loadGsplats 消费）；iOS 因 SOG 不可解析仍回落 PLY；安卓/鸿蒙无手机版合并
 *          数据，回落手机版流式（不生成 14 个手机版 .sog，取舍见文件头第 3 点）；
 *        - 单文件模式（?mode=single）：桌面加载 sog_data/ 下由 ?file= 参数指定的 .sog 文件
 *          （默认 0_0.sog；file= 参数在合并模式下保留但忽略）；
 *        - 流式模式（?mode=streamed，显式）：桌面加载桌面版完整流式 ./streamed/
 *          （130MB，需高带宽）；手机加载手机版流式；由官方 viewer 自动管理 LOD 与
 *          分块加载，自动适配设备性能。
 *        - ?mobile=1 强制手机语义（轻量）；?mobile=0 强制桌面语义（默认仍轻量，
 *          仅叠加 ?mode=merge 才加载完整版）。
 *   2. 解析 URL 参数：?file / ?mode / ?flip / ?voxres / ?mobile，写入对应全局标志；
 *   3. **手机模式（移动端自动适配）**：
 *        - 触发条件：手机 UA / 窄屏自动检测（默认），或显式 ?mobile=1 强制开启；
 *          桌面手动 ?mobile=0 可强制关闭（进入桌面语义；默认仍轻量，仅叠加
 *          ?mode=merge 才加载完整版 sog_data/）；
 *        - 默认进入 **手机版 Streamed SOG**（./sog_data_mobile/streamed/lod-meta.json，
 *          由 splat-transform 预生成：13 个 tile 合并（排除 env）→ 降采样 50 万 splat →
 *          Streamed SOG 分块；总大小约 15-30MB）。官方手机最优：LOD 渐进、秒开、
 *          按预算自适应加载；?mode=single 在手机模式下加载手机版单文件 mobile.sog
 *          （50 万 splat 降采样，回退方案）；?mode=merge 在手机模式下同样落回流式
 *          （不生成 14 个手机版 .sog，取舍见第 3 点说明）；
 *        - **iOS（iPhone/iPad，任务①白屏修复）**：任何 mode 参数（默认/streamed/single/
 *          merge）一律回落 **mobile.compressed.ply**（./sog_data_mobile/mobile.compressed.ply，
 *          50 万 splat → compressed.ply，SH0、无 WebP 纹理、无 zip/DecompressionStream）。
 *          根因：SOG 内嵌 WebP 纹理 + zip 解压（DecompressionStream 需 Safari 16.4+）在
 *          iOS 16 早期版本不可用（官方 engine 在 Safari 上还主动禁用 createImageBitmap，
 *          supportsImageBitmap = !isSafari），压缩 PLY 是官方推荐的 Safari/mobile 格式；
 *          安卓/鸿蒙保留流式 WebP（性能最优）。
 *        - 场景级 splat 预算调低到 0.6M（桌面默认轻量流式与手机一致，覆盖 12M 合并默认；
 *          手机版 LOD0 全量约 50 万，0.6M 可完整覆盖），体素碰撞分辨率调粗到 0.5m
 *          （默认，?voxres= 显式参数仍可覆盖）——在保证「空气墙 + 体素碰撞」兜底能力
 *          不变的前提下，显著降低手机端 CPU/GPU 负担（目标 30-45 FPS）；
 *        - 渲染层：手机端强制 WebGL2（WebGPU 在 iOS Safari/多数安卓浏览器不可用；
 *          官方 viewer 的 platform.mobile 默认也是 WebGL），桌面保持默认；
 *   4. 挂接官方 window.firstFrame 钩子（首帧渲染完成）与合并进度/完成钩子
 *      （window.__ssplatMergeProgress / __ssplatMergeDone），状态仅流转到
 *      window.__ssplatOnStatus 回调（默认静默，不注入任何 DOM）；
 *   5. 挂接体素碰撞构建进度/完成钩子（window.__ssplatVoxelProgress / __ssplatVoxelDone），
 *      同样仅流转到 window.__ssplatOnStatus 回调。
 *
 * 界面说明（需求②：移除 ssplat-panel）：
 *   本文件不再注入任何自绘 UI（无 #ssplat-panel、无文件下拉、无查看模式按钮、
 *   无「保存当前视角」按钮、无状态栏）。页面为纯官方 viewer 界面（官方 play/暂停/
 *   时间轴控件已在 build.mjs 的 index.html 补丁中隐藏）。
 *   **唯一例外：?debug=1 显式开启诊断面板**（#__ssplatDebugPanel，绝对定位小面板，
 *   纯诊断用途，默认关闭不创建任何 DOM）——显示 UA / IS_MOBILE / IS_IOS /
 *   FORCE_IOS_PLY / contentUrl / renderer / 加载状态 / window 错误收集（最多 5 条），
 *   用于 iOS 白屏等现场排查（用户 iPhone 打开 ?debug=1 截图即可）。build.mjs 已在
 *   官方脚本执行前注入错误收集器（window.__ssplatDebugErrors），app.js 末尾做兜底补装。
 *   状态输出已全部移除（需求：log 日志之类输出信息全部移除，本文件不产生任何 console.* 输出）。
 *   状态流转统一走极简回调 window.__ssplatOnStatus：
 *     - 默认实现为空函数（静默），页面不产生任何状态输出；
 *     - 外部（含未来自定义 UI）可覆写该回调接管状态展示；
 *     - 内部 setStatus 优先调用 window.__ssplatOnStatus，未覆写时静默跳过。
 *
 * 执行时机：本脚本以 <script type="module"> 放在官方 index.html 的 </body> 之前，
 * 位于官方两个内联脚本之后。module 脚本按文档顺序执行，因此本脚本会在
 * DOMContentLoaded（官方 main() 启动）之前完成对 window.sse.config 的改写。
 * 官方第二个脚本捕获的是 config 对象引用（非拷贝），改写对 main() 同样可见。
 */
(() => {
    'use strict';

    // ---------- ?debug=1 诊断开关（显式开启，默认关闭；不违背「日志移除」要求） ----------
    // build.mjs 已在官方脚本执行前注入 window 级错误收集器（__ssplatDebugErrors /
    // __ssplatDebugCollect，见 index.html 的 head 补丁）；此处做防御性兜底：若 head
    // 收集器缺失（例如脱离 build 直接运行），则在本文件执行时立即补装，尽可能早地
    // 捕获 window error / unhandledrejection（最多 5 条，供诊断面板展示）。
    // 注意：?debug=1 仅显式开启诊断面板，默认（无参数）不创建任何 DOM、不输出任何日志。
    const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
    if (!window.__ssplatDebugErrors) {
        window.__ssplatDebugErrors = [];
    }
    if (typeof window.__ssplatDebugCollect !== 'function') {
        window.__ssplatDebugCollect = (type, text) => {
            try {
                if (window.__ssplatDebugErrors.length >= 5) window.__ssplatDebugErrors.shift();
                window.__ssplatDebugErrors.push({ type: type, text: String(text), time: Date.now() });
            } catch (e) { /* 静默：诊断收集器自身异常不影响主流程 */ }
        };
        if (typeof window.addEventListener === 'function') {
            window.addEventListener('error', (event) => {
                const msg = (event && event.message) ? event.message : '未知错误';
                const where = (event && event.filename) ? ' @' + String(event.filename).split('/').pop() + ':' + (event.lineno || 0) : '';
                window.__ssplatDebugCollect('error', msg + where);
            });
            window.addEventListener('unhandledrejection', (event) => {
                let text = 'Promise rejected';
                try {
                    const reason = event && event.reason;
                    if (reason instanceof Error) text = 'Promise: ' + reason.message;
                    else if (reason && reason.message) text = 'Promise: ' + reason.message;
                    else text = 'Promise: ' + String(reason);
                } catch (e) { /* 静默 */ }
                window.__ssplatDebugCollect('unhandledrejection', text);
            });
        }
    }

    // ---------- 加载封面隐藏（splash：云冈艺术巡展海报，首帧渲染完成后淡出） ----------
    // build.mjs 已在 dist/index.html 的 <body> 开头注入 #ssplatCover 封面 DOM + 内联 CSS/脚本
    // （位于官方脚本之前），其中已定义 window.__ssplatCover；此处兜底补装（与内联定义一致、防重复）：
    //   - 内联脚本先执行（位于 <body> 开头，早于本文件）→ 此处 typeof 判断为 function 直接跳过；
    //   - 若脱离 build 直接运行（无内联脚本）→ 此处补装，window.firstFrame 触发时仍能隐藏封面。
    // 触发链路：window.firstFrame（首帧渲染完成）→ onFirstFrameInternal() → window.__ssplatCover()
    // → #ssplatCover 加 .hidden（opacity 1→0 过渡 0.8s 后兜底 display:none，不拦截点击）。
    // 失败/超时兜底见「2.2 splash 超时兜底」（首帧 30s 未触发 → 自动隐藏封面 + 极简失败提示，
    // 封面不再常驻遮挡 —— BugFix：加载失败时用户看到的不是"海报 + 黑屏"）。
    if (typeof window.__ssplatCover !== 'function') {
        window.__ssplatCover = () => {
            try {
                const cover = document.getElementById('ssplatCover');
                if (!cover || cover.classList.contains('hidden')) return;
                cover.classList.remove('show');
                cover.classList.add('hidden');
                // 兜底：CSS 过渡结束后彻底隐藏（display:none），确保任何情况下不遮挡/不拦截点击
                setTimeout(() => {
                    if (cover && cover.classList.contains('hidden')) {
                        cover.style.display = 'none';
                    }
                }, 900);
            } catch (e) {
                // 静默：封面隐藏失败绝不影响查看器主流程（日志已全部移除）
            }
        };
    }

    // ---------- 常量 ----------

    // 内置文件清单（/api/files 接口不可用时的回退方案，与 sog_data 目录一致；
    // 合并模式固定使用此清单，确保与 build.mjs 复制的数据完全对应）
    const FALLBACK_FILES = [
        '0_0.sog', '0_11_0_0_0.sog', '0_13_0_0.sog', '0_13_0_0_0.sog',
        '0_15_0_0_0.sog', '0_3_0.sog', '0_3_0_0.sog', '0_3_0_0_0.sog',
        '0_4_0.sog', '0_6_0_0_0.sog', '0_9_0_0.sog', '0_9_0_0_0.sog',
        '0_9_0_0_1.sog', 'env.sog'
    ];

    const DEFAULT_FILE = '0_0.sog';

    // 合并模式下场景级 splat 预算（单位：百万）。14 个文件解压后总 splat 数较大，
    // 官方默认桌面预算仅 4M，会导致大量 splat 被裁掉；这里放宽到 12M 让整体尽量可见。
    const MERGE_BUDGET_MILLIONS = 12;

    // 手机模式 splat 预算（单位：百万）。手机版数据（Streamed SOG）LOD0 全量约 50 万 splat，
    // 0.6M 预算可完整覆盖全部手机版 splat，同时显著低于桌面 12M，保证手机端流畅
    // （目标 30-45 FPS）。若 URL 显式给出 ?budget= 则尊重用户显式值。
    const MOBILE_BUDGET_MILLIONS = 0.6;

    // 数据目录与 URL（模式语义 v2，BugFix：桌面默认轻量数据）：
    //   桌面完整版：sog_data/（14 个 .sog，仅 ?mode=merge 显式加载）、
    //     streamed/（桌面版完整流式，仅 ?mode=streamed 显式加载，130MB 需高带宽）；
    //   轻量数据（桌面默认 + 手机主方案）：sog_data_mobile/streamed/（手机版 Streamed SOG：
    //     lod-meta.json + 分块，12MB LOD 渐进，首屏秒开，公网低带宽可快速显示）；
    //   sog_data_mobile/mobile.sog（手机版单文件，?mode=single 回退）。
    // 手机版由 splat-transform 预生成：13 个 tile 合并（排除 env）→ 降采样 50 万 →
    // Streamed SOG / 单文件 .sog；桌面默认也复用手机版轻量数据（保证 Web 端能看到 3D 数据）。
    const DESKTOP_MERGE_DIR = './sog_data/';
    const DESKTOP_STREAMED_URL = './streamed/lod-meta.json';
    const MOBILE_STREAMED_URL = './sog_data_mobile/streamed/lod-meta.json';
    const MOBILE_SINGLE_URL = './sog_data_mobile/mobile.sog';
    // iOS 兼容格式（mobile.compressed.ply：500 万 splat 降采样 50 万 → compressed.ply，
    // 顶点内嵌 SH/颜色，无 WebP 纹理、无 zip、无 DecompressionStream —— 见文件头「iOS 16 白屏修复」）。
    // 生成命令（splat-transform v3.3.0，RTX3060 GPU）：
    //   node node_modules/@playcanvas/splat-transform/bin/cli.mjs -g 0 -w --stats text \
    //     sog_data_mobile/_src/mobile-500k.ply -H 0 -N -m --sh-iterations 6 \
    //     sog_data_mobile/_src/mobile-500k.compressed.ply
    // （mobile-500k.ply 为合并 13 tile 后降采样的 50 万 splat 源；compressed.ply 产物 8.1MB，
    //   比 mobile.sog 6.1MB 大 33%，换来 iOS 全版本兼容——SOG 内嵌 WebP 纹理与 zip 解压在
    //   iOS 16.0~16.3（Safari 无 DecompressionStream）无法工作，官方推荐 Safari 使用
    //   compressed.ply（SH0）。安卓/鸿蒙保留流式 WebP（性能最优）。）
    const MOBILE_IOS_URL = './sog_data_mobile/mobile.compressed.ply';

    // 手机模式体素碰撞默认分辨率（m）：调粗到 0.5m（桌面默认 0.3m）。
    // 取舍说明：体素网格按此分辨率把场景栅格化，0.5m 比 0.3m 的体素数约为 (0.3/0.5)^3 ≈ 22%，
    // 构建耗时与内存占用大幅下降（手机 CPU 更弱）；碰撞精度仍足以「不能穿模型」，
    // 且空气墙（基于合并包围盒、与分辨率无关）作为最终兜底逻辑不变。
    // ?voxres= 显式参数优先级更高（0.1~2 范围内生效），可在手机端手动调回 0.3。
    const MOBILE_DEFAULT_VOXEL_RESOLUTION = 0.5;

    // ---------- 移动端检测 ----------

    /**
     * 检测是否为 iOS 设备（iPhone / iPad / iPod touch）。
     * 覆盖两类 UA：
     *   - iPhone/iPod：UA 含 iphone/ipod；
     *   - iPadOS 13+：UA 伪装成 Macintosh（无 ipad 关键字），用「Macintosh + 触摸点 > 1」
     *     识别（iPad 必然有触摸屏；桌面 Mac 绝大多数 maxTouchPoints=0，少数带 Touch Bar 的
     *     MacBook 为 5——误判概率极低且手机模式仍可用）。
     * @returns {boolean}
     */
    const isIOsDevice = () => {
        const ua = (typeof navigator !== 'undefined' && navigator.userAgent
            ? navigator.userAgent : '').toLowerCase();
        if (/iphone|ipod/.test(ua)) return true;
        if (/ipad/.test(ua)) return true; // 旧 iOS 12 及以下 UA 含 ipad
        if (/macintosh/.test(ua) && typeof navigator !== 'undefined' &&
            typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1) {
            return true; // iPadOS 13+（UA 伪装 Macintosh）
        }
        return false;
    };

    /**
     * 检测是否为移动端设备。
     * 通过 User-Agent 关键字匹配（覆盖安卓/华为/苹果），同时辅以屏幕宽度判断。
     * 说明：UA 判定结果会被 ?mobile=1 / ?mobile=0 显式参数覆盖（见「1. 读取 URL 参数」），
     * 因此本函数只做「自动检测」，最终 IS_MOBILE 在解析 URL 参数后计算。
     * @returns {boolean}
     */
    const isMobile = () => {
        // 防御性读取：部分环境（如 Node 单测 mock）可能没有 navigator 或 userAgent
        const ua = (typeof navigator !== 'undefined' && navigator.userAgent
            ? navigator.userAgent : '').toLowerCase();
        // 移动端 UA 关键字
        const mobileKeywords = [
            'android', 'iphone', 'ipad', 'ipod',  // 安卓/苹果
            'huawei', 'harmonyos',                 // 华为/鸿蒙
            'mobile', 'phone', 'tablet',           // 通用
            'miui', 'oppo', 'vivo', 'xiaomi',     // 国产厂商
        ];
        const hasMobileKeyword = mobileKeywords.some((kw) => ua.includes(kw));
        // 屏幕宽度 < 768px 仅作**辅佐**：只在 UA 已有移动特征时辅助判定（应对 UA 篡改），
        // 不能独立触发移动端——否则桌面浏览器/预览面板窗口窄（<768px）会被误判为手机，
        // 导致 /new 走手机分支数据（与 PC 不一致）。桌面 UA + 窄窗 → 仍是桌面。
        const isNarrowScreen = window.innerWidth < 768;
        // iPadOS 13+ UA 伪装成 Macintosh，关键字/宽度都识别不了，需单独识别（任务③：UA 检测修正）
        return hasMobileKeyword || (hasMobileKeyword && isNarrowScreen) || isIOsDevice();
    };

    // ---------- 状态输出（不注入 DOM；已移除全部 console.* 输出） ----------

    /**
     * 极简状态回调：外部可覆写 window.__ssplatOnStatus 接管状态展示（例如自定义 UI），
     * 未覆写时静默（不输出任何内容）。kind 取值：'' / 'ok' / 'error'。
     * 注：状态输出已全部移除，本文件不产生任何 console.* 日志；如需查看状态，
     *     请外部覆写 window.__ssplatOnStatus。
     * @param {string} text 状态文本
     * @param {string} [kind] 状态类别
     */
    const setStatus = (text, kind = '') => {
        const statusCallback = window.__ssplatOnStatus;
        // 防御：即使外部把 __ssplatOnStatus 覆写回 setStatus 自身，也绝不自我递归
        // （曾因把全局回调赋值为 setStatus 自身导致无限递归 RangeError 爆栈）
        if (typeof statusCallback === 'function' && statusCallback !== setStatus) {
            statusCallback(text, kind);
        }
        // 未覆写时静默：不输出任何 console 内容（需求：移除全部日志输出）
    };
    // 暴露给 bundle 体素进度/加载状态内部使用：默认全局回调为独立的静默空函数
    // （与 setStatus 解耦，绝不自我引用；外部可覆写 window.__ssplatOnStatus 接管状态展示，
    //  未覆写时不产生任何输出）
    window.__ssplatOnStatus = (text, kind = '') => {
        // 静默：状态输出已全部移除，如需可外部覆写本回调
    };

    // 千分位格式化（用于展示总 splat 数）
    const formatNumber = (value) => {
        return typeof value === 'number' ? value.toLocaleString('zh-CN') : String(value);
    };

    // ---------- 1. 读取 URL 参数 ----------

    const params = new URLSearchParams(location.search);
    const fileParam = (params.get('file') || '').trim();
    const flipParam = params.get('flip');
    const modeParam = (params.get('mode') || '').trim();
    const voxresParam = params.get('voxres');
    const mobileParam = params.get('mobile');
    const walkParam = params.get('walk');
    const pinchParam = params.get('pinch');
    const gcParam = params.get('gc');
    const logParam = params.get('log');
    const orbit360Param = params.get('orbit360');

    // ---------- 旋转限制开关 ----------
    // 模型翻转后坐标系与 Max 相反：默认鼠标左键 orbit 旋转限制 180°
    // （bundle 补丁：yaw/pitch 各以基准 ±90° clamp，左右/垂直拖拽都不能 360°）；
    // ?orbit360=1 关闭限制，恢复官方行为。
    window.__ssplatYawLock = orbit360Param !== '1';
    window.__ssplatPitchLock = orbit360Param !== '1';

    // ---------- 测试数据页面（任务④：通过页面区分，不通过按钮） ----------
    // 默认页面（/ 或 /index.html）完全保持上个版本行为：仅加载云冈数据。
    // 新增测试数据页面路径 /test（nginx SPA 回退到 index.html，app.js 按 pathname 识别）：
    //   - 访问 /test → 加载 new_data/ 优化产物（splat-transform 降采样 50 万 splat：
    //     桌面/安卓 t0.mobile.sog 5.8MB，iOS t0.compressed.ply 7.8MB 无 WebP/zip 依赖）；
    //   - 不访问 /test → 完全不受影响（不加载 new_data、不创建任何按钮/DOM）。
    // 说明：测试页只切换数据源，碰撞/空气墙/行走等逻辑完全不变（同一套构建与查询管线）。
    const IS_TEST_PAGE = typeof location.pathname === 'string' &&
        (location.pathname === '/test' || location.pathname.endsWith('/test'));
    // 新增 /new 数据页：加载 point_cloud 数据集（完整版 88.6MB / 788.9 万 splat，或降采样 50 万）。
    //   - 访问 /new → 桌面默认加载降采样 point_cloud.mobile.sog（6.1MB，约 16s 加载，
    //     服务器公网带宽实测 ~364KB/s，完整版需 4-5 分钟会「卡加载」）；?full=1 强制完整版
    //     point_cloud.sog（788.9 万 splat，本地/高带宽用）；
    //   - 安卓/手机加载 point_cloud.mobile.sog（50 万 splat 降采样，手机预算 0.6M 内）；
    //   - iOS 回落 point_cloud.mobile.compressed.ply（无 WebP/zip 依赖，防 iOS 白屏）；
    //   - 默认旋转 rx=90° + rz=180°：旋转模型本身使其**水平放置在场景中**（点云 PCA 实测最长轴沿
    //     Y 竖直 ≈ (-0.29, +0.96, +0.05)，绕 X 转 90° 后最长轴躺平到水平 Z 方向；再绕 Z 转 180°
    //     翻转正面；?rx=?ry=?rz= 可覆盖调试）；
    //   - 模型居中到原点 + 相机定位（teleport 到用户指定位姿，?focus=0 关闭）；
    //   - 与 /test 一致：强制单文件模式，碰撞/空气墙/行走逻辑完全不变。
    // 多入口判定（适配不同部署环境 + 用户要求 index.html 即 new 页）：
    //   - 默认页 / 与 /index.html → 直接是 new 页（云冈默认页内容已移除，不通过 index.html 承载）；
    //   - nginx：pathname === '/new' 或 endsWith('/new')（try_files 兜底到 index.html）；
    //   - COS 静态托管（无路由重写）：访问 new.html（部署包内置副本，pathname endsWith('/new.html')）
    //     或 index.html?page=new（URL 参数显式指定，与路径无关，最通用）。
    const IS_NEW_PAGE = typeof location.pathname === 'string' && (
        location.pathname === '/new' || location.pathname.endsWith('/new') ||
        location.pathname.endsWith('/new.html') || params.get('page') === 'new' ||
        location.pathname === '/' || location.pathname === '' || location.pathname.endsWith('/index.html')
    );
    const IS_DATA_PAGE = IS_TEST_PAGE || IS_NEW_PAGE;
    const focusParam = params.get('focus');
    const fullParam = params.get('full');
    const TEST_DATASET = IS_NEW_PAGE
        ? {
            // /new 加载策略（用户要求，PC 与手机完全一致，无中间档）：
            // 先加载 point_cloud.mobile.sog（50 万，秒开）→ 体素构建完成后由
            // __ssplatSwapConfig 触发后台加载 point_cloud.compressed.ply（完整版 chunked PLY，
            // 788.9 万 splat，128MB）替换。?full=1 跳过渐进直接完整版；
            // iOS 无法解析 SOG 回落 mobile.compressed.ply。
            desktop: fullParam === '1' ? './new_data/point_cloud.compressed.ply' : './new_data/point_cloud.mobile.sog',
            android: fullParam === '1' ? './new_data/point_cloud.compressed.ply' : './new_data/point_cloud.mobile.sog',
            ios: './new_data/point_cloud.mobile.compressed.ply'
        }
        : {
            desktop: './new_data/t0.mobile.sog',
            android: './new_data/t0.mobile.sog',
            ios: './new_data/t0.compressed.ply'
        };
    // 测试数据坐标系修正（仅数据页 /test、/new 生效，默认页完全不变）：
    //   - /new 默认：x=90°、y=0°、z=180°（旋转模型本身使其水平放置 + Z 轴翻转 180°）；
    //   - /test 默认：x=0°、y=0°、z=180°（保持原样）；
    //   - 调试覆盖：?rx=角度 ?ry=角度 ?rz=角度，方便直接改 URL 测试不同角度组合，无需改代码重建。
    // 补丁侧：setLocalEulerAngles(rx, ry, rz)，欧拉组合 R = Rx * Ry * Rz。
    if (IS_DATA_PAGE) {
        const testRxParam = params.get('rx');
        const testRyParam = params.get('ry');
        const testRzParam = params.get('rz');
        window.__ssplatTestX = testRxParam !== null && Number.isFinite(Number(testRxParam)) ? Number(testRxParam) : (IS_NEW_PAGE ? 90 : 0);
        window.__ssplatTestY = testRyParam !== null && Number.isFinite(Number(testRyParam)) ? Number(testRyParam) : 0;
        window.__ssplatTestZ = testRzParam !== null && Number.isFinite(Number(testRzParam)) ? Number(testRzParam) : (IS_NEW_PAGE ? 180 : 180);
        // 模型加载完成后把旋转后的世界包围盒中心平移到世界原点 (0,0,0)：
        // 实体 addChild 后立即执行（resolve 之前），官方随后用 getWorldTransform 计算
        // sceneBound（空气墙/体素房间/相机取景）时已包含平移，全部自动跟随。
        window.__ssplatCenterModelsAtOrigin = true;
        // 相机定位到模型包围盒中心：模型居中到原点后包围盒中心 ≈ (0,0,0)，
        // 定义触发函数（在体素构建完成回调中调用，场景/空气墙就绪后执行），
        // 用 walk 状态机平滑移动到包围盒中心点（?focus=0 关闭，恢复官方自动取景）。
        // 注意：仅 /test 页注册瞬移取景点（t0 专用坐标）。/new 页**不注册**——
        // 模型已旋转为水平放置（rx=90°），原针对竖立模型的相机位姿
        // （pos=(-8.13,14.20,4.80) rot=(87.66/359.81/0.00)）已失效会看不到模型，
        // /new 恢复为官方取景基础上的自定义定位（见下方 IS_NEW_PAGE 分支）。
        if (IS_TEST_PAGE) {
            // 相机直接定位（瞬移，不走平滑飞行）：固定位置 + 固定朝向。
            // pos=(-0.00, 0.92, 0.55) rot=(6.35/-26.65/0.00)（用户确认的取景点）。
            // 写入 window.__ssplatTeleportState，由 CameraManager.update 每帧消费一次
            // （position/angles 直接写入 + orbit.goto 同步，防止下一帧被控制器覆盖）。
            // ?focus=0 关闭，恢复官方自动取景。
            window.__ssplatFocusBBoxCenter = () => {
            try {
                const ent = (window.__ssplatEntities && window.__ssplatEntities[0]) || null;
                // 固定取景点：位置 + 相机朝向欧拉角（this.camera.angles: x/y/z）
                window.__ssplatTeleportState = { x: -0.00, y: 0.92, z: 0.55, ax: 6.35, ay: -26.65, az: 0.00 };
                // 输出实体实际欧拉角（验证旋转是否真正生效；playcanvas 欧拉角 = 局部 ZYX，注意读取顺序）
                let eulerStr = 'n/a';
                try {
                    if (ent && typeof ent.getLocalEulerAngles === 'function') {
                        const e = ent.getLocalEulerAngles();
                        eulerStr = 'x=' + e.x.toFixed(2) + ' y=' + e.y.toFixed(2) + ' z=' + e.z.toFixed(2);
                    }
                } catch (e2) { /* 静默 */ }
                window.__ssplatLog('cam', '相机直接定位到 (-0.00, 0.92, 0.55) rot=(6.35/-26.65/0.00) 实体欧拉角[' + eulerStr + ']');
            } catch (e) { /* 静默 */ }
            };
        } else if (IS_NEW_PAGE) {
            // /new 页相机初始定位：位置 (10.14, 4.33, 17.69) + 朝向欧拉角 (6.88/34.00/0.00)（用户指定）。
            // 形态 1：{x,y,z, ax,ay,az}（teleport 补丁直接写 position/angles）。
            // 强制飞行模式：fly 下旋转限制（yaw/pitch ±90°）不生效（该限制仅在 orbit 控制器）。
            window.__ssplatFocusBBoxCenter = () => {
                try {
                    window.__ssplatTeleportState = { x: 10.14, y: 4.33, z: 17.69, ax: 6.88, ay: 34.00, az: 0.00 };
                    window.__ssplatLog('cam', '相机初始定位到 (10.14, 4.33, 17.69) rot=(6.88/34.00/0.00)（用户参数）');
                } catch (e) { /* 静默 */ }
            };
            // 强制飞行状态（bundle 补丁：CameraManager 初始模式强制 fly，覆盖默认 orbit）
            window.__ssplatForceFly = true;
            // 注销 Q/E 升降快捷键（bundle 补丁：FlySource y 轴输入恒 0）
            window.__ssplatQEEnabled = false;
            // 相机高度固定 = 相机参数 y（4.33）（bundle 补丁：每帧无条件钳制 camera.position.y）
            window.__ssplatCameraHeightFixed = true;
            window.__ssplatCameraHeight = 4.33;
            // 空气墙「最远」外扩放宽到 30m：/new 页相机可在模型远处自由活动，
            // 靠近模型由体素碰撞（半径 0.5m）触发「距模型 0.5m 不能再近」。
            window.__ssplatAirWallOffset = 30;
            // [渐进加载] 见下方 singleUrl 设置处（IS_MOBILE/FORCE_IOS_PLY 定义后）——__ssplatSwapConfig
        }
        // 数据页相机：移除 settings 中的 cameras[0].initial（云冈数据的位姿，与测试数据无关），
        // 让官方回落到 createFrameCamera(bbox)——自动把相机放到 T0 模型包围盒外、
        // target 精确对准模型中心（官方取景逻辑，随数据自适应，无需硬编码坐标）。
        // 注意：官方 main 调用脚本在 DOMContentLoaded 时 await window.sse.settings，
        // 本脚本（body 末尾的 module）先于 DOMContentLoaded 执行，改写 Promise 来得及。
        if (window.sse && window.sse.settings && typeof window.sse.settings.then === 'function') {
            window.sse.settings = window.sse.settings.then((s) => {
                try {
                    if (s && Array.isArray(s.cameras)) s.cameras = [];
                } catch (e) {
                    // 静默：settings 改写失败不影响加载
                }
                return s;
            });
        }
    }

    // ---------- 手机端游戏控制（用户要求：手机进入页面激活游戏控制，转盘移动，其他移动方式全部注销） ----------
    // 手机端（安卓/华为/苹果）默认激活 gamingControls（虚拟摇杆转盘显示在左下角），
    // 只通过转盘控制移动；单指旋转、双指平移/缩放、点击行走全部禁用（bundle 补丁）。
    // ?gc=0 可关闭游戏控制（回落官方 touch 手势）；?walk=1 可临时启用点击行走（逃生）。
    // 注意：IS_MOBILE 在下文才判定，这里只存参数意图，下方判定后统一写入 __ssplatGamingForce。
    const gcEnabledIntent = gcParam !== '0';
    const walkEnabledIntent = walkParam === '1';

    // ---------- 手机模式判定（最终值，供合并/流式模式共用） ----------
    // 优先级：
    //   - ?mobile=1 → 强制手机模式（即使桌面 UA / 宽屏）；
    //   - ?mobile=0 → 强制桌面模式（即使手机 UA / 窄屏）；
    //   - 未指定 → 自动检测（isMobile()：手机 UA 或窄屏）。
    // 手机模式下数据指向 sog_data_mobile/：
    //   - iOS（IS_IOS，任务①白屏修复）→ 单文件 mobile.compressed.ply（无 WebP/zip 依赖，
    //     iOS 16 全版本兼容）；任何 mode 参数均回落 PLY（见 FORCE_IOS_PLY 说明）；
    //   - 安卓/鸿蒙 → 流式（默认，性能最优）与 mobile.sog（?mode=single 回退）；
    // 桌面模式行为完全不变（仍加载 sog_data/ 完整版、预算 12M、体素 0.3m）。
    const FORCE_MOBILE = mobileParam === '1';
    const FORCE_DESKTOP = mobileParam === '0';
    const IS_MOBILE = FORCE_MOBILE || (!FORCE_DESKTOP && isMobile());
    // iOS 设备（仅在手机模式下生效；?mobile=0 强制桌面时不生效）
    const IS_IOS = isIOsDevice();
    // iOS 强制走单文件 PLY：iOS 无法可靠加载 SOG（WebP 纹理 + zip 解压依赖，
    // DecompressionStream 需 Safari 16.4+，WebP 纹理解码在 iOS 有兼容风险），
    // 与其部分失败不如统一走官方推荐的 compressed.ply（SH0，无纹理解码）。
    const FORCE_IOS_PLY = IS_MOBILE && IS_IOS;

    // ---------- 安卓手机双指手势屏蔽（需求：所有安卓双指平移/缩放有 bug，需屏蔽） ----------
    // 安卓/华为/鸿蒙 UA（android / huawei / harmonyos）→ 设置 __ssplatHuaweiNoPinch=true，
    // bundle 补丁在 TouchDevice.update 中强制 double=0（双指平移/缩放失效），
    // 只保留：单指旋转 + 单击行走（点击移动）。?pinch=1 可强制开启双指（逃生通道）。
    // [手机游戏控制] 手机端（安卓/华为/苹果）激活游戏控制（虚拟摇杆）+ 关闭点击行走；
    // 桌面不受影响（gamingForce=false，walkEnabled 保持官方）。?gc=0 / ?walk=1 逃生。
    window.__ssplatGamingForce = IS_MOBILE && gcEnabledIntent;
    window.__ssplatWalkEnabled = IS_MOBILE ? walkEnabledIntent : walkParam !== '0';
    // [手机游戏控制] 所有手机（安卓/华为/苹果）都屏蔽双指平移/缩放：
    // 移动只由虚拟摇杆（gamingControls）驱动；?pinch=1 可强制恢复双指（逃生通道）。
    const IS_MOBILE_PINCH_OFF = IS_MOBILE;
    window.__ssplatHuaweiNoPinch = IS_MOBILE_PINCH_OFF && pinchParam !== '1';
    if (IS_MOBILE_PINCH_OFF && pinchParam === '1') {
        window.__ssplatHuaweiNoPinch = false;
    }

    // 设备分类（需求：网页支持 WASD 行走，手机支持点选行走，分类别对待）：
    //   - 'desktop' → 桌面网页：WASD 行走（fly 第一人称 + 鼠标转向，官方 ModeShortcuts，
    //      补丁侧显式按此设备分支；鼠标点击保持官方聚焦）；
    //   - 'mobile'  → 手机：触摸点选行走（_walkToPickedPosition，?walk=0 关闭回落聚焦），
    //      触摸时禁用 WASD（官方 inputMode=touch 已挡，补丁侧再按此设备双保险）；
    //   - 与数据选型共用 IS_MOBILE 判定（?mobile=1/0 可强制覆盖），保证操控分支与加载分支一致。
    window.__ssplatDevice = IS_MOBILE ? 'mobile' : 'desktop';

    // 坐标翻转开关（默认关闭官方 Z 翻转 180°）：
    //   - 无参数 / ?flip=0 → window.__ssplatFlip 为 undefined/false → 补丁 z=0（仅 Rx(-90°) 轴修正）；
    //   - ?flip=1         → window.__ssplatFlip === true → 补丁 z=180（临时启用官方 Z 翻转，调试逃生通道）。
    // 该全局标志会被补丁后的 dist/index.js 在创建每个 gsplat 实体时读取（单文件/合并均生效）。
    window.__ssplatFlip = flipParam === '1';

    // 体素碰撞分辨率开关（需求①：分辨率可调）：?voxres=0.3（默认 0.3m，建议 0.25~0.4m）。
    // 在 bundle 的 SplatVoxelCollision 创建前写入 window.__ssplatVoxelResolution，
    // 构建器创建实例时读取（越界值回退默认 0.3）。
    if (voxresParam) {
        const parsed = Number.parseFloat(voxresParam);
        if (Number.isFinite(parsed) && parsed >= 0.1 && parsed <= 2) {
            window.__ssplatVoxelResolution = parsed;
        }
    }
    // 手机模式体素分辨率默认调粗到 0.5m（桌面默认 0.3m）：手机 CPU 更弱，粗分辨率使
    // 体素构建耗时/内存大幅下降（约 22% 体素数），碰撞精度仍足以「不能穿模型」；
    // 空气墙（基于合并包围盒）与分辨率无关，作为最终兜底逻辑不变。
    // 用户显式 ?voxres= 参数优先（上面已处理），这里仅在手机模式且未显式指定时生效。
    if (IS_MOBILE && !voxresParam) {
        window.__ssplatVoxelResolution = MOBILE_DEFAULT_VOXEL_RESOLUTION;
    }

    const currentFile = FALLBACK_FILES.includes(fileParam) ? fileParam : DEFAULT_FILE;
    // 查看模式语义 v2（BugFix：桌面默认轻量数据；?mode=merge 显式完整版）：
    //   - 默认（无 mode 参数）：桌面与手机统一走**轻量数据**（手机版 Streamed SOG
    //     ./sog_data_mobile/streamed/lod-meta.json，12MB LOD 渐进，首屏秒开）；
    //     iOS 例外见 FORCE_IOS_PLY（回落 mobile.compressed.ply）。
    //   - ?mode=merge：强制完整版（桌面 14 个 .sog 同一场景，74MB，带宽足够时用；
    //     iOS 因 SOG 不可解析仍回落 PLY；安卓/鸿蒙无手机版合并数据，回落手机版流式）。
    //   - ?mode=single：单文件模式（桌面加载 ?file= 指定文件，默认 0_0.sog；
    //     手机 mobile.sog；iOS mobile.compressed.ply）。
    //   - ?mode=streamed：显式流式（桌面 ./streamed/ 完整版流式 130MB，需高带宽；
    //     手机手机版流式；iOS 回落 PLY）。
    //   - ?mobile=1 强制手机语义（轻量）；?mobile=0 强制桌面语义（默认仍轻量，
    //     仅叠加 ?mode=merge 才加载完整版）。
    // 注意：合并模式下 file= 参数仍被解析（currentFile 保留），但合并加载固定使用
    // FALLBACK_FILES 全量清单，file= 不会改变合并内容；仅切回单文件模式时生效。
    const isMergeMode = !FORCE_IOS_PLY && !IS_MOBILE && modeParam === 'merge';
    // 非默认数据集：强制单文件模式（忽略 mode 语义；仅默认数据集才走合并/流式）
    const isStreamedMode = !FORCE_IOS_PLY && !isMergeMode && modeParam !== 'single' && !IS_DATA_PAGE;

    // 合并模式状态（供 firstFrame 钩子判断首帧到来时是否已全部加载完成）
    let mergeLastInfo = null;
    let mergeLoaded = false;
    let mergeDoneInfo = null;

    // ---------- 2. 改写官方配置（必须在 main() 启动前完成） ----------

    const config = window.sse && window.sse.config;

    // ---------- ?debug=1 诊断状态（仅 DEBUG 模式展示；默认静默不建 DOM） ----------
    // 记录数据链路各环节状态：contentUrl / renderer / budget / 加载成败 / 首帧 / 合并 /
    // 体素。各分支在改写 config 时同步更新；诊断面板渲染函数在文件末尾（仅 DEBUG 时创建）。
    const debugState = {
        contentUrl: (config && config.contentUrl) || '(未设置)',
        renderer: (config && config.renderer) || '(默认)',
        budget: (config && Number.isFinite(config.budget)) ? config.budget : '(默认)',
        loadState: '初始化',
        loadMessage: '',
        firstFrame: false,
        merge: '',
        voxel: ''
    };

    if (!config) {
        // 静默：未找到 window.sse.config 时不再输出任何日志（需求：移除全部日志输出），
        // 场景保持官方空场景，不产生额外副作用；如需诊断请外部覆写 window.__ssplatOnStatus。
    } else if (isStreamedMode) {
        // —— Streamed SOG 流式加载模式：加载 lod-meta.json，由 viewer 自动管理 LOD ——
        // 默认（无 mode 参数）桌面与手机统一走**轻量流式**（sog_data_mobile/streamed/，
        // 12MB LOD 渐进，首屏秒开，公网低带宽可快速显示）；?mode=streamed 桌面显式请求
        // 桌面版完整流式（./streamed/，130MB，需高带宽）。iOS 已由 FORCE_IOS_PLY 排除
        // （回落 mobile.compressed.ply）。
        const isDesktopFullStreamed = !IS_MOBILE && modeParam === 'streamed';
        const streamedUrl = isDesktopFullStreamed ? DESKTOP_STREAMED_URL : MOBILE_STREAMED_URL;
        if (IS_MOBILE) {
            // 手机端强制 WebGL2（WebGPU 在 iOS Safari/多数安卓不可用）；预算 0.6M 覆盖
            // 手机版 LOD0 全量约 50 万（?budget= 显式值时官方 config.budget 已为正数，尊重）
            config.renderer = 'webgl';
            if (!(Number.isFinite(config.budget) && config.budget > 0)) {
                config.budget = MOBILE_BUDGET_MILLIONS;
            }
            setStatus('手机版 Streamed SOG：WebGL 渲染 · 预算 ' + MOBILE_BUDGET_MILLIONS + 'M');
        } else if (isDesktopFullStreamed) {
            // 桌面 ?mode=streamed（完整版流式）：保留官方默认渲染器（WebGPU；公网 http 下
            // engine 的 createGraphicsDevice 自动追加 WebGL2 回退，渲染正常），
            // 预算保持 viewer 默认（4M），LOD 渐进按需加载
            setStatus('Streamed SOG 模式（桌面完整版）：默认渲染');
        } else {
            // 桌面默认轻量流式（BugFix：桌面默认不再加载 74MB 合并，改为轻量数据）：
            // 渲染器保持官方默认（WebGPU；http 下自动回退 WebGL2，见 createGraphicsDevice
            // deviceTypes 自动追加逻辑——WebGPU 不可用时依次回退 WebGL2/NULL）；
            // 预算 0.6M 覆盖手机版 LOD0 全量（?budget= 显式值优先）
            if (!(Number.isFinite(config.budget) && config.budget > 0)) {
                config.budget = MOBILE_BUDGET_MILLIONS;
            }
            setStatus('轻量 Streamed SOG（桌面默认）：默认渲染 · 预算 ' + MOBILE_BUDGET_MILLIONS + 'M');
        }

        config.contentUrl = streamedUrl;
        config.contents = fetch(streamedUrl);
        debugState.contentUrl = streamedUrl;
        debugState.renderer = config.renderer || '(默认)';
        debugState.budget = Number.isFinite(config.budget) ? config.budget : '(默认)';
        debugState.loadState = '加载中';
        // 删除 mergeFiles 字段，确保走官方单场景加载路径（而非 loadGsplats 合并加载）
        delete config.mergeFiles;
        config.contents.catch((err) => {
            debugState.loadState = '失败';
            debugState.loadMessage = 'Streamed SOG: ' + (err && err.message ? err.message : err);
            setStatus(
                'Streamed SOG 加载失败：' + (err && err.message ? err.message : err),
                'error'
            );
        });
    } else if (isMergeMode) {
        // —— 合并模式（?mode=merge 显式完整版，仅桌面执行）：把 14 个 .sog 全部交给
        // bundle 的 loadGsplats 依次加载 ——
        // config.mergeFiles 是自定义字段，由 build.mjs 注入的 loadGsplatOrMerge 识别：
        // 非空时走 loadGsplats（每个文件一个独立 gsplat 实体，挂到同一场景），
        // 否则回落到 loadGsplat（单文件）。每个实体都会应用相同的坐标翻转补丁。
        // 注意：isMergeMode 要求 !IS_MOBILE（桌面语义），因此本分支只在桌面（非手机）
        // 执行；手机模式下 ?mode=merge 回落手机版流式（不生成 14 个手机版 .sog，
        // 取舍见文件头第 3 点）；iOS 由 FORCE_IOS_PLY 排除（回落 PLY）。
        const mergeDir = DESKTOP_MERGE_DIR;
        config.mergeFiles = FALLBACK_FILES.map((file) => {
            const contentUrl = mergeDir + encodeURIComponent(file);
            return {
                contentUrl,
                contents: fetch(contentUrl)
            };
        });
        // 保留单文件字段（指向合并目录下的第一个文件），保证官方其它代码路径引用 config
        // 时不缺字段；复用 mergeFiles[0] 的同一 fetch Promise，避免重复下载首个文件
        config.contentUrl = mergeDir + encodeURIComponent(FALLBACK_FILES[0]);
        config.contents = config.mergeFiles[0].contents;
        debugState.contentUrl = config.contentUrl;
        debugState.renderer = config.renderer || '(默认)';
        debugState.budget = Number.isFinite(config.budget) ? config.budget : '(默认)';
        debugState.loadState = '加载中';
        config.contents.catch((err) => {
            debugState.loadState = '失败';
            debugState.loadMessage = FALLBACK_FILES[0] + ': ' + (err && err.message ? err.message : err);
            setStatus(
                '加载失败：' + FALLBACK_FILES[0] + '（' + (err && err.message ? err.message : err) + '）',
                'error'
            );
        });
        // 场景级 splat 预算（bundle 的 applyPerfSettings 会读取）：
        //   - 桌面模式：放宽到 12M，让 14 个完整版文件尽量同时可见；
        //   - 手机模式（防御分支，正常不会进入）：0.6M。
        // 若 URL 显式给出 ?budget= 则尊重用户显式值（config.budget 已为正数，跳过）。
        if (!(Number.isFinite(config.budget) && config.budget > 0)) {
            config.budget = IS_MOBILE ? MOBILE_BUDGET_MILLIONS : MERGE_BUDGET_MILLIONS;
        }
        // 合并进度/完成钩子（由 bundle 的 loadGsplats 在每文件完成后与全部完成后调用）
        window.__ssplatMergeProgress = (info) => {
            if (!info) return;
            mergeLastInfo = info;
            const fileName = (info.file || '').split('/').pop();
            debugState.merge = '进度 ' + info.index + '/' + info.total + '：' + fileName;
            setStatus('合并模式：正在加载全部 ' + info.total + ' 个文件（' + info.index + '/' + info.total + '）：' + fileName + ' …');
        };
        window.__ssplatMergeDone = (info) => {
            if (!info) return;
            mergeLoaded = true;
            mergeDoneInfo = info;
            const splatText = info.totalSplats > 0 ? ('共 ' + formatNumber(info.totalSplats) + ' 个 splat') : 'splat 数量未知';
            debugState.merge = '完成 ' + info.loaded + '/' + info.total + '（失败 ' + info.failed + '）· ' + splatText;
            debugState.loadState = info.loaded > 0 && info.failed === 0 ? '成功' : (info.loaded === 0 ? '失败' : '部分成功');
            if (info.loaded > 0 && info.failed === 0) {
                setStatus(
                    '合并模式：已加载 ' + info.loaded + '/' + info.total + ' 个文件（' + splatText + '）· 正在渲染…',
                    'ok'
                );
            } else {
                setStatus(
                    '合并模式：完成 ' + info.loaded + '/' + info.total + '，失败 ' + info.failed +
                    ' 个（' + splatText + '）',
                    info.failed > 0 && info.loaded === 0 ? 'error' : 'ok'
                );
            }
        };
    } else {
        // —— 单文件模式：加载 ?file= 指定文件（默认 0_0.sog）——
        // 手机模式下加载手机版单文件 mobile.sog（50 万 splat 降采样、排除 env，回退方案）；
        // iOS（任务①白屏修复）加载 mobile.compressed.ply（无 WebP/zip 依赖，全版本兼容）；
        // 桌面模式保持 sog_data/ 完整版（行为不变）；?file= 参数在桌面单文件模式下生效。
        const singleUrl = IS_DATA_PAGE
            ? (FORCE_IOS_PLY ? TEST_DATASET.ios : (IS_MOBILE ? TEST_DATASET.android : TEST_DATASET.desktop))
            : (FORCE_IOS_PLY
                ? MOBILE_IOS_URL
                : (IS_MOBILE ? MOBILE_SINGLE_URL : (DESKTOP_MERGE_DIR + encodeURIComponent(currentFile))));
        // [渐进加载] /new 全设备一致（含 iOS，非 ?full=1）：先展示轻量版（秒开），
        // 体素构建完成后由 __ssplatVoxelDone 回调触发 __ssplatSwapGsplat 后台加载
        // point_cloud.compressed.ply（完整版 chunked PLY，788.9 万 splat，128MB）替换。
        //   - 桌面/安卓：初始 point_cloud.mobile.sog（SOG 秒开）；
        //   - iOS：初始 point_cloud.mobile.compressed.ply（PLY，iOS 可解析）——
        //     完整版同样用 compressed.ply（chunked PLY 格式 iOS 可加载），故 swap 不排除 iOS。
        if (IS_NEW_PAGE && fullParam !== '1') {
            window.__ssplatSwapConfig = {
                url: './new_data/point_cloud.compressed.ply',
                done: false
            };
        }
        const singleLabel = IS_DATA_PAGE
            ? (IS_NEW_PAGE
                ? 'point_cloud' + (FORCE_IOS_PLY ? '（mobile.compressed.ply）' : (IS_MOBILE ? '（mobile.sog）' : '（完整版 .sog）'))
                : '测试数据T0（' + (FORCE_IOS_PLY ? 'compressed.ply' : 'mobile.sog') + '）')
            : (FORCE_IOS_PLY ? 'mobile.compressed.ply' : (IS_MOBILE ? 'mobile.sog' : currentFile));
        config.contentUrl = singleUrl;
        config.contents = fetch(singleUrl);
        debugState.contentUrl = singleUrl;
        debugState.renderer = config.renderer || '(默认)';
        debugState.budget = Number.isFinite(config.budget) ? config.budget : '(默认)';
        debugState.loadState = '加载中';
        // 手机端单文件同样强制 WebGL2 + 预算限制（与流式分支一致的性能基线）：
        //   - /new 页手机：与 PC 一致加载完整版（mobile.sog → compressed.ply 788.9 万），
        //     预算 2M（手机 GPU 上限，超出部分按需裁剪渲染，数据完整下载）；
        //   - 其他页面（含 iOS compressed.ply 50 万）：保持 0.6M 手机基线。
        if (IS_MOBILE) {
            config.renderer = 'webgl';
            if (!(Number.isFinite(config.budget) && config.budget > 0)) {
                config.budget = (IS_NEW_PAGE && !FORCE_IOS_PLY) ? 2 : MOBILE_BUDGET_MILLIONS;
            }
            debugState.renderer = config.renderer;
            debugState.budget = config.budget;
        }
        // 监听加载失败，用于状态输出（官方 loadGsplat 内部也会消费同一 Promise，互不影响）
        config.contents.catch((err) => {
            debugState.loadState = '失败';
            debugState.loadMessage = singleLabel + ': ' + (err && err.message ? err.message : err);
            setStatus(
                '加载失败：' + singleLabel + '（' + (err && err.message ? err.message : err) + '）',
                'error'
            );
        });
    }

    // ---------- 2.1 体素碰撞构建进度/完成钩子（由 bundle 的 SplatVoxelCollision 调用） ----------
    // 构建在场景加载完成后异步分批执行（rAF + 每帧 6ms 时间预算），状态仅流转到
    // window.__ssplatOnStatus（默认静默，不输出任何日志）。
    // 「正在读取 splat 数据」= SOG 纹理 CPU 读回阶段；「正在构建碰撞网格」= 体素化阶段。
    window.__ssplatVoxelProgress = (info) => {
        if (!info) return;
        const phase = info.phase === 'preparing' ? '正在读取 splat 数据' : '正在构建碰撞网格';
        const percent = typeof info.percent === 'number' ? info.percent : 0;
        debugState.voxel = phase + ' ' + percent + '%';
        setStatus('体素碰撞：' + phase + ' ' + percent + '%…');
    };
    window.__ssplatVoxelDone = (info) => {
        if (!info) return;
        const voxelText = '碰撞网格构建完成（' + formatNumber(info.solidVoxels || 0) + ' 实心体素 · 分辨率 ' +
            ((info.voxelResolution || 0.3).toFixed(2)) + 'm · 耗时 ' + (info.buildMs || 0) + 'ms）';
        debugState.voxel = voxelText;
        setStatus('场景加载完成 · ' + voxelText, 'ok');
    };

    // ---------- 2.2 splash 超时兜底（BugFix：加载失败/超时时封面不再常驻） ----------
    // 背景：若数据加载失败/超时（如公网低带宽加载大文件），window.firstFrame 永不触发，
    // 封面会一直遮挡页面（用户看到"海报 + 黑屏"，误以为无数据）。这里设置超时兜底：
    // 到达时限仍未首帧 → 自动隐藏封面（不再遮挡）+ 显示极简失败提示「加载失败，请刷新重试」
    // （提示仅在失败时创建，成功后不出现；非常驻 UI，符合「零自绘 UI」约束）。
    // 超时时长默认按模式区分（?splashtimeout=<秒> 仍可覆盖，如 ?splashtimeout=15）：
    //   - 流式/单文件模式（默认轻量数据 12~25MB）：180s。腾讯云轻量服务器公网带宽低
    //     （实测 .sog 下载约 80KB/s，nginx.conf 已注明），手机版流式数据完整下载需
    //     90~150s，旧版固定 30s 会在下载中途误判失败 → 隐藏封面 + 提示「加载失败」，
    //     用户刷新后重走下载依然超时 → 永远进不了展示页（"刷新完成后不进入展示页面"
    //     的根因，web/手机同源）。180s 覆盖低带宽完整下载，首帧（LOD 渐进可提前）到达
    //     即正常进入展示页；
    //   - 合并模式（?mode=merge，74MB 完整版，标称"高带宽用"）：600s（10 分钟）。
    //     74MB @ 80KB/s ≈ 16 分钟，600s 覆盖长尾；真实高带宽用户远早于此时限完成。
    // 超时触发时区分两类情况（BugFix：仍在下载 ≠ 失败，不得误报「加载失败」）：
    //   - debugState.loadState === '失败'（fetch 已被 .catch 标记，网络真错误）
    //     → 显示「加载失败，请刷新重试」+ 隐藏封面；
    //   - 仍在下载中（首帧未到但数据请求正常）→ 隐藏封面（封面不常驻遮挡，与旧版
    //     一致）+ 显示中性「正在加载…」提示，数据到齐首帧渲染后自动清除。
    // 实现说明：放置在 src/app.js（不重复注入 build.mjs 内联脚本），可解析 URL 参数、
    // 可被单测 mock（document/setTimeout 注入）；Node 单测环境下 unref 定时器不阻塞进程退出。
    let splashFirstFrameFired = false;
    let splashTimer = null;
    const splashTimeoutParam = params.get('splashtimeout');
    let splashTimeoutMs = isMergeMode ? 600000 : 180000;
    if (splashTimeoutParam) {
        const parsed = Number.parseFloat(splashTimeoutParam);
        if (Number.isFinite(parsed) && parsed >= 1) {
            splashTimeoutMs = Math.round(parsed * 1000);
        }
    }
    // 极简失败提示：仅在超时兜底触发时创建（成功后不出现；默认不创建任何 DOM）
    const showSplashFailHint = () => {
        try {
            if (typeof document === 'undefined') return;
            if (document.getElementById('__ssplatFailHint')) return;
            const hint = document.createElement('div');
            hint.id = '__ssplatFailHint';
            hint.textContent = '加载失败，请刷新重试';
            hint.style.cssText = [
                'position:fixed',
                'left:50%',
                'bottom:48px',
                'transform:translateX(-50%)',
                'z-index:2147483646',
                'background:rgba(8,10,14,0.85)',
                'color:#f2f2f2',
                'font:13px/1.5 system-ui,-apple-system,sans-serif',
                'padding:8px 16px',
                'border:1px solid rgba(255,255,255,0.25)',
                'border-radius:20px',
                'pointer-events:none',
                'white-space:nowrap'
            ].join(';');
            if (document.body && typeof document.body.appendChild === 'function') {
                document.body.appendChild(hint);
            }
        } catch (e) {
            // 静默：失败提示自身异常绝不影响主流程
        }
    };
    const hideSplashFailHint = () => {
        try {
            if (typeof document === 'undefined') return;
            const hint = document.getElementById('__ssplatFailHint');
            if (hint && hint.parentNode && typeof hint.parentNode.removeChild === 'function') {
                hint.parentNode.removeChild(hint);
            }
        } catch (e) {
            // 静默
        }
    };
    // 移除中性「正在加载…」提示（超时兜底在「仍在下载」时创建的，首帧到达后清除）
    const hideSplashLoadingHint = () => {
        try {
            if (typeof document === 'undefined') return;
            const hint = document.getElementById('__ssplatLoadingHint');
            if (hint && hint.parentNode && typeof hint.parentNode.removeChild === 'function') {
                hint.parentNode.removeChild(hint);
            }
        } catch (e) {
            // 静默
        }
    };
    // 首帧内部统一入口：标记已首帧、清除超时定时器、移除失败提示、隐藏封面。
    // 三个模式分支（流式/合并/单文件）的 firstFrame 都先调用它，保证行为一致。
    const onFirstFrameInternal = () => {
        splashFirstFrameFired = true;
        if (splashTimer) {
            clearTimeout(splashTimer);
            splashTimer = null;
        }
        hideSplashFailHint();
        hideSplashLoadingHint();
        if (typeof window.__ssplatCover === 'function') {
            window.__ssplatCover();
        }
        // 测试页：首帧渲染完成（封面淡出）瞬间直接瞬移到模型内部取景点，
        // 不再展示官方初始远景（远处总览）→ 从海报图片直接切换为模型内部视角。
        // voxelDone 的 300ms 延迟触发降级为兜底（已瞬移过则跳过，避免重复定位日志）。
        if (IS_DATA_PAGE && focusParam !== '0' && window.__ssplatTeleported !== true &&
            typeof window.__ssplatFocusBBoxCenter === 'function') {
            window.__ssplatTeleported = true;
            window.__ssplatFocusBBoxCenter();
        }
    };
    if (typeof document !== 'undefined' && typeof setTimeout === 'function') {
        splashTimer = setTimeout(() => {
            splashTimer = null;
            if (splashFirstFrameFired) return;
            const cover = document.getElementById('ssplatCover');
            if (!cover || cover.classList.contains('hidden')) return;
            // BugFix：区分「真失败」（fetch 报错）与「仍在下载」（低带宽大文件未到首帧）。
            // 旧版一律按失败处理，导致低带宽用户（腾讯云实测 80KB/s：手机版流式 12~25MB
            // 需 90~150s）在 30s 处被误报「加载失败」→ 刷新后重走下载再次超时 → 永远
            // 进不了展示页（"刷新完成后不进入展示页面"，web/手机同源）。
            // 仅 fetch 已失败才提示失败；仍在下载则隐藏封面（不常驻遮挡）+ 中性提示，
            // 数据到齐后 window.firstFrame 会调用 onFirstFrameInternal 清除该提示。
            if (debugState.loadState === '失败') {
                showSplashFailHint(); // 极简失败提示（仅网络真错误才创建；成功后不出现）
                if (typeof window.__ssplatCover === 'function') {
                    window.__ssplatCover(); // 自动隐藏封面（不再常驻遮挡）
                }
                debugState.loadMessage = '数据加载失败（' + Math.round(splashTimeoutMs / 1000) + 's 内未完成），已自动隐藏封面';
            } else {
                // 仍在加载（首帧未到但 fetch 未报错）：隐藏封面但显示中性「正在加载…」，
                // 避免海报常驻遮挡；数据下载完成后首帧触发自动清除提示。
                if (typeof window.__ssplatCover === 'function') {
                    window.__ssplatCover();
                }
                const loadingHint = document.getElementById('__ssplatLoadingHint');
                if (!loadingHint && typeof document.createElement === 'function') {
                    const hint = document.createElement('div');
                    hint.id = '__ssplatLoadingHint';
                    hint.textContent = '正在加载…';
                    hint.style.cssText = [
                        'position:fixed',
                        'left:50%',
                        'bottom:48px',
                        'transform:translateX(-50%)',
                        'z-index:2147483646',
                        'background:rgba(8,10,14,0.85)',
                        'color:#f2f2f2',
                        'font:13px/1.5 system-ui,-apple-system,sans-serif',
                        'padding:8px 16px',
                        'border:1px solid rgba(255,255,255,0.25)',
                        'border-radius:20px',
                        'pointer-events:none',
                        'white-space:nowrap'
                    ].join(';');
                    if (document.body && typeof document.body.appendChild === 'function') {
                        document.body.appendChild(hint);
                    }
                }
                debugState.loadMessage = '首帧超时（' + Math.round(splashTimeoutMs / 1000) + 's 未渲染完成）· 仍在加载，已自动隐藏封面';
            }
        }, splashTimeoutMs);
        // Node 单测环境：定时器不阻止进程退出（浏览器环境 unref 不存在，无副作用）
        if (splashTimer && typeof splashTimer.unref === 'function') {
            splashTimer.unref();
        }
    }

    // ---------- 3. 加载状态（firstFrame 钩子） ----------

    if (isStreamedMode) {
        window.firstFrame = () => {
            // 首帧渲染完成：统一隐藏加载封面（splash 淡出）+ 清除超时兜底定时器 + 移除失败提示
            onFirstFrameInternal();
            debugState.firstFrame = true;
            debugState.loadState = debugState.loadState === '失败' ? '失败' : '成功';
            setStatus('Streamed SOG 模式：首帧渲染完成', 'ok');
        };
    } else if (isMergeMode) {
        setStatus('合并模式：正在加载全部 ' + FALLBACK_FILES.length + ' 个文件（0/' + FALLBACK_FILES.length + '）…');
        window.firstFrame = () => {
            // 首帧渲染完成：统一隐藏加载封面（splash 淡出）+ 清除超时兜底定时器 + 移除失败提示
            onFirstFrameInternal();
            debugState.firstFrame = true;
            if (mergeLoaded && mergeDoneInfo) {
                // 全部加载完成后的首帧：显示最终结果
                debugState.loadState = mergeDoneInfo.failed > 0 && mergeDoneInfo.loaded === 0 ? '失败' : '成功';
                const splatText = mergeDoneInfo.totalSplats > 0
                    ? ('共 ' + formatNumber(mergeDoneInfo.totalSplats) + ' 个 splat')
                    : 'splat 数量未知';
                setStatus(
                    '合并模式：已加载全部 ' + mergeDoneInfo.loaded + '/' + mergeDoneInfo.total +
                    ' 个文件（' + splatText + '）· 首帧渲染完成',
                    'ok'
                );
            } else if (mergeLastInfo) {
                // 首帧在加载中途到来：保留进度信息，附加说明
                setStatus(
                    '合并模式：正在加载全部 ' + mergeLastInfo.total + ' 个文件（' +
                    mergeLastInfo.index + '/' + mergeLastInfo.total + '）· 首帧已就绪 …'
                );
            }
        };
    } else {
        const singleLabel = FORCE_IOS_PLY ? 'mobile.compressed.ply' : (IS_MOBILE ? 'mobile.sog' : currentFile);
        setStatus('正在加载：' + singleLabel + ' …');
        window.firstFrame = () => {
            // 首帧渲染完成：统一隐藏加载封面（splash 淡出）+ 清除超时兜底定时器 + 移除失败提示
            onFirstFrameInternal();
            debugState.firstFrame = true;
            debugState.loadState = debugState.loadState === '失败' ? '失败' : '成功';
            setStatus('已加载：' + singleLabel + '（首帧渲染完成）', 'ok');
        };
    }

    // ---------- ?debug=1 诊断面板渲染（仅 DEBUG 模式创建 DOM，默认静默） ----------
    // 纯诊断用途：绝对定位小面板，显示 UA / 判定结果（IS_MOBILE/IS_IOS/FORCE_IOS_PLY）/
    // 当前 contentUrl / renderer / 数据加载状态 / window 错误收集（最多 5 条）。
    // 默认（无 ?debug=1）不创建任何 DOM、不输出任何日志 —— 不违背「日志移除」要求，
    // 这是显式诊断开关（用户 iPhone 打开 ?debug=1 截图即可定位白屏）。
    const ensureDebugPanel = () => {
        if (typeof document === 'undefined') return null;
        const existing = document.getElementById('__ssplatDebugPanel');
        if (existing) return existing;
        const panel = document.createElement('div');
        panel.id = '__ssplatDebugPanel';
        panel.style.cssText = [
            'position:fixed',
            'top:8px',
            'left:8px',
            'z-index:2147483646',
            'max-width:88vw',
            'max-height:62vh',
            'overflow:auto',
            'background:rgba(8,10,14,0.94)',
            'color:#e6e6e6',
            'font:11px/1.55 Menlo,Consolas,monospace',
            'padding:8px 10px',
            'border:1px solid #666',
            'border-radius:6px',
            'white-space:pre-wrap',
            'word-break:break-all',
            'pointer-events:auto'
        ].join(';');
        document.body.appendChild(panel);
        return panel;
    };
    const renderDebugPanel = () => {
        if (!DEBUG) return;
        const panel = ensureDebugPanel();
        if (!panel) return;
        const lines = [];
        lines.push('=== 云冈艺术 诊断 (?debug=1) ===');
        lines.push('UA: ' + (typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : ''));
        lines.push('IS_MOBILE=' + IS_MOBILE + '  IS_IOS=' + IS_IOS + '  FORCE_IOS_PLY=' + FORCE_IOS_PLY);
        lines.push('mode=' + (modeParam || '(默认)') + '  merge=' + isMergeMode + '  streamed=' + isStreamedMode +
            '  splashTimeout=' + Math.round(splashTimeoutMs / 1000) + 's');
        lines.push('contentUrl: ' + debugState.contentUrl);
        lines.push('renderer: ' + debugState.renderer + '  budget: ' + debugState.budget + 'M');
        lines.push('加载状态: ' + debugState.loadState + (debugState.loadMessage ? '  ' + debugState.loadMessage : ''));
        lines.push('首帧渲染: ' + (debugState.firstFrame ? '是' : '否'));
        if (debugState.merge) lines.push('合并: ' + debugState.merge);
        if (debugState.voxel) lines.push('体素: ' + debugState.voxel);
        lines.push('--- 错误收集 (' + (window.__ssplatDebugErrors || []).length + '/5) ---');
        (window.__ssplatDebugErrors || []).forEach((item) => {
            lines.push('[' + item.type + '] ' + item.text);
        });
        lines.push('--- 请将本面板截图发给开发者 ---');
        panel.textContent = lines.join('\n');
    };
    if (DEBUG) {
        renderDebugPanel();
        // 仅真实浏览器（document 存在）周期刷新；Node/mock 环境不启动定时器（避免事件循环挂起）
        if (typeof document !== 'undefined') {
            setInterval(renderDebugPanel, 500);
        }
    }

    // ---------- 受控日志（任务⑤：向外输出 log 日志，排查「相机被卡在房子外面」） ----------
    // 定义 window.__ssplatLog(tag, msg)：全局受控日志函数，供页面逻辑与 bundle 补丁
    // （空气墙钳制 / orbit 体素推出 / 相机周期位置）共同调用，输出带 [SSPLAT-LOG][tag] 前缀。
    // 输出策略：
    //   - ?log=1   → 始终输出（用户排查时显式开启，可覆盖页面开关状态）；
    //   - ?log=0   → 始终静默（显式关闭，默认页保持无日志的旧行为）；
    //   - 未指定   → 数据页（/test、/new）默认输出（用户要求：输出旋转角度/相机定位日志），
    //     默认页（/）静默（保持旧行为）。
    // 注：本文件定义的 __ssplatLog 会覆盖 bundle 注入的兜底版本（app.js 后执行），
    // 行为统一由这里控制；bundle 补丁通过 typeof window.__ssplatLog 防御调用。
    window.__ssplatLogEnabled = logParam === '1' || (logParam !== '0' && IS_DATA_PAGE);
    window.__ssplatLog = (tag, msg) => {
        try {
            if (window.__ssplatLogEnabled !== true) return;
            // [控制台输出] 用户要求输出 log（旋转角度/相机定位）：?log=1 或数据页默认开启时打印
            if (typeof console !== 'undefined' && console.log) {
                console.log('[SSPLAT-LOG][' + tag + '] ' + msg);
            }
        } catch (e) { /* 静默：日志自身异常绝不影响主流程 */ }
    };
    // 关键节点日志（页面侧）：
    if (window.__ssplatLogEnabled) {
        window.__ssplatLog('app', '页面初始化 mode=' + (modeParam || '(默认)') +
            ' testPage=' + IS_TEST_PAGE + ' mobile=' + IS_MOBILE + ' ios=' + IS_IOS +
            ' contentUrl=' + debugState.contentUrl);
        window.__ssplatLog('device', '设备分类=' + window.__ssplatDevice +
            ' 操控方式=' + (window.__ssplatDevice === 'mobile' ? '点击行走(点选)' : 'WASD 行走(飞行+鼠标转向)'));
    }
    // 体素构建完成钩子（bundle 构建完成后调用）：输出构建结果（实心体素数/分辨率/耗时）
    if (typeof window.__ssplatVoxelDone === 'function') {
        const _prevVoxelDone = window.__ssplatVoxelDone;
        window.__ssplatVoxelDone = (info) => {
            try {
                if (info && info.solidVoxels !== undefined) {
                    window.__ssplatLog('voxel', '构建完成 solid=' + info.solidVoxels +
                        ' res=' + (info.voxelResolution !== undefined ? info.voxelResolution : '?') +
                        ' 耗时=' + (info.buildMs !== undefined ? Math.round(info.buildMs) + 'ms' : '?'));
                }
            } catch (e) { /* 静默 */ }
            if (typeof _prevVoxelDone === 'function') _prevVoxelDone(info);
            // 数据页：体素构建完成（场景/空气墙/相机就绪）后输出「旋转角度 + 相机定位」日志。
            // 延迟 500ms 确保相机已完成官方取景定位；?log=1 或数据页默认开启时打印到控制台。
            if (IS_DATA_PAGE && typeof setTimeout === 'function') {
                setTimeout(() => {
                    // —— 旋转角度：期望值（URL 参数/页面默认） + 实体实际欧拉角 ——
                    window.__ssplatLog('rot', '期望旋转 rx=' + window.__ssplatTestX + ' ry=' + window.__ssplatTestY + ' rz=' + window.__ssplatTestZ);
                    try {
                        const _ent = (window.__ssplatEntities && window.__ssplatEntities[0]) || null;
                        if (_ent && typeof _ent.getLocalEulerAngles === 'function') {
                            const _e = _ent.getLocalEulerAngles();
                            window.__ssplatLog('rot', '实体欧拉角 x=' + _e.x.toFixed(2) + ' y=' + _e.y.toFixed(2) + ' z=' + _e.z.toFixed(2));
                        } else {
                            window.__ssplatLog('rot', '实体未就绪或 getLocalEulerAngles 不可用');
                        }
                    } catch (e2) {
                        window.__ssplatLog('rot', '读取实体欧拉角失败：' + (e2 && e2.message ? e2.message : e2));
                    }
                    // —— 模型高度：实体世界包围盒（含 rx/rz 旋转）的 minY / maxY / 总高度 ——
                    // 手动用世界矩阵（Mat4.data 列主序）变换包围盒 8 个角点求世界 Y 范围。
                    try {
                        const _ent2 = (window.__ssplatEntities && window.__ssplatEntities[0]) || null;
                        if (_ent2 && _ent2.gsplat && _ent2.gsplat.customAabb && typeof _ent2.getWorldTransform === 'function') {
                            const _aabb = _ent2.gsplat.customAabb;
                            const _m = _ent2.getWorldTransform().data;
                            const _c = _aabb.center;
                            const _h = _aabb.halfExtents;
                            let _minY = Infinity, _maxY = -Infinity;
                            for (let _i = 0; _i < 8; _i++) {
                                const _lx = _c.x + ((_i & 1) ? _h.x : -_h.x);
                                const _ly = _c.y + ((_i & 2) ? _h.y : -_h.y);
                                const _lz = _c.z + ((_i & 4) ? _h.z : -_h.z);
                                const _wy = _m[1] * _lx + _m[5] * _ly + _m[9] * _lz + _m[13];
                                if (_wy < _minY) _minY = _wy;
                                if (_wy > _maxY) _maxY = _wy;
                            }
                            window.__ssplatLog('model', '包围盒 minY=' + _minY.toFixed(3) + ' maxY=' + _maxY.toFixed(3) +
                                ' 高度=' + (_maxY - _minY).toFixed(3));
                        } else {
                            window.__ssplatLog('model', '实体包围盒未就绪（gsplat/customAabb 不可用）');
                        }
                    } catch (e4) {
                        window.__ssplatLog('model', '读取模型高度失败：' + (e4 && e4.message ? e4.message : e4));
                    }
                    // —— 相机定位：position / height / angles / distance / fov / mode ——
                    try {
                        if (typeof window.__ssplatGetCameraState === 'function') {
                            const _cs = window.__ssplatGetCameraState();
                            if (_cs) {
                                window.__ssplatLog('cam', 'position=(' + _cs.position.map((v) => v.toFixed(3)).join(', ') +
                                    ') height=' + _cs.position[1].toFixed(3) +
                                    ' angles=(' + _cs.angles.map((v) => v.toFixed(2)).join(', ') +
                                    ') distance=' + (_cs.distance !== undefined ? _cs.distance.toFixed(2) : '?') +
                                    ' fov=' + (_cs.fov !== undefined ? _cs.fov.toFixed(1) : '?') +
                                    ' mode=' + _cs.mode);
                            } else {
                                window.__ssplatLog('cam', 'getCameraState 返回空（相机未就绪）');
                            }
                        } else {
                            window.__ssplatLog('cam', 'window.__ssplatGetCameraState 未定义（相机日志补丁未生效？）');
                        }
                    } catch (e3) {
                        window.__ssplatLog('cam', '读取相机状态失败：' + (e3 && e3.message ? e3.message : e3));
                    }
                    // —— [渐进加载] 轻量版已展示（体素构建完成）→ 后台下载完整版并替换 ——
                    // 桌面 /new 默认先加载 mobile.sog（秒开），这里触发 __ssplatSwapGsplat
                    // 加载 point_cloud.sog（完整版）并替换旧实体，保证最终效果。
                    // 本地磁盘秒下（几乎无感）；服务器公网 4-5 分钟下载期间用户先看轻量版。
                    if (typeof window !== 'undefined' && window.__ssplatSwapConfig &&
                        !window.__ssplatSwapConfig.done && typeof window.__ssplatSwapGsplat === 'function') {
                        window.__ssplatSwapConfig.done = true;
                        window.__ssplatLog('swap', '轻量版已展示，开始后台加载完整版 ' + window.__ssplatSwapConfig.url + ' …');
                        setTimeout(() => {
                            window.__ssplatSwapGsplat(window.__ssplatSwapConfig.url);
                        }, 800);
                    }
                }, 500);
            }
            // 数据页：体素构建完成（场景/空气墙就绪）后定位相机到目标位置。
            // 兜底：首帧已瞬移（__ssplatTeleported=true）则跳过（防重复定位）。
            if (IS_DATA_PAGE && focusParam !== '0' && window.__ssplatTeleported !== true &&
                typeof window.__ssplatFocusBBoxCenter === 'function' && typeof setTimeout === 'function') {
                setTimeout(() => window.__ssplatFocusBBoxCenter(), 300);
            }
        };
    }
    // 数据页：删除官方「进入场景相机跳转动画」（frame 事件不再 startTransition，
    // 直接落位；/test、/new 最终位姿由 __ssplatFocusBBoxCenter 瞬移接管）。
    // 默认页保持官方动画。
    if (IS_DATA_PAGE) {
        window.__ssplatFrameNoTransition = true;
    }
})();

    // 调试按钮条已按用户要求移除（碰撞/编辑开关不再显示；相关逻辑一并移除）
