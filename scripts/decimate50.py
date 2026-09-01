"""
point_cloud.compressed.ply 抽稀 → point_XX.compressed.ply（参数化）
=============================================================
用法：python decimate50.py <输入.ply> <输出.ply> <保留比例>
  例：python decimate50.py point_cloud.compressed.ply point_50.compressed.ply 0.5
      python decimate50.py point_cloud.compressed.ply point_75.compressed.ply 0.25
格式：Supersplat chunked compressed PLY（splat-transform 3.3.1）
  element chunk N    → 每 chunk 18 个 float 元数据（position/scale/color 的 min/max）
  element vertex M   → 每 splat 4 个 uint（packed_position/rotation/scale/color）
解码（GPU shader）：
  position = mix(chunkMinXYZ, chunkMaxXYZ, unpack111011(packed_position))  # 11/10/11 位量化
  scale    = exp(mix(chunkMinScale, chunkMaxScale, unpack111011(packed_scale)))
  color    = mix(chunkMinRGB, chunkMaxRGB, unpack8888(packed_color.rgb))
  rotation = unpackRotation(packed_rotation)  # 无 chunk 依赖，原样复用
抽稀后必须：重新分组(每256) → 重算 chunk min/max → 重新量化 packed 数据。
"""
import numpy as np
import re, os, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else r'D:/lm/高斯/new_data/point_cloud.compressed.ply'
DST = sys.argv[2] if len(sys.argv) > 2 else r'D:/lm/高斯/new_data/point_50.compressed.ply'
KEEP = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
assert 0 < KEEP < 1, '保留比例须在 (0,1) 之间'

# ---------- 1. 读头部 ----------
with open(SRC, 'rb') as f:
    head = b''
    while True:
        line = f.readline()
        head += line
        if line == b'end_header\n':
            break
hdr = head.decode('ascii', errors='ignore')
numChunks = int(re.search(r'element chunk (\d+)', hdr).group(1))
numVerts = int(re.search(r'element vertex (\d+)', hdr).group(1))
print(f'源文件: {numChunks} chunks, {numVerts} verts')

# ---------- 2. 读数据 ----------
with open(SRC, 'rb') as f:
    f.seek(len(head))
    chunk_data = np.fromfile(f, dtype='<f4', count=numChunks * 18).reshape(numChunks, 18)
    verts = np.fromfile(f, dtype='<u4', count=numVerts * 4).reshape(numVerts, 4)
print('数据读取完成:', chunk_data.shape, verts.shape)

