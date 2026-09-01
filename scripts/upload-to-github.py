#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通过 GitHub Git Data API 重建 main 分支（laopocb/gaosi）：
- 读取当前工作区 git 追踪的文件（仅代码，无任何 ply/sog 数据）
- base64 上传 blob -> 构建 tree -> 创建孤儿 commit -> 强制更新 refs/heads/main
- 走 socks5h 代理访问 api.github.com（github.com 主站被代理阻断，git push 走不通）
- Token 自动从 Windows 凭据管理器读取（无需手动传参）

用法：
  python scripts/upload-to-github.py            # 自动读 token，上传全部代码
  python scripts/upload-to-github.py <TOKEN>    # 手动指定 token（可选）

前置条件：
  - Windows 凭据管理器中存在 git:https://github.com（用户 laopocb，40 位 PAT token）
  - socks5 代理 127.0.0.1:5180 可用（api.github.com 可达）
"""
import base64
import json
import os
import subprocess
import sys
import tempfile

REPO = 'laopocb/gaosi'
PROXY = 'socks5h://127.0.0.1:5180'
ROOT = r'D:\lm\高斯'

# ---------- Token 获取：优先命令行参数，否则自动读 Windows 凭据管理器 ----------
TOKEN = sys.argv[1] if len(sys.argv) > 1 else ''

def read_token_from_windows():
    """读取 Windows 凭据管理器中的 GitHub token（GCM get --no-ui，无弹窗）"""
    # 首选 GCM 专用 CLI（git-credential-manager get --no-ui），稳定无 GUI
    for base_cmd in (['git-credential-manager', 'get', '--no-ui'],
                     ['git-credential-manager-core', 'get', '--no-ui']):
        try:
            proc = subprocess.run(
                base_cmd, input='protocol=https\nhost=github.com\n\n',
                capture_output=True, text=True, timeout=12,
                env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'},
            )
            for line in proc.stdout.splitlines():
                if line.startswith('password='):
                    token = line[len('password='):].strip()
                    if len(token) >= 20:
                        return token
        except FileNotFoundError:
            continue
        except Exception:
            continue
    # 兜底：git credential fill（helper 逐个尝试，超时保护）
    for helper in ('manager-core', 'manager', 'wincred'):
        try:
            proc = subprocess.run(
                ['git', '-c', f'credential.helper={helper}', 'credential', 'fill'],
                input='protocol=https\nhost=github.com\n\n',
                capture_output=True, text=True, timeout=10,
                env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'},
            )
            for line in proc.stdout.splitlines():
                if line.startswith('password='):
                    token = line[len('password='):].strip()
                    if len(token) >= 20:
                        return token
        except Exception:
            continue
    return ''

if not TOKEN:
    TOKEN = read_token_from_windows()
    if TOKEN:
        print('  [凭据] 已从 Windows 凭据管理器读取 token（laopocb）')
    else:
        print('[错误] 未找到 GitHub token', file=sys.stderr)
        print('  请确认 Windows 凭据管理器中有 git:https://github.com 条目，', file=sys.stderr)
        print('  或手动传参: python scripts/upload-to-github.py <TOKEN>', file=sys.stderr)
        sys.exit(1)

def curl(method, url, data=None):
    cmd = ['curl', '-x', PROXY, '-s', '-X', method,
           '-H', f'Authorization: token {TOKEN}',
           '-H', 'Accept: application/vnd.github+json']
    tmp_path = None
    if data is not None:
        # Windows 命令行长度限制：payload 写入临时文件，用 -d @file 传递
        fd, tmp_path = tempfile.mkstemp(suffix='.json', prefix='gh_payload_')
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            json.dump(data, fh, ensure_ascii=False)
        cmd += ['-H', 'Content-Type: application/json', '-d', f'@{tmp_path}']
    cmd += [url]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if tmp_path and os.path.exists(tmp_path):
        try:
            os.remove(tmp_path)
        except OSError:
            pass
    if r.returncode != 0:
        print(f'  curl 失败: {r.stderr[:200]}', file=sys.stderr)
        return None
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {'_raw': r.stdout}

# 1. 收集要上传的文件（git 追踪的代码文件，数据目录已被 .gitignore 排除）
#    -c core.quotepath=false：防止中文文件名被转义成八进制（如 \344\270\212...）
files = subprocess.run(
    ['git', '-C', ROOT, '-c', 'core.quotepath=false', 'ls-files'],
    capture_output=True, text=True,
).stdout.split()
if not files:
    print('[错误] git ls-files 为空，请确认仓库状态', file=sys.stderr)
    sys.exit(1)
print(f'共 {len(files)} 个文件待上传')

# 2. 上传 blobs，构建 tree 条目
tree_entries = []
for f in files:
    path = os.path.join(ROOT, f.replace('/', os.sep))
    if not os.path.isfile(path):
        print(f'  [跳过] {f} (不存在)')
        continue
    with open(path, 'rb') as fh:
        content = fh.read()
    mode = '100755' if f.endswith(('.sh', '.mjs', '.py')) else '100644'
    blob = curl('POST', f'https://api.github.com/repos/{REPO}/git/blobs', {
        'content': base64.b64encode(content).decode(),
        'encoding': 'base64',
    })
    if not blob or 'sha' not in blob:
        print(f'  [失败] {f}: {str(blob)[:150]}', file=sys.stderr)
        sys.exit(1)
    tree_entries.append({'path': f, 'mode': mode, 'type': 'blob', 'sha': blob['sha']})
    print(f'  [OK] {f} ({len(content)} bytes)')

# 3. 创建 tree
tree = curl('POST', f'https://api.github.com/repos/{REPO}/git/trees', {'tree': tree_entries})
if not tree or 'sha' not in tree:
    print(f'[失败] 创建 tree: {str(tree)[:300]}', file=sys.stderr)
    sys.exit(1)
print(f'tree sha: {tree["sha"]}')

# 4. 创建孤儿 commit（无父提交 -> 历史里彻底没有数据文件）
commit = curl('POST', f'https://api.github.com/repos/{REPO}/git/commits', {
    'message': 'feat: 3D 高斯查看器完整代码（圆形摇杆UI/碰撞/渐进加载）；无点云数据',
    'tree': tree['sha'],
})
if not commit or 'sha' not in commit:
    print(f'[失败] 创建 commit: {str(commit)[:300]}', file=sys.stderr)
    sys.exit(1)
print(f'commit sha: {commit["sha"]}')

# 5. 强制更新 main 分支
ref = curl('PATCH', f'https://api.github.com/repos/{REPO}/git/refs/heads/main', {
    'sha': commit['sha'],
    'force': True,
})
if ref and 'ref' in ref:
    print(f'[成功] main 分支已更新: {ref["ref"]} -> {ref.get("object", {}).get("sha", "")}')
    print(f'[完成] 访问 https://github.com/laopocb/gaosi 查看最新代码')
else:
    print(f'[警告] ref 更新响应异常: {str(ref)[:300]}', file=sys.stderr)
    sys.exit(1)
