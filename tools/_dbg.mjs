import { serializeBook, parseBook } from '../js/book-format.js';
const project = { title: '青焰纪', genre: '玄幻', pov: '第三人称有限视角', synopsis: '简介', style: '文风', world: '世界', goal: 2000, chunk: 800,
  characters: [{ name: '沈青焰', role: '铸剑师', traits: '性格', goal: '目标', desc: '其他' }] };
const chapters = [{ order: 0, title: '第一章 断契', summary: '摘要一', content: '雨下了一夜。' },
  { order: 1, title: '第二章 仙门来人', summary: '', content: '第二天清早。\n\n# 这行以井号开头，需要转义' },
  { order: 2, title: '', summary: '空标题', content: '第三章的内容。' }];
const md = serializeBook(project, chapters);
const back = parseBook(md);
console.log('章节数:', back.chapters.length);
back.chapters.forEach((c, i) => console.log(`  [${i}] title=${JSON.stringify(c.title)} summary=${JSON.stringify(c.summary)} content=${JSON.stringify(c.content.slice(0, 40))}`));
console.log('\n--- 纯正文 ---');
const plain = serializeBook(project, chapters, { plain: true });
console.log(plain);
console.log("含 '## ' ?", plain.includes('## '));