# ---------- 3. 解包（向量化） ----------
chunk_id = (np.arange(numVerts) // 256).astype(np.int64)
p_min = chunk_data[chunk_id, 0:3]
p_max = chunk_data[chunk_id, 3:6]
s_min = chunk_data[chunk_id, 6:9]
s_max = chunk_data[chunk_id, 9:12]
c_min = chunk_data[chunk_id, 12:15]
c_max = chunk_data[chunk_id, 15:18]

# unpack111011（position/scale 的 11/10/11 位）
def unpack111011(bits):
    x = ((bits >> 21).astype(np.float64)) / 2047.0
    y = (((bits >> 11) & 0x3ff).astype(np.float64)) / 1023.0
    z = ((bits & 0x7ff).astype(np.float64)) / 2047.0
    return np.stack([x, y, z], axis=1)

pos = p_min + unpack111011(verts[:, 0]) * (p_max - p_min)
slog = s_min + unpack111011(verts[:, 2]) * (s_max - s_min)
rgb = np.stack([
    ((verts[:, 3] >> 0) & 0xff).astype(np.float64) / 255.0,
    ((verts[:, 3] >> 8) & 0xff).astype(np.float64) / 255.0,
    ((verts[:, 3] >> 16) & 0xff).astype(np.float64) / 255.0
], axis=1)
col = c_min + rgb * (c_max - c_min)
rot = verts[:, 1]          # rotation 无 chunk 依赖，原样复用
alpha = (verts[:, 3] >> 24) & 0xff  # alpha 保留

# ---------- 4. 抽稀（固定 seed，随机保留 KEEP 比例） ----------
rng = np.random.default_rng(42)
perm = rng.permutation(numVerts)
idx = np.sort(perm[: int(numVerts * KEEP)])
n2 = len(idx)
print(f'抽稀后: {n2} verts (保留 {n2/numVerts*100:.1f}%)')

pos_k = pos[idx]; slog_k = slog[idx]; col_k = col[idx]
rot_k = rot[idx]; alpha_k = alpha[idx]

# ---------- 5. 重新分组（每 256）并计算 chunk min/max ----------
numChunks2 = (n2 + 255) // 256
c2 = np.zeros((numChunks2, 18), dtype=np.float64)
starts = np.arange(numChunks2) * 256
ends = np.minimum(starts + 256, n2)
for i in range(numChunks2):
    s, e = starts[i], ends[i]
    seg_p = pos_k[s:e]; seg_s = slog_k[s:e]; seg_c = col_k[s:e]
    c2[i, 0:3] = seg_p.min(axis=0); c2[i, 3:6] = seg_p.max(axis=0)
    c2[i, 6:9] = seg_s.min(axis=0); c2[i, 9:12] = seg_s.max(axis=0)
    c2[i, 12:15] = seg_c.min(axis=0); c2[i, 15:18] = seg_c.max(axis=0)
print(f'新 chunk: {numChunks2}')

# ---------- 6. 重新量化 ----------
cid2 = (np.arange(n2) // 256).astype(np.int64)
p_min2 = c2[cid2, 0:3]; p_max2 = c2[cid2, 3:6]
s_min2 = c2[cid2, 6:9]; s_max2 = c2[cid2, 9:12]
c_min2 = c2[cid2, 12:15]; c_max2 = c2[cid2, 15:18]
EPS = 1e-9

def quantize_111011(val, vmin, vmax):
    span = np.maximum(vmax - vmin, EPS)
    t = np.clip((val - vmin) / span, 0.0, 1.0)
    return (np.round(t * [2047.0, 1023.0, 2047.0])).astype(np.uint32)

q = quantize_111011(pos_k, p_min2, p_max2)
packed_pos = (q[:, 0] << 21) | (q[:, 1] << 11) | q[:, 2]

qs = quantize_111011(slog_k, s_min2, s_max2)
packed_scale = (qs[:, 0] << 21) | (qs[:, 1] << 11) | qs[:, 2]

span_c = np.maximum(c_max2 - c_min2, EPS)
t_c = np.clip((col_k - c_min2) / span_c, 0.0, 1.0)
qc = np.round(t_c * 255.0).astype(np.uint32)
packed_color = qc[:, 0] | (qc[:, 1] << 8) | (qc[:, 2] << 16) | (alpha_k.astype(np.uint32) << 24)

verts2 = np.stack([packed_pos, rot_k, packed_scale, packed_color], axis=1)

# ---------- 7. 写 PLY ----------
props_chunk = [
    ('min_x',), ('min_y',), ('min_z',), ('max_x',), ('max_y',), ('max_z',),
    ('min_scale_x',), ('min_scale_y',), ('min_scale_z',),
    ('max_scale_x',), ('max_scale_y',), ('max_scale_z',),
    ('min_r',), ('min_g',), ('min_b',), ('max_r',), ('max_g',), ('max_b',)
]
header_lines = ['ply', 'format binary_little_endian 1.0',
                'comment Generated by splat-transform 3.3.1',
                f'comment [decimated {int((1-KEEP)*100)}%] {os.path.basename(SRC)} -> {os.path.basename(DST)} ({n2} verts)',
                f'element chunk {numChunks2}']
for p in props_chunk:
    header_lines.append(f'property float {p[0]}')
header_lines.append(f'element vertex {n2}')
for p in ['packed_position', 'packed_rotation', 'packed_scale', 'packed_color']:
    header_lines.append(f'property uint {p}')
header_lines.append('end_header')
header_text = ('\n'.join(header_lines) + '\n').encode('ascii')

with open(DST, 'wb') as f:
    f.write(header_text)
    f.write(c2.astype('<f4').tobytes())
    f.write(verts2.astype('<u4').tobytes())

size = os.path.getsize(DST)
print(f'输出: {DST} ({size/1048576:.1f}MB)')

# ---------- 8. 自校验：重新解析输出 ----------
with open(DST, 'rb') as f:
    h2 = b''
    while True:
        line = f.readline()
        h2 += line
        if line == b'end_header\n':
            break
hdr2 = h2.decode('ascii', errors='ignore')
nC2 = int(re.search(r'element chunk (\d+)', hdr2).group(1))
nV2 = int(re.search(r'element vertex (\d+)', hdr2).group(1))
with open(DST, 'rb') as f:
    f.seek(len(h2))
    cd2 = np.fromfile(f, dtype='<f4', count=nC2 * 18).reshape(nC2, 18)
    vd2 = np.fromfile(f, dtype='<u4', count=nV2 * 4).reshape(nV2, 4)
assert nC2 == numChunks2 and nV2 == n2, '文件结构不一致'
assert vd2.shape[1] == 4
print(f'自校验通过: chunk={nC2}, vertex={nV2}, 结构完整')
