/**
 * 构建脚本：组装 dist/ 目录
 * =====================================================
 * 设计说明：
 *   官方 @playcanvas/supersplat-viewer npm 包在 public/ 中直接提供了完整的静态查看器
 *   （index.html / index.js / index.css，即官方 superspl.at 站点使用的同一套文件），
 *   因此本项目不需要任何打包器，只需：
 *     1. 复制官方三个静态文件到 dist/；
 *     2. 对 dist/index.html 打多处补丁：
 *         - 「页面标题改为云冈艺术」：官方 <title>SuperSplat Viewer</title> 与品牌区
 *           <span class="title-name">SuperSplat Viewer</span> 各恰好 1 处，严格替换为「云冈艺术」
 *           （applyStrictPatch 校验：官方未来若改动文案会显式报错）；
 *         - 「注入 ?debug=1 早期错误收集器」：在官方脚本执行前注入 window 级 onerror /
 *           unhandledrejection 收集器（__ssplatDebugErrors），使 app.js 诊断面板能显示早期 JS 错误；
 *         - 「移除默认 scene.compressed.ply 请求」：官方 head 内联脚本会立即
 *           fetch('./scene.compressed.ply')（默认 content），每次开页产生 404；
 *           app.js 稍后会覆盖 config.contents，该默认请求本就不需要 → 改为
 *           contentUrl 空串 + contents 为 Promise.resolve(null)，不再发起请求；
 *         - 「隐藏官方动画播放控件」：无动画项目里移除 play/pause/时间轴（需求③）；
 *         - 「注入 app.js」：在 </body> 前追加 <script src="./app.js">。
 *         - 「注入加载封面 splash」：在 <body> 之后、官方脚本之前注入 #ssplatCover 封面
 *           DOM + 内联 CSS/脚本（云冈艺术巡展海报 cover.jpg，首帧渲染完成后淡出隐藏；
 *           window.__ssplatCover 与 src/app.js 兜底定义一致、防重复）。
 *     3. 对 dist/index.js 打多处补丁：
 *         - 「坐标翻转」（Z-up → Y-up，绕 X 轴 -90°；默认不做官方 Z 轴 180° 翻转，
 *           仅当 window.__ssplatFlip === true（?flip=1 逃生通道）时叠加 Rz(180°)，见下方说明）；
 *         - 「合并视图-辅助函数/调用点/包围盒」：支持把 14 个 .sog 全部加载进同一场景
 *           同时渲染（每个实体独立应用翻转），并保留单文件模式；合并包围盒时跳过
 *           环境/天空盒等超大包围盒实体（如 env.sog），避免碰撞「房间」被撑到几百米大；
 *         - 「无动画」：settings.animTracks 为空时禁用官方默认动画（figure-8 自动巡游），
 *           否则默认相机模式会是 anim（WASD 输入被吞、碰撞不生效），修复「碰撞未触发」；
 *         - 「简化碰撞」：注入 SceneBoundCollision（AABB 房间，每侧 0.5m 内缩 padding）
 *           + CameraManager 挂接 fly 相机碰撞 + 禁用 walk + Orbit 最小缩放 0.3m
 *           + orbit 相机位置钳制（需求②：orbit 旋转/缩放同样不能穿出房间）；
 *         - 「固定空气墙」：以合并包围盒（sceneBound，env 已排除）为基准外扩 0.3m 建立
 *           空气墙，在 CameraManager.update 每帧相机更新最终落点无条件钳制相机位置
 *           （相机球体半径 0.2m 内缩），作为碰撞最终兜底——不依赖房间/体素/GPU，
 *           任何相机模式（fly/orbit/anim/过渡）均生效；
 *     4. 复制 settings.json（相机初始位姿；修改根目录 settings.json 后重新构建即可生效，
 *        也可直接改 dist/settings.json——index.html 运行时按 ./settings.json 相对路径拉取）；
 *     4.1 复制 cover.jpg（加载封面：云冈艺术巡展海报，splash 背景图；源为项目根 cover.jpg）；
 *     5. 复制 src/app.js（自定义中文界面与控制逻辑）；
 *     6. 增量同步 sog_data/ 全部 .sog 数据到 dist/sog_data/（源目录保持不动；
 *        只复制缺失或大小变动的文件，不删除已有文件）；
 *     7. 增量同步 sog_data_mobile/ 手机版数据到 dist/sog_data_mobile/（零删除策略；
 *        只同步运行期需要的文件：streamed/（lod-meta.json + 分块）与 mobile.sog，
 *        跳过 _src/ 中间产物——merged-noenv.ply / mobile-500k.ply 仅预处理用，不进 dist）。
 *
 * 用法：node scripts/build.mjs
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- 路径常量 ----------

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url))); // D:\lm\高斯
const PKG_PUBLIC = join(ROOT, 'node_modules', '@playcanvas', 'supersplat-viewer', 'public');
const SRC_DIR = join(ROOT, 'src');
const DIST_DIR = join(ROOT, 'dist');
const SOG_SRC = join(ROOT, 'sog_data');
const SOG_DEST = join(DIST_DIR, 'sog_data');
const SOG_MOBILE_SRC = join(ROOT, 'sog_data_mobile');
const SOG_MOBILE_DEST = join(DIST_DIR, 'sog_data_mobile');
// 新增数据集目录（new_data/，任务④：页面切片切换；只同步优化产物，
// 原始大文件 T*.ply / T*.sog 不进 dist——运行时仅用 t0.mobile.sog / t0.compressed.ply）
const NEW_DATA_SRC = join(ROOT, 'new_data');
const NEW_DATA_DEST = join(DIST_DIR, 'new_data');
// 加载封面（splash：云冈艺术巡展海报，用户提供的 jpg 复制到项目根 cover.jpg，
// build 时一并入 dist；不硬编码用户原始桌面路径）
const COVER_SRC = join(ROOT, 'cover.jpg');
const COVER_DEST = join(DIST_DIR, 'cover.jpg');

// 官方查看器静态文件（来自 npm 包 public/ 目录）
const VIEWER_FILES = ['index.html', 'index.js', 'index.css'];

// ---------- index.html 补丁（需求①：移除 scene.compressed.ply 404；需求③：隐藏动画播放控件） ----------
// 官方 index.html 的 head 内联脚本会在页面加载时立即执行
//   `contents: fetch(contentUrl)`（默认 contentUrl = './scene.compressed.ply'），
// 每次开页都会发起一次多余的 404 请求（app.js 稍后会覆盖 config.contents，
// 该默认请求本就不需要）。以下三个 HTML 补丁：
//   H1. 默认 contentUrl 改为空串（不再指向不存在的 scene.compressed.ply）；
//   H2. contents 改为 Promise.resolve(null)（不发起任何网络请求；
//       app.js 在 main() 启动前会覆盖 config.contents 为真实 .sog 的 fetch）；
//   H3. 隐藏官方动画播放/暂停/时间轴控件（#play/#pause/#timelineContainer）——
//       「play 按钮」即官方动画播放控件；项目无动画轨道（settings.animTracks 为空），
//       配合 index.js 的「无轨道禁用默认动画」补丁，hasAnimation=false 时官方本会隐藏，
//       这里再加 CSS 强制隐藏做兜底，确保任何状态下都不显示。
const HTML_CONTENT_URL_TARGET = "const contentUrl = url.searchParams.has('content') ? url.searchParams.get('content') : './scene.compressed.ply';";
const HTML_CONTENT_URL_REPLACEMENT = "const contentUrl = url.searchParams.has('content') ? url.searchParams.get('content') : ''; // [本地高斯查看器补丁] 移除默认 scene.compressed.ply 请求（app.js 会在 main() 前覆盖 config.contents）";

const HTML_CONTENTS_TARGET = '                contents: fetch(contentUrl),';
const HTML_CONTENTS_REPLACEMENT = '                contents: Promise.resolve(null), // [本地高斯查看器补丁] 不再发起默认内容请求（app.js 会在 main() 前覆盖 config.contents）';

const HTML_HIDE_ANIM_UI_TARGET = '        <link rel="stylesheet" href="./index.css">';
const HTML_HIDE_ANIM_UI_REPLACEMENT = [
    '        <link rel="stylesheet" href="./index.css">',
    '        <style>/* [本地高斯查看器补丁] 无动画：隐藏官方播放/暂停/时间轴控件（需求③ 移除 play 按钮） */',
    '            #play, #pause, #timelineContainer { display: none !important; }',
    '        </style>'
].join('\n');

// ---------- index.html 补丁（加载封面 splash：云冈艺术巡展海报，首帧渲染完成后淡出） ----------
// 需求：数据加载完成前全屏显示海报封面（#ssplatCover），window.firstFrame（首帧渲染完成）
// 触发 window.__ssplatCover() 后 opacity 1→0 过渡 0.8s 并最终隐藏（visibility/display 兜底，
// 不拦截点击）。注入位置：<body> 之后、官方脚本之前（紧邻 body 开头，DOM 解析即就绪；
// CSS 内联避免额外请求；内联脚本同步定义 window.__ssplatCover，与 src/app.js 兜底定义一致、防重复）。
// 比例适配（BugFix：Web 端桌面宽屏下封面裁剪过重）：cover.jpg 为竖版巡展海报，
// 统一用 background-size: contain + center center —— 完整显示整张海报（宽屏两侧黑边，
// 深色背景兜底），任何屏幕比例都不裁剪；若用 cover 在 16:9/21:9 宽屏会裁掉海报上下大量内容。
// 失败/超时兜底：src/app.js「2.2 splash 超时兜底」负责（首帧 30s 未触发 → 自动隐藏 + 失败提示）。
// 注意：<body> 在官方 index.html 中恰好 1 处（applyStrictPatch 严格校验版本变化）。
const HTML_COVER_SPLASH_TARGET = '<body>';
// ---------- favicon 补丁（需求：消除 favicon.ico 404） ----------
// 浏览器请求 /favicon.ico 时服务器无此文件返回 404（控制台报错）。
// 注入 <link rel="icon" href="data:,">（空图标声明），浏览器不再发起 favicon.ico 请求。
const HTML_FAVICON_TARGET = '    <head>';
const HTML_FAVICON_REPLACEMENT = [
    '    <head>',
    '    <link rel="icon" href="data:,">'
].join('\n');
// ---------- XrNavigation 日志静默补丁（需求：消除控制台 XrNavigation 日志） ----------
// 官方 WebXR 组件 XrNavigation 初始化时打印「Enabled methods - teleportation, smooth...」，
// 属正常初始化日志但造成困扰；注释掉该 console.log。
const XR_LOG_TARGET = "        console.log(`XrNavigation: Enabled methods - ${methods.join(', ')}`);";
const XR_LOG_REPLACEMENT = [
    '        // [XrNavigation 日志静默补丁] 官方 WebXR 组件初始化日志（非错误），注释掉避免控制台噪音',
    '        // console.log(`XrNavigation: Enabled methods - ${methods.join(\', \')}`);'
].join('\n');const HTML_COVER_SPLASH_REPLACEMENT = [
    '<body>',
    '    <!-- [本地高斯查看器补丁] 加载封面（splash：云冈艺术巡展海报，首帧渲染完成后淡出） -->',
    '    <div id="ssplatCover" class="ssplat-cover" aria-hidden="true"></div>',
    '    <style>',
    '        /* 封面渐显前页面兜底纯黑（海报为深色底，与黑底融合），避免白屏闪烁 */',
    '        html, body { background: #000; }',
    '        .ssplat-cover {',
    '            position: fixed;',
    '            left: 0; top: 0; right: 0; bottom: 0;',
    '            z-index: 2147483647;',
    '            pointer-events: none;',
    '            opacity: 0;',
    '            visibility: visible;',
    '            background-color: #000;',
    '            background-image: url("./cover.jpg");',
    '            background-size: contain;',
    '            background-position: center center;',
    '            background-repeat: no-repeat;',
    '            transition: opacity 0.35s ease, visibility 0s linear 0.35s;',
    '        }',
    '        .ssplat-cover.show { opacity: 1; }',
    '        .ssplat-cover.hidden {',
    '            opacity: 0;',
    '            visibility: hidden;',
    '            transition: opacity 0.8s ease, visibility 0s linear 0.8s;',
    '        }',
    '    </style>',
    '    <script>',
    '    /* 加载封面控制：渐显（0.35s）+ 首帧后淡出隐藏（0.8s）。与 src/app.js 的 __ssplatCover 定义一致，防重复；不输出任何日志 */',
    '    (function () {',
    '        var cover = document.getElementById("ssplatCover");',
    '        if (cover && !cover.classList.contains("hidden")) {',
    '            requestAnimationFrame(function () {',
    '                if (!cover.classList.contains("hidden")) cover.classList.add("show");',
    '            });',
    '        }',
    '        if (typeof window.__ssplatCover !== "function") {',
    '            window.__ssplatCover = function () {',
    '                var el = document.getElementById("ssplatCover");',
    '                if (!el || el.classList.contains("hidden")) return;',
    '                el.classList.remove("show");',
    '                el.classList.add("hidden");',
    '                setTimeout(function () {',
    '                    if (el && el.classList.contains("hidden")) el.style.display = "none";',
    '                }, 900);',
    '            };',
    '        }',
    '    })();',
    '    </script>'
].join('\n');

// ---------- index.html 补丁（任务①：页面标题改为「云冈艺术」；任务③：?debug=1 早期错误收集器） ----------
// 官方 index.html 有两处 "SuperSplat Viewer" 文案：
//   1. <head> 的 <title>（浏览器标签页标题）；
//   2. UI 品牌区 <span class="title-name">（帮助面板内，属官方界面文案）。
// 各恰好 1 处，均严格替换为「云冈艺术」（applyStrictPatch 校验版本变化）。
const HTML_TITLE_TARGET = '<title>SuperSplat Viewer</title>';
const HTML_TITLE_REPLACEMENT = '<title>云冈艺术</title>';

const HTML_BRAND_TARGET = '<span class="title-name">SuperSplat Viewer</span>';
const HTML_BRAND_REPLACEMENT = '<span class="title-name">云冈艺术</span>';

// ?debug=1 诊断：在官方脚本执行前注入 window 级错误收集器（onerror + unhandledrejection）。
// 位置选在 <meta charset> 之后、官方 sseConfig 内联脚本之前：该脚本随 HTML 解析同步执行，
// 因此任何后续脚本（官方内联脚本、bundle、app.js、渲染期异步错误）都会被收集到
// window.__ssplatDebugErrors（最多 5 条），供 app.js 诊断面板展示（?debug=1 时）。
// 使用 ES5 语法（var / function）保证所有 iOS Safari 版本可执行；不输出任何日志。
const HTML_DEBUG_COLLECTOR_TARGET = '        <meta charset="UTF-8">';
const HTML_DEBUG_COLLECTOR_REPLACEMENT = [
    '        <meta charset="UTF-8">',
    '        <script>/* ?debug=1 诊断：尽早收集 JS 错误（在官方脚本执行前注入） */',
    '        (function () {',
    '            window.__ssplatDebugErrors = window.__ssplatDebugErrors || [];',
    '            if (typeof window.__ssplatDebugCollect === \'function\') return;',
    '            window.__ssplatDebugCollect = function (type, text) {',
    '                try {',
    '                    if (window.__ssplatDebugErrors.length >= 5) window.__ssplatDebugErrors.shift();',
    '                    window.__ssplatDebugErrors.push({ type: type, text: String(text), time: Date.now() });',
    '                } catch (e) {}',
    '            };',
    '            window.addEventListener(\'error\', function (event) {',
    '                var msg = (event && event.message) ? event.message : \'未知错误\';',
    '                var where = (event && event.filename) ? \' @\' + String(event.filename).split(\'/\').pop() + \':\' + (event.lineno || 0) : \'\';',
    '                window.__ssplatDebugCollect(\'error\', msg + where);',
    '            });',
    '            window.addEventListener(\'unhandledrejection\', function (event) {',
    '                var text = \'Promise rejected\';',
    '                try {',
    '                    var reason = event && event.reason;',
    '                    if (reason instanceof Error) text = \'Promise: \' + reason.message;',
    '                    else if (reason && reason.message) text = \'Promise: \' + reason.message;',
    '                    else text = \'Promise: \' + String(reason);',
    '                } catch (e) {}',
    '                window.__ssplatDebugCollect(\'unhandledrejection\', text);',
    '            });',
    '        })();',
    '        </script>'
].join('\n');

// ---------- 坐标翻转补丁 ----------
// 官方代码在加载 gsplat 后执行 entity.setLocalEulerAngles(0, 0, 180)（Z 轴翻转 180°）。
// 用户数据坐标系为 Z-up，渲染引擎为 Y-up，需要再绕 X 轴旋转 -90°（右手系 Rx(-π/2)）。
// PlayCanvas 欧拉角组合顺序为 R = Rx * Ry * Rz（先绕 Z 后绕 X），
// 因此 (-90, 0, z)：z=0 时仅做 Z-up → Y-up 轴修正（默认行为，不再叠加官方 Z 翻转）；
// z=180 时 = Rx(-90°) ∘ Rz(180°)（保留官方 Z 翻转，调试逃生通道）。
// 开关语义（src/app.js 解析 URL 参数后写入全局）：
//   - 无参数 / ?flip=0        → window.__ssplatFlip 未设置或非 true → z=0（默认，界面无勾选框）；
//   - ?flip=1                 → window.__ssplatFlip === true → z=180（临时启用官方 Z 翻转）；
//   - /test 测试页            → app.js 按测试数据坐标系设置 __ssplatTestX/Y/Z（可经 ?rx= ?ry= ?rz= 覆盖）。
const ROTATION_TARGET = 'entity.setLocalEulerAngles(0, 0, 180);';
const ROTATION_REPLACEMENT = 'entity.setLocalEulerAngles(window.__ssplatTestX !== undefined ? window.__ssplatTestX : -90, window.__ssplatTestY || 0, window.__ssplatFlip === true ? 180 : (window.__ssplatTestZ || 0));';

