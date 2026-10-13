/* ================= 提示词与上下文组装 ================= */

export function buildContext({ project, chapters = [], current = null, ctxChars = 6000 }) {
  const p = project || {};
  const parts = [];

  const info = [];
  if (p.title) info.push(`书名：${p.title}`);
  if (p.genre) info.push(`题材：${p.genre}`);
  if (p.pov) info.push(`叙事视角：${p.pov}`);
  if (p.synopsis) info.push(`一句话简介：${p.synopsis}`);
  if (info.length) parts.push('【作品信息】\n' + info.join('\n'));

  if (p.world) parts.push('【世界观设定】\n' + p.world);
  if (p.style) parts.push('【文风要求】\n' + p.style);

  const chars = (p.characters || []).filter((c) => c.name || c.desc);
  if (chars.length) {
    parts.push(
      '【主要角色】\n' +
        chars
          .map((c) => {
            const head = [c.name, c.role].filter(Boolean).join('（') + (c.role ? '）' : '');
            const traits = [c.traits, c.goal, c.desc].filter(Boolean).join('；');
            return `- ${head || '未命名'}${traits ? '：' + traits : ''}`;
          })
          .join('\n')
    );
  }

  const withSummary = chapters.filter((c) => (c.summary || '').trim());
  if (withSummary.length) {
    parts.push(
      '【前情摘要】\n' +
        withSummary
          .slice(-30)
          .map((c) => `第${c.order + 1}章《${c.title || '未命名'}》：${c.summary.trim()}`)
          .join('\n')
    );
  } else {
    // 没有摘要时，退回用"上一章结尾"做前情
    const idx = current ? chapters.findIndex((c) => c.id === current.id) : chapters.length;
    const prev = chapters
      .slice(Math.max(0, (idx < 0 ? chapters.length : idx) - 2), idx < 0 ? chapters.length : idx)
      .filter((c) => (c.content || '').trim());
    if (prev.length) {
      parts.push(
        '【前情（上一章结尾）】\n' +
          prev
            .map((c) => `第${c.order + 1}章《${c.title || '未命名'}》结尾：\n…${(c.content || '').slice(-Math.min(1200, ctxChars / Math.max(1, prev.length) | 0))}`)
            .join('\n\n')
      );
    }
  }

  if (current) {
    const body = (current.content || '').trim();
    const tail = body.length > ctxChars ? '……（前文略）\n' + body.slice(-ctxChars) : body;
    parts.push(
      `【当前章节】第${current.order + 1}章《${current.title || '未命名'}》\n${tail || '（本章还是空的）'}`
    );
  }

  return parts.join('\n\n');
}

const NO_MARKDOWN =
  '只输出小说正文本身：不要解释、不要点评、不要写"好的"之类的开场白，不要使用 Markdown 标记（#、*、```）或"第X章"以外的标题。';

function baseSystem(settingsSystem, project) {
  const extra = [];
  if (project?.pov) extra.push(`统一使用${project.pov}叙事。`);
  if (project?.style) extra.push(`严格遵守用户给出的文风要求。`);
  return [settingsSystem, ...extra].filter(Boolean).join('\n');
}

function chunkWords(project, fallback = 800) {
  const n = Number(project?.chunk);
  return Number.isFinite(n) && n >= 200 ? Math.round(n) : fallback;
}

