// 读取 .sog/.ply 的包围盒，判断坐标系（Z-up vs Y-up）
import { readFile } from '@playcanvas/splat-transform'; 

const file = process.argv[2];
const data = await readFile(file);
console.log('文件:', file);
console.log('类型:', data.format);
console.log('splat 数:', data.numSplats);
console.log('包围盒:', JSON.stringify(data.bbox));
console.log('中心:', JSON.stringify(data.center));
console.log('尺度:', JSON.stringify(data.scale));
// 各轴范围（判断哪个轴是"垂直"方向）
const b = data.bbox;
console.log('轴范围:', {
    x: [b.min[0], b.max[0]].map(v => v.toFixed(2)).join('~'),
    y: [b.min[1], b.max[1]].map(v => v.toFixed(2)).join('~'),
    z: [b.min[2], b.max[2]].map(v => v.toFixed(2)).join('~')
});