/* 清理测试/截图脚本留下的临时 Chrome 配置目录
 * 用法：node tools/clean.mjs [保留最近多少小时]   默认 0（全清）
 */
import { sweepStaleProfiles } from './temp.mjs';

const hours = Number(process.argv[2] ?? 0);
const { count, bytes } = sweepStaleProfiles(hours * 3600 * 1000);
console.log(count
  ? `🧹 清理临时目录 ${count} 个，释放 ${(bytes / 1024 / 1024).toFixed(1)} MB`
  : '没有需要清理的临时目录');
