/* ================= 墨阁书稿格式（Markdown 标准化）=================
 *
 * 一个格式，三个用途：
 *   1. 导出：把整本书写成标准书稿，人看得懂、AI 也读得懂
 *   2. 导入：认识自己导出的文件，也尽量认识别人的分章文本
 *   3. 喂 AI：SPEC_PROMPT 可以直接贴给任何模型，让它按这个格式产出
 *
 * 格式长这样（纯文本，记事本可读；扩展名 .md / .txt 都行）：
 *
 *   # 青焰纪
 *
 *   - 题材：玄幻 · 悬疑
 *   - 视角：第三人称有限视角
 *   - 一句话简介：落魄铸剑师沈青焰为了找回被夺走的记忆，混入仙门做卧底。
 *   - 文风要求：短句为主，画面感强
 *   - 单章目标字数：2000
 *
 *   ## 世界观设定
 *
 *   九州之上，仙门以「剑契」御剑……
 *
 *   ## 角色卡
 *
 *   ### 沈青焰
 *   - 身份：铸剑师
 *   - 性格：表面懒散爱开玩笑，实则记仇
 *   - 目标：找回被夺走的记忆
 *   - 其他：左手腕有一道环形旧疤
 *
 *   ## 第一章 断契
 *
 *   > 摘要：沈青焰在废剑冢捡到一柄没开锋的剑。
 *
 *   雨下了一夜。
 */

export const FORMAT_NAME = '墨阁书稿格式';
export const FORMAT_VERSION = 1;

/* 固定小节名（二级标题里出现这些词就当成"设定小节"而不是"章节"） */
const SECTION_WORLD = ['世界观设定', '世界观', '背景设定', '世界观与设定', '设定', '世界设定'];
const SECTION_STYLE = ['文风要求', '文风', '写作风格', '风格', '写作要求'];
const SECTION_CHARS = ['角色卡', '角色', '人物卡', '主要角色', '人物设定', '人物'];
const ALL_SECTIONS = [...SECTION_WORLD, ...SECTION_STYLE, ...SECTION_CHARS];

/* 设定清单里认识的键 */
const META_KEYS = [
  { field: 'title', names: ['书名', '标题', '名称'] },
  { field: 'genre', names: ['题材', '类型', '分类', '标签'] },
  { field: 'pov', names: ['视角', '叙事视角', '人称'] },
  { field: 'synopsis', names: ['一句话简介', '简介', '内容简介', '故事简介'] },
  { field: 'style', names: ['文风要求', '文风', '写作风格'] },
  { field: 'goal', names: ['单章目标字数', '目标字数', '每章字数'], number: true },
  { field: 'chunk', names: ['AI单次输出字数', '单次输出字数'], number: true },
];

/* 角色卡里认识的键 -> 角色对象字段 */
const CHAR_KEYS = [
  { field: 'role', names: ['身份', '角色', '职业', '职位'] },
  { field: 'traits', names: ['性格', '性格特点', '说话方式', '特点'] },
  { field: 'goal', names: ['目标', '欲望', '核心欲望', '动机'] },
  { field: 'desc', names: ['其他', '外貌', '背景', '经历', '关系', '备注', '描述'] },
];

const CHAPTER_RE = /^[\s\u3000]*((?:第\s*[0-9０-９零〇一二三四五六七八九十百千两]{1,8}\s*[章回节篇卷])|(?:Chapter\s*\d+)|(?:CHAPTER\s*\d+))([\s\u3000]*)(.*)$/;
const NUM_RE = /^[\s\u3000]*(\d{1,4})\s*[.、:：]\s*(.+)$/;
const SEP_AFTER = /^[\s\u3000：:、.．\-—·]/;

function norm(s) {
  return String(s || '').replace(/[《》【】\[\]（）()\s\u3000]/g, '').trim();
}
function matchNames(text, table) {
  const n = norm(text);
  for (const row of table) {
    for (const name of (row.names || [row.name])) {
      if (n === norm(name)) return row;
    }
  }
  return null;
}

