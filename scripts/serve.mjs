/**
 * 零依赖本地静态文件服务器
 * ----------------------------------------
 * 职责：
 *  1. 以只读方式伺服 dist/ 目录（构建产物，含 index.html / index.js / app.js / sog_data/ 等）；
 *  2. 提供 GET /api/files 接口，返回 sog_data 目录下的 .sog 文件名列表（JSON），
 *     供前端自动发现可切换的文件（若接口不可用，前端会回退到内置文件清单）；
 *  3. 提供 POST /api/save-camera 接口：校验 position/target 后写入 cameras[0].initial，
 *     同时同步 dist/settings.json 与根目录 settings.json（只允许写 settings.json 一个文件）；
 *  4. 启动时输出一行必要提示；请求级日志已全部移除（需求：移除全部日志输出）。
 *
 * 用法：
 *  ​node scripts/serve.mjs [端口]
 *  环境变量 PORT 也可指定端口，默认 8080。
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- 常量 ----------

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url))); // 项目根目录（D:\lm\高斯）
const DIST_DIR = join(ROOT_DIR, 'dist');
const SOG_DIR = join(DIST_DIR, 'sog_data'); // 构建时会把 sog_data 复制进 dist/sog_data
const DEFAULT_PORT = Number(process.env.PORT) || 8080;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.sog': 'application/octet-stream',
    '.ply': 'application/octet-stream',
    '.splat': 'application/octet-stream',
    '.spz': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm'
};

// ---------- 工具函数 ----------

/**
 * 将 URL 路径解析为 dist 目录内的安全绝对路径。
 * @returns {{ ok: true, filePath: string } | { ok: false, status: number, message: string }}
 */
const resolveSafePath = (urlPath) => {
    let decoded;
    try {
        decoded = decodeURIComponent(urlPath);
    } catch {
        return { ok: false, status: 400, message: '请求路径无法解码' };
    }

    // 去掉查询字符串（不应出现，防御性处理）
    const pathname = decoded.split('?')[0];

    // 归一化并防止路径穿越
    const candidate = normalize(join(DIST_DIR, pathname));
    const rootPrefix = DIST_DIR + sep;
    if (candidate !== DIST_DIR && !candidate.startsWith(rootPrefix)) {
        return { ok: false, status: 403, message: '禁止访问目录之外的路径' };
    }
    return { ok: true, filePath: candidate };
};

/**
 * 读取 sog_data 目录下的 .sog 文件清单。
 */
const listSogFiles = async () => {
    try {
        const names = await readdir(SOG_DIR);
        return names.filter((name) => name.toLowerCase().endsWith('.sog')).sort();
    } catch {
        return [];
    }
};

/**
 * 发送 JSON 响应。
 */
const sendJson = (res, statusCode, data) => {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
};

/**
 * 解析 Range 请求头（仅支持单区间 "bytes=start-end"）。
 * @returns {{ start: number, end: number } | null}
 */
const parseRange = (req, fileSize) => {
    const header = req.headers.range;
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return null;
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : fileSize - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start) return null;
    return { start, end };
};

/**
 * 发送文件响应（支持 Range 请求，便于大文件/拖动播放）。
 */
const sendFile = async (req, res, filePath) => {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
        sendJson(res, 404, { error: '未找到文件' });
        return;
    }

    const mime = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = parseRange(req, fileStat.size);

    if (range) {
        res.writeHead(206, {
            'Content-Type': mime,
            'Content-Length': range.end - range.start + 1,
            'Content-Range': `bytes ${range.start}-${range.end}/${fileStat.size}`,
            'Accept-Ranges': 'bytes'
        });
        createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
        return;
    }

    res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': fileStat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
    });
    createReadStream(filePath).pipe(res);
};

// ---------- 请求处理 ----------

/**
 * 读取请求体并解析为 JSON（限制大小，防止滥用）。
 * 超限时不销毁 socket（否则客户端会收到连接重置 HTTP 000），而是继续排空请求体、
 * 在 end 时以带标记的错误拒绝（err.code === 'BODY_TOO_LARGE'），让 400 响应能正常送达。
 * @returns {Promise<object|null>} 解析结果；空 body 返回 null
 */
const readJsonBody = (req) => new Promise((resolve, reject) => {
    const MAX_BODY_SIZE = 64 * 1024;
    let data = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
        size += chunk.length;
        if (tooLarge) return; // 已超限：继续排空请求体但丢弃内容
        if (size > MAX_BODY_SIZE) {
            tooLarge = true;
            data = ''; // 内容已无意义，释放内存
            return;
        }
        data += chunk;
    });
    req.on('end', () => {
        if (tooLarge) {
            const err = new Error('请求体过大（上限 64KB）');
            err.code = 'BODY_TOO_LARGE';
            reject(err);
            return;
        }
        try {
            resolve(data ? JSON.parse(data) : null);
        } catch {
            reject(new Error('请求体不是合法 JSON'));
        }
    });
    req.on('error', reject);
});

/**
 * 校验并规范化长度 3 的有限数数组。
 * @param {unknown} value
 * @returns {number[] | null}
 */