/* 每个动作返回 {system, user} */
export const ACTIONS = [
  {
    id: 'continue',
    label: '续写',
    icon: '✍️',
    need: 'chapter',
    hint: '接着当前章节往下写',
    build({ context, project, instruction, selection }) {
      const n = chunkWords(project);
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】请接着上面的正文继续往下写，字数约 ${n} 字。\n` +
          `要求：1) 严格延续现有情节、人物、人称与时态，风格一致；2) 不要复述、总结或重写已有内容；` +
          `3) ${NO_MARKDOWN} 4) 自然分段，长短句结合。\n` +
          (selection ? `\n【特别注意】作者选中了这段，请顺着它写：\n${selection}\n` : '') +
          (instruction ? `\n【作者的额外要求】${instruction}` : ''),
      };
    },
  },
  {
    id: 'chapter',
    label: '写整章',
    icon: '📖',
    need: 'chapter',
    hint: '根据设定和大纲写一整章',
    build({ context, project, instruction }) {
      const n = chunkWords(project, 1200);
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】请写出当前章节的完整内容，约 ${n} 字（可略多）。\n` +
          (instruction ? `本章剧情要求：${instruction}\n` : '如果没有额外要求，请根据设定和上文自然推进剧情。\n') +
          `要求：1) 有起承转合，结尾留一个钩子；2) 人物言行符合角色设定；3) ${NO_MARKDOWN}`,
      };
    },
  },
  {
    id: 'polish',
    label: '润色',
    icon: '✨',
    need: 'selection',
    hint: '保留原意，让文字更顺更有画面感',
    build({ context, project, instruction, target }) {
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】润色下面这段文字，保持原意、情节和信息量不变，篇幅基本不变，让表达更流畅、更有画面感，去除重复和口水词。\n` +
          (instruction ? `额外要求：${instruction}\n` : '') +
          `\n【原文】\n${target}\n\n要求：${NO_MARKDOWN}直接输出润色后的文本。`,
      };
    },
  },
  {
    id: 'expand',
    label: '扩写',
    icon: '➕',
    need: 'selection',
    hint: '补充细节，把段落写厚',
    build({ context, project, instruction, target }) {
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】扩写下面这段文字，扩到约 ${Math.max(200, Math.round(target.length * 1.8))} 字。` +
          `补充环境、动作、心理、感官细节，但不要新增关键剧情转折，不要改变人物关系。\n` +
          (instruction ? `额外要求：${instruction}\n` : '') +
          `\n【原文】\n${target}\n\n要求：${NO_MARKDOWN}直接输出扩写后的文本。`,
      };
    },
  },
  {
    id: 'condense',
    label: '精简',
    icon: '✂️',
    need: 'selection',
    hint: '删掉冗余，节奏更紧',
    build({ context, project, instruction, target }) {
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】精简下面这段文字，压缩到约 ${Math.max(80, Math.round(target.length * 0.6))} 字，保留关键信息与精彩描写，删掉冗余修饰和重复表达，节奏更紧凑。\n` +
          (instruction ? `额外要求：${instruction}\n` : '') +
          `\n【原文】\n${target}\n\n要求：${NO_MARKDOWN}直接输出精简后的文本。`,
      };
    },
  },
  {
    id: 'rewrite',
    label: '改写',
    icon: '🔁',
    need: 'selection',
    hint: '换一种写法，避免和已有情节雷同',
    build({ context, project, instruction, target }) {
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】用另一种写法改写下面这段，情节走向和结果保持一致，但叙述角度、句式、比喻都要换新，避免常见套路表达。\n` +
          (instruction ? `额外要求：${instruction}\n` : '') +
          `\n【原文】\n${target}\n\n要求：${NO_MARKDOWN}直接输出改写后的文本。`,
      };
    },
  },
  {
    id: 'dialogue',
    label: '加对话',
    icon: '💬',
    need: 'selection',
    hint: '把叙述改成有来有回的对话',
    build({ context, project, instruction, target }) {
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】把下面这段内容改写为以人物对话和动作推进的写法，对话要符合各自身份和性格，少用"他说道"这类重复提示语，多用动作和神态代替。\n` +
          (instruction ? `额外要求：${instruction}\n` : '') +
          `\n【原文】\n${target}\n\n要求：${NO_MARKDOWN}直接输出改写后的文本。`,
      };
    },
  },
  {
    id: 'outline',
    label: '大纲',
    icon: '🗺️',
    need: 'none',
    hint: '生成整本书或后续剧情大纲',
    build({ context, project, instruction }) {
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】为这本书设计一份可执行的大纲。\n` +
          (instruction ? `作者的要求：${instruction}\n` : '') +
          `请分三部分输出：\n1. 全书主线（三幕结构，每幕 3-5 个关键事件）\n2. 主角成长弧线（起点 / 转折 / 终点）\n3. 接下来 10 章的章节大纲（每章一句话，注明冲突与钩子）\n可以用简洁的列表，但不要写成作文。`,
      };
    },
  },
  {
    id: 'plot',
    label: '剧情走向',
    icon: '🧭',
    need: 'none',
    hint: '给 3 个后续可能，附利弊',
    build({ context, project, instruction }) {
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】基于当前进度，给出 3 个不同的后续剧情走向。每个方案写：核心事件、冲突升级方式、对主角的影响、以及优缺点。\n` +
          (instruction ? `作者倾向：${instruction}\n` : '') +
          `最后推荐一个最适合当前节奏的方案并说明理由。`,
      };
    },
  },
  {
    id: 'character',
    label: '角色卡',
    icon: '🎭',
    need: 'none',
    hint: '设计一个立体的角色',
    build({ context, project, instruction }) {
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】设计${instruction ? `这样一个角色：${instruction}` : '一个重要新角色'}。请输出：姓名、身份、外貌特征、性格（优点+缺陷）、说话方式、核心欲望、致命弱点、与主角的关系与矛盾、一个能体现性格的小细节。直接给设定，不要写成故事。`,
      };
    },
  },
  {
    id: 'name',
    label: '起名',
    icon: '🏷️',
    need: 'none',
    hint: '人名/地名/功法/组织名',
    build({ context, project, instruction }) {
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】起名。${instruction ? `需要：${instruction}` : '请给出人名、地名、组织/势力名各 5 个。'}\n` +
          `要求：符合本书题材与世界观，读起来顺口好记，不要用烂大街的名字。每个名字后用一句话说明出处或含义。`,
      };
    },
  },
  {
    id: 'check',
    label: '设定体检',
    icon: '🔍',
    need: 'chapter',
    hint: '找出前后矛盾与逻辑漏洞',
    build({ context, project, instruction }) {
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】以严苛的编辑视角检查以上内容，找出：1) 与设定/前情矛盾之处（引用原文）；2) 逻辑漏洞或人物行为不合理；3) 节奏与视角问题；4) 已经被写烂的套路表达。\n` +
          (instruction ? `重点关注：${instruction}\n` : '') +
          `按严重程度排序，每条给出具体修改建议。`,
      };
    },
  },
  {
    id: 'summary',
    label: '章节摘要',
    icon: '📝',
    need: 'chapter',
    hint: '生成前情摘要（存到设定页给 AI 记）',
    build({ context, project, instruction, current }) {
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】用 2-3 句话概括第${(current?.order ?? 0) + 1}章《${current?.title || '未命名'}》发生了什么，包含关键人物、事件结果和留下的悬念。只输出摘要正文，不要任何前缀。`,
      };
    },
  },
  {
    id: 'idea',
    label: '灵感',
    icon: '💡',
    need: 'none',
    hint: '卡文时给 5 个点子',
    build({ context, project, instruction }) {
      return {
        system: baseSystem(project?.aiSystem, project),
        user:
          `${context}\n\n【任务】我卡文了。${instruction ? `我的困惑：${instruction}\n` : ''}请给出 5 个立刻能写的具体桥段（每个 2-3 句），要求新颖、可落地、能推动当前剧情，避免老套。`,
      };
    },
  },
];

export function getAction(id) {
  return ACTIONS.find((a) => a.id === id) || ACTIONS[0];
}

export function defaultSystemPrompt() {
  return [
    '你是一位经验丰富的中文小说作家兼责任编辑，长期为畅销小说做续写、润色与结构把控。',
    '你熟悉中文网文的节奏感：开篇抓人、对话推动情节、每章有钩子。',
    '你尊重作者已写下的每一个字：延续既有文风、人称、时态和人物设定，从不擅自改设定。',
    '你从不输出解释、免责声明或与正文无关的话。',
    '正文一律使用简体中文（除非设定要求外语），标点使用中文全角标点。',
  ].join('\n');
}