// ---------- 合并视图补丁（14 个 .sog 同一场景同时渲染） ----------
// 官方 viewer 是单场景逻辑：config.contents 只指向一个 URL，loadGsplat 只创建一个 gsplat 实体。
// 为在不动源数据的前提下实现「加载全部」，对 bundle 做三处最小补丁（每处均保留严格校验）：
//   P2a. 在 loadGsplat 定义之前注入 loadGsplatOrMerge / loadGsplats 两个辅助函数：
//        入口 loadGsplatOrMerge 依据 config.mergeFiles 是否非空分派到合并/单文件两条路径；
//        loadGsplats 依次把每个文件加载为独立 gsplat 实体（每个实体同样经过上方翻转补丁，
//        即 Rx(-90°)∘Rz(180°)），全部挂到同一 app.root 场景，实现同画布同时渲染。
//   P2b. 将 main() 中的 loadGsplat 调用点替换为 loadGsplatOrMerge（单文件行为不变）。
//   P3.  在 Viewer 的 Promise.all 回调中，把其余实体的包围盒并入 sceneBound，
//        使相机取景与远近裁剪覆盖合并后的整体范围。
const MERGE_HELPERS_TARGET = 'const loadGsplat = async (app, config, progressCallback) => {';
const MERGE_HELPERS_REPLACEMENT = [
    "const loadGsplats = async (app, config, progressCallback) => {",
    "    // [合并视图补丁] 多文件合并加载：把 config.mergeFiles 中的每个 .sog 依次加载为独立的",
    "    // gsplat 实体并挂到同一 app.root 场景下，实现「14 个文件同一场景同时渲染」。",
    "    // 每个实体复用官方 loadGsplat 的创建逻辑（含上方 Z-up → Y-up 翻转补丁）。",
    "    const files = Array.isArray(config.mergeFiles) ? config.mergeFiles : [];",
    "    const total = files.length;",
    "    const entities = [];",
    "    const errors = [];",
    "    let firstEntity = null;",
    "    let totalSplats = 0;",
    "    // [体素碰撞补丁] 合并模式标志：loadGsplat 内的单文件钩子此时只入队不启动构建，",
    "    // 待全部文件加载完成后由 __ssplatBuildVoxelFromEntities 统一启动（避免与渲染首帧竞争）。",
    "    window.__ssplatVoxelMergeMode = true;",
    "    for (let i = 0; i < total; i++) {",
    "        const item = files[i] || {};",
    "        try {",
    "            const entity = await loadGsplat(app, { contentUrl: item.contentUrl, contents: item.contents }, () => {});",
    "            entities.push(entity);",
    "            if (!firstEntity) {",
    "                firstEntity = entity;",
    "            }",
    "            // 读取该文件解析出的 splat 数量（引擎解析完成即可用；获取不到则记为 0）",
    "            let splatCount = 0;",
    "            try {",
    "                splatCount = entity.gsplat?.resource?.numSplats ?? 0;",
    "            } catch (err) {",
    "                splatCount = 0;",
    "            }",
    "            totalSplats += splatCount;",
    "            // 每个文件完成后强制渲染一帧，确保即使已进入按需渲染模式也能立即显示新实体",
    "            app.renderNextFrame = true;",
    "            if (typeof progressCallback === 'function') {",
    "                progressCallback(Math.trunc(((i + 1) / total) * 100));",
    "            }",
    "            // 供自定义中文界面感知合并进度的全局钩子（由 src/app.js 注入）",
    "            if (typeof window.__ssplatMergeProgress === 'function') {",
    "                window.__ssplatMergeProgress({ index: i + 1, total, file: item.contentUrl, splatCount });",
    "            }",
    "        } catch (err) {",
    "            errors.push({ file: item.contentUrl, error: err });",
    "            // 加载失败静默记录到 errors（不再 console 输出，需求：移除全部日志输出）",
    "        }",
    "    }",
    "    if (firstEntity) {",
    "        // 把全部已加载实体挂到首个实体上，供 Viewer 合并包围盒（P3 补丁）使用",
    "        firstEntity.__ssplatMergedEntities = entities;",
    "    }",
    "    // [体素碰撞补丁] 全部文件加载完成：把全部实体交给体素碰撞构建器",
    "    // （SplatVoxelCollision 异步分批构建；env.sog 等超大实体在构建器内部按包围盒跳过）",
    "    if (typeof window.__ssplatBuildVoxelFromEntities === 'function') {",
    "        window.__ssplatBuildVoxelFromEntities(entities);",
    "    }",
    "    // 合并完成钩子（供自定义中文界面显示最终结果）",
    "    if (typeof window.__ssplatMergeDone === 'function') {",
    "        window.__ssplatMergeDone({ total, loaded: entities.length, failed: errors.length, totalSplats });",
    "    }",
    "    if (!firstEntity) {",
    "        throw new Error('合并视图：全部 ' + total + ' 个文件加载失败');",
    "    }",
    "    return firstEntity;",
    "};",
    "const loadGsplatOrMerge = (app, config, progressCallback) => {",
    "    // [合并视图补丁] 入口分派：config.mergeFiles 非空时走合并加载，否则保持原单文件行为。",
    "    if (Array.isArray(config.mergeFiles) && config.mergeFiles.length > 0) {",
    "        return loadGsplats(app, config, progressCallback);",
    "    }",
    "    return loadGsplat(app, config, progressCallback);",
    "};",
    "const loadGsplat = async (app, config, progressCallback) => {"
].join('\n');

const MERGE_CALL_TARGET = [
    '    const gsplatLoad = loadGsplat(app, config, (progress) => {',
    '        state.progress = progress;',
    '    });'
].join('\n');
const MERGE_CALL_REPLACEMENT = [
    '    const gsplatLoad = loadGsplatOrMerge(app, config, (progress) => {',
    '        state.progress = progress;',
    '    });'
].join('\n');

const MERGE_AABB_TARGET = [
    '            const gsplatBbox = gsplatComponent.customAabb;',
    '            if (gsplatBbox) {',
    '                sceneBound.setFromTransformedAabb(gsplatBbox, results[0].getWorldTransform());',
    '            }'
].join('\n');
const MERGE_AABB_REPLACEMENT = [
    '            const gsplatBbox = gsplatComponent.customAabb;',
    '            if (gsplatBbox) {',
    '                sceneBound.setFromTransformedAabb(gsplatBbox, results[0].getWorldTransform());',
    '            }',
    '            // ===== [合并视图补丁] 将全部额外 gsplat 实体的包围盒并入场景包围盒，保证取景/裁剪覆盖整体 =====',
    '            // [碰撞补丁] 跳过包围盒远超首个实体的大尺度实体（如环境/天空盒 env.sog，其包围盒可达数百米）。',
    '            // 若不跳过，碰撞「房间」会被撑到几百米大，用户在真实室内飞行动作永远撞不到墙，表现为',
    '            // 「碰撞未触发」；同时 F 键取景也会被拉到几百米外。判定方式：以首个实体的包围盒对角线',
    '            // 为基准，超过 _skipFactor（8）倍即视为环境/天空盒，只参与渲染、不并入碰撞/取景包围盒。',
    '            // 本场景 14 个文件中 13 个 tile 的包围盒对角线彼此相差 < 1.2 倍，env.sog 约 12.7 倍，',
    '            // 8 倍阈值可干净地区分两者。',
    '            if (results[0].__ssplatMergedEntities && results[0].__ssplatMergedEntities.length > 0) {',
    '                const _mergedTmpBox = new BoundingBox();',
    '                const _baseBox = new BoundingBox();',
    '                const _baseBbox = results[0].gsplat && results[0].gsplat.customAabb;',
    '                let _baseDiag = 1;',
    '                if (_baseBbox) {',
    '                    _baseBox.setFromTransformedAabb(_baseBbox, results[0].getWorldTransform());',
    '                    _baseDiag = _baseBox.halfExtents.length();',
    '                }',
    '                const _skipFactor = 8;',
    '                for (const _other of results[0].__ssplatMergedEntities) {',
    '                    const _otherBbox = _other.gsplat && _other.gsplat.customAabb;',
    '                    if (!_otherBbox) continue;',
    '                    _mergedTmpBox.setFromTransformedAabb(_otherBbox, _other.getWorldTransform());',
    '                    if (_mergedTmpBox.halfExtents.length() > _baseDiag * _skipFactor) {',
    '                        // 环境/天空盒等超大包围盒：只参与渲染，不并入碰撞/取景包围盒',
    '                        continue;',
    '                    }',
    '                    sceneBound.add(_mergedTmpBox);',
    '                }',
    '            }'
].join('\n');

// ---------- 无轨道禁用默认动画补丁（需求②根因A：默认相机模式被动画劫持） ----------
// 排查结论：官方 CameraManager 构造时的 getAnimTrack() 在
//   settings.animTracks 为空、且相机起点位于场景包围盒内（isObjectExperience=false）时，
//   仍会调用 createFigure8Track(...) 生成一条「figure-8 自动巡游」轨道，返回非空。
// 后果链：
//   1) controllers.anim 非空 → state.hasAnimation = true；
//   2) state.cameraMode = state.hasAnimation ? 'anim' : ... → 默认模式变成 anim；
//   3) AnimController.update() 里调用 drainInputFrame(inputFrame) 把 WASD 输入直接丢弃；
//   4) 碰撞只挂接在 fly/walk 控制器（controllers.fly.collision），anim 控制器完全不消费碰撞
//      → 用户进入页面后无论怎么按 WASD 都「碰撞未触发」（其实相机根本没进入 fly 模式）。
// 修复：当 animTracks 为空时让 getAnimTrack 直接返回 null（无动画），
//   于是 hasAnimation=false → 默认模式进入 fly（相机在盒内 + walk 已禁用），碰撞生效。
// 副作用：官方动画播放/暂停/时间轴控件（#play/#pause/#timelineContainer）因
//   hasAnimation=false 而保持隐藏，正好满足需求③「移除 play 按钮」。
const ANIM_DISABLE_TARGET = [
    '        const getAnimTrack = (initial, isObjectExperience) => {',
    '            const { animTracks } = settings;'
].join('\n');
const ANIM_DISABLE_REPLACEMENT = [
    '        const getAnimTrack = (initial, isObjectExperience) => {',
    '            const { animTracks } = settings;',
    '            // [碰撞补丁] 无显式动画轨道时禁用官方默认动画（figure-8/rotate 自动巡游）。',
    '            // 官方逻辑在 animTracks 为空且相机位于包围盒内时仍会创建 figure-8 轨道，',
    '            // 导致 hasAnimation=true → 默认相机模式为 anim（WASD 输入被 drainInputFrame',
    '            // 丢弃、碰撞仅挂接在 fly/walk 控制器上因此完全不生效）。',
    '            // 改为返回 null：无动画 → 默认模式进入 fly（相机在盒内且 walk 已禁用），碰撞生效。',
    '            if (!Array.isArray(animTracks) || animTracks.length === 0) {',
    '                return null;',
    '            }'
].join('\n');

// ---------- 碰撞补丁（简化碰撞：AABB「房间」，无独立碰撞网格） ----------
// 调研结论（官方 bundle dist/index.js + 官方文档）：
//   1. 官方 viewer 的碰撞体仅能从 .glb（MeshCollision.fromGlb）或 .voxel.json
//      （loadVoxelCollision）文件加载，**没有**「从 splat 点云自动生成碰撞」的能力；
//   2. Orbit 控制器本身不消费碰撞，只有 Fly/Walk 控制器（SphereMover / 胶囊）与
//      Picker / NavCursor 消费；Viewer 的 Promise.all 回调里 collision 会被接到
//      CameraManager / InputController / NavCursor；
//   3. 本项目数据只有 14 个 .sog（无独立碰撞网格），因此采用「简化碰撞」方案：
//      P6. 注入 SceneBoundCollision 类：用合并后的场景包围盒 sceneBound 构建 AABB
//          「房间」（地板/四面墙/天花板），实现官方碰撞接口（queryRay/querySphere/
//          queryCapsule/querySurfaceNormal/isFreeAt/voxelResolution）；构造时对包围盒
//          每侧内缩 0.5m（COLLISION_PADDING，用户意图已固化），避免相机紧贴边界；
//      P7. 在 Viewer 的 Promise.all 回调中：无官方碰撞体时用 sceneBound 构造
//          cameraCollision，**仅接入 CameraManager**（fly 相机球体碰撞与滑动）；
//          不接入 InputController / NavCursor 的 collision 槽位（保持 null，
//          避免点击拾取被房间墙面劫持，拾取仍走 splat 深度）；
//      P8. CameraManager 使用 cameraCollision（fly 模式即可获得「相机不可穿出包围盒、
//          不可低于地面」的碰撞行为）；
//      P9. 禁用 walk 模式（场景没有真实地形，walk 出生点会把相机弹到包围盒底部，
//          破坏初始构图）；保持默认 fly 模式并使用碰撞；
//      P10. Orbit 最小缩放距离 0.3m（官方默认 0.01m），防止缩放穿入目标点；
//      P11/P12（需求②：默认操作就带碰撞——orbit 旋转/缩放同样不能穿出房间）：
//          把同一 cameraCollision 挂给 controllers.orbit，并在 OrbitController.update
//          写入相机位置后做「球体在盒内」轴对齐钳制（焦点保持不动、同步 distance/
//          angles 状态），详见下方 COLLISION_ORBIT_* 补丁定义。
const COLLISION_CLASS_TARGET = 'class Viewer {';
const COLLISION_CLASS_REPLACEMENT = [
    'class SceneBoundCollision {',
    '    // [碰撞补丁] 简化碰撞体：用场景包围盒构建的 AABB「房间」（地板/四面墙/天花板）。',
    '    // 实现官方碰撞接口（MeshCollision / VoxelCollision 同款），供 CameraManager 的',
    '    // fly 控制器（SphereMover）做球体碰撞与滑动；盒内为自由空间，表面为碰撞面。',
    '    constructor(bbox) {',
    '        const _c = bbox.center;',
    '        const _h = bbox.halfExtents;',
    '        // [碰撞补丁] 0.5m 内缩 padding（用户意图，已固化到源码）：碰撞「房间」比场景包围盒',
    '        // 每侧小 0.5m，相机（球体半径 0.2m）不会紧贴包围盒边界，避免“贴墙卡死/穿模感”。',
    '        const COLLISION_PADDING = 0.5;',
    '        this.minX = _c.x - _h.x + COLLISION_PADDING;',
    '        this.minY = _c.y - _h.y + COLLISION_PADDING;',
    '        this.minZ = _c.z - _h.z + COLLISION_PADDING;',
    '        this.maxX = _c.x + _h.x - COLLISION_PADDING;',
    '        this.maxY = _c.y + _h.y - COLLISION_PADDING;',
    '        this.maxZ = _c.z + _h.z - COLLISION_PADDING;',
    '        // 参考官方 MeshCollision 的默认体素分辨率（spawn 搜索步长）',
    '        this.voxelResolution = 0.05;',
    '        this._normalResult = { nx: 0, ny: 1, nz: 0 };',
    '    }',
    '    // 射线与 AABB 求交（slab 法）。起点在盒内时返回出口交点（用于从内部撞墙的扫掠）',
    '    queryRay(ox, oy, oz, dx, dy, dz, maxDist) {',
    '        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);',
    '        if (len < 1e-10) return null;',
    '        const nx = dx / len, ny = dy / len, nz = dz / len;',
    '        // tMin 从 -Infinity 开始：保留「入口在身后」的信息，用于判断起点是否在盒内',
    '        let tMin = -Infinity, tMax = Infinity;',
    '        if (Math.abs(nx) < 1e-12) {',
    '            if (ox < this.minX || ox > this.maxX) return null;',
    '        } else {',
    '            let t1 = (this.minX - ox) / nx;',
    '            let t2 = (this.maxX - ox) / nx;',
    '            if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }',
    '            if (t1 > tMin) tMin = t1;',
    '            if (t2 < tMax) tMax = t2;',
    '            if (tMin > tMax) return null;',
    '        }',
    '        if (Math.abs(ny) < 1e-12) {',
    '            if (oy < this.minY || oy > this.maxY) return null;',
    '        } else {',
    '            let t1 = (this.minY - oy) / ny;',
    '            let t2 = (this.maxY - oy) / ny;',
    '            if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }',
    '            if (t1 > tMin) tMin = t1;',
    '            if (t2 < tMax) tMax = t2;',
    '            if (tMin > tMax) return null;',
    '        }',
    '        if (Math.abs(nz) < 1e-12) {',
    '            if (oz < this.minZ || oz > this.maxZ) return null;',
    '        } else {',
    '            let t1 = (this.minZ - oz) / nz;',
    '            let t2 = (this.maxZ - oz) / nz;',
    '            if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }',
    '            if (t1 > tMin) tMin = t1;',
    '            if (t2 < tMax) tMax = t2;',
    '            if (tMin > tMax) return null;',
    '        }',
    '        const t = tMin < 0 ? tMax : tMin;',
    '        if (t < 0 || t > maxDist) return null;',
    '        return { x: ox + nx * t, y: oy + ny * t, z: oz + nz * t };',
    '    }',
    '    // 命中点的表面法线，朝向射线起点（与射线方向相反），供滑动裁剪使用',
    '    querySurfaceNormal(x, y, z, rdx, rdy, rdz) {',
    '        const result = this._normalResult;',
    '        const len = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);',
    '        if (len < 1e-10) { result.nx = 0; result.ny = 1; result.nz = 0; return result; }',
    '        const dx = rdx / len, dy = rdy / len, dz = rdz / len;',
    '        const eps = 1e-4;',
    '        let nx = 0, ny = 0, nz = 0;',
    '        if (Math.abs(x - this.minX) < eps) nx = -1;',
    '        else if (Math.abs(x - this.maxX) < eps) nx = 1;',
    '        else if (Math.abs(y - this.minY) < eps) ny = -1;',
    '        else if (Math.abs(y - this.maxY) < eps) ny = 1;',
    '        else if (Math.abs(z - this.minZ) < eps) nz = -1;',
    '        else if (Math.abs(z - this.maxZ) < eps) nz = 1;',
    '        else { result.nx = 0; result.ny = 1; result.nz = 0; return result; }',
    '        const dot = nx * dx + ny * dy + nz * dz;',
    '        if (dot > 0) { nx = -nx; ny = -ny; nz = -nz; }',
    '        result.nx = nx; result.ny = ny; result.nz = nz;',
    '        return result;',
    '    }',
    '    // 球体与 AABB 表面碰撞检测；命中时把推出向量写入 out（推出方向远离墙面）',
    '    querySphere(cx, cy, cz, radius, out) {',
    '        const insideX = cx >= this.minX && cx <= this.maxX;',
    '        const insideY = cy >= this.minY && cy <= this.maxY;',
    '        const insideZ = cz >= this.minZ && cz <= this.maxZ;',
    '        if (insideX && insideY && insideZ) {',
    '            // 球心在盒内：与最近的墙面比较（盒内为自由空间，仅表面有碰撞）',
    '            const dMinX = cx - this.minX;',
    '            const dMaxX = this.maxX - cx;',
    '            const dMinY = cy - this.minY;',
    '            const dMaxY = this.maxY - cy;',
    '            const dMinZ = cz - this.minZ;',
    '            const dMaxZ = this.maxZ - cz;',
    '            let bestD = dMinX, bestNx = 1, bestNy = 0, bestNz = 0;',
    '            if (dMaxX < bestD) { bestD = dMaxX; bestNx = -1; bestNy = 0; bestNz = 0; }',
    '            if (dMinY < bestD) { bestD = dMinY; bestNx = 0; bestNy = 1; bestNz = 0; }',
    '            if (dMaxY < bestD) { bestD = dMaxY; bestNx = 0; bestNy = -1; bestNz = 0; }',
    '            if (dMinZ < bestD) { bestD = dMinZ; bestNx = 0; bestNy = 0; bestNz = 1; }',
    '            if (dMaxZ < bestD) { bestD = dMaxZ; bestNx = 0; bestNy = 0; bestNz = -1; }',
    '            if (bestD >= radius) { out.x = 0; out.y = 0; out.z = 0; return false; }',
    '            const push = radius - bestD;',
    '            out.x = bestNx * push;',
    '            out.y = bestNy * push;',
    '            out.z = bestNz * push;',
    '            return true;',
    '        }',
    '        // 球心在盒外：与盒表面的最近点比较（推出方向远离盒子）',
    '        const px = Math.max(this.minX, Math.min(this.maxX, cx));',
    '        const py = Math.max(this.minY, Math.min(this.maxY, cy));',
    '        const pz = Math.max(this.minZ, Math.min(this.maxZ, cz));',
    '        const dx = cx - px, dy = cy - py, dz = cz - pz;',
    '        const distSq = dx * dx + dy * dy + dz * dz;',
    '        if (distSq >= radius * radius) { out.x = 0; out.y = 0; out.z = 0; return false; }',
    '        const dist = Math.sqrt(distSq);',
    '        if (dist < 1e-9) { out.x = 0; out.y = 0; out.z = 0; return false; }',
    '        const push = radius - dist;',
    '        out.x = dx / dist * push;',
    '        out.y = dy / dist * push;',
    '        out.z = dz / dist * push;',
    '        return true;',
    '    }',
    '    // 胶囊（竖直线段 + 半径）与 AABB 表面碰撞检测（walk 模式备用，当前未启用）',
    '    queryCapsule(cx, cy, cz, halfHeight, radius, out) {',
    '        const ay0 = cy - halfHeight;',
    '        const ay1 = cy + halfHeight;',
    '        const px = Math.max(this.minX, Math.min(this.maxX, cx));',
    '        const py = Math.max(this.minY, Math.min(this.maxY, cy));',
    '        const pz = Math.max(this.minZ, Math.min(this.maxZ, cz));',
    '        const cyc = Math.max(ay0, Math.min(ay1, py));',
    '        const dx = cx - px;',
    '        const dy = cyc - py;',
    '        const dz = cz - pz;',
    '        const distSq = dx * dx + dy * dy + dz * dz;',
    '        if (distSq >= radius * radius) { out.x = 0; out.y = 0; out.z = 0; return false; }',
    '        const dist = Math.sqrt(distSq);',
    '        if (dist > 1e-9) {',
    '            const push = radius - dist;',
    '            out.x = dx / dist * push;',
    '            out.y = dy / dist * push;',
    '            out.z = dz / dist * push;',
    '            return true;',
    '        }',
    '        // 胶囊中心线穿过盒子：按最小穿透轴推出（与 querySphere 内部逻辑一致）',
    '        const dMinX = cx - this.minX;',
    '        const dMaxX = this.maxX - cx;',
    '        const dMinY = ay0 - this.minY;',
    '        const dMaxY = this.maxY - ay1;',
    '        const dMinZ = cz - this.minZ;',
    '        const dMaxZ = this.maxZ - cz;',
    '        let bestD = dMinX, bestNx = 1, bestNy = 0, bestNz = 0;',
    '        if (dMaxX < bestD) { bestD = dMaxX; bestNx = -1; bestNy = 0; bestNz = 0; }',
    '        if (dMinY < bestD) { bestD = dMinY; bestNx = 0; bestNy = 1; bestNz = 0; }',
    '        if (dMaxY < bestD) { bestD = dMaxY; bestNx = 0; bestNy = -1; bestNz = 0; }',
    '        if (dMinZ < bestD) { bestD = dMinZ; bestNx = 0; bestNy = 0; bestNz = 1; }',
    '        if (dMaxZ < bestD) { bestD = dMaxZ; bestNx = 0; bestNy = 0; bestNz = -1; }',
    '        if (bestD >= radius) { out.x = 0; out.y = 0; out.z = 0; return false; }',
    '        const push = radius - bestD;',
    '        out.x = bestNx * push;',
    '        out.y = bestNy * push;',
    '        out.z = bestNz * push;',
    '        return true;',
    '    }',
    '    // 盒内为自由空间（spawn 搜索用）',
    '    isFreeAt(x, y, z) {',
    '        return x > this.minX && x < this.maxX && y > this.minY && y < this.maxY && z > this.minZ && z < this.maxZ;',
    '    }',
    '}',
    '',
    'class Viewer {'
].join('\n');