const normalizeVec3 = (value) => {
    if (!Array.isArray(value) || value.length !== 3) return null;
    if (!value.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    // 保留 4 位小数（与相机日志输出口径一致）
    return value.map((v) => Math.round(v * 10000) / 10000);
};

/**
 * 与项目原始 settings.json 风格一致的序列化：对象 2 空格缩进、数组保持单行。
 * 这样「保存当前视角」写回后，diff 只会落在 position/target 两行，不引起格式抖动。
 */
const stringifySettingsJson = (data) => {
    const indent = (level) => '  '.repeat(level);
    const serialize = (value, level) => {
        if (Array.isArray(value)) {
            return '[' + value.map((v) => serialize(v, level)).join(', ') + ']';
        }
        if (value && typeof value === 'object') {
            const keys = Object.keys(value);
            if (keys.length === 0) return '{}';
            const inner = keys.map((k) => indent(level + 1) + JSON.stringify(k) + ': ' + serialize(value[k], level + 1));
            return '{\n' + inner.join(',\n') + '\n' + indent(level) + '}';
        }
        return JSON.stringify(value);
    };
    return serialize(data, 0) + '\n';
};

/**
 * 把 position/target 写入 settings.json 的 cameras[0].initial（dist 与根目录两处同步）。
 * 只允许写 settings.json 这一个文件（路径硬编码，不接受用户输入路径，防任意写）。
 * @param {{ position: number[], target: number[] }} pose
 */
const saveCameraPose = async (pose) => {
    const targets = [
        join(DIST_DIR, 'settings.json'), // 立即生效（运行时按 ./settings.json 相对路径拉取）
        join(ROOT_DIR, 'settings.json')  // 下次 build 不丢（build.mjs 以根 settings.json 为准）
    ];
    for (const filePath of targets) {
        const data = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(data.cameras) || data.cameras.length === 0) {
            data.cameras = [{ initial: {} }];
        }
        const initial = data.cameras[0].initial || (data.cameras[0].initial = {});
        initial.position = pose.position;
        initial.target = pose.target;
        // fov 保持不变（缺失时补默认 60）
        if (typeof initial.fov !== 'number' || !Number.isFinite(initial.fov)) {
            initial.fov = 60;
        }
        await writeFile(filePath, stringifySettingsJson(data), 'utf8');
    }
};

/**
 * POST /api/save-camera 处理：校验 → 写 settings.json → 返回结果。
 */
const handleSaveCamera = async (req, res) => {
    let body;
    try {
        body = await readJsonBody(req);
    } catch (err) {
        // 区分「请求体过大」与「请求体不是合法 JSON」两种失败
        if (err && err.code === 'BODY_TOO_LARGE') {
            sendJson(res, 400, { error: '请求体过大（上限 64KB）' });
        } else {
            sendJson(res, 400, { error: '请求体不是合法 JSON' });
        }
        return;
    }
    const position = normalizeVec3(body && body.position);
    const target = normalizeVec3(body && body.target);
    if (!position || !target) {
        sendJson(res, 400, { error: 'position/target 必须为长度 3 的有限数数组' });
        return;
    }
    try {
        await saveCameraPose({ position, target });
    } catch {
        // 静默：写入 settings.json 失败不再输出日志（需求：移除全部日志输出）
        sendJson(res, 500, { error: '写入 settings.json 失败' });
        return;
    }
    sendJson(res, 200, { ok: true });
};

const handleRequest = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // API：返回 sog 文件列表
    if (pathname === '/api/files') {
        const files = await listSogFiles();
        sendJson(res, 200, { files });
        return;
    }

    // API：保存相机位姿（仅支持 POST；只允许写 settings.json 这一个文件）
    if (pathname === '/api/save-camera') {
        if (req.method === 'POST') {
            await handleSaveCamera(req, res);
        } else {
            sendJson(res, 405, { error: '仅支持 POST' });
        }
        return;
    }

    // 根路径 → index.html；/test、/new 测试数据页面（任务④：页面区分，SPA 回退到 index.html，
    // app.js 按 location.pathname 识别并加载 new_data/ 测试数据；与线上 nginx
    // try_files $uri $uri/ /index.html 语义一致）
    let servePath = pathname;
    if (servePath === '/' || servePath === '/test' || servePath === '/new') {
        servePath = '/index.html';
    }
    const safePath = resolveSafePath(servePath);
    if (!safePath.ok) {
        sendJson(res, safePath.status, { error: safePath.message });
        return;
    }

    try {
        await sendFile(req, res, safePath.filePath);
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            sendJson(res, 404, { error: `未找到资源：${pathname}` });
        } else {
            sendJson(res, 500, { error: '服务器内部错误' });
        }
    }
};

// ---------- 启动 ----------

const port = Number(process.argv[2]) || DEFAULT_PORT;

const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
        // 静默：请求处理异常不再输出日志（需求：移除全部日志输出）
        if (!res.headersSent) {
            sendJson(res, 500, { error: '服务器内部错误' });
        } else {
            res.end();
        }
    });
});

server.listen(port, '127.0.0.1', () => {
    // 需求：移除全部日志输出 —— 请求级日志已全部移除；此处仅保留启动时一行必要提示，
    // 便于确认服务已就绪与访问地址（如需完全静默可删除本行）。
    console.log(`Server running at http://127.0.0.1:${port}/`);
});