/* ---------------- 导出 ---------------- */
function escapeBody(text) {
  return String(text || '').replace(/^(\s*)(#{1,6}\s)/gm, '$1\\$2');
}
function unescapeBody(text) {
  return String(text || '').replace(/^(\s*)\\(#{1,6}\s)/gm, '$1$2');
}

/** 把作品序列化成标准书稿 */
export function serializeBook(project, chapters, { plain = false, summaries = true } = {}) {
  const p = project || {};
  const list = (chapters || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));

  if (plain) {
    const out = [`《${p.title || '未命名'}》`, ''];
    if (p.genre) out.push(`题材：${p.genre}`);
    if (p.synopsis) out.push(`简介：${p.synopsis}`);
    out.push('');
    list.forEach((c, i) => {
      out.push('', plainChapterTitle(c, i), '');
      out.push(String(c.content || '').trim());
    });
    return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
  }

  const L = [];
  L.push(`# ${p.title || '未命名'}`, '');
  const meta = [];
  if (p.genre) meta.push(`- 题材：${oneLine(p.genre)}`);
  if (p.pov) meta.push(`- 视角：${oneLine(p.pov)}`);
  if (p.synopsis) meta.push(`- 一句话简介：${oneLine(p.synopsis)}`);
  if (p.style) meta.push(`- 文风要求：${oneLine(p.style)}`);
  if (p.goal) meta.push(`- 单章目标字数：${p.goal}`);
  if (p.chunk) meta.push(`- AI单次输出字数：${p.chunk}`);
  if (meta.length) L.push(...meta, '');

  if (p.world && String(p.world).trim()) L.push('## 世界观设定', '', String(p.world).trim(), '');

  const chars = (p.characters || []).filter((c) => c && (c.name || c.role || c.traits || c.goal || c.desc));
  if (chars.length) {
    L.push('## 角色卡', '');
    for (const c of chars) {
      L.push(`### ${c.name || '未命名'}`);
      if (c.role) L.push(`- 身份：${oneLine(c.role)}`);
      if (c.traits) L.push(`- 性格：${oneLine(c.traits)}`);
      if (c.goal) L.push(`- 目标：${oneLine(c.goal)}`);
      if (c.desc) L.push(`- 其他：${oneLine(c.desc)}`);
      L.push('');
    }
  }

  list.forEach((c, i) => {
    L.push(`## ${chapterHeading(c, i)}`, '');
    if (summaries && c.summary && String(c.summary).trim()) L.push(`> 摘要：${oneLine(c.summary)}`, '');
    const body = escapeBody(String(c.content || '').trim());
    L.push(body || '', '');
  });

  return L.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
}

function oneLine(s) {
  return String(s || '').replace(/\s*\n+\s*/g, ' ').trim();
}
function stripChapterNo(title) {
  return String(title || '').replace(/^第\s*[0-9０-９零〇一二三四五六七八九十百千两]{1,8}\s*[章回节篇卷]\s*/, '').trim();
}
/* 纯正文导出：原本写了「第X章」就沿用，否则补一个序号 */
function plainChapterTitle(c, i) {
  const t = String(c.title || '').trim();
  if (/^第\s*[0-9０-９零〇一二三四五六七八九十百千两]{1,8}\s*[章回节篇卷]/.test(t)) return t;
  if (/^chapter\s*\d+/i.test(t)) return t;
  return `第${i + 1}章　${t}`.trim();
}
function chapterHeading(c, i) {
  const t = String(c.title || '').trim();
  if (!t) return `第${i + 1}章`;
  if (/^第\s*[0-9０-９零〇一二三四五六七八九十百千两]{1,8}\s*[章回节篇卷]/.test(t)) return t;
  if (/^chapter\s*\d+/i.test(t)) return t;
  return `第${i + 1}章 ${t}`;
}

/* ---------------- 导入 ---------------- */
/**
 * 解析任意文本（墨阁标准书稿 / 普通分章文本 / 一坨没分章的正文）
 * @returns {{title, meta, world, style, characters, chapters, warnings, standard, preamble}}
 */
export function parseBook(raw) {
  const text = String(raw == null ? '' : raw)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  const out = {
    title: '', meta: {}, world: '', style: '',
    characters: [], chapters: [], warnings: [],
    standard: false, preamble: '',
  };

  let section = null;      // null | 'world' | 'style' | 'chars'
  let chapter = null;      // 当前章节
  let curChar = null;      // 角色卡里的当前角色
  let sawH1 = false, sawH2Chapter = false, sawSection = false, sawMetaList = false;
  const metaBuf = [];
  const worldBuf = [];
  const styleBuf = [];
  const preambleBuf = [];
  let sawChapterLike = 0;
  let chapterCount = 0;

  const headingAt = (line) => {
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    return m ? { level: m[1].length, text: m[2].trim() } : null;
  };
  const bracketAt = (line) => {
    const m = /^\s*[【\[《]\s*(.+?)\s*[】\]》]\s*$/.exec(line);
    return m ? m[1].trim() : null;
  };
  const chapterAt = (line, { bare = false } = {}) => {
    const m = CHAPTER_RE.exec(line);
    if (m) {
      const after = line.slice(line.indexOf(m[1]) + m[1].length);
      // 裸行判断：章号后面必须跟空格/标点/结尾。
      // 否则「第三章的内容。」这种正文会被误判成章节标题。
      if (bare && after && !SEP_AFTER.test(after)) return null;
      const label = m[1].replace(/\s+/g, '');
      const rest = (m[3] || '').replace(/^[：:、.．\-—·]\s*/, '').trim();
      return { label, numeric: false, title: rest ? `${label} ${rest}`.replace(/\s+/g, ' ').trim() : label };
    }
    const n = NUM_RE.exec(line);
    if (n) {
      const rest = (n[2] || '').trim();
      if (!rest) return null;
      if (bare && line.trim().length > 40) return null;
      return { label: n[1], numeric: true, title: `${n[1]} ${rest}`.replace(/\s+/g, ' ').trim() };
    }
    return null;
  };
  /* 裸行章节标题（普通 txt）：第X章/Chapter 总是认；纯数字编号更谨慎 */
  const bareChapterAt = (trimmed, prevBlank, hasChapter) => {
    const ch = chapterAt(trimmed, { bare: true });
    if (!ch) return null;
    if (ch.numeric && hasChapter && !prevBlank) return null;   // 正文中间的 "1." 多半是列表
    return ch;
  };
  const pushMeta = (line) => metaBuf.push(line);
  const pushBody = (line) => {
    if (chapter) chapter.lines.push(line);
    else if (section === 'world') worldBuf.push(line);
    else if (section === 'style') styleBuf.push(line);
    else if (section === 'chars') { /* 角色卡里的散文本忽略 */ }
    else preambleBuf.push(line);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const h = headingAt(line);
    const br = h ? null : bracketAt(line);

    if (h || br) {
      const level = h ? h.level : 2;
      const text2 = h ? h.text : br;
      const sec = matchNames(text2, [
        ...SECTION_WORLD.map((n) => ({ field: 'world', names: [n] })),
        ...SECTION_STYLE.map((n) => ({ field: 'style', names: [n] })),
        ...SECTION_CHARS.map((n) => ({ field: 'chars', names: [n] })),
      ]);

      if (sec && level <= 3) {
        section = sec.field;
        chapter = null; curChar = null;
        sawSection = true;
        continue;
      }

      const ch = chapterAt(text2);
      if (ch && (level <= 2 || /^第.*[章回节篇卷]/.test(text2))) {
        // 二级标题里认出章节 → 新章节
        chapter = { title: ch.title, summary: '', lines: [] };
        out.chapters.push(chapter);
        chapterCount++;
        section = null; curChar = null;
        sawH2Chapter = true;
        continue;
      }

      if (level === 1 && !out.title) { out.title = text2.replace(/^[《【\[]|[》】\]]$/g, '').trim(); sawH1 = true; continue; }

      // 第一行是《书名》/【书名】这种，也当书名（角色卡小节里的 【角色名】不算）
      if (!out.title && !out.chapters.length && level <= 2 && section === null) {
        out.title = text2.replace(/^[《【\[]|[》】\]]$/g, '').trim();
        sawH1 = true;
        continue;
      }

      if (section === 'chars' && level >= 2) {
        curChar = { name: text2, role: '', traits: '', goal: '', desc: '' };
        out.characters.push(curChar);
        continue;
      }

      if (chapter) { chapter.lines.push(line); continue; }
      if (level <= 2) { section = null; continue; }
      pushBody(line);
      continue;
    }

    // 非标题行：先看是不是裸行章节标题（普通 txt 里很常见）
    if (trimmed && section === null) {
      const prevBlank = i === 0 || !lines[i - 1].trim();
      const bare = bareChapterAt(trimmed, prevBlank, !!chapter);
      if (bare) {
        chapter = { title: bare.title, summary: '', lines: [] };
        out.chapters.push(chapter);
        chapterCount++;
        curChar = null;
        continue;
      }
    }

    // 非标题行
    if (!chapter) {
      const bullet = /^\s*[-*+•]\s*(.+)$/.exec(line);
      const kvSrc = (bullet ? bullet[1] : line).trim();
      const kv = /^([^：:]{1,14})[：:]\s*(.*)$/.exec(kvSrc);
      if (kv) {
        const key = kv[1].trim();
        const val = kv[2].trim();
        if (section === 'chars' && curChar && val) {
          const ck = matchNames(key, CHAR_KEYS);
          if (ck) {
            curChar[ck.field] = curChar[ck.field] ? curChar[ck.field] + '；' + val : val;
            continue;
          }
        }
        const mk = matchNames(key, META_KEYS);
        if (mk && val) {
          if (mk.number) {
            const n = parseInt(val.replace(/[^\d]/g, ''), 10);
            if (Number.isFinite(n) && n > 0) out.meta[mk.field] = n;
          } else {
            out.meta[mk.field] = val;
          }
          if (mk.field === 'title' && !out.title) { out.title = val; sawH1 = true; }
          sawMetaList = true;
          continue;
        }
      }
      if (bullet && section === null) { pushMeta(line); continue; }
      if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) continue;   // --- 分隔线
      pushBody(line);
      continue;
    }

    // 章节内：开头的「摘要：」行算本章摘要
    const sumM = /^\s*>?\s*(?:摘要|本章摘要|内容摘要)[：:]\s*(.*)$/.exec(line);
    if (sumM && chapter.lines.filter((l) => l.trim()).length === 0 && !chapter.summary) {
      chapter.summary = sumM[1].trim();
      continue;
    }
    chapter.lines.push(line);
  }

  // 章节对象补上方法太啰嗦，这里统一转成普通对象
  out.chapters = out.chapters.map((c) => {
    let content = c.lines.join('\n');
    content = unescapeBody(content).replace(/^\n+/, '').replace(/\s+$/, '');
    return { title: c.title || '', summary: c.summary || '', content };
  });
  // 上面的摘要判断需要用原始行，这里重扫一遍修正（见下）
  fixSummaries(out);

  out.world = worldBuf.join('\n').replace(/^\n+|\s+$/g, '');
  out.style = styleBuf.join('\n').replace(/^\n+|\s+$/g, '');
  out.preamble = preambleBuf.join('\n').replace(/^\n+|\s+$/g, '');
  // 判定是否"已经是墨阁标准书稿"：有书名 + （设定清单 或 固定小节）
  out.standard = sawH1 && (sawMetaList || sawSection || sawH2Chapter) && sawMetaList;

  if (out.meta.style && !out.style) out.style = out.meta.style;
  if (out.meta.synopsis == null) out.meta.synopsis = '';
  // 书名无论从哪来（# 标题 / 《》/ 设定行），都回填进 meta，方便调用方统一取
  if (out.title && !out.meta.title) out.meta.title = out.title;

  out.chapters = out.chapters.filter((c) => c.title || c.content);

  if (!out.chapters.length) {
    const body = (out.preamble || text).trim();
    if (body) {
      out.chapters.push({ title: '第一章', summary: '', content: body });
      out.warnings.push('没有识别到章节标记，已把全文作为第 1 章导入；可以用「AI 整理成标准格式」自动分章。');
    } else {
      out.warnings.push('内容为空。');
    }
  }
  if (out.chapters.length === 1 && !out.standard) {
    out.warnings.push('只识别到 1 章，可能缺少章节标题；可以用「AI 整理成标准格式」自动分章。');
  }
  return out;
}

/* 摘要识别需要在章节正文首行判断，这里做一次后处理 */
function fixSummaries(out) {
  // parseBook 里已按行处理，这里只兜底：把正文第一行形如"摘要：xxx"的挪到 summary
  for (const c of out.chapters) {
    const lines = c.content.split('\n');
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      const m = /^\s*(?:摘要|本章摘要)[：:]\s*(.+)$/.exec(lines[i]);
      if (m && !c.summary) {
        c.summary = m[1].trim();
        lines.splice(i, 1);
        c.content = lines.join('\n').replace(/^\n+/, '');
        break;
      }
    }
  }
}

/* ---------------- 给 AI 的格式说明 ---------------- */
export const SPEC_PROMPT = `${FORMAT_NAME} v${FORMAT_VERSION}（Markdown 纯文本，UTF-8）：

- 第一行是书名：\`# 书名\`
- 紧接着是设定清单，每行一个 \`- 键：值\`，可用键只有：
  题材、视角、一句话简介、文风要求、单章目标字数、AI单次输出字数
- 然后可选三个固定小节（二级标题）：\`## 世界观设定\`、\`## 角色卡\`
  角色卡里每个角色一个三级标题 \`### 角色名\`，下面用 \`- 身份：\` \`- 性格：\` \`- 目标：\` \`- 其他：\` 描述
- 每一章用二级标题开头：\`## 第N章 章节名\`（N 连续编号）
- 章节标题下面可以有一行引用式摘要：\`> 摘要：一句话概括本章\`
- 之后就是章节正文，段落之间空一行
- 正文里如果某行要以 # 开头，写成 \\# 转义
- 不要使用其他 Markdown 语法（表格、代码块、链接、加粗），不要写任何解释或注释
- 输出的扩展名可以是 .md 或 .txt，内容完全一样`;

/** 供 App 内「复制格式说明」按钮使用 */
export function specText() {
  return `【${FORMAT_NAME} v${FORMAT_VERSION}】

${SPEC_PROMPT}

示例：
# 青焰纪

- 题材：玄幻 · 悬疑
- 视角：第三人称有限视角
- 一句话简介：落魄铸剑师沈青焰为了找回被夺走的记忆，混入仙门做卧底。
- 文风要求：短句为主，画面感强
- 单章目标字数：2000

## 世界观设定

九州之上，仙门以「剑契」御剑。剑契一断，持剑者便失去相关记忆。

## 角色卡

### 沈青焰
- 身份：铸剑师
- 性格：表面懒散爱开玩笑，实则记仇
- 目标：找回被夺走的记忆
- 其他：左手腕有一道环形旧疤

## 第一章 断契

> 摘要：沈青焰在废剑冢捡到一柄没开锋的剑，剑上刻着自己的名字。

雨下了一夜。

沈青焰是被铁锈味呛醒的。
`;
}