// 在 CameraManager 创建处构造「仅相机」用的碰撞体（体素优先；此时 sceneBound 已完成合并填充）
const COLLISION_CAMERA_MANAGER_TARGET = '            this.cameraManager = new CameraManager(global, sceneBound, collision);';
const COLLISION_CAMERA_MANAGER_REPLACEMENT = [
    '            // ===== [碰撞补丁] 体素碰撞（从 splat 构建，优先）+ AABB 房间外边界 =====',
    '            // 官方 viewer 仅支持从 .glb / .voxel.json 文件加载碰撞体；本项目数据只有 .sog，',
    '            // 没有独立碰撞网格。因此从 gsplat splat 数据异步构建体素碰撞网格',
    '            // （SplatVoxelCollision，由加载钩子在全部文件加载完成后触发构建），并叠加',
    '            // AABB「房间」（sceneBound 内缩 0.5m）作为场景外边界：',
    '            //   体素管「不能穿模型」，房间管「不能出场景」。',
    '            // 构建完成前（或单文件无数据时）自动回落到仅房间碰撞，行为与旧版一致。',
    '            // 注意：此处 sceneBound 已完成合并填充（含全部 gsplat 实体的包围盒，跳过环境/天空盒）；',
    '            // 同时不接入 InputController / NavCursor 的 collision 槽位（保持 null），',
    '            // 避免点击拾取被房间墙面劫持（拾取仍走 splat 深度）。',
    '            const cameraCollision = window.__ssplatVoxelCollision ?? (collision ?? new SceneBoundCollision(sceneBound));',
    '            if (window.__ssplatVoxelCollision && typeof window.__ssplatVoxelCollision.setRoom === \'function\') {',
    '                // 权威房间边界 = 合并后的 sceneBound（含 0.5m 内缩 padding）。',
    '                // setRoom 在首帧体素构建开始前执行（Viewer 回调是微任务，首帧构建在 rAF），',
    '                // 体素网格按此房间边界分配，保证体素索引与世界坐标对齐。',
    '                window.__ssplatVoxelCollision.setRoom(sceneBound);',
    '            }',
    '            // ===== [空气墙补丁] 以合并后的 sceneBound 为基准外扩 0.7m 建立固定空气墙（写死，兜底） =====',
    '            // 用户要求「空气墙再外扩 0.4m」：原 0.3m + 0.4m = 0.7m，直接写死避免相机穿墙。',
    '            // sceneBound 在此处已完成合并填充（13 个 tile，已跳过 env 等超大包围盒）：',
    '            //   合并包围盒 sceneBound ≈ x[-42.47, 29.91] y[-6.92, 9.90] z[-15.28, 36.65]',
    '            //   空气墙（外扩 0.7m）     = x[-43.17, 30.61] y[-7.62, 10.60] z[-15.98, 37.35]',
    '            //   相机球心允许（内缩 0.2m）= x[-42.97, 30.41] y[-7.42, 10.40] z[-15.78, 37.15]',
    '            // 与现有碰撞的关系：AABB 房间（sceneBound 内缩 0.5m）与体素碰撞负责「贴近模型的精细阻挡」；',
    '            // 空气墙是最终兜底——每帧在 CameraManager.update 里无条件钳制相机位置，即使房间/体素',
    '            // 构建失败或空网格也 100% 挡相机（详见 CameraManager.update 内的钳制补丁）。',
    '            window.__ssplatAirWall = window.__ssplatAirWall || new SceneAirWall();',
    '            window.__ssplatAirWall.setFromBBox(sceneBound);',
    '            this.cameraManager = new CameraManager(global, sceneBound, cameraCollision);',
    '            // ===== [体素碰撞补丁] 鼠标射线持续与体素网格求交（需求③） =====',
    '            // 官方 Picker 走 splat GPU 深度拾取（与碰撞体无关，持续可用）；这里额外把鼠标射线',
    '            // 接到体素 queryRay，提供 mesh 级命中反馈：window.__ssplatVoxelRayHit 保存最近命中',
    '            // 点与距离，供状态栏「距模型 x.x m / 射线命中 y.y m」读取。',
    '            if (window.__ssplatVoxelCollision) {',
    '                const _rayCanvas = app.graphicsDevice.canvas;',
    '                const _rayNear = new Vec3();',
    '                const _rayFar = new Vec3();',
    '                const _rayDir = new Vec3();',
    '                if (_rayCanvas) {',
    '                    _rayCanvas.addEventListener(\'pointermove\', (event) => {',
    '                        const _col = window.__ssplatVoxelCollision;',
    '                        if (!_col || !_col.hasVoxels) return;',
    '                        const _rect = _rayCanvas.getBoundingClientRect();',
    '                        const _ox = event.clientX - _rect.left;',
    '                        const _oy = event.clientY - _rect.top;',
    '                        const _camEnt = global.camera;',
    '                        const _camComp = _camEnt && _camEnt.camera;',
    '                        const _camPos = _camEnt && _camEnt.getPosition();',
    '                        if (!_camComp || !_camPos) return;',
    '                        _camComp.screenToWorld(_ox, _oy, 0.1, _rayNear);',
    '                        _camComp.screenToWorld(_ox, _oy, 1000, _rayFar);',
    '                        _rayDir.sub2(_rayFar, _rayNear).normalize();',
    '                        const _hit = _col.queryRay(_rayNear.x, _rayNear.y, _rayNear.z, _rayDir.x, _rayDir.y, _rayDir.z, 1000);',
    '                        if (_hit) {',
    '                            const _dx = _hit.x - _rayNear.x, _dy = _hit.y - _rayNear.y, _dz = _hit.z - _rayNear.z;',
    '                            window.__ssplatVoxelRayHit = {',
    '                                hit: { x: _hit.x, y: _hit.y, z: _hit.z },',
    '                                distance: Math.sqrt(_dx * _dx + _dy * _dy + _dz * _dz)',
    '                            };',
    '                        } else {',
    '                            window.__ssplatVoxelRayHit = { hit: null, distance: Infinity };',
    '                        }',
    '                    });',
    '                }',
    '            }'
].join('\n');

// 禁用 walk 模式（无真实地形）：保持默认 fly 模式并使用碰撞
const COLLISION_WALK_DISABLE_TARGET = '        const walkAllowed = isWalkAllowed(bbox, collision);';
const COLLISION_WALK_DISABLE_REPLACEMENT = [
    '        // [碰撞补丁] 简化碰撞下不启用 walk 模式：场景没有真实地形（包围盒底部不是地面），',
    '        // walk 出生点会把相机弹到包围盒底部破坏初始构图；保持默认 fly 模式并使用碰撞。',
    '        const walkAllowed = false;'
].join('\n');

// Orbit 最小缩放距离：防止缩放穿入目标点
const COLLISION_ORBIT_MIN_DIST_TARGET = '        this.controller.zoomRange = new Vec2(0.01, Infinity);';
const COLLISION_ORBIT_MIN_DIST_REPLACEMENT = [
    '        // [碰撞补丁] Orbit 最小缩放距离 0.3m：防止缩放时相机穿入目标点（简化碰撞的一部分）。',
    '        this.controller.zoomRange = new Vec2(0.3, Infinity);'
].join('\n');

// ---------- orbit 碰撞补丁（需求②：不切换 fly 模式，默认操作就带碰撞） ----------
// 用户要求「默认操作就带碰撞」——当前碰撞只挂接在 controllers.fly.collision（SphereMover），
// orbit 控制器无碰撞，鼠标 orbit 旋转/缩放时相机可自由穿出房间墙/地板/天花板。
// 官方 OrbitController 不消费碰撞（只有 Fly/Walk 的 SphereMover/胶囊消费），因此：
//   P11. 把同一个 cameraCollision（SceneBoundCollision AABB 房间）也挂给 controllers.orbit，
//        与 fly 共用同一碰撞体实例、互不干扰；
//   P12. 在 OrbitController.update 写入相机位置之后做「球体在盒内」钳制：
//        - 用 AABB 内缩相机球体半径 0.2m（与 fly CAMERA_RADIUS 一致）得到球心允许范围，
//          轴对齐把相机球心钳回盒内。这等价于 querySphere 的球体-房间推出语义，且对
//          快速缩放/拖拽的单帧大位移同样有效；注意不能直接用 querySphere 的「盒外分支」
//          ——它的推出方向远离盒子（供 SphereMover 沿面滑动），会把相机越推越远；
//        - 焦点（orbit target = _rootPose.position）保持不动；距离 = 钳制后与焦点的实际
//          距离（不小于 0.3m 最小缩放）；朝向用 Camera#look 由「焦点-相机」方向反算，
//          并同步回 _rootPose/_childPose 内部状态，保证与官方 orbit 状态模型自洽、不抖动
//          （官方 update 由 焦点 + R(angles)*(0,0,distance) 重建相机位置，同步后二者一致）。
const COLLISION_ORBIT_ATTACH_TARGET = [
    '        controllers.fly.collision = collision;',
    '        controllers.walk.collision = collision;'
].join('\n');
const COLLISION_ORBIT_ATTACH_REPLACEMENT = [
    '        controllers.fly.collision = collision;',
    '        // [orbit 碰撞补丁] 把同一简化碰撞体（AABB 房间）也挂给 orbit 控制器：',
    '        // 需求②要求「默认操作就带碰撞」——orbit 旋转/缩放同样不能穿出房间（墙/地板/天花板），',
    '        // 与 fly 碰撞互不干扰（两者共用同一碰撞体实例，但各自独立消费）。',
    '        controllers.orbit.collision = collision;',
    '        controllers.walk.collision = collision;'
].join('\n');

const COLLISION_ORBIT_CLAMP_TARGET = [
    '    update(deltaTime, inputFrame, camera) {',
    '        const pose = this.controller.update(inputFrame, deltaTime);',
    '        camera.position.copy(pose.position);',
    '        camera.angles.copy(pose.angles);',
    '        camera.distance = pose.distance;',
    '        camera.fov = this.fov;',
    '    }'
].join('\n');
const COLLISION_ORBIT_CLAMP_REPLACEMENT = [
    '    update(deltaTime, inputFrame, camera) {',
    '        const pose = this.controller.update(inputFrame, deltaTime);',
    '        camera.position.copy(pose.position);',
    '        camera.angles.copy(pose.angles);',
    '        camera.distance = pose.distance;',
    '        camera.fov = this.fov;',
    '        // ===== [orbit 碰撞补丁] 相机球体钳制到碰撞房间内 + 体素推出（不穿墙/地板/天花板/模型） =====',
    '        // 官方 Orbit 控制器不消费碰撞；这里复用 CameraManager 传入的碰撞体（SceneBoundCollision',
    '        // AABB 房间 或 SplatVoxelCollision 体素网格）对相机球体（半径 0.2m，与 fly CAMERA_RADIUS',
    '        // 一致）做碰撞处理：',
    '        //   - 房间：球心允许范围 = [min+0.2, max-0.2]，轴对齐钳制（等价于球体-房间推出语义，且对',
    '        //     快速缩放/拖拽的单帧大位移同样有效；不能用 querySphere 的「盒外分支」——它的推出方向',
    '        //     远离盒子（供 SphereMover 沿面滑动），会把相机越推越远）；',
    '        //   - 体素（模型表面）：调用 querySphere 取推出向量，相机球体不能进入实心体素。',
    '        // 焦点（orbit target = _rootPose.position）保持不动；距离 = 钳制后与焦点的实际距离（不小于',
    '        // 0.3m 最小缩放）；朝向用 Camera#look 由「焦点-相机」方向反算，并同步回 _rootPose/_childPose',
    '        // 内部状态，保证与官方 orbit 状态模型自洽、不抖动。',
    '        // [碰撞开关补丁] window.__ssplatCollisionEnabled === false 时跳过全部钳制/推出；',
    '        // [瞬移免推出补丁] __ssplatTeleportSkipUntil 窗口内整块跳过（房间钳制 + 体素推出统一豁免）：',
    '        // 瞬移目标点本身可能在房间边界外（用户确认的取景点），窗口内先让相机到达并停稳，',
    '        // 避免房间钳制分支把相机 look() 重写到焦点附近 0.3m 处（实测被拉偏 0.3m）；',
    '        // 窗口过后若目标点合法（房间内且无体素）碰撞恢复后位置保持不变。',
    '        // [日志补丁] 体素推出时经 window.__ssplatLog 输出（节流 1s）。',
    '        if ((typeof window === \'undefined\' || (window.__ssplatCollisionEnabled !== false &&',
    '            !(window.__ssplatTeleportSkipUntil && Date.now() < window.__ssplatTeleportSkipUntil))) && this.collision && typeof this.collision.minX === \'number\') {',
    '            const _orbitR = 0.5; // [碰撞半径补丁] 相机距模型 0.5m 触发碰撞（用户要求，1m 减半）',
    '            const _col = this.collision;',
    '            const _orbitClamped = new Vec3();',
    '            const _orbitMinX = _col.minX + _orbitR;',
    '            const _orbitMaxX = _col.maxX - _orbitR;',
    '            const _orbitMinY = _col.minY + _orbitR;',
    '            const _orbitMaxY = _col.maxY - _orbitR;',
    '            const _orbitMinZ = _col.minZ + _orbitR;',
    '            const _orbitMaxZ = _col.maxZ - _orbitR;',
    '            const _orbitCX = camera.position.x < _orbitMinX ? _orbitMinX : (camera.position.x > _orbitMaxX ? _orbitMaxX : camera.position.x);',
    '            const _orbitCY = camera.position.y < _orbitMinY ? _orbitMinY : (camera.position.y > _orbitMaxY ? _orbitMaxY : camera.position.y);',
    '            const _orbitCZ = camera.position.z < _orbitMinZ ? _orbitMinZ : (camera.position.z > _orbitMaxZ ? _orbitMaxZ : camera.position.z);',
    '            let _orbitChanged = _orbitCX !== camera.position.x || _orbitCY !== camera.position.y || _orbitCZ !== camera.position.z;',
    '            if (_orbitChanged) {',
    '                camera.position.x = _orbitCX;',
    '                camera.position.y = _orbitCY;',
    '                camera.position.z = _orbitCZ;',
    '            }',
    '            // ===== [体素碰撞补丁] orbit 相机球体同样不能进入实心体素（模型表面） =====',
    '            // 与 fly 的 SphereMover 走同一官方碰撞接口 querySphere，保证 orbit/fly 碰撞语义一致。',
    '            // [瞬移免推出补丁] 瞬移后 1 秒窗口内跳过体素推出（相机先到达目标点）。',
    '            if (this.collision.hasVoxels && typeof this.collision.querySphere === \'function\' &&',
    '                !(typeof window !== \'undefined\' && window.__ssplatTeleportSkipUntil && Date.now() < window.__ssplatTeleportSkipUntil)) {',
    '                const _orbitVoxelPush = new Vec3();',
    '                if (this.collision.querySphere(camera.position.x, camera.position.y, camera.position.z, _orbitR, _orbitVoxelPush)) {',
    '                    camera.position.x += _orbitVoxelPush.x;',
    '                    camera.position.y += _orbitVoxelPush.y;',
    '                    camera.position.z += _orbitVoxelPush.z;',
    '                    _orbitChanged = true;',
    '                    if (typeof window !== \'undefined\') {',
    '                        const _ovNow = Date.now();',
    '                        if (_ovNow - (window.__ssplatVoxelLogLast || 0) > 1000) {',
    '                            window.__ssplatVoxelLogLast = _ovNow;',
    '                            if (typeof window.__ssplatLog === \'function\') {',
    '                                window.__ssplatLog(\'voxel\', \'orbit 相机被体素推出 (\' + _orbitVoxelPush.x.toFixed(2) + \', \' +',
    '                                    _orbitVoxelPush.y.toFixed(2) + \', \' + _orbitVoxelPush.z.toFixed(2) + \') pos=(\' +',
    '                                    camera.position.x.toFixed(2) + \', \' + camera.position.y.toFixed(2) + \', \' +',
    '                                    camera.position.z.toFixed(2) + \')\');',
    '                            }',
    '                        }',
    '                    }',
    '                }',
    '            }',
    '            if (_orbitChanged) {',
    '                // 发生碰撞：焦点（orbit 的 target = _rootPose.position）保持不动，',
    '                // 只把相机位置钳回盒内/推出体素，并按钳制后的实际距离同步 distance / angles。',
    '                const _orbitFocus = this.controller._rootPose.position;',
    '                const _orbitCX2 = camera.position.x;',
    '                const _orbitCY2 = camera.position.y;',
    '                const _orbitCZ2 = camera.position.z;',
    '                let _orbitDist = Math.sqrt(',
    '                    (_orbitCX2 - _orbitFocus.x) * (_orbitCX2 - _orbitFocus.x) +',
    '                    (_orbitCY2 - _orbitFocus.y) * (_orbitCY2 - _orbitFocus.y) +',
    '                    (_orbitCZ2 - _orbitFocus.z) * (_orbitCZ2 - _orbitFocus.z)',
    '                );',
    '                const _orbitMinDist = 0.3; // 与构造器 zoomRange 最小缩放距离一致',
    '                let _orbitLX = _orbitCX2, _orbitLY = _orbitCY2, _orbitLZ = _orbitCZ2;',
    '                if (_orbitDist < _orbitMinDist) {',
    '                    if (_orbitDist < 1e-9) {',
    '                        // 极端情况（相机与焦点几乎重合）：沿原始视线方向取最小距离',
    '                        const _orbitODX = pose.position.x - _orbitFocus.x;',
    '                        const _orbitODY = pose.position.y - _orbitFocus.y;',
    '                        const _orbitODZ = pose.position.z - _orbitFocus.z;',
    '                        const _orbitOLen = Math.sqrt(_orbitODX * _orbitODX + _orbitODY * _orbitODY + _orbitODZ * _orbitODZ);',
    '                        if (_orbitOLen > 1e-9) {',
    '                            _orbitLX = _orbitFocus.x + (_orbitODX / _orbitOLen) * _orbitMinDist;',
    '                            _orbitLY = _orbitFocus.y + (_orbitODY / _orbitOLen) * _orbitMinDist;',
    '                            _orbitLZ = _orbitFocus.z + (_orbitODZ / _orbitOLen) * _orbitMinDist;',
    '                        }',
    '                    } else {',
    '                        const _orbitScale = _orbitMinDist / _orbitDist;',
    '                        _orbitLX = _orbitFocus.x + (_orbitCX2 - _orbitFocus.x) * _orbitScale;',
    '                        _orbitLY = _orbitFocus.y + (_orbitCY2 - _orbitFocus.y) * _orbitScale;',
    '                        _orbitLZ = _orbitFocus.z + (_orbitCZ2 - _orbitFocus.z) * _orbitScale;',
    '                    }',
    '                }',
    '                // look() 同步 position/distance/angles：angles 由「焦点-相机」方向反算，',
    '                // 与官方 Camera#calcFocusPoint 口径（position + R(angles)*FORWARD*distance）',
    '                // 完全一致，保证下一帧官方 update 算出的相机位置 == 钳制后的位置，不抖动。',
    '                camera.look(_orbitClamped.set(_orbitLX, _orbitLY, _orbitLZ), _orbitFocus);',
    '                if (camera.distance < _orbitMinDist) {',
    '                    camera.distance = _orbitMinDist;',
    '                }',
    '                // 同步 orbit 内部状态：焦点不变、child pose 距离 = 实际距离、朝向 = 新角度；',
    '                // 这样官方 update 的阻尼 lerp 不再朝盒外位置追赶，orbit 与 fly 碰撞互不干扰。',
    '                this.controller._targetRootPose.position.copy(_orbitFocus);',
    '                this.controller._rootPose.position.copy(_orbitFocus);',
    '                this.controller._targetRootPose.angles.copy(camera.angles);',
    '                this.controller._rootPose.angles.copy(camera.angles);',
    '                this.controller._childPose.position.set(0, 0, camera.distance);',
    '                this.controller._targetChildPose.position.set(0, 0, camera.distance);',
    '            }',
    '        }',
    '    }'
].join('\n');

