/* 书稿格式单元测试：node tools/format-test.mjs */
import { serializeBook, parseBook, specText, SPEC_PROMPT } from '../js/book-format.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

const project = {
  title: '青焰纪',
  genre: '玄幻 · 悬疑',
  pov: '第三人称有限视角',
  synopsis: '落魄铸剑师沈青焰为了找回被夺走的记忆，混入仙门做卧底。',
  style: '短句为主，画面感强\n少用成语',
  world: '九州之上，仙门以「剑契」御剑。\n剑契一断，持剑者便失去相关记忆。',
  goal: 2000,
  chunk: 800,
  characters: [
    { name: '沈青焰', role: '铸剑师', traits: '表面懒散爱开玩笑，实则记仇', goal: '找回被夺走的记忆', desc: '左手腕有一道环形旧疤' },
    { name: '白眠', role: '仙门执事', traits: '温柔而危险', goal: '守住秘密', desc: '' },
  ],
};
const chapters = [
  { order: 0, title: '第一章 断契', summary: '沈青焰在废剑冢捡到一柄没开锋的剑，剑上刻着自己的名字。', content: '雨下了一夜。\n\n沈青焰是被铁锈味呛醒的。' },
  { order: 1, title: '第二章 仙门来人', summary: '', content: '第二天清早，门口站着个撑伞的人。\n\n# 这行以井号开头，需要转义' },
  { order: 2, title: '', summary: '空标题的一章', content: '第三章的内容。' },
];

console.log('\n【1】导出 → 导入 往返一致');
const md = serializeBook(project, chapters);
console.log('---- 导出的标准书稿 ----');
console.log(md);
const back = parseBook(md);

check('书名', back.title === '青焰纪', back.title);
check('题材', back.meta.genre === '玄幻 · 悬疑', back.meta.genre);
check('视角', back.meta.pov === '第三人称有限视角', back.meta.pov);
check('一句话简介', back.meta.synopsis === project.synopsis, back.meta.synopsis);
check('文风（多行被压成一行）', back.meta.style === '短句为主，画面感强 少用成语', back.meta.style);
check('单章目标字数', back.meta.goal === 2000, String(back.meta.goal));
check('世界观小节', back.world.includes('剑契一断'), back.world);
check('角色数量', back.characters.length === 2, String(back.characters.length));
check('角色字段', back.characters[0].name === '沈青焰' && back.characters[0].role === '铸剑师' && back.characters[0].traits.includes('记仇'), JSON.stringify(back.characters[0]));
check('章节数', back.chapters.length === 3, String(back.chapters.length));
check('第1章标题', back.chapters[0].title === '第一章 断契', back.chapters[0].title);
check('第1章摘要', back.chapters[0].summary.includes('废剑冢'), back.chapters[0].summary);
check('第1章正文', back.chapters[0].content === chapters[0].content, JSON.stringify(back.chapters[0].content));
check('正文里的 # 转义后还原', back.chapters[1].content.includes('\n# 这行以井号开头'), JSON.stringify(back.chapters[1].content));
check('空标题章节自动补号', /^第3章/.test(back.chapters[2].title), back.chapters[2].title);
check('识别为标准格式', back.standard === true);
check('无警告', back.warnings.length === 0, back.warnings.join('|'));

console.log('\n【2】普通分章文本（第一章/第1章/数字编号混排）');
const loose = `我的小说

第一章 雪夜
他推开门。
外面在下雪。

第2章 来客
有人敲窗。

3. 真相
原来如此。
`;
const b2 = parseBook(loose);
check('识别 3 章', b2.chapters.length === 3, String(b2.chapters.length));
check('章名带序号', b2.chapters[0].title.includes('第一章') && b2.chapters[1].title.includes('第2章'), b2.chapters.map(c=>c.title).join(' / '));
check('正文归属正确', b2.chapters[2].content.includes('原来如此'), JSON.stringify(b2.chapters[2].content));

console.log('\n【3】一坨没分章的正文');
const b3 = parseBook('他醒了。\n\n屋里很暗。'.repeat(20));
check('回退成 1 章', b3.chapters.length === 1);
check('有提示警告', b3.warnings.some((w) => /没有识别到章节/.test(w)), b3.warnings.join('|'));

console.log('\n【4】AI 常见写法（无 # 号，用中文书名号与方括号）');
const aiish = `《荒海灯》
题材：科幻
视角：第一人称
一句话简介：灯塔守夜人在废土上收到三十年前的回信。
文风要求：冷峻，克制

【世界观设定】
海平面上升后，仅存七座灯塔。

【角色卡】
【陈默】
- 身份：守夜人
- 性格：沉默，怕黑
- 目标：找到信的寄件人

【第一章 夜航】
灯塔亮了。
`;
const b4 = parseBook(aiish);
check('书名', b4.title === '荒海灯', b4.title);
check('题材', b4.meta.genre === '科幻', b4.meta.genre);
check('视角', b4.meta.pov === '第一人称', b4.meta.pov);
check('世界观', b4.world.includes('七座灯塔'), b4.world);
check('角色卡', b4.characters.length === 1 && b4.characters[0].name === '陈默' && b4.characters[0].goal === '找到信的寄件人', JSON.stringify(b4.characters));
check('章节', b4.chapters.length === 1 && b4.chapters[0].content.includes('灯塔亮了'), JSON.stringify(b4.chapters));

console.log('\n【5】导出纯正文');
const plain = serializeBook(project, chapters, { plain: true });
check('纯正文不含 ## 标记', !plain.includes('## ') && plain.includes('第一章 断契'), plain.slice(0, 80));
check('纯正文含正文', plain.includes('雨下了一夜'));

console.log('\n【6】格式说明');
check('SPEC_PROMPT 有内容', SPEC_PROMPT.length > 200 && SPEC_PROMPT.includes('墨阁书稿格式'));
check('specText 带示例', specText().includes('## 角色卡') && specText().includes('示例'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