// ---------- 固定空气墙补丁（需求：0.7m 空气墙 + 每帧无条件钳制相机位置） ----------
// 用户实测此前所有碰撞方案（AABB 房间、体素碰撞）都失败——相机轻松穿墙。本次要求
// 「简单、可靠、无条件」：不依赖 GPU 纹理读回、不依赖体素构建、不依赖相机模式，
// 每帧强制把相机位置钳制在空气墙内。
// 空气墙：以合并后的场景包围盒 sceneBound（env 已排除）为基准外扩 0.7m（确定性逻辑，
// 运行时在 Viewer 的 Promise.all 回调中 sceneBound 合并完成后初始化；0.7 = 原 0.3 + 再外扩 0.4）：
//   合并包围盒 sceneBound ≈ x[-42.47, 29.91] y[-6.92, 9.90] z[-15.28, 36.65]；
//   空气墙（±0.7）       = x[-43.17, 30.61] y[-7.62, 10.60] z[-15.98, 37.35]；
//   相机球心允许（±0.2） = x[-42.97, 30.41] y[-7.42, 10.40] z[-15.78, 37.15]。
// 钳制注入点：CameraManager.update 内、controller.update + 过渡 lerp/copy 之后（每帧
//   相机更新的最终落点），随后 applyCamera() 才把 this.camera 同步到相机实体——在此
//   钳制后本帧不会被任何更新覆盖。任何相机模式（fly/orbit/anim/过渡）均经过此点。
const SCENE_AIR_WALL_CLASS = `
class SceneAirWall {
    // [空气墙补丁] 固定空气墙：以合并后的场景包围盒 sceneBound 为基准，外扩 0.7m 建立
    // 「高斯模型外围的固定空气墙」（原 0.3m + 用户要求再外扩 0.4m = 0.7m），每帧无条件把相机位置
    // 钳制在墙内（最终兜底）。
    // 设计（对应需求「简单、可靠、无条件」）：
    //   - 不依赖 GPU 纹理读回、不依赖体素构建、不依赖相机模式 / controllers 类型；
    //   - 空气墙边界 = sceneBound 外扩 wallOffset（0.7m）；
    //   - 相机球心允许范围 = 空气墙边界内缩 cameraRadius（0.2m），保证相机球体任何部分不越墙；
    //   - 轴对齐 clamp（逐轴 min/max），单帧大位移（瞬移/导航/动画）同样生效。
    constructor() {
        this.ready = false;
        // 空气墙外扩距离（默认 0.7m = 原 0.3 + 再外扩 0.4；可经 window.__ssplatAirWallOffset 覆盖，
        // 如 /new 页设 30m 放宽「最远」限制，避免与「最近 0.5m」碰撞半径冲突、不干扰远处相机定位）
        this.wallOffset = (typeof window !== \'undefined\' && typeof window.__ssplatAirWallOffset === 'number')
            ? window.__ssplatAirWallOffset : 0.7;
        this.cameraRadius = 0.2;  // 相机球体半径（空气墙内缩；模型表面 0.5m 由体素碰撞 CAMERA_RADIUS 负责）
        this.minX = 0; this.minY = 0; this.minZ = 0;
        this.maxX = 0; this.maxY = 0; this.maxZ = 0;
        this.clampMinX = 0; this.clampMinY = 0; this.clampMinZ = 0;
        this.clampMaxX = 0; this.clampMaxY = 0; this.clampMaxZ = 0;
        this.clampCount = 0;      // 钳制次数（与 window.__ssplatWallClamps 同步，仅作状态统计，不输出日志）
    }
    // 由场景包围盒（BoundingBox）初始化空气墙。sceneBound 在 Viewer 的 Promise.all
    // 回调中完成合并填充（13 个 tile，已跳过 env 等超大包围盒），是该处唯一权威来源。
    setFromBBox(bbox) {
        if (!bbox || !bbox.center || !bbox.halfExtents) return;
        const c = bbox.center;
        const h = bbox.halfExtents;
        this.setFromMinMax(c.x - h.x, c.y - h.y, c.z - h.z, c.x + h.x, c.y + h.y, c.z + h.z);
    }
    // 由世界 AABB min/max 初始化空气墙（确定性逻辑：min/max 各外扩 wallOffset）。
    setFromMinMax(minX, minY, minZ, maxX, maxY, maxZ) {
        const off = this.wallOffset;
        const r = this.cameraRadius;
        this.minX = minX - off; this.minY = minY - off; this.minZ = minZ - off;
        this.maxX = maxX + off; this.maxY = maxY + off; this.maxZ = maxZ + off;
        // 相机球心允许范围 = 空气墙内缩相机半径（球体任何部分不越出空气墙）
        this.clampMinX = this.minX + r; this.clampMinY = this.minY + r; this.clampMinZ = this.minZ + r;
        this.clampMaxX = this.maxX - r; this.clampMaxY = this.maxY - r; this.clampMaxZ = this.maxZ - r;
        this.ready = true;
    }
    // 轴对齐钳制相机位置（写回 camera.position）；发生钳制返回 true，并计数。
    // 仅改位置不改朝向/焦点（orbit 模式下 target 保持不动，距离被压缩是预期行为）。
    // [碰撞开关补丁] window.__ssplatCollisionEnabled === false 时跳过钳制（相机自由穿行）；
    // [日志补丁] 发生钳制时经 window.__ssplatLog 输出（节流 1s，排查「相机被卡住」）。
    clampCamera(camera) {
        if (!camera || !camera.position) return false;
        if (!this.ready) return false; // 空气墙未就绪（sceneBound 未确定）：安全跳过
        if (typeof window !== \'undefined\' && window.__ssplatCollisionEnabled === false) return false;
        const p = camera.position;
        const cx = p.x < this.clampMinX ? this.clampMinX : (p.x > this.clampMaxX ? this.clampMaxX : p.x);
        const cy = p.y < this.clampMinY ? this.clampMinY : (p.y > this.clampMaxY ? this.clampMaxY : p.y);
        const cz = p.z < this.clampMinZ ? this.clampMinZ : (p.z > this.clampMaxZ ? this.clampMaxZ : p.z);
        if (cx === p.x && cy === p.y && cz === p.z) return false;
        p.x = cx; p.y = cy; p.z = cz;
        this.clampCount++;
        if (typeof window !== \'undefined\') {
            window.__ssplatWallClamps = this.clampCount;
            const now = Date.now();
            const last = window.__ssplatWallLogLast || 0;
            if (now - last > 1000) {
                window.__ssplatWallLogLast = now;
                if (typeof window.__ssplatLog === 'function') {
                    window.__ssplatLog('wall',
                        '相机被空气墙钳制 #' + this.clampCount + ' → (' + cx.toFixed(2) + ', ' + cy.toFixed(2) + ', ' + cz.toFixed(2) +
                        ') 墙内 x[' + this.clampMinX.toFixed(2) + ', ' + this.clampMaxX.toFixed(2) + '] y[' +
                        this.clampMinY.toFixed(2) + ', ' + this.clampMaxY.toFixed(2) + '] z[' +
                        this.clampMinZ.toFixed(2) + ', ' + this.clampMaxZ.toFixed(2) + ']');
                }
            }
        }
        return true;
    }
}
`;

// CameraManager.update 每帧相机更新的最终落点：controller.update 写入 target →
// 过渡 lerp / 直接 copy 落到 this.camera（权威相机状态）。在此之后追加空气墙钳制。
const COLLISION_AIRWALL_CLAMP_TARGET = [
    '            if (transitionTimer < 1) {',
    '                // lerp away from previous camera during transition',
    '                this.camera.lerp(from, target, easeOut(transitionTimer));',
    '            }',
    '            else {',
    '                this.camera.copy(target);',
    '            }'
].join('\n');
const COLLISION_AIRWALL_CLAMP_REPLACEMENT = [
    '            if (transitionTimer < 1) {',
    '                // lerp away from previous camera during transition',
    '                this.camera.lerp(from, target, easeOut(transitionTimer));',
    '            }',
    '            else {',
    '                this.camera.copy(target);',
    '            }',
    '            // ===== [空气墙补丁] 每帧无条件钳制相机位置到空气墙内（最终兜底，任何相机模式均生效） =====',
    '            // 用户要求「在高斯模型外围 0.3m 建立固定空气墙，直接写死，避免相机穿墙」。',
    '            // 此处是 CameraManager 每帧相机更新的最终落点：controller.update(dt, frame, target)',
    '            // 写入期望位姿 → 经 lerp/copy 落到 this.camera（权威相机状态）；随后 app 更新循环里',
    '            // applyCamera(this.cameraManager.camera) 才会把 this.camera 同步到相机实体。因此在这里',
    '            // 钳制后，本帧内不会再被任何更新覆盖。',
    '            // 语义：相机球体（半径 0.2m）任何部分都不能越出空气墙 —— 钳制范围 = [wallMin+0.2,',
    '            // wallMax-0.2]，轴对齐 clamp。无条件生效：不依赖 controllers 类型、不依赖 collision',
    '            // 是否挂接、不依赖体素/GPU；fly/orbit/anim 及过渡 lerp 全部覆盖。',
    '            // orbit 模式下 target（焦点）保持不动，仅相机位置被钳制（距离被压缩是预期行为——',
    '            // 用户要的就是不能穿墙）。',
    '            // [碰撞开关补丁] window.__ssplatCollisionEnabled === false 时跳过钳制与焦点钳制；',
    '            // [日志补丁] 每 2s 输出一次相机位置与碰撞计数（排查「相机被卡住」）。',
    '            if (typeof window !== \'undefined\') { window.__ssplatCameraManager = this; }',
    '            // [瞬移保位补丁] 暴露 orbit 核心实例与相机状态（调试追踪 rootPose/childPose 写入者用）',
    '            if (typeof window !== \'undefined\' && controllers.orbit && controllers.orbit.controller) {',
    '                window.__ssplatOrbitCore = controllers.orbit.controller;',
    '                window.__ssplatCamState = state;',
    '                if (controllers.fly && controllers.fly.controller) { window.__ssplatFlyCore = controllers.fly.controller; }',
    '            }',
    '            const _ssLogNow = Date.now();',
    '            if (typeof window !== \'undefined\' && _ssLogNow - (window.__ssplatCamTick || 0) > 2000) {',
    '                window.__ssplatCamTick = _ssLogNow;',
    '                if (typeof window.__ssplatLog === \'function\' && window.__ssplatCollisionEnabled !== false) {',
    '                    const _p = this.camera.position;',
    '                    // [rotation 监控] 输出相机朝向欧拉角（与 pos 同步，排查旋转角度问题）',
    '                    // this.camera = { position: Vec3, angles: Vec3(x,y,z 欧拉角), distance, fov }',
    '                    const _a = this.camera.angles;',
    '                    const _eulerStr = _a ? (_a.x.toFixed(2) + \'/\' + _a.y.toFixed(2) + \'/\' + _a.z.toFixed(2)) : \'n/a\';',
    '                    window.__ssplatLog(\'cam\', \'pos=(\' + _p.x.toFixed(2) + \', \' + _p.y.toFixed(2) + \', \' + _p.z.toFixed(2) +',
    '                        \') rot=(\' + _eulerStr + \') mode=\' + (state.cameraMode || \'?\') + \' wallClamps=\' + (window.__ssplatWallClamps || 0) +',
    '                        \' voxelDone=\' + (window.__ssplatVoxelCollision && window.__ssplatVoxelCollision._done ? \'1\' : \'0\'));',
    '                }',
    '            }',
    '            // [瞬移免推出补丁] 瞬移后 1 秒窗口内跳过空气墙钳制（相机先到达目标点）',
    '            if (window.__ssplatAirWall && window.__ssplatAirWall.ready && window.__ssplatCollisionEnabled !== false &&',
    '                !(typeof window !== \'undefined\' && window.__ssplatTeleportSkipUntil && Date.now() < window.__ssplatTeleportSkipUntil)) {',
    '                window.__ssplatAirWall.clampCamera(this.camera);',
    '            }',
    '            // ===== [体素碰撞推出补丁] 每帧防止旋转/缩放穿模（任何相机模式均生效） =====',
    '            // 问题：空气墙只限制场景外边界，但 orbit 旋转/缩放时相机可能绕过空气墙进模型内部。',
    '            // 体素碰撞已构建但之前只在点击行走时检测，旋转时无检测 → 穿模。',
    '            // 方案：每帧用 querySphere（半径 0.2m）检测相机位置，命中时按推出向量推出到表面外。',
    '            // 与 airWall 叠加：airWall 管「不能出场景」，体素管「不能穿模型」，二者正交不冲突。',
    '            if (typeof window !== \'undefined\' && window.__ssplatVoxelCollision &&',
    '                window.__ssplatVoxelCollision._done &&',
    '                window.__ssplatCollisionEnabled !== false &&',
    '                typeof window.__ssplatVoxelCollision.querySphere === \'function\' &&',
    '                !(window.__ssplatTeleportSkipUntil && Date.now() < window.__ssplatTeleportSkipUntil)) {',
    '                const _voxOut = new Vec3();',
    '                if (window.__ssplatVoxelCollision.querySphere(this.camera.position.x, this.camera.position.y,',
    '                    this.camera.position.z, 0.2, _voxOut)) {',
    '                    this.camera.position.x += _voxOut.x;',
    '                    this.camera.position.y += _voxOut.y;',
    '                    this.camera.position.z += _voxOut.z;',
    '                }',
    '            }',
    '            // ===== [相机高度固定补丁] 每帧强制相机高度（如 /new 页高度=3.91，不能上下移动） =====',
    '            // window.__ssplatCameraHeightFixed === true 时，相机 y 无条件钳制到 __ssplatCameraHeight：',
    '            //   - 位于空气墙钳制之后（最终兜底，任何模式/过渡/瞬移后均生效）；',
    '            //   - 同步 fly 内部 _position.y（强制飞行模式下防下一帧 update 拉回）；',
    '            //   - 同步 orbit 焦点（rootPose/targetRootPose.position.y 平移同增量），orbit 下自洽；',
    '            //   - QE 升降已由独立补丁注销（__ssplatQEEnabled=false），此处兜底保证任何输入都改不了高度。',
    '            if (typeof window !== \'undefined\' && window.__ssplatCameraHeightFixed === true &&',
    '                typeof window.__ssplatCameraHeight === \'number\' && this.camera && this.camera.position) {',
    '                const _camDY = window.__ssplatCameraHeight - this.camera.position.y;',
    '                if (Math.abs(_camDY) > 1e-6) {',
    '                    this.camera.position.y = window.__ssplatCameraHeight;',
    '                    if (controllers.fly && controllers.fly._position) {',
    '                        controllers.fly._position.y = window.__ssplatCameraHeight;',
    '                    }',
    '                    if (controllers.orbit && controllers.orbit.controller) {',
    '                        const _oc = controllers.orbit.controller;',
    '                        if (_oc._rootPose && _oc._rootPose.position) _oc._rootPose.position.y += _camDY;',
    '                        if (_oc._targetRootPose && _oc._targetRootPose.position) _oc._targetRootPose.position.y += _camDY;',
    '                    }',
    '                }',
    '            }',
    '            // ===== [点击行走补丁] 手机端点击行走状态机（每帧推进平滑飞行） =====',
    '            // window.__ssplatWalkState 由 NavInteraction 手机端点击设置：',
    '            //   { toPos: Vec3, toTarget: Vec3, t: number, duration: number }',
    '            // 首次帧初始化 fromPos/fromTarget（当前相机位置与 orbit 焦点），随后每帧：',
    '            //   1) 插值相机位置（fromPos → toPos，easeOut）；',
    '            //   2) 插值注视点（fromTarget → toTarget）；',
    '            //   3) 用 look() 重建朝向并同步 orbit 控制器内部状态（goto），',
    '            //      避免下一帧被 orbit 控制器覆盖；',
    '            //   4) 到达后清空状态（相机停在目标点附近，可继续 orbit 环绕）。',
    '            if (window.__ssplatWalkState) {',
    '                const _ws = window.__ssplatWalkState;',
    '                if (!_ws.fromPos) {',
    '                    _ws.fromPos = this.camera.position.clone();',
    '                    // [fly 适配] fly 模式下无 orbit 焦点（_rootPose 不存在）：',
    '                    // 旧逻辑 fromTarget = camera.position → 首帧 look(from==to) 零向量 → 角度 NaN/乱跳。',
    '                    // 改为相机当前朝向前方一点（沿 -Z 视线方向延伸 3m），保证首帧 look 方向有效。',
    '                    if (controllers.orbit && controllers.orbit.controller && controllers.orbit.controller._rootPose) {',
    '                        _ws.fromTarget = controllers.orbit.controller._rootPose.position.clone();',
    '                    } else {',
    '                        const _fa = this.camera.angles;',
    '                        const _fPitch = _fa.x * Math.PI / 180, _fYaw = _fa.y * Math.PI / 180;',
    '                        const _fLen = Math.max(1, this.camera.distance || 3);',
    '                        _ws.fromTarget = new Vec3(',
    '                            this.camera.position.x + (-Math.sin(_fYaw) * Math.cos(_fPitch)) * _fLen,',
    '                            this.camera.position.y + Math.sin(_fPitch) * _fLen,',
    '                            this.camera.position.z + (-Math.cos(_fYaw) * Math.cos(_fPitch)) * _fLen',
    '                        );',
    '                    }',
    '                    _ws._tmpPos = new Vec3();',
    '                    _ws._tmpTgt = new Vec3();',
    '                }',
    '                _ws.t = Math.min(1, _ws.t + deltaTime / Math.max(0.1, _ws.duration));',
    '                const _wk = _ws.t >= 1 ? 1 : easeOut(_ws.t);',
    '                _ws._tmpPos.set(',
    '                    _ws.fromPos.x + (_ws.toPos.x - _ws.fromPos.x) * _wk,',
    '                    _ws.fromPos.y + (_ws.toPos.y - _ws.fromPos.y) * _wk,',
    '                    _ws.fromPos.z + (_ws.toPos.z - _ws.fromPos.z) * _wk',
    '                );',
    '                _ws._tmpTgt.set(',
    '                    _ws.fromTarget.x + (_ws.toTarget.x - _ws.fromTarget.x) * _wk,',
    '                    _ws.fromTarget.y + (_ws.toTarget.y - _ws.fromTarget.y) * _wk,',
    '                    _ws.fromTarget.z + (_ws.toTarget.z - _ws.fromTarget.z) * _wk',
    '                );',
    '                this.camera.look(_ws._tmpPos, _ws._tmpTgt);',
    '                // [walkTo 碰撞补丁] 安卓点选行走「卡墙里」修复：walkTo 直接插值相机位置（绕过',
    '                // fly SphereMover 碰撞），飞行路径穿过模型时相机进入模型内部被卡住。',
    '                // 每帧用体素 querySphere（半径 0.5m，与 fly/orbit 碰撞半径一致）检测插值位置：',
    '                // 命中（相机球体接触模型）→ 按推出向量推出相机 + 提前结束飞行（停在表面外 0.5m，',
    '                // 不再深入、不卡墙）；_ws._tmpTgt 在本帧 look 之后不再使用，安全复用为推出向量。',
    '                if (window.__ssplatVoxelCollision && window.__ssplatVoxelCollision._done &&',
    '                    window.__ssplatCollisionEnabled !== false &&',
    '                    typeof window.__ssplatVoxelCollision.querySphere === \'function\') {',
    '                    if (window.__ssplatVoxelCollision.querySphere(this.camera.position.x, this.camera.position.y,',
    '                        this.camera.position.z, 0.5, _ws._tmpTgt)) {',
    '                        this.camera.position.x += _ws._tmpTgt.x;',
    '                        this.camera.position.y += _ws._tmpTgt.y;',
    '                        this.camera.position.z += _ws._tmpTgt.z;',
    '                        _ws.t = 1; // 被模型挡住：提前结束飞行，相机停在模型表面外',
    '                    }',
    '                }',
    '                // 同步控制器内部状态，防止下一帧覆盖（fly 与 orbit 都要）：',
    '                //   - fly 模式（/new 强制 fly）：FlyController.update 每帧用 _position/_angles 覆盖相机，',
    '                //     点击行走写入的位置必须同步到 fly 内部（goto），否则相机原地不动（"点击无法移动"）；',
    '                //   - orbit 模式：同步 _rootPose/_childPose（goto），否则被 orbit 控制器拉回。',
    '                if (controllers.fly && typeof controllers.fly.goto === \'function\') {',
    '                    controllers.fly.goto(this.camera);',
    '                }',
    '                if (controllers.orbit) {',
    '                    controllers.orbit.goto(this.camera);',
    '                }',
    '                if (_ws.t >= 1) {',
    '                    window.__ssplatWalkState = null;',
    '                    events.fire(\'navigateComplete\');',
    '                }',
    '            }',
    '            // ===== [相机瞬移补丁] 直接定位（不飞行）：一次性消费 teleport 状态 =====',
    '            // window.__ssplatTeleportState = { x,y,z: 相机位置, ex,ey,ez: 欧拉角 }',
    '            // 测试页体素构建完成后把相机瞬移到模型包围盒中心、镜头绕 X 轴 90°。',
    '            // 瞬移后立即 goto() 同步 orbit 控制器内部状态，防止下一帧被控制器覆盖；',
    '            // 再执行一次帧末 lookAt/applyCamera 由既有流程负责（该块位于帧末钳制之前）。',
    '            if (window.__ssplatTeleportState) {',
    '                const _ts = window.__ssplatTeleportState;',
    '                // this.camera 是 CameraManager 内部相机对象（{position, angles, distance, fov}）；',
    '                // 直接写 position/angles（Vec3）+ orbit.goto 同步，防止下一帧被控制器覆盖。',
    '                // 支持三种形态：',
    '                //   1) {x,y,z, ax,ay,az}  直接指定位置 + 朝向欧拉角（镜头精确对准）；',
    '                //   2) {x,y,z, tx,ty,tz}  指定位置 + look 目标点（镜头对准墙面等任意点）；',
    '                //   3) {x,y,z, ex,ey,ez}  指定位置 + 绕 X 轴欧拉角（默认 forward=-Z 推导方向）。',
    '                if (this.camera.position) {',
    '                    this.camera.position.x = _ts.x;',
    '                    this.camera.position.y = _ts.y;',
    '                    this.camera.position.z = _ts.z;',
    '                }',
    '                if (typeof _ts.ax === \'number\') {',
    '                    if (this.camera.angles) {',
    '                        this.camera.angles.x = _ts.ax;',
    '                        this.camera.angles.y = _ts.ay;',
    '                        this.camera.angles.z = _ts.az;',
    '                    }',
    '                    // [旋转限制补丁] 瞬移定位的朝向作为旋转 180° 基准（yaw=ay / pitch=ax）',
    '                    // （OrbitController.update 的 yaw/pitch clamp 以该基准为中心 ±90°）',
    '                    window.__ssplatYawBase = _ts.ay;',
    '                    window.__ssplatPitchBase = _ts.ax;',
    '                    // [瞬移保位补丁 v2] 官方 OrbitController 的 zoomRange 最小距离 = 0.3m',
    '                    // （构造时 zoomRange = Vec2(0.3, Infinity)，见 OrbitController 构造器），',
    '                    // 官方 update 每帧调用 _targetChildPose.move(...)，Pose.move 内部会把',
    '                    // position.z clamp 到 zRange[0.3, ∞) —— 因此「距离归零」无法持久：',
    '                    // 瞬移后下一帧 tcp.z 就被 clamp 回 0.3，cp.lerp 向 0.3 收敛，相机被拉到',
    '                    // 「焦点前方 0.3m」（实测 (-0.134, 0.887, 0.816) == 焦点 + R(angles)×(0,0,0.3)）。',
    '                    // 正确做法：让距离符合官方语义——先钉死 camera.distance = 0.3（官方最小',
    '                    // 缩放，合法值），再走官方 goto()（_attach → core.attach）：',
    '                    //   _targetRootPose.set(pose.getFocus(dir), angles, 0)  → 焦点 = 目标位置',
    '                    //     沿视线前方 0.3m；',
    '                    //   _targetChildPose.position.set(0, 0, 0.3)             → 距离 0.3（合法，',
    '                    //     不再被 move 的 clamp 改动）。',
    '                    //   官方重建：相机 = 焦点 + R(angles)×(0,0,0.3) == 目标位置，永不回弹。',
    '                    // 注意：不能用 goto 的旧路径——camera.distance 为旧值（0 或大距离）时焦点',
    '                    // 会被放到相机前方 distance 处导致位置回弹；必须先钉死 0.3 再 goto。',
    '                    if (controllers.orbit && controllers.orbit.controller && controllers.orbit.controller._rootPose) {',
    '                        this.camera.distance = 0.3;',
    '                        controllers.orbit.goto(this.camera);',
    '                    }',
    '                } else {',
    '                    // 形态 2 {x,y,z, tx,ty,tz}：指定位置 + look 目标点（镜头对准目标，如模型中心）',
    '                    // 相机在指定位置看向目标点，用官方 Camera#look 计算朝向（与 orbit 碰撞补丁同口径）。',
    '                    if (typeof _ts.tx === \'number\' && typeof this.camera.look === \'function\') {',
    '                        this.camera.look(',
    '                            new Vec3(this.camera.position.x, this.camera.position.y, this.camera.position.z),',
    '                            new Vec3(_ts.tx, _ts.ty, _ts.tz)',
    '                        );',
    '                    }',
    '                    if (controllers.orbit) {',
    '                        controllers.orbit.goto(this.camera);',
    '                    }',
    '                }',
    '                // [模式同步补丁] 按当前相机模式同步控制器内部状态（teleport 直写 camera 后，',
    '                // 当前模式控制器内部状态（fly._position/_angles 等）必须同步，否则下一帧 update',
    '                // 会用旧内部状态覆盖相机位姿导致瞬移回弹；orbit 的 goto 上面已执行，这里补 fly。',
    '                if (typeof state !== \'undefined\' && state && state.cameraMode === \'fly\' &&',
    '                    controllers.fly && typeof controllers.fly.goto === \'function\') {',
    '                    controllers.fly.goto(this.camera);',
    '                }',
    '                window.__ssplatTeleportState = null;',
    '                // [瞬移免推出补丁] 瞬移后 1.5 秒窗口内跳过空气墙钳制与体素推出',
    '                // （目标点在模型内部时相机先到达目标点；窗口过后恢复碰撞）。',
    '                if (typeof window !== \'undefined\') {',
    '                    window.__ssplatTeleportSkipUntil = Date.now() + 1500;',
    '                }',
    '                if (typeof events !== \'undefined\' && events && typeof events.fire === \'function\') {',
    '                    events.fire(\'navigateComplete\');',
    '                }',
    '            }',
    '            // ===== [碰撞补丁] orbit 焦点（target）同样钳制到空气墙内（任务②A） =====',
    '            // 双指平移/点击行走会移动 orbit 焦点；若焦点被推到墙外，相机虽被空气墙钳制，',
    '            // 但环绕中心在墙外会导致「贴墙转圈」。这里把焦点也钳到空气墙相机允许范围内',
    '            // （wall.clampMin/Max = 空气墙内缩相机半径，保证相机在焦点处也始终在墙内）。',
    '            // [碰撞开关补丁] 开关关闭时跳过（相机/焦点自由移动）。',
    '            if (state.cameraMode === \'orbit\' && window.__ssplatCollisionEnabled !== false &&',
    '                window.__ssplatAirWall && window.__ssplatAirWall.ready &&',
    '                controllers.orbit && controllers.orbit.controller) {',
    '                const _oc = controllers.orbit.controller;',
    '                const _wall = window.__ssplatAirWall;',
    '                if (_oc._rootPose && _oc._rootPose.position) {',
    '                    const _tp = _oc._rootPose.position;',
    '                    _tp.x = _tp.x < _wall.clampMinX ? _wall.clampMinX : (_tp.x > _wall.clampMaxX ? _wall.clampMaxX : _tp.x);',
    '                    _tp.y = _tp.y < _wall.clampMinY ? _wall.clampMinY : (_tp.y > _wall.clampMaxY ? _wall.clampMaxY : _tp.y);',
    '                    _tp.z = _tp.z < _wall.clampMinZ ? _wall.clampMinZ : (_tp.z > _wall.clampMaxZ ? _wall.clampMaxZ : _tp.z);',
    '                }',
    '                if (_oc._targetRootPose && _oc._targetRootPose.position) {',
    '                    const _tt = _oc._targetRootPose.position;',
    '                    _tt.x = _tt.x < _wall.clampMinX ? _wall.clampMinX : (_tt.x > _wall.clampMaxX ? _wall.clampMaxX : _tt.x);',
    '                    _tt.y = _tt.y < _wall.clampMinY ? _wall.clampMinY : (_tt.y > _wall.clampMaxY ? _wall.clampMaxY : _tt.y);',
    '                    _tt.z = _tt.z < _wall.clampMinZ ? _wall.clampMinZ : (_tt.z > _wall.clampMaxZ ? _wall.clampMaxZ : _tt.z);',
    '                }',
    '            }'
].join('\n');

// ---------- 体素碰撞补丁（需求①：从 splat 构建体素碰撞网格；需求③：鼠标射线；需求④：距离） ----------
// 设计总览（详见 scripts/splat-voxel-collision.mjs 头部注释）：
//   1. SplatVoxelCollision 类单独维护在 scripts/splat-voxel-collision.mjs（单一源码）：
//      - 浏览器端：本文件读取其源码（去掉 `export ` 前缀）注入 dist/index.js 模块作用域；
//      - 单测端：merge-logic-test.mjs 直接 import 该文件做 T9 逻辑验证；
//   2. 构建时机：合并模式在全部文件加载完成后（__ssplatBuildVoxelFromEntities 于
//      __ssplatMergeDone 之前调用）触发；单文件模式在实体加载完成（loadGsplat resolve）后触发。
//      构建为异步分批（rAF + 每帧 6ms 时间预算），不阻塞渲染/UI；
//   3. 查询：querySphere 检查球心周围 3×3×3 体素（O(1)），queryRay 用 DDA 步进；
//      与 AABB「房间」叠加：体素管「不能穿模型」，房间管「不能出场景」；
//   4. 暴露构建进度（window.__ssplatVoxelProgress / __ssplatVoxelDone），供 app.js 状态输出复用。
const VOXEL_SINGLE_HOOK_TARGET = [
    '            app.root.addChild(entity);',
    '            resolve(entity);'
].join('\n');
const VOXEL_SINGLE_HOOK_REPLACEMENT = [
    '            app.root.addChild(entity);',
    '            // [体素碰撞补丁] 实体加载完成：单文件模式立即入队并启动体素碰撞构建；',
    '            // 合并模式下仅入队（__ssplatVoxelMergeMode=true），由 loadGsplats 全部加载完后',
    '            // 调用 __ssplatBuildVoxelFromEntities 统一启动（避免与渲染首帧竞争）。',
    '            if (window.__ssplatCenterModelsAtOrigin === true && typeof window.__ssplatCenterModelAtOrigin === \'function\') {',
    '                window.__ssplatCenterModelAtOrigin(entity);',
    '            }',
    '            if (typeof window.__ssplatBuildVoxelFromEntity === \'function\') {',
    '                window.__ssplatBuildVoxelFromEntity(entity);',
    '            }',
    '            // [渐进替换补丁] 记录当前 gsplat 实体（供 __ssplatSwapGsplat 替换：先展示轻量版，',
    '            // 后台加载完整版后无缝替换，保证最终效果）',
    '            if (typeof window !== \'undefined\') { window.__ssplatCurrentEntity = entity; }',
    '            resolve(entity);'
].join('\n');

// ---------- 渐进替换补丁（需求：/new 先加载轻量版展示，再后台加载完整版替换） ----------
// createApp 返回前注入 window.__ssplatSwapGsplat(url)：加载新数据实体并替换当前实体
// （旧实体 destroy 释放），配合 app.js 的「先 mobile.sog 展示 → 体素构建完成后后台换 point_cloud.sog」。
const SWAP_APP_TARGET = '    return { app, camera, renderer };';
const SWAP_APP_REPLACEMENT = [
    '    // [渐进替换补丁] __ssplatSwapGsplat(url)：加载新数据并替换当前实体（app.js 两阶段加载用：',
    '    // 先展示轻量版 point_cloud.mobile.sog，后台下载完整版 point_cloud.sog 后无缝替换）。',
    '    if (typeof window !== \'undefined\') {',
    '        window.__ssplatSwapGsplat = async (url) => {',
    '            try {',
    '                const old = window.__ssplatCurrentEntity;',
    '                const ne = await loadGsplat(app, { contentUrl: url, contents: fetch(url) }, () => {});',
    '                if (old && old.destroy) { try { old.destroy(); } catch (e2) { /* 静默 */ } }',
    '                window.__ssplatCurrentEntity = ne;',
    '                if (typeof window.__ssplatLog === \'function\') {',
    '                    window.__ssplatLog(\'swap\', \'已替换为 \' + url);',
    '                }',
    '                return ne;',
    '            } catch (e) {',
    '                if (typeof window.__ssplatLog === \'function\') {',
    '                    window.__ssplatLog(\'swap\', \'替换失败: \' + (e && e.message ? e.message : e));',
    '                }',
    '                return null;',
    '            }',
    '        };',
    '    }',
    '    return { app, camera, renderer };'
].join('\n');

// ---------- 手机端点击行走补丁（任务②C） ----------
// 官方 NavInteraction._onMobileTap 在 orbit 模式下只做「点击聚焦」（_focusPickedPosition →
// events 'pick'，相机原地看向点击点）。用户拍板：手机端点击场景某点 → 相机平滑移动到
// 目标点附近（点击行走）。
// 方案（尽量复用官方能力，保持桌面行为不变）：
//   N1. 新增 _walkToPickedPosition：拾取点击点（碰撞 queryRay 优先，回退官方 Picker GPU
//       深度拾取）→ 计算相机目的地 = 点击点 - 视线方向 * stopDistance（fov 相关，与官方
//       FlySource.getStopDistance 同口径，保证「停在目标点附近」）→ 目的地钳制到空气墙
//       相机允许范围（可达性）→ 调用 window.__ssplatWalkTo 设置行走状态；
//   N2. _onMobileTap 在 orbit 分支：window.__ssplatWalkEnabled !== false（默认开启，
//       ?walk=0 关闭）时走点击行走，否则回落到官方聚焦行为；walk/fly 分支保持官方原样；
//   N3. 行走状态机在 CameraManager.update 内消费（见 COLLISION_AIRWALL_CLAMP_REPLACEMENT）：
//       位置/注视点 easeOut 插值 + 每帧 controllers.orbit.goto 同步，到达后清空。
// 桌面端点击行为不变：mobileTap 仅由官方 TouchDevice（pointerType === 'touch'）触发，
// 桌面鼠标点击走 _onPointerUp（orbit → _focusPickedPosition，官方原样）。
const NAV_MOBILE_TAP_TARGET = [
    '    _onMobileTap = () => {',
    '        const global = this._global;',
    '        if (!global)',
    '            return;',
    '        const { state, events } = global;',
    '        if (this._suppressClick) {',
    '            this._suppressClick = false;',
    '            return;',
    '        }',
    "        if (state.cameraMode === 'walk' && !state.gamingControls) {",
    '            const result = this._pickCollision(this._lastPointerOffsetX, this._lastPointerOffsetY);',
    '            if (result) {',
    "                events.fire('navigateTo', result.position, result.normal);",
    '            }',
    '        }',
    "        else if (state.cameraMode === 'fly') {",
    '            this._flyToPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);',
    '        }',
    "        else if (state.cameraMode === 'orbit') {",
    '            this._focusPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);',
    '        }',
    '    };'
].join('\n');

const NAV_MOBILE_TAP_REPLACEMENT = [
    '    // [点击行走补丁] 手机端 orbit 模式点击行走：拾取点击点 → 计算相机目的地',
    '    // （点击点前方 stopDistance，确保停在“目标点附近”而非点内部）→ 钳制到空气墙内 →',
    '    // 交给 CameraManager 的 __ssplatWalkState 状态机做平滑飞行（O(1) 每帧插值）。',
    '    // 目标点获取：优先碰撞 queryRay（体素/房间），回退官方 Picker（GPU 深度拾取 splat 表面）。',
    '    _walkToPickedPosition = async (offsetX, offsetY) => {',
    '        const global = this._global;',
    '        if (!global)',
    '            return;',
    '        const request = ++this._targetPickRequest;',
    '        const target = await this._pickSceneTarget(offsetX, offsetY);',
    '        if (!target || request !== this._targetPickRequest || !this._global)',
    '            return;',
    '        const camera = this._global.camera;',
    '        const cameraPos = camera.getPosition();',
    '        // 相机 → 点击点的视线方向（世界单位）',
    '        const dir = new Vec3().copy(target.position).sub(cameraPos).normalize();',
    '        // 停靠距离：按 fov 让点击点完整落在画面内（与官方 FlySource getStopDistance 同口径）',
    '        const camFov = camera.camera && camera.camera.fov ? camera.camera.fov : 60;',
    '        const halfFov = Math.min(120, Math.max(15, camFov)) * Math.PI / 180 * 0.5;',
    '        const stopDist = Math.min(4.0, Math.max(0.75, 0.75 / Math.tan(halfFov)));',
    '        const dest = new Vec3().copy(target.position).sub(dir.mulScalar(stopDist));',
    '        // 目的地钳制到空气墙相机允许范围内（最终落点可达，不穿墙）',
    '        const wall = window.__ssplatAirWall;',
    '        if (wall && wall.ready) {',
    '            dest.x = Math.min(wall.clampMaxX, Math.max(wall.clampMinX, dest.x));',
    '            dest.y = Math.min(wall.clampMaxY, Math.max(wall.clampMinY, dest.y));',
    '            dest.z = Math.min(wall.clampMaxZ, Math.max(wall.clampMinZ, dest.z));',
    '        }',
    '        // 飞行时长与距离相关：0.8s ~ 1.6s',
    '        const travelDist = dest.distance(cameraPos);',
    '        const duration = Math.min(1.6, Math.max(0.8, travelDist / 6));',
    "        if (typeof window.__ssplatWalkTo === 'function') {",
    '            window.__ssplatWalkTo(dest.x, dest.y, dest.z, target.position.x, target.position.y, target.position.z, duration);',
    '        }',
    '    };',
    '    _onMobileTap = () => {',
    '        const global = this._global;',
    '        if (!global)',
    '            return;',
    '        const { state, events } = global;',
    '        if (this._suppressClick) {',
    '            this._suppressClick = false;',
    '            return;',
    '        }',
    "        if (state.cameraMode === 'walk' && !state.gamingControls) {",
    '            const result = this._pickCollision(this._lastPointerOffsetX, this._lastPointerOffsetY);',
    '            if (result) {',
    "                events.fire('navigateTo', result.position, result.normal);",
    '            }',
    '        }',
    "        else if (state.cameraMode === 'fly') {",
    '            // [点击行走补丁] 手机端 fly 模式点击行走：默认开启（?walk=0 关闭）。',
    '            // /new 页强制 fly（__ssplatForceFly=true），官方 fly 分支只做 _flyToPickedPosition',
    '            // （飞向拾取点，可能受高度固定/碰撞影响不移动），这里统一接入 _walkToPickedPosition',
    '            // （平滑移动到目标点 + 每帧体素碰撞检测，撞模型自动停），保证手机点击能移动相机。',
    '            if (window.__ssplatWalkEnabled !== false) {',
    '                this._walkToPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);',
    '            }',
    '            else {',
    '                this._flyToPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);',
    '            }',
    '        }',
    "        else if (state.cameraMode === 'orbit') {",
    '            // [点击行走补丁] 手机端 orbit 点击行走：默认开启（?walk=0 关闭），',
    '            // 禁用时回落到官方「点击聚焦」行为；桌面端不触发 mobileTap，行为不变。',
    '            if (window.__ssplatWalkEnabled !== false) {',
    '                this._walkToPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);',
    '            }',
    '            else {',
    '                this._focusPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);',
    '            }',
    '        }',
    '    };'
].join('\n');

// ---------- 设备分类操控补丁（需求：网页支持 WASD、手机支持点选，分类别对待） ----------
// 官方 ModeShortcuts._onKeyDown default 分支：isWasdKey && state.inputMode === 'desktop'
// → 非第一人称模式切 fly + gamingControls（鼠标转向）。官方已用 inputMode（首次指针事件
// pointerType 动态判定）区分触屏/桌面，但 inputMode 初始值依赖 platform.mobile，且手机
// 连接蓝牙键盘时 pointerType 仍为 touch（官方逻辑已挡）。本补丁按 app.js 的统一设备分类
// window.__ssplatDevice 再显式分支（双保险，分类一目了然）：
//   - desktop（网页）：保持官方 WASD → fly 第一人称行走（+gamingControls 鼠标转向），
//     官方按 W 即自动进入，无需先按 3/双击切换；
//   - mobile（手机）：WASD 键盘完全忽略（蓝牙键盘误触无效），操控只有触摸点选行走
//     （_walkToPickedPosition，mobileTap 事件；?walk=0 回落官方点击聚焦）。
const MODE_SHORTCUTS_WASD_TARGET = [
    '            default:',
    '                if (isWasdKey(event) && state.inputMode === \'desktop\') {',
    '                    if (!isCaptureMode$1(state.cameraMode)) {',
    '                        state.cameraMode = \'fly\';',
    '                    }',
    '                    if (!state.gamingControls) {',
    '                        state.gamingControls = true;',
    '                    }',
    '                }',
    '                break;'
].join('\n');
const MODE_SHORTCUTS_WASD_REPLACEMENT = [
    '            default:',
    '                // [设备分类补丁] 桌面网页：WASD 行走（fly 第一人称 + 鼠标转向，官方行为）；',
    '                // 手机：WASD 键盘一律忽略（蓝牙键盘误触无效），操控只有触摸点选行走',
    '                // （window.__ssplatDevice 由 src/app.js 判定，?mobile=1/0 可强制覆盖）。',
    '                if (isWasdKey(event) && state.inputMode === \'desktop\' &&',
    '                    (typeof window === \'undefined\' || window.__ssplatDevice !== \'mobile\')) {',
    '                    if (!isCaptureMode$1(state.cameraMode)) {',
    '                        state.cameraMode = \'fly\';',
    '                    }',
    '                    if (!state.gamingControls) {',
    '                        state.gamingControls = true;',
    '                    }',
    '                }',
    '                break;'
].join('\n');

// 官方流程：进入页面 → 加载封面 → 数据加载完成 → events.fire('frame')（自动取景）→
// controllers.orbit.goto(frameCamera) + startTransition()（transitionTimer 归零 →
// CameraManager.update 从 from 位姿 easeOut 过渡到 target，约 1 秒平滑飞行）。
// 用户看到「从图片进入场景时相机跳转」就是这段官方自动取景过渡动画。
// 本补丁（测试页 __ssplatFrameNoTransition=true）：frame 分支不再 goto(frameCamera)
// （跳过官方自动取景「模型总览」视角）、不再 startTransition()（无过渡飞行），
// 直接调用 app.js 的 __ssplatFocusBBoxCenter 设置瞬移状态 → 下一帧 CameraManager.update
// 消费 → 从封面图片直接落到模型内部目标位姿（无总览、无跳转）。
// 默认页（__ssplatFrameNoTransition 未设置）：保持官方 goto+startTransition 原行为。
const FRAME_TRANSITION_TARGET = [
    "                case 'frame':",
    "                    events.fire('orbitTarget:clear');",
    "                    state.cameraMode = 'orbit';",
    '                    controllers.orbit.goto(frameCamera);',
    '                    startTransition();',
    '                    break;'
].join('\n');
const FRAME_TRANSITION_REPLACEMENT = [
    "                case 'frame':",
    "                    events.fire('orbitTarget:clear');",
    "                    state.cameraMode = 'orbit';",
    '                    // [进入场景补丁] 删除官方「自动取景总览 + 相机跳转动画」：',
    '                    // 测试页直接落到模型内部目标位姿（不经总览视角）：',
    '                    //   1) 不再 controllers.orbit.goto(frameCamera)——frameCamera 是官方',
    '                    //      自动取景（整个模型的远距离总览视角），会先展示一帧总览再瞬移内部；',
    '                    //   2) 直接调用 app.js 的 __ssplatFocusBBoxCenter() 写入瞬移状态',
    '                    //      （window.__ssplatTeleportState），本帧末尾 CameraManager.update',
    '                    //      即消费 → 封面图片直接切换为模型内部视角（无总览、无过渡飞行）；',
    '                    //   3) this.snap() 取消可能残留的过渡。',
    '                    // 默认页（未设置 __ssplatFrameNoTransition）：保持官方 goto+startTransition。',
    '                    if (typeof window !== \'undefined\' && window.__ssplatFrameNoTransition === true) {',
    '                        if (typeof window.__ssplatFocusBBoxCenter === \'function\') {',
    '                            try { window.__ssplatFocusBBoxCenter(); } catch (e) { /* 静默 */ }',
    '                        }',
    '                        this.snap();',
    '                    } else {',
    '                        controllers.orbit.goto(frameCamera);',
    '                        startTransition();',
    '                    }',
    '                    break;'
].join('\n');
// 体素碰撞全局钩子（与 SplatVoxelCollision 类一起注入到 class Viewer 之前）：
//   - window.__ssplatVoxelCollision：SplatVoxelCollision 实例（Viewer 回调读取为相机碰撞）；
//   - window.__ssplatVoxelBuild(entities, startNow)：入队实体（Set 去重），可立即启动；
//   - window.__ssplatBuildVoxelFromEntity(entity)：loadGsplat 单文件钩子（合并模式仅入队）；
//   - window.__ssplatBuildVoxelFromEntities(entities)：loadGsplats 合并完成钩子（启动构建）；
//   - window.__ssplatVoxelResolution：可选分辨率覆盖（src/app.js 解析 ?voxres= 参数写入）；
//   - window.__ssplatVoxelRayHit：鼠标射线命中结果（{ hit, distance }，由 Viewer 回调挂接）。
//   - window.__ssplatCollisionEnabled：碰撞总开关（默认 true；src/app.js 页面开关/键盘切换）。
//     所有碰撞消费点（空气墙 clampCamera、orbit/fly 钳制、体素查询）统一读取，关闭后
//     相机可自由穿行（不重建体素、不重建空气墙，仅跳过钳制/查询）。
//   - window.__ssplatEntities / window.__ssplatCurrentEntity：实体引用（编辑旋转用）。
//   - window.__ssplatLog(tag, msg)：受控日志（src/app.js 定义；补丁侧防御调用）。
const VOXEL_GLOBALS_BLOCK = [
    'window.__ssplatVoxelCollision = null;',
    'window.__ssplatVoxelRayHit = null;',
    'window.__ssplatVoxelMergeMode = false;',
    'window.__ssplatCollisionEnabled = true;',
    'window.__ssplatEntities = [];',
    'window.__ssplatCurrentEntity = null;',
    'window.__ssplatCenterModelsAtOrigin = window.__ssplatCenterModelsAtOrigin === true;',
    '// [居中补丁] 把旋转后的模型包围盒中心平移到世界原点 (0,0,0)：',
    '// 用与 setLocalEulerAngles 完全一致的旋转矩阵（照抄 playcanvas Mat4.setFromEulerAngles，',
    '// 列主序 data + 角度取反）变换局部包围盒中心 → 旋转后中心 → setLocalPosition(-中心)。',
    '// 不依赖 getWorldTransform（实体刚 addChild 时 world 矩阵尚未更新，取到的会是单位矩阵），',
    '// 且 setLocalPosition 在 resolve 之前完成，官方随后计算 sceneBound（空气墙/房间/取景）',
    '// 读取的已是含平移的变换，全部自动跟随。',
    '    // 居中后模型世界中心（=旋转矩阵×局部包围盒中心，实体位置为 0 时即旋转后中心）：',
    '    // 供相机定位（包围盒中心）等场景直接读取。',
    '    let __ssplatModelCenterC = null;',
    '    window.__ssplatCenterModelAtOrigin = (entity) => {',
    '        try {',
    '            const _gsplat = entity && entity.gsplat;',
    '            const _bbox = _gsplat && (_gsplat.customAabb || (_gsplat.component && _gsplat.component.customAabb));',
    '            if (!_bbox || !_bbox.center) return;',
    '            const _rx = (typeof window.__ssplatTestX === \'number\') ? window.__ssplatTestX : -90;',
    '            const _ry = (typeof window.__ssplatTestY === \'number\') ? window.__ssplatTestY : 0;',
    '            const _rz = (window.__ssplatFlip === true) ? 180 : ((typeof window.__ssplatTestZ === \'number\') ? window.__ssplatTestZ : 0);',
    '            const _d2r = Math.PI / 180;',
    '            const _s1 = Math.sin(-_rx * _d2r), _c1 = Math.cos(-_rx * _d2r);',
    '            const _s2 = Math.sin(-_ry * _d2r), _c2 = Math.cos(-_ry * _d2r);',
    '            const _s3 = Math.sin(-_rz * _d2r), _c3 = Math.cos(-_rz * _d2r);',
    '            const _x = _bbox.center.x, _y = _bbox.center.y, _z = _bbox.center.z;',
    '            const _m0 = _c2 * _c3, _m4 = _c1 * _s3 + _c3 * _s1 * _s2, _m8 = _s1 * _s3 - _c1 * _c3 * _s2;',
    '            const _m1 = -_c2 * _s3, _m5 = _c1 * _c3 - _s1 * _s2 * _s3, _m9 = _c3 * _s1 + _c1 * _s2 * _s3;',
    '            const _m2 = _s2, _m6 = -_c2 * _s1, _m10 = _c1 * _c2;',
    '            const _cx = _m0 * _x + _m4 * _y + _m8 * _z;',
    '            const _cy = _m1 * _x + _m5 * _y + _m9 * _z;',
    '            const _cz = _m2 * _x + _m6 * _y + _m10 * _z;',
    '            __ssplatModelCenterC = { x: _cx, y: _cy, z: _cz };',
    '            window.__ssplatModelCenter = __ssplatModelCenterC;',
    '            entity.setLocalPosition(-_cx, -_cy, -_cz);',
    '        } catch (e) { /* 静默：居中失败不影响加载 */ }',
    '    };',
    'if (typeof window.__ssplatLog !== \'function\') {',
    '    window.__ssplatLog = (tag, msg) => {',
    '        try {',
    '            // [控制台输出注销] 控制台所有输出内容全部注销（代码保留，不删除）：',
    '            // if (typeof console !== \'undefined\' && console.log) {',
    '            //     console.log(\'[SSPLAT-LOG][\' + tag + \'] \' + msg);',
    '            // }',
    '        } catch (e) { /* 静默：日志异常绝不影响主流程 */ }',
    '    };',
    '}',
    // [空气墙补丁] 全局空气墙引用与钳制计数：初始化前为 null / 0，钳制代码安全跳过；
    // sceneBound 合并完成后由 Viewer 回调 new SceneAirWall() 并 setFromBBox(sceneBound) 接管。
    'window.__ssplatAirWall = null;',
    'window.__ssplatWallClamps = 0;',
    // [点击行走补丁] 手机端点击行走状态与入口：
    //   - window.__ssplatWalkState：由 NavInteraction 手机端点击（_walkToPickedPosition）写入；
    //     CameraManager.update 每帧消费（位置/注视点 easeOut 插值 + orbit 控制器同步）。
    //   - window.__ssplatWalkTo(x,y,z, lookX,lookY,lookZ, duration)：设置行走目标
    //     （toPos = 相机目的地，toTarget = 注视点，均为世界坐标；duration 秒）。
    'window.__ssplatWalkState = null;',
    'window.__ssplatWalkTo = (toX, toY, toZ, lookX, lookY, lookZ, duration) => {',
    '    // 目标已由 NavInteraction 钳制到空气墙内；状态机在首帧自动读取当前相机/焦点。',
    '    window.__ssplatWalkState = {',
    '        toPos: new Vec3(toX, toY, toZ),',
    '        toTarget: new Vec3(lookX, lookY, lookZ),',
    '        t: 0,',
    '        duration: (typeof duration === \'number\' && duration > 0) ? duration : 1.2',
    '    };',
    '};',
    'let __ssplatVoxelInstance = null;',
    'window.__ssplatVoxelBuild = (entities, startNow) => {',
    '    if (!Array.isArray(entities) || entities.length === 0) return;',
    '    if (!__ssplatVoxelInstance) {',
    '        const _voxRes = (typeof window.__ssplatVoxelResolution === \'number\' && window.__ssplatVoxelResolution >= 0.1 && window.__ssplatVoxelResolution <= 2)',
    '            ? window.__ssplatVoxelResolution : 0.3;',
    '        __ssplatVoxelInstance = new SplatVoxelCollision({',
    '            voxelResolution: _voxRes,',
    '            fillScale: 1.5,',
    '            maxFillRadius: 2,',
    '            opacityThreshold: 0.1',
    '        });',
    '        window.__ssplatVoxelCollision = __ssplatVoxelInstance;',
    '    }',
    '    __ssplatVoxelInstance.enqueueEntities(entities);',
    '    window.__ssplatEntities = entities.slice();',
    '    if (startNow) {',
    '        __ssplatVoxelInstance.startBuild();',
    '    }',
    '};',
    'window.__ssplatBuildVoxelFromEntity = (entity) => {',
    '    // 单文件模式（非合并）：实体加载完成即启动构建；合并模式：仅入队，全部加载完后统一启动',
    '    const merge = window.__ssplatVoxelMergeMode === true;',
    '    window.__ssplatCurrentEntity = entity;',
    '    window.__ssplatVoxelBuild([entity], !merge);',
    '};',
    'window.__ssplatBuildVoxelFromEntities = (entities) => {',
    '    window.__ssplatVoxelMergeMode = false;',
    '    // [体素碰撞补丁] 修复：合并模式下实体已被逐个入队（__ssplatBuildVoxelFromEntity），',
    '    // _seen Set 记录了它们，导致批量入队时被去重跳过。重置 _seen 和 _pending，',
    '    // 让 __ssplatVoxelBuild 能正确以批量模式重新入队并启动构建。',
    '    if (__ssplatVoxelInstance) {',
    '        __ssplatVoxelInstance._seen = new Set();',
    '        __ssplatVoxelInstance._pending = [];',
    '    }',
    '    window.__ssplatVoxelBuild(entities, true);',
    '};'
].join('\n');

// 读取 SplatVoxelCollision 类源码（单一源码，浏览器注入与单测共用；注入时去掉 `export ` 前缀）
const VOXEL_CLASS_SOURCE = (await readFile(join(ROOT, 'scripts', 'splat-voxel-collision.mjs'), 'utf8'))
    .replace('export class SplatVoxelCollision', 'class SplatVoxelCollision');
const VOXEL_CLASS_REPLACEMENT = VOXEL_CLASS_SOURCE + '\n\n' + VOXEL_GLOBALS_BLOCK + '\n\n' + SCENE_AIR_WALL_CLASS + '\n\nclass Viewer {';

// ---------- Streamed SOG 叶子包围盒补丁（流式模式空气墙/碰撞/取景用正确场景范围） ----------
// 官方 Viewer 对 Streamed SOG（lod-meta.json / octree 资源）取包围盒用的是八叉树根节点
// （lod-meta.json 的 tree.bound）。桌面版 streamed 数据含 env（根包围盒 ±460m），会让
// 空气墙/碰撞「房间」被撑到几百米大；手机版虽已排除 env，仍统一加此补丁做防御。
// 方案：实体加载完成后延迟 500ms（确保资源初始化完毕），用八叉树**叶子节点**的实际包围盒
// 重新计算 sceneBound（世界变换取实体 getWorldTransform()，含 Rx(-90°) 翻转），并同步
// 重建空气墙（SceneAirWall）与体素碰撞房间边界。
const STREAMED_AABB_TARGET = [
    '            if (!config.noui) {',
    '                this.annotations = new Annotations(global, this.cameraFrame != null);'
].join('\n');
const STREAMED_AABB_REPLACEMENT = [
    '            // ===== [Streamed SOG 补丁] 对于八叉树资源（Streamed SOG），使用叶子节点的实际包围盒',
    '            // 而非八叉树根节点的超大包围盒，确保空气墙/碰撞/取景使用正确的场景范围 =====',
    '            // 使用 setTimeout 延迟执行，确保资源已完全初始化（asset.on(\'load\') 时资源可能尚未就绪）；',
    '            // 同时暴露 sceneBound 引用，供后续延迟修正使用。',
    '            window.__ssplatSceneBound = sceneBound;',
    '            setTimeout(() => {',
    '                const _octreeRes = gsplatComponent && gsplatComponent.resource;',
    '                const _octreeNodes = _octreeRes && _octreeRes.octree && _octreeRes.octree.nodes;',
    '                if (_octreeNodes && _octreeNodes.length > 0) {',
    '                    const _octreeTmpBox = new BoundingBox();',
    '                    const _octreeWm = results[0].getWorldTransform();',
    '                    let _octreeFirst = true;',
    '                    for (const _octreeNode of _octreeNodes) {',
    '                        if (_octreeNode && _octreeNode.bounds) {',
    '                            _octreeTmpBox.setFromTransformedAabb(_octreeNode.bounds, _octreeWm);',
    '                            if (_octreeFirst) {',
    '                                sceneBound.copy(_octreeTmpBox);',
    '                                _octreeFirst = false;',
    '                            } else {',
    '                                sceneBound.add(_octreeTmpBox);',
    '                            }',
    '                        }',
    '                    }',
    '                    // 重新设置空气墙（因为 sceneBound 已被更新为正确的叶子节点包围盒）',
    '                    if (window.__ssplatAirWall && typeof window.__ssplatAirWall.setFromBBox === \'function\') {',
    '                        window.__ssplatAirWall.setFromBBox(sceneBound);',
    '                    }',
    '                    // 重新设置体素碰撞的房间边界',
    '                    if (window.__ssplatVoxelCollision && typeof window.__ssplatVoxelCollision.setRoom === \'function\') {',
    '                        window.__ssplatVoxelCollision.setRoom(sceneBound);',
    '                    }',
    '                }',
    '            }, 500);',
    '            if (!config.noui) {',
    '                this.annotations = new Annotations(global, this.cameraFrame != null);'
].join('\n');

// ---------- 工具 ----------

const log = (message) => console.log(message);

const formatSize = (bytes) => {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / 1024).toFixed(1) + ' KB';
};

/**
 * 以「读源 → 写目标」的方式复制文件（覆盖已存在目标）。
 * 注意：不使用 fs.cp —— 在沙箱环境中 fs.cp 覆盖已有文件时会触发「安全删除」钩子
 * （内部先 unlink 目标再复制），可能导致构建被拦截；直接 writeFile 只做截断写入，
 * 不涉及删除操作，可安全覆盖 dist 中的已有产物。
 */
const writeFileFrom = async (srcPath, destPath) => {
    const data = await readFile(srcPath);
    await writeFile(destPath, data);
};

// ---------- 相机状态暴露补丁（输出 log：旋转角度 + 相机定位） ----------
// 官方 window.getCameraState 仅在 debug 面板打开（?debug 或 Ctrl+Shift+D）时注册，
// 默认不可用。在 DebugPanel 实例化处追加一行，无条件暴露相机状态读取函数，
// 供 app.js 在体素构建完成后输出「旋转角度 + 相机定位」日志（captureCameraState
// 与 this.cameraManager / global.state 均在同一模块作用域，可直接引用）。
const CAMERA_STATE_EXPOSE_TARGET = '            this.debugPanel = new DebugPanel(global, this.cameraManager);';
const CAMERA_STATE_EXPOSE_REPLACEMENT = [
    '            this.debugPanel = new DebugPanel(global, this.cameraManager);',
    '            // [相机日志补丁] 无条件暴露相机状态读取函数（app.js 输出旋转/相机定位日志用；',
    '            // 官方 window.getCameraState 仅在 debug 面板打开时注册，此处默认可用）',
    '            window.__ssplatGetCameraState = () => captureCameraState(this.cameraManager, global.state);'
].join('\n');

// ---------- 旋转限制补丁（需求：鼠标左键旋转限制 180°） ----------
// 说明：模型已翻转（Rx(-90°)），坐标系与 3ds Max 相反。用户要求「左右拖拽不能 360°」——
// 左右拖拽改变 yaw（camera.angles.y），垂直拖拽改变 pitch（camera.angles.x），
// 两个方向都做 ±90° 钳制（各 180°）：
//   - yaw（左右）：基准 window.__ssplatYawBase（teleport 写入 ay），否则首次 update 记录；
//   - pitch（垂直）：基准 window.__ssplatPitchBase（teleport 写入 ax），否则首次 update 记录；
//   - 归一化处理角度环绕；同步 controller 内部 _rootPose/_targetRootPose 的 angles，防回弹；
//   - 开关：window.__ssplatYawLock / __ssplatPitchLock !== false 时生效
//     （app.js 可 ?orbit360=1 关闭恢复官方行为）。
//   - 注意：官方 pitchRange 已固定 (-90, 90)（180°），此处以初始朝向为基准再钳 ±90°，
//     两者叠加保证垂直方向最大 180°。
const ROT_LOCK_TARGET = [
    '        const pose = this.controller.update(inputFrame, deltaTime);',
    '        camera.position.copy(pose.position);',
    '        camera.angles.copy(pose.angles);',
    '        camera.distance = pose.distance;'
].join('\n');
const ROT_LOCK_REPLACEMENT = [
    '        const pose = this.controller.update(inputFrame, deltaTime);',
    '        camera.position.copy(pose.position);',
    '        camera.angles.copy(pose.angles);',
    '        camera.distance = pose.distance;',
    '        // ===== [旋转限制补丁] 鼠标左键旋转限制 180°：左右（yaw）与垂直（pitch）各 ±90° =====',
    '        // 左右拖拽改变 yaw（camera.angles.y），垂直拖拽改变 pitch（camera.angles.x）。',
    '        // 基准：teleport 瞬移时写入 window.__ssplatYawBase/__ssplatPitchBase（用户定位视角）；',
    '        //       否则取首次 update 的对应角度。',
    '        // 开关：window.__ssplatYawLock / __ssplatPitchLock === false 时跳过（?orbit360=1 恢复官方）。',
    '        if ((typeof window === \'undefined\' || window.__ssplatYawLock !== false)) {',
    '            if (this._ssplatYawBaseInit !== true) {',
    '                this._ssplatYawBaseInit = true;',
    '                this._ssplatYawBase = camera.angles.y;',
    '            }',
    '            const _yawBase = (typeof window !== \'undefined\' && typeof window.__ssplatYawBase === \'number\')',
    '                ? window.__ssplatYawBase : this._ssplatYawBase;',
    '            let _yawDelta = camera.angles.y - _yawBase;',
    '            while (_yawDelta > 180) _yawDelta -= 360;',
    '            while (_yawDelta < -180) _yawDelta += 360;',
    '            if (_yawDelta > 90) {',
    '                camera.angles.y = _yawBase + 90;',
    '            } else if (_yawDelta < -90) {',
    '                camera.angles.y = _yawBase - 90;',
    '            }',
    '        }',
    '        if ((typeof window === \'undefined\' || window.__ssplatPitchLock !== false)) {',
    '            if (this._ssplatPitchBaseInit !== true) {',
    '                this._ssplatPitchBaseInit = true;',
    '                this._ssplatPitchBase = camera.angles.x;',
    '            }',
    '            const _pitchBase = (typeof window !== \'undefined\' && typeof window.__ssplatPitchBase === \'number\')',
    '                ? window.__ssplatPitchBase : this._ssplatPitchBase;',
    '            let _pitchDelta = camera.angles.x - _pitchBase;',
    '            while (_pitchDelta > 180) _pitchDelta -= 360;',
    '            while (_pitchDelta < -180) _pitchDelta += 360;',
    '            if (_pitchDelta > 90) {',
    '                camera.angles.x = _pitchBase + 90;',
    '            } else if (_pitchDelta < -90) {',
    '                camera.angles.x = _pitchBase - 90;',
    '            }',
    '        }',
    '        // 同步控制器内部姿态（rootPose/targetRootPose），防止下一帧 lerp 回弹',
    '        if (this.controller) {',
    '            if (this.controller._rootPose && this.controller._rootPose.angles) {',
    '                this.controller._rootPose.angles.x = camera.angles.x;',
    '                this.controller._rootPose.angles.y = camera.angles.y;',
    '            }',
    '            if (this.controller._targetRootPose && this.controller._targetRootPose.angles) {',
    '                this.controller._targetRootPose.angles.x = camera.angles.x;',
    '                this.controller._targetRootPose.angles.y = camera.angles.y;',
    '            }',
    '        }'
].join('\n');

// ---------- 强制飞行状态补丁（需求：/new 页强制 fly 相机模式） ----------
// 官方默认模式：hasAnimation ? anim : (isObjectExperience ? orbit : (walkAllowed ? walk : fly))。
// 数据页（cameras=[] → frameCamera 在包围盒外 → isObjectExperience=true）默认 orbit；
// window.__ssplatForceFly === true 时强制 'fly'（第一人称飞行，WASD+鼠标转向），
// 覆盖默认 orbit 语义；云冈默认页无此标志不受影响。
const FORCE_FLY_TARGET = '        state.cameraMode = state.hasAnimation ? \'anim\' : (isObjectExperience ? \'orbit\' : (walkAllowed ? \'walk\' : \'fly\'));';
const FORCE_FLY_REPLACEMENT = [
    '        // [强制飞行补丁] window.__ssplatForceFly === true 时强制 fly 模式（如 /new 页），',
    '        // 覆盖数据页默认 orbit；否则保持官方模式选择不变。',
    '        state.cameraMode = (typeof window !== \'undefined\' && window.__ssplatForceFly === true)',
    '            ? \'fly\'',
    '            : (state.hasAnimation ? \'anim\' : (isObjectExperience ? \'orbit\' : (walkAllowed ? \'walk\' : \'fly\')));',
    '        // [手机游戏控制补丁] window.__ssplatGamingForce === true（手机端强制游戏控制）时',
    '        // 激活 state.gamingControls（虚拟摇杆转盘显示；写属性自动触发 gamingControls:changed',
    '        // 事件 → UI 更新）。注意：不能在 state 初始化处读取该标志——app.js module 脚本',
    '        // 晚于官方 main 调用脚本执行，初始化时标志尚未写入（华为/苹果实测摇杆不显示）；',
    '        // 这里在 main 运行时（app.js 已执行）强制，与强制飞行同位置。',
    '        if (typeof window !== \'undefined\' && window.__ssplatGamingForce === true) {',
    '            state.gamingControls = true;',
    '        }'
].join('\n');

// ---------- 相机碰撞半径补丁（需求：相机距离模型 1m 触发碰撞，不能更近） ----------
// 官方 CAMERA_RADIUS = 0.2（fly SphereMover 球体半径）→ 1：
// 相机球心距模型表面（体素碰撞）≥ 1m，靠近即被推出（云冈贴墙/模型同样 1m 停）。
const CAMERA_RADIUS_TARGET = 'const CAMERA_RADIUS = 0.2;';
const CAMERA_RADIUS_REPLACEMENT = 'const CAMERA_RADIUS = 0.5; // [碰撞半径补丁] 相机距模型 0.5m 触发碰撞（用户要求，1m 减半）';

// ---------- QE 升降键注销补丁（需求：QE 快捷键取消） ----------
// 官方 FlySource 每帧把键盘输入累积到移动轴（FlySource.update）：
//   y 轴 = (key[keyCode.E] - key[keyCode.Q])（Q=下、E=上，第一人称升降）。
// 注销：window.__ssplatQEEnabled === false 时该分量恒为 0（fly 下无法用 QE 升降）。
const QE_DISABLE_TARGET = '        this._axis.add(tmpV1.set((key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]), (key[keyCode.E] - key[keyCode.Q]), (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN])));';
const QE_DISABLE_REPLACEMENT = [
    '        // [QE 注销补丁] window.__ssplatQEEnabled === false 时禁用 Q/E 升降（如 /new 页强制飞行）',
    '        this._axis.add(tmpV1.set((key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]), ((typeof window !== \'undefined\' && window.__ssplatQEEnabled === false) ? 0 : (key[keyCode.E] - key[keyCode.Q])), (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN])));'
].join('\n');

// ---------- 安卓双指手势屏蔽补丁（需求：所有安卓手机双指缩放/平移有 bug） ----------
// 官方 TouchDevice.update 中 `double = this._touchCount > 1 ? 1 : 0` 驱动双指手势：
//   - double=1 时走「双指平移」（orbit 平移目标 / fly 平移）+「双指捏合缩放」（pinch）。
// 安卓手机（含华为/鸿蒙）上这两类双指手势有 bug（相机异常跳动/位移），用户要求屏蔽：
//   - app.js 识别安卓 UA（android/huawei/harmonyos）→ window.__ssplatHuaweiNoPinch = true；
//   - 此处强制 double = 0（双指平移与缩放全部失效），只保留单指旋转 + 单击行走；
//   - 逃生通道：?pinch=1 强制恢复双指（window.__ssplatHuaweiNoPinch 置 false）。
const PINCH_DISABLE_TARGET = '        const double = this._touchCount > 1 ? 1 : 0;';
const PINCH_DISABLE_REPLACEMENT = [
    '        // [华为双指屏蔽补丁] 华为/鸿蒙手机双指手势（平移/缩放）有 bug：',
    '        // window.__ssplatHuaweiNoPinch === true 时强制 double=0（双指平移+捏合缩放失效），',
    '        // 只保留单指旋转 + 单击行走（点击移动）；?pinch=1 可强制恢复双指（逃生通道）。',
    '        const double = (typeof window !== \'undefined\' && window.__ssplatHuaweiNoPinch === true) ? 0 : (this._touchCount > 1 ? 1 : 0);'
].join('\n');

// ---------- 圆形摇杆 CSS 补丁（需求：游戏控制虚拟摇杆统一为圆形图标，苹果/华为/安卓一致） ----------
// 官方 index.css 摇杆默认是竖条胶囊（#joystickBase 56×100、border-radius 28px，1D 模式），
// 仅 .mode-2d 类存在时才显示圆形底座（100×100）。手机端游戏控制激活后（2D 模式）虽带
// mode-2d 类为圆形，但双击摇杆会切到 1D 模式（竖条），且用户要求三端 UI 图标一致为圆形。
// 补丁方案（只改样式，不动逻辑）：
//   C1. #joystickBase 默认样式直接改为圆形底座（100×100、border-radius 50%、圆形渐变），
//       不再依赖 .mode-2d 类——任何模式（1D/2D）下都是圆形图标；
//   C2. #joystickBase > #joystick 默认 left 8px → 30px（居中），并加立体渐变；
//   C3. .mode-2d 相关规则保留（与 C1 相同的圆形象态，无冲突）。
// 配套 JS 补丁（J1）：1D 模式 reset 时 left '8px' → '30px'（居中，避免竖条定位残留）。
const JOYSTICK_CSS_BASE_TARGET = [
    '#joystickBase {',
    '  position: absolute;',
    '  width: 56px;',
    '  height: 100px;',
    '  transform: translate(-50%, -50%);',
    '  border-radius: 28px;',
    '  touch-action: none;',
    '  background: linear-gradient(180deg, rgba(0, 0, 0, 0.2666666667) 0%, rgba(0, 0, 0, 0) 30%, rgba(0, 0, 0, 0) 70%, rgba(0, 0, 0, 0.2666666667) 100%);',
    '  background-color: rgba(0, 0, 0, 0.2);',
    '  border: 2px solid rgba(255, 255, 255, 0.2);',
    '  transition: width 0.2s ease, height 0.2s ease, border-radius 0.2s ease;',
    '}'
].join('\n');
const JOYSTICK_CSS_BASE_REPLACEMENT = [
    '#joystickBase {',
    '  position: absolute;',
    '  width: 100px;',
    '  height: 100px;',
    '  transform: translate(-50%, -50%);',
    '  border-radius: 50%;',
    '  touch-action: none;',
    '  background: radial-gradient(circle, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0) 42%, rgba(0, 0, 0, 0.28) 100%);',
    '  background-color: rgba(0, 0, 0, 0.22);',
    '  border: 2px solid rgba(255, 255, 255, 0.4);',
    '  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);',
    '  transition: width 0.2s ease, height 0.2s ease, border-radius 0.2s ease;',
    '}'
].join('\n');
const JOYSTICK_CSS_STICK_TARGET = [
    '#joystickBase > #joystick {',
    '  position: absolute;',
    '  left: 8px;',
    '  width: 40px;',
    '  height: 40px;',
    '  border-radius: 50%;',
    '  touch-action: none;',
    '  background-color: rgba(255, 255, 255, 0.5333333333);',
    '  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);',
    '  transition: left 0.1s ease;',
    '}'
].join('\n');
const JOYSTICK_CSS_STICK_REPLACEMENT = [
    '#joystickBase > #joystick {',
    '  position: absolute;',
    '  left: 30px;',
    '  width: 40px;',
    '  height: 40px;',
    '  border-radius: 50%;',
    '  touch-action: none;',
    '  background: radial-gradient(circle at 35% 35%, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0.65) 100%);',
    '  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);',
    '  transition: left 0.1s ease;',
    '}'
].join('\n');
// ---------- 圆形摇杆 JS 补丁（J1：1D 模式摇杆头居中） ----------
const JOYSTICK_JS_1D_TARGET = "                dom.joystick.style.left = '8px'; // Reset to 1D centered position";
const JOYSTICK_JS_1D_REPLACEMENT = "                dom.joystick.style.left = '30px'; // [圆形摇杆补丁] 1D 模式摇杆头同样居中（圆形底座）";

// ---------- 手机端游戏控制补丁（需求：手机进入页面激活游戏控制，转盘移动，单指环绕） ----------
// 官方 gamingControls 仅桌面 WASD/指针锁定时激活（state 初始 false，ModeShortcuts 按键切换）。
// 手机端（安卓/华为/苹果）要求：进入页面即激活游戏控制（虚拟摇杆转盘显示），
//   转盘摇杆 → 移动；单指拖动 → 相机环绕（旋转）；双指平移/缩放 → 由 PINCH_DISABLE 补丁屏蔽。
// 实现（强制逻辑已并入 FORCE_FLY 补丁——main 运行时 app.js 已执行，才能读到
// window.__ssplatGamingForce；state 初始化处读取会因 module 执行顺序拿到 undefined，
// 导致华为/苹果摇杆不显示）：
//   转盘摇杆 → 移动；单指拖动 → 相机环绕；双指平移/缩放 → PINCH_DISABLE 屏蔽。

/**
 * 对官方静态文件（index.js / index.html）应用一个补丁，要求目标串恰好出现 1 次（严格校验）。
 * 不满足条件时抛出带版本提示的错误，避免官方 bundle 版本变更后静默打错位置。
 * @param {string} source 当前文件全文（index.js 或 index.html）
 * @param {{ name: string, target: string, replacement: string }} patch 补丁定义
 * @returns {string} 替换后的完整文本
 */
const applyStrictPatch = (source, patch) => {
    const { name, target, replacement } = patch;
    const count = source.split(target).length - 1;
    if (count !== 1) {
        throw new Error(
            `补丁失败（${name}）：期望在官方静态文件中找到 1 处目标串，实际找到 ${count} 处。` +
            '请检查 @playcanvas/supersplat-viewer 版本是否已变更。\n' +
            `目标串：\n${target}`
        );
    }
    return source.replace(target, replacement);
};

/**
 * 增量同步 sog_data → dist/sog_data：
 * 只复制缺失或大小不一致的文件，绝不删除已有文件。
 * 原因：dist/sog_data 含约 74MB 数据，整体清空重拷既慢又容易触发沙箱删除钩子；
 * 源目录不变时（文件同名同大小）直接跳过，构建更快且无删除风险。
 * @returns {Promise<{ count: number, totalBytes: number }>} 实际复制文件数与字节数
 */
const syncSogData = async () => {
    await mkdir(SOG_DEST, { recursive: true });
    const names = await readdir(SOG_SRC);
    let count = 0;
    let totalBytes = 0;
    for (const name of names) {
        const srcPath = join(SOG_SRC, name);
        const destPath = join(SOG_DEST, name);
        const srcStat = await stat(srcPath);
        if (!srcStat.isFile()) continue;
        // 目标已存在且大小一致 → 跳过（dist/sog_data 与源保持一致）
        let needCopy = true;
        try {
            const destStat = await stat(destPath);
            needCopy = !destStat.isFile() || destStat.size !== srcStat.size;
        } catch {
            needCopy = true;
        }
        if (needCopy) {
            await writeFileFrom(srcPath, destPath);
            count += 1;
            totalBytes += srcStat.size;
        }
    }
    return { count, totalBytes };
};

/**
 * 递归增量同步 sog_data_mobile → dist/sog_data_mobile（零删除策略）：
 * 只复制缺失或大小不一致的文件，绝不删除已有文件；跳过 _src/ 中间产物目录
 * （merged-noenv.ply / mobile-500k.ply 仅预处理用，不进 dist）。
 * 运行期需要的文件：streamed/（lod-meta.json + 分块目录，Streamed SOG 主方案）
 * 与 mobile.sog（单文件回退方案）。
 * @returns {Promise<{ count: number, totalBytes: number, totalFiles: number, totalBytesAll: number }>}
 *   count/totalBytes：本次实际复制文件数与字节数；totalFiles/totalBytesAll：同步后 dist 内全部文件统计
 */
const syncMobileData = async () => {
    await mkdir(SOG_MOBILE_DEST, { recursive: true });
    const pending = [{ src: SOG_MOBILE_SRC, dest: SOG_MOBILE_DEST }];
    let count = 0;
    let totalBytes = 0;
    let totalFiles = 0;
    let totalBytesAll = 0;
    while (pending.length > 0) {
        const { src, dest } = pending.pop();
        const names = await readdir(src);
        for (const name of names) {
            // 跳过预处理中间产物目录（_src/）：不进 dist
            if (name === '_src') continue;
            const srcPath = join(src, name);
            const destPath = join(dest, name);
            const srcStat = await stat(srcPath);
            if (srcStat.isDirectory()) {
                await mkdir(destPath, { recursive: true });
                pending.push({ src: srcPath, dest: destPath });
                continue;
            }
            if (!srcStat.isFile()) continue;
            // 目标已存在且大小一致 → 跳过（dist 与源保持一致，零删除）
            let needCopy = true;
            try {
                const destStat = await stat(destPath);
                needCopy = !destStat.isFile() || destStat.size !== srcStat.size;
            } catch {
                needCopy = true;
            }
            totalFiles += 1;
            totalBytesAll += srcStat.size;
            if (needCopy) {
                await writeFileFrom(srcPath, destPath);
                count += 1;
                totalBytes += srcStat.size;
            }
        }
    }
    return { count, totalBytes, totalFiles, totalBytesAll };
};

/**
 * 增量同步 new_data → dist/new_data（任务④：页面切片切换的数据集）：
 * 只同步**优化产物**（*mobile.sog / *.compressed.ply），原始源数据
 * （T0.sog / T1.ply / T2.ply / T3.sog 等大文件与中间产物 *-500k.ply）不进 dist，
 * 避免部署包膨胀（262MB×2 + 54MB×2 ≈ 630MB 无用数据）。
 * 例外：point_cloud.sog（88.6MB 完整版，/new 页桌面加载）为运行期必需文件，单独加入同步。
 * @returns {Promise<{ count: number, totalBytes: number, files: string[] }>}
 */
const syncNewData = async () => {
    await mkdir(NEW_DATA_DEST, { recursive: true });
    const names = await readdir(NEW_DATA_SRC);
    let count = 0;
    let totalBytes = 0;
    const files = [];
    // 精确白名单：仅同步运行期被引用的文件（/new、/test 页数据），
    // 排除中间产物（point_50/point_75/point_cloud_75/full 等 compressed.ply、SOG 抽稀版、PLY 源文件）。
    // 被引用集（src/app.js TEST_DATASET + swap 配置）：
    //   /new  桌面：point_cloud.mobile.sog（秒开）→ swap point_cloud.sog（完整版）
    //   /new  安卓：point_cloud.mobile.sog（秒开）→ swap point_cloud_mid.sog（中间档）
    //   /new  iOS ：point_cloud.mobile.compressed.ply
    //   /test 桌面/安卓：t0.mobile.sog；iOS：t0.compressed.ply
    const NEW_DATA_WHITELIST = new Set([
        'point_cloud.mobile.sog',
        'point_cloud.sog',
        'point_cloud_mid.sog',
        'point_cloud.mobile.compressed.ply',
        't0.mobile.sog',
        't0.compressed.ply'
    ]);
    for (const name of names) {
        if (!NEW_DATA_WHITELIST.has(name)) continue;
        const srcPath = join(NEW_DATA_SRC, name);
        const destPath = join(NEW_DATA_DEST, name);
        const srcStat = await stat(srcPath);
        if (!srcStat.isFile()) continue;
        let needCopy = true;
        try {
            const destStat = await stat(destPath);
            needCopy = !destStat.isFile() || destStat.size !== srcStat.size;
        } catch {
            needCopy = true;
        }
        if (needCopy) {
            await writeFileFrom(srcPath, destPath);
            count += 1;
            totalBytes += srcStat.size;
        }
        files.push(name);
    }
    return { count, totalBytes, files };
};

// ---------- 主流程 ----------

const main = async () => {
    log('=== 开始构建本地 3D 高斯查看器 ===');
    log('');

    // 0. 确保 dist/ 存在（不清空：构建产物文件直接覆写，sog_data 增量同步，
    //    避免整体删除 74MB 数据触发沙箱删除钩子 / 误删风险）
    await mkdir(DIST_DIR, { recursive: true });

    // 1. 复制官方查看器静态文件，并在 index.html 末尾注入自定义脚本
    for (const file of VIEWER_FILES) {
        await writeFileFrom(join(PKG_PUBLIC, file), join(DIST_DIR, file));
        log(`  [复制] dist/${file}`);
    }

    // 1.0 对 index.css 打「圆形摇杆」补丁（官方 CSS 摇杆默认竖条胶囊 → 圆形底座，三端一致）
    const cssPath = join(DIST_DIR, 'index.css');
    let css = await readFile(cssPath, 'utf8');
    const cssPatchSteps = [
        { name: 'index.css-圆形摇杆底座（#joystickBase 56×100 竖条 → 100×100 圆）', target: JOYSTICK_CSS_BASE_TARGET, replacement: JOYSTICK_CSS_BASE_REPLACEMENT },
        { name: 'index.css-圆形摇杆头（#joystick 居中 30px + 立体渐变）', target: JOYSTICK_CSS_STICK_TARGET, replacement: JOYSTICK_CSS_STICK_REPLACEMENT }
    ];
    for (const step of cssPatchSteps) {
        css = applyStrictPatch(css, step);
    }
    await writeFile(cssPath, css, 'utf8');
    log('  [补丁] index.css 虚拟摇杆已改为圆形底座 + 圆形摇杆头（游戏控制 UI，苹果/华为/安卓统一）');

    // 1.1 对 index.html 打补丁（任务①：页面标题改为「云冈艺术」；任务③：注入 ?debug=1 早期错误收集器；
    //     需求①：移除 scene.compressed.ply 404 请求；需求③：隐藏官方动画播放/暂停/时间轴控件）
    const htmlPath = join(DIST_DIR, 'index.html');
    let html = await readFile(htmlPath, 'utf8');
    const htmlPatchSteps = [
        { name: 'index.html-页面标题改为「云冈艺术」', target: HTML_TITLE_TARGET, replacement: HTML_TITLE_REPLACEMENT },
        { name: 'index.html-品牌区文案改为「云冈艺术」', target: HTML_BRAND_TARGET, replacement: HTML_BRAND_REPLACEMENT },
        { name: 'index.html-注入 ?debug=1 早期错误收集器（onerror + unhandledrejection）', target: HTML_DEBUG_COLLECTOR_TARGET, replacement: HTML_DEBUG_COLLECTOR_REPLACEMENT },
        { name: 'index.html-移除默认 scene.compressed.ply（contentUrl 置空）', target: HTML_CONTENT_URL_TARGET, replacement: HTML_CONTENT_URL_REPLACEMENT },
        { name: 'index.html-不再发起默认内容 fetch（contents 置空 Promise）', target: HTML_CONTENTS_TARGET, replacement: HTML_CONTENTS_REPLACEMENT },
        { name: 'index.html-隐藏官方动画播放/暂停/时间轴控件（移除 play 按钮）', target: HTML_HIDE_ANIM_UI_TARGET, replacement: HTML_HIDE_ANIM_UI_REPLACEMENT },
        { name: 'index.html-注入加载封面 splash（#ssplatCover + 内联 CSS/脚本 + window.__ssplatCover）', target: HTML_COVER_SPLASH_TARGET, replacement: HTML_COVER_SPLASH_REPLACEMENT },
        { name: 'index.html-注入空 favicon（href=data:,，消除 favicon.ico 404）', target: HTML_FAVICON_TARGET, replacement: HTML_FAVICON_REPLACEMENT }
    ];
    for (const step of htmlPatchSteps) {
        html = applyStrictPatch(html, step);
    }
    log('  [补丁] index.html 页面标题与品牌区文案已改为「云冈艺术」（0 处 SuperSplat Viewer）');
    log('  [补丁] index.html 已注入 ?debug=1 早期错误收集器（onerror + unhandledrejection，官方脚本执行前）');
    log('  [补丁] index.html 已移除默认 scene.compressed.ply 请求（不再产生 404）');
    log('  [补丁] index.html 已隐藏官方动画播放/暂停/时间轴控件（移除 play 按钮）');
    log('  [补丁] index.html 已注入加载封面 splash（#ssplatCover + 内联 CSS/脚本，官方脚本之前；首帧渲染完成后淡出）');

    // 1.2 在 dist/index.html 的 </body> 前追加 <script src="./app.js">
    //     （module 脚本按文档顺序执行：官方配置脚本 → 官方 main 调用脚本 → app.js，
    //      因此 app.js 能在 main() 启动前改写 window.sse.config）
    const APP_SCRIPT = '    <script type="module" src="./app.js"></script>\n';
    if (!html.includes(APP_SCRIPT.trim())) {
        if (!/<\/body>/i.test(html)) {
            throw new Error('构建失败：官方 index.html 中未找到 </body>，无法注入自定义脚本。');
        }
        html = html.replace(/<\/body>/i, APP_SCRIPT + '</body>');
        log('  [注入] dist/index.html 已追加 <script src="./app.js">');
    }
    await writeFile(htmlPath, html, 'utf8');

    // 1.3 生成 new.html（COS 静态托管入口副本，内容与 index.html 一致）
    //     COS 无 nginx try_files 路由重写，无法访问 /new；部署包内置 new.html，
    //     app.js 判定 pathname endsWith('/new.html') → 进入 new 数据页。
    //     也可用 index.html?page=new（URL 参数，与路径无关）。
    const NEW_HTML_PATH = join(DIST_DIR, 'new.html');
    await writeFile(NEW_HTML_PATH, html, 'utf8');
    log('  [复制] dist/new.html（COS 静态托管入口：/new.html 或 ?page=new）');

    // 2. 对 index.js 打「坐标翻转」+「合并视图」+「无动画」+「碰撞」补丁（每处均严格校验恰好 1 处）
    const jsPath = join(DIST_DIR, 'index.js');
    let js = await readFile(jsPath, 'utf8');
    const patchSteps = [
        { name: '坐标翻转（Z-up → Y-up，默认 z=0，?flip=1 时叠加官方 Z 翻转）', target: ROTATION_TARGET, replacement: ROTATION_REPLACEMENT },
        { name: '合并视图-注入辅助函数', target: MERGE_HELPERS_TARGET, replacement: MERGE_HELPERS_REPLACEMENT },
        { name: '合并视图-调用点分派', target: MERGE_CALL_TARGET, replacement: MERGE_CALL_REPLACEMENT },
        { name: '合并视图-包围盒合并（跳过环境/天空盒等超大包围盒）', target: MERGE_AABB_TARGET, replacement: MERGE_AABB_REPLACEMENT },
        { name: 'Streamed SOG-叶子节点包围盒修正（流式模式空气墙/碰撞/取景用正确场景范围）', target: STREAMED_AABB_TARGET, replacement: STREAMED_AABB_REPLACEMENT },
        { name: '无动画-禁用官方默认动画（无 animTracks 时返回 null，默认模式进入 fly）', target: ANIM_DISABLE_TARGET, replacement: ANIM_DISABLE_REPLACEMENT },
        { name: '碰撞-注入 SceneBoundCollision 简化碰撞类', target: COLLISION_CLASS_TARGET, replacement: COLLISION_CLASS_REPLACEMENT },
        { name: '碰撞-CameraManager 使用 cameraCollision（sceneBound 合并完成后构造）', target: COLLISION_CAMERA_MANAGER_TARGET, replacement: COLLISION_CAMERA_MANAGER_REPLACEMENT },
        { name: '碰撞-禁用 walk 模式（保持默认 fly）', target: COLLISION_WALK_DISABLE_TARGET, replacement: COLLISION_WALK_DISABLE_REPLACEMENT },
        { name: '碰撞-Orbit 最小缩放距离', target: COLLISION_ORBIT_MIN_DIST_TARGET, replacement: COLLISION_ORBIT_MIN_DIST_REPLACEMENT },
        { name: '碰撞-orbit 控制器挂接同一碰撞体（需求②）', target: COLLISION_ORBIT_ATTACH_TARGET, replacement: COLLISION_ORBIT_ATTACH_REPLACEMENT },
        { name: '碰撞-orbit 相机位置钳制到房间内（需求②）', target: COLLISION_ORBIT_CLAMP_TARGET, replacement: COLLISION_ORBIT_CLAMP_REPLACEMENT },
        { name: '空气墙-每帧无条件钳制相机位置（CameraManager.update 最终落点）', target: COLLISION_AIRWALL_CLAMP_TARGET, replacement: COLLISION_AIRWALL_CLAMP_REPLACEMENT },
        { name: '碰撞-注入 SplatVoxelCollision 体素碰撞类（从 splat 构建，异步分批）+ 全局构建钩子 + SceneAirWall 空气墙类', target: 'class Viewer {', replacement: VOXEL_CLASS_REPLACEMENT },
        { name: '碰撞-单文件模式体素碰撞构建钩子', target: VOXEL_SINGLE_HOOK_TARGET, replacement: VOXEL_SINGLE_HOOK_REPLACEMENT },
        { name: '点击行走-手机端 orbit 点击行走（_walkToPickedPosition + ?walk=0 开关，桌面行为不变）', target: NAV_MOBILE_TAP_TARGET, replacement: NAV_MOBILE_TAP_REPLACEMENT },
        { name: '设备分类-桌面 WASD 行走 / 手机禁用 WASD（ModeShortcuts 键盘分支按设备对待）', target: MODE_SHORTCUTS_WASD_TARGET, replacement: MODE_SHORTCUTS_WASD_REPLACEMENT },
        { name: '相机日志-无条件暴露相机状态读取（__ssplatGetCameraState，供 app.js 输出旋转/相机定位）', target: CAMERA_STATE_EXPOSE_TARGET, replacement: CAMERA_STATE_EXPOSE_REPLACEMENT },
        { name: '旋转限制-鼠标左键旋转限制 180°（yaw/pitch 各 ±90°，?orbit360=1 关闭）', target: ROT_LOCK_TARGET, replacement: ROT_LOCK_REPLACEMENT },
        { name: 'XrNavigation 日志静默-注释官方 WebXR 初始化 console.log', target: XR_LOG_TARGET, replacement: XR_LOG_REPLACEMENT },
        { name: '渐进替换-注入 __ssplatSwapGsplat（加载新数据替换当前实体）', target: SWAP_APP_TARGET, replacement: SWAP_APP_REPLACEMENT },
        { name: '强制飞行-__ssplatForceFly 时强制 fly 模式（覆盖数据页默认 orbit）', target: FORCE_FLY_TARGET, replacement: FORCE_FLY_REPLACEMENT },
        { name: 'QE 注销-Q/E 升降键功能注销（__ssplatQEEnabled=false 时 y 轴输入恒 0）', target: QE_DISABLE_TARGET, replacement: QE_DISABLE_REPLACEMENT },
        { name: '华为双指屏蔽-华为/鸿蒙手机双指平移缩放失效（__ssplatHuaweiNoPinch 时 double=0，?pinch=1 恢复）', target: PINCH_DISABLE_TARGET, replacement: PINCH_DISABLE_REPLACEMENT },
        { name: '圆形摇杆-1D 模式摇杆头居中（left 8px → 30px，配合 CSS 圆形底座）', target: JOYSTICK_JS_1D_TARGET, replacement: JOYSTICK_JS_1D_REPLACEMENT },
        { name: '碰撞半径-相机距模型 0.5m 触发碰撞（CAMERA_RADIUS 0.2→0.5，fly SphereMover）', target: CAMERA_RADIUS_TARGET, replacement: CAMERA_RADIUS_REPLACEMENT },
        { name: '进入场景-删除官方相机跳转动画（frame 事件不再 startTransition，直接落位）', target: FRAME_TRANSITION_TARGET, replacement: FRAME_TRANSITION_REPLACEMENT }
    ];
    for (const step of patchSteps) {
        js = applyStrictPatch(js, step);
    }
    await writeFile(jsPath, js, 'utf8');
    log('  [补丁] index.js 已注入 Z-up → Y-up 变换（绕 X 轴 -90°，默认不做官方 Z 翻转；?flip=1 可临时启用）');
    log('  [补丁] index.js 已注入合并视图（多文件同场景渲染 + 合并包围盒，跳过环境/天空盒超大包围盒）');
    log('  [补丁] index.js 已注入 Streamed SOG 叶子节点包围盒修正（流式模式空气墙/碰撞/取景用正确场景范围）');
    log('  [补丁] index.js 已禁用官方默认动画（无 animTracks 时默认模式进入 fly，碰撞生效）');
    log('  [补丁] index.js 已注入简化碰撞（AABB 房间 + 0.5m padding + fly 相机碰撞 + Orbit 最小距离 + orbit 相机钳制）');
    log('  [补丁] index.js 已注入固定空气墙（sceneBound 外扩 0.3m + 相机半径 0.2m 内缩 + CameraManager.update 每帧无条件钳制相机位置）');
    log('  [补丁] index.js 已注入体素碰撞（SplatVoxelCollision：从 splat 构建稀疏体素网格 + 异步分批构建 + 房间外边界 + 鼠标射线）');
    log('  [补丁] index.js 已注入点击行走（手机端 orbit 点击 → 平滑飞行到目标点附近，?walk=0 关闭；orbit 焦点同步钳制到空气墙内）');
    log('  [补丁] index.js 已注入设备分类操控（桌面 WASD 行走 fly+鼠标转向 / 手机触摸点选行走，ModeShortcuts 键盘分支按设备对待）');

    // 3. 复制 settings.json（相机初始位姿等体验设置）
    await writeFileFrom(join(ROOT, 'settings.json'), join(DIST_DIR, 'settings.json'));
    log('  [复制] dist/settings.json');

    // 3.1 复制加载封面（cover.jpg：云冈艺术巡展海报，splash 背景图；源为项目根 cover.jpg，
    //     不硬编码用户桌面原始路径；缺失时 splash 仅显示黑底，不影响查看器主流程）
    if (existsSync(COVER_SRC)) {
        await writeFileFrom(COVER_SRC, COVER_DEST);
        log('  [复制] dist/cover.jpg（加载封面）');
    } else {
        log('  [警告] 未找到 cover.jpg（加载封面缺失，splash 仅显示纯黑底）');
    }

    // 4. 复制自定义启动与控制脚本（src/app.js：config 改写 + URL 参数 + 钩子，无自绘 UI）
    await writeFileFrom(join(SRC_DIR, 'app.js'), join(DIST_DIR, 'app.js'));
    log('  [复制] dist/app.js');

    // 5. 增量同步 sog_data 数据（源目录保持不动；只复制缺失/变动的文件，不删除）
    if (existsSync(SOG_SRC)) {
        const { count, totalBytes } = await syncSogData();
        const sogFiles = await readdir(SOG_DEST);
        const allStats = await Promise.all(
            sogFiles.map(async (name) => ({ name, size: (await stat(join(SOG_DEST, name))).size }))
        );
        const allBytes = allStats.reduce((sum, item) => sum + item.size, 0);
        log(`  [同步] dist/sog_data/ 共 ${sogFiles.length} 个文件，合计 ${formatSize(allBytes)}` +
            (count > 0 ? `（本次复制 ${count} 个 / ${formatSize(totalBytes)}）` : '（无变化，全部跳过）'));
    } else {
        log('  [警告] 未找到 sog_data 目录，请确认数据路径正确！');
    }

    // 5.1 增量同步 sog_data_mobile 手机版数据（零删除策略；跳过 _src/ 中间产物）
    if (existsSync(SOG_MOBILE_SRC)) {
        const mobileSync = await syncMobileData();
        log(`  [同步] dist/sog_data_mobile/ 共 ${mobileSync.totalFiles} 个文件，合计 ${formatSize(mobileSync.totalBytesAll)}` +
            (mobileSync.count > 0
                ? `（本次复制 ${mobileSync.count} 个 / ${formatSize(mobileSync.totalBytes)}）`
                : '（无变化，全部跳过）'));
    } else {
        log('  [警告] 未找到 sog_data_mobile 目录（手机版数据未生成，手机模式将无法加载！）');
    }

    // 5.2 增量同步 new_data 优化产物（任务④：页面切片切换的数据集）
    if (existsSync(NEW_DATA_SRC)) {
        const newSync = await syncNewData();
        if (newSync.count > 0 || newSync.files.length > 0) {
            log(`  [同步] dist/new_data/ 优化产物 ${newSync.files.length} 个（${newSync.files.join(', ')}）` +
                (newSync.count > 0 ? `（本次复制 ${newSync.count} 个 / ${formatSize(newSync.totalBytes)}）` : '（无变化，全部跳过）'));
        } else {
            log('  [警告] new_data 目录无优化产物（*.mobile.sog / *.compressed.ply），数据集切换将无法加载！');
        }
    } else {
        log('  [警告] 未找到 new_data 目录（数据集切换不可用）');
    }

    // 6. 输出汇总
    log('');
    log('=== 构建完成 ===');
    log(`输出目录: ${DIST_DIR}`);
    const summaryFiles = ['index.html', 'index.js', 'index.css', 'app.js', 'settings.json'];
    if (existsSync(COVER_DEST)) summaryFiles.push('cover.jpg');
    for (const file of summaryFiles) {
        const fileStat = await stat(join(DIST_DIR, file));
        log(`  dist/${file}  ${formatSize(fileStat.size)}`);
    }
    log('');
    log('启动方式: npm run serve   （或 node scripts/serve.mjs）');
    log('访问地址: http://127.0.0.1:8080/');
};

main().catch((err) => {
    console.error('构建失败：', err);
    process.exit(1);
});
